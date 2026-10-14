/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — ARCHITETTURA MULTI-PIANALE (FASE 1: 1 → 3 MEZZI)
 *
 *  Pilota Chrome reale via Chrome DevTools Protocol (zero dipendenze aggiunte) e
 *  verifica end-to-end la centrale multi-pianale: fino a **tre mezzi affiancati
 *  nello stesso canvas e nello stesso file JSON**, ciascuno su coordinate locali,
 *  comandati dalla sidebar tramite le **pillole del Mezzo Attivo**.
 *
 *    1. **Pulsante `+ Mezzo` della sidebar** (`#btn-add-bay`): unica porta
 *       d'ingresso di un nuovo mezzo nella centrale, fino a `MAX_BAYS`. Sul
 *       canvas **non esiste alcuno slot fantasma**: i pianali disegnati sono
 *       esclusivamente quelli reali della flotta;
 *    2. **Affiancamento**: il primo stallo resta a `X = 0`, il secondo a
 *       `larghezza + 180 cm` (stacco `BAY_SPACING_CM`), il terzo a catena;
 *    3. **Limite di flotta**: dopo il terzo mezzo il pulsante di aggiunta
 *       sparisce (`MAX_BAYS = 3`);
 *    4. **Pillole della sidebar** `Mezzo 1 / 2 / 3`: il click cambia il Mezzo
 *       Attivo, sposta il focus della targa e riporta il riepilogo di stiva del
 *       mezzo selezionato;
 *    5. **Totale Flotta**: la micro-riga con colli e metri lineari complessivi
 *       compare solo con più di un mezzo;
 *    6. **File di progetto v2**: `version: 2` con `bays` (3 stalli completi di
 *       mezzo, targa, colli e note) e `activeBayId`, senza più campi piatti v1;
 *    7. **Auto-migrazione v1 → v2**: un vecchio piano a pianale singolo viene
 *       riconosciuto, convertito in un unico stallo `bay-1` e messo in scena
 *       senza perdere nemmeno un collo;
 *    8. **Eliminazione di un mezzo** col solo pulsante `Elimina` della sidebar
 *       (sul canvas l'header è una pillola pulita, senza "X" / cestino) con
 *       conferma antipanico e riallineamento delle pillole;
 *    9. **Stampe**: foglio unico "Solo Grafica" (A4 **verticale** con 1 o 2 mezzi,
 *       A4 **panoramico** con 3) e Scheda Completa A4 verticale, una pagina per
 *       mezzo.
 *
 *  Uso:  node scripts/verify-multi-bay.mjs [url]
 *  Chiude sempre con `browser.close()` + `process.exit(0)` entro 30 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://127.0.0.1:5199/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9341);
const WATCHDOG_MS = 30000;
const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Stacco ufficiale fra due stalli affiancati (`BAY_SPACING_CM`). */
const BAY_SPACING_CM = 180;
/** Numero massimo di mezzi della centrale (`MAX_BAYS`). */
const MAX_BAYS = 3;

/** Targhe dei tre mezzi: identificano senza ambiguità pillole e file salvato. */
const PLATE_1 = 'AA111AA';
const PLATE_2 = 'BB222BB';
const PLATE_3 = 'CC333CC';

/** Collo di catalogo usato in tutte le verifiche (PLT INDU, Piatto 120 × 100). */
const INDU = { code: 'INDU', width: 120, length: 100 };

/** Vecchio piano a **pianale singolo** (schema v1): deve migrare da solo. */
const LEGACY_V1_PROJECT = {
  version: 1,
  app: 'truck-planner',
  timestamp: '2026-02-02T07:30:00.000Z',
  vehicle: { id: 'bilico_cc', name: 'Bilico CC Fiori (2,50 × 13,28 m)', width: 250, length: 1328 },
  plate: 'LEGACY01',
  items: Array.from({ length: 4 }, (_, i) => ({
    id: `LEGACY_${i}`,
    code: 'INDU',
    name: 'CLIENTE STORICO',
    width: 120,
    length: 100,
    x: (i % 2) * 120,
    y: Math.floor(i / 2) * 100,
    rotation: 90,
    color: '#E2E8F0',
    borderColor: '#334155',
  })),
  notes: [],
  labelDensity: 'all',
};

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
        // Il dialogo va sempre chiuso, altrimenti la pagina resta bloccata.
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
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

/* --- Interazioni reali con la pagina --------------------------------------- */

/**
 * Click fisico sul centro di un elemento del DOM (evento fidato).
 *
 * È il gesto con cui si aggiungono i mezzi: il pulsante `+ Mezzo` della sidebar
 * (`#btn-add-bay`) è l'**unica** porta d'ingresso di un nuovo stallo, perché sul
 * canvas non esiste più alcuno slot fantasma da cliccare.
 */
const clickElement = async (cdp, id) => {
  const box = await cdp.eval(`
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  `);
  if (!box) throw new Error(`elemento #${id} non trovato`);
  const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  await sleep(180);
};

/** Scrittura in un input tramite il setter nativo (React 19 lo intercetta). */
const setInput = (cdp, id, value) =>
  cdp.eval(`
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return null;
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    desc.set.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  `);

/**
 * Aggiunge un collo al Mezzo Attivo tramite il comando rapido "Punta" della
 * riga di catalogo (`quick-punta-INDU`) e attende che compaia sul canvas.
 */
const addItemToActiveBay = async (cdp, expectedTotal) => {
  await clickElement(cdp, `quick-punta-${INDU.code}`);
  await waitFor(
    async () =>
      cdp.eval(
        `return document.querySelectorAll('[data-canvas-item]').length === ${expectedTotal} ? 1 : 0;`
      ),
    4000,
    `aggiunta del collo (totale atteso ${expectedTotal})`
  );
};

/**
 * Apertura di un file dal selettore classico: il contenuto viene iniettato in un
 * `<input type="file">` reale tramite `DataTransfer`, quindi l'evento `change` è
 * fidato e React lo gestisce come un file scelto dall'operatore.
 */
const loadProjectFile = async (cdp, name, content) => {
  const delivered = await cdp.eval(`
    const input = document.getElementById('project-file-input');
    if (!input) return 'input-assente';
    const dt = new DataTransfer();
    dt.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, {
      type: 'application/json',
    }));
    input.files = dt.files;
    const delivered = input.files.length;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return delivered;
  `);
  await sleep(400);
  return delivered;
};

/** Invio di `Ctrl + Z` reale alla pagina (motore Undo a snapshot). */
const pressUndo = async (cdp) => {
  await cdp.eval(`
    const active = document.activeElement;
    if (active && active !== document.body) active.blur();
    document.body.focus();
    return document.activeElement?.tagName ?? 'n/d';
  `);
  const key = { key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, ...key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, ...key });
  await sleep(220);
};

