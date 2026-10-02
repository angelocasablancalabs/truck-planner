/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — SALVATAGGIO DIRETTO IN-PLACE (STILE EXCEL / WORD) &
 *  SOSTITUZIONE GLOBALE "2D" → "CAD"
 *
 *  Pilota Chrome reale via Chrome DevTools Protocol (zero dipendenze aggiunte)
 *  e verifica, end-to-end, il modulo `src/utils/fileStorage.ts` insieme alle
 *  scorciatoie e alla UI della sidebar:
 *
 *    1. **Rinomina**: `<title>` = `Truck Planner CAD`, sottotitolo della plancia
 *       `Gestione Carico CAD Vettoriale`, sottotitolo della scheda A4
 *       `Truck Planner CAD — data • ora`: nessuna occorrenza visiva di `2D`;
 *    2. **Unit** (modulo importato dal dev server): `saveProjectWithHandle` con
 *       handle esistente **sovrascrive in-place** (una `write` + una `close`,
 *       nessun download) e restituisce `{ handle, fileName, isNewFile: false }`;
 *       senza handle e con il selettore nativo **annullato** propaga l'`AbortError`;
 *       senza selettore nativo ricade sul **download classico**;
 *       `openProjectWithPicker` restituisce piano + handle + nome e, se
 *       l'operatore annulla, propaga l'`AbortError`;
 *    3. **End-to-end**: apertura con handle, `Ctrl + S` che **riscrive lo stesso
 *       file** (contenuto verificato) senza produrre alcun download e con la
 *       pagina che **non** apre il proprio salvataggio (`defaultPrevented`);
 *    4. **UI**: riga "File attivo" con nome e tooltip, feedback `Salvato!` per 2 s
 *       con il nome del file nel tooltip, tooltip a riposo `Salva modifiche (Ctrl / Cmd + S)`;
 *    5. **Annullamenti e distacco**: `AbortError` silenzioso su salva e apri,
 *       `Svuota` che stacca l'handle, fallback di download con nome file attivo.
 *
 *  Nota di metodo: Chrome headless **espone** la File System Access API ma non
 *  può mostrare le finestre di dialogo native (la promise non si risolve mai).
 *  Le due modalità native sono quindi pilotate con selettori **finti** installati
 *  nella pagina (`Object.defineProperty(window, …)`), mentre il salvataggio
 *  in-place usa un handle finto che registra ciò che l'applicazione gli scrive:
 *  è esattamente il percorso di codice di produzione (`createWritable` →
 *  `write` → `close`), senza dipendere da un dialogo di sistema.
 *
 *  Uso:  node scripts/verify-inplace-save.mjs [url]
 *  (default `http://localhost:5199/`: in questo ambiente il dev server Vite
 *  ascolta sul loopback IPv6, quindi `127.0.0.1` verrebbe rifiutato)
 *  Chiude sempre con `Browser.close()` + `process.exit(0)` entro 15 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://localhost:5199/';
/** Percorso del modulo sul dev server (prefissato con la `base` di Vite). */
const MODULE_URL = '/truck-planner/src/utils/fileStorage.ts';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9338);
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

/** Verde `green-600` di Tailwind v4 (feedback `Salvato!`), con il fallback RGB. */
const VERDE_600 = ['oklch(0.627 0.194 149.214)', 'rgb(22, 163, 74)'];
/** Durata del feedback verde sul pulsante di salvataggio (ms). */
const SAVE_FEEDBACK_MS = 2000;
/** Tooltip a riposo del pulsante di salvataggio. */
const SAVE_TITLE_IDLE = 'Salva modifiche (Ctrl / Cmd + S)';

/** Nome del file "agganciato" dai selettori finti (apertura e salvataggio). */
const FAKE_FILE_NAME = 'piano-piazzale.json';
/** Data ISO del giorno: entra in tutti i nomi file del modulo. */
const TODAY = new Date().toISOString().slice(0, 10);
/** Nome del file prodotto dal fallback a targa vuota (`piano-carico-<data>.json`). */
const FALLBACK_FILE_NAME = `piano-carico-${TODAY}.json`;
/** Mezzo di riferimento: bilico CC 250 × 1328 cm. */
const VEHICLE = { id: 'bilico_cc', name: 'Bilico frigo Fiori', width: 250, length: 1328 };
/** Bordo rigido di ogni collo (`ITEM_BORDER_COLOR`). */
const ITEM_BORDER_COLOR = '#334155';

