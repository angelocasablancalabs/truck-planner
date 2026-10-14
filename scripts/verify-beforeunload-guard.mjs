/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — PROTEZIONE DALLA CHIUSURA ACCIDENTALE DELLA SCHEDA
 *
 *  Prova end-to-end del guardiano `beforeunload` aggiunto in `src/App.tsx`:
 *
 *    1. pianale a riposo (nessuna modifica) → la chiusura NON viene bloccata;
 *    2. collo aggiunto (mutazione)         → la chiusura viene bloccata;
 *    3. targa modificata                    → la chiusura viene bloccata;
 *    4. salvataggio `.json` andato a buon fine (selettore nativo finto)
 *       → il piano torna "pulito" e la chiusura NON viene più bloccata;
 *    5. nuova mutazione dopo il salvataggio → la protezione si riaccende;
 *    6. apertura di un piano da disco con modifiche non salvate → la protezione
 *       antipanico chiede il `confirm` nativo, il piano letto entra in scena e
 *       torna "pulito" (chiusura di nuovo non bloccata).
 *
 *  L'esito viene letto dal `returnValue` che il browser espone sul `BeforeUnloadEvent`
 *  dopo il dispatch: `true` (stringa vuota) = popup nativo di conferma richiesto.
 *
 *  Uso:  node scripts/verify-beforeunload-guard.mjs [url]
 *
 *  Prerequisiti: dev server Vite attivo (default `http://localhost:5173/truck-planner/`)
 *  e Google Chrome installato (override con `CHROME_PATH`).
 *
 *  Chiude sempre con `Browser.close()` + `process.exit(...)` entro 45 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://localhost:5173/truck-planner/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9349);
const WATCHDOG_MS = 60000;
const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    /** Messaggi dei `confirm` nativi aperti dalla pagina (protezione antipanico). */
    this.dialogs = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Page.javascriptDialogOpening') {
        this.dialogs.push(msg.params?.message ?? '');
        // Il dialogo va sempre chiuso (accettato), altrimenti il renderer resta
        // bloccato e ogni comando CDP successivo va in timeout.
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
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
      throw new Error(result.exceptionDetails.exception?.description ?? 'errore di valutazione');
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
 * Script iniettato nella pagina: definisce `window.__probeBeforeUnload()`, che
 * crea un `BeforeUnloadEvent` **annullabile**, lo dispaccia sulla finestra e
 * riporta se il guardiano ha chiesto la conferma nativa.
 *
 * La prova è `defaultPrevented`: in un test sintetico è **il solo** segnale
 * affidabile, perché su un evento costruito a mano `returnValue` resta il
 * booleano legacy `true` e la scrittura `e.returnValue = ''` non vi si riflette
 * (nel ciclo di vita reale del browser è invece proprio quella scrittura a far
 * comparire il popup). Il valore viene comunque riportato per diagnostica.
 */
const INSTALL_PROBE = `
  window.__probeBeforeUnload = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return {
      blocked: event.defaultPrevented,
      prevented: event.defaultPrevented,
      returnValue: String(event.returnValue),
    };
  };
  return true;
`;

/** Aggiunge un collo INDU al pianale con un click fidato (`Input.dispatchMouseEvent`). */
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

/** Installa un finto `showSaveFilePicker` che registra la scrittura su disco. */
const installFakeSavePicker = async (cdp, fileName) => {
  await cdp.eval(`
    window.__writes = [];
    window.showSaveFilePicker = async () => ({
      name: ${JSON.stringify(fileName)},
      kind: 'file',
      async createWritable() {
        return {
          async write(data) {
            window.__writes.push({ name: ${JSON.stringify(fileName)}, bytes: String(data).length });
          },
          async close() {},
        };
      },
    });
    return true;
  `);
};

/** Click fidato su un pulsante della plancia. */
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

