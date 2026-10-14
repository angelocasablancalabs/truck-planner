/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — PULSANTE "NUOVO" + PROTEZIONE ANTIPANICO
 *
 *  Pilota Chrome reale via Chrome DevTools Protocol (zero dipendenze aggiunte)
 *  e prova end-to-end il pulsante `Nuovo` dell'header e la rete di sicurezza
 *  contro la perdita accidentale dei dati:
 *
 *    1. **Posizione del pulsante**: `#btn-new-project` vive nell'header in alto
 *       a destra, con il bordo destro **allineato alla terza colonna** della
 *       toolbar e la stessa altezza (36 px) dei pulsanti della toolbar;
 *    2. **Nuovo con modifiche non salvate + conferma negata** → il pianale resta
 *       intatto (colli, targa, mezzo) e il messaggio di conferma è quello
 *       dedicato al nuovo piano;
 *    3. **Nuovo con conferma accettata** → reset totale: zero colli, targa
 *       sbiancata, mezzo di fabbrica (Bilico CC 250 × 1328), nessun file attivo,
 *       Undo / Redo azzerati;
 *    4. **Apri Piano con conferma negata** → il selettore nativo **non viene
 *       nemmeno aperto** (`showOpenFilePicker` mai invocato) e il piano resta;
 *    5. **Apri Piano con conferma accettata** → il selettore si apre e il piano
 *       scelto entra in scena (badge del file attivo);
 *    6. **"Svuota"** → azzera colli **e** note laterali, mentre mezzo e targa
 *       restano quelli del file appena aperto;
 *    7. nessuna eccezione runtime in pagina.
 *
 *  Uso:  node scripts/verify-new-project-guard.mjs [url]
 *
 *  Prerequisiti: dev server Vite attivo (default `http://localhost:5173/truck-planner/`)
 *  e Google Chrome installato (override con `CHROME_PATH`).
 *
 *  Chiude sempre con `Browser.close()` + `process.exit(...)` entro 60 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://localhost:5173/truck-planner/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9351);
const WATCHDOG_MS = 60000;
const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** Client CDP minimale (WebSocket nativo di Node 22+). */
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
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(msg.params.exceptionDetails?.text ?? 'eccezione');
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // Timeout per singola richiesta: senza di esso una risposta mai arrivata
      // (target chiuso, pagina bloccata) lascerebbe il test appeso al watchdog.
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout CDP su ${method}`));
      }, 10000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Valuta un'espressione nella pagina e ne restituisce il valore serializzato. */
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? 'errore di valutazione';
      throw new Error(`${detail} — espressione: ${expression.trim().slice(0, 200)}`);
    }
    return result.result.value;
  }
}

const HTTP_TIMEOUT_MS = 20000;

const waitForDevServer = async () => {
  const deadline = Date.now() + HTTP_TIMEOUT_MS;
  for (;;) {
    try {
      const res = await fetch(DEV_URL);
      if (res.ok) return;
    } catch {
      /* dev server non ancora pronto */
    }
    if (Date.now() > deadline) throw new Error(`dev server non raggiungibile su ${DEV_URL}`);
    await sleep(250);
  }
};

const waitForDebugPort = async () => {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return;
    } catch {
      /* porta non ancora aperta */
    }
    if (Date.now() > deadline) throw new Error('porta di debug Chrome non disponibile');
    await sleep(200);
  }
};

/**
 * Installa un `window.confirm` pilotato: registra i messaggi mostrati e risponde
 * sempre con `answer`. È l'unico modo di provare in headless le due diramazioni
 * della protezione antipanico (conferma accettata / negata).
 */
const installConfirmStub = async (cdp, answer) => {
  await cdp.eval(`
    window.__confirmMessages = [];
    window.__confirmAnswer = ${answer ? 'true' : 'false'};
    window.confirm = (message) => {
      window.__confirmMessages.push(String(message));
      return window.__confirmAnswer;
    };
    // Lettura robusta del preset mezzo attivo: la plancia è la **seconda** colonna
    // del layout, quindi il suo campo di selezione non è il primo del DOM.
    window.__readVehicleId = () => {
      const select = [...document.querySelectorAll('select')].find((s) =>
        [...s.options].some((o) => o.value === 'bilico_cc')
      );
      return select ? select.value : null;
    };
    return true;
  `);
};

/** Click fidato (`Input.dispatchMouseEvent`) su un elemento per id. */
const clickButton = async (cdp, id) => {
  const box = await cdp.eval(`
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `);
  if (!box) throw new Error(`pulsante \`${id}\` non trovato`);
  const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
};

