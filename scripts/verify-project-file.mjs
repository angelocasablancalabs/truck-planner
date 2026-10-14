/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — SALVA & APRI PIANO DI CARICO (.json)
 *
 *  Pilota Chrome reale via Chrome DevTools Protocol (zero dipendenze aggiunte)
 *  e verifica il modulo `src/utils/fileStorage.ts` end-to-end, dal click
 *  dell'operatore al file sul disco:
 *
 *    1. **Salva Piano** → il browser scarica davvero un file `.json` con il
 *       nome pulito ufficiale (`piano-<TARGA>_<YYYY-MM-DD>.json`, targa ripulita
 *       da ogni carattere non alfanumerico) e contenuto valido nella **centrale
 *       multi-pianale (schema v2)**: `version: 2`, `app: 'truck-planner'`,
 *       `timestamp` ISO, la **flotta `bays`** con il mezzo (bilico CC
 *       250 × 1328), la **targa** digitata, i **3 colli** con quote/posizioni/
 *       colori, le **note laterali**, `activeBayId` e la **densità etichette**;
 *    2. **feedback "Salvato!"** verde per 2 secondi sul pulsante;
 *    3. **Apri Piano** → un file di progetto valido (6 colli, targa diversa,
 *       densità `minimal`, 1 nota) ripristina **tutto lo stato in scena**:
 *       targa, numero e codici dei colli sul canvas, nota laterale, densità;
 *    4. **Undo** (`Ctrl + Z`) annulla l'apertura e riporta lo stato precedente;
 *    5. **file corrotto** → `alert` amichevole e **nessuna** alterazione del
 *       pianale (i colli restano quelli di prima);
 *    6. **piano storico v1** (a pianale singolo) → auto-migrazione istantanea al
 *       primo stallo e messa in scena senza perdere nemmeno un collo.
 *
 *  Uso:  node scripts/verify-project-file.mjs [url]
 *  Chiude sempre con `browser.close()` + `process.exit(0)` entro 15 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://127.0.0.1:5199/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9337);
const WATCHDOG_MS = 15000;
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

/**
 * Tailwind v4 esprime i colori in `oklch(…)`: i controlli cromatici accettano
 * sia la notazione moderna sia i corrispondenti valori RGB storici.
 */
/**
 * Verde `emerald-600` di Tailwind v4: colore dell'icona `Salva` quando il
 * feedback `Salvato!` è acceso (con il fallback RGB).
 */
const VERDE_600 = ['oklch(0.596 0.145 163.225)', 'rgb(5, 150, 105)'];
/**
 * Ardesia `slate-600` di Tailwind v4: tinta **istituzionale uniforme** delle sei
 * icone della toolbar (con il fallback RGB). Sostituisce i vecchi accenti
 * cromatici per-pulsante: l'unico colore acceso resta il feedback dinamico.
 */
const ARDESIA_600 = ['oklch(0.446 0.043 257.281)', 'rgb(71, 85, 105)'];

/** Targa digitata in sidebar: 19 caratteri, contiene spazi (→ `_` nel nome file). */
const PLATE_SAVED = 'XA111NJ COME ARRIVA';
/** Nome file atteso: targa ripulita + data ISO del giorno del salvataggio. */
const TODAY = new Date().toISOString().slice(0, 10);
const EXPECTED_FILE_NAME = `piano-XA111NJ_COME_ARRIVA-${TODAY}.json`;

/** Mezzo di riferimento: bilico CC 250 × 1328 cm. */
const VEHICLE = { id: 'bilico_cc', name: 'Bilico frigo Fiori', width: 250, length: 1328 };
/** Tinta di riempimento del lotto EUR caricato in scena (Verde scuro). */
const BATCH_COLOR = '#4ADE80';
/** Bordo rigido di ogni collo (`ITEM_BORDER_COLOR`). */
const ITEM_BORDER_COLOR = '#334155';
/** Dimensione del feedback verde "Salvato!" (ms): deve spegnersi da solo. */
const SAVE_FEEDBACK_MS = 2000;

