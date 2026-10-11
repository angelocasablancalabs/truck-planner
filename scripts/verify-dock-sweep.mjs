/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — SPINTA A BATTUTA NEI 4 PUNTI CARDINALI (SWEEP DOCKING)
 *
 *  Il blocco dei colli selezionati viene spinto **rigidamente** verso uno dei
 *  quattro punti cardinali del pianale e si arresta **a filo esatto** (0 cm di
 *  distanza) contro la parete o contro il primo ostacolo incontrato, senza mai
 *  generare collisioni. La fisica vive nella funzione pura
 *  `calculateDockDisplacement` (`src/utils/snapping.ts`), unica fonte di verità
 *  condivisa dai due pulsanti della sidebar e dalle quattro frecce della
 *  tastiera; ogni spinta registra un fotogramma di Undo.
 *
 *  Controlli:
 *    1. UNIT del motore puro (`/truck-planner/src/utils/snapping.ts`): i quattro
 *       punti cardinali, l'arresto a filo dell'ostacolo, l'ostacolo fuori fascia
 *       che NON limita, il blocco già a battuta e la selezione vuota;
 *    2. END-TO-END sul caso reale dei **2 carrelli CC** a `X = 0` e `X = 56.5`:
 *       `ArrowRight` → `X = 137` e `X = 193.5` (Δ esatto +137, a battuta sulla
 *       parete da 250 cm), `ArrowLeft` → ritorno a `X = 0` / `X = 56.5`,
 *       `Ctrl + Z` → l'azione è annullata;
 *    3. Pulsanti della sidebar `Spingi a SX` / `Spingi a DX` con la stessa
 *       fisica delle frecce;
 *    4. Ostacolo a `X = 200`: la spinta a destra si arresta **a filo** e la
 *       verifica di collisione AABB su tutte le coppie resta falsa;
 *    5. Guardia dei campi di scrittura (freccia nel campo `Targa` → nessuna
 *       spinta) e voce del popover delle scorciatoie;
 *    6. Nessun errore runtime in console.
 *
 *  Uso:  node scripts/verify-dock-sweep.mjs [url]
 *  Chiude sempre con `Browser.close()` + `process.exit(0)` entro 15 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://localhost:5199/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9340);
const WATCHDOG_MS = 15000;

/** Colore del bordo di selezione dei colli (`SELECTION_COLOR` di TruckCanvas). */
const SELECTION_COLOR = 'rgb(37, 99, 235)';

/** Percorso del modulo puro sul dev server (Vite serve sotto `base`). */
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

/**
 * Conversione cm ↔ px schermo tramite la matrice reale del `<g>` trasformato e
 * lettura geometrica dei colli resi (posizione, quote, stato di selezione).
 */
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

/* --- Input reali (mouse e tastiera) --------------------------------------- */

const ARROW_KEYS = {
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
};

/** Preme e rilascia un tasto reale (`rawKeyDown` + `keyUp`). */
const pressKey = async (cdp, spec, modifiers = 0) => {
  const params = {
    modifiers,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
  };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
  await sleep(120);
};

const arrow = (cdp, name) => pressKey(cdp, ARROW_KEYS[name]);

const ctrlKey = (cdp, letter, vk, code, modifiers = 2) =>
  pressKey(cdp, { key: letter, code, vk }, modifiers);

/** Click reale del mouse (fidato) con modificatori opzionali. */
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
  await sleep(120);
};

/** Trascinamento reale del mouse in più passi (drag dei colli sul canvas). */
const dragFromTo = async (cdp, from, to, steps = 8) => {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: from.x,
    y: from.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      button: 'left',
      buttons: 1,
    });
    await sleep(25);
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: to.x,
    y: to.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await sleep(180);
};

