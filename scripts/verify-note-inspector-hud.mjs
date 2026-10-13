/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — HUD SINISTRO UNIFICATO (ITEM INSPECTOR + NOTE INSPECTOR)
 *
 *  La card "Nota Laterale Selezionata" è stata **estratta** dalla sidebar destra
 *  (`ControlDeck`) nel componente autonomo `src/components/NoteInspector.tsx` e
 *  vive ora nella **colonna HUD fluttuante** di sinistra (`App.tsx`):
 *
 *    absolute top-4 left-4 z-20 flex flex-col gap-2.5 w-72 md:w-80
 *    pointer-events-none max-h-[calc(100vh-2rem)] overflow-y-auto
 *
 *  Controlli:
 *    1. un collo selezionato → `ItemInspector` in alto a sinistra (16/16 px);
 *    2. "Aggiungi Nota Laterale" → `NoteInspector` come **appendice** subito
 *       sotto la card del collo, con la selezione dei colli conservata;
 *    3. modifica testo / corpo / misure / colore → canvas aggiornato in tempo
 *       reale e clamps rispettati;
 *    4. la sidebar destra NON contiene più alcun pannello nota: la quota Y del
 *       "Riepilogo Stiva" resta identica con la card aperta e chiusa;
 *    5. `X` chiude solo la nota lasciando visibile la card del collo;
 *    6. `Canc` con la sola nota selezionata elimina la nota.
 *
 *  Uso:  node scripts/verify-note-inspector-hud.mjs [url]
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://localhost:5199/truck-planner/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9347);
const WATCHDOG_MS = 30000;

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Risoluzione del binario di Chrome: env, poi i percorsi tipici dei due OS. */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const CHROME_PATH = CHROME_CANDIDATES.find((path) => existsSync(path)) || CHROME_CANDIDATES[0];

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

/* --- Helper iniettati nella pagina ---------------------------------------- */

const PAGE_HELPERS = `
  window.__inspector = () => document.getElementById('item-inspector');
  window.__noteInspector = () => document.getElementById('note-inspector');
  window.__panel = () => window.__inspector()?.parentElement ?? null;
  window.__items = () =>
    Array.from(document.querySelectorAll('[data-item-id]')).map((el) => {
      const rect = el.querySelector('rect');
      const m = el.transform.baseVal.consolidate().matrix;
      return {
        id: el.getAttribute('data-item-id'),
        x: m.e, y: m.f,
        width: Number(rect.getAttribute('width')),
        length: Number(rect.getAttribute('height')),
        fill: rect.getAttribute('fill'),
      };
    });
  window.__selectedIds = () =>
    Array.from(document.querySelectorAll('[data-item-id]'))
      .filter((el) => getComputedStyle(el.querySelector('rect')).stroke === 'rgb(37, 99, 235)')
      .map((el) => el.getAttribute('data-item-id'));
  window.__centerPx = (id) => {
    const it = window.__items().find((i) => i.id === id);
    if (!it) return null;
    const svg = document.querySelector('.canvas-hud')?.parentElement?.querySelector('svg')
      || document.querySelector('svg');
    const world = svg.querySelector('g[transform]');
    const m = world.getScreenCTM();
    return { x: m.a * (it.x + it.width / 2) + m.e, y: m.d * (it.y + it.length / 2) + m.f };
  };
  window.__centerPxOf = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  window.__note = () => {
    const el = document.querySelector('[data-canvas-note]');
    if (!el) return null;
    const rect = el.querySelector('rect');
    const text = el.querySelector('text');
    const m = el.transform.baseVal.consolidate().matrix;
    return {
      id: el.getAttribute('data-canvas-note'),
      x: m.e, y: m.f,
      width: Number(rect.getAttribute('width')),
      height: Number(rect.getAttribute('height')),
      fill: rect.getAttribute('fill'),
      stroke: rect.getAttribute('stroke'),
      fontSize: Number(text.getAttribute('font-size')),
      text: Array.from(el.querySelectorAll('tspan')).map((t) => t.textContent).join(' '),
    };
  };
  window.__noteCards = () => document.querySelectorAll('[data-canvas-note]').length;
  /** Quota Y del titolo "Riepilogo Stiva" nella sidebar destra. */
  window.__summaryTop = () => {
    const label = Array.from(document.querySelectorAll('.control-deck label'))
      .find((el) => el.textContent.trim() === 'Riepilogo Stiva');
    return label ? label.getBoundingClientRect().top : null;
  };
  /** Il pannello nota è ancora dentro la sidebar destra? */
  window.__notePanelInDeck = () => !!document.querySelector('.control-deck #note-content-input');
  window.__deckText = () => document.querySelector('.control-deck')?.textContent ?? '';
`;

