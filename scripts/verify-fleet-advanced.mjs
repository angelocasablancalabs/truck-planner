/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — FLOTTA AVANZATA: CLONAZIONE, RIORDINO E DUPLICAZIONE
 *
 *  Pilota Chrome reale via Chrome DevTools Protocol (zero dipendenze aggiunte) e
 *  verifica end-to-end i tre comandi dell'ecosistema multi-pianale:
 *
 *    1. **Clona Mezzo** (`#btn-clone-bay`): nasce uno stallo gemello — stessa
 *       configurazione veicolo, targa con suffisso ` (copia)`, copia profonda di
 *       tutti i colli e di tutte le note con **ID rigenerati** (nessuna collisione
 *       con gli originali) — e diventa subito il Mezzo Attivo, in UN solo
 *       `Ctrl + Z`;
 *    2. **Riordino stalli** (`#btn-reorder-bay-left` / `-right`): lo scambio con
 *       lo stallo adiacente riallinea all'istante gli offset del mondo, le
 *       intestazioni `MEZZO n` e la sequenza delle pagine A4, conservando il
 *       carico di ciascun mezzo; valido UN solo passo di Undo. Le frecce sono
 *       disabilitate agli estremi della flotta e assenti con un solo mezzo;
 *    3. **Duplica selezione** (`#btn-duplicate-selected` e `Ctrl / Cmd + D`): i
 *       colli selezionati vengono ricollocati nel **primo slot utile** verso le
 *       Porte (first-fit verificato con un oracolo indipendente), la selezione
 *       si sposta sui duplicati e l'operazione vale UN solo passo di Undo. La
 *       scorciatoia tace senza selezione e mentre si scrive in un campo.
 *
 *  Uso:  node scripts/verify-fleet-advanced.mjs [url]
 *  Chiude sempre con `browser.close()` + `process.exit(0)` entro 45 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://127.0.0.1:5199/truck-planner/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9347);
const WATCHDOG_MS = 45000;

/** Colore del bordo di selezione dei colli (`SELECTION_COLOR` di TruckCanvas). */
const SELECTION_COLOR = 'rgb(37, 99, 235)';

/** ID del campo targa della sidebar (`PLATE_INPUT_ID` di utils/plateBadge.ts). */
const PLATE_INPUT_ID = 'vehicle-plate-input';

/** Sforamento posteriore ammesso dal motore first-fit (`REAR_OVERHANG_LIMIT`). */
const REAR_OVERHANG_LIMIT = 150;

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
    this.dialogs = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Page.javascriptDialogOpening') {
        this.dialogs.push(msg.params?.message ?? '');
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
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
 * Fotografia della centrale letta dal DOM: per ogni stallo l'ordine di
 * affiancamento, la traslazione in cm, la sagoma del mezzo, l'intestazione
 * `MEZZO n`, la targa, i colli (posizione locale, misure, tinta, selezione) e le
 * note laterali. Le pagine A4 sono lette dal report di stampa.
 */
