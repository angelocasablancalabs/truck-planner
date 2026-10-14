/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — NOME PREDEFINITO PARLANTE DELLA STAMPA PDF
 *
 *  I driver PDF (Adobe PDF / "Salva come PDF") usano `document.title` come nome
 *  file proposto. Storicamente la stampa azzerava il titolo (`document.title =
 *  ' '`) e il driver ricadeva sul dominio del sito
 *  (`angelocasablancalabs.github.pdf`). Questa verifica accerta che:
 *
 *    1. "Solo Grafica" proponga `piano-<TARGA>` con la targa del **primo stallo**
 *       (es. `piano-AA111AA`), normalizzata in `[A-Za-z0-9_]`;
 *    2. "Scheda Completa" proponga lo stesso nome parlante;
 *    3. senza targa il nome sia il generico `piano-di-carico`;
 *    4. una targa con caratteri non alfanumerici (es. `XA000BB COME ARRIVA`)
 *       diventi un nome file senza spazi (`piano-XA000BB_COME_ARRIVA`);
 *    5. alla chiusura del dialogo (`afterprint`) il titolo torni esattamente a
 *       `Truck Planner CAD`;
 *    6. nessun titolo sia mai il dominio del sito o una stringa vuota.
 *
 *  Il dialogo nativo di stampa bloccherebbe l'esecuzione headless: `window.print`
 *  viene quindi sostituito da una spia che registra il titolo al momento della
 *  stampa e rilascia poi un vero evento `afterprint`.
 *
 *  Uso:  node scripts/verify-print-filename.mjs [url]
 *  Chiude sempre con `Browser.close` + `process.exit(0)` entro 15 secondi.
 * -------------------------------------------------------------------------- */

const TARGET_URL = process.argv[2] || 'http://127.0.0.1:5199/truck-planner/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9347);
const WATCHDOG_MS = 15000;
const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

/* --- Spia di stampa -------------------------------------------------------- */

/** Installa la spia su `window.print`: registra il titolo al momento della
 *  stampa e, su richiesta, rilascia un vero `afterprint` sul `window`.
 *
 *  L'evento è differito con `setTimeout(0)` perché `triggerPrint` registra il
 *  listener `afterprint` **dopo** la chiamata a `window.print()`. */
const INSTALL_PRINT_SPY = `
  window.__printSpy = { calls: [], titles: [] };
  window.print = () => {
    window.__printSpy.calls.push(document.documentElement.getAttribute('data-print-mode'));
    window.__printSpy.titles.push(document.title);
    if (window.__printSpy.autoAfter) {
      setTimeout(() => window.dispatchEvent(new Event('afterprint')), 0);
    }
  };
  window.__printSpy.autoAfter = true;
  return 1;
`;

/** Clicca il pulsante di stampa e attende che la spia registri la chiamata. */
const clickPrint = async (cdp, buttonId) => {
  await cdp.eval(`
    window.__printSpy.titles = [];
    window.__printSpy.calls = [];
    document.getElementById('${buttonId}').click();
    return 1;
  `);
  await waitFor(
    async () => cdp.eval(`return window.__printSpy.titles.length > 0 ? 1 : 0;`),
    4000,
    `chiamata a window.print da #${buttonId}`
  );
  return cdp.eval(`
    return {
      printTitle: window.__printSpy.titles[0],
      mode: window.__printSpy.calls[0],
      liveTitle: document.title,
    };
  `);
};

/** Imposta la targa del Mezzo Attivo con gli eventi React attesi. */
const setPlate = (cdp, value) =>
  cdp.eval(`
    const input = document.getElementById('vehicle-plate-input');
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;
    setter.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  `);

