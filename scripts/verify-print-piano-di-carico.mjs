/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — RESTYLING UFFICIALE DELLA SCHEDA A4 ("PIANO DI CARICO")
 *
 *  Controlla la nuova impaginazione della scheda di stampa (`PrintReport.tsx`):
 *
 *    1. Intestazione minimale: titolo ufficiale `PIANO DI CARICO` (font-black
 *       text-2xl tracking-tight), sottotitolo `Truck Planner CAD — data • ora`
 *       (nessuna dicitura "documento generato il"), blocco mezzo a destra con
 *       nome vettore in grassetto e dimensioni in metri **larghezza per prima**
 *       (`2.50 × 13.28 m`), **nessuna riga Targa**.
 *    2. Paginazione dinamica A4: con 2 righe di carico la tabella staziona in
 *       Pagina 1; con 4 righe scatta il salto pagina (`break-before: page`) e la
 *       tabella completa vive in Pagina 2, mentre in Pagina 1 resta la sola nota
 *       di rinvio `Tabella riepilogativa colli consultabile a Pagina 2 ➔`.
 *    3. Nuova gerarchia della tabella: colonne `RIFERIMENTO | Q.TÀ | FORMATO |
 *       ORIENTAMENTO` (quantità come seconda colonna, centrata e in grassetto),
 *       penultima riga `TOTALE COLLI` con il totale incolonnato sotto le
 *       quantità e ultima riga `Ingombro Lineare Effettivo (LDM)` estesa su
 *       tutte e quattro le colonne (`colSpan 4`).
 *    4. Il PDF generato da `Page.printToPDF` con 4 righe occupa 2 pagine.
 *    5. Nessun errore runtime in console.
 *
 *  Uso:  node scripts/verify-print-piano-di-carico.mjs [url]
 *  Chiude sempre con `Browser.close` + `process.exit(0)` entro 15 secondi.
 * -------------------------------------------------------------------------- */

const TARGET_URL = process.argv[2] || 'http://127.0.0.1:5199/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9339);
const WATCHDOG_MS = 15000;
const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/* --- Lettura della scheda ------------------------------------------------- */

/** Intestazione della pagina del **primo mezzo** + dati del blocco mezzo (media `print` emulata).
 *
 *  L'aggancio è `.print-bay-page`: nella centrale multi-pianale la pagina di
 *  ciascun mezzo è una `.print-page.print-page-first` annidata, quindi il solo
 *  `.print-page-first` non identifica più la pagina 1 (lo condivide con il
 *  foglio panoramico della modalità "Solo Grafica"). */
const READ_HEADER = `
  const page = document.querySelector('#print-report .print-bay-page');
  const header = page.querySelector(':scope > header');
  const left = header.firstElementChild;
  const right = header.lastElementChild;
  const h1 = left.querySelector('h1');
  const subtitle = left.querySelector('p');
  const nameLine = right.children[0];
  const dimensionLine = right.children[1];
  return {
    title: h1.textContent.replace(/\\s+/g, ' ').trim(),
    titleClass: h1.className,
    titleFontWeight: getComputedStyle(h1).fontWeight,
    titleFontSize: getComputedStyle(h1).fontSize,
    subtitle: subtitle.textContent.trim(),
    vehicleName: nameLine.textContent.trim(),
    vehicleNameWeight: getComputedStyle(nameLine).fontWeight,
    dimensions: dimensionLine.textContent.trim(),
    headerText: header.textContent,
    // La vecchia voce formale della targa non deve più esistere in intestazione.
    plateRow: !!document.getElementById('print-plate-row'),
    plateBadgeInDrawing: !!document.getElementById('print-plate-badge'),
    reportText: document.getElementById('print-report').textContent,
    pageHeightPx: page.getBoundingClientRect().height,
  };
`;

