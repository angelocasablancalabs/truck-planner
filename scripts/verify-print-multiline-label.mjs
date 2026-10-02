/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — ETICHETTA MULTI-RIGA DEI COLLI NELLA SCHEDA A4
 *
 *  Controlla su Chrome reale (Chrome DevTools Protocol, zero dipendenze) che la
 *  Scheda di Carico stampata (`#print-report`, `PrintReport.tsx`) adotti la
 *  STESSA logica di spezzamento multi-riga di `utils/labels.ts` già usata dal
 *  canvas a schermo (`TruckCanvas.tsx`) e dallo snapshot PNG (`export.ts`):
 *
 *    1. unit (`/src/utils/labels.ts`): `shouldWrapLabel('MIGHIRIAN c/o RAOUL', 120)`
 *       è vero e `splitLabelIntoTwoLines` produce `['MIGHIRIAN', 'c/o RAOUL']`;
 *    2. scheda A4, densità `all`: il collo EUR (120 × 80 cm) rende DUE `<tspan>`
 *       centrate (`MIGHIRIAN` / `c/o RAOUL`) con la quota `120×80` subito sotto,
 *       dentro il `clipPath` del collo; la vecchia stringa troncata con i puntini
 *       (`MIGHIRIAN c/o RA…`) è **sparita** dal documento;
 *    3. geometria reale sotto media `print`: le due righe sono davvero impilate,
 *       centrate sul bancale, con la quota immediatamente sotto;
 *    4. parità col canvas a schermo: gli stessi due frammenti in `<tspan>`;
 *    5. nessuna regressione: un nome corto ("COOP") resta su una riga sola;
 *    6. densità: `client` → solo le due righe del nome; `dimensions` → solo la
 *       quota; `minimal` → nessun testo; ritorno a `all` → due righe di nuovo.
 *
 *  Uso:  node scripts/verify-print-multiline-label.mjs [url]
 *  Chiude sempre con `Browser.close` + `process.exit(0)` entro 10 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://localhost:5199/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9335);
const WATCHDOG_MS = 10000;
const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Il nome composto citato dal task: 3 parole → riga 1 "MIGHIRIAN", riga 2 "c/o RAOUL". */
const COMPOSITE_NAME = 'MIGHIRIAN c/o RAOUL';
const COMPOSITE_LINE_1 = 'MIGHIRIAN';
const COMPOSITE_LINE_2 = 'c/o RAOUL';
/** Vecchio comportamento: troncamento a riga singola con i puntini. */
const LEGACY_TRUNCATED = 'MIGHIRIAN c/o RA…';
/** Nome corto: non deve andare a capo (nessuna regressione). */
const SHORT_NAME = 'COOP';
/** Rapporto fra corpo ridotto (a capo) e corpo base del nome, da `labels.ts`. */
const WRAP_FONT_RATIO = 10 / 11;

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

/** Scrittura nei campi controllati (React 19 intercetta il setter nativo). */
const SET_INPUT = `
  const setInput = (el, next) => {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    desc.set.call(el, next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  };
`;

/**
 * Helper iniettati nella pagina: legge le etichette dei colli della scheda A4
 * raggruppate per collo. Il riferimento è il `clipPath` del collo
 * (`print-clip-*`) e il gruppo `g[clip-path=…]` che lo usa. L'ordine è quello
 * di stiva. Nessuna misura di layout: la scheda è `display: none` a schermo.
 */
const READ_PRINT_HELPERS = `
  const readTspan = (s, inheritedFont) => ({
    text: s.textContent,
    x: Number(s.getAttribute('x')),
    dy: Number(s.getAttribute('dy')),
    fontSize: Number(s.getAttribute('font-size') ?? inheritedFont),
    fontFamily: s.getAttribute('font-family') ?? null,
  });
  const readText = (t) => {
    const textFont = Number(t.getAttribute('font-size'));
    return {
      content: t.textContent,
      x: Number(t.getAttribute('x')),
      fontSize: textFont,
      fontFamily: t.getAttribute('font-family'),
      fontWeight: t.getAttribute('font-weight'),
      fill: t.getAttribute('fill'),
      tspans: Array.from(t.querySelectorAll('tspan')).map((s) => readTspan(s, textFont)),
    };
  };
  const readPrintItems = () => {
    const print = document.getElementById('print-report');
    return Array.from(print.querySelectorAll('g[clip-path^="url(#print-clip-"]')).map((g) => {
      const clipId = g.getAttribute('clip-path').slice(5, -1);
      const clip = document.getElementById(clipId);
      const clipRect = clip ? clip.querySelector('rect') : null;
      return {
        clipId,
        clipRect: clipRect
          ? {
              width: Number(clipRect.getAttribute('width')),
              height: Number(clipRect.getAttribute('height')),
            }
          : null,
        texts: Array.from(g.querySelectorAll('text')).map(readText),
      };
    });
  };
`;