/** Carico di partenza: deve finire **dentro** il file salvato. */
const SEED_ITEMS = [
  { code: 'INDU', width: 120, length: 100, x: 0, y: 0 },
  { code: 'INDU', width: 120, length: 100, x: 120, y: 0 },
  { code: 'EUR', width: 120, length: 80, x: 0, y: 100, name: 'COOP', color: BATCH_COLOR },
];

/** Piano di ripristino: 6 colli, targa diversa, densità `minimal` e una nota. */
const FIXTURE_PROJECT = {
  version: 2,
  app: 'truck-planner',
  timestamp: '2026-03-04T08:15:00.000Z',
  bays: [
    {
      id: 'bay-1',
      vehicle: VEHICLE,
      plate: 'XZ999ZZ',
      items: Array.from({ length: 6 }, (_, i) => ({
        id: `INDU_fixture_${i}`,
        code: 'INDU',
        name: i < 3 ? 'PRODIVA' : 'CONAD',
        width: 120,
        length: 100,
        x: (i % 2) * 120,
        y: Math.floor(i / 2) * 100,
        rotation: 90,
        color: '#E2E8F0',
        borderColor: ITEM_BORDER_COLOR,
      })),
      notes: [
        {
          id: 'note_fixture_1',
          x: 280,
          y: 40,
          content: 'Bancali poco stabili: attenzione durante il carico.',
          color: '#E2E8F0',
          borderColor: '#94A3B8',
          width: 140,
          fontSize: 14,
        },
      ],
    },
  ],
  activeBayId: 'bay-1',
  labelDensity: 'minimal',
};

/**
 * Piano **storico a pianale singolo** (schema v1): campi piatti in radice e
 * nessun `bays`. Deve essere riconosciuto e migrato al volo in un unico stallo,
 * senza perdere colli né targhe.
 */
const LEGACY_V1_PROJECT = {
  version: 1,
  app: 'truck-planner',
  timestamp: '2026-01-08T06:45:00.000Z',
  vehicle: VEHICLE,
  plate: 'STORICO1',
  items: Array.from({ length: 3 }, (_, i) => ({
    id: `LEGACY_${i}`,
    code: 'INDU',
    name: 'CLIENTE STORICO',
    width: 120,
    length: 100,
    x: (i % 2) * 120,
    y: Math.floor(i / 2) * 100,
    rotation: 90,
    color: '#E2E8F0',
    borderColor: ITEM_BORDER_COLOR,
  })),
  notes: [],
  labelDensity: 'all',
};

/** File non valido: JSON corretto ma **senza** i campi minimi indispensabili. */
const CORRUPT_PROJECT = { version: 1, app: 'truck-planner', note: 'file estraneo' };
/** File illeggibile: JSON troncato a metà. */
const UNREADABLE_FILE_CONTENT = '{ "version": 1, "app": "truck-planner", "items": [' ;

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
    /** Ultimo dialogo nativo aperto dalla pagina (`alert` di errore). */
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

/* --- Interazioni reali con il mouse --------------------------------------- */

/**
 * Click fisico sul centro di un elemento: `Input.dispatchMouseEvent` produce un
 * evento fidato (user gesture reale), condizione necessaria perché Chrome
 * avvii davvero il download del file di progetto.
 */
const clickElement = async (cdp, id) => {
  const box = await cdp.eval(`
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  `);
  if (!box) throw new Error(`elemento #${id} non trovato`);
  const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  return box;
};

/** Scrittura nel campo targa tramite il setter nativo (React 19 lo intercetta). */
const typePlate = (cdp, value) =>
  cdp.eval(`
    const el = document.getElementById('vehicle-plate-input');
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    desc.set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  `);

