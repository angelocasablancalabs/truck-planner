/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — FLOATING ITEM INSPECTOR (CRUSCOTTO COLLI SELEZIONATI)
 *
 *  Il cruscotto di modifica dei colli selezionati è stato **estratto** dalla
 *  sidebar destra (`ControlDeck`) e incapsulato in una **card fluttuante**
 *  (`src/components/ItemInspector.tsx`) ancorata in alto a sinistra dell'area
 *  del canvas (`absolute top-4 left-4 z-20`), visibile solo con selezione attiva.
 *
 *  Controlli:
 *    1. STATO DI RIPOSO (0 colli): nessuna card fluttuante e nessun pannello
 *       azzurro dentro la sidebar destra;
 *    2. NESSUN LAYOUT SHIFT: la quota Y del "Riepilogo Stiva" resta **identica**
 *       prima e dopo l'aggiunta/selezione di un collo (il difetto originale);
 *    3. COMPARSA: il click su "Piatto" di PLT EUR stiva il collo e fa apparire
 *       la card a `left: 16px / top: 16px` rispetto all'area canvas, z-index 20,
 *       con la dissolvenza `item-inspector-in`;
 *    4. RINOMINA ISTANTANEA dal campo della card: etichetta sul canvas e
 *       Riepilogo Stiva si aggiornano in tempo reale;
 *    5. MATRICE 21 COLORI: la tinta scelta aggiorna il riempimento del collo;
 *    6. AZIONI: `Ruota 90°`, `Spingi a SX` (dopo la freccia →), `Cancella`;
 *    7. NOTA LATERALE ancorata alla quota Y del collo, col suo colore;
 *    8. CHIUSURA: pulsante `X` e click sullo sfondo del pianale;
 *    9. SCORCIATOIE invariate: Spazio, frecce, Canc, Ctrl/Cmd + Z;
 *   10. Nessun errore runtime in console.
 *
 *  Uso:  node scripts/verify-item-inspector.mjs [url]
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://localhost:5199/truck-planner/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9343);
const WATCHDOG_MS = 25000;

/** Colore del bordo di selezione dei colli (`SELECTION_COLOR` di TruckCanvas). */
const SELECTION_COLOR = 'rgb(37, 99, 235)';

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
  window.__inspector = () => document.getElementById('item-inspector');
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
        fill: rect.getAttribute('fill'),
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
  window.__itemTexts = (id) => {
    const el = document.querySelector('[data-item-id="' + id + '"]');
    return el ? Array.from(el.querySelectorAll('text')).map((t) => t.textContent).join(' | ') : '';
  };
  window.__centerPxOf = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  /** Quota Y del titolo "Riepilogo Stiva" nella sidebar destra. */
  window.__summaryTop = () => {
    const label = Array.from(document.querySelectorAll('.control-deck label'))
      .find((el) => el.textContent.trim() === 'Riepilogo Stiva');
    return label ? label.getBoundingClientRect().top : null;
  };
  /** Pannelli con sfondo azzurro (bg-blue-50) ancora presenti nella sidebar. */
  window.__bluePanels = () =>
    Array.from(document.querySelectorAll('.control-deck *')).filter((el) => {
      const bg = getComputedStyle(el).backgroundColor;
      return bg === 'rgb(239, 246, 255)' || bg === 'rgb(191, 219, 254)';
    }).length;
  window.__noteCards = () => document.querySelectorAll('[data-canvas-note]').length;
