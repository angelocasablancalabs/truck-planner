/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — LARGHEZZA ESTESA DELLA TARGA FUORI SPONDA
 *  (Sprint J-quater)
 *
 *  Controlla su Chrome reale (Chrome DevTools Protocol, zero dipendenze) che la
 *  targa si estenda davvero oltre le sponde laterali della cabina, fino a
 *  `vehicle.width + 100` cm (≈ 350 cm sul bilico CC), e che con una dicitura
 *  logistica reale come `XA111NJ COME ARRIVA` (19 caratteri) il corpo del testo
 *  non crolli più sotto i 18 px come con la vecchia formula dei 210 cm interni:
 *
 *    1. unit (`/src/utils/plateBadge.ts`): larghezza massima estesa 350 cm,
 *       `fontSize ≈ 26,7 px` (≥ 26), `textWidthCm ≈ 330 cm` con la formula
 *       `caratteri × fontSize × 0.65`, estremi `leftX ≈ −55` / `rightX ≈ 305`;
 *    2. canvas: il testo è realmente renderizzato a **≥ 26 px** (contro i ~17 px
 *       della vecchia formula) e il suo ingombro reale (`getBBox`) **sfora** le
 *       sponde del pianale (250 cm) restando dentro la fascia estesa;
 *    3. SVG esportato (`buildPianoSvg`) e scheda A4: lo stesso corpo, e il
 *       `viewBox` **contiene** il bounding box reale del glifo (nessun taglio);
 *    4. targa massima di 40 caratteri: ancora dentro la fascia estesa.
 *
 *  Uso:  node scripts/verify-plate-extended-width.mjs [url]
 *  Chiude sempre con `Browser.close` + `process.exit(0)` entro 10 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://127.0.0.1:5199/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9334);
const WATCHDOG_MS = 10000;
const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Mezzo di riferimento della verifica: bilico CC 250 × 1328 cm. */
const VEHICLE = { id: 'bilico_cc', name: 'Bilico frigo Fiori', width: 250, length: 1328 };
/** Dicitura logistica reale: 19 caratteri, il caso citato dal task. */
const PLATE_19 = 'XA111NJ COME ARRIVA';
/** Targa massima consentita dal campo della sidebar (`maxLength 40`). */
const PLATE_40 = 'XA111NJ COME ARRIVA PROVA LUNGHEZZA TEST';
/** Vecchia formula (larghezza utile interna): `(250 − 40) / (19 × 0.65)`. */
const LEGACY_FONT_SIZE_19 = (250 - 40) / (19 * 0.65);

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (value, expected, tolerance = 0.02) =>
  typeof value === 'number' && Math.abs(value - expected) <= tolerance;

/** Scrittura nel campo targa tramite il setter nativo (React 19 lo intercetta). */
const PLATE_SETUP = `
  const setPlate = (el, next) => {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  };
`;

const typePlate = (cdp, value) =>
  cdp.eval(`
    ${PLATE_SETUP}
    return setPlate(document.getElementById('vehicle-plate-input'), ${JSON.stringify(value)});
  `);