/* --- Script ----------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();
  const profileDir = mkdtempSync(join(tmpdir(), 'print-name-profile-'));
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
    await cdp.send('Page.navigate', { url: TARGET_URL });

    await waitFor(
      async () => cdp.eval(`return document.getElementById('quick-piatto-INDU') ? 1 : 0;`),
      9000,
      'mount della plancia'
    );

    const baseTitle = await cdp.eval(`return document.title;`);
    check(
      'Titolo di riposo della pagina: "Truck Planner CAD"',
      baseTitle === 'Truck Planner CAD',
      `document.title = ${JSON.stringify(baseTitle)}`
    );

    await cdp.eval(INSTALL_PRINT_SPY);

    /* --- 1) Senza targa: nome generico ---------------------------------- */
    const noPlate = await clickPrint(cdp, 'btn-print-clean');
    check(
      'Senza targa, "Solo Grafica" propone "piano-di-carico"',
      noPlate.printTitle === 'piano-di-carico',
      `titolo alla stampa = ${JSON.stringify(noPlate.printTitle)}`
    );
    check(
      'Alla chiusura del dialogo il titolo torna a "Truck Planner CAD"',
      noPlate.liveTitle === 'Truck Planner CAD' &&
        (await cdp.eval(`return document.title;`)) === 'Truck Planner CAD',
      `titolo dopo afterprint = ${JSON.stringify(noPlate.liveTitle)}`
    );

    /* --- 2) Targa piena: nome parlante ---------------------------------- */
    await setPlate(cdp, 'AA111AA');
    await sleep(200);
    const withPlate = await clickPrint(cdp, 'btn-print-clean');
    check(
      'Con targa "AA111AA", "Solo Grafica" propone "piano-AA111AA"',
      withPlate.printTitle === 'piano-AA111AA',
      `titolo alla stampa = ${JSON.stringify(withPlate.printTitle)}`
    );
    check(
      'Dopo la stampa con targa il titolo torna a "Truck Planner CAD"',
      (await cdp.eval(`return document.title;`)) === 'Truck Planner CAD',
      `titolo = ${JSON.stringify(await cdp.eval(`return document.title;`))}`
    );

    /* --- 3) "Scheda Completa": stesso nome parlante ---------------------- */
    const fullMode = await clickPrint(cdp, 'btn-print-report');
    check(
      'Anche "Scheda Completa" propone "piano-AA111AA"',
      fullMode.printTitle === 'piano-AA111AA' && fullMode.mode === 'full',
      `titolo = ${JSON.stringify(fullMode.printTitle)}, modalità = ${JSON.stringify(fullMode.mode)}`
    );

    /* --- 4) Never un titolo vuoto o il dominio del sito ----------------- */
    const allTitles = [noPlate.printTitle, withPlate.printTitle, fullMode.printTitle];
    check(
      'Nessun titolo di stampa è vuoto o il dominio del sito',
      allTitles.every(
        (t) => typeof t === 'string' && t.trim().length > 0 && !t.includes('angelocasablancalabs')
      ),
      JSON.stringify(allTitles)
    );

    /* --- 5) Targa con spazi: nome file normalizzato ---------------------- */
    await setPlate(cdp, 'XA000BB COME ARRIVA');
    await sleep(200);
    const messyPlate = await clickPrint(cdp, 'btn-print-clean');
    check(
      'Targa con spazi ("XA000BB COME ARRIVA") → "piano-XA000BB_COME_ARRIVA" (nessuno spazio)',
      messyPlate.printTitle === 'piano-XA000BB_COME_ARRIVA' && !/\s/.test(messyPlate.printTitle),
      `titolo = ${JSON.stringify(messyPlate.printTitle)}`
    );

    /* --- 6) Stato di stampa ripulito e nessun errore runtime ------------- */
    const residue = await cdp.eval(`
      return {
        mode: document.documentElement.hasAttribute('data-print-mode'),
        landscape: document.documentElement.hasAttribute('data-print-landscape'),
        style: !!document.getElementById('print-page-orientation'),
      };
    `);
    check(
      "Stato di stampa ripulito all'afterprint (nessun attributo né foglio @page)",
      residue.mode === false && residue.landscape === false && residue.style === false,
      JSON.stringify(residue)
    );
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
