/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — FASE 2: TRAVASO COLLI CROSS-PIANALE
 *
 *  Pilota Chrome reale via Chrome DevTools Protocol (zero dipendenze aggiunte) e
 *  verifica end-to-end l'interazione di flotta fra due stalli affiancati:
 *
 *    1. **Drag & Drop cross-pianale**: un collo trascinato da MEZZO 1 supera le
 *       sponde, viaggia nel canale neutro di 260 cm (2 mezzi, A4 verticale) e al
 *       rilascio su MEZZO 2 viene trasferito (stiva locale del bersaglio, Mezzo
 *       Attivo che segue);
 *    2. **Drag Overlay**: durante il transito il collo vive nel layer globale
 *       `#canvas-drag-overlay` (in testa al DOM, sopra il fondo bianco dei
 *       camion) e nello stallo di partenza resta la sola **sagoma fantasma**
 *       (`opacity 0.35` + bordo tratteggiato);
 *    3. **Zona di rilascio**: entrando nella sagoma di MEZZO 2 compare il
 *       contorno di evidenziazione con il badge `📥 Rilascia per caricare su
 *       MEZZO 2`;
 *    4. **Annullamento elastico (Opzione A)**: un rilascio nel canale neutro di
 *       260 cm non muta la stiva e non aggiunge passi alla cronologia;
 *    5. **Un solo passo di Undo**: il trasferimento si annulla con un unico
 *       `Ctrl + Z`, che riporta i colli su MEZZO 1;
 *    6. **Pulsante `➔ MEZZO n` dell'ItemInspector**: sposta i colli selezionati
 *       sul primo slot utile del mezzo scelto (`findSmartSpawnPosition`).
 *
 *  Uso:  node scripts/verify-bay-transfer.mjs [url]
 *  Chiude sempre con `browser.close()` + `process.exit(0)` entro 30 secondi.
 * -------------------------------------------------------------------------- */

const DEV_URL = process.argv[2] || 'http://127.0.0.1:5199/truck-planner/';
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9342);
const WATCHDOG_MS = 30000;
const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Collo di catalogo usato nelle verifiche (PLT INDU, Piatto 120 × 100). */
const INDU = { code: 'INDU', width: 120, length: 100 };

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

/* --- Interazioni reali con la pagina --------------------------------------- */

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
  await sleep(180);
};

const dispatchMove = (cdp, x, y, modifiers = 0) =>
  cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    modifiers,
  });

/** Aggiunge un collo al Mezzo Attivo tramite il comando rapido "Punta". */
const addItemToActiveBay = async (cdp, code, expectedTotal) => {
  await clickElement(cdp, `quick-punta-${code}`);
  await waitFor(
    async () =>
      cdp.eval(
        `return document.querySelectorAll('[data-canvas-item]').length === ${expectedTotal} ? 1 : 0;`
      ),
    4000,
    `aggiunta del collo (totale atteso ${expectedTotal})`
  );
};

/** Invio di `Ctrl + Z` reale alla pagina (motore Undo a snapshot). */
const pressUndo = async (cdp) => {
  await cdp.eval(`
    const active = document.activeElement;
    if (active && active !== document.body) active.blur();
    document.body.focus();
    return 1;
  `);
  const key = { key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, nativeVirtualKeyCode: 90 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, ...key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, ...key });
  await sleep(260);
};

/* --- Geometria: dal mondo (cm) allo schermo (px) --------------------------- */

/**
 * Riferimenti di scena: trasformazione del gruppo di mondo (`translate(pan)
 * scale(zoom)`), origine dell'SVG nello schermo e stalli con la loro traslazione
 * in cm. Da qui si ricavano le coordinate degli eventi mouse reali.
 */
const SCENE = `
  const world = document.querySelector('[data-canvas-world="world"]');
  const svg = document.querySelector('svg');
  const m = /translate\\(([-\\d.eE+]+),\\s*([-\\d.eE+]+)\\)\\s*scale\\(([-\\d.eE+]+)\\)/.exec(
    world.getAttribute('transform') || ''
  );
  if (!m) return null;
  const rect = svg.getBoundingClientRect();
  return {
    panX: Number(m[1]),
    panY: Number(m[2]),
    zoom: Number(m[3]),
    rectLeft: rect.left,
    rectTop: rect.top,
    bays: [...document.querySelectorAll('[data-canvas-bay]')].map((g) => {
      const t = /translate\\(([-\\d.]+)/.exec(g.getAttribute('transform') || '');
      const body = g.querySelector('rect');
      return {
        id: g.getAttribute('data-canvas-bay'),
        offset: t ? Number(t[1]) : 0,
        width: body ? Number(body.getAttribute('width')) : 0,
        length: body ? Number(body.getAttribute('height')) : 0,
      };
    }),
  };
`;

