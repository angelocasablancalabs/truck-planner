/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — STABILIZZAZIONE DELLA SIDEBAR (`scrollbar-gutter: stable`)
 *  (Sprint K)
 *
 *  Il contenitore radice di `ControlDeck.tsx` riserva permanentemente il canale
 *  della barra di scorrimento verticale (`[scrollbar-gutter:stable]`). Senza la
 *  direttiva, al comparire della scrollbar la larghezza utile della plancia si
 *  riduce di ~15 px e i micro-pulsanti allineati a destra (`↔ Piatto` /
 *  `↕ Punta` delle righe di catalogo) slittano a sinistra: i click "a raffica"
 *  dell'operatore finiscono fuori bersaglio.
 *
 *  Controlli:
 *    1. computed `scrollbar-gutter: stable` sul contenitore `.control-deck` e
 *       canale già riservato **a pianale vuoto** (nessuna scrollbar visibile);
 *    2. coordinata X di `#quick-piatto-EUR` (il pulsante `↔ Piatto` di
 *       `PLT EUR`) **identica** a pianale vuoto e dopo l'inserimento / selezione
 *       del primo collo (tolleranza 0,001 px) — con la scrollbar ormai comparsa;
 *    3. controprova: disattivando la direttiva (`scrollbar-gutter: auto`) lo
 *       stesso pulsante slitta davvero di ~15 px fra i due stati, quindi la
 *       stabilizzazione non è un artefatto del test;
 *    4. nessun errore runtime in console.
 *
 *  Uso:  node scripts/verify-scrollbar-gutter.mjs [url]
 *  Chiude sempre con `Browser.close` + `process.exit(0)` entro 10 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://127.0.0.1:5199/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9336);
const WATCHDOG_MS = 10000;
const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** Soglia richiesta dal task: identità "al millesimo di pixel". */
const X_TOLERANCE_PX = 0.001;
/** Canale scrollbar atteso su Windows/Chrome (classic scrollbars, 15 px). */
const MIN_RESERVED_GUTTER_PX = 10;

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

/* --- Misura dello stato della plancia -------------------------------------- */

/**
 * Fotografia geometrica della sidebar: posizione del pulsante `↔ Piatto` di
 * `PLT EUR` (elemento allineato a destra nella riga di catalogo, quindi il primo
 * a muoversi se la larghezza utile della plancia cambia), canale della scrollbar
 * e presenza/assenza della barra verticale.
 */
const MEASURE = `
  const deck = document.querySelector('.control-deck');
  const btn = document.getElementById('quick-piatto-EUR');
  if (!deck || !btn) return null;
  const deckRect = deck.getBoundingClientRect();
  const rect = btn.getBoundingClientRect();
  const style = getComputedStyle(deck);
  return {
    left: rect.left,
    right: rect.right,
    width: rect.width,
    top: rect.top,
    deckLeft: deckRect.left,
    deckRight: deckRect.right,
    clientWidth: deck.clientWidth,
    offsetWidth: deck.offsetWidth,
    clientHeight: deck.clientHeight,
    scrollHeight: deck.scrollHeight,
    scrollbarGutter: style.scrollbarGutter,
    overflowY: style.overflowY,
    reservedPx: deck.offsetWidth - deck.clientWidth,
    overflowing: deck.scrollHeight > deck.clientHeight,
    hasSelectedPanel: !!document.getElementById('btn-add-side-note'),
    // Contatore ufficiale del riepilogo stiva ("N Colli Totali").
    items: (() => {
      const m = /(\\d+)\\s+Colli Totali/.exec(deck.textContent || '');
      return m ? Number(m[1]) : -1;
    })(),
  };
`;

/** Sovrascrittura temporanea della direttiva (controprova `auto`). */
const OVERRIDE_ID = 'verify-scrollbar-gutter-override';
const setGutterOverride = (cdp, enabled) =>
  cdp.eval(`
    const existing = document.getElementById(${JSON.stringify(OVERRIDE_ID)});
    if (${enabled}) {
      if (!existing) {
        const style = document.createElement('style');
        style.id = ${JSON.stringify(OVERRIDE_ID)};
        style.textContent = '.control-deck { scrollbar-gutter: auto !important; }';
        document.head.appendChild(style);
      }
    } else if (existing) {
      existing.remove();
    }
    const deck = document.querySelector('.control-deck');
    return getComputedStyle(deck).scrollbarGutter;
  `);