/** Aggiunge un collo INDU al pianale con un click fidato. */
const clickPalletQuickPunta = async (cdp) => {
  const box = await cdp.eval(`
    const el = document.getElementById('quick-punta-INDU');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  `);
  if (!box) throw new Error('pulsante rapido `quick-punta-INDU` non trovato');
  const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
};

/** Scatta la fotografia dello stato osservabile del piano in scena. */
const readState = (cdp) =>
  cdp.eval(`
    const plateInput = document.querySelector('input[type="text"][maxlength]');
    return {
      items: document.querySelectorAll('[data-canvas-item]').length,
      notes: document.querySelectorAll('[data-canvas-note]').length,
      plate: plateInput ? plateInput.value : null,
      activeFile: document.getElementById('active-file-badge')?.textContent?.trim() ?? null,
      undoDisabled: document.getElementById('btn-undo')?.disabled ?? null,
      redoDisabled: document.getElementById('btn-redo')?.disabled ?? null,
      confirms: window.__confirmMessages.slice(),
    };
  `);

/** Digita la targa nel campo della sidebar con eventi nativi fidati. */
const typePlate = async (cdp, value) => {
  await cdp.eval(`
    const input = document.querySelector('input[type="text"][maxlength]');
    if (!input) return null;
    input.focus();
    input.select();
    return input.value;
  `);
  await cdp.send('Input.insertText', { text: value });
  await cdp.eval(`document.activeElement.blur(); return true;`);
  await sleep(120);
};

/** Consegna un file di progetto reale al campo `<input type="file">` nascosto. */
const injectProjectFile = async (cdp, filePath) => {
  const doc = await cdp.send('DOM.getDocument', { depth: 1 });
  const node = await cdp.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: '#project-file-input',
  });
  if (!node.nodeId) throw new Error('campo `#project-file-input` non trovato');
  await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [filePath] });
};

