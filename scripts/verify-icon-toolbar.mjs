/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — TOOLBAR A SEI ICONE & STAMPA VETTORIALE A MODALITÀ
 *
 *  Pilota Chrome reale via Chrome DevTools Protocol (zero dipendenze aggiunte)
 *  e verifica, end-to-end, la plancia comandi nell'architettura attuale — quella
 *  in cui il PDF **non** è più un raster JPEG composto a mano, ma il risultato
 *  della stampa nativa del browser pilotata dall'attributo `data-print-mode`:
 *
 *    1. **Toolbar geometrica 2 × 3**: sei pulsanti a **sole icone** disposti su
 *       due righe da tre colonne uniformi (`grid-cols-3`, alto 36 px ciascuno),
 *       con il testo descrittivo confinato nel `title` (tooltip) e in uno
 *       `span.sr-only` — nessuna etichetta visibile;
 *    2. **Ordine dei comandi**: riga 1 (File) = `Salva` · `Salva con nome` ·
 *       `Apri Piano`; riga 2 (Output) = `Copia Immagine` · `Stampa Solo Grafica`
 *       · `Stampa Scheda Completa`;
 *    3. **Badge `#active-file-badge`** sotto la seconda riga, acceso dal
 *       salvataggio;
 *    4. **Stampa a modalità**: il click su `#btn-print-clean` imposta
 *       `data-print-mode="clean"` su `<html>`, chiama `window.print()` e lo
 *       **rimuove** all'evento `afterprint` (stessa cosa per
 *       `#btn-print-report` → `full`); le regole `@media print` della modalità
 *       `clean` esistono davvero nei fogli di stile (`display: none !important`
 *       per intestazione e tabella) e, sotto media di stampa emulato, nascondono
 *       intestazione, tabella e Pagina 2 lasciando il disegno a piena pagina;
 *    5. **PDF vettoriale leggero**: il motore di stampa di Chrome (`printToPDF`)
 *       produce, con la modalità `clean` attiva, un PDF **senza alcuna immagine
 *       raster incorporata** e di peso contenuto, salvato come evidenza in
 *       `shots/` per l'ispezione manuale dell'operatore;
 *    6. **"Salva con nome"**: con un file già agganciato forza comunque il
 *       selettore nativo, crea una **nuova copia** e sposta lì il file attivo;
 *       se l'operatore annulla non succede nulla e non compare alcun avviso.
 *
 *  Nota di metodo: Chrome headless espone la File System Access API ma non può
 *  mostrare i dialoghi nativi, quindi i selettori sono sostituiti da doppi
 *  controllabili installati nella pagina (`Object.defineProperty`). Allo stesso
 *  modo `window.print()` — che in headless non ha né anteprima né dialogo — viene
 *  sostituito da una spia contabile: il ciclo di vita dell'attributo è così
 *  deterministico, mentre la **resa reale** del foglio di stampa è verificata a
 *  parte con `Emulation.setEmulatedMedia({ media: 'print' })` (stili calcolati e
 *  geometria) e con `Page.printToPDF` (artefatto vettoriale vero).
 *
 *  Uso:  node scripts/verify-icon-toolbar.mjs [url]
 *  (default `http://localhost:5173/truck-planner/`)
 *  Chiude sempre con `Browser.close()` + `process.exit(...)` entro 45 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://localhost:5173/truck-planner/';
/** Porta del server DevTools del Chrome headless pilotato dallo script. */
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9341);
const WATCHDOG_MS = 45000;
const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
/**
 * Evidenza della stampa "Solo Grafica": il PDF **vettoriale** prodotto dal motore
 * di stampa di Chrome con `data-print-mode="clean"` attivo. Sostituisce il vecchio
 * `shots/pdf-solo-grafica.pdf`, che era il raster JPEG del generatore rimosso.
 */
const PRINT_EVIDENCE = ['shots', 'pdf-vettoriale-solo-grafica.pdf'];

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * I sei comandi attesi, **nell'ordine visivo** (riga per riga, sinistra →
 * destra): prima la riga 1 di gestione file, poi la riga 2 di output, così le
 * tre colonne di ciascuna riga si possono confrontare per geometria.
 */
const COMMANDS = [
  { id: 'btn-save-project', label: 'Salva', tooltip: 'Salva' },
  { id: 'btn-save-as-project', label: 'Salva con nome', tooltip: 'nuova copia' },
  { id: 'btn-open-project', label: 'Apri Piano', tooltip: '.json' },
  { id: 'btn-copy-image', label: 'Copia Immagine', tooltip: 'appunti' },
  { id: 'btn-print-clean', label: 'Stampa Solo Grafica', tooltip: 'solo grafica' },
  { id: 'btn-print-report', label: 'Stampa Scheda Completa', tooltip: 'scheda tecnica' },
];