const PAGE_HELPERS = `
  window.__world = () => {
    const world = document.querySelector('[data-canvas-world="world"]');
    const m = /translate\\(([-\\d.eE+]+),\\s*([-\\d.eE+]+)\\)\\s*scale\\(([-\\d.eE+]+)\\)/.exec(
      world.getAttribute('transform') || ''
    );
    const rect = document.querySelector('svg').getBoundingClientRect();
    return { panX: Number(m[1]), panY: Number(m[2]), zoom: Number(m[3]), left: rect.left, top: rect.top };
  };
  window.__num = (value) => {
    const m = /translate\\(([-\\d.]+)(?:,\\s*([-\\d.]+))?\\)/.exec(value || '');
    return m ? { x: Number(m[1]), y: Number(m[2] ?? 0) } : { x: NaN, y: NaN };
  };
  window.__fleet = () => [...document.querySelectorAll('[data-canvas-bay]')].map((g, index) => {
    const body = g.querySelector('rect');
    const header = g.querySelector('[data-canvas-bay-header]');
    const badge = g.querySelector('[id="canvas-plate-badge"]');
    return {
      index,
      id: g.getAttribute('data-canvas-bay'),
      offset: window.__num(g.getAttribute('transform')).x,
      width: Number(body?.getAttribute('width') ?? 0),
      length: Number(body?.getAttribute('height') ?? 0),
      header: (header?.textContent || '').trim(),
      active: (header?.textContent || '').includes('ATTIVO'),
      plate: (badge?.textContent || '').trim(),
      items: [...g.querySelectorAll('[data-item-id]')].map((n) => {
        const rect = n.querySelector('rect');
        const t = window.__num(n.getAttribute('transform'));
        return {
          id: n.getAttribute('data-item-id'),
          x: t.x,
          y: t.y,
          width: Number(rect?.getAttribute('width') ?? 0),
          length: Number(rect?.getAttribute('height') ?? 0),
          fill: rect?.getAttribute('fill') ?? null,
          selected: getComputedStyle(rect).stroke === ${JSON.stringify(SELECTION_COLOR)},
        };
      }),
      notes: [...g.querySelectorAll('[data-canvas-note]')].map((n) => {
        const t = window.__num(n.getAttribute('transform'));
        return {
          id: n.getAttribute('data-canvas-note'),
          x: t.x,
          y: t.y,
          text: (n.textContent || '').trim(),
        };
      }),
    };
  });
  /** Ordine delle pagine A4 "una per mezzo" (Scheda Completa). */
  window.__printPages = () =>
    [...document.querySelectorAll('[data-print-bay-page]')].map((s) =>
      s.getAttribute('data-print-bay-page')
    );
  window.__selected = () =>
    window.__fleet()
      .flatMap((bay) => bay.items)
      .filter((item) => item.selected)
      .map((item) => item.id);
  /** Coordinate schermo del centro geometrico di un collo (cm di mondo → px). */
  window.__centerPx = (bayId, itemId) => {
    const w = window.__world();
    const bay = window.__fleet().find((b) => b.id === bayId);
    const item = bay?.items.find((i) => i.id === itemId);
    if (!item) return null;
    return {
      x: w.left + w.panX + (bay.offset + item.x + item.width / 2) * w.zoom,
      y: w.top + w.panY + (item.y + item.length / 2) * w.zoom,
    };
  };
  /** Etichetta della sezione flotta della sidebar: \`Centrale (n/3 Mezzi)\`. */
  window.__fleetLabel = () => {
    const label = [...document.querySelectorAll('.control-deck label')].find((el) =>
      el.textContent.trim().startsWith('Centrale (')
    );
    return label ? label.textContent.trim() : null;
  };
  window.__button = (id) => {
    const el = document.getElementById(id);
    return el ? { present: true, disabled: el.disabled === true, text: (el.textContent || '').trim(), title: el.getAttribute('title') } : { present: false };
  };
  /** Firma compatta di uno stallo: targa, colli (posizione/misure/tinta) e note. */
  window.__signature = (bayId) => {
    const bay = window.__fleet().find((b) => b.id === bayId);
    if (!bay) return null;
    return JSON.stringify({
      width: bay.width,
      length: bay.length,
      plate: bay.plate,
      items: bay.items.map((i) => [i.x, i.y, i.width, i.length, i.fill]),
      notes: bay.notes.map((n) => [n.x, n.y, n.text]),
    });
  };
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
  await sleep(180);
};

const clickElement = async (cdp, id, modifiers = 0) => {
  const point = await cdp.eval(`
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  if (!point) throw new Error(`elemento #${id} non trovato`);
  await clickAt(cdp, point.x, point.y, modifiers);
};

/** Click sul centro geometrico di un collo del pianale indicato. */
const clickItem = async (cdp, bayId, itemId, modifiers = 0) => {
  const point = await cdp.eval(
    `return window.__centerPx(${JSON.stringify(bayId)}, ${JSON.stringify(itemId)});`
  );
  if (!point) throw new Error(`collo non trovato: ${itemId}`);
  await clickAt(cdp, point.x, point.y, modifiers);
};

const pressKey = async (cdp, { key, code, vk, modifiers = 0 }) => {
  await cdp.eval(`
    const active = document.activeElement;
    if (active && active !== document.body && !(active instanceof HTMLInputElement)) active.blur();
    return 1;
  `);
  const params = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...params });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...params });
  await sleep(240);
};

