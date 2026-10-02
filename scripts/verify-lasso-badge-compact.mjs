/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — LASSO ESCLUSIVO, SIDEBAR COMPATTA & BADGE FILE ATTIVO
 *  (Sprint L)
 *
 *  Tre rifiniture verificate end-to-end su Chrome headless (CDP, zero
 *  dipendenze aggiunte):
 *
 *    1. LASSO DI SELEZIONE ESCLUSIVO (`TruckCanvas.tsx`): con il collo #16
 *       selezionato, un `Shift` + drag che racchiude i colli 1…10 deve lasciare
 *       selezionati **solo** i colli 1…10 — il #16, pur essendo selezionato in
 *       precedenza, viene deselezionato all'istante (nessuna selezione
 *       cumulativa). Controprova: i 10 colli selezionati sono esattamente quelli
 *       racchiusi dal rettangolo, e il #16 non lo è.
 *    2. COMPATTAZIONE VERTICALE DELLA SIDEBAR (`ControlDeck.tsx`): padding
 *       radice `p-4` (16 px), spaziatura fra macro-sezioni `space-y-3.5`
 *       (14 px), `pb-2` sull'intestazione, `gap-1.5` sulla griglia comandi e
 *       `space-y-1` fra etichetta e input di Mezzo/Targa. Il pannello risulta
 *       più basso della geometria precedente (`space-y-6` = 24 px per gap).
 *    3. BADGE `#active-file-badge`: compare sia dopo il **salvataggio** (anche
 *       nel fallback di download, col nome del file generato) sia dopo
 *       l'**apertura** di un piano, con lo stile compatto richiesto.
 *
 *  Uso:  node scripts/verify-lasso-badge-compact.mjs [url]
 *  Chiude sempre con `Browser.close()` + `process.exit(0)` entro 15 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://127.0.0.1:5199/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9338);
const WATCHDOG_MS = 15000;
const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** Colore del bordo di selezione dei colli (`SELECTION_COLOR` di TruckCanvas). */
const SELECTION_COLOR = 'rgb(37, 99, 235)';

/** Indici (1-based) dei dieci colli che il lasso deve selezionare. */
const LASSO_TARGET_COUNT = 10;

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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

/* --- Helper iniettati nella pagina ---------------------------------------- */

/**
 * Helper condivisi: conversione cm ↔ px schermo tramite la matrice reale dello
 * `<g>` trasformato, lettura geometrica dei colli resi e conteggio dei colli
 * selezionati (bordo spesso blu `#2563EB`).
 */
const PAGE_HELPERS = `
  window.__vp = () => {
    const svg = document.querySelector('.canvas-hud')?.parentElement?.querySelector('svg')
      || document.querySelector('svg');
    const world = svg.querySelector('g[transform]');
    const m = world.getScreenCTM();
    return {
      a: m.a, d: m.d, e: m.e, f: m.f,
      zoom: m.a,
      panY: m.f,
      rect: svg.getBoundingClientRect(),
    };
  };
  window.__toPx = (x, y) => {
    const v = window.__vp();
    return { x: v.a * x + v.e, y: v.d * y + v.f, zoom: v.a };
  };
  window.__toCm = (px, py) => {
    const v = window.__vp();
    return { x: (px - v.e) / v.a, y: (py - v.f) / v.d };
  };
  window.__items = () =>
    Array.from(document.querySelectorAll('[data-item-id]')).map((el) => {
      const rect = el.querySelector('rect');
      const m = el.transform.baseVal.consolidate().matrix;
      return {
        id: el.getAttribute('data-item-id'),
        code: el.getAttribute('data-canvas-item'),
        x: m.e, y: m.f,
        width: Number(rect.getAttribute('width')),
        length: Number(rect.getAttribute('height')),
        selected: getComputedStyle(rect).stroke === ${JSON.stringify(SELECTION_COLOR)},
        strokeWidth: Number(getComputedStyle(rect).strokeWidth.replace('px', '')),
      };
    });
  window.__selectedIds = () => window.__items().filter((i) => i.selected).map((i) => i.id);
  window.__pointer = (type, clientX, clientY, target, extra = {}) => {
    const ev = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX,
      clientY,
      ...extra,
    });
    target.dispatchEvent(ev);
    return 1;
  };
`;