/**
 * Targa digitata prima delle verifiche di stampa: finisce nel badge sopra la
 * Cabina della scheda A4 e del disegno "solo grafica", quindi prova che il
 * foglio stampato porta davvero il mezzo identificato (e non una sagoma vuota).
 */
const PLATE = 'XA111NJ';
/** Nome del file agganciato dal primo salvataggio (selettore nativo finto). */
const FIRST_FILE_NAME = 'piano-piazzale.json';
/** Nome della nuova copia creata da "Salva con nome". */
const COPY_FILE_NAME = 'piano-copia.json';

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
    /** Dialoghi nativi aperti dalla pagina (`alert` di errore). */
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
 * Installa nella pagina un handle finto in stile File System Access API e lo
 * espone come `window.__handles[name]`: `createWritable()` registra in
 * `window.__writes` ogni `write` / `close`, esattamente come il file reale.
 */
const installFakeHandles = (cdp, names) =>
  cdp.eval(`
    window.__writes = [];
    window.__handles = {};
    window.__saves = 0;
    for (const name of ${JSON.stringify(names)}) {
      window.__handles[name] = {
        kind: 'file',
        name,
        async getFile() { return new File(['{}'], name, { type: 'application/json' }); },
        async createWritable() {
          const owner = name;
          return {
            async write(data) { window.__writes.push({ name: owner, data: String(data) }); },
            async close() { window.__writes.push({ name: owner, closed: true }); },
          };
        },
      };
    }
    return Object.keys(window.__handles).length;
  `);

/**
 * Sostituisce `showSaveFilePicker` con un doppio controllabile: la coda dei nomi
 * indica quale handle finto restituire a ogni chiamata (`abort` = annullamento).
 */
const shimSavePicker = (cdp, queue) =>
  cdp.eval(`
    const queue = ${JSON.stringify(queue)};
    window.__pickerCalls = 0;
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      writable: true,
      value: async () => {
        window.__pickerCalls += 1;
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (next === 'abort') throw new DOMException('annullato', 'AbortError');
        return window.__handles[next];
      },
    });
    return typeof window.showSaveFilePicker;
  `);

/* --- Fotografia della toolbar --------------------------------------------- */

const TOOLBAR_SNAPSHOT = `
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) };
  };
  const commands = ${JSON.stringify(COMMANDS.map((c) => c.id))}.map((id) => {
    const el = document.getElementById(id);
    if (!el) return { id, missing: true };
    const sr = el.querySelector('span.sr-only');
    const children = Array.from(el.children).map((c) => ({
      tag: c.tagName.toLowerCase(),
      cls: c.getAttribute('class') || '',
    }));
    const srStyle = sr ? getComputedStyle(sr) : null;
    return {
      id,
      missing: false,
      box: box(el),
      title: el.getAttribute('title') || '',
      srText: sr ? sr.textContent.trim() : null,
      srPosition: srStyle ? srStyle.position : null,
      srWidth: srStyle ? srStyle.width : null,
      svgCount: el.querySelectorAll('svg').length,
      // Testo NON accessibile: ogni figlio non-icona deve essere uno sr-only.
      visibleChildren: children.filter((c) => c.tag !== 'svg').map((c) => ({ ...c, srOnly: c.cls.split(/\\s+/).includes('sr-only') })),
      textNodes: Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim()).length,
    };
  });
  const badge = document.getElementById('active-file-badge');
  return {
    commands,
    badge: badge ? { text: badge.textContent.trim(), title: badge.getAttribute('title'), box: box(badge) } : null,
    // Testo dell'intera toolbar (etichette sr-only comprese): serve a provare
    // che nessuna vecchia etichetta visibile sia rimasta in giro.
    toolbarText: document.getElementById('btn-copy-image').parentElement.parentElement.textContent.trim(),
    deckText: (document.querySelector('.control-deck')?.textContent || '').trim(),
  };
`;

/* --- Stampa a modalità: regole `@media print` e resa del foglio ----------- */

/**
 * Raccoglie dai fogli di stile **tutte** le regole che citano `data-print-mode`,
 * con le condizioni degli at-rule che le contengono (in dev Vite inietta il CSS
 * di `src/index.css` in un `<style>` same-origin, quindi `cssRules` è leggibile).
 *
 * La ricorsione non guarda il tipo dell'at-rule ma la sola presenza di
 * `cssRules`: così funziona anche se Tailwind v4 avvolge il foglio in `@layer`
 * o `@supports`, e la condizione `print` viene cercata lungo tutta la catena.
 */