/* --- Script ----------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();
  const profileDir = mkdtempSync(join(tmpdir(), 'dock-profile-'));
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
      async () => cdp.eval(`return document.getElementById('quick-punta-CC') ? 1 : 0;`),
      9000,
      'mount della sidebar'
    );
    await cdp.eval(PAGE_HELPERS + 'return 1;');

    /* =================================================================== *
     *  1) UNIT DEL MOTORE PURO
     * =================================================================== */
    const unit = await cdp.eval(`
      const { calculateDockDisplacement } = await import(${JSON.stringify(SNAPPING_MODULE)});
      const vehicle = { id: 'bilico_cc', name: 'Bilico CC', width: 250, length: 1328 };
      const cc = (id, x, y) => ({
        id, code: 'CC', name: 'CC', width: 56.5, length: 135,
        x, y, rotation: 0, color: '#E2E8F0', borderColor: '#334155',
      });
      const box = (id, x, y, w = 40, l = 50) => ({
        id, code: 'CUSTOM', name: 'Ostacolo', width: w, length: l,
        x, y, rotation: 0, color: '#CBD5E1', borderColor: '#334155',
      });
      const ids = (...list) => list.map((i) => i.id);

      // Caso reale del task: 2 carrelli CC affiancati alla parete sinistra.
      const pair = [cc('a', 0, 0), cc('b', 56.5, 0)];
      const right = calculateDockDisplacement(pair, ids(pair[0], pair[1]), 'right', vehicle);

      // Gli stessi due carrelli già a battuta sulla parete destra.
      const docked = [cc('a', 137, 0), cc('b', 193.5, 0)];
      const left = calculateDockDisplacement(docked, ids(docked[0], docked[1]), 'left', vehicle);

      // Ostacolo (40 × 50) sulla destra a X = 200, stessa fascia Y.
      const withObstacle = [...pair, box('obs', 200, 0)];
      const rightObstacle = calculateDockDisplacement(withObstacle, ids(pair[0], pair[1]), 'right', vehicle);

      // Ostacolo fuori fascia Y: non deve limitare la spinta a destra.
      const offBand = [...pair, box('far', 200, 400)];
      const rightOffBand = calculateDockDisplacement(offBand, ids(pair[0], pair[1]), 'right', vehicle);

      // Ostacolo a filo del bordo destro del blocco: già a battuta.
      const flush = [...pair, box('flush', 113, 0)];
      const rightFlush = calculateDockDisplacement(flush, ids(pair[0], pair[1]), 'right', vehicle);

      // In alto: il blocco è già contro la Cabina.
      const up = calculateDockDisplacement(pair, ids(pair[0], pair[1]), 'up', vehicle);

      // In basso: battuta sulle Porte posteriori (Y = 1328).
      const down = calculateDockDisplacement(pair, ids(pair[0], pair[1]), 'down', vehicle);

      // In basso con un ostacolo sotto (Y = 200), stessa fascia X.
      const below = [...pair, box('below', 0, 200)];
      const downObstacle = calculateDockDisplacement(below, ids(pair[0], pair[1]), 'down', vehicle);

      // In alto con un ostacolo sopra (Y = 100, fondo 150), blocco a Y = 300.
      const upper = [cc('a', 0, 300), cc('b', 56.5, 300), box('above', 0, 100)];
      const upObstacle = calculateDockDisplacement(upper, ['a', 'b'], 'up', vehicle);

      // Selezione vuota: nessuna spinta.
      const empty = calculateDockDisplacement(pair, [], 'right', vehicle);

      return { right, left, rightObstacle, rightOffBand, rightFlush, up, down, downObstacle, upObstacle, empty };
    `);

    check(
      'UNIT right: 2 CC a X = 0 / 56.5 → a battuta sulla parete da 250 cm (Δ +137 esatto)',
      unit.right.dx === 137 && unit.right.dy === 0,
      `dx=${unit.right.dx}, dy=${unit.right.dy}`
    );
    check(
      'UNIT left: 2 CC a X = 137 / 193.5 → ritorno a filo della parete sinistra (Δ −137)',
      unit.left.dx === -137 && unit.left.dy === 0,
      `dx=${unit.left.dx}, dy=${unit.left.dy}`
    );
    check(
      'UNIT right con ostacolo a X = 200: arresto a filo (Δ +87: bordo del blocco esattamente a 200)',
      unit.rightObstacle.dx === 87 && unit.rightObstacle.dy === 0,
      `dx=${unit.rightObstacle.dx} (56.5 + 87 = 143.5, bordo 200), dy=${unit.rightObstacle.dy}`
    );
    check(
      'UNIT right con ostacolo fuori fascia Y: non limita la spinta (parete a 137)',
      unit.rightOffBand.dx === 137,
      `dx=${unit.rightOffBand.dx}`
    );
    check(
      'UNIT right con ostacolo a filo del blocco: già a battuta, nessun movimento',
      unit.rightFlush.dx === 0 && unit.rightFlush.dy === 0,
      `dx=${unit.rightFlush.dx}, dy=${unit.rightFlush.dy}`
    );
    check(
      'UNIT up: blocco già contro la Cabina → nessun movimento',
      unit.up.dx === 0 && unit.up.dy === 0,
      `dx=${unit.up.dx}, dy=${unit.up.dy}`
    );
    check(
      'UNIT down: 2 CC a Y = 0 → a battuta sulle Porte posteriori (Δ +1193 = 1328 − 135)',
      unit.down.dx === 0 && unit.down.dy === 1193,
      `dx=${unit.down.dx}, dy=${unit.down.dy}`
    );
    check(
      'UNIT down con ostacolo sotto a Y = 200: arresto a filo (Δ +65 = 200 − 135)',
      unit.downObstacle.dy === 65,
      `dy=${unit.downObstacle.dy}`
    );
    check(
      'UNIT up con ostacolo sopra (fondo 150) e blocco a Y = 300: arresto a filo (Δ −150)',
      unit.upObstacle.dy === -150 && unit.upObstacle.dx === 0,
      `dx=${unit.upObstacle.dx}, dy=${unit.upObstacle.dy}`
    );
    check(
      'UNIT selezione vuota: nessuna spinta (dx = 0, dy = 0)',
      unit.empty.dx === 0 && unit.empty.dy === 0,
      `dx=${unit.empty.dx}, dy=${unit.empty.dy}`
    );

    /* =================================================================== *
     *  2) END-TO-END — I 2 CARRELLI CC (X = 0 / 56.5)
     * =================================================================== */
    await cdp.eval(`
      for (let i = 0; i < 2; i += 1) {
        document.getElementById('quick-punta-CC').click();
        await new Promise((r) => setTimeout(r, 120));
      }
      await new Promise((r) => setTimeout(r, 200));
      return 1;
    `);

    let items = await cdp.eval(`return window.__items();`);
    const ccBlock = [...items].sort((a, b) => a.x - b.x);
    const cc1 = ccBlock[0];
    const cc2 = ccBlock[1];
    check(
      'Pianale: 2 carrelli CC (56,5 × 135 cm) affiancati a X = 0 e X = 56,5 — la battuta di partenza',
      items.length === 2 &&
        Math.abs(cc1.x - 0) < 0.05 &&
        Math.abs(cc2.x - 56.5) < 0.05 &&
        Math.abs(cc1.width - 56.5) < 0.05,
      items.map((i) => `${i.code}@${i.x},${i.y} ${i.width}×${i.length}`).join(' · ')
    );

    // Selezione del blocco: click su CC1, poi Ctrl + click su CC2
    // (fallback Meta: su macOS il Ctrl + click sinistro può diventare contesto).
    const c1 = await cdp.eval(`return window.__centerPx(${JSON.stringify(cc1.id)});`);
    const c2 = await cdp.eval(`return window.__centerPx(${JSON.stringify(cc2.id)});`);
    await clickAt(cdp, c1.x, c1.y);
    await clickAt(cdp, c2.x, c2.y, 2);
    let selected = await cdp.eval(`return window.__selectedIds();`);
    if (selected.length !== 2) {
      // Fallback: `Ctrl` intercettato dal contesto di macOS → si usa `Cmd`.
      await clickAt(cdp, c1.x, c1.y);
      await clickAt(cdp, c2.x, c2.y, 4);
      selected = await cdp.eval(`return window.__selectedIds();`);
    }
    check(
      'Selezione del blocco: i 2 carrelli CC sono selezionati (contorno blu #2563EB)',
      selected.length === 2,
      `${selected.length} colli selezionati`
    );

    const buttons = await cdp.eval(`
      const list = Array.from(document.querySelectorAll('[title^="Spingi a battuta a"]'));
      return list.map((b) => ({
        title: b.getAttribute('title'),
        text: b.textContent.trim(),
        hasIcon: !!b.querySelector('svg'),
        inPanel: !!b.closest('.bg-blue-50'),
      }));
    `);
    check(
      'Sidebar: i due pulsanti `Spingi a SX` / `Spingi a DX` sono nel pannello del collo selezionato, con icona',
      buttons.length === 2 &&
        buttons[0].text.includes('Spingi a SX') &&
        buttons[1].text.includes('Spingi a DX') &&
        buttons.every((b) => b.hasIcon && b.inPanel),
      buttons.map((b) => `${b.text} (${b.title})`).join(' | ')
    );

    // --- ArrowRight → 137 / 193.5 (a battuta sulla parete da 250 cm) ---
    await arrow(cdp, 'ArrowRight');
    let after = await cdp.eval(`return window.__items();`);
    let byId = Object.fromEntries(after.map((i) => [i.id, i]));
    check(
      'Frecce: `ArrowRight` sposta i 2 CC a X = 137 e X = 193.5 (Δ esatto +137, battuta sulla parete da 250 cm)',
      Math.abs(byId[cc1.id].x - 137) < 0.05 &&
        Math.abs(byId[cc2.id].x - 193.5) < 0.05 &&
        Math.abs(byId[cc2.id].x + byId[cc2.id].width - 250) < 0.05,
      `CC1 ${byId[cc1.id].x} · CC2 ${byId[cc2.id].x} (bordo destro ${byId[cc2.id].x + byId[cc2.id].width} = parete 250)`
    );
    check(
      'Fisica ad arresto di contatto: nessuna collisione dopo la spinta',
      (await cdp.eval(`return window.__collisions();`)).length === 0,
      'coppie in collisione: 0'
    );
    check(
      'La spinta conserva la geometria reciproca (distanza fra i due carrelli invariata a 56,5 cm)',
      Math.abs(byId[cc2.id].x - byId[cc1.id].x - 56.5) < 0.05,
      `ΔX interno = ${(byId[cc2.id].x - byId[cc1.id].x).toFixed(2)} cm`
    );

    // --- Ctrl + Z → annullamento della spinta ---
    await ctrlKey(cdp, 'z', 90, 'KeyZ', 2);
    after = await cdp.eval(`return window.__items();`);
    byId = Object.fromEntries(after.map((i) => [i.id, i]));
    check(
      'Undo: `Ctrl + Z` annulla la spinta (i 2 CC tornano a X = 0 e X = 56.5)',
      after.length === 2 &&
        Math.abs(byId[cc1.id].x - 0) < 0.05 &&
        Math.abs(byId[cc2.id].x - 56.5) < 0.05,
      `CC1 ${byId[cc1.id].x} · CC2 ${byId[cc2.id].x} (${after.length} colli ancora presenti)`
    );

    // --- ArrowRight + ArrowLeft → andata e ritorno ---
    await arrow(cdp, 'ArrowRight');
    await arrow(cdp, 'ArrowLeft');
    after = await cdp.eval(`return window.__items();`);
    byId = Object.fromEntries(after.map((i) => [i.id, i]));
    check(
      'Frecce: `ArrowLeft` riporta i 2 CC a battuta a sinistra (X = 0 e X = 56.5)',
      Math.abs(byId[cc1.id].x - 0) < 0.05 && Math.abs(byId[cc2.id].x - 56.5) < 0.05,
      `CC1 ${byId[cc1.id].x} · CC2 ${byId[cc2.id].x}`
    );

    // --- ArrowDown + ArrowUp → andata e ritorno sulle Porte posteriori ---
    await arrow(cdp, 'ArrowDown');
    after = await cdp.eval(`return window.__items();`);
    byId = Object.fromEntries(after.map((i) => [i.id, i]));
    const downOk =
      Math.abs(byId[cc1.id].y - 1193) < 0.05 &&
      Math.abs(byId[cc2.id].y - 1193) < 0.05 &&
      Math.abs(byId[cc2.id].y + byId[cc2.id].length - 1328) < 0.05;
    await arrow(cdp, 'ArrowUp');
    after = await cdp.eval(`return window.__items();`);
    byId = Object.fromEntries(after.map((i) => [i.id, i]));
    check(
      'Frecce: `ArrowDown` → a battuta sulle Porte posteriori (Y = 1193, fondo 1328) e `ArrowUp` → ritorno alla Cabina (Y = 0)',
      downOk && Math.abs(byId[cc1.id].y) < 0.05 && Math.abs(byId[cc2.id].y) < 0.05,
      `ArrowDown: Y = 1193 (fondo 1328) = ${downOk} · ArrowUp: Y = ${byId[cc1.id].y} / ${byId[cc2.id].y}`
    );

    // --- Pulsanti della sidebar ---
    await cdp.eval(`
      document.querySelector('[title^="Spingi a battuta a destra"]').click();
      await new Promise((r) => setTimeout(r, 150));
      return 1;
    `);
    after = await cdp.eval(`return window.__items();`);
    byId = Object.fromEntries(after.map((i) => [i.id, i]));
    const rightButtonOk =
      Math.abs(byId[cc1.id].x - 137) < 0.05 && Math.abs(byId[cc2.id].x - 193.5) < 0.05;
    await cdp.eval(`
      document.querySelector('[title^="Spingi a battuta a sinistra"]').click();
      await new Promise((r) => setTimeout(r, 150));
      return 1;
    `);
    after = await cdp.eval(`return window.__items();`);
    byId = Object.fromEntries(after.map((i) => [i.id, i]));
    check(
      'Sidebar: `Spingi a DX` → 137 / 193.5 e `Spingi a SX` → 0 / 56.5 (stessa fisica delle frecce)',
      rightButtonOk && Math.abs(byId[cc1.id].x - 0) < 0.05 && Math.abs(byId[cc2.id].x - 56.5) < 0.05,
      `dopo DX: 137 / 193.5 = ${rightButtonOk} · dopo SX: ${byId[cc1.id].x} / ${byId[cc2.id].x}`
    );

    // --- Guardia dei campi di scrittura ---
    await cdp.eval(`document.getElementById('vehicle-plate-input').focus(); return 1;`);
    await arrow(cdp, 'ArrowRight');
    const inInput = await cdp.eval(`return window.__items();`);
    check(
      'Guardia: la freccia premuta dentro il campo `Targa` non muove il blocco (nessuna spinta)',
      inInput.every((i) => {
        const before = after.find((b) => b.id === i.id);
        return Math.abs(before.x - i.x) < 0.001 && Math.abs(before.y - i.y) < 0.001;
      }),
      `posizioni invariate: ${inInput.map((i) => `${i.x},${i.y}`).join(' · ')}`
    );
    await cdp.eval(`document.getElementById('vehicle-plate-input').blur(); return 1;`);

    // --- Popover delle scorciatoie ---
    const shortcut = await cdp.eval(`
      const pop = document.querySelector('.control-deck .bg-slate-900');
      if (!pop) return null;
      const rows = Array.from(pop.querySelectorAll('div.flex'));
      const row = rows.find((r) => r.textContent.includes('Spingi a battuta'));
      return {
        text: row ? row.textContent.trim() : null,
        kbd: row ? row.querySelector('kbd')?.textContent.trim() : null,
      };
    `);
    check(
      'Popover scorciatoie: voce `Spingi a battuta (pareti / ostacoli)` con i tasti `Frecce ← ↑ → ↓`',
      !!shortcut && shortcut.kbd === 'Frecce ← ↑ → ↓',
      shortcut ? `${shortcut.text} → ${shortcut.kbd}` : 'voce assente'
    );

    // Evidenza grafica del caso richiesto: 2 CC a battuta sulla parete destra.
    mkdirSync('shots', { recursive: true });
    await cdp.eval(`
      document.querySelector('[title^="Spingi a battuta a destra"]').click();
      await new Promise((r) => setTimeout(r, 250));
      return 1;
    `);
    let shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('shots/spinta-a-battuta-parete-destra.png', Buffer.from(shot.data, 'base64'));
    console.log('Evidenza grafica: shots/spinta-a-battuta-parete-destra.png');
    await ctrlKey(cdp, 'z', 90, 'KeyZ', 2);

    /* =================================================================== *
     *  3) OSTACOLO A X = 200 — ARRESTO A FILO SENZA COLLISIONE
     * =================================================================== */
    // Ostacolo 40 × 50 cm dal Formato Libero: nasce a (113, 0) e viene
    // trascinato a X = 200 con un drag reale del mouse.
    await cdp.eval(`
      const acc = document.getElementById('toggle-custom-box');
      if (acc) acc.click();
      await new Promise((r) => setTimeout(r, 120));
      const fields = document.getElementById('custom-box-fields');
      if (fields) {
        const inputs = Array.from(fields.querySelectorAll('input[type="number"]'));
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        const apply = (el, value) => {
          setter.call(el, String(value));
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        if (inputs[0]) apply(inputs[0], 40);
        if (inputs[1]) apply(inputs[1], 50);
      }
      await new Promise((r) => setTimeout(r, 120));
      const add = document.querySelector('#custom-box-fields button');
      if (add) add.click();
      await new Promise((r) => setTimeout(r, 250));
      return 1;
    `);

    let withObstacle = await cdp.eval(`return window.__items();`);
    const obstacle = withObstacle.find((i) => i.code === 'CUSTOM');
    check(
      'Ostacolo di prova: un collo fuori sagoma 40 × 50 cm è stato caricato e piazzato dal first-fit',
      !!obstacle && obstacle.width === 40 && obstacle.length === 50,
      obstacle ? `${obstacle.code}@${obstacle.x},${obstacle.y} ${obstacle.width}×${obstacle.length}` : 'assente'
    );

    const oCenter = await cdp.eval(`return window.__centerPx(${JSON.stringify(obstacle.id)});`);
    const zoom = await cdp.eval(`return window.__vp().zoom;`);
    await dragFromTo(cdp, oCenter, { x: oCenter.x + 87 * zoom, y: oCenter.y });
    withObstacle = await cdp.eval(`return window.__items();`);
    const obs = withObstacle.find((i) => i.id === obstacle.id);
    check(
      'Ostacolo trascinato a X = 200 (Y = 0), a ridosso della parete destra',
      Math.abs(obs.x - 200) < 0.6 && Math.abs(obs.y) < 0.6,
      `${obs.code}@${obs.x},${obs.y}`
    );

    // Blocco dei 2 CC riselezionato e spinto a destra contro l'ostacolo.
    const k1 = await cdp.eval(`return window.__centerPx(${JSON.stringify(cc1.id)});`);
    const k2 = await cdp.eval(`return window.__centerPx(${JSON.stringify(cc2.id)});`);
    await clickAt(cdp, k1.x, k1.y);
    await clickAt(cdp, k2.x, k2.y, 2);
    selected = await cdp.eval(`return window.__selectedIds();`);
    if (selected.length !== 2) {
      await clickAt(cdp, k1.x, k1.y);
      await clickAt(cdp, k2.x, k2.y, 4);
      selected = await cdp.eval(`return window.__selectedIds();`);
    }

    await arrow(cdp, 'ArrowRight');
    const stopped = await cdp.eval(`return window.__items();`);
    const stoppedById = Object.fromEntries(stopped.map((i) => [i.id, i]));
    const blockRightEdge = Math.max(
      stoppedById[cc1.id].x + stoppedById[cc1.id].width,
      stoppedById[cc2.id].x + stoppedById[cc2.id].width
    );
    check(
      'Ostacolo a X = 200: la spinta a destra si arresta A FILO del collo, senza collisione',
      Math.abs(blockRightEdge - stoppedById[obstacle.id].x) < 0.05 &&
        (await cdp.eval(`return window.__collisions();`)).length === 0,
      `bordo destro del blocco ${blockRightEdge.toFixed(2)} cm = ostacolo a ${stoppedById[obstacle.id].x.toFixed(2)} cm, collisioni 0`
    );
    check(
      'L\'arresto sull\'ostacolo è più corto della parete: il blocco NON è a filo della sponda destra',
      blockRightEdge < 250 - 1,
      `bordo destro ${blockRightEdge.toFixed(2)} cm contro la parete a 250 cm (Δ ${(250 - blockRightEdge).toFixed(2)} cm)`
    );

    // Ultimo passo di Undo: la spinta sull'ostacolo viene annullata.
    await ctrlKey(cdp, 'z', 90, 'KeyZ', 2);
    const undone = await cdp.eval(`return window.__items();`);
    const undoneById = Object.fromEntries(undone.map((i) => [i.id, i]));
    check(
      'Undo dell\'ultima spinta: il blocco torna a X = 0 / 56.5 e l\'ostacolo resta a X = 200',
      Math.abs(undoneById[cc1.id].x - 0) < 0.05 &&
        Math.abs(undoneById[cc2.id].x - 56.5) < 0.05 &&
        Math.abs(undoneById[obstacle.id].x - 200) < 0.6,
      `CC1 ${undoneById[cc1.id].x} · CC2 ${undoneById[cc2.id].x} · ostacolo ${undoneById[obstacle.id].x}`
    );

    /* =================================================================== *
     *  4) EVIDENZA GRAFICA FINALE E CONSOLE
     * =================================================================== */
    await cdp.eval(`
      document.querySelector('[title^="Spingi a battuta a destra"]').click();
      await new Promise((r) => setTimeout(r, 250));
      return 1;
    `);
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('shots/spinta-a-battuta-ostacolo-x200.png', Buffer.from(shot.data, 'base64'));
    console.log('Evidenza grafica: shots/spinta-a-battuta-ostacolo-x200.png');

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