/* --- Input reali ---------------------------------------------------------- */

const clickAt = async (cdp, x, y, modifiers = 0) => {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers,
  });
  await sleep(160);
};

const clickSelector = async (cdp, selector) => {
  const point = await cdp.eval(`return window.__centerPxOf(${JSON.stringify(selector)});`);
  if (!point) throw new Error(`elemento non trovato: ${selector}`);
  await clickAt(cdp, point.x, point.y);
};

const clickItem = async (cdp, id) => {
  const point = await cdp.eval(`return window.__centerPx(${JSON.stringify(id)});`);
  if (!point) throw new Error(`collo non trovato: ${id}`);
  await clickAt(cdp, point.x, point.y);
};

const pressKey = async (cdp, { key, code, vk, modifiers = 0 }) => {
  const params = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...params });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...params });
  await sleep(220);
};
const pressDelete = (cdp) => pressKey(cdp, { key: 'Delete', code: 'Delete', vk: 46 });

/** Scrive in un input/textarea React con l'evento nativo (setter + `input`). */
const typeInto = async (cdp, selector, value, proto = 'HTMLInputElement') => {
  await cdp.eval(`
    const el = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(window.${proto}.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 1;
  `);
  await sleep(200);
};

/* --- Script --------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();
  const profileDir = mkdtempSync(join(tmpdir(), 'note-hud-profile-'));
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

    /* =================================================================== *
     *  1) COLLO SELEZIONATO → ITEM INSPECTOR IN ALTO A SINISTRA
     * =================================================================== */
    await clickSelector(cdp, '#quick-piatto-EUR');
    const withItem = await cdp.eval(`
      const item = window.__inspector();
      const canvas = document.querySelector('.canvas-hud').parentElement.getBoundingClientRect();
      const r = item ? item.getBoundingClientRect() : null;
      const p = window.__panel();
      const ps = p ? getComputedStyle(p) : null;
      return {
        hasItem: !!item,
        hasNote: !!window.__noteInspector(),
        offsetLeft: r ? Math.round(r.left - canvas.left) : null,
        offsetTop: r ? Math.round(r.top - canvas.top) : null,
        panelPosition: ps ? ps.position : null,
        panelZ: ps ? ps.zIndex : null,
        panelDisplay: ps ? ps.display : null,
        panelPointer: ps ? ps.pointerEvents : null,
        cardPointer: item ? getComputedStyle(item).pointerEvents : null,
        summaryTop: window.__summaryTop(),
        selected: window.__selectedIds().length,
      };
    `);
    check('Il collo selezionato mostra la card fluttuante', withItem.hasItem === true);
    check(
      'La card del collo è ancorata in alto a sinistra (top-4 left-4 → 16/16 px)',
      withItem.offsetLeft === 16 && withItem.offsetTop === 16,
      `left ${withItem.offsetLeft}px, top ${withItem.offsetTop}px`
    );
    check(
      'Il container HUD è una colonna assoluta a z-20, trasparente ai pointer',
      withItem.panelPosition === 'absolute' &&
        withItem.panelZ === '20' &&
        withItem.panelDisplay === 'flex' &&
        withItem.panelPointer === 'none',
      `${withItem.panelPosition} · z${withItem.panelZ} · ${withItem.panelDisplay} · pointer-events ${withItem.panelPointer}`
    );
    check(
      'La card interna resta cliccabile (pointer-events-auto)',
      withItem.cardPointer === 'auto',
      String(withItem.cardPointer)
    );
    check('Nessuna card nota a schermo prima di crearla', withItem.hasNote === false);

    /* =================================================================== *
     *  2) "AGGIUNGI NOTA LATERALE" → APPENDICE SOTTO LA CARD DEL COLLO
     * =================================================================== */
    await clickSelector(cdp, '#btn-add-side-note');
    const withNote = await cdp.eval(`
      const item = window.__inspector();
      const note = window.__noteInspector();
      const ir = item ? item.getBoundingClientRect() : null;
      const nr = note ? note.getBoundingClientRect() : null;
      const canvas = document.querySelector('.canvas-hud').parentElement.getBoundingClientRect();
      const first = item ? item.querySelector('div').textContent.replace(/\\s+/g, ' ').trim() : '';
      const header = note ? note.textContent.replace(/\\s+/g, ' ').trim() : '';
      return {
        hasItem: !!item,
        hasNote: !!note,
        samePanel: !!item && !!note && item.parentElement === note.parentElement,
        noteTopGap: ir && nr ? Math.round(nr.top - ir.bottom) : null,
        noteLeftDelta: ir && nr ? Math.round(nr.left - ir.left) : null,
        noteOffsetTop: nr ? Math.round(nr.top - canvas.top) : null,
        selected: window.__selectedIds().length,
        header,
        first,
        canvasNote: window.__note(),
        inDeck: window.__notePanelInDeck(),
      };
    `);
    check(
      'La selezione dei colli è conservata creando la nota',
      withNote.selected === 1,
      `selezionati ${withNote.selected}`
    );
    check(
      'ItemInspector e NoteInspector convivono nella stessa colonna HUD',
      withNote.hasItem === true && withNote.hasNote === true && withNote.samePanel === true
    );
    check(
      'La nota appare come appendice subito sotto la card del collo (gap 10px, stesso left)',
      withNote.noteTopGap === 10 && withNote.noteLeftDelta === 0,
      `gap ${withNote.noteTopGap}px, left Δ ${withNote.noteLeftDelta}px`
    );
    check(
      'Il pannello è "Nota Laterale Selezionata" con badge coordinate',
      withNote.header.includes('Nota Laterale Selezionata') &&
        /X [\d.-]+ · Y [\d.-]+ cm/.test(withNote.header),
      withNote.header.slice(0, 90)
    );
    check(
      'La nota nasce ancorata alla quota Y del collo (x = 280 cm)',
      withNote.canvasNote !== null &&
        Math.abs(withNote.canvasNote.x - 280) < 0.51 &&
        Math.abs(withNote.canvasNote.y - 0) < 0.51,
      `x ${withNote.canvasNote?.x}, y ${withNote.canvasNote?.y}`
    );

    /* =================================================================== *
     *  3) MODIFICA IN TEMPO REALE: TESTO, CORPO, MISURE, COLORE
     * =================================================================== */
    await typeInto(cdp, '#note-content-input', 'BANCALI POCO STABILI ATTENZIONE', 'HTMLTextAreaElement');
    const texted = await cdp.eval(`return window.__note();`);
    check(
      'Il testo digitato nella card compare subito sul canvas',
      texted.text.includes('BANCALI POCO STABILI'),
      texted.text
    );

    await clickSelector(cdp, '#note-inspector [data-font-size="18"]');
    const bigFont = await cdp.eval(`
      const n = window.__note();
      const active = document.querySelector('#note-inspector [data-font-size="18"]')?.getAttribute('aria-pressed');
      return { fontSize: n.fontSize, active };
    `);
    check(
      'Il selettore A+ porta il corpo del testo a 18 px (canvas compreso)',
      bigFont.fontSize === 18 && bigFont.active === 'true',
      `font ${bigFont.fontSize}px · aria-pressed ${bigFont.active}`
    );

    await typeInto(cdp, '#note-width-input', '110');
    const widened = await cdp.eval(`return { note: window.__note(), value: document.getElementById('note-width-input').value };`);
    check(
      'Il campo W cm ridimensiona la card sul canvas',
      Math.abs(widened.note.width - 110) < 0.51 && widened.value === '110',
      `width ${widened.note.width} cm`
    );
    await typeInto(cdp, '#note-width-input', '10');
    const clamped = await cdp.eval(`return { note: window.__note(), value: document.getElementById('note-width-input').value };`);
    check(
      'Il campo W cm è clampato al minimo di 70 cm',
      Math.abs(clamped.note.width - 70) < 0.51 && clamped.value === '70',
      `width ${clamped.note.width} cm · input ${clamped.value}`
    );

    await typeInto(cdp, '#note-height-input', '150');
    const heightened = await cdp.eval(`return window.__note();`);
    check(
      'Il campo H cm fissa l\'altezza della card',
      Math.abs(heightened.height - 150) < 0.51,
      `height ${heightened.height} cm`
    );

    await clickSelector(cdp, '#note-inspector [aria-label="Sfondo #DCFCE7"]');
    const colored = await cdp.eval(`
      const n = window.__note();
      const active = document.querySelector('#note-inspector [aria-label="Sfondo #DCFCE7"]')?.getAttribute('aria-pressed');
      return { fill: n.fill, active };
    `);
    check(
      'La palette pastello ricolora la nota (ring sulla tinta attiva)',
      String(colored.fill).toLowerCase() === '#dcfce7' && colored.active === 'true',
      `fill ${colored.fill} · aria-pressed ${colored.active}`
    );

    /* =================================================================== *
     *  4) SIDEBAR DESTRA IMMOBILE E PRIVA DI PANNELLI NOTA
     * =================================================================== */
    check(
      'Il pannello nota NON è più nella sidebar destra',
      withNote.inDeck === false && (await cdp.eval(`return window.__notePanelInDeck();`)) === false
    );
    check(
      'La sidebar destra non nomina più "Nota Laterale Selezionata"',
      !(await cdp.eval(`return window.__deckText().includes('Nota Laterale Selezionata');`))
    );

    const summaryOpen = await cdp.eval(`return window.__summaryTop();`);
    const shotStack = await cdp.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync('shots', { recursive: true });
    writeFileSync(
      'shots/note-inspector-hud-appendix.png',
      Buffer.from(shotStack.data, 'base64')
    );
    await clickSelector(cdp, '#note-inspector-close');
    const afterClose = await cdp.eval(`
      return {
        hasNote: !!window.__noteInspector(),
        hasItem: !!window.__inspector(),
        summaryTop: window.__summaryTop(),
        selected: window.__selectedIds().length,
        noteStillOnCanvas: window.__noteCards(),
      };
    `);
    check(
      'La X chiude solo la nota e lascia visibile la card del collo',
      afterClose.hasNote === false && afterClose.hasItem === true && afterClose.selected === 1
    );
    check('La nota resta sul pianale (si chiude l\'editing, non la nota)', afterClose.noteStillOnCanvas === 1);
    check(
      'Riepilogo Stiva perfettamente fermo con la card nota aperta/chiusa',
      Math.abs(afterClose.summaryTop - summaryOpen) <= 0.5,
      `aperta ${summaryOpen} · chiusa ${afterClose.summaryTop}`
    );

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync('shots', { recursive: true });
    writeFileSync('shots/note-inspector-hud.png', Buffer.from(shot.data, 'base64'));

    /* =================================================================== *
     *  5) SOLA NOTA SELEZIONATA (CLICK SUL CANVAS) + CANCELLAZIONE CON `Canc`
     * =================================================================== */
    const notePoint = await cdp.eval(`
      const n = document.querySelector('[data-canvas-note]');
      const r = n.getBoundingClientRect();
      return { x: r.left + 18, y: r.top + r.height / 2 };
    `);
    await clickAt(cdp, notePoint.x, notePoint.y);
    const soloNote = await cdp.eval(`
      const note = window.__noteInspector();
      const canvas = document.querySelector('.canvas-hud').parentElement.getBoundingClientRect();
      const nr = note ? note.getBoundingClientRect() : null;
      return {
        hasNote: !!note,
        hasItem: !!window.__inspector(),
        offsetLeft: nr ? Math.round(nr.left - canvas.left) : null,
        offsetTop: nr ? Math.round(nr.top - canvas.top) : null,
        selectedItems: window.__selectedIds().length,
      };
    `);
    check(
      'Cliccando la sola nota la card appare da sola in alto a sinistra',
      soloNote.hasNote === true &&
        soloNote.hasItem === false &&
        soloNote.offsetLeft === 16 &&
        soloNote.offsetTop === 16,
      `left ${soloNote.offsetLeft}, top ${soloNote.offsetTop}`
    );

    await pressDelete(cdp);
    const afterDelete = await cdp.eval(`
      return {
        cards: window.__noteCards(),
        hasNote: !!window.__noteInspector(),
        summaryTop: window.__summaryTop(),
      };
    `);
    check(
      '`Canc` elimina la nota selezionata e chiude la card',
      afterDelete.cards === 0 && afterDelete.hasNote === false
    );
    check(
      'Riepilogo Stiva ancora fermo dopo l\'eliminazione',
      Math.abs(afterDelete.summaryTop - summaryOpen) <= 0.5,
      `${summaryOpen} → ${afterDelete.summaryTop}`
    );

    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    console.log(`\n${passed}/${passed + failed} controlli superati`);
    console.log(
      `Durata della verifica: ${((Date.now() - startedAt) / 1000).toFixed(2)} s (limite ${WATCHDOG_MS / 1000} s)`
    );
    console.log('Evidenza grafica: shots/note-inspector-hud.png');
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