/**
 * Esegue un lasso (`Shift` + drag sullo sfondo grigio) dal punto `from` al punto
 * `to`, entrambi in **cm reali del pianale**, con passi intermedi perché il
 * rettangolo venga aggiornato anche durante il movimento.
 */
const lassoScript = (from, to) => `
  const svg = document.querySelector('.canvas-hud')?.parentElement?.querySelector('svg')
    || document.querySelector('svg');
  const a = window.__toPx(${from.x}, ${from.y});
  const b = window.__toPx(${to.x}, ${to.y});
  window.__pointer('pointerdown', a.x, a.y, svg, { shiftKey: true });
  for (let i = 1; i <= 6; i += 1) {
    const t = i / 6;
    window.__pointer('pointermove', a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, svg, {
      shiftKey: true,
    });
    // Un respiro fra un movimento e l'altro: il rettangolo è disegnato da React.
    await new Promise((r) => setTimeout(r, 20));
  }
  const rectEl = svg.querySelector('rect[fill="#3B82F6"]');
  const drawn = !!rectEl;
  const drawnDash = rectEl ? rectEl.getAttribute('stroke-dasharray') : null;
  window.__pointer('pointerup', b.x, b.y, svg, { shiftKey: true });
  await new Promise((r) => setTimeout(r, 120));
  return {
    lassoDrawnDuringDrag: drawn,
    lassoDash: drawnDash,
    selected: window.__selectedIds(),
  };
`;