/** Scrittura in un input numerico del cassetto, con setter nativo di React. */
const setNumberInput = (cdp, id, value) =>
  cdp.eval(`
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return null;
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    desc.set.call(el, String(${JSON.stringify(value)}));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  `);

/** Scrittura in un input di testo (cliente/lotto del cassetto). */
const setTextInput = (cdp, id, value) =>
  cdp.eval(`
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return null;
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    desc.set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  `);

/**
 * Invio di Ctrl+Z reale alla pagina (scorciatoia Undo del motore a snapshot).
 *
 * Il focus viene prima riportato sul `body`: le scorciatoie globali di `App.tsx`
 * ignorano di proposito gli eventi che arrivano dai campi di scrittura (compreso
 * l'`<input type="file">` che ha appena ricevuto il piano), così l'undo nativo
 * del testo non viene mai rubato all'operatore.
 */
const pressUndo = async (cdp) => {
  await cdp.send('Page.bringToFront').catch(() => {});
  await cdp.eval(`
    const active = document.activeElement;
    if (active && active !== document.body) active.blur();
    document.body.focus();
    return document.activeElement?.tagName ?? 'n/d';
  `);
  const key = { key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, ...key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, ...key });
};

/**
 * Apertura di un file dal selettore nativo: il contenuto viene iniettato in un
 * `<input type="file">` reale tramite `DataTransfer` e l'evento `change` è
 * fidato (`isTrusted === true`), quindi React lo gestisce come un file scelto
 * dall'operatore. Il campo viene svuotato subito dal gestore (stesso file
 * riselezionabile), quindi lo stato di consegna viene letto **prima** che
 * l'evento possa essere consumato.
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
  // Il gestore React è asincrono (lettura del file): si attende che la pagina
  // abbia davvero elaborato l'evento prima di fotografare lo stato.
  await sleep(350);
  return delivered;
};

/* --- Fotografia dello stato in scena -------------------------------------- */

/**
 * Stato osservabile dell'applicazione: targa mostrata, colli sul canvas (per
 * codice e numero), note laterali, densità etichette attiva, selezioni e
 * contatore ufficiale del riepilogo stiva.
 */
const SNAPSHOT = `
  const deck = document.querySelector('.control-deck');
  const items = [...document.querySelectorAll('[data-canvas-item]')];
  const notes = [...document.querySelectorAll('[data-canvas-note]')];
  const density = [...document.querySelectorAll('[aria-label="Densità etichette"] button')]
    .find((b) => b.getAttribute('aria-pressed') === 'true');
  const plate = document.getElementById('canvas-plate-badge');
  const total = /(\\d+)\\s+Colli Totali/.exec(deck?.textContent || '');
  const saveBtn = document.getElementById('btn-save-project');
  return {
    plateText: plate ? (plate.textContent || '').trim() : null,
    plateInput: document.getElementById('vehicle-plate-input')?.value ?? null,
    itemCount: items.length,
    itemCodes: items.map((g) => g.getAttribute('data-canvas-item')),
    itemTexts: items.map((g) => (g.textContent || '').trim()),
    noteCount: notes.length,
    density: density ? density.textContent.trim() : null,
    sidebarTotal: total ? Number(total[1]) : -1,
    saveLabel: saveBtn ? (saveBtn.querySelector('span.sr-only')?.textContent || '').trim() : null,
    saveLabelColor: saveBtn
      ? getComputedStyle(saveBtn.querySelector('svg')).color
      : null,
    selectedPanel: !!document.getElementById('btn-add-side-note'),
    canUndo: !document.getElementById('btn-undo')?.disabled,
  };
`;