const main = async () => {
  await waitForDevServer();

  const profileDir = mkdtempSync(join(tmpdir(), 'beforeunload-profile-'));
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

    // Attesa del mount: il campo targa è il riferimento stabile della plancia.
    const deadline = Date.now() + 10000;
    for (;;) {
      const ready = await cdp.eval(
        `return Boolean(document.getElementById('btn-print-clean') && document.getElementById('quick-punta-INDU'));`
      );
      if (ready) break;
      if (Date.now() > deadline) {
        const dump = await cdp.eval(
          `return { url: location.href, title: document.title, readyState: document.readyState, body: (document.body?.innerHTML ?? '').slice(0, 200) };`
        );
        throw new Error(`plancia non montata entro 10 s: ${JSON.stringify(dump)}`);
      }
      await sleep(150);
    }

    await cdp.eval(INSTALL_PROBE);
    await sleep(200);

    /* --- 1) Pianale appena caricato: nessuna modifica, nessun blocco ------ */
    const pristine = await cdp.eval(`return window.__probeBeforeUnload();`);
    check(
      'Piano appena aperto (nessuna modifica): la chiusura della scheda NON viene bloccata',
      pristine.blocked === false && pristine.prevented === false,
      `blocked=${pristine.blocked}, prevented=${pristine.prevented}`
    );

    /* --- 2) Aggiunta di un collo: il guardiano si accende ----------------- */
    await clickPalletQuickPunta(cdp);
    await sleep(250);
    const afterAdd = await cdp.eval(`
      return {
        items: document.querySelectorAll('[data-canvas-item]').length,
        probe: window.__probeBeforeUnload(),
      };
    `);
    check(
      'Aggiunta di un collo: mutazione registrata sul pianale',
      afterAdd.items >= 1,
      `${afterAdd.items} collo/i in scena`
    );
    check(
      'Modifica non salvata: `beforeunload` viene annullato e chiede il popup nativo',
      afterAdd.probe.blocked === true && afterAdd.probe.prevented === true,
      `blocked=${afterAdd.probe.blocked}, prevented=${afterAdd.probe.prevented}, returnValue="${afterAdd.probe.returnValue}"`
    );

    /* --- 3) Modifica della targa: il guardiano resta acceso --------------- */
    await typePlate(cdp, 'XA999ZZ');
    const afterPlate = await cdp.eval(`
      return { plate: document.querySelector('input[type="text"][maxlength]').value, probe: window.__probeBeforeUnload() };
    `);
    check(
      'Modifica della targa: la stiva resta protetta dalla chiusura accidentale',
      afterPlate.plate === 'XA999ZZ' && afterPlate.probe.blocked === true,
      `targa="${afterPlate.plate}", blocked=${afterPlate.probe.blocked}`
    );

    /* --- 4) Salvataggio riuscito: il piano torna "pulito" ----------------- */
    await installFakeSavePicker(cdp, 'piano-prova-guardiano.json');
    await clickButton(cdp, 'btn-save-project');
    const deadlineSave = Date.now() + 5000;
    let afterSave = null;
    for (;;) {
      afterSave = await cdp.eval(`
        return {
          writes: window.__writes.length,
          badge: document.getElementById('active-file-badge')?.textContent ?? null,
          probe: window.__probeBeforeUnload(),
        };
      `);
      if (afterSave.writes > 0 && afterSave.probe.blocked === false) break;
      if (Date.now() > deadlineSave) break;
      await sleep(150);
    }
    check(
      'Salvataggio `.json` andato a buon fine: il file viene scritto su disco',
      afterSave.writes === 1,
      `scritture=${afterSave.writes}, badge=${afterSave.badge}`
    );
    check(
      'Dopo il salvataggio: `beforeunload` NON blocca più (piano allineato al file)',
      afterSave.probe.blocked === false && afterSave.probe.prevented === false,
      `blocked=${afterSave.probe.blocked}, prevented=${afterSave.probe.prevented}`
    );

    /* --- 5) Nuova mutazione dopo il salvataggio: si riaccende ------------- */
    await clickPalletQuickPunta(cdp);
    await sleep(250);
    const afterSecondEdit = await cdp.eval(`return window.__probeBeforeUnload();`);
    check(
      'Nuova modifica dopo il salvataggio: la protezione si riaccende',
      afterSecondEdit.blocked === true && afterSecondEdit.prevented === true,
      `blocked=${afterSecondEdit.blocked}, prevented=${afterSecondEdit.prevented}`
    );

    /* --- 6) Apertura di un piano da disco: il piano torna "pulito" -------- */
    // Il piano in scena ha modifiche non salvate (passo 5): la protezione
    // antipanico apre il `confirm` nativo, che l'harness accetta. L'apertura
    // deve quindi procedere e riallineare lo stato al file letto.
    cdp.dialogs.length = 0;
    const project = {
      version: 1,
      app: 'truck-planner',
      timestamp: new Date().toISOString(),
      vehicle: { id: 'bilico_cc', name: 'Bilico CC', width: 250, length: 1328 },
      plate: 'XA111NJ',
      items: [],
      notes: [],
      labelDensity: 'all',
    };
    const deadlineLoad = Date.now() + 5000;
    let afterLoad = { probe: { blocked: true }, badge: null };
    let loadError = null;
    // Il piano di prova viene scritto su un file **reale** e consegnato al campo
    // `<input type="file">` con `DOM.setFileInputFiles`: è la strada nativa del
    // browser, perché l'iniezione sintetica via `DataTransfer` blocca il
    // renderer headless sul `change` del campo file.
    const projectPath = join(profileDir, 'piano-ripreso.json');
    writeFileSync(projectPath, JSON.stringify(project, null, 2), 'utf8');
    for (;;) {
      try {
        const doc = await cdp.send('DOM.getDocument', { depth: 1 });
        const node = await cdp.send('DOM.querySelector', {
          nodeId: doc.root.nodeId,
          selector: '#project-file-input',
        });
        if (!node.nodeId) throw new Error('campo `#project-file-input` non trovato');
        await cdp.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [projectPath] });
      } catch (error) {
        loadError = error.message;
        break;
      }
      await sleep(300);
      afterLoad = await cdp.eval(`
        return {
          probe: window.__probeBeforeUnload(),
          badge: document.getElementById('active-file-badge')?.textContent ?? null,
        };
      `);
      if (afterLoad.probe.blocked === false && afterLoad.badge?.includes('piano-ripreso.json')) {
        break;
      }
      if (Date.now() > deadlineLoad) break;
    }
    check(
      'Apertura di un piano `.json` da disco: file attivo agganciato',
      Boolean(afterLoad.badge?.includes('piano-ripreso.json')),
      `badge=${afterLoad.badge}${loadError ? ` · errore iniezione: ${loadError}` : ''}`
    );
    check(
      'Piano appena aperto da file: nessuna modifica in sospeso, chiusura non bloccata',
      afterLoad.probe.blocked === false && afterLoad.probe.prevented === false,
      `blocked=${afterLoad.probe.blocked}, prevented=${afterLoad.probe.prevented}`
    );
    check(
      'Apertura con modifiche non salvate: la protezione antipanico chiede conferma',
      cdp.dialogs.length === 1 && cdp.dialogs[0].includes('Vuoi aprire un altro file'),
      cdp.dialogs.join(' | ') || 'nessun dialogo'
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