const pressUndo = (cdp) => pressKey(cdp, { key: 'z', code: 'KeyZ', vk: 90, modifiers: 2 });
const pressCtrlD = (cdp) => pressKey(cdp, { key: 'd', code: 'KeyD', vk: 68, modifiers: 2 });

/** Scrive in un input React con l'evento nativo (setter + `input`). */
const typeInto = async (cdp, selector, value) => {
  await cdp.eval(`
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return 0;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  `);
  await sleep(200);
};

/** Aggiunge un collo al Mezzo Attivo tramite il comando rapido "Punta". */
const addItem = async (cdp, code, expectedTotal) => {
  await clickElement(cdp, `quick-punta-${code}`);
  await waitFor(
    async () =>
      cdp.eval(`return document.querySelectorAll('[data-item-id]').length === ${expectedTotal} ? 1 : 0;`),
    4000,
    `aggiunta del collo (totale atteso ${expectedTotal})`
  );
};

/* --- Oracolo del first-fit ------------------------------------------------- *
 *  Replica **indipendente** della prima passata di `findSmartSpawnPosition`
 *  (Cabina → Porte, poi parete sinistra → destra): serve a pretendere dai
 *  duplicati esattamente il primo slot utile, non un punto qualsiasi.
 * -------------------------------------------------------------------------- */

const firstFit = (width, length, vehicle, items) => {
  const yCandidates = [...new Set([0, ...items.map((i) => i.y + i.length)])].sort((a, b) => a - b);
  const xCandidates = [...new Set([0, ...items.map((i) => i.x + i.width)])].sort((a, b) => a - b);
  const collides = (x, y) =>
    items.some(
      (o) => x < o.x + o.width && o.x < x + width && y < o.y + o.length && o.y < y + length
    );

  for (const y of yCandidates) {
    for (const x of xCandidates) {
      if (x + width > vehicle.width) continue;
      if (y + length > vehicle.length + REAR_OVERHANG_LIMIT) continue;
      if (collides(x, y)) continue;
      return { x, y };
    }
  }
  return null;
};

