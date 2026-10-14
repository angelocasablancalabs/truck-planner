/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — TOOLBAR A SEI ICONE & PDF DIRETTO "SOLO GRAFICA"
 *
 *  Pilota Chrome reale via Chrome DevTools Protocol (zero dipendenze aggiunte)
 *  e verifica, end-to-end, la nuova plancia comandi:
 *
 *    1. **Toolbar geometrica 2 × 3**: sei pulsanti a **sole icone** disposti su
 *       due righe da tre colonne uniformi (`grid-cols-3`, alto 36 px ciascuno),
 *       con il testo descrittivo confinato nel `title` (tooltip) e in uno
 *       `span.sr-only` — nessuna etichetta visibile;
 *    2. **Ordine dei comandi**: riga 1 = `Copia Immagine` · `PDF Solo Grafica` ·
 *       `Stampa Piano`; riga 2 = `Salva` · `Salva con nome` · `Apri Piano`;
 *    3. **Badge `#active-file-badge`** sotto la seconda riga, acceso dal
 *       salvataggio;
 *    4. **PDF diretto**: il modulo `src/utils/pdfExport.ts` produce un PDF 1.4
 *       strutturalmente valido — header, tavola `xref` con offset reali,
 *       `/Length` dei flussi esatti, immagine JPEG `/DCTDecode` con le stesse
 *       proporzioni dello snapshot pulito di `Copia Immagine` (quindi **non** la
 *       scheda A4 formale) — e lo scarica come `piano-<TARGA>-<data>.pdf`;
 *    5. **"Salva con nome"**: con un file già agganciato forza comunque il
 *       selettore nativo, crea una **nuova copia** e sposta lì il file attivo;
 *       se l'operatore annulla non succede nulla e non compare alcun avviso.
 *
 *  Nota di metodo: Chrome headless espone la File System Access API ma non può
 *  mostrare i dialoghi nativi, quindi i selettori sono sostituiti da doppi
 *  controllabili installati nella pagina (`Object.defineProperty`).
 *
 *  Uso:  node scripts/verify-icon-toolbar.mjs [url]
 *  (default `http://localhost:5173/truck-planner/`)
 *  Chiude sempre con `Browser.close()` + `process.exit(...)` entro 45 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://localhost:5173/truck-planner/';
/** Percorso del modulo PDF sul dev server (prefissato con la `base` di Vite). */
const MODULE_URL = '/truck-planner/src/utils/pdfExport.ts';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9341);
const WATCHDOG_MS = 45000;
const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Estensione del **visualizzatore PDF interno** di Chrome: quando compare fra i
 * target della pagina, il documento è stato riconosciuto come `application/pdf`
 * e affidato al motore PDF del browser (prova di leggibilità reale del file).
 */
const CHROME_PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai';

/** I sei comandi attesi, nell'ordine visivo (riga per riga, sinistra → destra). */
const COMMANDS = [
  { id: 'btn-copy-image', label: 'Copia Immagine', tooltip: 'appunti' },
  { id: 'btn-export-pdf', label: 'PDF Solo Grafica', tooltip: 'PDF' },
  { id: 'btn-print-report', label: 'Stampa Piano', tooltip: 'Stampa' },
  { id: 'btn-save-project', label: 'Salva', tooltip: 'Salva' },
  { id: 'btn-save-as-project', label: 'Salva con nome', tooltip: 'Salva con nome' },
  { id: 'btn-open-project', label: 'Apri Piano', tooltip: 'Apri' },
];

/** A4 verticale in punti e margine di 10 mm usati dal generatore PDF. */
const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const A4_MARGIN_PT = 28.35;
/** Data ISO del giorno: entra nel nome dei file scaricati. */
const TODAY = new Date().toISOString().slice(0, 10);
/** Targa usata per il nome del PDF scaricato. */
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

/* --- Validazione byte-per-byte del PDF prodotto --------------------------- */

/**
 * Convalida la struttura del PDF scaricato: header, tavola `xref` con offset
 * reali (ogni voce deve puntare al proprio `N 0 obj`), `/Length` dichiarati
 * uguali ai byte effettivamente presenti nei due flussi, immagine JPEG integra
 * (`SOI`/`EOI`) e impaginazione A4 centrata dentro i margini di 10 mm.
 */
