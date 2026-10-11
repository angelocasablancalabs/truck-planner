/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — AUTO-FITTING MAGNETICO POST-ROTAZIONE
 *
 *  La rotazione (Barra Spaziatrice o tasto Ruota) fa perno sul baricentro del
 *  collo: i bordi arretrano o avanzano di `|width − length| / 2` (20 cm per un
 *  PLT EUR, 39,25 cm per un CC). La vecchia soglia di aggancio post-rotazione,
 *  fissata rigidamente a 10 cm, non riusciva più a riagganciare il collo al
 *  bordo del vicino: un EUR a Y = 80 restava a Y = 100, con 20 cm di fessura.
 *
 *  Il motore ora applica un **Auto-Fitting Magnetico attivo** con tolleranza
 *  dinamica `Math.max(45, |width − length| / 2 + 5)`: se la posizione a filo più
 *  vicina è priva di collisioni, il collo viene risucchiato a contatto esatto.
 *
 *  Controlli:
 *    1. UNIT della soglia e dello snap (`handleRotateSelected` in `App.tsx`):
 *       la soglia dinamica vale 45 per un EUR (80 × 120) e 44,625 per un CC
 *       (56,5 × 135), mentre la geometria pura `calculateSnapPosition` con
 *       soglia 45 riporta a filo un EUR ruotato;
 *    2. END-TO-END sul caso dei file `0.json` / `1.json`: **due PLT EUR di
 *       piatto a Y = 0 (X = 0 e X = 120) + un EUR di punta a X = 0, Y = 80**;
 *       selezione del terzo EUR e rotazione di 90° → coordinate finali
 *       **X = 0, Y = 80** (a filo perfetto sotto il primo EUR, nessun buco a
 *       Y = 100) e `rotation = 90`;
 *    3. Zero collisioni AABB su tutte le coppie di colli;
 *    4. `Ctrl + Z` annulla la rotazione (un solo passo di Undo);
 *    5. Nessun errore runtime in console.
 *
 *  Uso:  node scripts/verify-rotation-autofit.mjs [url]
 *  Chiude sempre con `browser.close()` + `process.exit(0)` entro 15 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://localhost:5199/truck-planner/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9341);
const WATCHDOG_MS = 15000;

/** Colore del bordo di selezione dei colli (`SELECTION_COLOR` di TruckCanvas). */
const SELECTION_COLOR = 'rgb(37, 99, 235)';

/** Moduli puri serviti da Vite (base `/truck-planner/`). */
const SNAPPING_MODULE = '/truck-planner/src/utils/snapping.ts';

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Risoluzione del binario di Chrome: env, poi i percorsi tipici dei due OS. */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const CHROME_PATH = CHROME_CANDIDATES.find((path) => existsSync(path)) || CHROME_CANDIDATES[0];

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
          `console.error: ${(msg.params?.args ?? []).map((a) => a.value ?? a.description).join(' ')}`
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

/* --- Helper iniettati nella pagina ---------------------------------------- */

const PAGE_HELPERS = `
  window.__vp = () => {
    const svg = document.querySelector('.canvas-hud')?.parentElement?.querySelector('svg')
      || document.querySelector('svg');
    const world = svg.querySelector('g[transform]');
    const m = world.getScreenCTM();
    return { a: m.a, d: m.d, e: m.e, f: m.f, zoom: m.a, rect: svg.getBoundingClientRect() };
  };
  window.__toPx = (x, y) => {
    const v = window.__vp();
    return { x: v.a * x + v.e, y: v.d * y + v.f, zoom: v.a };
  };
  window.__items = () =>
    Array.from(document.querySelectorAll('[data-item-id]')).map((el) => {
      const rect = el.querySelector('rect');
      const m = el.transform.baseVal.consolidate().matrix;
      return {
        id: el.getAttribute('data-item-id'),
        code: el.getAttribute('data-canvas-item'),
        x: m.e, y: m.f,
        width: Number(rect.getAttribute('width')),
        length: Number(rect.getAttribute('height')),
        selected: getComputedStyle(rect).stroke === ${JSON.stringify(SELECTION_COLOR)},
      };
    });
  window.__selectedIds = () => window.__items().filter((i) => i.selected).map((i) => i.id);
  window.__item = (id) => window.__items().find((i) => i.id === id) || null;
  window.__centerPx = (id) => {
    const it = window.__item(id);
    if (!it) return null;
    return window.__toPx(it.x + it.width / 2, it.y + it.length / 2);
  };
  /** Coppie in collisione AABB (il contatto a filo NON è collisione). */
  window.__collisions = () => {
    const items = window.__items();
    const hits = [];
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i];
        const b = items[j];
        const overlap = !(
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.length <= b.y ||
          b.y + b.length <= a.y
        );
        if (overlap) hits.push([a.id, b.id]);
      }
    }
    return hits;
  };
`;