const main = async () => {
  await waitForDevServer();

  const profileDir = mkdtempSync(join(tmpdir(), 'nuovo-piano-profile-'));
  const chrome = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1600,1000',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let cdp = null;
  let exitCode = 1;

  const watchdog = setTimeout(async () => {
    console.error('WATCHDOG: tempo scaduto, chiusura forzata del browser.');
    try {
      chrome.kill();
    } catch {
      /* già terminato */
    }
    process.exit(1);
  }, WATCHDOG_MS);

  try {
    await waitForDebugPort();
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('nessun target di tipo `page` disponibile');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket CDP non apribile')), {
        once: true,
      });
    });
    cdp = new Cdp(ws);

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('DOM.enable');
    const loadFired = new Promise((resolve) => {
      const onMessage = (event) => {
        if (JSON.parse(event.data).method === 'Page.loadEventFired') {
          ws.removeEventListener('message', onMessage);
          resolve();
        }
      };
      ws.addEventListener('message', onMessage);
    });
    await cdp.send('Page.navigate', { url: DEV_URL });
    await loadFired;

    // Attesa del mount: il pulsante `Nuovo` e il catalogo sono i riferimenti stabili.
    const deadlineMount = Date.now() + 10000;
    for (;;) {
      const ready = await cdp.eval(
        `return Boolean(document.getElementById('btn-new-project') && document.getElementById('quick-punta-INDU'));`
      );
      if (ready) break;
      if (Date.now() > deadlineMount) {
        const dump = await cdp.eval(
          `return { url: location.href, title: document.title, readyState: document.readyState };`
        );
        throw new Error(`plancia non montata entro 10 s: ${JSON.stringify(dump)}`);
      }
      await sleep(150);
    }
    await sleep(200);

    /* --- 1) Il pulsante "Nuovo" esiste ed è in alto a destra -------------- */
    const geometry = await cdp.eval(`
      const nuovo = document.getElementById('btn-new-project');
      const terzaColonna = document.getElementById('btn-print-report');
      const toolbar = document.getElementById('btn-copy-image').parentElement;
      if (!nuovo || !terzaColonna || !toolbar) return null;
      const n = nuovo.getBoundingClientRect();
      const c = terzaColonna.getBoundingClientRect();
      const t = toolbar.getBoundingClientRect();
      return {
        label: nuovo.textContent.trim(),
        hasIcon: Boolean(nuovo.querySelector('svg')),
        title: nuovo.getAttribute('title'),
        right: Math.round(n.right),
        columnRight: Math.round(c.right),
        height: Math.round(n.height),
        columnHeight: Math.round(c.height),
        bottom: Math.round(n.bottom),
        toolbarTop: Math.round(t.top),
        id: nuovo.id,
      };
    `);
    check('Pulsante `Nuovo` presente nell\'header della plancia', geometry !== null);
    if (!geometry) throw new Error('pulsante `#btn-new-project` non trovato');

    check(
      'Etichetta "Nuovo" con icona `FilePlus` della stessa taglia della toolbar',
      geometry.label === 'Nuovo' && geometry.hasIcon === true,
      `etichetta="${geometry.label}", icona=${geometry.hasIcon}`
    );
    check(
      'Bordo destro allineato alla terza colonna della toolbar',
      Math.abs(geometry.right - geometry.columnRight) <= 2,
      `nuovo.right=${geometry.right}, terzaColonna.right=${geometry.columnRight}`
    );
    check(
      'Altezza 36 px (h-9) come i pulsanti della toolbar',
      geometry.height === 36 && geometry.height === geometry.columnHeight,
      `nuovo=${geometry.height} px, toolbar=${geometry.columnHeight} px`
    );
    check(
      'Il pulsante vive nell\'header, sopra la toolbar comandi',
      geometry.bottom <= geometry.toolbarTop,
      `nuovo.bottom=${geometry.bottom}, toolbar.top=${geometry.toolbarTop}`
    );

    // Evidenza grafica: primo piano 2× dell'header con il pulsante a destra.
    mkdirSync('shots', { recursive: true });
    const headerClip = await cdp.eval(`
      const header = document.getElementById('btn-new-project').parentElement;
      const r = header.getBoundingClientRect();
      return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), width: r.width + 16, height: r.height + 16 };
    `);
    const headerShot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...headerClip, scale: 2 },
    });
    writeFileSync(join('shots', 'header-pulsante-nuovo.png'), Buffer.from(headerShot.data, 'base64'));
    console.log('Evidenza grafica: shots/header-pulsante-nuovo.png');

    /* --- 2) Nuovo con conferma NEGATA: il piano resta intatto ------------- */
    await clickPalletQuickPunta(cdp);
    await sleep(200);
    await typePlate(cdp, 'XA123NP');
    await installConfirmStub(cdp, false);

    const beforeNew = await readState(cdp);
    await clickButton(cdp, 'btn-new-project');
    await sleep(300);
    const afterDenied = await readState(cdp);

    check(
      'Conferma negata: il messaggio chiede se iniziare un nuovo piano',
      afterDenied.confirms.length === 1 &&
        afterDenied.confirms[0].includes('Vuoi iniziare un nuovo piano'),
      `messaggi=${JSON.stringify(afterDenied.confirms)}`
    );
    check(
      'Conferma negata: colli, targa e file attivo restano intatti',
      afterDenied.items === beforeNew.items &&
        afterDenied.plate === beforeNew.plate &&
        afterDenied.items >= 1,
      `colli=${afterDenied.items}, targa="${afterDenied.plate}"`
    );

    /* --- 3) Nuovo con conferma ACCETTATA: reset completo ------------------ */
    await installConfirmStub(cdp, true);
    await clickButton(cdp, 'btn-new-project');
    await sleep(300);
    const afterNew = await cdp.eval(`
      const state = (() => {
        const plateInput = document.querySelector('input[type="text"][maxlength]');
        return {
          items: document.querySelectorAll('[data-canvas-item]').length,
          notes: document.querySelectorAll('[data-canvas-note]').length,
          plate: plateInput ? plateInput.value : null,
          activeFile: document.getElementById('active-file-badge')?.textContent?.trim() ?? null,
          undoDisabled: document.getElementById('btn-undo')?.disabled ?? null,
          redoDisabled: document.getElementById('btn-redo')?.disabled ?? null,
          confirms: window.__confirmMessages.slice(),
        };
      })();
      return { ...state, vehicleId: window.__readVehicleId() };
    `);
    check(
      'Nuovo Piano accettato: pianale vuoto (né colli né note)',
      afterNew.items === 0 && afterNew.notes === 0,
      `colli=${afterNew.items}, note=${afterNew.notes}`
    );
    check(
      'Nuovo Piano accettato: targa sbiancata e file attivo sganciato',
      afterNew.plate === '' && afterNew.activeFile === null,
      `targa="${afterNew.plate}", badge=${afterNew.activeFile}`
    );
    check(
      'Nuovo Piano accettato: mezzo di fabbrica (Bilico CC)',
      afterNew.vehicleId === 'bilico_cc',
      `preset="${afterNew.vehicleId}"`
    );
    check(
      'Nuovo Piano accettato: pile Undo / Redo azzerate',
      afterNew.undoDisabled === true && afterNew.redoDisabled === true,
      `undo=${afterNew.undoDisabled}, redo=${afterNew.redoDisabled}`
    );

    /* --- 4) Apri Piano con conferma NEGATA: nessun selettore aperto ------- */
    await clickPalletQuickPunta(cdp);
    await typePlate(cdp, 'XA777AP');
    await cdp.eval(`
      window.__pickerCalls = 0;
      window.showOpenFilePicker = async () => {
        window.__pickerCalls += 1;
        throw new DOMException('annullato', 'AbortError');
      };
      return true;
    `);
    await installConfirmStub(cdp, false);
    const beforeOpen = await readState(cdp);
    await clickButton(cdp, 'btn-open-project');
    await sleep(300);
    const afterDeniedOpen = await cdp.eval(`
      return { pickerCalls: window.__pickerCalls, state: (() => {
        const plateInput = document.querySelector('input[type="text"][maxlength]');
        return {
          items: document.querySelectorAll('[data-canvas-item]').length,
          plate: plateInput ? plateInput.value : null,
          confirms: window.__confirmMessages.slice(),
        };
      })() };
    `);
    check(
      'Apri Piano con conferma negata: il selettore nativo NON viene aperto',
      afterDeniedOpen.pickerCalls === 0,
      `aperture=${afterDeniedOpen.pickerCalls}`
    );
    check(
      'Apri Piano con conferma negata: pianale intatto',
      afterDeniedOpen.state.items === beforeOpen.items && afterDeniedOpen.state.items >= 1,
      `colli=${afterDeniedOpen.state.items}`
    );
    check(
      'Apri Piano con conferma negata: messaggio dedicato all\'apertura',
      afterDeniedOpen.state.confirms.some((m) => m.includes('Vuoi aprire un altro file')),
      `messaggi=${JSON.stringify(afterDeniedOpen.state.confirms)}`
    );

    /* --- 5) Apri Piano con conferma ACCETTATA: il selettore si apre ------- */
    await installConfirmStub(cdp, true);
    await clickButton(cdp, 'btn-open-project');
    await sleep(400);
    const afterOpen = await cdp.eval(`return { pickerCalls: window.__pickerCalls };`);
    check(
      'Apri Piano con conferma accettata: il selettore nativo viene aperto',
      afterOpen.pickerCalls === 1,
      `aperture=${afterOpen.pickerCalls}`
    );

    /* --- 6) Apertura da file e "Svuota" ---------------------------------- */
    const project = {
      version: 1,
      app: 'truck-planner',
      timestamp: new Date().toISOString(),
      vehicle: { id: 'motrice_3a', name: 'Motrice 3 Assi', width: 250, length: 760 },
      plate: 'XA555SV',
      items: [
        {
          id: 'INDU_1',
          code: 'INDU',
          name: 'PLT INDU',
          width: 100,
          length: 120,
          x: 0,
          y: 0,
          rotation: 0,
          color: '#dbeafe',
          borderColor: '#334155',
        },
        {
          id: 'EUR_2',
          code: 'EUR',
          name: 'PLT EUR',
          width: 80,
          length: 120,
          x: 100,
          y: 0,
          rotation: 0,
          color: '#fef3c7',
          borderColor: '#334155',
        },
      ],
      notes: [
        {
          id: 'note_1',
          x: 270,
          y: 40,
          content: 'Fragile',
          color: '#ffffff',
          borderColor: '#cbd5e1',
          width: 140,
        },
      ],
      labelDensity: 'all',
    };
    const projectPath = join(profileDir, 'piano-svuota.json');
    writeFileSync(projectPath, JSON.stringify(project, null, 2), 'utf8');

    const deadlineLoad = Date.now() + 6000;
    let loaded = null;
    for (;;) {
      await injectProjectFile(cdp, projectPath);
      await sleep(300);
      loaded = await readState(cdp);
      if (loaded.items === 2 && loaded.notes === 1) break;
      if (Date.now() > deadlineLoad) break;
    }
    check(
      'Apertura del piano di prova: 2 colli e 1 nota laterale in scena',
      loaded.items === 2 && loaded.notes === 1,
      `colli=${loaded.items}, note=${loaded.notes}`
    );

    await installConfirmStub(cdp, true);
    await clickButton(cdp, 'btn-clear-all');
    await sleep(300);
    const afterClear = await cdp.eval(`
      const plateInput = document.querySelector('input[type="text"][maxlength]');
      return {
        items: document.querySelectorAll('[data-canvas-item]').length,
        notes: document.querySelectorAll('[data-canvas-note]').length,
        plate: plateInput ? plateInput.value : null,
        vehicleId: window.__readVehicleId(),
        activeFile: document.getElementById('active-file-badge')?.textContent?.trim() ?? null,
      };
    `);
    check(
      '"Svuota" azzera colli E note laterali',
      afterClear.items === 0 && afterClear.notes === 0,
      `colli=${afterClear.items}, note=${afterClear.notes}`
    );
    check(
      '"Svuota" non tocca mezzo, targa e file attivo',
      afterClear.vehicleId === 'motrice_3a' &&
        afterClear.plate === 'XA555SV' &&
        Boolean(afterClear.activeFile?.includes('piano-svuota.json')),
      `mezzo="${afterClear.vehicleId}", targa="${afterClear.plate}", badge=${afterClear.activeFile}`
    );

    check(
      'Nessuna eccezione runtime in pagina',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ') || 'console pulita'
    );

    console.log(`\n${passed}/${passed + failed} controlli superati`);
    exitCode = failed === 0 ? 0 : 1;

    await cdp.send('Browser.close').catch(() => {});
    cdp.ws.close();
    cdp = null;
  } finally {
    clearTimeout(watchdog);
    try {
      chrome.kill();
    } catch {
      /* già terminato */
    }
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* profilo temporaneo già rimosso */
    }
    // `exitCode` (e non `process.exit`) per lasciare svuotare i buffer di stdout:
    // il processo termina da solo quando il WebSocket e Chrome sono chiusi.
    process.exitCode = exitCode;
  }
};

main().catch((error) => {
  console.error(`ERRORE: ${error.message}`);
  process.exit(1);
});