const waitFor = async (fn, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout in attesa di ${label}`);
    await sleep(120);
  }
};

/* --- Client CDP minimale --------------------------------------------------- */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.consoleErrors = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(
          `exception: ${msg.params?.exceptionDetails?.exception?.description ?? 'n/d'}`
        );
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        this.consoleErrors.push(
          `console.error: ${(msg.params.args ?? []).map((a) => a.value ?? a.description).join(' ')}`
        );
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`eval: ${result.exceptionDetails.exception?.description}`);
    }
    return result.result.value;
  }
}

const connect = async (wsUrl, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ws = new WebSocket(wsUrl);
    try {
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
      });
      return ws;
    } catch {
      if (Date.now() > deadline) throw new Error('impossibile aprire il websocket CDP');
      await sleep(150);
    }
  }
};

/* --- Script ----------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();
  const profileDir = mkdtempSync(join(tmpdir(), 'plate-width-profile-'));
  const chrome = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1600,1113',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let ws;
  let cdp;
  try {
    const target = await waitFor(
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
          const list = await res.json();
          const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          return page ? page.webSocketDebuggerUrl : null;
        } catch {
          return null;
        }
      },
      6000,
      'Chrome DevTools endpoint'
    );

    ws = await connect(target);
    cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: DEV_URL });

    await waitFor(
      async () => cdp.eval(`return document.getElementById('vehicle-plate-input') ? 1 : 0;`),
      9000,
      'mount della sidebar'
    );

    /* --- 1) Unit: formula e ingombro della targa estesa ------------------ */
    const unit = await cdp.eval(`
      const mod = await import('/src/utils/plateBadge.ts');
      const layout = mod.plateBadgeLayout(250, ${JSON.stringify(PLATE_19)});
      const max40 = mod.plateBadgeLayout(250, ${JSON.stringify(PLATE_40)});
      return {
        fontSize: layout.fontSize,
        width: layout.width,
        textWidthCm: layout.textWidthCm,
        leftX: layout.leftX,
        rightX: layout.rightX,
        centerX: layout.centerX,
        advanceEm: mod.PLATE_BADGE_CHAR_ADVANCE_EM,
        overhang: mod.PLATE_MAX_OVERHANG_CM,
        max40FontSize: max40.fontSize,
        max40TextWidth: max40.textWidthCm,
        empty: mod.plateBadgeLayout(250, '   '),
      };
    `);
    check(
      'Unit: larghezza massima estesa = vehicle.width + 100 (350 cm)',
      unit.width === 350 && unit.overhang === 100,
      `width=${unit.width} sforo=${unit.overhang} cm (50 cm per lato)`
    );
    check(
      'Unit: "XA111NJ COME ARRIVA" (19 caratteri) → font-size ≈ 26,72 px (≥ 26)',
      near(unit.fontSize, 330 / (19 * 0.65), 0.01) && unit.fontSize >= 26 && unit.fontSize < 30,
      `font-size=${unit.fontSize?.toFixed(2)} px (vecchia formula: ${LEGACY_FONT_SIZE_19.toFixed(2)} px)`
    );
    check(
      'Unit: ingombro testo = caratteri × fontSize × 0.65 (≈ 330 cm)',
      near(unit.textWidthCm, 19 * unit.fontSize * 0.65, 0.01) &&
        unit.textWidthCm > 250 &&
        unit.textWidthCm <= 330 + 0.01,
      `textWidthCm=${unit.textWidthCm?.toFixed(1)} cm su 330 disponibili (pianale 250)`
    );
    check(
      'Unit: estremi di inquadratura textWidth/2 + 15 cm per lato',
      near(unit.leftX, 125 - unit.textWidthCm / 2 - 15, 0.01) &&
        near(unit.rightX, 125 + unit.textWidthCm / 2 + 15, 0.01),
      `leftX=${unit.leftX?.toFixed(1)} rightX=${unit.rightX?.toFixed(1)} (mezzeria ${unit.centerX})`
    );
    check(
      'Unit: targa da 40 caratteri ancora dentro la fascia estesa',
      unit.max40FontSize > 5 && unit.max40TextWidth <= 330 + 0.01,
      `font-size=${unit.max40FontSize?.toFixed(2)} px, larghezza=${unit.max40TextWidth?.toFixed(1)} cm`
    );
    check(
      'Unit: targa vuota → nessuna geometria (silenzio a riposo)',
      unit.empty === null,
      `layout=${JSON.stringify(unit.empty)}`
    );

    /* --- 2) Canvas: corpo reale e sforo oltre le sponde ------------------ */
    await typePlate(cdp, PLATE_19.toLowerCase());
    await sleep(250);

    const canvas = await cdp.eval(`
      const badge = document.getElementById('canvas-plate-badge');
      const text = badge && badge.querySelector('text');
      if (!text) return null;
      const style = getComputedStyle(text);
      const box = text.getBBox();
      const world = text.closest('g[transform]');
      const zoom = Number((world.getAttribute('transform').split('scale(')[1] || '').replace(')', ''));
      return {
        content: text.textContent,
        input: document.getElementById('vehicle-plate-input').value,
        computedFontSize: parseFloat(style.fontSize),
        attrFontSize: Number(text.getAttribute('font-size')),
        textWidthCm: box.width,
        textHeightCm: box.height,
        // Ingombro a schermo (px) contro la larghezza del pianale a schermo:
        // la targa estesa sfora visibilmente le sponde anche sul canvas.
        textWidthPx: text.getBoundingClientRect().width,
        deckWidthPx: 250 * zoom,
        zoom,
        stroke: text.getAttribute('stroke'),
        rects: badge.querySelectorAll('rect').length,
      };
    `);
    check(
      'Canvas: la targa è resa a ≥ 26 px (era ~17 px con i 210 cm interni)',
      !!canvas && canvas.computedFontSize >= 26 && canvas.computedFontSize < 30,
      `computed=${canvas?.computedFontSize?.toFixed(2)} px, attributo=${canvas?.attrFontSize} (testo "${canvas?.content}")`
    );
    check(
      'Canvas: ingombro reale del glifo OLTRE le sponde (250 cm) e dentro i 330 utili',
      !!canvas && canvas.textWidthCm > 250 && canvas.textWidthCm <= 330 + 1,
      `larghezza=${canvas?.textWidthCm?.toFixed(1)} cm (pianale 250, fascia estesa 350)`
    );
    check(
      'Canvas: a schermo la targa estesa supera le sponde del pianale',
      !!canvas && canvas.textWidthPx > canvas.deckWidthPx,
      `targa ${canvas?.textWidthPx?.toFixed(1)} px vs pianale ${canvas?.deckWidthPx?.toFixed(1)} px (zoom ${canvas?.zoom?.toFixed(3)} px/cm, altezza glifo ${canvas?.textHeightCm?.toFixed(1)} cm)`
    );
    check(
      'Canvas: nessun bordo e nessun rettangolo nel badge',
      canvas?.stroke === 'none' && canvas?.rects === 0,
      `stroke=${canvas?.stroke} rect=${canvas?.rects}`
    );

    /* --- 3) SVG esportato: viewBox che contiene davvero il testo --------- */
    const exported = await cdp.eval(`
      const mod = await import('/src/utils/export.ts');
      const vehicle = ${JSON.stringify(VEHICLE)};
      const snapshot = mod.buildPianoSvg(vehicle, [], 'all', [], ${JSON.stringify(PLATE_19)});
      // Il bounding box REALE del glifo si misura montando l'SVG fuori schermo.
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-99999px;top:0;';
      document.body.appendChild(host);
      host.innerHTML = snapshot.svg;
      const svgEl = host.querySelector('svg');
      const textEl = host.querySelector('#export-plate-badge text');
      const bbox = textEl.getBBox();
      const viewBox = svgEl.getAttribute('viewBox').split(/\\s+/).map(Number);
      const result = {
        fontAttr: Number(textEl.getAttribute('font-size')),
        viewBox,
        bbox: { x: bbox.x, width: bbox.width },
        glyphLeft: bbox.x,
        glyphRight: bbox.x + bbox.width,
        frameLeft: viewBox[0],
        frameRight: viewBox[0] + viewBox[2],
      };
      host.remove();
      return result;
    `);
    check(
      'Export PNG: lo stesso corpo (~26,72 px) della targa a 19 caratteri',
      near(exported.fontAttr, 330 / (19 * 0.65), 0.01),
      `font-size="${exported.fontAttr}"`
    );
    check(
      'Export PNG: lo snapshot NON taglia la targa estesa (glifo dentro il viewBox)',
      exported.glyphLeft >= exported.frameLeft && exported.glyphRight <= exported.frameRight,
      `glifo ${exported.glyphLeft?.toFixed(1)}…${exported.glyphRight?.toFixed(1)} cm nel viewBox ${exported.frameLeft?.toFixed(1)}…${exported.frameRight?.toFixed(1)} cm`
    );
    check(
      'Export PNG: cornice con i 15 cm di margine per lato',
      exported.frameLeft <= 125 - exported.bbox.width / 2 - 15 + 0.01 &&
        exported.frameRight >= 125 + exported.bbox.width / 2 + 15 - 0.01,
      `testo largo ${exported.bbox.width?.toFixed(1)} cm, cornice ${(exported.frameRight - exported.frameLeft).toFixed(1)} cm`
    );

    /* --- 4) Scheda A4: stesso corpo e stessa inquadratura ---------------- */
    const printReport = await cdp.eval(`
      const print = document.getElementById('print-report');
      const text = print.querySelector('#print-plate-badge text');
      const svg = print.querySelector('svg');
      const viewBox = svg.getAttribute('viewBox').split(/\\s+/).map(Number);
      return {
        content: text ? text.textContent : null,
        fontAttr: text ? Number(text.getAttribute('font-size')) : null,
        viewBox,
        frameLeft: viewBox[0],
        frameRight: viewBox[0] + viewBox[2],
      };
    `);
    check(
      'Scheda A4: targa ridisegnata allo stesso corpo (≥ 26 px)',
      printReport.content === PLATE_19 &&
        printReport.fontAttr >= 26 &&
        printReport.fontAttr < 30,
      `testo="${printReport.content}" font-size=${printReport.fontAttr}`
    );
    check(
      'Scheda A4: viewBox allargato alla targa estesa (nessun taglio in stampa)',
      printReport.frameLeft <= unit.leftX + 0.01 &&
        printReport.frameRight >= unit.rightX - 0.01,
      `viewBox ${printReport.frameLeft?.toFixed(1)}…${printReport.frameRight?.toFixed(1)} cm vs ingombro ${unit.leftX?.toFixed(1)}…${unit.rightX?.toFixed(1)} cm`
    );
    /* --- 5) Nessun errore in console ------------------------------------- */
    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    /* --- Evidenza grafica ------------------------------------------------- */
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync('shots', { recursive: true });
    await cdp.eval(`
      document.querySelector('[aria-label="Reset / Adatta a schermo"]').click();
      return 1;
    `);
    await sleep(200);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('shots/badge-targa-estesa-fuori-sponda.png', Buffer.from(shot.data, 'base64'));
    console.log('Evidenza grafica: shots/badge-targa-estesa-fuori-sponda.png');

    console.log(`\n${passed}/${passed + failed} controlli superati`);
    console.log(`Durata della verifica: ${((Date.now() - startedAt) / 1000).toFixed(2)} s (limite 10 s)`);
  } finally {
    try {
      ws?.close();
    } catch {
      /* il websocket potrebbe essere già chiuso */
    }
    // Chiusura pulita del browser: `Browser.close` non risponde mai (la
    // connessione cade insieme al browser), quindi non si attende la risposta.
    try {
      cdp?.send('Browser.close').catch(() => {});
    } catch {
      /* il websocket potrebbe essere già chiuso */
    }
    try {
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/`).catch(() => {});
    } catch {
      /* endpoint già chiuso */
    }
    chrome.kill();
    await sleep(100);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* profilo temporaneo già rimosso */
    }
  }
};

const watchdog = setTimeout(() => {
  console.error('WATCHDOG: verifica interrotta oltre i 10 secondi');
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

main()
  .then(() => process.exit(failed === 0 ? 0 : 1))
  .catch((error) => {
    console.error('ERRORE:', error?.message ?? error);
    process.exit(1);
  });