/**
 * Raccoglie dai fogli di stile **tutte** le regole che citano `data-print-mode`,
 * con le condizioni degli at-rule che le contengono (in dev Vite inietta il CSS
 * di `src/index.css` in un `<style>` same-origin, quindi `cssRules` è leggibile).
 *
 * La discesa avviene sugli at-rule (`@media`, `@layer`, `@supports`) e **non**
 * sulle regole di stile: da quando esiste il CSS nesting anche un `CSSStyleRule`
 * espone `cssRules` (vuoto se non annidato), quindi la discriminante corretta è
 * l'assenza di `selectorText`, non la presenza di `cssRules`.
 */
const CLEAN_PRINT_RULES = `
  const found = [];
  let sheets = 0;
  let visited = 0;
  let blocked = 0;
  const walk = (rules, conditions) => {
    for (const rule of Array.from(rules)) {
      visited += 1;
      if (rule.selectorText) {
        if (String(rule.selectorText).includes('data-print-mode')) {
          found.push({
            // Le virgolette dell'attributo possono sparire nella minificazione.
            selectors: String(rule.selectorText).replace(/"/g, ''),
            media: conditions.join(' && '),
            cssText: rule.style ? rule.style.cssText : '',
          });
        }
        continue;
      }
      if (rule.cssRules) {
        const own = rule.conditionText || (rule.media && rule.media.mediaText) || rule.name || '';
        walk(rule.cssRules, own ? conditions.concat(own) : conditions);
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    sheets += 1;
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch {
      // Foglio di origine diversa: non ispezionabile, viene solo contato.
      blocked += 1;
      rules = null;
    }
    if (rules) walk(rules, []);
  }
  return { found, sheets, visited, blocked };
`;

/**
 * Fotografa la **resa reale** del foglio di stampa sotto il media corrente:
 * `display` di interfaccia e scheda, e geometria di pagina e disegno. Va letto
 * con `Emulation.setEmulatedMedia({ media: 'print' })` attivo, perché le regole
 * della modalità vivono tutte dentro `@media print`.
 */
const PRINT_LAYOUT_PROBE = `
  const snap = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      display: cs.display,
      gap: cs.gap,
      justifyContent: cs.justifyContent,
      alignItems: cs.alignItems,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };
  return {
    mode: document.documentElement.getAttribute('data-print-mode'),
    screenApp: snap('#screen-app'),
    report: snap('#print-report'),
    page: snap('#print-report .print-page-first'),
    header: snap('#print-report header'),
    table: snap('#print-report .print-table'),
    drawing: snap('#print-report .print-drawing'),
  };
`;

/**
 * `true` se nella regola c'è una dichiarazione (o un frammento di selettore):
 * il confronto è case-insensitive e ignora gli spazi, così non dipende dalla
 * formattazione con cui il browser riserializza il CSS.
 */
const ruleHas = (rule, needle) => {
  const haystack = `${rule.selectors} ${rule.cssText}`.toLowerCase().replace(/\s+/g, ' ');
  return haystack.includes(needle.toLowerCase().replace(/\s+/g, ' '));
};

/**
 * `true` se il PDF è **puramente vettoriale**: nessuna immagine raster
 * incorporata (né JPEG `/DCTDecode` né `XObject` immagine di altro tipo). È la
 * prova che la stampa non passa più da uno snapshot rasterizzato.
 */
const isVectorOnlyPdf = (text) =>
  !/\/Subtype\s*\/Image/.test(text) && !/DCTDecode/.test(text) && !/\/JPXDecode/.test(text);