/** Converte un punto in cm di mondo nelle coordinate schermo degli eventi mouse. */
const worldToScreen = (scene, worldX, worldY) => ({
  x: scene.rectLeft + scene.panX + worldX * scene.zoom,
  y: scene.rectTop + scene.panY + worldY * scene.zoom,
});

/** Misure del Drag Overlay e della zona di rilascio, lette dal DOM. */
const DRAG_STATE = `
  const overlay = document.getElementById('canvas-drag-overlay');
  const members = overlay ? [...overlay.children] : [];
  const texts = overlay ? [...overlay.querySelectorAll('text')].map((t) => (t.textContent || '').trim()) : [];
  const dropBays = [...document.querySelectorAll('[data-canvas-drop-target]')].map((g) => {
    const badgeGroup = g.querySelector('g');
    const text = badgeGroup ? badgeGroup.querySelector('text') : null;
    const badgeRect = badgeGroup ? badgeGroup.querySelector('rect') : null;
    const textBox = text ? text.getBoundingClientRect() : null;
    const badgeBox = badgeRect ? badgeRect.getBoundingClientRect() : null;
    const header = g
      .closest('[data-canvas-bay]')
      ?.querySelector('[data-canvas-bay-header] rect');
    const headerBox = header ? header.getBoundingClientRect() : null;
    const svgBox = document.querySelector('svg').getBoundingClientRect();
    return {
      id: g.getAttribute('data-canvas-drop-target'),
      stroke: g.querySelector('rect')?.getAttribute('stroke') ?? null,
      dash: g.querySelector('rect')?.getAttribute('stroke-dasharray') ?? null,
      badge: [...g.querySelectorAll('text')].map((t) => (t.textContent || '').trim()).join(' '),
      badgeTransform: badgeGroup ? badgeGroup.getAttribute('transform') : null,
      badgeText: textBox
        ? { top: textBox.top, bottom: textBox.bottom, left: textBox.left, right: textBox.right }
        : null,
      badgeRectBox: badgeBox
        ? { top: badgeBox.top, bottom: badgeBox.bottom, left: badgeBox.left, right: badgeBox.right }
        : null,
      headerBottom: headerBox ? headerBox.bottom : null,
      // Il badge deve essere INTERAMENTE dentro l'area del canvas: la fascia
      // sopra la Cabina è quella che l'inquadratura "adatta a schermo" riserva
      // all'intestazione, quindi un badge troppo in alto verrebbe tagliato.
      insideSvg:
        !!textBox &&
        !!badgeBox &&
        badgeBox.top >= svgBox.top &&
        badgeBox.bottom <= svgBox.bottom &&
        badgeBox.left >= svgBox.left &&
        badgeBox.right <= svgBox.right &&
        textBox.top >= svgBox.top &&
        textBox.bottom <= svgBox.bottom,
      // ...e non deve coprire la pillola di intestazione dello stallo bersaglio.
      // Il testo del badge deve stare DENTRO la propria pastiglia blu (nessuno
      // sbordamento ai lati) e sotto la pillola di intestazione dello stallo.
      textInsideBadge:
        !!textBox &&
        !!badgeBox &&
        textBox.left >= badgeBox.left - 0.5 &&
        textBox.right <= badgeBox.right + 0.5,
      belowHeader: !!textBox && headerBox ? textBox.top >= headerBox.bottom : null,
    };
  });
  // Sagome fantasma: colli con opacity ridotta nello stallo di partenza.
  const ghosts = [...document.querySelectorAll('[data-canvas-bay] > g[data-canvas-item]')]
    .filter((g) => Number(g.getAttribute('opacity')) < 1)
    .map((g) => ({
      id: g.getAttribute('data-item-id'),
      opacity: Number(g.getAttribute('opacity')),
      dash: g.querySelector('rect')?.getAttribute('stroke-dasharray') ?? null,
      bay: g.closest('[data-canvas-bay]')?.getAttribute('data-canvas-bay') ?? null,
    }));
  return {
    overlayPresent: !!overlay,
    overlayMemberCount: members.length,
    overlayTransforms: members.map((g) => g.getAttribute('transform')),
    overlayStroke: members[0]?.querySelector('rect')?.getAttribute('stroke') ?? null,
    overlayDash: members[0]?.querySelector('rect')?.getAttribute('stroke-dasharray') ?? null,
    overlayTexts: texts,
    // Il layer di overlay vive in coda al gruppo di mondo: dopo TUTTI gli stalli.
    overlayAfterBays:
      !!overlay &&
      overlay.parentElement?.getAttribute('data-canvas-world') === 'world' &&
      (overlay.previousElementSibling?.hasAttribute('data-canvas-bay') ?? false),
    overlayBayCount: overlay
      ? [...(overlay.parentElement?.children ?? [])].filter((n) =>
          n.hasAttribute('data-canvas-bay')
        ).length
      : 0,
    dropBays,
    ghosts,
  };
`;