/** Struttura della tabella riepilogativa (ordine colonne, piede, colSpan). */
const READ_TABLE = `
  const readTable = (scopeSelector) => {
    const scope = document.querySelector(scopeSelector);
    if (!scope) return null;
    const table = scope.querySelector('table');
    if (!table) return null;
    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => ({
      text: th.textContent.trim(),
      align: getComputedStyle(th).textAlign,
    }));
    const bodyRows = Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.children).map((td) => td.textContent.trim())
    );
    const quantityCells = Array.from(table.querySelectorAll('tbody tr')).map((tr) => {
      const cell = tr.children[1];
      if (!cell) return null;
      const style = getComputedStyle(cell);
      return { text: cell.textContent.trim(), align: style.textAlign, weight: style.fontWeight };
    });
    const totalRow = document.getElementById('print-total-row');
    const ldmRow = document.getElementById('print-ldm-row');
    return {
      headers,
      bodyRows,
      quantityCells,
      totalRow: totalRow
        ? {
            cells: Array.from(totalRow.children).map((td) => ({
              text: td.textContent.trim(),
              colSpan: td.colSpan,
              align: getComputedStyle(td).textAlign,
              weight: getComputedStyle(td).fontWeight,
            })),
          }
        : null,
      ldmRow: ldmRow
        ? {
            cells: Array.from(ldmRow.children).map((td) => ({ text: td.textContent.trim(), colSpan: td.colSpan })),
          }
        : null,
    };
  };
  const first = document.querySelector('#print-report .print-bay-page');
  const second = document.querySelector('#print-report .print-bay-table-page');
  const hint = first.querySelector('.print-table, div.text-center');
  return {
    tableCount: document.querySelectorAll('#print-report table').length,
    pageOneHasTable: !!first.querySelector('table'),
    pageOneHasOwnTable: !!first.querySelector(':scope > .print-table'),
    pageTwoExists: !!second,
    pageTwoBreakBefore: second ? getComputedStyle(second).breakBefore : null,
    pageTwoHeader: second ? second.querySelector('header').textContent.replace(/\\s+/g, ' ').trim() : null,
    hintText: first.querySelector(':scope > .print-table') ? null : (hint ? hint.textContent.trim() : null),
    hintStyle: first.querySelector(':scope > .print-table')
      ? null
      : (() => {
          const el = first.querySelector('div.text-center');
          if (!el) return null;
          const style = getComputedStyle(el);
          return {
            className: el.className,
            fontSize: style.fontSize,
            color: style.color,
            fontWeight: style.fontWeight,
            textAlign: style.textAlign,
          };
        })(),
    pageOne: readTable('#print-report [data-print-bay-page]'),
    pageTwo: readTable('#print-report [data-print-bay-table-page]'),
    // Dimensioni reali della pagina del mezzo: il foglio A4 completo
    // (210 × 297 mm, border-box, padding interno di 10 mm per lato).
    pageOneHeightPx: (() => {
      const page = document.querySelector('#print-report [data-print-bay-page]');
      return page ? page.getBoundingClientRect().height : null;
    })(),
    pageOneWidthPx: (() => {
      const page = document.querySelector('#print-report [data-print-bay-page]');
      return page ? page.getBoundingClientRect().width : null;
    })(),
  };
`;