/* --- Script ----------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();

  // Cartelle di lavoro locali (dentro il progetto: leggibili anche dal file
  // system dello script) → `tmp/piano-verify/…`
  const workDir = resolve('tmp', 'piano-verify');
  const downloadDir = join(workDir, 'downloads');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(downloadDir, { recursive: true });

  // Fixture su disco: piano valido, piano incompleto e file troncato.
  const fixtureValidPath = join(workDir, 'fixture-valida.json');
  writeFileSync(fixtureValidPath, JSON.stringify(FIXTURE_PROJECT, null, 2), 'utf8');

  const profileDir = mkdtempSync(join(tmpdir(), 'piano-profile-'));
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
    await cdp.send('DOM.enable');

    // Download automatici nella cartella di verifica (niente prompt nativo).
    await cdp.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
    });
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: true,
    });

    await cdp.send('Page.navigate', { url: DEV_URL });

    await waitFor(
      async () => cdp.eval(`return document.getElementById('btn-save-project') ? 1 : 0;`),
      10000,
      'mount della barra comandi'
    );

    /*
     * Chrome headless *espone* la File System Access API ma non può mostrare le
     * finestre di dialogo native: `showSaveFilePicker` / `showOpenFilePicker`
     * restano appesi per sempre. Questa suite storica verifica il **fallback
     * trasparente** (download `<a download>` + `<input type="file">` classico),
     * cioè il comportamento dei browser senza File System Access API: l'API
     * viene quindi spenta nella pagina con `Object.defineProperty`, esattamente
     * come se il browser non la supportasse. Il percorso nativo — sovrascrittura
     * in-place e selettore di salvataggio — è verificato in
     * `scripts/verify-inplace-save.mjs`, con handle e selettori controllabili.
     */
    await cdp.eval(`
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true, writable: true, value: undefined,
      });
      Object.defineProperty(window, 'showOpenFilePicker', {
        configurable: true, writable: true, value: undefined,
      });
      return 1;
    `);

    /* --- 0) Presenza dei nuovi comandi in sidebar ------------------------ */
    const commands = await cdp.eval(`
      const save = document.getElementById('btn-save-project');
      const open = document.getElementById('btn-open-project');
      const input = document.getElementById('project-file-input');
      const bar = save?.parentElement;
      // Testo VISIBILE: tutto ciò che non vive dentro uno span.sr-only.
      const visibleText = (btn) =>
        btn
          ? Array.from(btn.childNodes)
              .filter((n) => n.nodeType === 3 || !(n.classList && n.classList.contains('sr-only')))
              .map((n) => n.textContent || '')
              .join('')
              .trim()
          : null;
      return {
        hasSave: !!save,
        hasOpen: !!open,
        hasInput: !!input,
        accept: input?.getAttribute('accept') ?? null,
        inputHidden: input ? input.className.includes('hidden') : null,
        gridClass: bar?.className ?? null,
        saveClass: save?.className ?? null,
        openClass: open?.className ?? null,
        saveText: save?.querySelector('span')?.textContent?.trim() ?? null,
        openText: open?.querySelector('span')?.textContent?.trim() ?? null,
        saveTextClass: save?.querySelector('span')?.className ?? null,
        openTextClass: open?.querySelector('span')?.className ?? null,
        saveVisibleText: visibleText(save),
        openVisibleText: visibleText(open),
        openIconColor: open ? getComputedStyle(open.querySelector('svg')).color : null,
      };
    `);

    check(
      'Sidebar: pulsanti `Salva` e `Apri Piano` presenti nella toolbar a icone',
      commands.hasSave && commands.hasOpen
    );
    check(
      'Riga comandi compatta: `grid grid-cols-3 gap-1.5` (tre icone uniformi per riga)',
      commands.gridClass.includes('grid-cols-3') &&
        commands.gridClass.includes('gap-1.5'),
      commands.gridClass
    );
    check(
      'Etichette accessibili `sr-only`: `Salva` e `Apri Piano` (nessun testo visibile)',
      commands.saveText === 'Salva' &&
        commands.openText === 'Apri Piano' &&
        commands.saveTextClass.includes('sr-only') &&
        commands.openTextClass.includes('sr-only') &&
        commands.saveVisibleText === '' &&
        commands.openVisibleText === '',
      `"${commands.saveText}" / "${commands.openText}" (${commands.openTextClass})`
    );
    check(
      'Icona `FolderOpen` in ardesia istituzionale (`text-slate-600`) sul pulsante `Apri Piano`',
      ARDESIA_600.includes(commands.openIconColor),
      `colore icona ${commands.openIconColor}`
    );
    const SAVE_BUTTON_CLASSES = [
      'h-9',
      'bg-white',
      'hover:bg-slate-50',
      'border',
      'border-slate-200',
      'text-slate-700',
      'rounded',
      'flex',
      'items-center',
      'justify-center',
      'transition',
      'cursor-pointer',
      'shadow-xs',
    ];
    check(
      'Stile sobrio richiesto sull\'icona `Salva` (altezza, sfondo, bordo, transizione)',
      SAVE_BUTTON_CLASSES.every((cls) => commands.saveClass.split(/\s+/).includes(cls)),
      commands.saveClass
    );
    check(
      'Selettore file nativo nascosto con `accept=".json,application/json"`',
      commands.hasInput && commands.accept === '.json,application/json' && commands.inputHidden === true,
      `accept=${commands.accept}, hidden=${commands.inputHidden}`
    );

    /* --- 1) Preparazione del carico in scena ----------------------------- */
    // Lotto di 2 PLT INDU (cassetto con Q.tà = 2) + 1 PLT EUR, poi la targa.
    // La Q.tà viene sempre forzata: il default del cassetto è 10.
    await cdp.eval(`document.getElementById('pallet-row-INDU').click(); return 1;`);
    await waitFor(
      async () => cdp.eval(`return document.getElementById('batch-qty-INDU') ? 1 : 0;`),
      4000,
      'cassetto INDU aperto'
    );
    await setNumberInput(cdp, 'batch-qty-INDU', 2);
    await clickElement(cdp, 'batch-add-piatto-INDU');
    await sleep(200);

    await cdp.eval(`document.getElementById('pallet-row-EUR').click(); return 1;`);
    await waitFor(
      async () => cdp.eval(`return document.getElementById('batch-qty-EUR') ? 1 : 0;`),
      4000,
      'cassetto EUR aperto'
    );
    await setNumberInput(cdp, 'batch-qty-EUR', 1);
    await setTextInput(cdp, 'batch-name-EUR', 'COOP');
    await sleep(120);
    // Tinta del lotto scelta dalla matrice colori 7 × 3 del cassetto.
    await cdp.eval(`
      const swatch = [...document.querySelectorAll('#pallet-batch-EUR button[aria-label]')]
        .find((b) => b.getAttribute('aria-label') === 'Colore lotto PLT EUR Verde scuro');
      if (!swatch) return 'swatch-assente';
      swatch.click();
      return swatch.getAttribute('aria-pressed');
    `);
    await sleep(120);
    await clickElement(cdp, 'batch-add-piatto-EUR');
    await sleep(200);

    const typedPlate = await typePlate(cdp, PLATE_SAVED);
    await sleep(250);

    const seeded = await cdp.eval(SNAPSHOT);
    check(
      'Carico di partenza in scena: 3 colli (2 INDU + 1 EUR) e targa digitata',
      seeded.itemCount === 3 &&
        seeded.itemCodes.join(',') === 'INDU,INDU,EUR' &&
        seeded.sidebarTotal === 3 &&
        typedPlate === PLATE_SAVED,
      `${seeded.itemCodes.join(' | ')} · targa "${typedPlate}"`
    );

    /* --- 2) Salva Piano → download reale del file .json ------------------- */
    const saveBox = await clickElement(cdp, 'btn-save-project');
    await sleep(300);
    const saving = await cdp.eval(SNAPSHOT);
    check(
      'Feedback di conferma `Salvato!` in verde subito dopo il click',
      saving.saveLabel === 'Salvato!' && VERDE_600.includes(saving.saveLabelColor),
      `"${saving.saveLabel}" · colore ${saving.saveLabelColor}`
    );

    const downloaded = await waitFor(
      () => {
        const files = existsSync(downloadDir)
          ? readdirSync(downloadDir).filter((f) => f.endsWith('.json'))
          : [];
        return files.length > 0 ? files : null;
      },
      6000,
      'download del file di progetto'
    );

    const jsonFiles = downloaded.filter((f) => !f.endsWith('.crdownload'));
    const downloadedPath = join(downloadDir, jsonFiles[0]);
    const raw = readFileSync(downloadedPath, 'utf8');
    let saved = null;
    try {
      saved = JSON.parse(raw);
    } catch {
      saved = null;
    }

    check(
      'Click su `Salva Piano`: il browser scarica davvero un file `.json`',
      jsonFiles.length === 1 && saved !== null,
      `${jsonFiles.length} file: ${jsonFiles.join(', ')}`
    );
    check(
      'Nome file pulito `piano-<TARGA>_<YYYY-MM-DD>.json` (targa ripulita)',
      jsonFiles[0] === EXPECTED_FILE_NAME,
      `${jsonFiles[0]} (atteso ${EXPECTED_FILE_NAME})`
    );
    check(
      'Firma del formato (schema v2): `version: 2`, `app: "truck-planner"`, `timestamp` ISO',
      saved?.version === 2 &&
        saved?.app === 'truck-planner' &&
        typeof saved?.timestamp === 'string' &&
        !Number.isNaN(Date.parse(saved.timestamp)),
      `version=${saved?.version}, app=${saved?.app}, timestamp=${saved?.timestamp}`
    );
    check(
      'Flotta salvata: un unico stallo `bay-1` con il bilico CC 250 × 1328 cm',
      Array.isArray(saved?.bays) &&
        saved.bays.length === 1 &&
        saved.bays[0].id === 'bay-1' &&
        saved.bays[0].vehicle?.id === VEHICLE.id &&
        saved.bays[0].vehicle?.width === 250 &&
        saved.bays[0].vehicle?.length === 1328,
      `${saved?.bays?.length} stallo/i — ${saved?.bays?.[0]?.vehicle?.id} ${saved?.bays?.[0]?.vehicle?.width}×${saved?.bays?.[0]?.vehicle?.length} cm`
    );
    check(
      'Nessun campo piatto dello schema v1 nel file salvato',
      !('vehicle' in saved) && !('items' in saved) && !('notes' in saved) && !('plate' in saved),
      Object.keys(saved).join(', ')
    );
    check(
      'Targa salvata esattamente come digitata',
      saved?.bays?.[0]?.plate === PLATE_SAVED,
      `"${saved?.bays?.[0]?.plate}"`
    );
    check(
      'Colli salvati: 3, con codici, quote, posizioni, tinte e bordo antracite',
      Array.isArray(saved?.bays?.[0]?.items) &&
        saved.bays[0].items.length === 3 &&
        saved.bays[0].items.map((i) => i.code).join(',') === 'INDU,INDU,EUR' &&
        saved.bays[0].items[0].width === 120 &&
        saved.bays[0].items[0].length === 100 &&
        saved.bays[0].items[0].x === 0 &&
        saved.bays[0].items[0].y === 0 &&
        saved.bays[0].items[1].x === 120 &&
        saved.bays[0].items[2].y === 100 &&
        saved.bays[0].items[2].name === 'COOP' &&
        saved.bays[0].items[2].color.toLowerCase() === BATCH_COLOR.toLowerCase() &&
        saved.bays[0].items.every((i) => i.borderColor === ITEM_BORDER_COLOR),
      saved?.bays?.[0]?.items
        ?.map((i) => `${i.code}(${i.width}×${i.length})@${i.x},${i.y}`)
        .join(' ')
    );
    check(
      'Note laterali, stallo attivo e densità etichette inclusi nel file',
      Array.isArray(saved?.bays?.[0]?.notes) &&
        saved.bays[0].notes.length === 0 &&
        saved?.activeBayId === 'bay-1' &&
        saved?.labelDensity === 'all',
      `notes=${saved?.bays?.[0]?.notes?.length}, activeBayId=${saved?.activeBayId}, labelDensity=${saved?.labelDensity}`
    );
    check(
      'JSON leggibile e indentato (`JSON.stringify(project, null, 2)`)',
      raw.includes('\n  "version": 2') && raw.split('\n').length > 20,
      `${raw.split('\n').length} righe, ${raw.length} byte`
    );

    /* --- 3) Feedback temporaneo: si spegne da solo dopo 2 secondi -------- */
    await sleep(SAVE_FEEDBACK_MS + 400);
    const afterFeedback = await cdp.eval(SNAPSHOT);
    check(
      'Il feedback `Salvato!` si spegne da solo e l\'icona `Salva` torna a riposo',
      afterFeedback.saveLabel === 'Salva',
      `etichetta dopo ${SAVE_FEEDBACK_MS + 400} ms: "${afterFeedback.saveLabel}"`
    );

    /* --- 4) Apri Piano → ripristino completo dello stato ------------------ */
    const loaded = await loadProjectFile(
      cdp,
      'piano-esterno.json',
      JSON.stringify(FIXTURE_PROJECT, null, 2)
    );
    check(
      'Selettore file nativo: il file scelto è stato consegnato al campo (`change` fidato)',
      loaded === 1,
      `files.length = ${loaded}`
    );

    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-item]').length === 6 ? 1 : 0;`),
      4000,
      'ripristino dei 6 colli del piano aperto'
    );
    const restored = await cdp.eval(SNAPSHOT);

    check(
      'Piano aperto: i 6 colli del file sono in scena (codici e riepilogo allineati)',
      restored.itemCount === 6 &&
        restored.itemCodes.every((code) => code === 'INDU') &&
        restored.sidebarTotal === 6,
      `${restored.itemCount} colli ${restored.itemCodes.join(',')} · riepilogo ${restored.sidebarTotal}`
    );
    check(
      'Mezzo e targa ripristinati dal file',
      restored.plateInput === 'XZ999ZZ' && restored.plateText === 'XZ999ZZ',
      `input "${restored.plateInput}" · canvas "${restored.plateText}"`
    );
    check(
      'Nota laterale ripristinata sul pianale',
      restored.noteCount === 1,
      `${restored.noteCount} nota/e`
    );
    check(
      'Densità etichette ripristinata dal file (`minimal`) e applicata al canvas',
      restored.density === 'Minimal' &&
        restored.itemTexts.every((text) => text === ''),
      `HUD "${restored.density}", testi dei colli ${JSON.stringify(restored.itemTexts.slice(0, 2))}`
    );
    check(
      'Selezioni azzerate dopo l\'apertura (nessun pannello orfano)',
      restored.selectedPanel === false
    );

    /* --- 5) Undo dell\'apertura ------------------------------------------ */
    await pressUndo(cdp);
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-item]').length === 3 ? 1 : 0;`),
      4000,
      'undo dell\'apertura del piano'
    );
    const undone = await cdp.eval(SNAPSHOT);
    check(
      '`Ctrl + Z` annulla l\'apertura: tornano i 3 colli e la targa precedenti',
      undone.itemCount === 3 &&
        undone.itemCodes.join(',') === 'INDU,INDU,EUR' &&
        undone.plateInput === PLATE_SAVED &&
        undone.noteCount === 0,
      `${undone.itemCount} colli, targa "${undone.plateInput}", ${undone.noteCount} note`
    );
    check(
      'L\'apertura del piano è passata dalla cronologia Undo (`canUndo` attivo)',
      undone.canUndo === true
    );

    /* --- 6) File corrotto → alert amichevole e stato intatto -------------- */
    cdp.dialogs.length = 0;
    const corruptLoaded = await loadProjectFile(
      cdp,
      'piano-corrotto.json',
      JSON.stringify(CORRUPT_PROJECT)
    );
    const corruptDialog = await waitFor(
      async () => (cdp.dialogs.length > 0 ? cdp.dialogs[0] : null),
      4000,
      'alert di file non valido'
    ).catch(() => null);
    await sleep(250);
    const afterCorrupt = await cdp.eval(SNAPSHOT);

    check(
      'File senza campi minimi (`vehicle`/`items`/`notes`) → `alert` amichevole',
      corruptLoaded === 1 &&
        typeof corruptDialog === 'string' &&
        /Apertura del piano non riuscita/.test(corruptDialog) &&
        /manca la configurazione del mezzo/i.test(corruptDialog),
      `${(corruptDialog || '').split('\n').pop()}`
    );
    check(
      'File rifiutato: il pianale in scena resta invariato',
      afterCorrupt.itemCount === 3 && afterCorrupt.plateInput === PLATE_SAVED,
      `${afterCorrupt.itemCount} colli, targa "${afterCorrupt.plateInput}"`
    );

    /* --- 7) File JSON troncato → stesso trattamento ---------------------- */
    cdp.dialogs.length = 0;
    await loadProjectFile(cdp, 'piano-troncato.json', UNREADABLE_FILE_CONTENT);
    const brokenDialog = await waitFor(
      async () => (cdp.dialogs.length > 0 ? cdp.dialogs[0] : null),
      4000,
      'alert di JSON danneggiato'
    ).catch(() => null);
    const afterBroken = await cdp.eval(SNAPSHOT);
    check(
      'File JSON danneggiato → `alert` esplicito e pianale invariato',
      typeof brokenDialog === 'string' &&
        /danneggiato o illeggibile/i.test(brokenDialog) &&
        afterBroken.itemCount === 3,
      `${(brokenDialog || '').split('\n').pop()}`
    );

    /* --- 8) Piano storico v1 → auto-migrazione allo schema v2 ------------ */
    await loadProjectFile(
      cdp,
      'piano-storico-v1.json',
      JSON.stringify(LEGACY_V1_PROJECT, null, 2)
    );
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-item]').length === 3 ? 1 : 0;`),
      4000,
      'migrazione del piano storico v1'
    );
    const migrated = await cdp.eval(SNAPSHOT);
    check(
      'Piano storico v1 (campi piatti) migrato al volo: colli e targa in scena',
      migrated.itemCount === 3 &&
        migrated.itemCodes.every((code) => code === 'INDU') &&
        migrated.plateInput === 'STORICO1' &&
        migrated.sidebarTotal === 3,
      `${migrated.itemCount} colli, targa "${migrated.plateInput}"`
    );

    /* --- 9) Nessun errore in console ------------------------------------- */
    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    /* --- Evidenza grafica: barra comandi + pianale ripristinato ---------- */
    const shotDir = 'shots';
    mkdirSync(shotDir, { recursive: true });
    await loadProjectFile(cdp, 'piano-evidenza.json', JSON.stringify(FIXTURE_PROJECT, null, 2));
    await waitFor(
      async () => cdp.eval(`return document.querySelectorAll('[data-canvas-item]').length === 6 ? 1 : 0;`),
      4000,
      'piano di evidenza'
    );
    await sleep(250);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(
      join(shotDir, 'salva-apri-piano-json.png'),
      Buffer.from(shot.data, 'base64')
    );
    console.log('Evidenza grafica: shots/salva-apri-piano-json.png');

    console.log(`\n${passed}/${passed + failed} controlli superati`);
    console.log(
      `Durata della verifica: ${((Date.now() - startedAt) / 1000).toFixed(2)} s (limite 15 s)`
    );
    // Il file scaricato è l'evidenza del salvataggio: viene conservato in `tmp/`.
    console.log(`File salvato analizzato: ${downloadedPath}`);
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