/* --- Script --------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();
  const profileDir = mkdtempSync(join(tmpdir(), 'fleet-advanced-profile-'));
  const chrome = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1800,1100',
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
      8000,
      'Chrome DevTools endpoint'
    );

    ws = await connect(target);
    cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: DEV_URL });

    await waitFor(
      async () => cdp.eval(`return document.getElementById('quick-punta-INDU') ? 1 : 0;`),
      10000,
      'mount della sidebar'
    );
    await cdp.eval(PAGE_HELPERS + 'return 1;');
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-bay]').length === 1 ? 1 : 0;`),
      6000,
      'disegno del primo stallo'
    );

    /* =================================================================== *
     *  1) CLONAZIONE DEL MEZZO ("camion gemello")
     * =================================================================== */
    await typeInto(cdp, `#${PLATE_INPUT_ID}`, 'XA000BB');

    const rest = await cdp.eval(`
      return {
        fleet: window.__fleet().length,
        label: window.__fleetLabel(),
        clone: window.__button('btn-clone-bay'),
        add: window.__button('btn-add-bay'),
        reorderLeft: window.__button('btn-reorder-bay-left'),
        reorderRight: window.__button('btn-reorder-bay-right'),
      };
    `);
    check(
      'Con un solo mezzo compare `[ 📋 Clona ]` accanto a `+ Mezzo`',
      rest.fleet === 1 && rest.clone.present === true && rest.add.present === true,
      `flotta=${rest.fleet}, clone=${rest.clone.present}, add=${rest.add.present}`
    );
    check(
      'Le frecce di riordino restano nascoste finché la centrale ha un solo mezzo',
      rest.reorderLeft.present === false && rest.reorderRight.present === false,
      `left=${rest.reorderLeft.present}, right=${rest.reorderRight.present}`
    );

    // Stiva dell'originale: 3 colli (PLT INDU Punta 120 × 100) e 1 nota operativa.
    await addItem(cdp, 'INDU', 1);
    await addItem(cdp, 'INDU', 2);
    await addItem(cdp, 'INDU', 3);

    const source = (await cdp.eval(`return window.__fleet()[0];`)) ?? null;
    if (!source) throw new Error('stallo di partenza non trovato');

    await clickItem(cdp, source.id, source.items[0].id);
    await clickElement(cdp, 'btn-add-side-note');
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-note]').length === 1 ? 1 : 0;`),
      4000,
      'creazione della nota laterale'
    );
    await clickElement(cdp, 'item-inspector-close');

    const beforeClone = await cdp.eval(`
      const bay = window.__fleet()[0];
      return {
        signature: window.__signature(bay.id),
        items: bay.items.length,
        notes: bay.notes.length,
        ids: bay.items.map((i) => i.id),
        noteIds: bay.notes.map((n) => n.id),
        pages: window.__printPages(),
      };
    `);
    check(
      'Stallo di partenza pronto: 3 colli, 1 nota e una sola pagina A4',
      beforeClone.items === 3 && beforeClone.notes === 1 && beforeClone.pages.length === 1,
      `${beforeClone.items} colli, ${beforeClone.notes} note, ${beforeClone.pages.length} pagine`
    );

    await clickElement(cdp, 'btn-clone-bay');
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-bay]').length === 2 ? 1 : 0;`),
      4000,
      'clonazione dello stallo'
    );

    const cloneState = await cdp.eval(`
      const fleet = window.__fleet();
      return {
        label: window.__fleetLabel(),
        pages: window.__printPages(),
        source: fleet[0],
        clone: fleet[1],
      };
    `);
    const cloneBay = cloneState.clone;
    const cloneIds = cloneBay.items.map((i) => i.id);
    const cloneNoteIds = cloneBay.notes.map((n) => n.id);

    check(
      'Il click su `[ 📋 Clona ]` aggiunge un secondo mezzo e lo rende il Mezzo Attivo',
      cloneState.label === 'Centrale (2/3 Mezzi)' &&
        cloneState.clone.active === true &&
        cloneState.source.active === false,
      `${cloneState.label} · attivo=${cloneBay.id}`
    );
    check(
      'Configurazione veicolo identica all\'originale',
      cloneBay.width === cloneState.source.width &&
        cloneBay.length === cloneState.source.length,
      `${cloneBay.width}×${cloneBay.length} contro ${cloneState.source.width}×${cloneState.source.length}`
    );
    check(
      'Targa contrassegnata con il suffisso ` (copia)`',
      /\(copia\)$/i.test(cloneBay.plate) && cloneBay.plate.startsWith('XA000BB'),
      `targa="${cloneBay.plate}"`
    );
    const geometryOf = (bay) =>
      JSON.stringify(bay.items.map((i) => [i.x, i.y, i.width, i.length, i.fill]));
    check(
      'I 3 colli sono clonati identici per posizione, misure e tinta',
      geometryOf(cloneBay) === geometryOf(cloneState.source),
      cloneBay.items.map((i) => `(${i.x},${i.y})`).join(' ')
    );
    check(
      'Gli ID dei colli clonati sono tutti nuovi: nessuna collisione con gli originali',
      cloneIds.length === 3 &&
        new Set(cloneIds).size === 3 &&
        cloneIds.every((id) => !beforeClone.ids.includes(id)),
      cloneIds.join(' | ')
    );
    check(
      'La nota operativa è clonata identica (testo e quota) con un ID nuovo',
      cloneBay.notes.length === 1 &&
        cloneBay.notes[0].text === cloneState.source.notes[0].text &&
        cloneBay.notes[0].x === cloneState.source.notes[0].x &&
        cloneBay.notes[0].y === cloneState.source.notes[0].y &&
        !beforeClone.noteIds.includes(cloneNoteIds[0]),
      `nota=${cloneNoteIds[0]} (originale ${beforeClone.noteIds[0]})`
    );
    check(
      'Lo stallo di partenza non è stato toccato dalla clonazione',
      (await cdp.eval(`return window.__signature(${JSON.stringify(cloneState.source.id)});`)) ===
        beforeClone.signature,
      'confronto profondo della firma'
    );
    check(
      'La scheda A4 elenca una pagina per mezzo, nell\'ordine della flotta',
      cloneState.pages.length === 2 &&
        cloneState.pages[0] === cloneState.source.id &&
        cloneState.pages[1] === cloneBay.id,
      JSON.stringify(cloneState.pages)
    );

    await pressUndo(cdp);
    const afterCloneUndo = await cdp.eval(`
      const fleet = window.__fleet();
      return {
        fleet: fleet.length,
        items: fleet[0].items.map((i) => i.id),
        notes: fleet[0].notes.map((n) => n.id),
        pages: window.__printPages(),
        label: window.__fleetLabel(),
      };
    `);
    check(
      'UN solo `Ctrl + Z` annulla la clonazione: la flotta torna a un mezzo con il suo carico',
      afterCloneUndo.fleet === 1 &&
        afterCloneUndo.label === 'Centrale (1/3 Mezzi)' &&
        JSON.stringify(afterCloneUndo.items) === JSON.stringify(beforeClone.ids) &&
        JSON.stringify(afterCloneUndo.notes) === JSON.stringify(beforeClone.noteIds) &&
        afterCloneUndo.pages.length === 1,
      `${afterCloneUndo.fleet} mezzo, ${afterCloneUndo.items.length} colli, ${afterCloneUndo.pages.length} pagine`
    );

    /* =================================================================== *
     *  2) RIORDINO DEGLI STALLI (frecce ◀ ▶)
     * =================================================================== */
    mkdirSync('shots', { recursive: true });

    // Flotta piena: due clonazioni portano la centrale a 3 mezzi (3 colli ciascuno).
    await clickElement(cdp, 'btn-clone-bay');
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-bay]').length === 2 ? 1 : 0;`),
      4000,
      'secondo mezzo'
    );
    await clickElement(cdp, 'btn-clone-bay');
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-bay]').length === 3 ? 1 : 0;`),
      4000,
      'terzo mezzo'
    );

    const full = await cdp.eval(`
      const fleet = window.__fleet();
      return {
        label: window.__fleetLabel(),
        ids: fleet.map((b) => b.id),
        offsets: fleet.map((b) => b.offset),
        headers: fleet.map((b) => b.header),
        counts: fleet.map((b) => b.items.length),
        pages: window.__printPages(),
        clone: window.__button('btn-clone-bay'),
        signatures: Object.fromEntries(fleet.map((b) => [b.id, window.__signature(b.id)])),
      };
    `);
    check(
      'Centrale al completo (3/3): `Clona` e `+ Mezzo` spariscono, i tre stalli si affiancano a 430 cm',
      full.label === 'Centrale (3/3 Mezzi)' &&
        full.clone.present === false &&
        JSON.stringify(full.offsets) === JSON.stringify([0, 680, 1360]),
      `${full.label} · offsets=${full.offsets.join('/')}`
    );
    check(
      'Intestazioni canvas e pagine A4 seguono l\'ordine della flotta',
      JSON.stringify(full.headers.map((h) => h.replace('ATTIVO', ''))) ===
        JSON.stringify(['MEZZO 1', 'MEZZO 2', 'MEZZO 3']) &&
        JSON.stringify(full.pages) === JSON.stringify(full.ids),
      `header=${full.headers.join(' | ')}`
    );

    const [bayA, bayB, bayC] = full.ids;

    await clickElement(cdp, `bay-pill-${bayB}`);
    const middleButtons = await cdp.eval(`
      return {
        left: window.__button('btn-reorder-bay-left'),
        right: window.__button('btn-reorder-bay-right'),
        active: window.__fleet().find((b) => b.active)?.id ?? null,
      };
    `);
    check(
      'Con il mezzo centrale attivo entrambe le frecce sono abilitate',
      middleButtons.active === bayB &&
        middleButtons.left.present === true &&
        middleButtons.left.disabled === false &&
        middleButtons.right.disabled === false,
      `left=${middleButtons.left.disabled}, right=${middleButtons.right.disabled}`
    );

    // Evidenza: tre mezzi affiancati con il gemello ` (copia)` e le frecce ◀ ▶.
    const shotReorder = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(
      'shots/flotta-avanzata-riordino-mezzi.png',
      Buffer.from(shotReorder.data, 'base64')
    );

    await clickElement(cdp, 'btn-reorder-bay-left');
    await sleep(260);
    const swapped = await cdp.eval(`
      const fleet = window.__fleet();
      return {
        ids: fleet.map((b) => b.id),
        offsets: fleet.map((b) => b.offset),
        headers: fleet.map((b) => b.header),
        counts: fleet.map((b) => b.items.length),
        active: fleet.find((b) => b.active)?.id ?? null,
        pages: window.__printPages(),
        signatures: Object.fromEntries(fleet.map((b) => [b.id, window.__signature(b.id)])),
      };
    `);
    check(
      '`[ ◀ ]` scambia lo stallo attivo con il precedente: l\'ordine diventa MEZZO 2 · MEZZO 1 · MEZZO 3',
      JSON.stringify(swapped.ids) === JSON.stringify([bayB, bayA, bayC]) &&
        JSON.stringify(swapped.headers.map((h) => h.replace('ATTIVO', ''))) ===
          JSON.stringify(['MEZZO 1', 'MEZZO 2', 'MEZZO 3']),
      `ordine=${swapped.ids.join(' | ')}`
    );
    check(
      'Gli offset del mondo si riallineano all\'istante (0 / 680 / 1360 cm)',
      JSON.stringify(swapped.offsets) === JSON.stringify([0, 680, 1360]),
      swapped.offsets.join('/')
    );
    check(
      'Il carico resta agganciato al proprio mezzo (3 colli per stallo, invariati)',
      JSON.stringify(swapped.counts) === JSON.stringify(full.counts) &&
        full.ids.every((id) => swapped.signatures[id] === full.signatures[id]),
      `colli=${swapped.counts.join('/')}`
    );
    check(
      'La sequenza delle pagine A4 rispecchia il nuovo ordine',
      JSON.stringify(swapped.pages) === JSON.stringify([bayB, bayA, bayC]),
      JSON.stringify(swapped.pages)
    );
    check(
      'Il riordino non cambia il Mezzo Attivo (resta lo stallo spostato)',
      swapped.active === bayB,
      `attivo=${swapped.active}`
    );

    const edges = await cdp.eval(`
      return {
        left: window.__button('btn-reorder-bay-left').disabled,
        right: window.__button('btn-reorder-bay-right').disabled,
      };
    `);
    check(
      'Sul primo posto la freccia `◀` è disabilitata (`▶` resta attiva)',
      edges.left === true && edges.right === false,
      `left=${edges.left}, right=${edges.right}`
    );

    await clickElement(cdp, `bay-pill-${bayC}`);
    const lastEdges = await cdp.eval(`
      return {
        left: window.__button('btn-reorder-bay-left').disabled,
        right: window.__button('btn-reorder-bay-right').disabled,
      };
    `);    check(
      'Sull\'ultimo posto è la freccia `▶` a essere disabilitata (`◀` resta attiva)',
      lastEdges.right === true && lastEdges.left === false,
      `left=${lastEdges.left}, right=${lastEdges.right}`
    );

    await pressUndo(cdp);
    const restoredOrder = await cdp.eval(`
      const fleet = window.__fleet();
      return {
        ids: fleet.map((b) => b.id),
        offsets: fleet.map((b) => b.offset),
        headers: fleet.map((b) => b.header.replace('ATTIVO', '')),
        counts: fleet.map((b) => b.items.length),
        pages: window.__printPages(),
      };
    `);
    check(
      'UN solo `Ctrl + Z` riporta la flotta all\'ordine di partenza (offset e quote comprese)',
      JSON.stringify(restoredOrder.ids) === JSON.stringify(full.ids) &&
        JSON.stringify(restoredOrder.offsets) === JSON.stringify([0, 680, 1360]) &&
        JSON.stringify(restoredOrder.headers) === JSON.stringify(['MEZZO 1', 'MEZZO 2', 'MEZZO 3']) &&
        JSON.stringify(restoredOrder.counts) === JSON.stringify(full.counts) &&
        JSON.stringify(restoredOrder.pages) === JSON.stringify(full.ids),
      `ordine=${restoredOrder.ids.join(' | ')} · offsets=${restoredOrder.offsets.join('/')}`
    );

    /* =================================================================== *
     *  3) DUPLICAZIONE DELLA SELEZIONE (Inspector + `Ctrl / Cmd + D`)
     * =================================================================== */
    // Piano pulito: un solo mezzo vuoto, così lo spawn first-fit è deterministico.
    await clickElement(cdp, 'btn-new-project');
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-item-id]').length === 0 ? 1 : 0;`),
      4000,
      'nuovo piano vuoto'
    );

    await addItem(cdp, 'INDU', 1);
    await addItem(cdp, 'INDU', 2);

    const base = await cdp.eval(`return window.__fleet()[0];`);
    const [item1, item2] = base.items;
    await clickItem(cdp, base.id, item1.id);
    await clickItem(cdp, base.id, item2.id, 2); // Ctrl + click → selezione multipla

    const inspector = await cdp.eval(`
      const card = document.getElementById('item-inspector');
      if (!card) return null;
      const row = document.getElementById('btn-duplicate-selected')?.parentElement;
      return {
        selected: window.__selected().length,
        buttons: row ? [...row.querySelectorAll('button')].map((b) => (b.textContent || '').trim()) : [],
        duplicate: window.__button('btn-duplicate-selected'),
      };
    `);
    check(
      'Nella card dei colli selezionati i pulsanti azione diventano tre: Ruota · Duplica · Cancella',
      inspector !== null &&
        inspector.selected === 2 &&
        JSON.stringify(inspector.buttons) ===
          JSON.stringify(['Ruota 90°', 'Duplica', 'Cancella (2)']),
      JSON.stringify(inspector?.buttons)
    );
    check(
      '`[ 📋 Duplica ]` è il pulsante `#btn-duplicate-selected` della riga azioni',
      inspector?.duplicate.present === true &&
        inspector.duplicate.title.includes('Ctrl / Cmd + D'),
      inspector?.duplicate.title
    );

    // Evidenza: card fluttuante con i tre pulsanti azione e 2 colli selezionati.
    const shotDuplicate = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(
      'shots/flotta-avanzata-duplica-selezione.png',
      Buffer.from(shotDuplicate.data, 'base64')
    );

    const beforeDuplicate = base.items.map((i) => ({ ...i }));
    await clickElement(cdp, 'btn-duplicate-selected');
    await sleep(260);

    const afterDuplicate = await cdp.eval(`
      const bay = window.__fleet()[0];
      return { bay, selected: window.__selected() };
    `);
    const dupItems = afterDuplicate.bay.items;
    const originalIds = beforeDuplicate.map((i) => i.id);
    const newItems = dupItems.filter((i) => !originalIds.includes(i.id));

    // Oracolo first-fit: ogni duplicato deve occupare il PRIMO slot utile
    // (Cabina → Porte), calcolato sulla stiva che lo precede.
    const expected = [];
    {
      let working = beforeDuplicate.map((i) => ({ ...i }));
      for (const source of beforeDuplicate) {
        const slot = firstFit(source.width, source.length, afterDuplicate.bay, working);
        expected.push(slot);
        working = [...working, { x: slot.x, y: slot.y, width: source.width, length: source.length }];
      }
    }

    check(
      '`[ 📋 Duplica ]` stiva 2 nuovi colli (4 in totale) senza toccare gli originali',
      dupItems.length === 4 &&
        newItems.length === 2 &&
        originalIds.every((id) => dupItems.some((i) => i.id === id)),
      `${dupItems.length} colli, ${newItems.length} nuovi`
    );
    check(
      'I duplicati occupano il primo slot utile verso le Porte (first-fit verificato a parte)',
      newItems.length === 2 &&
        newItems.every(
          (item, index) => item.x === expected[index].x && item.y === expected[index].y
        ),
      `atteso ${expected.map((e) => `(${e.x},${e.y})`).join(' ')} · ottenuto ${newItems
        .map((i) => `(${i.x},${i.y})`)
        .join(' ')}`
    );
    check(
      'Nessuna sovrapposizione e dentro le pareti: i duplicati rispettano la sagoma del mezzo',
      newItems.every(
        (item) =>
          item.x >= 0 &&
          item.x + item.width <= afterDuplicate.bay.width + 0.001 &&
          !dupItems.some(
            (other) =>
              other.id !== item.id &&
              item.x < other.x + other.width &&
              other.x < item.x + item.width &&
              item.y < other.y + other.length &&
              other.y < item.y + item.length
          )
      ),
      newItems.map((i) => `(${i.x},${i.y},${i.width}×${i.length})`).join(' ')
    );
    check(
      'Gli ID dei duplicati sono nuovi e la selezione si sposta su di essi',
      new Set(dupItems.map((i) => i.id)).size === 4 &&
        JSON.stringify(afterDuplicate.selected) === JSON.stringify(newItems.map((i) => i.id)),
      `selezione=${afterDuplicate.selected.length} colli`
    );

    await pressUndo(cdp);
    const afterDupUndo = await cdp.eval(`
      const bay = window.__fleet()[0];
      return { count: bay.items.length, ids: bay.items.map((i) => i.id) };
    `);
    check(
      'UN solo `Ctrl + Z` annulla l\'intera duplicazione (tornano i 2 colli originali)',
      afterDupUndo.count === 2 && JSON.stringify(afterDupUndo.ids) === JSON.stringify(originalIds),
      `${afterDupUndo.count} colli`
    );

    /* --- Scorciatoia `Ctrl / Cmd + D` ----------------------------------- */
    await clickItem(cdp, base.id, item1.id);
    const beforeShortcut = await cdp.eval(
      `return window.__fleet()[0].items.map((i) => i.id);`
    );
    await pressCtrlD(cdp);
    await sleep(200);
    const afterShortcut = await cdp.eval(`
      const bay = window.__fleet()[0];
      return { items: bay.items, selected: window.__selected() };
    `);
    const shortcutNew = afterShortcut.items.filter((i) => !beforeShortcut.includes(i.id));
    const shortcutExpected = firstFit(
      item1.width,
      item1.length,
      base,
      beforeDuplicate.map((i) => ({ ...i }))
    );
    check(
      '`Ctrl + D` duplica il collo selezionato nel primo slot utile e lo seleziona',
      afterShortcut.items.length === 3 &&
        shortcutNew.length === 1 &&
        shortcutNew[0].x === shortcutExpected.x &&
        shortcutNew[0].y === shortcutExpected.y &&
        JSON.stringify(afterShortcut.selected) === JSON.stringify([shortcutNew[0].id]),
      `nuovo=(${shortcutNew[0]?.x},${shortcutNew[0]?.y}), atteso=(${shortcutExpected.x},${shortcutExpected.y})`
    );

    await pressUndo(cdp);
    // La selezione seguiva il collo duplicato, quindi l'Undo l'ha già svuotata:
    // la card può essere già smontata, il click di chiusura è solo di sicurezza.
    await cdp.eval(`
      document.getElementById('item-inspector-close')?.click();
      return 1;
    `);
    await sleep(180);
    const beforeSilent = await cdp.eval(`return window.__fleet()[0].items.length;`);
    await pressCtrlD(cdp);
    await sleep(200);
    const afterSilent = await cdp.eval(`return window.__fleet()[0].items.length;`);
    check(
      'Senza selezione la scorciatoia tace: nessun collo viene creato',
      beforeSilent === 2 && afterSilent === 2,
      `${beforeSilent} → ${afterSilent} colli`
    );

    await clickItem(cdp, base.id, item1.id);
    await cdp.eval(`
      const input = document.getElementById('item-inspector-name');
      input.focus();
      return document.activeElement === input ? 1 : 0;
    `);
    const beforeTyping = await cdp.eval(`return window.__fleet()[0].items.length;`);
    await pressCtrlD(cdp);
    await sleep(200);
    const afterTyping = await cdp.eval(`
      return { count: window.__fleet()[0].items.length, selected: window.__selected().length };
    `);
    check(
      'Mentre si scrive in un campo la scorciatoia è inerte (nessun collo duplicato)',
      beforeTyping === 2 && afterTyping.count === 2 && afterTyping.selected === 1,
      `${beforeTyping} → ${afterTyping.count} colli, ${afterTyping.selected} selezionati`
    );

    /* --- 4) Nessun errore runtime --------------------------------------- */
    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    console.log(`\n${passed}/${passed + failed} controlli superati`);
    console.log(
      `Durata della verifica: ${((Date.now() - startedAt) / 1000).toFixed(2)} s (limite ${WATCHDOG_MS / 1000} s)`
    );
    console.log('Evidenze grafiche: shots/flotta-avanzata-riordino-mezzi.png, shots/flotta-avanzata-duplica-selezione.png');
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