/** Etichette dello stesso collo sul canvas a schermo (parità di resa). */
const READ_CANVAS_LABELS = `
  const canvas = document.getElementById('screen-app');
  const groups = Array.from(canvas.querySelectorAll('g[clip-path^="url(#clip-"]'));
  return groups.map((g) => ({
    texts: Array.from(g.querySelectorAll('text')).map((t) => ({
      content: t.textContent,
      tspans: Array.from(t.querySelectorAll('tspan')).map((s) => s.textContent),
    })),
  }));
`;

const waitFor = async (fn, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timeout in attesa di ${label}`);
    await sleep(100);
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
  const profileDir = mkdtempSync(join(tmpdir(), 'print-label-profile-'));
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
      async () => cdp.eval(`return document.getElementById('pallet-row-EUR') ? 1 : 0;`),
      9000,
      'mount della sidebar'
    );

    /* --- 1) Unit: helper condivisi di `labels.ts` ------------------------ */
    const unit = await cdp.eval(`
      const labels = await import('/src/utils/labels.ts');
      return {
        shouldWrap: labels.shouldWrapLabel(${JSON.stringify(COMPOSITE_NAME)}, 120),
        lines: labels.splitLabelIntoTwoLines(${JSON.stringify(COMPOSITE_NAME)}),
        shouldWrapShort: labels.shouldWrapLabel(${JSON.stringify(SHORT_NAME)}, 120),
        clipId: labels.clipIdForItem('abc-1'),
      };
    `);
    check(
      'Unit: shouldWrapLabel("MIGHIRIAN c/o RAOUL", 120) → true',
      unit.shouldWrap === true,
      `shouldWrap=${unit.shouldWrap}`
    );
    check(
      'Unit: splitLabelIntoTwoLines → ["MIGHIRIAN", "c/o RAOUL"]',
      Array.isArray(unit.lines) &&
        unit.lines[0] === COMPOSITE_LINE_1 &&
        unit.lines[1] === COMPOSITE_LINE_2,
      JSON.stringify(unit.lines)
    );
    check(
      'Unit: "COOP" su collo da 120 cm resta su una riga',
      unit.shouldWrapShort === false,
      `shouldWrap=${unit.shouldWrapShort}`
    );

    /* --- 2) Carico: un collo EUR con nome composto + uno INDU corto ----- */
    const addBatch = async (code, name, expectedCount) => {
      await cdp.eval(`
        ${SET_INPUT}
        if (!document.getElementById('pallet-batch-${code}')) {
          document.getElementById('pallet-row-${code}').click();
        }
        return 1;
      `);
      await waitFor(
        async () => cdp.eval(`return document.getElementById('batch-name-${code}') ? 1 : 0;`),
        4000,
        `cassetto del lotto ${code}`
      );
      await cdp.eval(`
        ${SET_INPUT}
        setInput(document.getElementById('batch-qty-${code}'), '1');
        setInput(document.getElementById('batch-name-${code}'), ${JSON.stringify(name)});
        document.getElementById('batch-add-piatto-${code}').click();
        return 1;
      `);
      await waitFor(
        async () =>
          cdp.eval(`
            ${READ_PRINT_HELPERS}
            return readPrintItems().length >= ${expectedCount} ? 1 : 0;
          `),
        4000,
        `colli nella scheda A4 dopo ${code}`
      );
    };

    await addBatch('EUR', COMPOSITE_NAME, 1);
    await addBatch('INDU', SHORT_NAME, 2);

    /* --- 3) Scheda A4: due righe centrate + quota sotto ------------------ */
    const print1 = await waitFor(
      async () => {
        const snapshot = await cdp.eval(`
          ${READ_PRINT_HELPERS}
          return {
            items: readPrintItems(),
            svgText: document.querySelector('#print-report svg').textContent,
          };
        `);
        return snapshot.items.length >= 2 && snapshot.items[0].texts[0]?.tspans.length === 3
          ? snapshot
          : null;
      },
      4000,
      'etichetta multi-riga nella scheda A4'
    );

    const first = print1.items[0];
    /** Secondo collo (nome corto "COOP"): riferimento per il corpo base del nome. */
    const second = print1.items[1];
    const compositeText = first.texts[0];
    const nameLine1 = compositeText.tspans[0];
    const nameLine2 = compositeText.tspans[1];
    const dimSpan = compositeText.tspans[2];

    check(
      'Scheda A4: un collo EUR (120 × 80) è etichettato da un unico <text>',
      first.texts.length === 1,
      `testi nel gruppo = ${first.texts.length}`
    );
    check(
      'Scheda A4: riga 1 = "MIGHIRIAN" e riga 2 = "c/o RAOUL" in due <tspan>',
      nameLine1?.text === COMPOSITE_LINE_1 && nameLine2?.text === COMPOSITE_LINE_2,
      `tspan[0]="${nameLine1?.text}" tspan[1]="${nameLine2?.text}"`
    );
    check(
      'Scheda A4: le due righe sono CENTRATE (stessa x = 60 cm) con i dy del canvas (-6 / 13)',
      nameLine1?.x === 60 &&
        nameLine2?.x === 60 &&
        nameLine1?.dy === -6 &&
        nameLine2?.dy === 13 &&
        compositeText.x === 60,
      `x=${nameLine1?.x}/${nameLine2?.x} dy=${nameLine1?.dy}/${nameLine2?.dy} (mezzeria collo 60 cm)`
    );
    check(
      'Scheda A4: la quota 120×80 è il 3° tspan, SUBITO SOTTO le due righe (dy 12)',
      dimSpan?.text === '120×80' && dimSpan?.dy === 12 && dimSpan.fontSize < nameLine1.fontSize,
      `quote "${dimSpan?.text}" con dy=${dimSpan?.dy} dopo le due righe (baseline relativa ${nameLine1?.dy + nameLine2?.dy + dimSpan?.dy} cm)`
    );
    check(
      'Scheda A4: corpo ridotto per il nome a capo (10/11) e quota in mono, più piccola',
      near(nameLine1.fontSize, second.texts[0].fontSize * WRAP_FONT_RATIO, 0.02) &&
        nameLine1.fontSize < second.texts[0].fontSize &&
        dimSpan.fontSize < nameLine1.fontSize &&
        String(dimSpan.fontFamily).includes('Mono'),
      `nome a capo ${nameLine1.fontSize} cm < nome a riga singola ${second.texts[0].fontSize} cm; quota ${dimSpan.fontSize} cm (${dimSpan.fontFamily})`
    );
    check(
      'Scheda A4: il testo del collo è ritagliato dal proprio clipPath (120 × 80)',
      first.clipId.startsWith('print-clip-') &&
        first.clipRect?.width === 120 &&
        first.clipRect?.height === 80,
      `#${first.clipId} → ${JSON.stringify(first.clipRect)}`
    );

    /* --- 4) Il vecchio troncamento con i puntini è SPARITO -------------- */
    check(
      'Scheda A4: nessun carattere di troncamento "…" nel disegno stampato',
      !print1.svgText.includes('…'),
      `occorrenze di "…": ${(print1.svgText.match(/…/g) ?? []).length} (prima della fix: "${LEGACY_TRUNCATED}")`
    );

    const legacy = await cdp.eval(`
      const print = document.getElementById('print-report');
      const drawing = print.querySelector('svg').textContent;
      const full = print.textContent;
      return {
        truncatedInDrawing: drawing.includes(${JSON.stringify(LEGACY_TRUNCATED)}),
        firstLineTruncated: drawing.includes('MIGHIRIAN…'),
        fullTableHasUntruncatedName: full.includes(${JSON.stringify(COMPOSITE_NAME)}),
      };
    `);
    check(
      'Scheda A4: la stringa troncata "MIGHIRIAN c/o RA…" NON esiste più nel disegno',
      legacy.truncatedInDrawing === false && legacy.firstLineTruncated === false,
      `truncatedInDrawing=${legacy.truncatedInDrawing}, firstLineTruncated=${legacy.firstLineTruncated}`
    );
    check(
      'Scheda A4: la tabella riepilogo riporta il nome integrale',
      legacy.fullTableHasUntruncatedName === true,
      `nome integrale presente = ${legacy.fullTableHasUntruncatedName}`
    );

    /* --- 5) Parità con il canvas a schermo ------------------------------ */
    const canvasLabels = await cdp.eval(READ_CANVAS_LABELS);
    const canvasComposite = canvasLabels[0]?.texts?.[0];
    check(
      'Canvas: lo stesso collo ha le stesse due righe in <tspan> (parità di resa)',
      canvasComposite?.tspans?.[0] === COMPOSITE_LINE_1 &&
        canvasComposite?.tspans?.[1] === COMPOSITE_LINE_2,
      `canvas = ${JSON.stringify(canvasComposite?.tspans)}`
    );

    /* --- 6) Nessuna regressione: nome corto su una riga sola ------------ */
    check(
      'Scheda A4: il nome corto "COOP" resta su riga singola (due <text>, zero <tspan>)',
      second.texts.length === 2 &&
        second.texts.every((t) => t.tspans.length === 0) &&
        second.texts[0].content === SHORT_NAME &&
        second.texts[1].content.includes('×'),
      `testi = ${JSON.stringify(second.texts.map((t) => t.content))}`
    );

    /* --- 7) Densità etichette ------------------------------------------- */
    const setDensity = async (label) =>
      cdp.eval(`
        const group = document.querySelector('[aria-label="Densità etichette"]');
        const button = Array.from(group.querySelectorAll('button')).find(
          (b) => b.textContent.trim() === ${JSON.stringify(label)}
        );
        button.click();
        return button.getAttribute('aria-pressed');
      `);

    const readPrintItems = () => cdp.eval(`${READ_PRINT_HELPERS} return { items: readPrintItems() };`);

    await setDensity('Cliente');
    const densityClient = await waitFor(async () => {
      const snapshot = await readPrintItems();
      const text = snapshot.items[0]?.texts[0];
      return text && text.tspans.length === 2 ? snapshot : null;
    }, 3000, 'densità Cliente');
    check(
      'Densità `client`: solo le due righe del nome, nessuna quota',
      densityClient.items[0].texts.length === 1 &&
        densityClient.items[0].texts[0].tspans.map((s) => s.text).join('|') ===
          [COMPOSITE_LINE_1, COMPOSITE_LINE_2].join('|'),
      `contenuto = "${densityClient.items[0].texts[0].content}"`
    );

    await setDensity('Misure');
    const densityDimensions = await waitFor(async () => {
      const snapshot = await readPrintItems();
      const text = snapshot.items[0]?.texts[0];
      return text && text.content === '120×80' ? snapshot : null;
    }, 3000, 'densità Misure');
    check(
      'Densità `dimensions`: solo la quota 120×80, nessun nome',
      densityDimensions.items[0].texts.length === 1 &&
        densityDimensions.items[0].texts[0].tspans.length === 0,
      `contenuto = "${densityDimensions.items[0].texts[0].content}"`
    );

    await setDensity('Minimal');
    const densityMinimal = await waitFor(async () => {
      const snapshot = await readPrintItems();
      return snapshot.items[0] && snapshot.items[0].texts.length === 0 ? snapshot : null;
    }, 3000, 'densità Minimal');
    check(
      'Densità `minimal`: nessun testo nel collo (solo blocco colorato)',
      densityMinimal.items[0].texts.length === 0,
      `testi = ${densityMinimal.items[0].texts.length}`
    );

    await setDensity('Tutto');
    const densityAll = await waitFor(async () => {
      const snapshot = await readPrintItems();
      const text = snapshot.items[0]?.texts[0];
      return text && text.tspans.length === 3 ? snapshot : null;
    }, 3000, 'ritorno a densità Tutto');
    check(
      'Ritorno a `all`: le due righe e la quota ricompaiono identiche',
      densityAll.items[0].texts[0].tspans.map((s) => s.text).join('|') ===
        [COMPOSITE_LINE_1, COMPOSITE_LINE_2, '120×80'].join('|'),
      `tspan = ${JSON.stringify(densityAll.items[0].texts[0].tspans.map((s) => s.text))}`
    );

    /* --- Evidenza grafica del canvas (media `screen`) ------------------- */
    mkdirSync('shots', { recursive: true });
    const screenShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(
      'shots/canvas-etichetta-multiriga-pallet.png',
      Buffer.from(screenShot.data, 'base64')
    );

    /* --- 8) Geometria REALE sulla scheda A4 (media `print`) ------------- */
    await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
    const geometry = await waitFor(
      async () => {
        const snapshot = await cdp.eval(`
          ${READ_PRINT_HELPERS}
          const print = document.getElementById('print-report');
          const display = getComputedStyle(print).display;
          const groups = Array.from(print.querySelectorAll('g[clip-path^="url(#print-clip-"]'));
          const items = groups.map((g) => {
            const host = g.parentElement;
            const rect = host.querySelector(':scope > rect');
            const box = rect.getBoundingClientRect();
            return {
              pallet: { centerX: (box.left + box.right) / 2, width: box.width, height: box.height },
              texts: Array.from(g.querySelectorAll('text')).map((t) => {
                const r = t.getBoundingClientRect();
                return {
                  text: t.textContent,
                  height: Number(r.height.toFixed(2)),
                  centerX: Number(((r.left + r.right) / 2).toFixed(2)),
                };
              }),
              lines: Array.from(g.querySelectorAll('tspan')).map((s) => {
                const r = s.getBoundingClientRect();
                return {
                  text: s.textContent,
                  top: Number(r.top.toFixed(2)),
                  height: Number(r.height.toFixed(2)),
                  centerX: Number(((r.left + r.right) / 2).toFixed(2)),
                };
              }),
            };
          });
          return { display, items };
        `);
        return snapshot.display === 'flex' && snapshot.items[0]?.lines.length === 3
          ? snapshot
          : null;
      },
      3000,
      'scheda A4 in media print'
    );
    const geoItem = geometry.items[0];
    const geoLine1 = geoItem.lines[0];
    const geoLine2 = geoItem.lines[1];
    const geoDim = geoItem.lines[2];
    check(
      'Scheda A4 (media print): la scheda è realmente impaginata (display: flex)',
      geometry.display === 'flex',
      `display=${geometry.display}, bancale ${geoItem.pallet.width.toFixed(1)}×${geoItem.pallet.height.toFixed(1)} px`
    );
    check(
      'Scheda A4 (media print): le due righe sono impilate, la quota è sotto la seconda',
      geoLine1.top < geoLine2.top && geoLine2.top < geoDim.top && geoLine1.height > 0,
      `top riga1=${geoLine1.top} < riga2=${geoLine2.top} < quota=${geoDim.top} px`
    );
    check(
      'Scheda A4 (media print): entrambe le righe sono centrate sul bancale',
      Math.abs(geoLine1.centerX - geoItem.pallet.centerX) <= 1.5 &&
        Math.abs(geoLine2.centerX - geoItem.pallet.centerX) <= 1.5 &&
        Math.abs(geoDim.centerX - geoItem.pallet.centerX) <= 1.5,
      `centri ${geoLine1.centerX} / ${geoLine2.centerX} / ${geoDim.centerX} vs bancale ${geoItem.pallet.centerX.toFixed(1)} px`
    );
    const geoShort = geometry.items[1].texts[0];
    check(
      'Scheda A4 (media print): il nome a capo è reso con corpo visibilmente ridotto',
      geoLine1.height < geoShort.height && geoShort.height - geoLine1.height <= 2,
      `altezza glifo riga 1 ${geoLine1.height} px < ${geoShort.height} px a riga singola (rapporto ${(geoLine1.height / geoShort.height).toFixed(3)}; il rapporto esatto 10/11 = ${WRAP_FONT_RATIO.toFixed(3)} è verificato sull'attributo font-size)`
    );

    const a4Shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('shots/scheda-a4-etichetta-multiriga.png', Buffer.from(a4Shot.data, 'base64'));
    await cdp.send('Emulation.setEmulatedMedia', { media: '' });
    console.log(
      'Evidenza grafica: shots/canvas-etichetta-multiriga-pallet.png, shots/scheda-a4-etichetta-multiriga.png'
    );

    /* --- 9) Nessun errore in console ------------------------------------ */
    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    console.log(`\n${passed}/${passed + failed} controlli superati`);
    console.log(
      `Durata della verifica: ${((Date.now() - startedAt) / 1000).toFixed(2)} s (limite 10 s)`
    );
  } finally {
    try {
      ws?.close();
    } catch {
      /* il websocket potrebbe essere già chiuso */
    }
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