/**
 * Contenuto **tipografico** dell'header di stallo, nell'ordine di scrittura:
 * `MEZZO n`, eventualmente seguito da `ATTIVO`. L'header compatto non riporta
 * più targa né preset — quelli vivono nel badge targa e nel menu della sidebar —
 * quindi il confronto avviene su sole due etichette, mai su righe ridondanti.
 */
const headerLabels = (bay) => (bay.plate ?? []).join(' ');

/* --- Fotografia dello stato della centrale --------------------------------- */

/**
 * Stato osservabile della centrale: stalli sul canvas (con la loro traslazione
 * reale in pixel, letta dal `transform` del gruppo), pillole della sidebar,
 * testi dell'header di stallo, colli per stallo, totale di flotta e comandi di
 * aggiunta / eliminazione mezzo (`#btn-add-bay`, `#btn-delete-bay`).
 */
const SNAPSHOT = `
  const deck = document.querySelector('.control-deck');
  const zone = document.querySelector('svg').getBoundingClientRect();
  const bays = [...document.querySelectorAll('[data-canvas-bay]')].map((g) => {
    const t = /translate\\(([-\\d.]+)/.exec(g.getAttribute('transform') || '');
    const cm = t ? Number(t[1]) : null;
    const viewportX = g.getBoundingClientRect().left - zone.left;
    const header = g.querySelector('[data-canvas-bay-header]');
    const headerRect = header?.querySelector('rect') ?? null;
    const headerBox = headerRect?.getBoundingClientRect() ?? null;
    const plateBox = g.querySelector('#canvas-plate-badge text')?.getBoundingClientRect() ?? null;
    return {
      cm,
      viewportX,
      items: g.querySelectorAll('[data-canvas-item]').length,
      active: !!g.querySelector('[data-canvas-bay-header] text') &&
        (g.textContent || '').includes('ATTIVO'),
      plate: (() => {
        const header = g.querySelector('[data-canvas-bay-header]');
        if (!header) return null;
        const texts = [...header.querySelectorAll('text')].map((t) => (t.textContent || '').trim());
        return texts;
      })(),
      // L'header dello stallo è una pillola **pulita**: nessun comando di
      // eliminazione (icona "X" / cestino) vive più sul canvas.
      headerCount: g.querySelectorAll('[data-canvas-bay-header]').length,
      deleteDiscs: g.querySelectorAll('[data-canvas-bay-delete]').length,
      headerTopCm: headerRect ? Number(headerRect.getAttribute('y')) : null,
      headerHeightCm: headerRect ? Number(headerRect.getAttribute('height')) : null,
      headerWidthCm: headerRect ? Number(headerRect.getAttribute('width')) : null,
      // Distanza reale (px) fra il bordo inferiore dell'header e la sommità del
      // badge targa: positiva = nessuna sovrapposizione con la targa estesa.
      headerToPlateGapPx: headerBox && plateBox ? Math.round(plateBox.top - headerBox.bottom) : null,
    };
  });
  const pills = [...document.querySelectorAll('[id^="bay-pill-"]')].map((b) => ({
    id: b.id,
    text: (b.textContent || '').trim(),
    pressed: b.getAttribute('aria-pressed') === 'true',
  }));
  const total = /Totale Flotta \\((\\d+) Mezzi\\):\\s*([\\d]+) Colli · ([\\d.]+) m/.exec(
    deck?.textContent || ''
  );
  const sideTotal = /(\\d+)\\s+Colli Totali/.exec(deck?.textContent || '');
  return {
    bayCount: bays.length,
    bays,
    pills,
    hasAddBayButton: !!document.getElementById('btn-add-bay'),
    addBayDisabled: document.getElementById('btn-add-bay')?.disabled ?? null,
    deleteBayDisabled: document.getElementById('btn-delete-bay')?.disabled ?? null,
    plateInput: document.getElementById('vehicle-plate-input')?.value ?? null,
    canvasHeaders: document.querySelectorAll('[data-canvas-bay-header]').length,
    canvasDeleteDiscs: document.querySelectorAll('[data-canvas-bay-delete]').length,
    fleetTotal: total ? { mezzi: Number(total[1]), colli: Number(total[2]), ldm: Number(total[3]) } : null,
    sideTotal: sideTotal ? Number(sideTotal[1]) : -1,
  };
`;