/** Piano di carico usato come "file su disco" (3 colli, targa `XZ999ZZ`). */
const FIXTURE_PROJECT = {
  version: 1,
  app: 'truck-planner',
  timestamp: '2026-04-01T07:30:00.000Z',
  vehicle: VEHICLE,
  plate: 'XZ999ZZ',
  items: Array.from({ length: 3 }, (_, i) => ({
    id: `INDU_fixture_${i}`,
    code: 'INDU',
    name: i === 2 ? 'COOP' : 'PRODIVA',
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

/** Piano senza targa: serve al fallback di download del test unitario. */
const UNPLATED_PROJECT = { ...FIXTURE_PROJECT, plate: '' };
/** Targa riconoscibile del fallback unitario: identifica il file scaricato. */
const UNIT_FALLBACK_PLATE = 'UNIT9';
const UNIT_FALLBACK_PROJECT = { ...FIXTURE_PROJECT, plate: UNIT_FALLBACK_PLATE };
const UNIT_FALLBACK_FILE_NAME = `piano-${UNIT_FALLBACK_PLATE}-${TODAY}.json`;

let passed = 0;
let failed = 0;
let skipped = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};
/** Verifica non eseguibile in questo contesto (es. bundle di produzione). */
const skip = (name, detail = '') => {
  skipped += 1;
  console.log(`SKIP  ${name}${detail ? `  [${detail}]` : ''}`);
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
    /** Dialoghi nativi aperti dalla pagina (`confirm` di Svuota, `alert` di errore). */
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

/* --- Interazioni reali (gesture fidate) ----------------------------------- */

/** Click fisico sul centro di un elemento (`Input.dispatchMouseEvent`). */
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
  return box;
};

/**
 * `Ctrl + S` reale: la scorciatoia di salvataggio. Il focus resta dove si trova
 * (corpo della pagina o campo di scrittura) perché il listener globale di
 * `App.tsx` gestisce il salvataggio **anche** mentre si digita.
 */
const pressCtrlS = async (cdp) => {
  await cdp.send('Page.bringToFront').catch(() => {});
  const key = { key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, ...key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, ...key });
};

/** Scrittura in un input tramite il setter nativo (React 19 lo intercetta). */
const setTextInput = (cdp, id, value) =>
  cdp.eval(`
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return null;
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    desc.set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  `);

/* --- Sonda del `defaultPrevented` di Ctrl + S ------------------------------ */

/**
 * Registra se la scorciatoia `Ctrl + S` è stata **prevenuta** dal listener
 * globale dell'applicazione. La sonda conserva l'**evento stesso**: lo stato
 * finale di `defaultPrevented` viene letto dopo la propagazione completa, quindi
 * è indipendente dall'ordine di registrazione dei listener (che cambia quando
 * React ri-registra l'effetto delle scorciatoie).
 */
const installSaveProbe = (cdp) =>
  cdp.eval(`
    window.__ctrlS = { seen: 0, last: null };
    window.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        window.__ctrlS.seen += 1;
        window.__ctrlS.last = event;
      }
    });
    return 1;
  `);

/* --- Handle finto: registra ciò che l'applicazione gli scrive ------------- */

/**
 * Installa nella pagina un handle finto in stile File System Access API:
 * `getFile()` restituisce il "file su disco" (`content`), mentre `createWritable()`
 * raccoglie in `window.__writes` ogni `write` e ogni `close`, esattamente come
 * farebbe il file reale. È l'unico modo di osservare la sovrascrittura in-place
 * senza una finestra di dialogo nativa.
 */
const installFakeHandle = (cdp, fileName, content) =>
  cdp.eval(`
    window.__writes = [];
    // Il "file su disco" è il JSON serializzato, esattamente come lo scriverebbe
    // il modulo: il File costruito dal testo è leggibile da parseProjectFile.
    window.__fileContent = JSON.stringify(${JSON.stringify(content)}, null, 2);
    window.__fakeHandle = {
      kind: 'file',
      name: ${JSON.stringify(fileName)},
      async getFile() {
        return new File([window.__fileContent], this.name, { type: 'application/json' });
      },
      async createWritable() {
        const name = this.name;
        return {
          async write(data) { window.__writes.push({ name, data: String(data) }); },
          async close() { window.__writes.push({ name, closed: true }); },
        };
      },
    };
    return window.__fakeHandle.name;
  `);

/**
 * Sostituisce un selettore nativo con un doppio controllabile:
 * `handle` → restituisce l'handle finto; `abort` → `AbortError`;
 * `unsupported` → la proprietà sparisce (browser senza File System Access API).
 */
const shimPicker = (cdp, picker, mode) =>
  cdp.eval(`
    const name = ${JSON.stringify(picker)};
    const mode = ${JSON.stringify(mode)};
    const property = name === 'open' ? 'showOpenFilePicker' : 'showSaveFilePicker';
    let value;
    if (mode === 'handle') {
      value = async () => (name === 'open' ? [window.__fakeHandle] : window.__fakeHandle);
    } else if (mode === 'abort') {
      value = async () => { throw new DOMException('annullato', 'AbortError'); };
    } else {
      value = undefined;
    }
    Object.defineProperty(window, property, { configurable: true, writable: true, value });
    return typeof window[property];
  `);

/* --- Fotografia dello stato in scena -------------------------------------- */

const SNAPSHOT = `
  const deck = document.querySelector('.control-deck');
  const items = [...document.querySelectorAll('[data-canvas-item]')];
  const activeFile = document.getElementById('active-file-name');
  const saveBtn = document.getElementById('btn-save-project');
  const total = /(\\d+)\\s+Colli Totali/.exec(deck?.textContent || '');
  return {
    itemCount: items.length,
    sidebarTotal: total ? Number(total[1]) : -1,
    activeFileName: activeFile
      ? (activeFile.querySelector('span.font-semibold')?.textContent || '').trim()
      : null,
    activeFileTitle: activeFile ? activeFile.getAttribute('title') : null,
    activeFileClass: activeFile ? activeFile.className : null,
    saveLabel: saveBtn ? (saveBtn.querySelector('span')?.textContent || '').trim() : null,
    saveTitle: saveBtn ? saveBtn.getAttribute('title') : null,
    saveLabelColor: saveBtn ? getComputedStyle(saveBtn.querySelector('span')).color : null,
    plateInput: document.getElementById('vehicle-plate-input')?.value ?? null,
    writes: (window.__writes ?? []).length,
    ctrlS: window.__ctrlS
      ? {
          seen: window.__ctrlS.seen,
          defaultPrevented: window.__ctrlS.last ? window.__ctrlS.last.defaultPrevented : null,
        }
      : null,
  };
`;

/* --- Script ----------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();

  // Cartella di lavoro e download reali (fuori dal watcher Vite: `tmp/**`).
  const workDir = resolve('tmp', 'inplace-verify');
  const downloadDir = join(workDir, 'downloads');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(downloadDir, { recursive: true });

  /** File `.json` davvero scaricati dal browser (i `.crdownload` sono esclusi). */
  const downloadedJson = () =>
    existsSync(downloadDir)
      ? readdirSync(downloadDir).filter((f) => f.endsWith('.json'))
      : [];

  const profileDir = mkdtempSync(join(tmpdir(), 'inplace-profile-'));
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

    // Download automatici nella cartella di verifica (nessun prompt nativo).
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: true,
    });

    await cdp.send('Page.navigate', { url: DEV_URL });
    await waitFor(
      async () => cdp.eval(`return document.getElementById('btn-save-project') ? 1 : 0;`),
      10000,
      'mount della plancia di comando'
    );

    /* --- 1) SOSTITUZIONE "2D" → "CAD" -------------------------------------- */
    const branding = await cdp.eval(`
      const deck = document.querySelector('.control-deck');
      const subtitle = deck.querySelector('h1 + p');
      const printSubtitle = document.querySelector('#print-report header p');
      return {
        title: document.title,
        subtitle: subtitle ? subtitle.textContent.trim() : null,
        subtitleClass: subtitle ? subtitle.className : null,
        printSubtitle: printSubtitle ? printSubtitle.textContent.trim() : null,
        screenText: (document.getElementById('screen-app')?.textContent || ''),
        printText: (document.getElementById('print-report')?.textContent || ''),
      };
    `);

    check(
      '`<title>` della pagina: `Truck Planner CAD`',
      branding.title === 'Truck Planner CAD',
      `"${branding.title}"`
    );
    check(
      'Sottotitolo della plancia: `Gestione Carico CAD Vettoriale`',
      branding.subtitle === 'Gestione Carico CAD Vettoriale' &&
        branding.subtitleClass.includes('text-xs') &&
        branding.subtitleClass.includes('text-slate-500'),
      `"${branding.subtitle}"`
    );
    check(
      'Sottotitolo della scheda A4: `Truck Planner CAD — data • ora`',
      /^Truck Planner CAD — \d{2}\/\d{2}\/\d{4} • \d{2}:\d{2}$/.test(branding.printSubtitle || ''),
      `"${branding.printSubtitle}"`
    );
    check(
      'Nessuna occorrenza visiva di `2D` in plancia e in scheda',
      !branding.screenText.includes('2D') && !branding.printText.includes('2D'),
      `plancia ${branding.screenText.split('2D').length - 1} · scheda ${branding.printText.split('2D').length - 1}`
    );

    // Il popover delle scorciatoie documenta la nuova scorciatoia di salvataggio.
    const shortcuts = await cdp.eval(`
      const rows = [...document.querySelectorAll('.control-deck .group .absolute kbd')];
      const labels = [...document.querySelectorAll('.control-deck .group .absolute > div')]
        .map((row) => row.textContent.trim());
      return {
        kbdCount: rows.length,
        hasSaveKey: rows.some((k) => k.textContent.trim() === 'Ctrl / Cmd + S'),
        hasSaveRow: labels.some((text) => text.startsWith('Salva Piano (in-place)')),
      };
    `);
    check(
      'Popover delle scorciatoie: nuova voce `Salva Piano (in-place)` → `Ctrl / Cmd + S`',
      shortcuts.hasSaveKey === true && shortcuts.hasSaveRow === true,
      `${shortcuts.kbdCount} tasti · voce presente=${shortcuts.hasSaveRow}`
    );

    /* --- 2) UNIT: il modulo `fileStorage.ts` ------------------------------ */
    await installFakeHandle(cdp, FAKE_FILE_NAME, FIXTURE_PROJECT);
    /*
     * Il modulo **sorgente** è importabile solo dal dev server: sul bundle di
     * produzione (minificato e senza `src/`) le verifiche unitarie vengono
     * saltate e resta la parte end-to-end, che è quella che l'operatore vede.
     */
    const moduleAvailable = await cdp.eval(`
      try { await import(${JSON.stringify(MODULE_URL)}); return true; } catch { return false; }
    `);
    const unit = moduleAvailable
      ? await cdp.eval(`
      const mod = await import(${JSON.stringify(MODULE_URL)});
      const fixture = ${JSON.stringify(FIXTURE_PROJECT)};
      const unplated = ${JSON.stringify(UNPLATED_PROJECT)};
      const unitFallback = ${JSON.stringify(UNIT_FALLBACK_PROJECT)};
      const out = { supported: mod.isFileSystemAccessSupported() };

      // Selettore di salvataggio nativo "finto": restituisce il nuovo handle.
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true, writable: true,
        value: async () => window.__fakeHandle,
      });

      // (a) SOVRASCRITTURA IN-PLACE con handle esistente.
      window.__writes = [];
      await mod.saveProjectWithHandle(fixture, window.__fakeHandle);
      out.inPlace = {
        writes: window.__writes.length,
        write: window.__writes[0] ?? null,
        closed: window.__writes[1]?.closed === true,
      };

      // (b) FILE NUOVO con selettore nativo → nuovo handle adottato.
      const created = await mod.saveProjectWithHandle(unplated);
      out.newHandle = {
        isNewFile: created.isNewFile,
        fileName: created.fileName,
        hasHandle: created.handle !== null,
      };

      // (c) Annullamento del selettore di salvataggio → AbortError propagato.
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true, writable: true,
        value: async () => { throw new DOMException('annullato', 'AbortError'); },
      });
      try {
        await mod.saveProjectWithHandle(unplated);
        out.abortSave = 'nessun-errore';
      } catch (error) {
        out.abortSave = error?.name ?? 'errore-sconosciuto';
        out.abortSaveRecognised = mod.isPickerAbortError(error);
      }

      // (d) Browser senza selettore nativo → fallback di download.
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true, writable: true, value: undefined,
      });
      const fallback = await mod.saveProjectWithHandle(unitFallback);
      out.fallback = {
        handleIsNull: fallback.handle === null,
        fileName: fallback.fileName,
        isNewFile: fallback.isNewFile,
      };

      // (e) Apertura con selettore nativo → piano + handle + nome.
      Object.defineProperty(window, 'showOpenFilePicker', {
        configurable: true, writable: true,
        value: async () => [window.__fakeHandle],
      });
      const opened = await mod.openProjectWithPicker();
      out.open = {
        items: opened.project.items.length,
        plate: opened.project.plate,
        fileName: opened.fileName,
        handleName: opened.handle?.name ?? null,
      };

      // (f) Annullamento del selettore di apertura → AbortError propagato.
      Object.defineProperty(window, 'showOpenFilePicker', {
        configurable: true, writable: true,
        value: async () => { throw new DOMException('annullato', 'AbortError'); },
      });
      try {
        await mod.openProjectWithPicker();
        out.abortOpen = 'nessun-errore';
      } catch (error) {
        out.abortOpen = error?.name ?? 'errore-sconosciuto';
      }
      return out;
    `)
      : null;

    if (!unit) {
      // Bundle di produzione: i moduli sorgente non esistono, restano le prove end-to-end.
      [
        'Supporto nativo rilevato nella pagina di prova (`isFileSystemAccessSupported`)',
        '`saveProjectWithHandle` con handle esistente: UNA `write` + UNA `close` (sovrascrittura in-place)',
        'Contenuto scritto: JSON indentato con firma, mezzo, targa e 3 colli del piano',
        'File nuovo con selettore nativo: `isNewFile: true`, nome del file e handle adottato',
        'Selettore di salvataggio annullato → `AbortError` riconosciuto (`isPickerAbortError`)',
        'Browser senza selettori nativi → fallback: handle `null`, nome file ufficiale, `isNewFile: true`',
        '`openProjectWithPicker`: piano convalidato, handle e nome del file restituiti',
        'Selettore di apertura annullato → `AbortError` propagato (uscita silenziosa)',
        'Valore di ritorno in-place: handle invariato, nome del file e `isNewFile: false`',
      ].forEach((name) => skip(name, 'modulo sorgente non disponibile: verifiche unit sul dev server'));
    } else {
      const inPlaceWrite = unit.inPlace?.write ?? {};
      const inPlaceJson = (() => {
        try {
          return JSON.parse(inPlaceWrite.data ?? '');
        } catch {
          return null;
        }
      })();

      check(
        'Supporto nativo rilevato nella pagina di prova (`isFileSystemAccessSupported`)',
        unit.supported === true,
        `supportato=${unit.supported}`
      );
      check(
        '`saveProjectWithHandle` con handle esistente: UNA `write` + UNA `close` (sovrascrittura in-place)',
        unit.inPlace?.writes === 2 &&
          unit.inPlace?.closed === true &&
          inPlaceWrite.name === FAKE_FILE_NAME,
        `${unit.inPlace?.writes} operazioni sull'handle "${inPlaceWrite.name}"`
      );
      check(
        'Contenuto scritto: JSON indentato con firma, mezzo, targa e 3 colli del piano',
        inPlaceJson?.version === 1 &&
          inPlaceJson?.app === 'truck-planner' &&
          inPlaceJson?.vehicle?.id === 'bilico_cc' &&
          inPlaceJson?.plate === 'XZ999ZZ' &&
          inPlaceJson?.items?.length === 3 &&
          (inPlaceWrite.data ?? '').includes('\n  "version": 1'),
        `${inPlaceJson?.items?.length} colli, ${(inPlaceWrite.data ?? '').length} byte`
      );
      check(
        'File nuovo con selettore nativo: `isNewFile: true`, nome del file e handle adottato',
        unit.newHandle?.isNewFile === true &&
          unit.newHandle?.fileName === FAKE_FILE_NAME &&
          unit.newHandle?.hasHandle === true,
        `nome="${unit.newHandle?.fileName}", nuovo=${unit.newHandle?.isNewFile}, handle=${unit.newHandle?.hasHandle}`
      );
      check(
        'Selettore di salvataggio annullato → `AbortError` riconosciuto (`isPickerAbortError`)',
        unit.abortSave === 'AbortError' && unit.abortSaveRecognised === true,
        `${unit.abortSave} / riconosciuto=${unit.abortSaveRecognised}`
      );
      check(
        'Browser senza selettori nativi → fallback: handle `null`, nome file ufficiale, `isNewFile: true`',
        unit.fallback?.handleIsNull === true &&
          unit.fallback?.fileName === UNIT_FALLBACK_FILE_NAME &&
          unit.fallback?.isNewFile === true,
        `"${unit.fallback?.fileName}" (atteso ${UNIT_FALLBACK_FILE_NAME})`
      );
      check(
        '`openProjectWithPicker`: piano convalidato, handle e nome del file restituiti',
        unit.open?.items === 3 &&
          unit.open?.plate === 'XZ999ZZ' &&
          unit.open?.fileName === FAKE_FILE_NAME &&
          unit.open?.handleName === FAKE_FILE_NAME,
        `${unit.open?.items} colli, targa ${unit.open?.plate}, file "${unit.open?.fileName}"`
      );
      check(
        'Selettore di apertura annullato → `AbortError` propagato (uscita silenziosa)',
        unit.abortOpen === 'AbortError',
        unit.abortOpen
      );

      /* Emulazione della sovrascrittura in-place: identità dell'handle esistente. */
      const inPlaceReturn = await cdp.eval(`
        const mod = await import(${JSON.stringify(MODULE_URL)});
        window.__writes = [];
        const result = await mod.saveProjectWithHandle(
          ${JSON.stringify(FIXTURE_PROJECT)},
          window.__fakeHandle
        );
        return {
          sameHandle: result.handle === window.__fakeHandle,
          fileName: result.fileName,
          isNewFile: result.isNewFile,
        };
      `);
      check(
        'Valore di ritorno in-place: handle invariato, nome del file e `isNewFile: false`',
        inPlaceReturn.sameHandle === true &&
          inPlaceReturn.fileName === FAKE_FILE_NAME &&
          inPlaceReturn.isNewFile === false,
        `handle=${inPlaceReturn.sameHandle}, nome="${inPlaceReturn.fileName}", nuovo=${inPlaceReturn.isNewFile}`
      );
    }

    /* --- 3) END-TO-END: apri con handle, poi Ctrl + S in-place ------------- */
    // Carico di partenza: 1 PLT INDU, così l'apertura del file lo sostituisce.
    await clickElement(cdp, 'quick-piatto-INDU');
    await waitFor(
      async () =>
        cdp.eval(`return document.querySelectorAll('[data-canvas-item]').length === 1 ? 1 : 0;`),
      4000,
      'primo collo in scena'
    );

    await installFakeHandle(cdp, FAKE_FILE_NAME, FIXTURE_PROJECT);
    await shimPicker(cdp, 'open', 'handle');
    await clickElement(cdp, 'btn-open-project');
    await waitFor(
      async () =>
        cdp.eval(`return document.querySelectorAll('[data-canvas-item]').length === 3 ? 1 : 0;`),
      5000,
      'piano aperto dal selettore nativo'
    );
    const afterOpen = await cdp.eval(SNAPSHOT);

    check(
      'Apertura con handle nativo: il piano del file è in scena (3 colli) e la targa è quella del file',
      afterOpen.itemCount === 3 &&
        afterOpen.sidebarTotal === 3 &&
        afterOpen.plateInput === 'XZ999ZZ',
      `${afterOpen.itemCount} colli, targa "${afterOpen.plateInput}"`
    );
    check(
      'Riga "File attivo" in sidebar: nome del file e tooltip dedicato',
      afterOpen.activeFileName === FAKE_FILE_NAME &&
        afterOpen.activeFileTitle === `File attivo: ${FAKE_FILE_NAME}`,
      `"${afterOpen.activeFileName}" · "${afterOpen.activeFileTitle}"`
    );
    check(
      'Stile discreto richiesto per la riga del file attivo (`text-[10px]`, mono, truncate)',
      [
        'text-[10px]',
        'text-slate-500',
        'font-mono',
        'flex',
        'items-center',
        'gap-1',
        'mt-1',
        'truncate',
      ].every((cls) => (afterOpen.activeFileClass || '').split(/\s+/).includes(cls)),
      afterOpen.activeFileClass
    );
    check(
      'Tooltip a riposo del pulsante: `Salva modifiche (Ctrl / Cmd + S)`',
      afterOpen.saveTitle === SAVE_TITLE_IDLE && afterOpen.saveLabel === 'Salva Piano',
      `"${afterOpen.saveLabel}" · "${afterOpen.saveTitle}"`
    );

    // Evidenza grafica (primo piano 2×): la riga del file attivo sotto i pulsanti.
    mkdirSync('shots', { recursive: true });
    const deckClip = await cdp.eval(`
      const save = document.getElementById('btn-save-project').getBoundingClientRect();
      const open = document.getElementById('btn-open-project').getBoundingClientRect();
      const file = document.getElementById('active-file-name').getBoundingClientRect();
      const left = Math.min(save.left, open.left, file.left) - 12;
      const top = Math.min(save.top, open.top) - 12;
      const right = Math.max(save.right, open.right, file.right) + 12;
      const bottom = Math.max(file.bottom) + 12;
      return { x: left, y: top, width: right - left, height: bottom - top };
    `);
    const closeUp = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...deckClip, scale: 2 },
    });
    writeFileSync(
      join('shots', 'salvataggio-in-place-file-attivo.png'),
      Buffer.from(closeUp.data, 'base64')
    );
    console.log('Evidenza grafica: shots/salvataggio-in-place-file-attivo.png');

    // Il piano cambia DOPO l'apertura: il file su disco deve seguire lo stato vivo.
    await clickElement(cdp, 'quick-piatto-EUR');
    await waitFor(
      async () =>
        cdp.eval(`return document.querySelectorAll('[data-canvas-item]').length === 4 ? 1 : 0;`),
      4000,
      'quarto collo in scena'
    );
    await cdp.eval(`window.__writes = []; return 1;`);
    const downloadsBeforeCtrlS = downloadedJson().length;
    await installSaveProbe(cdp);
    await pressCtrlS(cdp);
    await waitFor(
      async () => cdp.eval(`return (window.__writes ?? []).length >= 2 ? 1 : 0;`),
      5000,
      'sovrascrittura in-place del file attivo'
    );

    const afterCtrlS = await cdp.eval(SNAPSHOT);
    const savedJson = await cdp.eval(`
      const write = (window.__writes ?? []).find((w) => typeof w.data === 'string');
      try { return write ? JSON.parse(write.data) : null; } catch { return null; }
    `);
    const downloadsAfterCtrlS = downloadedJson();
    // Il feedback verde arriva con il render successivo alla promise di salvataggio.
    const feedback = await waitFor(
      async () => {
        const current = await cdp.eval(SNAPSHOT);
        return current.saveLabel === 'Salvato!' ? current : null;
      },
      3000,
      'feedback `Salvato!`'
    ).catch(() => afterCtrlS);

    check(
      '`Ctrl + S` è intercettato e il salvataggio pagina del browser è prevenuto (`defaultPrevented`)',
      afterCtrlS.ctrlS?.seen === 1 && afterCtrlS.ctrlS?.defaultPrevented === true,
      `eventi=${afterCtrlS.ctrlS?.seen}, defaultPrevented=${afterCtrlS.ctrlS?.defaultPrevented}`
    );
    check(
      '`Ctrl + S` riscrive lo STESSO file (write + close sull\'handle attivo) con lo stato vivo',
      afterCtrlS.writes === 2 &&
        savedJson !== null &&
        savedJson.items.length === 4 &&
        savedJson.plate === 'XZ999ZZ' &&
        savedJson.vehicle.id === 'bilico_cc',
      `${afterCtrlS.writes} operazioni, ${savedJson?.items?.length} colli nel file`
    );
    check(
      'Sovrascrittura in-place: NESSUN download prodotto nella cartella Download',
      downloadsAfterCtrlS.length === downloadsBeforeCtrlS,
      `${downloadsBeforeCtrlS} → ${downloadsAfterCtrlS.length} file scaricati`
    );
    check(
      'Feedback `Salvato!` in verde con il nome del file salvato nel tooltip',
      feedback.saveLabel === 'Salvato!' &&
        VERDE_600.includes(feedback.saveLabelColor) &&
        feedback.saveTitle === `File salvato: ${FAKE_FILE_NAME}`,
      `"${feedback.saveLabel}" · "${feedback.saveTitle}"`
    );

    // Evidenza grafica: file attivo agganciato + feedback di salvataggio.
    // Un attimo di respiro perché il compositor abbia disegnato il feedback verde.
    await sleep(250);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(
      join('shots', 'salvataggio-in-place-ctrl-s.png'),
      Buffer.from(shot.data, 'base64')
    );
    console.log('Evidenza grafica: shots/salvataggio-in-place-ctrl-s.png');

    /* --- 4) `Ctrl + S` mentre si digita (targa) --------------------------- */
    const typedPlate = await setTextInput(cdp, 'vehicle-plate-input', 'XA111NJ');
    await cdp.eval(
      `window.__writes = []; window.__ctrlS = { seen: 0, last: null }; return 1;`
    );
    await cdp.eval(`document.getElementById('vehicle-plate-input').focus(); return 1;`);
    await pressCtrlS(cdp);
    await waitFor(
      async () => cdp.eval(`return (window.__writes ?? []).length >= 2 ? 1 : 0;`),
      5000,
      'salvataggio con il focus nel campo di scrittura'
    );
    const whileTyping = await cdp.eval(`
      const write = (window.__writes ?? []).find((w) => typeof w.data === 'string');
      return {
        writes: (window.__writes ?? []).length,
        seen: window.__ctrlS?.seen ?? null,
        defaultPrevented: window.__ctrlS?.last ? window.__ctrlS.last.defaultPrevented : null,
        plate: document.getElementById('vehicle-plate-input').value,
        savedPlate: write ? JSON.parse(write.data).plate : null,
      };
    `);
    check(
      '`Ctrl + S` salva in-place anche con il focus in un campo (nessun salvataggio pagina)',
      typedPlate === 'XA111NJ' &&
        whileTyping.writes === 2 &&
        whileTyping.defaultPrevented === true &&
        whileTyping.plate === 'XA111NJ' &&
        whileTyping.savedPlate === 'XA111NJ',
      `targhe: ${typedPlate}/${whileTyping.plate}/${whileTyping.savedPlate} · scritture=${whileTyping.writes} · eventi=${whileTyping.seen} · defaultPrevented=${whileTyping.defaultPrevented}`
    );

    /* --- 5) Il feedback si spegne da solo --------------------------------- */
    await sleep(SAVE_FEEDBACK_MS + 500);
    const afterFeedback = await cdp.eval(SNAPSHOT);
    check(
      'Il feedback `Salvato!` si spegne dopo 2 s e il tooltip torna quello a riposo',
      afterFeedback.saveLabel === 'Salva Piano' && afterFeedback.saveTitle === SAVE_TITLE_IDLE,
      `"${afterFeedback.saveLabel}" · "${afterFeedback.saveTitle}"`
    );

    /* --- 6) `Svuota` stacca l'handle del file attivo ---------------------- */
    cdp.dialogs.length = 0;
    await clickElement(cdp, 'btn-clear-all');
    await waitFor(
      async () =>
        cdp.eval(`return document.querySelectorAll('[data-canvas-item]').length === 0 ? 1 : 0;`),
      4000,
      'svuotamento del pianale'
    );
    const afterClear = await cdp.eval(SNAPSHOT);
    check(
      '`Svuota` azzera il pianale e stacca il file attivo (nessuna riga "File attivo")',
      afterClear.itemCount === 0 && afterClear.activeFileName === null,
      `${afterClear.itemCount} colli · file attivo ${afterClear.activeFileName}`
    );

    /* --- 7) Annullamenti silenziosi del selettore nativo ------------------ */
    await shimPicker(cdp, 'save', 'abort');
    await cdp.eval(`window.__writes = []; return 1;`);
    cdp.dialogs.length = 0;
    const downloadsBeforeAbort = downloadedJson().length;
    await clickElement(cdp, 'btn-save-project');
    await sleep(400);
    const afterAbortSave = await cdp.eval(SNAPSHOT);
    check(
      'Salvataggio annullato dal pulsante: nessun feedback, nessuna scrittura, nessun download',
      afterAbortSave.writes === 0 &&
        afterAbortSave.saveLabel === 'Salva Piano' &&
        afterAbortSave.activeFileName === null &&
        downloadedJson().length === downloadsBeforeAbort &&
        cdp.dialogs.length === 0,
      `scritture=${afterAbortSave.writes}, download=${downloadedJson().length}, dialoghi=${cdp.dialogs.length}`
    );

    await shimPicker(cdp, 'open', 'abort');
    cdp.dialogs.length = 0;
    await clickElement(cdp, 'btn-open-project');
    await sleep(400);
    const afterAbortOpen = await cdp.eval(SNAPSHOT);
    check(
      'Apertura annullata: nessun `alert` e pianale invariato',
      afterAbortOpen.itemCount === 0 &&
        afterAbortOpen.activeFileName === null &&
        cdp.dialogs.length === 0,
      `${afterAbortOpen.itemCount} colli, dialoghi=${cdp.dialogs.length}`
    );

    /* --- 8) Fallback trasparente: download classico ----------------------- */
    // Targa svuotata: il nome del file torna quello neutro `piano-carico-<data>.json`.
    await setTextInput(cdp, 'vehicle-plate-input', '');
    await sleep(150);
    await shimPicker(cdp, 'save', 'unsupported');
    await cdp.eval(`window.__writes = []; return 1;`);
    await clickElement(cdp, 'btn-save-project');
    const fallbackDownloads = await waitFor(
      () => {
        const files = downloadedJson();
        return files.length > downloadsBeforeAbort ? files : null;
      },
      6000,
      'download di fallback'
    ).catch(() => null);
    const afterFallback = await cdp.eval(SNAPSHOT);

    check(
      'Browser senza File System Access API: il salvataggio ricade sul download classico',
      fallbackDownloads !== null && fallbackDownloads.length === downloadsBeforeAbort + 1,
      `${fallbackDownloads?.length ?? 0} file (atteso ${downloadsBeforeAbort + 1})`
    );
    check(
      'Dopo il fallback il nome del file scaricato diventa il "File attivo" in sidebar',
      afterFallback.activeFileName === FALLBACK_FILE_NAME && afterFallback.saveLabel === 'Salvato!',
      `"${afterFallback.activeFileName}" · "${afterFallback.saveLabel}"`
    );

    /* --- 9) Contenuto dei file scaricati ---------------------------------- */
    await sleep(500);
    const savedFiles = downloadedJson().map((name) => ({
      name,
      json: (() => {
        try {
          return JSON.parse(readFileSync(join(downloadDir, name), 'utf8'));
        } catch {
          return null;
        }
      })(),
    }));
    const unitFile = savedFiles.find((f) => f.json?.plate === UNIT_FALLBACK_PLATE);
    const emptyFile = savedFiles.find((f) => f.json?.items?.length === 0);
    if (unit) {
      check(
        'Fallback del test unitario: file `piano-UNIT9-<data>.json` con i 3 colli del piano',
        unitFile !== undefined &&
          unitFile.name === UNIT_FALLBACK_FILE_NAME &&
          unitFile.json.items.length === 3,
        `${unitFile?.name} · ${unitFile?.json?.items?.length} colli`
      );
    } else {
      skip(
        'Fallback del test unitario: file `piano-UNIT9-<data>.json` con i 3 colli del piano',
        'modulo sorgente non disponibile: verifiche unit sul dev server'
      );
    }
    check(
      'Fallback end-to-end: `piano-carico-<data>.json` con il pianale svuotato (0 colli)',
      emptyFile !== undefined &&
        emptyFile.name === FALLBACK_FILE_NAME &&
        emptyFile.json.items.length === 0,
      `${emptyFile?.name} · ${emptyFile?.json?.items?.length} colli`
    );

    /* --- 10) Console pulita ---------------------------------------------- */
    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    console.log(
      `\n${passed}/${passed + failed} controlli superati${skipped > 0 ? ` (${skipped} saltati: modulo sorgente non disponibile)` : ''}`
    );
    console.log(
      `Durata della verifica: ${((Date.now() - startedAt) / 1000).toFixed(2)} s (limite 15 s)`
    );
    console.log(`Download analizzati in: ${downloadDir}`);
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