/* --- Script ----------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();
  const profileDir = mkdtempSync(join(tmpdir(), 'lasso-profile-'));
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
    await cdp.eval(PAGE_HELPERS + 'return 1;');

    /* === 1) LASSO DI SELEZIONE ESCLUSIVO ================================ */

    // 5 PLT INDU (120 × 100) + 11 PLT EUR (120 × 80) = 16 colli.
    // Un click per volta con un respiro fra l'uno e l'altro: `handleAddItem` di
    // `App.tsx` calcola lo spawn sull'array `items` del render corrente, quindi
    // click accodati nello stesso task React riuserebbero la stessa closure.
    await cdp.eval(`
      for (let i = 0; i < 16; i += 1) {
        document.getElementById(i < 5 ? 'quick-piatto-INDU' : 'quick-piatto-EUR').click();
        await new Promise((r) => setTimeout(r, 60));
      }
      await new Promise((r) => setTimeout(r, 250));
      return 1;
    `);

    const items = await cdp.eval(`return window.__items();`);
    check(
      'Pianale di prova: 16 colli stivati in file ordinate (Cabina → Porte)',
      items.length === 16,
      `${items.length} colli`
    );

    // Ordine geometrico: Y crescente e, a parità di Y, X crescente.
    const ordered = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
    const first = ordered[0];
    const tenth = ordered[LASSO_TARGET_COUNT - 1];
    const eleventh = ordered[LASSO_TARGET_COUNT];
    const last = ordered[ordered.length - 1];

    // Click sul collo #16 (ultimo in ordine geometrico), in un punto libero.
    const vehicle = await cdp.eval(`
      const all = window.__items();
      const ids = new Set(all.map((i) => i.id));
      for (let x = 5; x < 250; x += 5) {
        for (let y = 5; y < 1320; y += 5) {
          const el = document.elementFromPoint(
            window.__toPx(x, y).x, window.__toPx(x, y).y
          );
          const g = el?.closest?.('[data-item-id]');
          if (g && g.getAttribute('data-item-id') === ${JSON.stringify(last.id)}) {
            const px = window.__toPx(x, y);
            return { x, y, px: px.x, py: px.y, ids: [...ids].length };
          }
        }
      }
      return null;
    `);
    check(
      'Click sul collo #16: è possibile selezionarlo (punto del collo individuato a schermo)',
      vehicle !== null,
      vehicle ? `punto (${vehicle.x}, ${vehicle.y}) cm` : 'nessun punto utile trovato'
    );

    await cdp.eval(`
      const el = document.elementFromPoint(${vehicle.px}, ${vehicle.py});
      window.__pointer('pointerdown', ${vehicle.px}, ${vehicle.py}, el);
      window.__pointer('pointerup', ${vehicle.px}, ${vehicle.py}, el);
      await new Promise((r) => setTimeout(r, 150));
      return 1;
    `);

    const beforeLasso = await cdp.eval(`return window.__selectedIds();`);
    check(
      'Stato di partenza: selezionato SOLO il collo #16',
      beforeLasso.length === 1 && beforeLasso[0] === last.id,
      `selezione = [${beforeLasso.join(', ')}]`
    );

    // Lasso che racchiude i colli 1…10 e NON l'11° (quindi nemmeno il #16).
    const lassoFrom = { x: first.x - 8, y: first.y - 8 };
    const lassoTo = { x: tenth.x + tenth.width + 8, y: eleventh.y - 5 };
    const lassoResult = await cdp.eval(lassoScript(lassoFrom, lassoTo));

    const expectedIds = ordered.slice(0, LASSO_TARGET_COUNT).map((i) => i.id).sort();
    const actualIds = [...lassoResult.selected].sort();
    const sameSelection =
      actualIds.length === expectedIds.length &&
      actualIds.every((id, index) => id === expectedIds[index]);

    // Controllo geometrico indipendente: chi sta dentro l'area del lasso?
    const insideLasso = (
      await cdp.eval(`
        const rx = ${lassoFrom.x}, ry = ${lassoFrom.y};
        const rw = ${lassoTo.x - lassoFrom.x}, rl = ${lassoTo.y - lassoFrom.y};
        return window.__items()
          .filter((i) => i.x < rx + rw && i.x + i.width > rx && i.y < ry + rl && i.y + i.length > ry)
          .map((i) => i.id)
          .sort();
      `)
    ).join('|');
    check(
      'Geometria: i colli dentro il rettangolo sono esattamente i 10 attesi (1…10)',
      insideLasso === expectedIds.join('|') && expectedIds.length === LASSO_TARGET_COUNT,
      `${expectedIds.length} dentro il lasso, #11 (${eleventh.id}) fuori`
    );

    check(
      'Lasso: il rettangolo tratteggiato viene disegnato durante il drag',
      lassoResult.lassoDrawnDuringDrag === true && lassoResult.lassoDash === '6 4',
      `disegnato=${lassoResult.lassoDrawnDuringDrag}, dash="${lassoResult.lassoDash}"`
    );
    check(
      `Lasso ESCLUSIVO: selezionati esattamente i colli 1…${LASSO_TARGET_COUNT}`,
      sameSelection,
      `${actualIds.length} selezionati su ${expectedIds.length} attesi`
    );
    check(
      'Lasso: il collo #16 selezionato in precedenza è stato DESELEZIONATO',
      !actualIds.includes(last.id),
      `#16 = ${last.id} ${actualIds.includes(last.id) ? 'ANCORA SELEZIONATO' : 'deselezionato'}`
    );
    check(
      'Lasso: nessun collo esterno al rettangolo resta selezionato (nessuna selezione cumulativa)',
      actualIds.every((id) => expectedIds.includes(id)),
      `estranei = [${actualIds.filter((id) => !expectedIds.includes(id)).join(', ') || 'nessuno'}]`
    );

    // Il pannello Batch mostra il conteggio aggiornato (nessuna selezione orfana).
    const batchLabel = await cdp.eval(`
      const deck = document.querySelector('.control-deck');
      const badge = Array.from(deck.querySelectorAll('span')).find(
        (el) => /^\\s*\\d+ Colli\\s*$/.test(el.textContent || '')
      );
      return badge ? Number(/\\d+/.exec(badge.textContent)[0]) : -1;
    `);
    check(
      'Sidebar allineata: badge batch con il conteggio dei soli colli del lasso',
      batchLabel === LASSO_TARGET_COUNT,
      `badge = ${batchLabel} Colli`
    );

    // Controprova: un secondo lasso su un'area vuota azzera la selezione.
    const emptyLasso = await cdp.eval(
      lassoScript({ x: 200, y: 1200 }, { x: 240, y: 1300 })
    );
    check(
      'Controprova: lasso su area vuota → selezione azzerata (sostituzione, non accumulo)',
      emptyLasso.selected.length === 0,
      `selezione = [${emptyLasso.selected.join(', ')}]`
    );

    /* === 2) COMPATTAZIONE VERTICALE DELLA SIDEBAR ======================== */

    // Evidenza grafica del pannello Batch popolato dal solo lasso.
    await cdp.eval(lassoScript(lassoFrom, lassoTo));
    await sleep(150);
    mkdirSync('shots', { recursive: true });
    const lassoShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('shots/canvas-lasso-esclusivo.png', Buffer.from(lassoShot.data, 'base64'));
    console.log('Evidenza grafica: shots/canvas-lasso-esclusivo.png');

    // Pianale vuoto: 16 passi di Undo (uno per ogni collo aggiunto).
    await cdp.eval(`
      for (let i = 0; i < 16; i += 1) {
        document.getElementById('btn-undo').click();
        await new Promise((r) => setTimeout(r, 40));
      }
      await new Promise((r) => setTimeout(r, 250));
      return 1;
    `);

    const deck = await cdp.eval(`
      const el = document.querySelector('.control-deck');
      const style = getComputedStyle(el);
      const header = el.firstElementChild;
      const cmdGrid = document.getElementById('btn-copy-image').parentElement;
      const saveGrid = document.getElementById('btn-save-project').parentElement;
      const select = el.querySelector('select');
      const rootPad = parseFloat(style.paddingTop);
      // Gap reale fra due macro-sezioni consecutive (padding di space-y-*).
      const siblings = Array.from(el.children).filter((c) => c.offsetHeight > 0);
      const gaps = [];
      for (let i = 1; i < siblings.length; i += 1) {
        const prev = siblings[i - 1].getBoundingClientRect();
        const curr = siblings[i].getBoundingClientRect();
        gaps.push(Math.round(curr.top - prev.bottom));
      }
      return {
        rootPaddingPx: rootPad,
        marginTopPx: parseFloat(style.marginTop),
        // Tailwind v4 realizza space-y-* con il margine inferiore sui fratelli
        // non ultimi (verificato sul CSS generato): e' li' che si legge il valore.
        sectionMarginBottomPx: parseFloat(getComputedStyle(el.children[1]).marginBottom),
        headerPaddingBottomPx: parseFloat(getComputedStyle(header).paddingBottom),
        cmdGapPx: parseFloat(getComputedStyle(cmdGrid).columnGap),
        saveGapPx: parseFloat(getComputedStyle(saveGrid).columnGap),
        labelToInputPx: Math.round(
          select.getBoundingClientRect().top -
            select.previousElementSibling.getBoundingClientRect().bottom
        ),
        gaps,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    `);

    // Controprova: la geometria precedente (p-5 / space-y-6 / pb-3 / gap-2) era
    // davvero più alta. Il contenitore radice è un flex a tutta altezza
    // (h-full overflow-y-auto), quindi scrollHeight satura al viewport: la
    // controprova confronta i valori risolti da Tailwind per le due generazioni
    // di utility, misurandoli su elementi reali.
    const legacy = await cdp.eval(`
      const probe = document.createElement('div');
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      probe.style.width = '400px';
      probe.innerHTML =
        '<div class="space-y-3.5"><i style="display:block;height:10px"></i><i style="display:block;height:10px"></i></div>'
        + '<div class="space-y-6"><i style="display:block;height:10px"></i><i style="display:block;height:10px"></i></div>'
        + '<div class="p-4"></div><div class="p-5"></div>'
        + '<div class="pb-2"></div><div class="pb-3"></div>'
        + '<div class="grid gap-1.5"></div><div class="grid gap-2"></div>';
      document.body.appendChild(probe);
      const kids = Array.from(probe.children);
      const pick = (index, prop) => parseFloat(getComputedStyle(kids[index])[prop]);
      // La utility space-y-* non tocca il contenitore: il margine vive sul 2 figlio.
      const spaceGap = (index) =>
        Math.round(
          kids[index].children[1].getBoundingClientRect().top -
            kids[index].children[0].getBoundingClientRect().bottom
        );
      const out = {
        spaceNew: spaceGap(0),
        spaceLegacy: spaceGap(1),
        padNew: pick(2, 'paddingTop'),
        padLegacy: pick(3, 'paddingTop'),
        pbNew: pick(4, 'paddingBottom'),
        pbLegacy: pick(5, 'paddingBottom'),
        gapNew: pick(6, 'columnGap'),
        gapLegacy: pick(7, 'columnGap'),
        probes: kids.length,
        sectionCount: Array.from(document.querySelector('.control-deck').children).filter(
          (c) => c.offsetHeight > 0
        ).length,
      };
      probe.remove();
      return out;
    `);

    const uniformGaps = deck.gaps.slice(0, 5);
    check(
      'Sidebar: padding radice compatto `p-4` (16 px)',
      deck.rootPaddingPx === 16,
      `padding-top = ${deck.rootPaddingPx} px (era 20 px con p-5)`
    );
    check(
      'Sidebar: spaziatura fra macro-sezioni `space-y-3.5` (14 px)',
      deck.sectionMarginBottomPx === 14 && uniformGaps.every((gap) => gap === 14),
      `margine di sezione = ${deck.sectionMarginBottomPx} px, gap misurati = [${uniformGaps.join(', ')}] px (era 24 px)`
    );
    check(
      'Intestazione: margine inferiore ridotto `pb-2` (8 px)',
      deck.headerPaddingBottomPx === 8,
      `padding-bottom = ${deck.headerPaddingBottomPx} px (era 12 px con pb-3)`
    );
    check(
      'Griglia comandi (Copia, Stampa, Salva, Apri): `gap-1.5` (6 px)',
      deck.cmdGapPx === 6 && deck.saveGapPx === 6,
      `gap comandi = ${deck.cmdGapPx} px, gap salva/apri = ${deck.saveGapPx} px (era 8 px)`
    );
    check(
      'Mezzo / Targa: spazio etichetta → input ridotto a `space-y-1` (≤ 6 px)',
      deck.labelToInputPx <= 6,
      `distanza etichetta → select = ${deck.labelToInputPx} px`
    );
    check(
      'Controprova: le utility precedenti risolvono valori più alti (p-5 / space-y-6 / pb-3 / gap-2)',
      legacy.padLegacy === 20 &&
        legacy.padNew === 16 &&
        legacy.spaceLegacy === 24 &&
        legacy.spaceNew === 14 &&
        legacy.pbLegacy === 12 &&
        legacy.pbNew === 8 &&
        legacy.gapLegacy === 8 &&
        legacy.gapNew === 6 &&
        legacy.spaceLegacy > legacy.spaceNew,
      `padding 20→16 px, spazio fra sezioni 24→14 px, intestazione 12→8 px, gap 8→6 px: su ${legacy.sectionCount} macro-sezioni il risparmio verticale è ${(legacy.spaceLegacy - legacy.spaceNew) * (legacy.sectionCount - 1) + 2 * (legacy.padLegacy - legacy.padNew) + (legacy.pbLegacy - legacy.pbNew)} px`
    );

    /* === 3) BADGE DEL FILE ATTIVO ====================================== */

    const shortcut = await cdp.eval(`
      const m = /(?:Ctrl|Cmd)\\s*\\+\\s*S/i.test(document.querySelector('.control-deck').textContent || '');
      return { hint: m, clean: !document.getElementById('active-file-badge') };
    `);
    check(
      'Badge assente a pianale nuovo (nessun file agganciato)',
      shortcut.clean === true,
      `#active-file-badge presente = ${!shortcut.clean}`
    );

    // Salvataggio: nel browser headless la File System Access API non espone
    // `showSaveFilePicker`, quindi si passa dal fallback di download classico.
    await cdp.eval(`document.getElementById('btn-save-project').click(); return 1;`);
    const badgeAfterSave = await waitFor(
      async () => cdp.eval(`
        const el = document.getElementById('active-file-badge');
        if (!el) return null;
        const style = getComputedStyle(el);
        return {
          text: el.querySelector('span:last-child').textContent.trim(),
          title: el.getAttribute('title'),
          icon: el.querySelector('span').textContent.trim(),
          fontSize: style.fontSize,
          fontFamily: style.fontFamily,
          fontWeight: parseFloat(getComputedStyle(el.querySelector('span:last-child')).fontWeight),
          background: style.backgroundColor,
          borderColor: style.borderTopColor,
          marginTop: parseFloat(style.marginTop),
          iconColor: getComputedStyle(el.querySelector('span')).color,
          truncated: style.overflow === 'hidden' && style.textOverflow === 'ellipsis',
          // Riferimenti: un campione con le stesse classi Tailwind, così il
          // confronto cromatico resta valido anche col formato oklch() di
          // Tailwind v4 (nessun confronto su valori RGB hard-coded).
          ref: (() => {
            const probe = document.createElement('div');
            probe.className = 'bg-slate-50 border-slate-200 text-slate-700';
            probe.style.position = 'absolute';
            probe.style.visibility = 'hidden';
            document.body.appendChild(probe);
            const ps = getComputedStyle(probe);
            const out = {
              background: ps.backgroundColor,
              borderColor: ps.borderTopColor,
              textColor: ps.color,
            };
            probe.remove();
            return out;
          })(),
          textColor: getComputedStyle(el.querySelector('span:last-child')).color,
        };
      `),
      4000,
      'badge del file attivo dopo il salvataggio'
    );

    const expectedSaveName = await cdp.eval(`
      const today = new Date().toISOString().slice(0, 10);
      return 'piano-carico-' + today + '.json';
    `);
    check(
      'Badge `#active-file-badge` presente dopo il primo "Salva Piano" (fallback download)',
      badgeAfterSave.text === expectedSaveName,
      `badge = "${badgeAfterSave.text}" (atteso "${expectedSaveName}")`
    );
    // Colore atteso dell'icona 📄: il blu `text-blue-600` del riferimento.
    const blueRef = await cdp.eval(`
      const probe = document.createElement('span');
      probe.className = 'text-blue-600';
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    `);

    check(
      'Badge: stile compatto sobrio (font 11 px mono, sfondo slate-50, bordo slate-200)',
      badgeAfterSave.fontSize === '11px' &&
        /mono|consolas|courier/i.test(badgeAfterSave.fontFamily) &&
        badgeAfterSave.fontWeight >= 600 &&
        badgeAfterSave.background === badgeAfterSave.ref.background &&
        badgeAfterSave.borderColor === badgeAfterSave.ref.borderColor &&
        badgeAfterSave.marginTop === 6,
      `font ${badgeAfterSave.fontSize} ${badgeAfterSave.fontWeight}, bg ${badgeAfterSave.background} (slate-50), bordo ${badgeAfterSave.borderColor} (slate-200), mt ${badgeAfterSave.marginTop} px`
    );
    check(
      'Badge: icona 📄 blu e tooltip col nome del file attivo',
      badgeAfterSave.icon === '📄' &&
        badgeAfterSave.iconColor === blueRef &&
        badgeAfterSave.title === `File attualmente aperto: ${badgeAfterSave.text}` &&
        badgeAfterSave.truncated,
      `icona "${badgeAfterSave.icon}" (${badgeAfterSave.iconColor} = blue-600), tooltip "${badgeAfterSave.title}", troncamento attivo=${badgeAfterSave.truncated}`
    );

    // Apertura di un piano con il selettore classico (`<input type="file">`):
    // il nome del file aperto deve diventare il nuovo badge attivo.
    const OPENED_NAME = 'piano-XA000BB-2026-01-15.json';
    const openResult = await waitFor(
      async () => cdp.eval(`
        const input = document.getElementById('project-file-input');
        if (!input) return null;
        const project = {
          version: 1,
          app: 'truck-planner',
          timestamp: new Date().toISOString(),
          vehicle: { id: 'bilico_cc', name: 'Bilico frigo Fiori (2,50 × 13,28 m)', width: 250, length: 1328 },
          plate: 'XA000BB',
          items: [{
            id: 'item-1', code: 'EUR', name: 'PLT EUR', width: 120, length: 80,
            x: 0, y: 0, rotation: 90, color: '#FEF08A', borderColor: '#334155',
          }],
          notes: [],
          labelDensity: 'all',
        };
        const file = new File([JSON.stringify(project)], ${JSON.stringify(OPENED_NAME)}, {
          type: 'application/json',
        });
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        const el = document.getElementById('active-file-badge');
        return {
          text: el ? el.querySelector('span:last-child').textContent.trim() : null,
          items: window.__items().length,
          plate: document.getElementById('vehicle-plate-input')?.value ?? null,
        };
      `),
      5000,
      'apertura del piano e aggiornamento del badge'
    );

    check(
      'Badge aggiornato dopo l\'apertura di un file (nome del piano aperto)',
      openResult.text === OPENED_NAME,
      `badge = "${openResult.text}" (atteso "${OPENED_NAME}")`
    );
    check(
      'Apertura effettiva: il piano caricato è in scena (1 collo, targa XA000BB)',
      openResult.items === 1 && openResult.plate === 'XA000BB',
      `${openResult.items} collo, targa "${openResult.plate}"`
    );

    /* === 4) Nessun errore in console =================================== */

    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    /* === Evidenza grafica ============================================== */

    mkdirSync('shots', { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(
      'shots/sidebar-compatta-badge-file-attivo.png',
      Buffer.from(shot.data, 'base64')
    );
    console.log('Evidenza grafica: shots/sidebar-compatta-badge-file-attivo.png');

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