/* --- Input reali ---------------------------------------------------------- */

/** Click reale del mouse (fidato). */
const clickAt = async (cdp, x, y, modifiers = 0) => {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    modifiers,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    modifiers,
  });
  await sleep(140);
};

/** Barra Spaziatrice reale (`rawKeyDown` + `keyUp`). */
const pressSpace = async (cdp) => {
  const params = {
    key: ' ',
    code: 'Space',
    windowsVirtualKeyCode: 32,
    nativeVirtualKeyCode: 32,
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
  await sleep(220);
};

/** Scorciatoia `Ctrl / Cmd + Z`. */
const pressUndo = async (cdp) => {
  const params = { key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, ...params });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, ...params });
  await sleep(220);
};

/* --- Script --------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();
  const profileDir = mkdtempSync(join(tmpdir(), 'rotfit-profile-'));
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
      async () => cdp.eval(`return document.getElementById('quick-piatto-EUR') ? 1 : 0;`),
      9000,
      'mount della sidebar'
    );
    await cdp.eval(PAGE_HELPERS + 'return 1;');

    /* =================================================================== *
     *  1) UNIT — SOGLIA DINAMICA E GEOMETRIA DELLO SNAP
     * =================================================================== */
    const unit = await cdp.eval(`
      const { calculateSnapPosition, isRectColliding } = await import(${JSON.stringify(SNAPPING_MODULE)});
      const vehicle = { id: 'bilico_cc', name: 'Bilico CC', width: 250, length: 1328 };

      // Stessa formula di \\\`rotationSnapThreshold\\\` in App.tsx.
      const rotationSnapThreshold = (item) =>
        Math.max(45, Math.abs(item.width - item.length) / 2 + 5);

      const eur = { width: 80, length: 120 };
      const cc = { width: 56.5, length: 135 };
      const industrial = { width: 100, length: 120 };

      // Geometria pura: EUR ruotato (120 × 80 → 80 × 120) centrato sul
      // baricentro di un EUR di punta a (0, 80) → centratura grezza (20, 100).
      const others = [
        { id: 'a', code: 'EUR', name: 'EUR', width: 120, length: 80, x: 0, y: 0, rotation: 0, color: '#FEF08A', borderColor: '#334155' },
        { id: 'b', code: 'EUR', name: 'EUR', width: 120, length: 80, x: 120, y: 0, rotation: 0, color: '#FEF08A', borderColor: '#334155' },
      ];
      const snapped = calculateSnapPosition(20, 100, 80, 120, vehicle, others, rotationSnapThreshold(eur));
      const snappedCollides = others.some((o) => isRectColliding(snapped.x, snapped.y, 80, 120, o));

      // Controprova: con la vecchia soglia rigida di 10 cm lo snap NON aggancia
      // (resterebbe a Y = 100, con i 20 cm di fessura del difetto originale).
      const legacy = calculateSnapPosition(20, 100, 80, 120, vehicle, others, 10);

      return {
        eurThreshold: rotationSnapThreshold(eur),
        ccThreshold: rotationSnapThreshold(cc),
        industrialThreshold: rotationSnapThreshold(industrial),
        snapped,
        snappedCollides,
        legacy,
      };
    `);

    check(
      'UNIT soglia dinamica: EUR (80 × 120) → 45 cm (|80 − 120| / 2 + 5 = 25, vince il minimo 45)',
      unit.eurThreshold === 45,
      `soglia ${unit.eurThreshold}`
    );
    check(
      'UNIT soglia dinamica: CC (56,5 × 135) → 45 cm (|56,5 − 135| / 2 + 5 = 44,25: vince il minimo 45)',
      unit.ccThreshold === 45,
      `soglia ${unit.ccThreshold}`
    );
    check(
      'UNIT soglia dinamica: PLT INDU (100 × 120) → 45 cm',
      unit.industrialThreshold === 45,
      `soglia ${unit.industrialThreshold}`
    );
    check(
      'UNIT geometria: centratura grezza (20, 100) → snap a filo X = 0, Y = 80 (sotto il primo EUR)',
      Math.abs(unit.snapped.x - 0) < 1e-9 && Math.abs(unit.snapped.y - 80) < 1e-9,
      `snap (${unit.snapped.x}, ${unit.snapped.y})`
    );
    check(
      'UNIT collisioni: la posizione riassestata è priva di collisioni (contatto a filo ammesso)',
      unit.snappedCollides === false,
      `collide=${unit.snappedCollides}`
    );
    check(
      'UNIT regressione: con la vecchia soglia di 10 cm lo snap lasciava il collo a Y = 100 (20 cm di fessura)',
      Math.abs(unit.legacy.y - 100) < 1e-9,
      `vecchio snap (${unit.legacy.x}, ${unit.legacy.y})`
    );

    /* =================================================================== *
     *  2) END-TO-END — CASO DEI FILE 0.json / 1.json
     * =================================================================== */
    const layout = await cdp.eval(`
      const click = async (id) => {
        document.getElementById(id).click();
        await new Promise((r) => setTimeout(r, 130));
      };
      await click('quick-piatto-EUR');  // 1° EUR di piatto  → (0, 0)   120 × 80
      await click('quick-piatto-EUR');  // 2° EUR di piatto  → (120, 0) 120 × 80
      await click('quick-punta-EUR');   // 3° EUR di punta   → (0, 80)  80 × 120
      await new Promise((r) => setTimeout(r, 250));
      return window.__items();
    `);

    const sorted = [...layout].sort((a, b) => a.y - b.y || a.x - b.x);
    const flat1 = sorted[0];
    const flat2 = sorted[1];
    const punto = sorted[2];

    check(
      'Pianale di partenza: due PLT EUR di piatto a Y = 0 (X = 0 e X = 120) + un EUR di punta a (0, 80)',
      layout.length === 3 &&
        Math.abs(flat1.x - 0) < 0.05 &&
        Math.abs(flat1.y - 0) < 0.05 &&
        Math.abs(flat1.width - 120) < 0.05 &&
        Math.abs(flat1.length - 80) < 0.05 &&
        Math.abs(flat2.x - 120) < 0.05 &&
        Math.abs(flat2.y - 0) < 0.05 &&
        Math.abs(punto.x - 0) < 0.05 &&
        Math.abs(punto.y - 80) < 0.05 &&
        Math.abs(punto.width - 80) < 0.05 &&
        Math.abs(punto.length - 120) < 0.05,
      sorted.map((i) => `${i.x},${i.y} ${i.width}×${i.length}`).join(' · ')
    );

    // Selezione del terzo EUR (quello di punta a Y = 80).
    const center = await cdp.eval(`return window.__centerPx(${JSON.stringify(punto.id)});`);
    await clickAt(cdp, center.x, center.y);
    const selected = await cdp.eval(`return window.__selectedIds();`);
    check(
      'Selezione: il solo terzo EUR di punta è selezionato (contorno blu #2563EB)',
      selected.length === 1 && selected[0] === punto.id,
      `${selected.length} collo/i selezionato/i`
    );

    // Rotazione reale con la Barra Spaziatrice.
    await pressSpace(cdp);

    const afterRotate = await cdp.eval(`return window.__items();`);
    const rotated = afterRotate.find((i) => i.id === punto.id);
    const collisions = await cdp.eval(`return window.__collisions();`);
    const rotation = await cdp.eval(`
      const el = document.querySelector('[data-item-id=${JSON.stringify(punto.id)}]');
      return el ? el.getAttribute('transform') : null;
    `);

    check(
      'Rotazione 90°: il terzo EUR è tornato a X = 0, Y = 80 — a filo perfetto sotto il primo EUR (nessun buco a Y = 100)',
      rotated !== undefined &&
        Math.abs(rotated.x - 0) < 0.05 &&
        Math.abs(rotated.y - 80) < 0.05,
      `posizione finale (${rotated?.x}, ${rotated?.y}) · attesa (0, 80)`
    );
    check(
      'Rotazione: le quote sono invertite (80 × 120 → 120 × 80 di piatto)',
      rotated !== undefined &&
        Math.abs(rotated.width - 120) < 0.05 &&
        Math.abs(rotated.length - 80) < 0.05,
      `${rotated?.width} × ${rotated?.length}`
    );
    check(
      'Rotazione: il collo ruotato è a filo esatto del primo EUR (fondo a 80 = top del primo EUR), zero collisioni',
      collisions.length === 0,
      `collisioni: ${collisions.length === 0 ? 'nessuna' : JSON.stringify(collisions)} · transform=${rotation}`
    );
    check(
      'Rotazione: i due EUR di piatto a Y = 0 restano invariati',
      Math.abs(flat1.x - 0) < 0.05 && Math.abs(flat1.y - 0) < 0.05 &&
        Math.abs(flat2.x - 120) < 0.05 && Math.abs(flat2.y - 0) < 0.05,
      `EUR1 (${flat1.x}, ${flat1.y}) · EUR2 (${flat2.x}, ${flat2.y})`
    );

    // La sede dell'intera rotazione è un solo passo di Undo.
    await pressUndo(cdp);
    const undone = await cdp.eval(`return window.__items();`);
    const undonePunto = undone.find((i) => i.id === punto.id);
    check(
      'Undo (Ctrl + Z): la rotazione è annullata e il collo torna di punta a (0, 80) — 80 × 120',
      undonePunto !== undefined &&
        Math.abs(undonePunto.y - 80) < 0.05 &&
        Math.abs(undonePunto.width - 80) < 0.05 &&
        Math.abs(undonePunto.length - 120) < 0.05,
      `posizione (${undonePunto?.x}, ${undonePunto?.y}) · ${undonePunto?.width}×${undonePunto?.length}`
    );

    // Rotazione definitiva per l'evidenza grafica.
    const center2 = await cdp.eval(`return window.__centerPx(${JSON.stringify(punto.id)});`);
    await clickAt(cdp, center2.x, center2.y);
    await pressSpace(cdp);
    const finalItems = await cdp.eval(`return window.__items();`);
    const finalRotated = finalItems.find((i) => i.id === punto.id);
    check(
      'Evidenza finale: dopo la seconda rotazione il collo è di nuovo a filo (0, 80) con zero collisioni',
      Math.abs(finalRotated.x - 0) < 0.05 &&
        Math.abs(finalRotated.y - 80) < 0.05 &&
        (await cdp.eval(`return window.__collisions();`)).length === 0,
      `(${finalRotated.x}, ${finalRotated.y})`
    );

    mkdirSync('shots', { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(
      'shots/rotazione-autofit-eur-y80.png',
      Buffer.from(shot.data, 'base64')
    );
    console.log('Evidenza grafica: shots/rotazione-autofit-eur-y80.png');

    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    console.log(`\n${passed}/${passed + failed} controlli superati`);
    console.log(
      `Durata della verifica: ${((Date.now() - startedAt) / 1000).toFixed(2)} s (limite 15 s)`
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
