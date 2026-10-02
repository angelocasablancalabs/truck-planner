/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — RIFINITURA TARGA (SPRINT J-bis)
 *
 *  Controlla, su Chrome reale pilotato via Chrome DevTools Protocol (zero
 *  dipendenze aggiunte al progetto), che:
 *    1. a targa VUOTA l'area sopra la Cabina sia totalmente priva di testi e di
 *       rettangoli tratteggiati: 0 nodi visibili su canvas, scheda A4 e SVG
 *       esportato;
 *    2. digitando "XA111NJ" il testo della targa abbia font-size **30 px** (cioè
 *       il doppio dei 15 px di `▲ CABINA ▲`), `stroke="none"` e una quota Y che
 *       non invade la didascalia né viene tagliata dall'inquadratura;
 *    3. la targa lunga (`XA100CD PROVA LUNGHEZZA TESTO PROVA`, 36 caratteri)
 *       resti dentro la fascia ESTESA (`vehicle.width + 100 cm`, cioè 330 cm
 *       utili sul bilico CC) scalando il corpo, quindi possa sforare le sponde;
 *    4. nella sidebar il titolo di settore sia `Targa` con la classe
 *       `text-xs font-bold text-slate-700` e il campo sia pulito (placeholder "").
 *
 *  Uso:  node scripts/verify-plate-badge.mjs [url]
 *  Chiude sempre con `browser.close()` + `process.exit(0)` entro 15 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://127.0.0.1:5199/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9333);
