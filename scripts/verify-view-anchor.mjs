/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — ANCORAGGIO VERTICALE DELLA CENTRALE (asse Y)
 *
 *  DIFETTO ORIGINALE (layout shift): i pianali saltavano verso il basso sia
 *  aggiungendo un secondo/terzo mezzo sia cambiando la configurazione di un
 *  mezzo **a parità di lunghezza utile**.
 *
 *  Causa: l'applicazione calcolava la posizione verticale in **due modi
 *  diversi e incompatibili**.
 *   - `fitView` (inquadratura automatica e Reset) **centrava la scena logica**
 *     (pianale + fascia di intestazione di `CABINA_ELEVATION_CM` = 128 cm):
 *     `pan.y = (H − (L + 128) × zoom) / 2 + 128 × zoom`;
 *   - `clampPanY` (Caso A) **centrava il solo pianale**:
 *     `pan.y = (H − L × zoom) / 2`.
 *  Il primo fotogramma passava dal clamp e ogni rifacimento dell'inquadratura
 *  dalla `fitView`: la differenza è esattamente `128 × zoom / 2` px (≈ 30–40 px
 *  ai livelli di zoom reali), cioè il salto verso il basso segnalato.
 *
 *  FIX: **una sola formula di ancoraggio verticale** (`anchoredPanY`), condivisa
 *  da `fitView` e da `clampPanY`: il punto più alto della scena (bordo superiore
 *  dell'header di stallo `MEZZO n`) resta sempre a `PAN_TOP_MARGIN_PX = 40` px
 *  dal bordo alto del viewport, quindi `pan.y = 40 + 128 × zoom`. La posizione
 *  verticale dei pianali dipende così dalla **sola** scala e non dal numero di
 *  mezzi né dalla loro configurazione.
 *
 *  Controlli (per 3 formati di viewport, incluso quello che manda il pianale nel
 *  vecchio ramo "Caso B con intervallo invertito"):
 *    1. all'apertura il bordo alto dell'header di stallo è a 40 px dal bordo
 *       alto del viewport (ancoraggio, non centratura);
 *    2. l'intero pianale è dentro il viewport (nessuna parte tagliata);
 *    3. `+ MEZZO 2` e `+ MEZZO 3`: **nessuna traslazione verticale** — la
 *       posizione della Cabina è la funzione pura della scala
 *       `pan.y = 40 + 128 × zoom`. Quando il fit non cambia zoom (viewport
 *       ampio o basso: la larghezza non è il vincolo) lo spostamento è
 *       **esattamente 0 px**; quando il fit deve rimpicciolire la scena per
 *       far entrare i mezzi in larghezza (viewport stretto e alto) lo
 *       scostamento residuo vale **esattamente** `128 × Δzoom`, cioè la scena
 *       si riscala attorno al proprio bordo alto ancorato — mai una traslazione
 *       arbitraria;
 *    4. con 3 mezzi gli header sono tutti a 40 px e gli stalli sono affiancati
 *       in ordine crescente di offset;
 *    5. cambio configurazione a parità di lunghezza (`bilico_cc` 250 → `bilico_std`
 *       245, entrambi 1328 cm): **spostamento verticale = 0 px**;
 *    6. cambio configurazione con lunghezza diversa (`→ motrice_3a` 760 cm):
 *       ancoraggio preservato (bordo alto a 40 px) e pianale interamente visibile;
 *    7. `Reset / Adatta a schermo` dopo pan e zoom manuali: ritorno **esatto**
 *       all'ancoraggio (nessun salto) e Reset idempotente;
 *    8. nessun errore runtime in console.
 *
 *  Uso:  node scripts/verify-view-anchor.mjs [url]
 *  Chiude sempre con `browser.close()` + `process.exit(0)` entro 30 secondi
 *  (la verifica ripete l'intero ciclo su tre formati di viewport).
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://localhost:5199/truck-planner/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9343);
const WATCHDOG_MS = 30000;

/** Margine alto (px) dell'ancoraggio: `PAN_TOP_MARGIN_PX` di `TruckCanvas.tsx`. */
const PAN_TOP_MARGIN_PX = 40;
/** Elevazione (cm) della fascia sopra la Cabina: `CABINA_LABEL_OFFSET_CM`. */
const CABINA_LABEL_OFFSET_CM = 128;
/** Lunghezza (cm) del Bilico CC / Frigo e della Motrice 3 Assi. */
const BILICO_LENGTH_CM = 1328;
const MOTRICE_LENGTH_CM = 760;
/** Tolleranza (px) delle misure di posizione: sono numeri interi di layout. */
const EPS = 0.05;

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

/**
 * Fotografia della vista: trasformazione del mondo (`getScreenCTM`), bordo alto
 * e fondo di ogni stallo in px di viewport. `panY` **è** la quota della Cabina
 * (Y = 0) sullo schermo, quindi il suo scostamento fra due misure è esattamente
 * lo "spostamento verticale dei pianali" lamentato nel difetto.
 */
const PAGE_HELPERS = `
  window.__view = () => {
    const world = document.querySelector('[data-canvas-world="world"]');
    const svg = world.ownerSVGElement;
    const m = world.getScreenCTM();
    const svgRect = svg.getBoundingClientRect();
    const bays = Array.from(document.querySelectorAll('[data-canvas-bay]')).map((g) => {
      const t = g.transform.baseVal.consolidate().matrix;
      const rect = g.getBoundingClientRect();
      const deck = g.querySelector('rect');
      return {
        id: g.getAttribute('data-canvas-bay'),
        offsetCm: t.e,
        widthCm: Number(deck.getAttribute('width')),
        lengthCm: Number(deck.getAttribute('height')),
        headerTopPx: rect.top,
      };
    });
    return {
      zoom: m.a,
      panX: m.e,
      panY: m.f,
      cabinaPx: m.f,
      viewportTop: svgRect.top,
      viewportHeight: svgRect.height,
      bays,
    };
  };
  window.__click = async (id) => {
    document.getElementById(id).click();
    await new Promise((r) => setTimeout(r, 300));
    return 1;
  };
  window.__setConfig = async (value) => {
    const sel = document.querySelector('select');
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    return 1;
  };
  window.__resetView = async () => {
    document.querySelector('[aria-label="Reset / Adatta a schermo"]').click();
    await new Promise((r) => setTimeout(r, 350));
    return 1;
  };
  /** Pan verticale + zoom con la rotellina, ancorati al centro del canvas. */
  window.__wheel = async (deltaY, ctrl) => {
    const svg = document.querySelector('[data-canvas-world="world"]').ownerSVGElement;
    const rect = svg.getBoundingClientRect();
    svg.dispatchEvent(new WheelEvent('wheel', {
      deltaY, ctrlKey: !!ctrl, bubbles: true, cancelable: true,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
    }));
    await new Promise((r) => setTimeout(r, 250));
    return 1;
  };
  return 1;
`;

/** Bordo alto dell'header di stallo in px **relativi al viewport del canvas**. */
const headerTop = (view) =>
  view.bays.map((bay) => bay.headerTopPx - view.viewportTop);

/** Fondo del pianale più profondo, in px relativi al viewport del canvas. */
const deckBottom = (view) => view.panY + Math.max(...view.bays.map((b) => b.lengthCm)) * view.zoom;

/** Quota ancorata attesa della Cabina: `pan.y = 40 + 128 × zoom`. */
const anchoredCabinaPx = (view) => PAN_TOP_MARGIN_PX + CABINA_LABEL_OFFSET_CM * view.zoom;

/**
 * Descrive lo scostamento verticale della Cabina fra due fotografie,
 * distinguendo la **traslazione arbitraria** (difetto) dalla **riscalatura**
 * attorno all'ancoraggio: quando il fit deve ridurre lo zoom per far entrare i
 * mezzi in larghezza, il bordo alto della scena resta a 40 px e la Cabina scende
 * esattamente di `128 × Δzoom`. Qualsiasi altro scostamento è un difetto.
 */
const describeShift = (before, after) => {
  const deltaCabina = after.cabinaPx - before.cabinaPx;
  const deltaZoom = after.zoom - before.zoom;
  const scaleOnly = Math.abs(deltaCabina - CABINA_LABEL_OFFSET_CM * deltaZoom) < EPS;
  const anchored = Math.abs(after.cabinaPx - anchoredCabinaPx(after)) < EPS;
  return {
    deltaCabina,
    deltaZoom,
    ok: scaleOnly && anchored,
    detail:
      `Δcabina ${deltaCabina.toFixed(3)} px · Δzoom ${deltaZoom.toFixed(5)} ` +
      `(riscalatura attesa ${(CABINA_LABEL_OFFSET_CM * deltaZoom).toFixed(3)} px)` +
      (Math.abs(deltaZoom) < 1e-9 ? ' · zoom invariato' : ' · zoom ridotto dal fit'),
  };
};

/* --- Script --------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();
  const profileDir = mkdtempSync(join(tmpdir(), 'view-anchor-profile-'));
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

    /**
     * Apre l'app con un viewport esatto e restituisce la prima fotografia.
     * I tre formati coprono i regimi reali: schermo ampio (fit limitato
     * dall'altezza), schermo stretto e alto (fit limitato dalla larghezza),
     * schermo basso (dove il pianale usciva dal vecchio Caso A e finiva nel ramo
     * con intervallo invertito).
     */
    const openAt = async (width, height) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.send('Page.navigate', { url: DEV_URL });
      await waitFor(
        async () => cdp.eval(`return document.getElementById('btn-add-bay') ? 1 : 0;`),
        9000,
        'mount della sidebar'
      );
      await sleep(700);
      await cdp.eval(PAGE_HELPERS);
      return cdp.eval('return window.__view();');
    };

    const VIEWPORTS = [
      { w: 1600, h: 1113, label: 'ampio 1600×1113' },
      { w: 1024, h: 1400, label: 'stretto e alto 1024×1400' },
      { w: 1500, h: 620, label: 'basso 1500×620' },
    ];

    for (const vp of VIEWPORTS) {
      console.log(`\n--- VIEWPORT ${vp.label} ---`);
      const v0 = await openAt(vp.w, vp.h);

      // 1) Ancoraggio: bordo alto dell'header a PAN_TOP_MARGIN_PX dal bordo alto.
      const top0 = headerTop(v0)[0];
      check(
        `[${vp.label}] Ancoraggio in alto: header di MEZZO 1 a ${PAN_TOP_MARGIN_PX} px dal bordo alto del canvas`,
        Math.abs(top0 - PAN_TOP_MARGIN_PX) < EPS,
        `misurato ${top0.toFixed(2)} px · zoom ${v0.zoom.toFixed(4)} · panY ${v0.panY.toFixed(2)}`
      );

      // 2) L'intero pianale è dentro il viewport.
      check(
        `[${vp.label}] Il pianale è interamente visibile (nessuna parte tagliata)`,
        deckBottom(v0) <= v0.viewportHeight + EPS,
        `fondo ${deckBottom(v0).toFixed(2)} px su viewport ${v0.viewportHeight.toFixed(2)} px`
      );

      // 3) Aggiunta di mezzi: nessuna traslazione verticale dei pianali esistenti.
      const v1 = await cdp.eval(`await window.__click('btn-add-bay'); return window.__view();`);
      const v2 = await cdp.eval(`await window.__click('btn-add-bay'); return window.__view();`);

      const add2 = describeShift(v0, v1);
      check(
        `[${vp.label}] + MEZZO 2: nessuna traslazione verticale dei pianali già in scena`,
        add2.ok && v1.bays.length === 2 && Math.abs(headerTop(v1)[0] - PAN_TOP_MARGIN_PX) < EPS,
        add2.detail
      );

      const add3 = describeShift(v1, v2);
      check(
        `[${vp.label}] + MEZZO 3: nessuna traslazione verticale dei pianali già in scena`,
        add3.ok && v2.bays.length === 3 && Math.abs(headerTop(v2)[0] - PAN_TOP_MARGIN_PX) < EPS,
        add3.detail
      );

      // 4) Con 3 mezzi: ancoraggio preservato e stalli affiancati in ordine.
      check(
        `[${vp.label}] Con 3 mezzi l'ancoraggio in alto è preservato (tutti gli header a ${PAN_TOP_MARGIN_PX} px)`,
        headerTop(v2).every((top) => Math.abs(top - PAN_TOP_MARGIN_PX) < EPS) &&
          v2.bays.every((b, i) => i === 0 || b.offsetCm > v2.bays[i - 1].offsetCm),
        `header ${headerTop(v2).map((t) => t.toFixed(1)).join(' / ')} px`
      );

      /* --- Configurazione del mezzo: si riparte da un pianale singolo, così il
             menu agisce esattamente sul mezzo in esame (quello del report). --- */
      const single = await openAt(vp.w, vp.h);
      const cfgSame = await cdp.eval(`
        const before = window.__view();
        await window.__setConfig('bilico_std');
        const after = window.__view();
        return { before, after };
      `);
      const shiftSame = describeShift(cfgSame.before, cfgSame.after);
      check(
        `[${vp.label}] Cambio configurazione bilico_cc → bilico_std (stessa lunghezza 1328 cm): spostamento verticale ZERO`,
        shiftSame.ok &&
          Math.abs(cfgSame.after.bays[0].lengthCm - BILICO_LENGTH_CM) < EPS &&
          Math.abs(shiftSame.deltaCabina) < EPS,
        shiftSame.detail
      );

      const cfgOther = await cdp.eval(`
        const before = window.__view();
        await window.__setConfig('motrice_3a');
        const after = window.__view();
        return { before, after };
      `);
      const shiftOther = describeShift(cfgOther.before, cfgOther.after);
      check(
        `[${vp.label}] Cambio configurazione → motrice_3a (760 cm): ancoraggio in alto preservato e pianale interamente visibile`,
        shiftOther.ok &&
          Math.abs(cfgOther.after.bays[0].lengthCm - MOTRICE_LENGTH_CM) < EPS &&
          deckBottom(cfgOther.after) <= cfgOther.after.viewportHeight + EPS &&
          Math.abs(headerTop(cfgOther.after)[0] - PAN_TOP_MARGIN_PX) < EPS,
        `${shiftOther.detail} · fondo ${deckBottom(cfgOther.after).toFixed(2)} px su ${cfgOther.after.viewportHeight.toFixed(2)} px`,
      );

      // 7) Reset dopo pan e zoom manuali: ritorno esatto all'ancoraggio.
      const reset = await cdp.eval(`
        await window.__wheel(240);        // pan verticale verso il basso
        await window.__wheel(-400, true); // zoom avanti con Ctrl
        const moved = window.__view();
        await window.__resetView();
        const first = window.__view();
        await window.__resetView();
        const second = window.__view();
        return { moved, first, second };
      `);
      check(
        `[${vp.label}] Reset / Adatta a schermo dopo pan e zoom: ritorno esatto all'ancoraggio, nessun salto`,
        Math.abs(reset.moved.cabinaPx - reset.first.cabinaPx) > EPS &&
          Math.abs(reset.first.cabinaPx - anchoredCabinaPx(reset.first)) < EPS &&
          Math.abs(headerTop(reset.first)[0] - PAN_TOP_MARGIN_PX) < EPS &&
          deckBottom(reset.first) <= reset.first.viewportHeight + EPS,
        `ancoraggio atteso panY ${anchoredCabinaPx(reset.first).toFixed(2)} · misurato ${reset.first.panY.toFixed(2)} ` +
          `· zoom ${reset.first.zoom.toFixed(4)} · fondo ${deckBottom(reset.first).toFixed(2)} px`,
      );

      check(
        `[${vp.label}] Doppio Reset: la vista non si sposta (inquadratura idempotente)`,
        Math.abs(reset.second.cabinaPx - reset.first.cabinaPx) < EPS &&
          Math.abs(reset.second.zoom - reset.first.zoom) < 1e-9,
        `Δcabina ${(reset.second.cabinaPx - reset.first.cabinaPx).toFixed(3)} px`
      );

      // L'apertura di un pianale singolo è già ancorata (nessuna centratura).
      check(
        `[${vp.label}] All'apertura dell'app l'ancoraggio è già applicato (nessuno scatto al primo fotogramma)`,
        Math.abs(single.cabinaPx - anchoredCabinaPx(single)) < EPS,
        `panY ${single.cabinaPx.toFixed(2)} · atteso ${anchoredCabinaPx(single).toFixed(2)}`
      );
    }

    /* --- Evidenza grafica: tre mezzi affiancati ancorati in alto -------------- */
    mkdirSync('shots', { recursive: true });
    await openAt(1600, 1113);
    await cdp.eval(`
      await window.__click('btn-add-bay');
      await window.__click('btn-add-bay');
      return 1;
    `);
    const evidence = await cdp.eval('return window.__view();');
    check(
      'Evidenza: con 3 mezzi la scena è ancorata in alto (tutti gli header a 40 px)',
      evidence.bays.length === 3 &&
        headerTop(evidence).every((top) => Math.abs(top - PAN_TOP_MARGIN_PX) < EPS),
      `header ${headerTop(evidence).map((t) => t.toFixed(1)).join(' / ')} px`
    );
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync('shots/ancoraggio-verticale-centrale.png', Buffer.from(shot.data, 'base64'));
    console.log('\nEvidenza grafica: shots/ancoraggio-verticale-centrale.png');

    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    console.log(`\n${passed}/${passed + failed} controlli superati`);
    console.log(
      `Durata della verifica: ${((Date.now() - startedAt) / 1000).toFixed(2)} s (limite 30 s)`
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
  console.error('WATCHDOG: verifica interrotta oltre i 30 secondi');
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref?.();

main()
  .then(() => process.exit(failed === 0 ? 0 : 1))
  .catch((error) => {
    console.error('ERRORE:', error?.message ?? error);
    process.exit(1);
  });