const inspectPdf = (bytes) => {
  const text = bytes.toString('latin1');
  const out = {
    header: text.slice(0, 8),
    eof: text.trimEnd().endsWith('%%EOF'),
    xrefOffset: null,
    xrefHeader: null,
    xrefOk: false,
    objects: [],
    mediaBox: (text.match(/\/MediaBox \[([^\]]+)\]/) || [])[1] || null,
    filters: [...text.matchAll(/\/Filter \/(\w+)/g)].map((m) => m[1]),
    fontResources: /\/Font/.test(text) || /\/Type \/Font/.test(text),
    imageWidth: Number((text.match(/\/Subtype \/Image[\s\S]*?\/Width (\d+)/) || [])[1]),
    imageHeight: Number((text.match(/\/Subtype \/Image[\s\S]*?\/Height (\d+)/) || [])[1]),
    imageStreamOk: false,
    contentStreamOk: false,
    cm: null,
  };

  const startxrefAt = text.lastIndexOf('startxref');
  if (startxrefAt >= 0) {
    out.xrefOffset = Number(text.slice(startxrefAt + 'startxref'.length).trim().split('\n')[0].trim());
    out.xrefHeader = text.slice(out.xrefOffset, out.xrefOffset + 16);
  }

  // Tavola xref: `xref`, riga `0 N`, poi una voce da 20 byte per oggetto.
  const size = Number((out.xrefHeader || '').match(/xref\n0 (\d+)/)?.[1]);
  if (size > 1) {
    const headerLength = `xref\n0 ${size}\n`.length;
    const entries = [];
    for (let i = 1; i < size; i += 1) {
      const at = out.xrefOffset + headerLength + i * 20;
      const offset = Number(text.slice(at, at + 10));
      entries.push({ object: i, offset, pointsAt: text.slice(offset, offset + 12) });
    }
    out.objects = entries;
    out.xrefOk = entries.every((e) => e.pointsAt.startsWith(`${e.object} 0 obj`));
  }

  // Flusso immagine (oggetto 5): `/Length` dichiarato = byte reali.
  const imageObj = text.indexOf('5 0 obj');
  if (imageObj >= 0) {
    const declared = Number(text.slice(imageObj, imageObj + 400).match(/\/Length (\d+)/)?.[1]);
    const streamStart = bytes.indexOf(Buffer.from('stream\n'), imageObj) + 'stream\n'.length;
    const streamEnd = bytes.indexOf(Buffer.from('\nendstream'), streamStart);
    const stream = bytes.subarray(streamStart, streamEnd);
    out.imageStreamOk =
      stream.length === declared &&
      stream[0] === 0xff &&
      stream[1] === 0xd8 &&
      stream[stream.length - 2] === 0xff &&
      stream[stream.length - 1] === 0xd9;
    out.imageStreamLength = stream.length;
    out.imageDeclaredLength = declared;
  }

  // Flusso di contenuto (oggetto 4): `/Length` dichiarato = byte reali.
  const contentObj = text.indexOf('4 0 obj');
  if (contentObj >= 0) {
    const declared = Number(text.slice(contentObj, contentObj + 200).match(/\/Length (\d+)/)?.[1]);
    const streamStart = bytes.indexOf(Buffer.from('stream\n'), contentObj) + 'stream\n'.length;
    const streamEnd = bytes.indexOf(Buffer.from('\nendstream'), streamStart);
    const stream = bytes.subarray(streamStart, streamEnd);
    out.contentStreamOk = stream.length === declared;
    const cm = stream.toString('latin1').match(
      /q\n([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm\n\/Im1 Do\nQ/
    );
    if (cm) out.cm = { width: Number(cm[1]), height: Number(cm[2]), x: Number(cm[3]), y: Number(cm[4]) };
  }

  out.fitsMargins =
    out.cm !== null &&
    out.cm.width <= A4_WIDTH_PT - A4_MARGIN_PT * 2 + 0.51 &&
    out.cm.height <= A4_HEIGHT_PT - A4_MARGIN_PT * 2 + 0.51 &&
    out.cm.x >= A4_MARGIN_PT - 0.51 &&
    out.cm.y >= A4_MARGIN_PT - 0.51 &&
    Math.abs(out.cm.x - (A4_WIDTH_PT - out.cm.width) / 2) < 0.02 &&
    Math.abs(out.cm.y - (A4_HEIGHT_PT - out.cm.height) / 2) < 0.02;

  return out;
};

/* --- Script ----------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();

  // Cartella di download reale (fuori dal watcher Vite: `tmp/**`).
  const workDir = resolve('tmp', 'icon-toolbar-verify');
  const downloadDir = join(workDir, 'downloads');
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(downloadDir, { recursive: true });

  /** File PDF davvero scaricati dal browser. */
  const downloadedPdfs = () =>
    existsSync(downloadDir) ? readdirSync(downloadDir).filter((f) => f.endsWith('.pdf')) : [];

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
      async () => cdp.eval(`return document.getElementById('btn-export-pdf') ? 1 : 0;`),
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
      'Toolbar: riga 1 (Output) sopra la riga 2 (File), con lo stesso passo orizzontale',
      row2[0].y > row1[0].bottom &&
        row1[1].x - row1[0].x === row2[1].x - row2[0].x &&
        row1[0].x === row2[0].x,
      `row1.y=${row1[0].y} … row2.y=${row2[0].y}, passo ${row1[1].x - row1[0].x}px`
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

    /* --- 2) Modulo PDF: API pubblica ------------------------------------- */
    const moduleInfo = await cdp.eval(`
      try {
        const mod = await import(${JSON.stringify(MODULE_URL)});
        return { available: true, isFunction: typeof mod.exportCleanPianoToPdf === 'function', exports: Object.keys(mod) };
      } catch (error) {
        return { available: false, message: String(error) };
      }
    `);
    check(
      'Modulo `src/utils/pdfExport.ts`: esporta `exportCleanPianoToPdf`',
      moduleInfo.available === true && moduleInfo.isFunction === true,
      moduleInfo.available ? moduleInfo.exports.join(', ') : moduleInfo.message
    );
    if (!moduleInfo.available) throw new Error('modulo PDF non importabile: verifiche interrotte');

    /* --- 3) PDF diretto "solo grafica" ----------------------------------- */
    const plateSet = await setTextInput(cdp, 'vehicle-plate-input', PLATE);
    // Carico di prova non banale: due PLT INDU a piatto, così il PDF contiene
    // davvero colli, targa e quote (e non solo la sagoma vuota del pianale).
    await clickElement(cdp, 'quick-piatto-INDU');
    await clickElement(cdp, 'quick-piatto-INDU');
    await waitFor(
      async () =>
        cdp.eval(`return document.querySelectorAll('[data-canvas-item]').length === 2 ? 1 : 0;`),
      4000,
      'due colli in scena'
    );
    // Geometria reale dei colli piazzati dal motore first-fit dell'app.
    const placedItems = await cdp.eval(`
      return [...document.querySelectorAll('[data-canvas-item]')].map((g) => {
        const rect = g.querySelector('rect');
        const t = /translate\\(([-\\d.]+),\\s*([-\\d.]+)\\)/.exec(g.getAttribute('transform') || '');
        return {
          id: g.getAttribute('data-canvas-item') + '_' + Math.round(Number(rect.getAttribute('x') ?? 0)),
          code: g.getAttribute('data-canvas-item'),
          name: 'PLT INDU',
          width: Number(rect.getAttribute('width')),
          length: Number(rect.getAttribute('height')),
          x: t ? Number(t[1]) : 0,
          y: t ? Number(t[2]) : 0,
          rotation: 90,
          color: '#E2E8F0',
          borderColor: '#334155',
        };
      });
    `);
    // Proporzioni attese dell'immagine: le stesse dello snapshot pulito usato
    // da "Copia Immagine" (NON quelle della scheda A4 formale, che è verticale).
    const expected = await cdp.eval(`
      const mod = await import('/truck-planner/src/utils/export.ts');
      const vehicle = { id: 'bilico_cc', name: 'Bilico', width: 250, length: 1328 };
      const snapshot = mod.buildPianoSvg(
        vehicle,
        ${JSON.stringify(placedItems)},
        'all',
        [],
        ${JSON.stringify(PLATE)}
      );
      return { width: snapshot.width, height: snapshot.height, items: ${placedItems.length} };
    `);

    await clickElement(cdp, 'btn-export-pdf');
    const pdfFiles = await waitFor(
      () => {
        const files = downloadedPdfs();
        return files.length > 0 ? files : null;
      },
      20000,
      'download del PDF'
    ).catch(() => null);

    const expectedName = `piano-${PLATE}-${TODAY}.pdf`;
    /** Vero se il file atteso è stato scaricato e analizzato: abilita l'ultimo passo. */
    const pdfDownloaded = pdfFiles !== null && pdfFiles.includes(expectedName);
    check(
      `PDF scaricato come \`${expectedName}\` (stessa convenzione del file .json)`,
      pdfFiles !== null && pdfFiles.includes(expectedName) && plateSet === PLATE,
      `${pdfFiles?.join(', ') ?? 'nessun file'} (targa "${plateSet}")`
    );

    if (pdfFiles && pdfFiles.includes(expectedName)) {
      const bytes = readFileSync(join(downloadDir, expectedName));
      const pdf = inspectPdf(bytes);

      check(
        'PDF: header `%PDF-1.4` e chiusura `%%EOF`',
        pdf.header.startsWith('%PDF-1.4') && pdf.eof === true,
        `"${pdf.header}" · eof=${pdf.eof}`
      );
      check(
        'PDF: tavola `xref` con offset reali (ogni voce punta al proprio `N 0 obj`)',
        pdf.xrefOk === true && pdf.objects.length === 5,
        `${pdf.objects.length} oggetti · ${pdf.objects.map((o) => o.pointsAt).join(' | ')}`
      );
      check(
        'PDF: `/Length` dichiarati identici ai byte reali dei due flussi',
        pdf.contentStreamOk === true && pdf.imageStreamOk === true,
        `contenuto=${pdf.contentStreamOk}, immagine=${pdf.imageStreamOk} (${pdf.imageDeclaredLength} dichiarati / ${pdf.imageStreamLength} reali)`
      );
      check(
        'PDF: pagina A4 verticale (MediaBox 595.28 × 841.89)',
        pdf.mediaBox === '0 0 595.28 841.89',
        pdf.mediaBox
      );
      check(
        'PDF: grafica impaginata centrata dentro i margini di 10 mm',
        pdf.fitsMargins === true,
        pdf.cm ? `${pdf.cm.width}×${pdf.cm.height} pt @ (${pdf.cm.x}, ${pdf.cm.y})` : 'matrice `cm` assente'
      );
      check(
        'PDF: immagine JPEG integra incorporata con `/DCTDecode` (nessun font: è solo grafica)',
        pdf.filters.includes('DCTDecode') &&
          pdf.fontResources === false &&
          pdf.filters.length === 1,
        `filtri=${pdf.filters.join(',')} · font=${pdf.fontResources}`
      );
      check(
        'PDF: immagine a 3× (Retina HD, ~480 DPI su A4) con proporzioni = snapshot pulito di `Copia Immagine`, non la scheda A4',
        expected.items === 2 &&
          pdf.imageWidth === expected.width * 3 &&
          Math.abs(pdf.imageHeight / pdf.imageWidth - expected.height / expected.width) < 0.002,
        `${pdf.imageWidth}×${pdf.imageHeight} px (atteso ${expected.width * 3}×${expected.height * 3}, ${expected.items} colli)`
      );

      // Evidenza grafica: il PDF è leggibile dal browser? Il file viene copiato
      // in `shots/` per l'ispezione manuale dell'operatore.
      mkdirSync('shots', { recursive: true });
      writeFileSync(join('shots', 'pdf-solo-grafica.pdf'), bytes);
      console.log(`Evidenza: shots/pdf-solo-grafica.pdf (${Math.round(bytes.length / 1024)} kB)`);
    }

    /* --- 4) "Salva con nome" con file già agganciato ---------------------- */
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

    /* --- 6) Il PDF è leggibile dal motore PDF di Chrome ------------------- *
     *  Ultimo passo (la pagina lascia l'applicazione): il file scaricato viene
     *  riaperto con `file://` e Chrome deve riconoscerlo come PDF e disegnarlo
     *  con il proprio visualizzatore interno. La schermata viene salvata come
     *  evidenza in `shots/pdf-solo-grafica-anteprima.png`. */
    if (pdfDownloaded) {
      await cdp.send('Page.navigate', { url: pathToFileURL(join(downloadDir, expectedName)).href });
      const viewer = await waitFor(
        async () => {
          const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
          const frame = list.find(
            (t) => t.type === 'iframe' && String(t.url).startsWith(CHROME_PDF_VIEWER)
          );
          const page = list.find((t) => t.type === 'page');
          return frame ? { viewer: String(frame.url), pageTitle: page?.title ?? '' } : null;
        },
        10000,
        'visualizzatore PDF interno di Chrome'
      ).catch(() => null);

      // Un attimo di respiro perché il viewer abbia disegnato la pagina A4.
      await sleep(2000);
      mkdirSync('shots', { recursive: true });
      const preview = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(
        join('shots', 'pdf-solo-grafica-anteprima.png'),
        Buffer.from(preview.data, 'base64')
      );

      check(
        'PDF: Chrome lo apre nel visualizzatore interno (file valido e disegnato)',
        viewer !== null && viewer.pageTitle === expectedName,
        viewer ? `viewer attivo, titolo "${viewer.pageTitle}"` : 'visualizzatore PDF non attivato'
      );
      console.log('Evidenza grafica: shots/pdf-solo-grafica-anteprima.png');
    }

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