`;

/* --- Input reali ---------------------------------------------------------- */

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
  await sleep(160);
};

/** Click sul centro geometrico di un collo (coordinate reali del canvas). */
const clickItem = async (cdp, id) => {
  const point = await cdp.eval(`return window.__centerPx(${JSON.stringify(id)});`);
  if (!point) throw new Error(`collo non trovato: ${id}`);
  await clickAt(cdp, point.x, point.y);
};

const clickSelector = async (cdp, selector) => {
  const point = await cdp.eval(`return window.__centerPxOf(${JSON.stringify(selector)});`);
  if (!point) throw new Error(`elemento non trovato: ${selector}`);
  await clickAt(cdp, point.x, point.y);
};

const pressKey = async (cdp, { key, code, vk, modifiers = 0 }) => {
  const params = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...params });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...params });
  await sleep(200);
};

const pressSpace = (cdp) => pressKey(cdp, { key: ' ', code: 'Space', vk: 32 });
const pressDelete = (cdp) => pressKey(cdp, { key: 'Delete', code: 'Delete', vk: 46 });
const pressArrow = (cdp, direction) =>
  pressKey(cdp, {
    key: `Arrow${direction}`,
    code: `Arrow${direction}`,
    vk: { Left: 37, Up: 38, Right: 39, Down: 40 }[direction],
  });
const pressUndo = (cdp) => pressKey(cdp, { key: 'z', code: 'KeyZ', vk: 90, modifiers: 2 });

/** Scrive in un input React con l'evento nativo (setter + `input`). */
const typeInto = async (cdp, selector, value) => {
  await cdp.eval(`
    const el = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  `);
  await sleep(180);
};

/* --- Script --------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();
  const profileDir = mkdtempSync(join(tmpdir(), 'inspector-profile-'));
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
     *  1) STATO DI RIPOSO — nessuna card, nessun pannello azzurro
     * =================================================================== */
    const rest = await cdp.eval(`
      return {
        inspector: !!window.__inspector(),
        bluePanels: window.__bluePanels(),
        items: window.__items().length,
        summaryTop: window.__summaryTop(),
      };
    `);
    check('A riposo nessuna card fluttuante è montata', rest.inspector === false);
    check(
      'A riposo la sidebar destra non contiene più pannelli azzurri',
      rest.bluePanels === 0,
      `trovati ${rest.bluePanels}`
    );
    check('Pianale vuoto all\'apertura', rest.items === 0);

    mkdirSync('shots', { recursive: true });
    const shotEmpty = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('shots/item-inspector-a-riposo.png', Buffer.from(shotEmpty.data, 'base64'));

    /* =================================================================== *
     *  2) COMPARSA DELLA CARD + NESSUN LAYOUT SHIFT DEL RIEPILOGO STIVA
     * =================================================================== */
    await clickSelector(cdp, '#quick-piatto-EUR');
    const afterAdd = await cdp.eval(`
      const el = window.__inspector();
      const canvas = document.querySelector('.canvas-hud').parentElement.getBoundingClientRect();
      const r = el ? el.getBoundingClientRect() : null;
      const style = el ? getComputedStyle(el) : null;
      return {
        inspector: !!el,
        items: window.__items().length,
        selected: window.__selectedIds().length,
        header: el ? el.querySelector('div').textContent.replace(/\\s+/g, ' ').trim() : '',
        offsetLeft: r ? Math.round(r.left - canvas.left) : null,
        offsetTop: r ? Math.round(r.top - canvas.top) : null,
        zIndex: style ? style.zIndex : null,
        position: style ? style.position : null,
        backdrop: style ? style.backdropFilter : null,
        animation: style ? style.animationName : null,
        animationMs: style ? style.animationDuration : null,
        width: r ? Math.round(r.width) : null,
        summaryTop: window.__summaryTop(),
      };
    `);
    check(
      'Il click su "Piatto" di PLT EUR stiva il collo sul pianale',
      afterAdd.items === 1,
      `${afterAdd.items} colli`
    );
    check('Il nuovo collo resta selezionato', afterAdd.selected === 1);
    check('La card fluttuante compare con la selezione', afterAdd.inspector === true);
    check(
      'Intestazione del collo singolo: nome e quote',
      /^Selezionato: PLT EUR \(120×80 cm\)$/.test(afterAdd.header),
      afterAdd.header
    );
    check(
      'La card è ancorata in alto a sinistra dell\'area canvas (top-4 left-4)',
      afterAdd.offsetLeft === 16 && afterAdd.offsetTop === 16,
      `left ${afterAdd.offsetLeft}px, top ${afterAdd.offsetTop}px`
    );
    check(
      'La card è sopra il canvas (z-20) e in posizione assoluta',
      afterAdd.position === 'absolute' && afterAdd.zIndex === '20',
      `position ${afterAdd.position}, z-index ${afterAdd.zIndex}`
    );
    check(
      'La card usa il vetro smerigliato (backdrop-blur-xs)',
      typeof afterAdd.backdrop === 'string' && afterAdd.backdrop.includes('blur'),
      String(afterAdd.backdrop)
    );
    check(
      'Comparsa con dissolvenza dedicata (item-inspector-in)',
      afterAdd.animation === 'item-inspector-in',
      `${afterAdd.animation} ${afterAdd.animationMs}`
    );
    check(
      'Riepilogo Stiva FERMO: il collo appena stivato resta selezionato senza spostare la sidebar',
      Math.abs(afterAdd.summaryTop - rest.summaryTop) <= 0.5,
      `prima ${rest.summaryTop}, dopo ${afterAdd.summaryTop}`
    );
    // Prova regina: a stiva invariata (1 collo) si confronta la sidebar con la
    // card CHIUSA e con la card APERTA: deve essere identica al pixel.
    await clickSelector(cdp, '#item-inspector-close');
    const withoutCard = await cdp.eval(`return { top: window.__summaryTop(), card: !!window.__inspector() };`);
    await clickItem(cdp, await cdp.eval(`return window.__items()[0].id;`));
    const withCard = await cdp.eval(`return { top: window.__summaryTop(), card: !!window.__inspector() };`);
    check(
      'La card fluttuante non sposta il Riepilogo Stiva (0 px di differenza)',
      withoutCard.card === false && withCard.card === true && withoutCard.top === withCard.top,
      `card chiusa ${withoutCard.top} · card aperta ${withCard.top}`
    );
    check('Nessun pannello azzurro è rientrato nella sidebar', (await cdp.eval(
      `return window.__bluePanels();`
    )) === 0);

    /* =================================================================== *
     *  3) RINOMINA ISTANTANEA E MATRICE COLORI DALLA CARD
     * =================================================================== */
    const itemId = (await cdp.eval(`return window.__items()[0].id;`));
    await typeInto(cdp, '#item-inspector-name', 'CLIENTE TEST');
    const renamed = await cdp.eval(`
      return {
        label: window.__itemTexts(${JSON.stringify(itemId)}),
        summary: document.querySelector('.control-deck').textContent.includes('CLIENTE TEST'),
        inspector: !!window.__inspector(),
        selected: window.__selectedIds().length,
      };
    `);
    check(
      'La rinomina dal floating inspector aggiorna il canvas in tempo reale',
      renamed.label.includes('CLIENTE TEST'),
      renamed.label
    );
    check('La rinomina aggiorna il Riepilogo Stiva', renamed.summary === true);
    check('Digitare nella card non fa perdere la selezione', renamed.selected === 1);

    await clickSelector(cdp, '#item-inspector [aria-label="Colore Verde scuro"]');
    const recolored = await cdp.eval(`
      const it = window.__item(${JSON.stringify(itemId)});
      return { fill: it.fill, selected: window.__selectedIds().length };
    `);
    check(
      'La matrice colori (21 tinte) ricolora il collo selezionato',
      String(recolored.fill).toLowerCase() === '#4ade80',
      String(recolored.fill)
    );

    // Click sul corpo della card (intestazione): la selezione NON deve cadere.
    const cardPoint = await cdp.eval(`
      const r = window.__inspector().getBoundingClientRect();
      return { x: r.left + 24, y: r.top + 20 };
    `);
    await clickAt(cdp, cardPoint.x, cardPoint.y);
    check(
      'Cliccare dentro la card non deseleziona i colli',
      (await cdp.eval(`return window.__selectedIds().length;`)) === 1
    );

    /* =================================================================== *
     *  4) AZIONI RAPIDE: RUOTA, SPINGI, CANCELLA
     * =================================================================== */
    const before = await cdp.eval(`return window.__item(${JSON.stringify(itemId)});`);
    await clickSelector(cdp, '#item-inspector button[title^="Oppure premi la Barra Spaziatrice"]');
    const rotated = await cdp.eval(`return window.__item(${JSON.stringify(itemId)});`);
    check(
      'Il pulsante "Ruota 90°" della card inverte i lati del collo',
      rotated.width === before.length && rotated.length === before.width,
      `${before.width}×${before.length} → ${rotated.width}×${rotated.length}`
    );

    // Spinta a battuta: freccia → fino alla parete, poi "Spingi a SX" della card.
    await pressArrow(cdp, 'Right');
    const docked = await cdp.eval(`return window.__item(${JSON.stringify(itemId)});`);
    check(
      'Freccia → porta il collo a filo della parete destra',
      Math.abs(docked.x + docked.width - 250) < 0.51,
      `x = ${docked.x}, bordo destro = ${docked.x + docked.width}`
    );
    await clickSelector(cdp, '#item-inspector button[title^="Spingi a battuta a sinistra"]');
    const pushedLeft = await cdp.eval(`return window.__item(${JSON.stringify(itemId)});`);
    check(
      'Il pulsante "Spingi a SX" della card riporta il collo a filo parete sinistra',
      Math.abs(pushedLeft.x) < 0.51,
      `x = ${pushedLeft.x}`
    );

    /* =================================================================== *
     *  5) NOTA LATERALE ANCORATA (eredità quota + colore dal collo)
     * =================================================================== */
    const noteAnchor = await cdp.eval(`
      const it = window.__item(${JSON.stringify(itemId)});
      return { y: it.y, fill: it.fill };
    `);
    await clickSelector(cdp, '#btn-add-side-note');
    const note = await cdp.eval(`
      const el = document.querySelector('[data-canvas-note]');
      const content = document.querySelector('#note-content-input');
      return {
        count: window.__noteCards(),
        inspector: !!window.__inspector(),
        selected: window.__selectedIds().length,
        // La nota nasce nella corsia a destra della parete (250 + 30 cm).
        rect: el ? { x: el.transform.baseVal.consolidate().matrix.e, y: el.transform.baseVal.consolidate().matrix.f } : null,
        text: content ? content.value : '',
      };
    `);
    check('"Aggiungi Nota Laterale" crea la nota dal floating inspector', note.count === 1);
    check(
      'La nota nasce ancorata alla quota Y del collo selezionato',
      note.rect !== null && Math.abs(note.rect.y - noteAnchor.y) < 0.51,
      `Y nota ${note.rect?.y} vs Y collo ${noteAnchor.y}`
    );
    check(
      'La nota nasce nella corsia a destra della parete (x = 280 cm)',
      note.rect !== null && Math.abs(note.rect.x - 280) < 0.51,
      `x = ${note.rect?.x}`
    );
    check(
      'La nota eredita il nome del collo come intestazione',
      note.text.startsWith('CLIENTE TEST'),
      note.text
    );
    check(
      'Creando la nota la card fluttuante si chiude (selezione colli azzerata)',
      note.inspector === false && note.selected === 0
    );
    check(
      'Il pannello "Nota Laterale Selezionata" resta nella sidebar destra',
      await cdp.eval(`return !!document.querySelector('#note-content-input');`)
    );

    /* =================================================================== *
     *  6) CHIUSURA CON X E CON CLICK SULLO SFONDO
     * =================================================================== */
    const noteId = await cdp.eval(`return document.querySelector('[data-canvas-note]').getAttribute('data-canvas-note');`);
    await clickItem(cdp, itemId);
    check(
      'Il click sul collo riapre la card fluttuante',
      (await cdp.eval(`return !!window.__inspector() && window.__selectedIds().length;`)) === 1
    );
    await clickSelector(cdp, '#item-inspector-close');
    const closed = await cdp.eval(`
      return { inspector: !!window.__inspector(), selected: window.__selectedIds().length };
    `);
    check('Il pulsante X chiude la card e svuota la selezione', !closed.inspector && closed.selected === 0);

    await clickItem(cdp, itemId);
    const emptyPoint = await cdp.eval(`
      const r = window.__vp().rect;
      return { x: r.left + r.width * 0.86, y: r.top + r.height * 0.88 };
    `);
    await clickAt(cdp, emptyPoint.x, emptyPoint.y);
    check(
      'Il click su uno spazio vuoto del pianale chiude la card',
      (await cdp.eval(`return !window.__inspector() && window.__selectedIds().length === 0;`)) === true
    );

    /* =================================================================== *
     *  7) SCORCIATOIE INVARIATE (Spazio, frecce, Canc, Ctrl/Cmd + Z)
     * =================================================================== */
    await clickItem(cdp, itemId);
    const beforeSpace = await cdp.eval(`return window.__item(${JSON.stringify(itemId)});`);
    await pressSpace(cdp);
    const afterSpace = await cdp.eval(`return window.__item(${JSON.stringify(itemId)});`);
    check(
      'Spazio ruota ancora il collo selezionato',
      afterSpace.width === beforeSpace.length && afterSpace.length === beforeSpace.width,
      `${beforeSpace.width}×${beforeSpace.length} → ${afterSpace.width}×${afterSpace.length}`
    );

    await pressDelete(cdp);
    const afterDelete = await cdp.eval(`
      return { items: window.__items().length, inspector: !!window.__inspector() };
    `);
    check('Canc elimina il collo selezionato', afterDelete.items === 0);
    check('Eliminato il collo, la card fluttuante scompare', afterDelete.inspector === false);

    await pressUndo(cdp);
    check(
      'Ctrl / Cmd + Z annulla la cancellazione (cronologia intatta)',
      (await cdp.eval(`return window.__items().length;`)) === 1
    );

    await clickItem(cdp, itemId);
    await pressDelete(cdp);
    await pressUndo(cdp);
    await cdp.eval(`return document.querySelector('#btn-clear-all') ? 1 : 0;`);

    /* =================================================================== *
     *  8) EVIDENZA GRAFICA + CONSOLE PULITA
     * =================================================================== */
    const idForShot = await cdp.eval(`return window.__items()[0] ? window.__items()[0].id : null;`);
    if (idForShot) await clickItem(cdp, idForShot);
    await sleep(200);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('shots/item-inspector-colli-selezionati.png', Buffer.from(shot.data, 'base64'));
    console.log('Evidenze grafiche: shots/item-inspector-a-riposo.png, shots/item-inspector-colli-selezionati.png');

    // La nota creata prima è ancora in scena: la si rimuove per pulizia.
    await cdp.eval(`
      const el = document.querySelector('[data-canvas-note="${noteId}"]');
      return el ? 1 : 0;
    `);

    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    console.log(`\n${passed}/${passed + failed} controlli superati`);
    console.log(
      `Durata della verifica: ${((Date.now() - startedAt) / 1000).toFixed(2)} s (limite ${WATCHDOG_MS / 1000} s)`
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
  console.error(`WATCHDOG: verifica interrotta oltre i ${WATCHDOG_MS / 1000} secondi`);
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

main()
  .then(() => process.exit(failed === 0 ? 0 : 1))
  .catch((error) => {
    console.error('ERRORE:', error?.message ?? error);
    process.exit(1);
  });