/* --- Script ----------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();
  const profileDir = mkdtempSync(join(tmpdir(), 'gutter-profile-'));
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

    /* --- 1) Direttiva attiva e canale riservato a pianale vuoto ----------- */
    const empty = await cdp.eval(MEASURE);
    check(
      'Sidebar: computed `scrollbar-gutter: stable` sul contenitore radice',
      empty.scrollbarGutter === 'stable',
      `scrollbar-gutter=${empty.scrollbarGutter}, overflow-y=${empty.overflowY}`
    );
    check(
      'Pianale vuoto: nessuna scrollbar visibile, ma canale già riservato',
      !empty.overflowing && empty.reservedPx >= MIN_RESERVED_GUTTER_PX,
      `scrollHeight ${empty.scrollHeight} ≤ clientHeight ${empty.clientHeight} px, canale riservato ${empty.reservedPx} px`
    );

    /* --- 2) X del pulsante `↔ Piatto` di PLT EUR: vuoto vs selezionato ---- */
    await cdp.eval(`document.getElementById('quick-piatto-EUR').click(); return 1;`);
    await waitFor(
      async () => cdp.eval(`return document.getElementById('btn-add-side-note') ? 1 : 0;`),
      4000,
      'pannello "Selezionato" del primo collo'
    );
    await sleep(200);
    const populated = await cdp.eval(MEASURE);

    check(
      'Primo collo inserito e selezionato: la scrollbar verticale è davvero comparsa',
      populated.items === 1 && populated.hasSelectedPanel && populated.overflowing,
      `${populated.items} collo, pannello Selezionato=${populated.hasSelectedPanel}, scrollHeight ${populated.scrollHeight} > clientHeight ${populated.clientHeight} px`
    );
    const deltaX = populated.left - empty.left;
    check(
      'X di `↔ Piatto` (PLT EUR) identica tra pianale vuoto e collo selezionato (tolleranza 0,001 px)',
      Math.abs(deltaX) <= X_TOLERANCE_PX,
      `left ${empty.left.toFixed(4)} px → ${populated.left.toFixed(4)} px (Δ ${deltaX.toFixed(6)} px)`
    );
    check(
      'Larghezza utile della plancia invariata (clientWidth costante)',
      populated.clientWidth === empty.clientWidth,
      `clientWidth ${empty.clientWidth} px → ${populated.clientWidth} px (canale ${empty.reservedPx} px)`
    );

    /* --- 3) Controprova: senza la direttiva il pulsante slitta ------------ */
    const overrideGutter = await setGutterOverride(cdp, true);
    await sleep(200);
    const populatedAuto = await cdp.eval(MEASURE);
    await cdp.eval(`document.getElementById('btn-undo').click(); return 1;`);
    await waitFor(
      async () => cdp.eval(`return document.getElementById('btn-add-side-note') ? 0 : 1;`),
      4000,
      'undo del primo collo'
    );
    await sleep(200);
    const emptyAuto = await cdp.eval(MEASURE);
    const autoDeltaX = populatedAuto.left - emptyAuto.left;
    const scrollbarWidthPx = Math.abs(autoDeltaX);
    check(
      'Controprova (`scrollbar-gutter: auto`): il pulsante slitta davvero di una scrollbar',
      overrideGutter === 'auto' &&
        !emptyAuto.overflowing &&
        populatedAuto.overflowing &&
        autoDeltaX < 0 &&
        scrollbarWidthPx >= MIN_RESERVED_GUTTER_PX,
      `left vuoto ${emptyAuto.left.toFixed(4)} px vs pieno ${populatedAuto.left.toFixed(4)} px (Δ ${autoDeltaX.toFixed(6)} px ≈ ${scrollbarWidthPx.toFixed(1)} px di scrollbar)`
    );

    /* --- 4) Ripristino della direttiva: X tornata al valore stabile ------- */
    const restoredGutter = await setGutterOverride(cdp, false);
    await sleep(150);
    const restored = await cdp.eval(MEASURE);
    check(
      'Ripristino: la direttiva torna attiva e la X del pulsante è quella stabilizzata',
      restoredGutter === 'stable' &&
        Math.abs(restored.left - populated.left) <= X_TOLERANCE_PX,
      `left ${restored.left.toFixed(4)} px (atteso ${populated.left.toFixed(4)} px), Δ ${(restored.left - populated.left).toFixed(6)} px`
    );

    /* --- 5) Nessun errore in console ------------------------------------- */
    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    /* --- Evidenza grafica: sidebar popolata con la scrollbar visibile ----- */
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync('shots', { recursive: true });
    await cdp.eval(`document.getElementById('quick-piatto-EUR').click(); return 1;`);
    await sleep(250);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(
      'shots/sidebar-scrollbar-gutter-stabile.png',
      Buffer.from(shot.data, 'base64')
    );
    console.log('Evidenza grafica: shots/sidebar-scrollbar-gutter-stabile.png');

    console.log(`\n${passed}/${passed + failed} controlli superati`);
    console.log(
      `Durata della verifica: ${((Date.now() - startedAt) / 1000).toFixed(2)} s (limite 10 s)`
    );
  } finally {
    try {
      ws?.close();
    } catch {
      /* il websocket potrebbe essere già chiuso */
    }
    // Chiusura pulita del browser: `Browser.close` non risponde mai (la
    // connessione cade insieme al browser), quindi non si attende la risposta.
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
  console.error('WATCHDOG: verifica interrotta oltre i 10 secondi');
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

main()
  .then(() => process.exit(failed === 0 ? 0 : 1))
  .catch((error) => {
    console.error('ERRORE:', error?.message ?? error);
    process.exit(1);
  });