/** Fotografia della distribuzione dei colli fra gli stalli. */
const FLEET_ITEMS = `
  return [...document.querySelectorAll('[data-canvas-bay]')].map((g) => ({
    id: g.getAttribute('data-canvas-bay'),
    items: [...g.querySelectorAll('[data-item-id]')].map((n) => ({
      id: n.getAttribute('data-item-id'),
      // Il filtro diretto sui figli esclude i colli del Drag Overlay, che vivono
      // nel layer globale in coda al mondo.
      transform: n.getAttribute('transform'),
      ghost: Number(n.getAttribute('opacity') ?? 1) < 1,
    })),
    active: (g.querySelector('[data-canvas-bay-header]')?.textContent || '').includes('ATTIVO'),
  }));
`;

/* --- Script ----------------------------------------------------------------- */

const main = async () => {
  const startedAt = Date.now();
  const profileDir = mkdtempSync(join(tmpdir(), 'bay-transfer-profile-'));
  const chrome = spawn(
    CHROME_PATH,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1800,1100',
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
      8000,
      'Chrome DevTools endpoint'
    );

    ws = await connect(target);
    cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: DEV_URL });
    await waitFor(
      async () => cdp.eval(`return document.getElementById('btn-add-bay') ? 1 : 0;`),
      12000,
      'mount della plancia di comando'
    );

    /* --- 1) Centrale a due mezzi, primo collo su MEZZO 1 ---------------- */
    await addItemToActiveBay(cdp, INDU.code, 1);
    await clickElement(cdp, 'btn-add-bay');
    await waitFor(
      async () =>
        cdp.eval(`return document.querySelectorAll('[data-canvas-bay]').length === 2 ? 1 : 0;`),
      4000,
      'aggiunta del secondo mezzo'
    );
    await sleep(200);

    const scene0 = await cdp.eval(SCENE);
    const fleet0 = await cdp.eval(FLEET_ITEMS);
    const sourceBayId = fleet0[0].id;
    const targetBayId = fleet0[1].id;
    const movingId = fleet0[0].items[0].id;

    check(
      'Centrale a due mezzi: un collo su MEZZO 1 e pianale di MEZZO 2 vuoto',
      fleet0.length === 2 && fleet0[0].items.length === 1 && fleet0[1].items.length === 0,
      `${fleet0.map((b) => b.items.length).join('/')} colli`
    );
    check(
      'Il collo da trasferire è univocamente identificato sul canvas',
      typeof movingId === 'string' && scene0.bays.length === 2,
      `id=${movingId}, offset MEZZO 2=${scene0.bays[1].offset} cm`
    );

    /* --- 2) Drag cross-pianale: MEZZO 1 → canale → MEZZO 2 -------------- */
    const itemCenter = await cdp.eval(`
      const scene = ${JSON.stringify(scene0)};
      const bay = scene.bays.find((b) => b.id === ${JSON.stringify(sourceBayId)});
      const item = document.querySelector('[data-item-id=${JSON.stringify(movingId)}]');
      const t = /translate\\(([-\\d.]+),\\s*([-\\d.]+)\\)/.exec(item.getAttribute('transform'));
      const rect = item.querySelector('rect');
      return {
        worldX: bay.offset + Number(t[1]) + Number(rect.getAttribute('width')) / 2,
        worldY: Number(t[2]) + Number(rect.getAttribute('height')) / 2,
      };
    `);

    const from = worldToScreen(scene0, itemCenter.worldX, itemCenter.worldY);
    // Bersaglio: subito a ridosso della **parete sinistra** di MEZZO 2 (30 cm
    // locali, entro la tolleranza magnetica di 5 cm dal candidato `X = 0`), alla
    // stessa quota del collo di partenza.
    const targetBay = scene0.bays.find((b) => b.id === targetBayId);
    const targetWorldY = itemCenter.worldY;
    const to = worldToScreen(scene0, targetBay.offset + 30, targetWorldY);
    // Zona neutra: metà esatta del canale di 260 cm fra i due stalli.
    const neutralBay = scene0.bays.find((b) => b.id === sourceBayId);
    const neutral = worldToScreen(
      scene0,
      neutralBay.offset + neutralBay.width + 130,
      itemCenter.worldY
    );

    const down = { x: from.x, y: from.y, button: 'left', clickCount: 1 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...down });
    // Primo movimento: dentro lo stallo di partenza (promuove il gesto a drag).
    await dispatchMove(cdp, from.x + 6, from.y + 4);
    await sleep(90);
    const inSource = await cdp.eval(DRAG_STATE);

    // Transito nel canale neutro di 260 cm.
    await dispatchMove(cdp, neutral.x, neutral.y);
    await sleep(120);
    const inChannel = await cdp.eval(DRAG_STATE);

    // Ingresso nella sagoma del mezzo bersaglio.
    await dispatchMove(cdp, to.x, to.y);
    await sleep(120);
    const overTargetState = await cdp.eval(DRAG_STATE);

    check(
      'Drag Overlay: il blocco in movimento vive nel layer globale `#canvas-drag-overlay`',
      inSource.overlayPresent === true && inSource.overlayMemberCount === 1,
      `presente=${inSource.overlayPresent}, membri=${inSource.overlayMemberCount}`
    );
    check(
      'Nello stallo di partenza il collo resta come sagoma fantasma (opacity 0.35 + tratteggio)',
      inSource.ghosts.length === 1 &&
        inSource.ghosts[0].id === movingId &&
        Math.abs(inSource.ghosts[0].opacity - 0.35) < 0.001 &&
        inSource.ghosts[0].dash === '4 2' &&
        inSource.ghosts[0].bay === sourceBayId,
      JSON.stringify(inSource.ghosts)
    );
    check(
      'Nel canale neutro di 260 cm il collo è in transito libero: bordo ambra tratteggiato e dicitura `(zona neutra)`',
      inChannel.overlayPresent === true &&
        inChannel.overlayMemberCount === 1 &&
        inChannel.overlayStroke === '#F59E0B' &&
        inChannel.overlayDash === '6 3' &&
        inChannel.overlayTexts.includes('(zona neutra)'),
      `stroke=${inChannel.overlayStroke}, dash=${inChannel.overlayDash}, testi=${JSON.stringify(inChannel.overlayTexts)}`
    );
    check(
      'Il layer di overlay è in coda al mondo: disegnato DOPO tutti gli stalli (mai sotto il fondo bianco)',
      inChannel.overlayAfterBays === true && inChannel.overlayBayCount === 2,
      `dopo gli stalli=${inChannel.overlayAfterBays}, stalli=${inChannel.overlayBayCount}`
    );
    check(
      'Zona di rilascio: contorno blu `#2563EB` tratteggiato sul pianale di MEZZO 2',
      overTargetState.dropBays.length === 1 &&
        overTargetState.dropBays[0].id === targetBayId &&
        overTargetState.dropBays[0].stroke === '#2563EB' &&
        overTargetState.dropBays[0].dash === '10 5',
      JSON.stringify(overTargetState.dropBays)
    );
    check(
      'Badge sopra la Cabina: `📥 Rilascia per caricare su MEZZO 2`',
      overTargetState.dropBays.length === 1 &&
        /📥 Rilascia per caricare su MEZZO 2/.test(overTargetState.dropBays[0].badge),
      overTargetState.dropBays[0]?.badge ?? 'nessun badge'
    );
    check(
      'Il badge di rilascio resta dentro il canvas, sotto la pillola `MEZZO 2` e col testo dentro la pastiglia',
      overTargetState.dropBays.length === 1 &&
        overTargetState.dropBays[0].insideSvg === true &&
        overTargetState.dropBays[0].belowHeader === true &&
        overTargetState.dropBays[0].textInsideBadge === true,
      `dentro il canvas=${overTargetState.dropBays[0]?.insideSvg}, sotto l'header=${overTargetState.dropBays[0]?.belowHeader}, ` +
        `testo dentro la pastiglia=${overTargetState.dropBays[0]?.textInsideBadge}, transform=${overTargetState.dropBays[0]?.badgeTransform}, ` +
        `testo=${JSON.stringify(overTargetState.dropBays[0]?.badgeText)} pastiglia=${JSON.stringify(overTargetState.dropBays[0]?.badgeRectBox)}`
    );
    check(
      'Snap magnetico sul bersaglio: il collo si aggancia a filo della parete di MEZZO 2',
      (() => {
        const m = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(
          overTargetState.overlayTransforms[0] ?? ''
        );
        if (!m) return false;
        // Il cursore era a 30 cm dalla parete sinistra: entro la tolleranza
        // magnetica di 5 cm il blocco deve essere risucchiato a `X = 0`.
        const localX = Number(m[1]) - targetBay.offset;
        return Math.abs(localX) < 0.5;
      })(),
      `world=${overTargetState.overlayTransforms[0]} (offset MEZZO 2=${targetBay.offset})`
    );

    // Rilascio sul mezzo bersaglio.
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button: 'left',
      clickCount: 1,
    });
    await sleep(300);

    const afterTransfer = await cdp.eval(FLEET_ITEMS);
    const afterTransferDrag = await cdp.eval(DRAG_STATE);
    const transferredItem = afterTransfer[1].items.find((i) => i.id === movingId);

    check(
      'Rilascio su MEZZO 2: il collo lascia MEZZO 1 e risiede stabilmente sul bersaglio',
      afterTransfer[0].items.length === 0 &&
        afterTransfer[1].items.length === 1 &&
        transferredItem !== undefined &&
        transferredItem.ghost === false,
      `${afterTransfer.map((b) => b.items.length).join('/')} colli`
    );
    check(
      'Coordinate convertite in locali: nessun residuo della traslazione di MEZZO 1',
      (() => {
        const m = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(transferredItem?.transform ?? '');
        if (!m) return false;
        const x = Number(m[1]);
        const y = Number(m[2]);
        // La posizione attesa è quella ANTEPRIMA dall'overlay nell'ultimo frame
        // (già agganciata alla parete e convertita in locali): se coincidesse con
        // la traslazione di MEZZO 1 (510 cm) il travaso sarebbe corrotto.
        const previewMatch = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(
          overTargetState.overlayTransforms[0] ?? ''
        );
        const expectedX = previewMatch ? Number(previewMatch[1]) - targetBay.offset : NaN;
        return (
          Math.abs(x - expectedX) < 0.2 &&
          Math.abs(x) < 0.5 &&
          x + INDU.width <= targetBay.width + 0.001 &&
          y >= -0.001 &&
          y + INDU.length <= targetBay.length + 0.001
        );
      })(),
      `${transferredItem?.transform} (anteprima ${overTargetState.overlayTransforms[0]})`
    );
    check(
      'Lo stallo di destinazione diventa il Mezzo Attivo (badge `ATTIVO` su MEZZO 2)',
      afterTransfer[1].active === true && afterTransfer[0].active === false,
      afterTransfer.map((b) => `${b.id}:${b.active}`).join(' | ')
    );
    check(
      'A gesto concluso il Drag Overlay e la zona di rilascio spariscono dal DOM',
      afterTransferDrag.overlayPresent === false && afterTransferDrag.dropBays.length === 0,
      `overlay=${afterTransferDrag.overlayPresent}, drop=${afterTransferDrag.dropBays.length}`
    );

    /* --- 3) Un solo `Ctrl + Z` riporta il collo su MEZZO 1 --------------- */
    await pressUndo(cdp);
    await sleep(200);
    const afterUndo = await cdp.eval(FLEET_ITEMS);
    check(
      'Un solo `Ctrl + Z` annulla l\'intero trasferimento: il collo torna su MEZZO 1',
      afterUndo[0].items.length === 1 &&
        afterUndo[0].items[0].id === movingId &&
        afterUndo[1].items.length === 0,
      `${afterUndo.map((b) => b.items.length).join('/')} colli`
    );

    /* --- 4) Annullamento elastico nel canale neutro di 260 cm (Opzione A) - */
    // Prima del gesto si attiva esplicitamente il mezzo che ospita il collo: il
    // gesto deve partire da uno stallo comandato, come farebbe l'operatore.
    const itemHome = await cdp.eval(`
      const id = ${JSON.stringify(movingId)};
      for (const g of document.querySelectorAll('[data-canvas-bay]')) {
        if (g.querySelector('[data-item-id="' + id + '"]')) {
          return { bayId: g.getAttribute('data-canvas-bay') };
        }
      }
      return null;
    `);
    if (!itemHome) throw new Error('collo da trasferire non presente in scena');
    await clickElement(cdp, `bay-pill-${itemHome.bayId}`);
    await sleep(220);

    const scene1 = await cdp.eval(SCENE);
    const currentCenter = await cdp.eval(`
      const scene = ${JSON.stringify(scene1)};
      const id = ${JSON.stringify(movingId)};
      for (const bay of scene.bays) {
        const node = document
          .querySelector('[data-canvas-bay="' + bay.id + '"]')
          ?.querySelector('[data-item-id="' + id + '"]');
        if (!node) continue;
        const t = /translate\\(([-\\d.]+),\\s*([-\\d.]+)\\)/.exec(node.getAttribute('transform'));
        const rect = node.querySelector('rect');
        return {
          bayId: bay.id,
          worldX: bay.offset + Number(t[1]) + Number(rect.getAttribute('width')) / 2,
          worldY: Number(t[2]) + Number(rect.getAttribute('height')) / 2,
          transform: node.getAttribute('transform'),
        };
      }
      return null;
    `);
    if (!currentCenter) throw new Error('collo non localizzato nella scena');
    const homeBay = scene1.bays.find((b) => b.id === currentCenter.bayId);
    const otherBay = scene1.bays.find((b) => b.id !== currentCenter.bayId);

    const start = worldToScreen(scene1, currentCenter.worldX, currentCenter.worldY);
    // Canale neutro: metà esatta dello stacco di 260 cm fra lo stallo di casa e
    // il vicino (`offset[1] = 250 + 260 = 510`, centro del canale a 380 cm).
    const channel = worldToScreen(
      scene1,
      homeBay.offset + homeBay.width + 130,
      currentCenter.worldY
    );

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: start.x,
      y: start.y,
      button: 'left',
      clickCount: 1,
    });
    await dispatchMove(cdp, channel.x, channel.y);
    await sleep(120);
    await dispatchMove(cdp, channel.x + 10, channel.y + 6);
    await sleep(120);
    const elasticMid = await cdp.eval(DRAG_STATE);
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: channel.x + 10,
      y: channel.y + 6,
      button: 'left',
      clickCount: 1,
    });
    await sleep(300);

    const afterElastic = await cdp.eval(FLEET_ITEMS);
    const afterElasticDrag = await cdp.eval(DRAG_STATE);
    const homeAfterElastic = afterElastic.find((b) => b.id === currentCenter.bayId);
    const otherAfterElastic = afterElastic.find((b) => b.id === otherBay.id);

    check(
      'Nel canale il collo è libero (`zona neutra`) e non agganciato ad alcuno stallo',
      elasticMid.overlayStroke === '#F59E0B' && elasticMid.dropBays.length === 0,
      `stroke=${elasticMid.overlayStroke}, drop=${elasticMid.dropBays.length}`
    );
    check(
      'Rilascio nel canale: annullamento elastico, la stiva non muta di un millimetro',
      homeAfterElastic.items.length === 1 &&
        homeAfterElastic.items[0].id === movingId &&
        homeAfterElastic.items[0].transform === currentCenter.transform &&
        otherAfterElastic.items.length === 0,
      `stallo di casa: ${homeAfterElastic.items[0]?.transform} (atteso ${currentCenter.transform})`
    );
    check(
      'Il rilascio elastico non lascia residui grafici sul canvas',
      afterElasticDrag.overlayPresent === false && afterElasticDrag.ghosts.length === 0,
      `overlay=${afterElasticDrag.overlayPresent}, fantasmi=${afterElasticDrag.ghosts.length}`
    );
    check(
      'Il gesto annullato non tocca il Mezzo Attivo, che resta quello di partenza',
      homeAfterElastic.active === true,
      afterElastic.map((b) => `${b.id}:${b.active}`).join(' | ')
    );

    /* --- 5) Pulsante rapido `➔ MEZZO n` dell'ItemInspector -------------- */
    await clickElement(cdp, `bay-pill-${currentCenter.bayId}`);
    await sleep(220);
    const itemBox = await cdp.eval(`
      const item = document.querySelector('[data-item-id=${JSON.stringify(movingId)}]');
      if (!item) return null;
      const rect = item.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    `);
    if (!itemBox) throw new Error('collo non cliccabile per la selezione');
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: itemBox.x,
      y: itemBox.y,
      button: 'left',
      clickCount: 1,
    });
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: itemBox.x,
      y: itemBox.y,
      button: 'left',
      clickCount: 1,
    });
    await sleep(250);

    const inspector = await cdp.eval(`
      const card = document.getElementById('item-inspector');
      if (!card) return null;
      const buttons = [...card.querySelectorAll('[id^="btn-move-to-"]')].map((b) => ({
        id: b.id,
        text: (b.textContent || '').trim(),
        title: b.getAttribute('title'),
      }));
      const heading = [...card.querySelectorAll('span')].map((s) => (s.textContent || '').trim());
      return { buttons, hasHeading: heading.includes('Sposta su altro Mezzo') };
    `);

    const targetIndex = scene1.bays.findIndex((b) => b.id === otherBay.id);

    check(
      'ItemInspector: con più mezzi compare la sezione `Sposta su altro Mezzo`',
      inspector !== null && inspector.hasHeading === true,
      `card=${inspector !== null}, heading=${inspector?.hasHeading}`
    );
    check(
      `Un solo pulsante rapido, per l'altro mezzo: \`➔ MEZZO ${targetIndex + 1}\``,
      inspector?.buttons.length === 1 &&
        inspector.buttons[0].text.includes(`MEZZO ${targetIndex + 1}`) &&
        inspector.buttons[0].id === `btn-move-to-${otherBay.id}`,
      JSON.stringify(inspector?.buttons)
    );

    await clickElement(cdp, `btn-move-to-${otherBay.id}`);
    await sleep(300);

    const afterQuickMove = await cdp.eval(FLEET_ITEMS);
    const homeAfterQuick = afterQuickMove.find((b) => b.id === currentCenter.bayId);
    const otherAfterQuick = afterQuickMove.find((b) => b.id === otherBay.id);

    check(
      'Click sul pulsante rapido: i colli si dispongono sul primo slot utile (Cabina, parete sinistra)',
      homeAfterQuick.items.length === 0 &&
        otherAfterQuick.items.length === 1 &&
        otherAfterQuick.items[0].id === movingId &&
        otherAfterQuick.items[0].transform === 'translate(0, 0)',
      `bersaglio: ${otherAfterQuick.items[0]?.transform}`
    );
    check(
      'Il travaso rapido rende il bersaglio il Mezzo Attivo e mantiene la selezione',
      otherAfterQuick.active === true && homeAfterQuick.active === false,
      afterQuickMove.map((b) => `${b.id}:${b.active}`).join(' | ')
    );

    await pressUndo(cdp);
    await sleep(220);
    const afterQuickMoveUndo = await cdp.eval(FLEET_ITEMS);
    check(
      'Un solo `Ctrl + Z` ripristina i colli sullo stallo di partenza',
      afterQuickMoveUndo.find((b) => b.id === currentCenter.bayId).items.length === 1 &&
        afterQuickMoveUndo.find((b) => b.id === otherBay.id).items.length === 0,
      `${afterQuickMoveUndo.map((b) => b.items.length).join('/')} colli`
    );

    /* --- 6) Nessun errore runtime --------------------------------------- */
    check(
      'Nessun errore runtime in console',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ')
    );

    console.log(`\n${passed}/${passed + failed} controlli superati`);
    console.log(`Durata della verifica: ${((Date.now() - startedAt) / 1000).toFixed(2)} s (limite 30 s)`);
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