const WATCHDOG_MS = 15000;
const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scrive nel campo della targa passando dal setter nativo della classe: è
 * l'unico modo perché React 19 intercetti l'evento `input` e aggiorni il badge
 * (l'assegnazione diretta a `input.value` viene assorbita dal value tracker).
 */
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

  /** Valuta un'espressione nella pagina e restituisce il valore serializzato. */
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

const connect = async (wsUrl, timeoutMs = 8000) => {  const deadline = Date.now() + timeoutMs;
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
  const profileDir = mkdtempSync(join(tmpdir(), 'plate-badge-profile-'));
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
    const targets = await waitFor(
      async () => {
        try {
          const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
          const list = await res.json();
          const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
          return page ? [page.webSocketDebuggerUrl] : null;
        } catch {
          return null;
        }
      },
      6000,
      'Chrome DevTools endpoint'
    );

    ws = await connect(targets[0]);
    cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: DEV_URL });

    await waitFor(
      async () => cdp.eval(`return document.querySelector('#vehicle-plate-input') ? 1 : 0;`),
      10000,
      'mount della sidebar'
    );
    // Attende il fit del canvas (ResizeObserver + pattern di aggiustamento dello
    // stato durante il render): la didascalia compare solo a viewport misurato.
    await waitFor(
      async () =>
        cdp.eval(`
          const texts = Array.from(document.querySelectorAll('svg text'));
          return texts.some((t) => t.textContent.includes('CABINA')) ? 1 : 0;
        `),
      8000,
      'primo render del canvas'
    );
    await sleep(250);

    /* --- 1) A riposo: silenzio totale sopra la Cabina --------------------- */
    const emptyCanvas = await cdp.eval(`
      const badge = document.getElementById('canvas-plate-badge');
      const allTexts = Array.from(document.querySelectorAll('svg text'));
      const cabina = document.getElementById('canvas-cabina-caption');
      return {
        badgeNodes: badge ? badge.querySelectorAll('text, rect').length : 0,
        cabinaCount: cabina ? 1 : 0,
        cabinaFontSize: cabina ? parseFloat(getComputedStyle(cabina).fontSize) : null,
        placeholderCount: allTexts.filter(t => t.textContent.includes('TARGA')).length,
        dashedRects: Array.from(document.querySelectorAll('svg rect'))
          .filter(r => (r.getAttribute('stroke-dasharray') || '') !== '')
          .filter(r => Number(r.getAttribute('y')) < -10).length,
        totalTexts: allTexts.length,
      };
    `);
    check(
      'Canvas a riposo: nessun nodo targa sopra la Cabina',
      emptyCanvas.badgeNodes === 0,
      `nodi=${emptyCanvas.badgeNodes}`
    );
    check(
      'Canvas a riposo: nessun segnaposto / rettangolo tratteggiato',
      emptyCanvas.placeholderCount === 0 && emptyCanvas.dashedRects === 0,
      `segnaposto=${emptyCanvas.placeholderCount} tratteggiati=${emptyCanvas.dashedRects}`
    );
    check(
      'Canvas: didascalia ▲ CABINA ▲ presente a 15 px',
      emptyCanvas.cabinaCount === 1 && emptyCanvas.cabinaFontSize === 15,
      `n=${emptyCanvas.cabinaCount} font=${emptyCanvas.cabinaFontSize}`
    );

    const emptyPrint = await cdp.eval(`
      const print = document.getElementById('print-report');
      const texts = Array.from(print.querySelectorAll('text'));
      return {
        badgeNodes: print.querySelectorAll('#print-plate-badge text, #print-plate-badge rect').length,
        midRows: texts.filter(t => t.textContent.includes('TARGA')).length,
      };
    `);
    check(
      'Scheda A4 a riposo: nessun nodo targa',
      emptyPrint.badgeNodes === 0 && emptyPrint.midRows === 0,
      `nodi=${emptyPrint.badgeNodes}`
    );

    /* --- 2) Targa standard: 30 px, stroke none, gerarchia ----------------- */
    await typePlate(cdp, 'xa111nj');
    await sleep(400);

    const shortPlate = await cdp.eval(`
      const badge = document.getElementById('canvas-plate-badge');
      const text = badge && badge.querySelector('text');
      const cabina = document.getElementById('canvas-cabina-caption');
      if (!text) return null;
      const style = getComputedStyle(text);
      const box = text.getBBox();
      const svg = document.querySelector('svg');
      const svgRect = svg.getBoundingClientRect();
      const textRect = text.getBoundingClientRect();
      const cabinaRect = cabina.getBoundingClientRect();
      const world = text.closest('g[transform]');
      return {
        inputValue: document.getElementById('vehicle-plate-input').value,
        content: text.textContent,
        attrFontSize: Number(text.getAttribute('font-size')),
        computedFontSize: parseFloat(style.fontSize),
        strokeAttr: text.getAttribute('stroke'),
        strokeComputed: style.stroke,
        strokeWidthAttr: text.getAttribute('stroke-width'),
        fontWeight: style.fontWeight,
        rects: badge.querySelectorAll('rect').length,
        cabinaFontSize: cabina ? parseFloat(getComputedStyle(cabina).fontSize) : null,
        // Confronto geometrico diretto in px schermo tra il glifo della targa e
        // la didascalia: nessuna conversione in cm necessaria.
        transform: world.getAttribute('transform'),
        svgTop: svgRect.top,
        scrollY: window.scrollY,
        plateYAttr: Number(text.getAttribute('y')),
        plateTopPx: textRect.top - svgRect.top,
        plateBottomPx: textRect.bottom - svgRect.top,
        cabinaTopPx: cabinaRect.top - svgRect.top,
        cabinaBottomPx: cabinaRect.bottom - svgRect.top,
        cabinaYAttr: Number(cabina.getAttribute('y')),
        gapPx: cabinaRect.top - textRect.bottom,
        plateWidthPx: textRect.width,
        plateHeightPx: textRect.height,
        plateWidthCm: box.width,
        insideSvgViewport:
          textRect.top >= svgRect.top - 0.5 && textRect.bottom <= svgRect.bottom + 0.5,
      };
    `);
    check(
      'Digitando "XA111NJ" la targa è in maiuscolo sul canvas',
      !!shortPlate && shortPlate.content === 'XA111NJ' && shortPlate.inputValue === 'XA111NJ',
      shortPlate ? `testo=${shortPlate.content} input=${shortPlate.inputValue}` : 'badge assente'
    );
    check(
      'Targa standard: font-size 30 px (doppio dei 15 px di CABINA)',
      shortPlate?.computedFontSize === 30 && shortPlate?.attrFontSize === 30,
      `computed=${shortPlate?.computedFontSize} attributo=${shortPlate?.attrFontSize}`
    );
    check(
      'Targa più grande di ▲ CABINA ▲ (15 px)',
      shortPlate?.cabinaFontSize === 15 && shortPlate.computedFontSize > shortPlate.cabinaFontSize,
      `targa=${shortPlate?.computedFontSize} cabina=${shortPlate?.cabinaFontSize}`
    );
    check(
      'Quota Y: il testo a 30 px non invade ▲ CABINA ▲',
      !!shortPlate && shortPlate.gapPx > 0,
      `targa ${shortPlate?.plateTopPx?.toFixed(1)}…${shortPlate?.plateBottomPx?.toFixed(1)} px, CABINA da ${shortPlate?.cabinaTopPx?.toFixed(1)} px (stacco ${shortPlate?.gapPx?.toFixed(1)} px; ${shortPlate?.transform}; svgTop ${shortPlate?.svgTop} scroll ${shortPlate?.scrollY}; y=${shortPlate?.plateYAttr})`
    );
    check(
      "Inquadratura: nessun taglio in alto nel viewport del canvas",
      !!shortPlate && shortPlate.insideSvgViewport && shortPlate.plateTopPx > 0,
      `top glifo ${shortPlate?.plateTopPx?.toFixed(1)} px, altezza ${shortPlate?.plateHeightPx?.toFixed(1)} px`
    );
    check(
      'Zero bordo: stroke="none" e stroke-width 0',
      shortPlate?.strokeAttr === 'none' &&
        shortPlate?.strokeWidthAttr === '0' &&
        shortPlate?.strokeComputed === 'none',
      `stroke=${shortPlate?.strokeAttr}/${shortPlate?.strokeComputed} width=${shortPlate?.strokeWidthAttr}`
    );
    check(
      'Nessun rettangolo nel badge',
      shortPlate?.rects === 0,
      `rect=${shortPlate?.rects}`
    );

    /* --- 3) Targa lunga: scale proporzionale, mai oltre il pianale -------- */
    const LONG_PLATE = 'XA100CD PROVA LUNGHEZZA TESTO PROVA';
    await typePlate(cdp, LONG_PLATE.toLowerCase());
    await sleep(400);

    const longPlate = await cdp.eval(`
      const badge = document.getElementById('canvas-plate-badge');
      const text = badge && badge.querySelector('text');
      if (!text) return null;
      const box = text.getBBox();
      const world = text.closest('g[transform]');
      const zoom = Number((world.getAttribute('transform').split('scale(')[1] || '').replace(')', ''));
      const rows = Array.from(document.querySelectorAll('rect'))
        .filter(r => r.getAttribute('width') === '250' && r.getAttribute('height') === '1328');
      return {
        content: text.textContent,
        fontSize: parseFloat(getComputedStyle(text).fontSize),
        widthCm: box.width,
        heightCm: box.height,
        screenHeightPx: box.height * zoom,
        vehicleWidth: rows.length ? 250 : null,
      };
    `);
    check(
      'Targa lunga (36 caratteri): corpo scalato sotto i 30 px',
      !!longPlate && longPlate.fontSize < 30 && longPlate.fontSize >= 5,
      `font-size=${longPlate?.fontSize}`
    );
    check(
      'Targa lunga: testo dentro la fascia estesa (250 + 100 cm, utile 330)',
      !!longPlate && longPlate.widthCm <= 330 + 1,
      `larghezza=${longPlate?.widthCm?.toFixed(1)} cm su 250 (fascia estesa 350, utile 330)`
    );
    check(
      'Targa lunga: testo visibile e non collassato',
      !!longPlate && longPlate.heightCm > 0 && longPlate.screenHeightPx > 3,
      `altezza=${longPlate?.heightCm?.toFixed(1)} cm (${longPlate?.screenHeightPx?.toFixed(1)} px a schermo)`
    );

    /* --- 4) Export PNG: stesso testo, senza bordo ------------------------- */
    const longExport = await cdp.eval(`
      // Il dev server serve l'app sotto la base Vite (/truck-planner/).
      const mod = await import('/truck-planner/src/utils/export.ts');
      const vehicle = { id: 'bilico_cc', name: 'Bilico', width: 250, length: 1328 };
      const svg = mod.buildPianoSvg(vehicle, [], 'all', [], ${JSON.stringify(LONG_PLATE)}).svg;
      return {
        hasGroup: svg.includes('export-plate-badge'),
        hasText: svg.includes(${JSON.stringify(LONG_PLATE)}),
        rectStroke: /<g id="export-plate-badge">[\\s\\S]*?<rect/.test(svg),
        strokeNone: svg.includes('stroke="none"'),
        fontSize: Number((svg.match(/id="export-plate-badge">[\\s\\S]*?font-size="([\\d.]+)"/) || [])[1]),
      };
    `);
    check(
      'Export PNG: la targa lunga è disegnata come solo testo',
      longExport.hasGroup && longExport.hasText,
      `gruppo=${longExport.hasGroup} testo=${longExport.hasText}`
    );
    check(
      'Export PNG: nessun rettangolo e stroke="none"',
      !longExport.rectStroke && longExport.strokeNone,
      `rect=${longExport.rectStroke} strokeNone=${longExport.strokeNone}`
    );

    const emptyExport = await cdp.eval(`
      // Il dev server serve l'app sotto la base Vite (/truck-planner/).
      const mod = await import('/truck-planner/src/utils/export.ts');
      const vehicle = { id: 'bilico_cc', name: 'Bilico', width: 250, length: 1328 };
      const svg = mod.buildPianoSvg(vehicle, [], 'all', [], '   ').svg;
      return {
        hasGroup: svg.includes('export-plate-badge'),
        hasPlaceholder: svg.includes('TARGA'),
        aspect: mod.buildPianoSvg(vehicle, [], 'all', [], '').width,
      };
    `);
    check(
      'Export PNG a targa vuota: nessun badge e nessun segnaposto',
      !emptyExport.hasGroup && !emptyExport.hasPlaceholder,
      `gruppo=${emptyExport.hasGroup} segnaposto=${emptyExport.hasPlaceholder}`
    );

    /* --- 5) Rispondenza con l'SVG realmente esportato --------------------- */
    await typePlate(cdp, 'xa111nj');
    await sleep(300);
    await cdp.eval(`
      const btn = document.getElementById('btn-copy-image');
      btn.click();
      return 1;
    `);
    await sleep(900);
    const liveExport = await cdp.eval(`
      // Il dev server serve l'app sotto la base Vite (/truck-planner/).
      const mod = await import('/truck-planner/src/utils/export.ts');
      const vehicle = { id: 'bilico_cc', name: 'Bilico', width: 250, length: 1328 };
      const svg = mod.buildPianoSvg(vehicle, [], 'all', [], 'XA111NJ').svg;
      return {
        fontSize: Number((svg.match(/id="export-plate-badge">[\\s\\S]*?font-size="([\\d.]+)"/) || [])[1]),
        feedback: document.getElementById('btn-copy-image').textContent.trim(),
      };
    `);
    check(
      'Export PNG con targa standard: font-size 30 e Copia Immagine completata',
      liveExport.fontSize === 30 && liveExport.feedback.length > 0,
      `font=${liveExport.fontSize} feedback="${liveExport.feedback}"`
    );

    /* --- 6) Scheda A4 con targa ------------------------------------------ */
    const printPlate = await cdp.eval(`
      const print = document.getElementById('print-report');
      const text = print.querySelector('#print-plate-badge text');
      return {
        content: text ? text.textContent : null,
        fontSize: text ? Number(text.getAttribute('font-size')) : null,
        stroke: text ? text.getAttribute('stroke') : null,
        rects: print.querySelectorAll('#print-plate-badge rect').length,
      };
    `);
    check(
      'Scheda A4: targa ridisegnata come solo testo a 30 px',
      printPlate.content === 'XA111NJ' &&
        printPlate.fontSize === 30 &&
        printPlate.stroke === 'none' &&
        printPlate.rects === 0,
      `testo=${printPlate.content} font=${printPlate.fontSize} rect=${printPlate.rects}`
    );

    /* --- 7) Zoom elevato: la targa ingrandita non viene mai tagliata ------ */
    // 7a) Porta lo zoom al 240% con i pulsanti dell'HUD.
    await cdp.eval(`
      const btn = document.querySelector('[aria-label="Zoom In"]');
      for (let i = 0; i < 7; i++) btn.click();
      return 1;
    `);
    await sleep(400);

    // 7b) Rotellina verso l'alto con eventi wheel REALI del protocollo, fino
    //     all'arresto del clamp: la Cabina si ferma a `40 + 82 × zoom` px e la
    //     targa a 30 px deve restare interamente dentro il viewport.
    const panPoint = await cdp.eval(`
      const container = document.querySelector('.canvas-hud').parentElement;
      const r = container.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    for (let step = 0; step < 8; step += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: panPoint.x,
        y: panPoint.y,
        deltaX: 0,
        deltaY: -120,
      });
      await sleep(120);
    }
    await sleep(400);

    const zoomClamp = await cdp.eval(`
      // Nessuno scroll di pagina deve falsare le misure in px schermo.
      window.scrollTo(0, 0);
      const text = document.querySelector('#canvas-plate-badge text');
      const cabina = document.getElementById('canvas-cabina-caption');
      const svg = document.querySelector('svg');
      const svgRect = svg.getBoundingClientRect();
      const rect = text.getBoundingClientRect();
      const cabinaRect = cabina.getBoundingClientRect();
      const hud = document.querySelector('.canvas-hud span');
      const group = text.closest('g[transform]');
      return {
        hud: hud ? hud.textContent.trim() : null,
        transform: group.getAttribute('transform'),
        topPx: rect.top - svgRect.top,
        bottomPx: rect.bottom - svgRect.top,
        cabinaTopPx: cabinaRect.top - svgRect.top,
        cabinaBottomPx: cabinaRect.bottom - svgRect.top,
        viewportHeight: svgRect.height,
        fontSize: parseFloat(getComputedStyle(text).fontSize),
      };
    `);
    check(
      'Zoom alto (240%): la targa a 30 px resta interamente nel viewport',
      zoomClamp.topPx >= 0 && zoomClamp.bottomPx <= zoomClamp.viewportHeight,
      `top=${zoomClamp.topPx?.toFixed(1)} bottom=${zoomClamp.bottomPx?.toFixed(1)} su ${zoomClamp.viewportHeight?.toFixed(0)} px (${zoomClamp.transform})`
    );
    check(
      'Zoom alto (240%): targa e ▲ CABINA ▲ restano separati e in vista',
      zoomClamp.bottomPx < zoomClamp.cabinaTopPx &&
        zoomClamp.cabinaTopPx >= 0 &&
        zoomClamp.cabinaBottomPx <= zoomClamp.viewportHeight,
      `targa fino a ${zoomClamp.bottomPx?.toFixed(1)} px, CABINA ${zoomClamp.cabinaTopPx?.toFixed(1)}…${zoomClamp.cabinaBottomPx?.toFixed(1)} px (HUD ${zoomClamp.hud})`
    );

    /* --- 8) Sidebar: titolo di settore e campo pulito -------------------- */
    const sidebar = await cdp.eval(`
      const input = document.getElementById('vehicle-plate-input');
      const label = document.querySelector('label[for="vehicle-plate-input"]');
      const style = label ? getComputedStyle(label) : null;
      const reference = document.querySelector('#screen-app label');
      return {
        label: label ? label.textContent.trim() : null,
        labelClass: label ? label.className : null,
        fontSize: style ? parseFloat(style.fontSize) : null,
        fontWeight: style ? style.fontWeight : null,
        color: style ? style.color : null,
        textTransform: style ? style.textTransform : null,
        sameStyleAsReferenceLabel: !!(label && reference && reference.className === label.className),
        hasPlaceholderAttr: input.hasAttribute('placeholder'),
        placeholder: input.getAttribute('placeholder'),
        maxLength: input.getAttribute('maxlength'),
      };
    `);
    check(
      'Sidebar: titolo di settore "Targa"',
      sidebar.label === 'Targa',
      `label="${sidebar.label}"`
    );
    check(
      'Sidebar: stile macro-sezione text-xs font-bold text-slate-700',
      typeof sidebar.labelClass === 'string' &&
        sidebar.labelClass.includes('text-xs') &&
        sidebar.labelClass.includes('font-bold') &&
        sidebar.labelClass.includes('text-slate-700') &&
        sidebar.labelClass.includes('uppercase'),
      sidebar.labelClass ?? ''
    );
    check(
      'Sidebar: resa identica a "CONFIGURAZIONE MEZZO" (12 px, 700, maiuscolo)',
      sidebar.sameStyleAsReferenceLabel &&
        sidebar.fontSize === 12 &&
        sidebar.fontWeight === '700' &&
        sidebar.textTransform === 'uppercase',
      `font=${sidebar.fontSize}px weight=${sidebar.fontWeight} transform=${sidebar.textTransform} colore=${sidebar.color}`
    );
    check(
      'Sidebar: campo pulito a riposo (nessun placeholder)',
      sidebar.hasPlaceholderAttr === false || sidebar.placeholder === '',
      `placeholder=${JSON.stringify(sidebar.placeholder)}`
    );

    /* --- 9) Nessun errore in console ------------------------------------- */
    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    /* --- Evidenza grafica ------------------------------------------------- */
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync('shots', { recursive: true });

    // Torna alla vista d'insieme prima delle evidenze grafiche.
    await cdp.eval(`
      document.querySelector('[aria-label="Reset / Adatta a schermo"]').click();
      return 1;
    `);
    await sleep(400);

    // 1) A riposo: fascia sopra la Cabina completamente pulita.
    await typePlate(cdp, '');
    await sleep(400);
    const emptyShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('shots/badge-targa-silente-a-vuoto.png', Buffer.from(emptyShot.data, 'base64'));

    // 2) Con targa: solo testo, più grande di ▲ CABINA ▲.
    await typePlate(cdp, 'xa000bb come arriva');
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('shots/badge-targa-solo-testo.png', Buffer.from(shot.data, 'base64'));

    // 3) Primo piano a 240% sulla Cabina: la targa a 30 px svetta sopra i 15 px
    //    di `▲ CABINA ▲`, interamente visibile e senza tagli.
    await typePlate(cdp, 'xa111nj');
    await cdp.eval(`
      const btn = document.querySelector('[aria-label="Zoom In"]');
      for (let i = 0; i < 7; i++) btn.click();
      return 1;
    `);
    await sleep(400);
    const closeUpPoint = await cdp.eval(`
      const container = document.querySelector('.canvas-hud').parentElement;
      const r = container.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    `);
    for (let step = 0; step < 8; step += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: closeUpPoint.x,
        y: closeUpPoint.y,
        deltaX: 0,
        deltaY: -120,
      });
      await sleep(120);
    }
    await sleep(400);
    const cabinaShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(
      'shots/badge-targa-30px-cabina-240.png',
      Buffer.from(cabinaShot.data, 'base64')
    );

    console.log(
      'Evidenza grafica: shots/badge-targa-silente-a-vuoto.png, shots/badge-targa-solo-testo.png, shots/badge-targa-30px-cabina-240.png'
    );

    console.log(`\n${passed}/${passed + failed} controlli superati`);
  } finally {
    try {
      ws?.close();
    } catch {
      /* il websocket potrebbe essere già chiuso */
    }
    try {
      await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/`).catch(() => {});
    } catch {
      /* endpoint già chiuso */
    }
    chrome.kill();
    await sleep(250);
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* profilo temporaneo già rimosso */
    }
  }
};

const watchdog = setTimeout(() => {
  console.error('WATCHDOG: verifica interrotta oltre i 15 secondi');
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

main()
  .then(() => process.exit(failed === 0 ? 0 : 1))
  .catch((error) => {
    console.error('ERRORE:', error?.message ?? error);
    process.exit(1);
  });