/** Numero di pagine del PDF generato da Chrome (`/Count N` + oggetti pagina). */
const countPdfPages = (base64) => {
  const raw = Buffer.from(base64, 'base64').toString('latin1');
  const counts = [...raw.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  const pageObjects = (raw.match(/\/Type\s*\/Page[^s]/g) || []).length;
  return { counts, pageObjects };
};

/* --- Script ----------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();
  const profileDir = mkdtempSync(join(tmpdir(), 'piano-carico-profile-'));
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

    const setPrintMedia = (print) =>
      cdp.send('Emulation.setEmulatedMedia', { media: print ? 'print' : 'screen' });

    /**
     * Riporta il documento allo stato di riposo: nessuna modalità di stampa e
     * nessun foglio `@page` temporaneo in `<head>`. In Chrome headless il
     * dialogo nativo di `window.print()` non si chiude, quindi l'evento
     * `afterprint` che ripulisce lo stato dell'app può non arrivare mai: la
     * pulizia esplicita evita che una prova precedente condizioni questa.
     */
    const resetPrintState = () =>
      cdp.eval(`
        document.documentElement.removeAttribute('data-print-mode');
        document.getElementById('print-page-orientation')?.remove();
        return 1;
      `);
    await resetPrintState();

    /* --- 1) Intestazione minimale (pianale vuoto) ------------------------ */
    await setPrintMedia(true);
    await sleep(200);
    const header = await cdp.eval(READ_HEADER);

    check(
      'Titolo ufficiale: "PIANO DI CARICO — MEZZO 1" (una pagina per ciascun mezzo)',
      header.title === 'PIANO DI CARICO — MEZZO 1',
      `titolo = "${header.title}"`
    );
    check(
      'Titolo con la gerarchia richiesta (font-black text-2xl tracking-tight text-slate-900)',
      header.titleClass.includes('font-black') &&
        header.titleClass.includes('text-2xl') &&
        header.titleClass.includes('tracking-tight') &&
        header.titleClass.includes('text-slate-900') &&
        header.titleFontWeight === '900',
      `class="${header.titleClass}" peso=${header.titleFontWeight} corpo=${header.titleFontSize}`
    );
    check(
      'Sottotitolo "Truck Planner CAD — data • ora" senza "documento generato il"',
      /^Truck Planner CAD — \d{2}\/\d{2}\/\d{4} • \d{2}:\d{2}$/.test(header.subtitle) &&
        !header.subtitle.includes('documento generato il') &&
        !header.reportText.includes('documento generato il'),
      `sottotitolo = "${header.subtitle}"`
    );
    check(
      'Blocco mezzo: nome della configurazione in grassetto (o la targa se compilata)',
      /^(Bilico .+|Motrice .+|Personalizzato.*|[A-Z0-9 ]+)$/.test(header.vehicleName) &&
        header.vehicleNameWeight === '700',
      `"${header.vehicleName}" (peso ${header.vehicleNameWeight})`
    );
    check(
      'Dimensioni in metri con la LARGHEZZA per prima ("2.50 × 13.28 m")',
      header.dimensions === '2.50 × 13.28 m',
      `"${header.dimensions}"`
    );
    check(
      'Nessuna riga Targa in intestazione (rimossa: la targa è disegnata sopra la Cabina)',
      header.plateRow === false && !header.headerText.includes('Targa'),
      `#print-plate-row presente = ${header.plateRow}, "Targa" in header = ${header.headerText.includes('Targa')}`
    );

    /* --- 2) Due righe di carico: tabella in Pagina 1 --------------------- */
    await setPrintMedia(false);
    await cdp.eval(`document.getElementById('quick-piatto-INDU').click(); return 1;`);
    await sleep(150);
    await cdp.eval(`document.getElementById('quick-piatto-EUR').click(); return 1;`);
    await sleep(200);

    await setPrintMedia(true);
    await sleep(150);
    const twoRows = await cdp.eval(READ_TABLE);

    check(
      'Carico compatto (2 righe): una sola pagina, tabella in Pagina 1',
      twoRows.pageOneHasTable === true &&
        twoRows.pageTwoExists === false &&
        twoRows.tableCount === 1 &&
        twoRows.pageOne.bodyRows.length === 2,
      `tabelle=${twoRows.tableCount}, Pagina 1 con tabella=${twoRows.pageOneHasTable}, Pagina 2=${twoRows.pageTwoExists}, righe=${twoRows.pageOne?.bodyRows.length}`
    );
    check(
      "Carico compatto: la Pagina 1 occupa l'intero foglio A4 (210 × 297 mm ≈ 794 × 1123 px)",
      Math.abs(twoRows.pageOneHeightPx - (297 / 25.4) * 96) < 2 &&
        Math.abs(twoRows.pageOneWidthPx - (210 / 25.4) * 96) < 2,
      `${twoRows.pageOneWidthPx?.toFixed(2)} × ${twoRows.pageOneHeightPx?.toFixed(2)} px (pianale vuoto, tabella in calce)`
    );
    check(
      'Carico compatto: nessuna nota di rinvio a Pagina 2',
      twoRows.hintText === null,
      `nota = ${JSON.stringify(twoRows.hintText)}`
    );

    /* Evidenza grafica della Pagina 1 "compatta" (disegno + tabella in calce). */
    mkdirSync('shots', { recursive: true });
    const compactShot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1600, height: Math.ceil(header.pageHeightPx) + 10, scale: 1 },
    });
    writeFileSync(
      'shots/scheda-piano-di-carico-due-righe-pagina-1.png',
      Buffer.from(compactShot.data, 'base64')
    );

    /* --- 3) Quattro righe di carico: salto pagina e Pagina 2 ------------- */
    await setPrintMedia(false);
    await cdp.eval(`document.getElementById('quick-piatto-HALF_EUR').click(); return 1;`);
    await sleep(150);
    await cdp.eval(`document.getElementById('quick-piatto-CC').click(); return 1;`);
    await sleep(250);

    await setPrintMedia(true);
    await sleep(200);
    const fourRows = await cdp.eval(READ_TABLE);

    check(
      'Carico articolato (4 righe): la tabella abbandona la Pagina 1',
      fourRows.pageOneHasOwnTable === false && fourRows.pageTwoExists === true && fourRows.tableCount === 1,
      `Pagina 1 con tabella=${fourRows.pageOneHasTable}, Pagina 2=${fourRows.pageTwoExists}, tabelle=${fourRows.tableCount}`
    );
    check(
      'Salto pagina forzato: `break-before: page` sulla Pagina 2',
      fourRows.pageTwoBreakBefore === 'page',
      `break-before = ${fourRows.pageTwoBreakBefore}`
    );
    check(
      'Pagina 1: nota discreta di rinvio alla Pagina 2',
      fourRows.hintText === 'Tabella riepilogativa colli consultabile a Pagina 2 ➔' &&
        fourRows.hintStyle?.className ===
          'text-center text-[10px] text-slate-500 font-semibold py-1' &&
        fourRows.hintStyle?.fontSize === '10px' &&
        fourRows.hintStyle?.textAlign === 'center' &&
        fourRows.hintStyle?.fontWeight === '600',
      `testo = ${JSON.stringify(fourRows.hintText)}, stile = ${JSON.stringify(fourRows.hintStyle)}`
    );
    check(
      'Pagina 2: header formale "MEZZO 1 — RIEPILOGO DETTAGLIATO COLLI" con data e nome mezzo',
      typeof fourRows.pageTwoHeader === 'string' &&
        fourRows.pageTwoHeader.startsWith('MEZZO 1 — RIEPILOGO DETTAGLIATO COLLI') &&
        fourRows.pageTwoHeader.includes('Bilico') &&
        /\d{2}\/\d{2}\/\d{4} • \d{2}:\d{2}/.test(fourRows.pageTwoHeader),
      `"${fourRows.pageTwoHeader}"`
    );

    const headers = fourRows.pageTwo?.headers ?? [];
    check(
      'Ordine colonne: RIFERIMENTO | Q.TÀ | FORMATO | ORIENTAMENTO',
      headers.length === 4 &&
        headers[0].text === 'Riferimento' &&
        headers[1].text === 'Q.tà' &&
        headers[2].text === 'Formato' &&
        headers[3].text === 'Orientamento',
      headers.map((h) => h.text).join(' | ')
    );
    check(
      'Q.TÀ è la seconda colonna, centrata in intestazione',
      headers[1]?.text === 'Q.tà' && headers[1]?.align === 'center',
      `allineamento = ${headers[1]?.align}`
    );
    check(
      'Le quattro righe di carico portano la quantità in 2ª colonna, centrata e in grassetto',
      fourRows.pageTwo?.bodyRows.length === 4 &&
        fourRows.pageTwo.quantityCells.every(
          (cell) => cell && cell.text === '1' && cell.align === 'center' && cell.weight === '700'
        ) &&
        fourRows.pageTwo.bodyRows.every((cells) => cells.length === 4),
      `righe = ${fourRows.pageTwo?.bodyRows.length}, quantità = ${JSON.stringify(
        fourRows.pageTwo?.quantityCells
      )}`
    );

    const totalRow = fourRows.pageTwo?.totalRow;
    check(
      'Penultima riga: "TOTALE COLLI" in colonna 1 e totale (4) incolonnato sotto le quantità in colonna 2',
      totalRow?.cells.length === 3 &&
        totalRow.cells[0].text === 'TOTALE COLLI' &&
        totalRow.cells[0].weight === '700' &&
        totalRow.cells[1].text === '4' &&
        totalRow.cells[1].align === 'center' &&
        totalRow.cells[2].colSpan === 2,
      `celle = ${JSON.stringify(totalRow?.cells)}`
    );

    const ldmRow = fourRows.pageTwo?.ldmRow;
    check(
      'Ultima riga: "Ingombro Lineare Effettivo (LDM)" esteso su tutte e 4 le colonne (colSpan 4)',
      ldmRow?.cells.length === 1 &&
        ldmRow.cells[0].colSpan === 4 &&
        /^Ingombro Lineare Effettivo \(LDM\): (?:\d+\.\d{2} m|Lato SX \d+\.\d{2} m \| Lato DX \d+\.\d{2} m)$/.test(
          ldmRow.cells[0].text
        ),
      `celle = ${JSON.stringify(ldmRow?.cells)}`
    );

    /* --- 4) Il PDF reale di Chrome occupa due pagine --------------------- */
    const pdf = await cdp.send('Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
    });
    const pageCount = countPdfPages(pdf.data);
    check(
      'PDF con 4 righe: pagina del disegno + pagina del riepilogo (salto pagina rispettato in stampa)',
      pageCount.pageObjects === 2 || pageCount.counts.includes(2),
      `oggetti pagina = ${pageCount.pageObjects}, /Count = ${JSON.stringify(pageCount.counts)}`
    );

    /* --- 5) Evidenze grafiche ------------------------------------------- *
     *  Nella centrale multi-pianale (sezione AM) la Pagina 2 di un mezzo **vive
     *  dentro** la pagina del mezzo: è il motore di stampa a impaginarla grazie a
     *  `break-before: page`, quindi a schermo (media di stampa emulato) il suo
     *  riquadro resta dentro la pagina 1 mentre il contenuto (la tabella) può
     *  sbordare più in basso. Le due clip vengono perciò calcolate sul **fondo
     *  reale del contenuto** — il massimo fra i riquadri di tutti i discendenti
     *  del report e l'altezza di scorrimento del documento — e mai come
     *  differenza fra due quote che può diventare negativa (una clip con altezza
     *  negativa blocca `Page.captureScreenshot`). */
    const geometry = await cdp.eval(`
      const report = document.getElementById('print-report');
      const first = report.querySelector('[data-print-bay-page]');
      const second = report.querySelector('[data-print-bay-table-page]');
      const firstRect = first.getBoundingClientRect();
      const secondRect = second.getBoundingClientRect();
      const contentBottom = [...report.querySelectorAll('*')].reduce(
        (max, el) => Math.max(max, el.getBoundingClientRect().bottom),
        Math.max(
          report.getBoundingClientRect().bottom,
          document.documentElement.scrollHeight,
          firstRect.bottom,
          secondRect.bottom
        )
      );
      return {
        width: Math.max(firstRect.width, secondRect.width),
        secondTop: secondRect.top,
        contentBottom,
      };
    `);
    const shotTwo = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: 0,
        width: Math.ceil(geometry.width),
        height: Math.ceil(geometry.contentBottom) + 20,
        scale: 1,
      },
    });
    writeFileSync(
      'shots/scheda-piano-di-carico-due-pagine.png',
      Buffer.from(shotTwo.data, 'base64')
    );
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: {
        x: 0,
        y: Math.floor(geometry.secondTop),
        width: Math.ceil(geometry.width),
        height: Math.max(1, Math.ceil(geometry.contentBottom - geometry.secondTop) + 20),
        scale: 1,
      },
    });
    writeFileSync(
      'shots/scheda-piano-di-carico-pagina-2.png',
      Buffer.from(shot.data, 'base64')
    );
    console.log(
      'Evidenze grafiche: shots/scheda-piano-di-carico-pagina-2.png, shots/scheda-piano-di-carico-due-pagine.png'
    );

    /* --- 6) Nessun errore runtime -------------------------------------- */
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
    // Chiusura pulita: `Browser.close` non risponde mai (la connessione cade
    // insieme al browser), quindi non si attende la risposta.
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