/* --- Script ----------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();

  // Cartella di download reale (fuori dal watcher Vite: `tmp/**`): la stampa a
  // modalità non scarica più alcun file, ma la si mantiene come rete di sicurezza
  // per l'eventuale fallback di download classico di "Salva con nome", che non
  // deve mai sporcare la cartella Download dell'operatore.
  const workDir = resolve('tmp', 'icon-toolbar-verify');
  const downloadDir = join(workDir, 'downloads');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(downloadDir, { recursive: true });

  const profileDir = mkdtempSync(join(tmpdir(), 'icon-toolbar-profile-'));
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
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: true,
    });

    await cdp.send('Page.navigate', { url: DEV_URL });
    await waitFor(
      async () => cdp.eval(`return document.getElementById('btn-print-clean') ? 1 : 0;`),
      12000,
      'mount della toolbar'
    );
    await sleep(300);

    /* --- 1) Toolbar geometrica 2 × 3 a sole icone ------------------------- */
    const toolbar = await cdp.eval(TOOLBAR_SNAPSHOT);
    const found = toolbar.commands.filter((c) => !c.missing);

    check(
      'Toolbar: tutti e sei i comandi presenti nella plancia',
      found.length === 6,
      toolbar.commands.filter((c) => c.missing).map((c) => c.id).join(', ') || 'tutti presenti'
    );

    check(
      'Toolbar: ogni pulsante ha UNA icona 16 px, nessun testo visibile (etichetta in `span.sr-only`)',
      found.every(
        (c) =>
          c.svgCount === 1 &&
          c.textNodes === 0 &&
          c.visibleChildren.length === 1 &&
          c.visibleChildren[0].tag === 'span' &&
          c.visibleChildren[0].srOnly &&
          c.visibleChildren[0].cls.includes('sr-only')
      ),
      found
        .map((c) => `${c.id}:${c.svgCount}svg/${c.visibleChildren.length}span`)
        .join(' · ')
    );

    check(
      'Toolbar: etichette accessibili `sr-only` corrette e nascoste (absolute, 1 px)',
      found.every(
        (c) =>
          c.srText === COMMANDS.find((cmd) => cmd.id === c.id).label &&
          c.srPosition === 'absolute' &&
          c.srWidth === '1px'
      ),
      found.map((c) => `${c.id}="${c.srText}"`).join(' · ')
    );

    check(
      'Toolbar: tooltip esaustivo su ogni comando',
      found.every((c) =>
        c.title.toLowerCase().includes(COMMANDS.find((cmd) => cmd.id === c.id).tooltip.toLowerCase())
      ),
      found.map((c) => `${c.id}="${c.title}"`).join(' · ')
    );

    const row1 = found.slice(0, 3).map((c) => c.box);
    const row2 = found.slice(3).map((c) => c.box);
    const sameRow = (row) => row.every((b) => b.y === row[0].y && b.h === row[0].h);
    const uniform = (row) => row.every((b) => Math.abs(b.w - row[0].w) <= 1);
    const spread = (row) => row[1].x > row[0].x && row[2].x > row[1].x;

    check(
      'Toolbar: due righe da tre colonne uniformi (36 px di alto, larghezze uguali)',
      sameRow(row1) && sameRow(row2) && uniform(row1) && uniform(row2) && spread(row1) && spread(row2),
      `riga1 ${row1.map((b) => `${b.w}×${b.h}@${b.x}`).join(' ')} · riga2 ${row2
        .map((b) => `${b.w}×${b.h}@${b.x}`)
        .join(' ')}`
    );

    check(
      'Toolbar: riga 1 (File) sopra la riga 2 (Output), con lo stesso passo orizzontale',
      row2[0].y >= row1[0].bottom &&
        row1[1].x - row1[0].x === row2[1].x - row2[0].x &&
        row1[0].x === row2[0].x,
      `row1.y=${row1[0].y} (bottom ${row1[0].bottom}) … row2.y=${row2[0].y}, passo ${row1[1].x - row1[0].x}px`
    );

    check(
      'Toolbar: nessuna etichetta visibile residua (`Salva Piano`, `Stampa / PDF` spariti)',
      !toolbar.toolbarText.includes('Salva Piano') &&
        !toolbar.toolbarText.includes('Stampa / PDF') &&
        COMMANDS.every((cmd) => toolbar.toolbarText.includes(cmd.label)),
      `"${toolbar.toolbarText}"`
    );

    check(
      'Badge `#active-file-badge` assente a riposo (nessun file agganciato)',
      toolbar.badge === null,
      toolbar.badge ? `presente: "${toolbar.badge.text}"` : 'assente'
    );

    /* --- 2) Stampa "Solo Grafica": ciclo di vita di `data-print-mode` ------ *
     *  `window.print()` in headless non ha dialogo né anteprima e non emette
     *  `afterprint`: viene quindi sostituito da una spia contabile, mentre la
     *  resa reale del foglio è verificata più sotto con il media di stampa
     *  emulato (§ 5) e con il PDF prodotto dal motore di stampa (§ 3). */
    const plateSet = await setTextInput(cdp, 'vehicle-plate-input', PLATE);
    // Carico di prova non banale: due PLT INDU a piatto, così il foglio stampato
    // contiene davvero colli, targa e quote (e non la sola sagoma del pianale).
    await clickElement(cdp, 'quick-piatto-INDU');
    await clickElement(cdp, 'quick-piatto-INDU');
    await waitFor(
      async () =>
        cdp.eval(`return document.querySelectorAll('[data-canvas-item]').length === 2 ? 1 : 0;`),
      4000,
      'due colli in scena'
    );

    /** Sostituisce `window.print` con una spia contabile (nessun dialogo reale). */
    const installPrintSpy = () =>
      cdp.eval(`
        window.__printCalls = 0;
        window.print = () => { window.__printCalls += 1; };
        return true;
      `);

    /** Stato del ciclo di vita: modalità richiesta e chiamate a `window.print`. */
    const printState = () =>
      cdp.eval(`
        return {
          mode: document.documentElement.getAttribute('data-print-mode'),
          calls: window.__printCalls,
        };
      `);

    /** Chiude a mano il dialogo di stampa, che in headless non esiste. */
    const finishPrinting = () =>
      cdp.eval(`window.dispatchEvent(new Event('afterprint')); return true;`);

    /**
     * Testo della scheda di stampa (`#print-report`): vive nel DOM accanto
     * all'app ma resta invisibile a schermo. Serve a provare che il foglio da
     * stampare descrive il carico reale — targa del mezzo e colli in scena — e
     * non una sagoma vuota.
     */
    const sheetText = () =>
      cdp.eval(`
        const sheet = document.getElementById('print-report');
        return sheet ? sheet.textContent : '';
      `);

    await installPrintSpy();
    await clickElement(cdp, 'btn-print-clean');
    const afterCleanClick = await printState();
    check(
      'Stampa Solo Grafica: il click su `#btn-print-clean` imposta `data-print-mode="clean"` su `<html>` e chiama `window.print()`',
      afterCleanClick.mode === 'clean' && afterCleanClick.calls === 1,
      `data-print-mode=${JSON.stringify(afterCleanClick.mode)}, window.print() × ${afterCleanClick.calls}`
    );
    const sheet = await sheetText();
    const plateOnSheet = sheet.includes(PLATE);
    const loadOnSheet = /PLT\s*INDU/i.test(sheet);
    check(
      'Stampa Solo Grafica: il foglio da stampare descrive il carico reale (targa e colli in scena)',
      plateSet === PLATE && plateOnSheet && loadOnSheet,
      `targa "${plateSet}" ${plateOnSheet ? 'presente' : 'assente'}, colli ${
        loadOnSheet ? 'elencati' : 'assenti'
      }`
    );

    /* --- 3) PDF vettoriale leggero dal motore di stampa ------------------- *
     *  Con la modalità `clean` ancora attiva si chiede a Chrome il PDF che il
     *  suo stesso dialogo di stampa produrrebbe: deve essere **privo di immagini
     *  raster** — la grafica è vettoriale, non più uno snapshot JPEG — e di peso
     *  contenuto. Il file resta in `shots/` come evidenza ispezionabile. */
    const printed = await cdp.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
    });
    const pdfBytes = Buffer.from(printed.data, 'base64');
    const pdfText = pdfBytes.toString('latin1');
    const pdfKb = pdfBytes.length / 1024;

    mkdirSync('shots', { recursive: true });
    writeFileSync(join(...PRINT_EVIDENCE), pdfBytes);
    console.log(
      `Evidenza: ${PRINT_EVIDENCE.join('/')} (${pdfKb.toFixed(1)} kB, ${
        isVectorOnlyPdf(pdfText) ? 'vettoriale' : 'contiene raster'
      })`
    );

    check(
      'Stampa Solo Grafica: il PDF del motore di stampa è strutturalmente valido (`%PDF-` … `%%EOF`)',
      pdfText.startsWith('%PDF-') && pdfText.trimEnd().endsWith('%%EOF'),
      `"${pdfText.slice(0, 8)}" · ${pdfKb.toFixed(1)} kB`
    );
    check(
      'Stampa Solo Grafica: PDF **vettoriale** — nessuna immagine raster incorporata (niente `/DCTDecode`)',
      isVectorOnlyPdf(pdfText),
      isVectorOnlyPdf(pdfText)
        ? 'nessun `/Subtype /Image` nel documento'
        : 'immagine raster trovata nel PDF'
    );
    check(
      'Stampa Solo Grafica: PDF leggero (la grafica vettoriale resta ben sotto i 150 kB)',
      pdfBytes.length < 150 * 1024,
      `${pdfKb.toFixed(1)} kB`
    );

    await finishPrinting();
    const afterCleanPrint = await printState();
    check(
      "Stampa Solo Grafica: `afterprint` rimuove l'attributo e il documento torna identico a prima",
      afterCleanPrint.mode === null,
      `data-print-mode=${JSON.stringify(afterCleanPrint.mode)}`
    );

    await clickElement(cdp, 'btn-print-report');
    const afterReportClick = await printState();
    check(
      'Stampa Scheda Completa: il click su `#btn-print-report` imposta `data-print-mode="full"` e chiama `window.print()`',
      afterReportClick.mode === 'full' && afterReportClick.calls === 2,
      `data-print-mode=${JSON.stringify(afterReportClick.mode)}, window.print() × ${afterReportClick.calls}`
    );
    await finishPrinting();
    const afterReportPrint = await printState();
    check(
      "Stampa Scheda Completa: `afterprint` rimuove l'attributo e il documento torna identico a prima",
      afterReportPrint.mode === null,
      `data-print-mode=${JSON.stringify(afterReportPrint.mode)}`
    );

    /* --- 4) Regole `@media print` della modalità `clean` ------------------ *
     *  Le regole devono esistere **dentro** `@media print`: è la condizione che
     *  le rende attive solo su carta, lasciando intatto lo schermo interattivo. */
    const ruleScan = await cdp.eval(CLEAN_PRINT_RULES);
    const cleanRules = ruleScan.found;
    const printScoped = cleanRules.filter((r) => r.media.includes('print'));

    check(
      'Modalità `clean`: le regole esistono nei fogli di stile dentro `@media print`',
      printScoped.length >= 3,
      `${cleanRules.length} regole con \`data-print-mode\` su ${ruleScan.visited} ispezionate in ${
        ruleScan.sheets
      } fogli (${ruleScan.blocked} illeggibili)`
    );
    check(
      'Modalità `clean`: intestazione, tabella, Pagina 2 e nota di rinvio sono `display: none !important`',
      printScoped.some(
        (r) =>
          ruleHas(r, '#print-report header') &&
          ruleHas(r, '#print-report .print-table') &&
          ruleHas(r, '#print-report .print-page-second') &&
          ruleHas(r, '[data-print-multipage-note]') &&
          ruleHas(r, 'display: none') &&
          ruleHas(r, 'important')
      ),
      printScoped.map((r) => r.selectors).join(' | ') || 'nessuna regola trovata'
    );
    check(
      'Modalità `clean`: la prima pagina centra il disegno a piena altezza (277 mm, gap 0) e il disegno occupa il 100%',
      printScoped.some(
        (r) =>
          ruleHas(r, '.print-page-first') &&
          ruleHas(r, 'height: 277mm') &&
          ruleHas(r, 'justify-content: center') &&
          ruleHas(r, 'gap: 0')
      ) &&
        printScoped.some(
          (r) =>
            ruleHas(r, '.print-drawing') &&
            ruleHas(r, 'width: 100%') &&
            ruleHas(r, 'height: 100%')
        ),
      printScoped.map((r) => r.cssText).join(' | ') || 'nessuna regola trovata'
    );

    /* --- 5) Resa reale del foglio sotto media di stampa ------------------- *
     *  `Emulation.setEmulatedMedia` fa valutare al browser le vere regole
     *  `@media print`: si controlla l'effetto sull'impaginazione — quello che
     *  l'operatore vede nel dialogo di stampa e nel PDF salvato. I due comandi
     *  vengono azionati con un click programmatico sul pulsante reale: sotto
     *  media di stampa l'interfaccia è `display: none` e non è più cliccabile
     *  con un gesto del mouse, ma l'handler di React risponde lo stesso. */
    await cdp.send('Emulation.setEmulatedMedia', { media: 'print' });

    await cdp.eval(`document.getElementById('btn-print-clean').click(); return true;`);
    const cleanSheet = await cdp.eval(PRINT_LAYOUT_PROBE);
    check(
      'Modalità `clean` su carta: interfaccia nascosta, scheda visibile, intestazione e tabella soppresse',
      cleanSheet.mode === 'clean' &&
        cleanSheet.screenApp !== null &&
        cleanSheet.screenApp.display === 'none' &&
        cleanSheet.report !== null &&
        cleanSheet.report.display !== 'none' &&
        cleanSheet.header !== null &&
        cleanSheet.header.display === 'none' &&
        (cleanSheet.table === null || cleanSheet.table.display === 'none'),
      `mode=${cleanSheet.mode}, #screen-app=${cleanSheet.screenApp?.display}, #print-report=${
        cleanSheet.report?.display
      }, header=${cleanSheet.header?.display}, tabella=${cleanSheet.table?.display ?? 'assente'}`
    );
    check(
      "Modalità `clean` su carta: il disegno riempie l'intera pagina A4 (centrato, gap 0)",
      cleanSheet.page !== null &&
        cleanSheet.drawing !== null &&
        cleanSheet.page.justifyContent === 'center' &&
        cleanSheet.page.alignItems === 'center' &&
        cleanSheet.page.gap === '0px' &&
        cleanSheet.drawing.height >= cleanSheet.page.height - 2 &&
        Math.abs(cleanSheet.drawing.width - cleanSheet.page.width) <= 2,
      `pagina ${cleanSheet.page?.width}×${cleanSheet.page?.height} px (gap ${cleanSheet.page?.gap}, ` +
        `justify ${cleanSheet.page?.justifyContent}), disegno ${cleanSheet.drawing?.width}×${cleanSheet.drawing?.height} px`
    );
    await finishPrinting();

    await cdp.eval(`document.getElementById('btn-print-report').click(); return true;`);
    const fullSheet = await cdp.eval(PRINT_LAYOUT_PROBE);
    check(
      'Modalità `full` su carta: intestazione e tabella restano visibili (scheda tecnica completa)',
      fullSheet.mode === 'full' &&
        fullSheet.header !== null &&
        fullSheet.header.display !== 'none' &&
        fullSheet.table !== null &&
        fullSheet.table.display !== 'none' &&
        fullSheet.drawing !== null &&
        fullSheet.page !== null &&
        fullSheet.drawing.height < fullSheet.page.height,
      `header=${fullSheet.header?.display}, tabella=${fullSheet.table?.display}, disegno ${
        fullSheet.drawing?.height
      } px su pagina ${fullSheet.page?.height} px`
    );
    await finishPrinting();
    // Torna allo schermo: le verifiche successive misurano la plancia reale.
    await cdp.send('Emulation.setEmulatedMedia', { media: 'screen' });

    const afterAllPrints = await printState();
    check(
      'Stampa a modalità: nessun attributo residuo e schermo interattivo intatto',
      afterAllPrints.mode === null && afterAllPrints.calls === 4,
      `data-print-mode=${JSON.stringify(afterAllPrints.mode)}, window.print() × ${afterAllPrints.calls}`
    );

    /* --- 6) "Salva con nome" con file già agganciato ---------------------- */
    await installFakeHandles(cdp, [FIRST_FILE_NAME, COPY_FILE_NAME]);
    await shimSavePicker(cdp, [FIRST_FILE_NAME]);
    await clickElement(cdp, 'btn-save-project');
    const afterFirstSave = await waitFor(
      async () => {
        const snap = await cdp.eval(TOOLBAR_SNAPSHOT);
        return snap.badge && snap.badge.text.includes(FIRST_FILE_NAME) ? snap : null;
      },
      5000,
      'badge del file attivo dopo il primo salvataggio'
    ).catch(() => cdp.eval(TOOLBAR_SNAPSHOT));

    check(
      'Badge `#active-file-badge` acceso dal salvataggio, sotto la seconda riga della toolbar',
      afterFirstSave.badge !== null &&
        afterFirstSave.badge.text.includes(FIRST_FILE_NAME) &&
        afterFirstSave.badge.title === `File attualmente aperto: ${FIRST_FILE_NAME}` &&
        afterFirstSave.badge.box.y >= row2[0].bottom,
      afterFirstSave.badge
        ? `"${afterFirstSave.badge.text}" @ y=${afterFirstSave.badge.box.y} (riga 2: ${row2[0].bottom})`
        : 'badge assente'
    );

    // Evidenza grafica (primo piano 2×): toolbar a sei icone + badge del file.
    mkdirSync('shots', { recursive: true });
    const toolbarClip = await cdp.eval(`
      const wrap = document.getElementById('btn-copy-image').parentElement.parentElement;
      const r = wrap.getBoundingClientRect();
      return { x: Math.max(0, r.left - 12), y: Math.max(0, r.top - 12), width: r.width + 24, height: r.height + 24 };
    `);
    const toolbarShot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { ...toolbarClip, scale: 2 },
    });
    writeFileSync(
      join('shots', 'toolbar-sei-icone.png'),
      Buffer.from(toolbarShot.data, 'base64')
    );
    console.log('Evidenza grafica: shots/toolbar-sei-icone.png');

    // Il feedback verde dura 2 s: si attende che si spenga per leggere il
    // tooltip a riposo (e si verifica di passaggio che si spenga davvero).
    await waitFor(
      async () => {
        const title = await cdp.eval(
          `return document.getElementById('btn-save-project').getAttribute('title');`
        );
        return title.includes('Ctrl / Cmd + S') ? title : null;
      },
      4000,
      'spegnimento del feedback `Salvato!`'
    );

    const saveTooltip = await cdp.eval(`
      return {
        save: document.getElementById('btn-save-project').getAttribute('title'),
        saveAs: document.getElementById('btn-save-as-project').getAttribute('title'),
        open: document.getElementById('btn-open-project').getAttribute('title'),
      };
    `);
    check(
      'Tooltip dinamici: `Salva` nomina il file attivo, `Salva con nome` la nuova copia, `Apri` il .json',
      saveTooltip.save.includes(FIRST_FILE_NAME) &&
        saveTooltip.save.includes('Ctrl / Cmd + S') &&
        saveTooltip.saveAs.includes('nuova copia') &&
        saveTooltip.open.toLowerCase().includes('.json'),
      `salva="${saveTooltip.save}" · con nome="${saveTooltip.saveAs}"`
    );

    // "Salva con nome" con un file già agganciato: il selettore DEVE riaprirsi e
    // deve restituire un **nuovo** handle (la copia), non quello attivo.
    await shimSavePicker(cdp, [COPY_FILE_NAME]);
    await cdp.eval(`window.__writes = []; return 1;`);
    await clickElement(cdp, 'btn-save-as-project');
    const afterSaveAs = await waitFor(
      async () => {
        const snap = await cdp.eval(`
          const state = { calls: window.__pickerCalls, writes: (window.__writes ?? []).map((w) => w.name) };
          const badge = document.getElementById('active-file-badge');
          state.badge = badge ? badge.textContent.trim() : null;
          state.saveTitle = document.getElementById('btn-save-project').getAttribute('title');
          return state;
        `);
        return snap.badge && snap.badge.includes(COPY_FILE_NAME) ? snap : null;
      },
      5000,
      'nuova copia creata da "Salva con nome"'
    ).catch(() => null);

    check(
      '`Salva con nome` con file già agganciato: riapre il selettore e scrive una NUOVA copia',
      afterSaveAs !== null &&
        afterSaveAs.calls === 1 &&
        afterSaveAs.writes.length === 2 &&
        afterSaveAs.writes.every((name) => name === COPY_FILE_NAME),
      afterSaveAs
        ? `${afterSaveAs.calls} selettore, scritture su ${afterSaveAs.writes.join('/')}, badge "${afterSaveAs.badge}"`
        : 'nessuna nuova copia'
    );

    check(
      '`Salva con nome` sposta il file attivo sulla copia e mostra il feedback `Salvato su …!`',
      afterSaveAs !== null &&
        afterSaveAs.saveTitle === `Salvato su ${COPY_FILE_NAME}!` &&
        afterSaveAs.writes.length === 2,
      afterSaveAs ? afterSaveAs.saveTitle : 'n/d'
    );

    // Annullamento del selettore: nessun avviso, nessuna scrittura, badge intatto.
    await shimSavePicker(cdp, ['abort']);
    await cdp.eval(`window.__writes = []; return 1;`);
    cdp.dialogs.length = 0;
    await clickElement(cdp, 'btn-save-as-project');
    await sleep(500);
    const afterAbort = await cdp.eval(`
      const badge = document.getElementById('active-file-badge');
      return {
        badge: badge ? badge.textContent.trim() : null,
        writes: (window.__writes ?? []).length,
        calls: window.__pickerCalls,
      };
    `);
    check(
      '`Salva con nome` annullato: uscita silenziosa (nessun `alert`, nessuna scrittura, badge invariato)',
      afterAbort.badge !== null &&
        afterAbort.badge.includes(COPY_FILE_NAME) &&
        afterAbort.writes === 0 &&
        afterAbort.calls === 1 &&
        cdp.dialogs.length === 0,
      `badge="${afterAbort.badge}", scritture=${afterAbort.writes}, dialoghi=${cdp.dialogs.length}`
    );

    /* --- 7) Console pulita ------------------------------------------------ */
    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    console.log(`\n${passed}/${passed + failed} controlli superati`);
    console.log(
      `Durata della verifica: ${((Date.now() - startedAt) / 1000).toFixed(2)} s (limite ${WATCHDOG_MS / 1000} s)`
    );
    console.log(`Download isolati in: ${downloadDir}`);
    console.log(`Evidenze della stampa in: ${join(...PRINT_EVIDENCE)}`);
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