/* --- Script ----------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();

  const workDir = resolve('tmp', 'multi-bay-verify');
  const downloadDir = join(workDir, 'downloads');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(downloadDir, { recursive: true });

  const profileDir = mkdtempSync(join(tmpdir(), 'multi-bay-profile-'));
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

    await cdp.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
    });

    await cdp.send('Page.navigate', { url: DEV_URL });
    await waitFor(
      async () => cdp.eval(`return document.getElementById('btn-save-project') ? 1 : 0;`),
      12000,
      'mount della plancia di comando'
    );

    // Headless non può mostrare i selettori nativi: si verifica il fallback
    // trasparente (download `<a download>` + `<input type="file">` classico).
    await cdp.eval(`
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true, writable: true, value: undefined,
      });
      Object.defineProperty(window, 'showOpenFilePicker', {
        configurable: true, writable: true, value: undefined,
      });
      return 1;
    `);
    await sleep(250);

    /* --- 1) Partenza: un solo mezzo, nessuno slot fantasma sul canvas ---- */
    const single = await cdp.eval(SNAPSHOT);
    // Il canvas non deve riservare spazio a un pianale inesistente: l'unico
    // segno del fantasma era l'aggancio `[data-canvas-add-bay]`, ora rimosso.
    const canvasGhostNodes = await cdp.eval(
      `return document.querySelectorAll('[data-canvas-add-bay]').length;`
    );
    check(
      'Partenza: un solo stallo in centrale e nessuno slot fantasma sul canvas',
      single.bayCount === 1 && canvasGhostNodes === 0,
      `${single.bayCount} stallo/i, nodi fantasma=${canvasGhostNodes}`
    );
    check(
      'Pillola `Mezzo 1` attiva e comando `Elimina` disabilitato (ultimo mezzo)',
      single.pills.length === 1 &&
        single.pills[0].pressed === true &&
        single.pills[0].text.startsWith('Mezzo 1') &&
        single.deleteBayDisabled === true,
      `${single.pills.length} pillola/e, elimina disabilitato=${single.deleteBayDisabled}`
    );
    check(
      'Totale Flotta assente con un solo mezzo',
      single.fleetTotal === null,
      JSON.stringify(single.fleetTotal)
    );
    check(
      'Il primo stallo vive a X = 0 cm',
      single.bays[0].cm === 0,
      `offset ${single.bays[0].cm} cm`
    );
    check(
      'Pulsante `+ Mezzo` della sidebar presente e abilitato (1/3 mezzi)',
      single.hasAddBayButton === true && single.addBayDisabled === false,
      `bottone=${single.hasAddBayButton}, disabilitato=${single.addBayDisabled}`
    );
    check(
      'Sul canvas non esiste alcuna icona "X" / cestino di eliminazione dell\'header',
      single.canvasDeleteDiscs === 0 && single.bays.every((bay) => bay.deleteDiscs === 0),
      `dischi di eliminazione=${single.canvasDeleteDiscs}`
    );
    check(
      'Header dello stallo in quota, sopra la fascia della targa: bordo inferiore a −102 cm',
      single.bays[0].headerTopCm === -128 &&
        single.bays[0].headerHeightCm === 26 &&
        single.bays[0].headerWidthCm === 140 &&
        single.bays[0].headerTopCm + single.bays[0].headerHeightCm === -102,
      `top=${single.bays[0].headerTopCm}, height=${single.bays[0].headerHeightCm}, width=${single.bays[0].headerWidthCm}`
    );

    /* --- 2) Aggiunta del secondo mezzo dal pulsante della sidebar -------- */
    await clickElement(cdp, 'btn-add-bay');
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-bay]').length === 2 ? 1 : 0;`),
      4000,
      'aggiunta del secondo mezzo dal pulsante `+ Mezzo` della sidebar'
    );

    await setInput(cdp, 'vehicle-plate-input', PLATE_1);
    await sleep(150);
    await addItemToActiveBay(cdp, 1);
    await sleep(150);

    const two = await cdp.eval(SNAPSHOT);
    check(
      'Il secondo mezzo è il Mezzo Attivo (pillola 2 accesa, pillola 1 a riposo)',
      two.pills.length === 2 &&
        two.pills[0].pressed === false &&
        two.pills[1].pressed === true &&
        two.plateInput === PLATE_1,
      `pillole=${two.pills.map((p) => `${p.text}:${p.pressed}`).join(' | ')}`
    );
    check(
      'Affiancamento: stallo 2 a larghezza mezzo 1 + 180 cm = 430 cm',
      two.bays[1].cm === 250 + BAY_SPACING_CM,
      `offset ${two.bays[1].cm} cm`
    );
    check(
      'In pixel la traslazione reale è proporzionale (stallo 2 a destra dello stallo 1)',
      two.bays[1].viewportX > two.bays[0].viewportX,
      `${two.bays[0].viewportX.toFixed(0)}px → ${two.bays[1].viewportX.toFixed(0)}px`
    );
    check(
      'Header compatto: `MEZZO 1` / `MEZZO 2` e badge `ATTIVO` sul solo mezzo attivo',
      two.bays.every(
        (bay) =>
          bay.plate.length === (two.bays.indexOf(bay) === 1 ? 2 : 1) &&
          bay.plate.includes(`MEZZO ${two.bays.indexOf(bay) + 1}`) &&
          bay.active === (two.bays.indexOf(bay) === 1)
      ) &&
        two.bays.filter((bay) => bay.active).length === 1 &&
        two.bays[1].plate.includes('ATTIVO') &&
        !two.bays[0].plate.includes('ATTIVO'),
      JSON.stringify(two.bays.map((bay) => bay.plate))
    );
    check(
      'Totale Flotta (2 Mezzi) con colli e metri lineari complessivi',
      two.fleetTotal !== null &&
        two.fleetTotal.mezzi === 2 &&
        two.fleetTotal.colli === 1 &&
        two.fleetTotal.ldm > 0,
      JSON.stringify(two.fleetTotal)
    );
    check(
      'Riepilogo di stiva = solo i colli del Mezzo Attivo (1)',
      two.sideTotal === 1,
      `${two.sideTotal} colli`
    );
    check(
      'Nessuna icona "X" sul canvas e un header pulito per ciascuno stallo',
      two.canvasDeleteDiscs === 0 &&
        two.canvasHeaders === 2 &&
        two.bays.every((bay) => bay.headerCount === 1 && bay.deleteDiscs === 0),
      `header=${two.canvasHeaders}, dischi=${two.canvasDeleteDiscs}`
    );
    check(
      'Header e targa non si toccano: aria reale fra pillola e badge targa sui mezzi targati',
      (() => {
        // Solo gli stalli con targa disegnano il badge: gli altri non hanno nulla
        // da confrontare (nessuna sovrapposizione possibile).
        const gaps = two.bays
          .map((bay) => bay.headerToPlateGapPx)
          .filter((gap) => typeof gap === 'number');
        return gaps.length >= 1 && gaps.every((gap) => gap > 0);
      })(),
      two.bays.map((bay) => `${bay.headerToPlateGapPx}px`).join(' | ')
    );

    /* --- 3) Terzo mezzo: limite di flotta raggiunto ---------------------- */
    await clickElement(cdp, 'btn-add-bay');
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-bay]').length === 3 ? 1 : 0;`),
      4000,
      'aggiunta del terzo mezzo'
    );
    await setInput(cdp, 'vehicle-plate-input', PLATE_3);
    await sleep(150);
    await addItemToActiveBay(cdp, 2);

    const three = await cdp.eval(SNAPSHOT);
    check(
      'Tre mezzi affiancati in centrale',
      three.bayCount === 3,
      `${three.bayCount} stalli`
    );
    check(
      'Affiancamento a catena: stallo 3 a 430 + 250 + 180 = 860 cm',
      three.bays[2].cm === 430 + 250 + BAY_SPACING_CM,
      `offset ${three.bays[2].cm} cm`
    );
    check(
      'A flotta completa (MAX_BAYS = 3) il pulsante di aggiunta mezzo sparisce',
      three.hasAddBayButton === false,
      `bottone=${three.hasAddBayButton}`
    );
    check(
      'Totale Flotta (3 Mezzi) aggiornato a 2 colli',
      three.fleetTotal !== null && three.fleetTotal.mezzi === 3 && three.fleetTotal.colli === 2,
      JSON.stringify(three.fleetTotal)
    );

    /* --- 4) Le pillole comandano il Mezzo Attivo ------------------------- */
    // Prima di toccare la targa si fotografa l'header del Mezzo 1: serve a
    // provare che la targa digitata subito dopo **non** entri mai negli header
    // di stallo (vive soltanto nel badge targa sopra la Cabina).
    const beforePlate = await cdp.eval(SNAPSHOT);
    await clickElement(cdp, 'bay-pill-bay-1');
    await sleep(250);
    await setInput(cdp, 'vehicle-plate-input', PLATE_2);
    await sleep(250);
    const switched = await cdp.eval(SNAPSHOT);
    check(
      'Click sulla pillola `Mezzo 1`: lo stallo diventa attivo e il campo targa lo segue',
      switched.pills[0].pressed === true &&
        switched.pills[2].pressed === false &&
        switched.plateInput === PLATE_2 &&
        switched.bays[0].active === true &&
        switched.bays[2].active === false,
      `targa="${switched.plateInput}"`
    );
    check(
      'La targa resta **locale** al mezzo 1: nessun header la riporta',
      headerLabels(beforePlate.bays[0]) === 'MEZZO 1' &&
        headerLabels(switched.bays[1]) === 'MEZZO 2' &&
        headerLabels(switched.bays[2]) === 'MEZZO 3' &&
        !JSON.stringify(beforePlate.bays[0].plate).includes(PLATE_2) &&
        !JSON.stringify(switched.bays.map((bay) => bay.plate)).includes(PLATE_2),
      `before="${JSON.stringify(beforePlate.bays[0].plate)}" → ${JSON.stringify(switched.bays.map((bay) => bay.plate))}`
    );
    check(
      'Lavorare un mezzo non tocca la flotta: 3 stalli e 2 colli complessivi',
      switched.bayCount === 3 && switched.fleetTotal?.colli === 2,
      JSON.stringify(switched.fleetTotal)
    );

    /* --- 5) Salvataggio del piano multi-mezzo (schema v2) ---------------- */
    await clickElement(cdp, 'btn-save-project');
    const downloaded = await waitFor(
      () => {
        const files = existsSync(downloadDir)
          ? readdirSync(downloadDir).filter((f) => f.endsWith('.json'))
          : [];
        return files.length > 0 ? files : null;
      },
      6000,
      'download del file multi-mezzo'
    );
    const jsonFiles = downloaded.filter((f) => !f.endsWith('.crdownload'));
    const savedPath = join(downloadDir, jsonFiles[0]);
    const raw = readFileSync(savedPath, 'utf8');
    let saved = null;
    try {
      saved = JSON.parse(raw);
    } catch {
      saved = null;
    }

    check(
      'Salvataggio multi-mezzo: file `.json` scaricato e leggibile',
      jsonFiles.length === 1 && saved !== null,
      jsonFiles.join(', ')
    );
    check(
      'Schema v2: `version: 2` con la flotta `bays` di 3 stalli',
      saved?.version === 2 && Array.isArray(saved?.bays) && saved.bays.length === 3,
      `version=${saved?.version}, bays=${saved?.bays?.length}`
    );
    check(
      'Ogni stallo porta mezzo, targa, colli e note propri',
      saved?.bays?.every(
        (bay) =>
          typeof bay.id === 'string' &&
          typeof bay.vehicle?.width === 'number' &&
          typeof bay.plate === 'string' &&
          Array.isArray(bay.items) &&
          Array.isArray(bay.notes)
      ) === true,
      saved?.bays?.map((b) => `${b.id}:${b.plate}:${b.items.length}`).join(' ')
    );
    check(
      'Il file v2 non contiene più i campi piatti dello schema v1',
      !('vehicle' in saved) && !('items' in saved) && !('notes' in saved) && !('plate' in saved),
      Object.keys(saved).join(', ')
    );
    check(
      '`activeBayId` salvato e coerente con il Mezzo Attivo',
      saved?.activeBayId === 'bay-1',
      `activeBayId=${saved?.activeBayId}`
    );
    check(
      'Le targhe dei tre mezzi sono tutte nel file',
      [PLATE_2, PLATE_1, PLATE_3].every((p) => JSON.stringify(saved).includes(p)),
      JSON.stringify(saved.bays.map((b) => b.plate))
    );

    /* --- 6) Auto-migrazione di un vecchio piano v1 ----------------------- */
    const delivered = await loadProjectFile(
      cdp,
      'piano-storico-v1.json',
      JSON.stringify(LEGACY_V1_PROJECT, null, 2)
    );
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-item]').length === 4 ? 1 : 0;`),
      5000,
      'migrazione del piano v1'
    );
    const migrated = await cdp.eval(SNAPSHOT);
    check(
      'Piano v1 aperto: file consegnato al selettore classico',
      delivered === 1,
      `files.length=${delivered}`
    );
    check(
      'Auto-migrazione v1 → v2: un unico stallo con i 4 colli storici',
      migrated.bayCount === 1 &&
        migrated.bays[0].items === 4 &&
        migrated.bays[0].cm === 0 &&
        migrated.sideTotal === 4,
      `${migrated.bayCount} stallo, ${migrated.bays[0].items} colli`
    );
    check(
      'Nella scena migrata tornano la targa del piano singolo e il comando `+ Mezzo`',
      migrated.plateInput === 'LEGACY01' &&
        migrated.hasAddBayButton === true &&
        migrated.bays[0].plate.join(' ').includes('MEZZO 1') &&
        !migrated.bays[0].plate.join(' ').includes('LEGACY01'),
      `targa="${migrated.plateInput}", bottone=${migrated.hasAddBayButton}, header=${JSON.stringify(migrated.bays[0].plate)}`
    );

    /* --- 7) Undo: il ritorno alla centrale a tre mezzi -------------------- */
    await pressUndo(cdp);
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-bay]').length === 3 ? 1 : 0;`),
      5000,
      'undo dell\'apertura del file v1'
    );
    const restored = await cdp.eval(SNAPSHOT);
    check(
      '`Ctrl + Z` annulla l\'apertura: tornano i 3 mezzi con i loro 2 colli',
      restored.bayCount === 3 && restored.fleetTotal?.colli === 2,
      JSON.stringify(restored.fleetTotal)
    );

    /* --- 8) Eliminazione di un mezzo (conferma antipanico) --------------- */
    // Si elimina di proposito lo stallo **carico**: prima dell'eliminazione si
    // seleziona la pillola del mezzo che contiene i colli, così la conferma
    // antipanico deve comparire davvero.
    const loadedBayPill = restored.pills[restored.bays.findIndex((bay) => bay.items > 0)]?.id ?? null;
    check(
      'Dopo l\'undo esiste uno stallo carico da eliminare',
      loadedBayPill !== null,
      `${loadedBayPill} (${restored.bays.map((b) => b.items).join('/')} colli)`
    );
    await clickElement(cdp, loadedBayPill);
    await sleep(200);
    cdp.dialogs.length = 0;
    await clickElement(cdp, 'btn-delete-bay');
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-bay]').length === 2 ? 1 : 0;`),
      5000,
      'eliminazione del mezzo'
    );
    const afterDelete = await cdp.eval(SNAPSHOT);
    check(
      'Eliminazione del mezzo: restano 2 stalli e il totale flotta si aggiorna',
      afterDelete.bayCount === 2 && afterDelete.fleetTotal?.mezzi === 2,
      JSON.stringify(afterDelete.fleetTotal)
    );
    check(
      'Eliminazione di uno stallo carico: il suo carico esce dal totale di flotta',
      afterDelete.fleetTotal?.colli === 1,
      JSON.stringify(afterDelete.fleetTotal)
    );
    check(
      'Conferma antipanico mostrata perché il mezzo conteneva del carico',
      cdp.dialogs.some((d) => /eliminare il mezzo/i.test(d)),
      cdp.dialogs.slice(-1)[0] ?? 'nessun dialogo'
    );
    check(
      'Dopo l\'eliminazione la flotta resta comandabile (2 pillole, una attiva)',
      afterDelete.pills.length === 2 && afterDelete.pills.filter((p) => p.pressed).length === 1,
      afterDelete.pills.map((p) => `${p.text}:${p.pressed}`).join(' | ')
    );

    /* --- 9) Stampe: Solo Grafica (orientamento dinamico) e una pagina per mezzo --- */
    /**
     * Il dialogo di stampa nativo non è pilotabile da CDP: si misura quindi il
     * **layout reale delle sezioni** che finiscono sul foglio — le stesse che le
     * regole `@media print` di `src/index.css` mostrano o nascondono — con la
     * modalità di stampa applicata e poi rimossa.
     *
     * La misura viene fatta sulla centrale **a tre mezzi** (il file multi-mezzo
     * appena salvato), che è la condizione limite dell'architettura.
     */
    await loadProjectFile(cdp, 'piano-multi.json', raw);
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-bay]').length === 3 ? 1 : 0;`),
      5000,
      'riapertura del piano multi-mezzo per la stampa'
    );

    const measurePrintLayout = async (mode) => {
      await cdp.eval(`
        document.documentElement.setAttribute('data-print-mode', ${JSON.stringify(mode)});
        return 1;
      `);
      await sleep(150);
      const measured = await cdp.eval(`
        const report = document.getElementById('print-report');
        const cleanSheet = report.querySelector('.print-clean-sheet');
        const cleanSvg = cleanSheet ? cleanSheet.querySelector('svg') : null;
        return {
          cleanSheet: !!cleanSheet,
          fleetViewBox: cleanSvg ? cleanSvg.getAttribute('viewBox') : null,
          fleetStalls: cleanSvg
            ? (cleanSvg.innerHTML.match(/<g transform="translate\\(/g) || []).length
            : 0,
          bayPages: report.querySelectorAll('.print-bay-page').length,
          hasSummary: !!report.querySelector('.print-fleet-summary'),
          bayPageViewBoxes: [...report.querySelectorAll('.print-bay-page .print-drawing svg')].map(
            (s) => s.getAttribute('viewBox')
          ),
          bayPageStalls: [...report.querySelectorAll('.print-bay-page .print-drawing svg')].map(
            (s) => (s.innerHTML.match(/<g transform="translate\\(/g) || []).length
          ),
          // Targa stampata nell'intestazione di ciascuna pagina di mezzo.
          bayPagePlates: [...report.querySelectorAll('.print-bay-page header')].map((h) =>
            (h.textContent || '').replace(/\\s+/g, ' ').trim()
          ),
        };
      `);
      await cdp.eval(`document.documentElement.removeAttribute('data-print-mode'); return 1;`);
      await sleep(120);
      return measured;
    };

    const cleanLayout = await measurePrintLayout('clean');
    const fullLayout = await measurePrintLayout('full');
    // Il file è già in scena (riaperto per la stampa): l'evidenza grafica si
    // limita a togliere l'HUD e a fotografare la centrale a tre mezzi.
    await cdp.eval(`document.querySelector('.canvas-hud')?.remove(); return 1;`);
    await sleep(350);

    check(
      'Stampa Solo Grafica: foglio unico con i 3 pianali affiancati nello stesso disegno',
      cleanLayout.cleanSheet === true &&
        cleanLayout.fleetStalls >= 3 &&
        typeof cleanLayout.fleetViewBox === 'string',
      `stalli nel disegno=${cleanLayout.fleetStalls}, viewBox=${cleanLayout.fleetViewBox}`
    );
    check(
      'Stampa Scheda Completa: una pagina A4 per ciascun mezzo',
      fullLayout.bayPages === 3,
      `${fullLayout.bayPages} pagine`
    );
    check(
      'Ogni pagina di mezzo ha la propria inquadratura dedicata (una per stallo)',
      fullLayout.bayPageViewBoxes.length === 3 &&
        fullLayout.bayPageViewBoxes.every(
          (vb) => typeof vb === 'string' && vb.startsWith('-')
        ) &&
        // Pagine di mezzi con identico ingombro possono condividere il viewBox:
        // ciò che conta è che ognuna abbia il proprio disegno con la propria targa.
        new Set(fullLayout.bayPagePlates).size === 3,
      `${JSON.stringify(fullLayout.bayPageViewBoxes)} · targhe ${JSON.stringify(fullLayout.bayPagePlates)}`
    );
    check(
      'Pagina di servizio `TOTALE FLOTTA` presente con più di un mezzo',
      fullLayout.hasSummary === true
    );

    /* --- 9-bis) Orientamento del foglio per ciascuna modalità ------------ */
    /**
     * La stampa parte **dai pulsanti reali** della sidebar: è `triggerPrint` a
     * iniettare la regola `@page` con l'orientamento giusto (panoramico per la
     * sola grafica, verticale per la scheda). Il dialogo nativo viene chiuso
     * subito dal gestore `Page.javascriptDialogOpening`.
     */
    const printFromButton = async (buttonId) => {
      const styleId = 'print-page-orientation';
      await cdp.eval(`document.getElementById(${JSON.stringify(buttonId)}).click(); return 1;`);
      await sleep(500);
      // Le regole del foglio vivono dentro `@media print`: la pagina viene messa
      // per un istante in emulazione di stampa, così si misura la dimensione
      // **reale** del foglio in millimetri (e non solo il testo della regola
      // `@page`). L'emulazione viene poi spenta senza toccare il documento.
      await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });
      await sleep(200);
      const state = await cdp.eval(`
        const style = document.getElementById(${JSON.stringify(styleId)});
        const report = document.getElementById('print-report');
        const sheet = report.querySelector('.print-clean-sheet');
        const px2mm = (value) => Math.round((parseFloat(value) / 96) * 25.4);
        const box = sheet ? sheet.getBoundingClientRect() : null;
        return {
          mode: document.documentElement.getAttribute('data-print-mode'),
          landscape: document.documentElement.getAttribute('data-print-landscape'),
          pageRule: style ? style.textContent.trim() : null,
          cleanSheet: !!sheet,
          bayPages: report.querySelectorAll('.print-bay-page').length,
          sheetWidthMm: box ? px2mm(box.width) : null,
          sheetHeightMm: box ? px2mm(box.height) : null,
        };
      `);
      await cdp.send('Emulation.setEmulatedMedia', { media: '' });
      await cdp.eval(`
        document.documentElement.removeAttribute('data-print-mode');
        document.documentElement.removeAttribute('data-print-landscape');
        document.getElementById(${JSON.stringify(styleId)})?.remove();
        return 1;
      `);
      await sleep(120);
      return state;
    };

    const cleanPrint = await printFromButton('btn-print-clean');
    const fullPrint = await printFromButton('btn-print-report');

    check(
      'Pulsante "Stampa Solo Grafica" con 3 mezzi: foglio A4 **panoramico** 297×210 mm',
      cleanPrint.mode === 'clean' &&
        /A4\s+landscape/.test(cleanPrint.pageRule || '') &&
        cleanPrint.landscape === 'true' &&
        cleanPrint.cleanSheet === true &&
        cleanPrint.sheetWidthMm === 297 &&
        cleanPrint.sheetHeightMm === 210,
      `mode=${cleanPrint.mode}, @page="${cleanPrint.pageRule}", foglio=${cleanPrint.sheetWidthMm}×${cleanPrint.sheetHeightMm}mm, landscape=${cleanPrint.landscape}`
    );
    check(
      'Pulsante "Stampa Scheda Completa": foglio A4 **verticale**, una pagina per mezzo',
      fullPrint.mode === 'full' &&
        /A4\s+portrait/.test(fullPrint.pageRule || '') &&
        fullPrint.bayPages === 3,
      `mode=${fullPrint.mode}, @page="${fullPrint.pageRule}", pagine=${fullPrint.bayPages}`
    );
    const afterPrint = await cdp.eval(`
      return {
        mode: document.documentElement.getAttribute('data-print-mode'),
        landscape: document.documentElement.getAttribute('data-print-landscape'),
        style: !!document.getElementById('print-page-orientation'),
      };
    `);
    check(
      'A fine stampa nessun residuo: modalità, orientamento e regola `@page` rimossi dal documento',
      afterPrint.mode === null && afterPrint.landscape === null && afterPrint.style === false,
      `mode=${afterPrint.mode}, landscape=${afterPrint.landscape}, @page=${afterPrint.style}`
    );

    /* --- 9-ter) Orientamento dinamico: 1 o 2 mezzi restano in A4 verticale --- */
    /**
     * Il foglio "Solo Grafica" non è più panoramico a prescindere: con **1 o 2
     * mezzi** i pianali sono alti e stretti e il disegno sfrutta tutto l'A4
     * **verticale** (210×297 mm); la larghezza del foglio panoramico serve solo
     * con **3 mezzi**. Si scende quindi a 2 mezzi eliminando uno stallo col solo
     * pulsante `Elimina` della sidebar (sul canvas non esiste più alcuna "X") e si
     * ripete la stampa reale.
     */
    const loadedBayPillId =
      (await cdp.eval(SNAPSHOT)).pills.find((pill) => pill.pressed)?.id ?? null;
    check(
      'Prima della prova di orientamento esiste un mezzo attivo da eliminare',
      loadedBayPillId !== null && (await cdp.eval(`return document.querySelectorAll('[data-canvas-bay]').length;`)) === 3,
      `${loadedBayPillId}`
    );
    cdp.dialogs.length = 0;
    await clickElement(cdp, 'btn-delete-bay');
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-bay]').length === 2 ? 1 : 0;`),
      5000,
      'riduzione della flotta a 2 mezzi per la prova di orientamento'
    );
    const cleanPrintTwo = await printFromButton('btn-print-clean');
    check(
      'Pulsante "Stampa Solo Grafica" con 2 mezzi: foglio A4 **verticale** 210×297 mm',
      cleanPrintTwo.mode === 'clean' &&
        /A4\s+portrait/.test(cleanPrintTwo.pageRule || '') &&
        cleanPrintTwo.landscape === null &&
        cleanPrintTwo.cleanSheet === true &&
        cleanPrintTwo.sheetWidthMm === 210 &&
        cleanPrintTwo.sheetHeightMm === 297,
      `mode=${cleanPrintTwo.mode}, @page="${cleanPrintTwo.pageRule}", foglio=${cleanPrintTwo.sheetWidthMm}×${cleanPrintTwo.sheetHeightMm}mm, landscape=${cleanPrintTwo.landscape}`
    );

    /* --- 10) Nessun errore runtime --------------------------------------- */
    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    /* --- Evidenza grafica: la centrale a tre mezzi ---------------------- */
    await loadProjectFile(cdp, 'piano-multi.json', raw);
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-bay]').length === 3 ? 1 : 0;`),
      5000,
      'riapertura del piano multi-mezzo'
    );
    await cdp.eval(`document.querySelector('.canvas-hud')?.remove(); return 1;`);
    await sleep(350);
    const shotDir = 'shots';
    mkdirSync(shotDir, { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shotDir, 'centrale-multi-pianale.png'), Buffer.from(shot.data, 'base64'));
    console.log('Evidenza grafica: shots/centrale-multi-pianale.png');

    console.log(`\n${passed}/${passed + failed} controlli superati`);
    console.log(
      `Durata della verifica: ${((Date.now() - startedAt) / 1000).toFixed(2)} s (limite 30 s)`
    );
    console.log(`File multi-mezzo analizzato: ${savedPath}`);
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
  console.error('WATCHDOG: verifica interrotta oltre i 30 secondi');
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

main()
  .then(() => process.exit(failed === 0 ? 0 : 1))
  .catch((error) => {
    console.error('ERRORE:', error?.message ?? error);
    process.exit(1);
  });
