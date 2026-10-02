/* -------------------------------------------------------------------------- *
 *  VERIFICA HEADLESS — PREDISPOSIZIONE AL DEPLOY SU GITHUB PAGES
 *
 *  GitHub Pages pubblica una *project page* da una sottocartella
 *  (`https://<org>.github.io/truck-planner/`), non dalla radice del dominio:
 *  se `base` non è impostato, `dist/index.html` chiede `/assets/…` e la pagina
 *  online resta bianca (404 su JS e CSS). Questa verifica prova che la
 *  configurazione è corretta **e** che il bundle costruito funziona davvero
 *  sotto quel prefisso, senza aggiungere dipendenze.
 *
 *    1. `vite.config.ts` dichiara `base: '/truck-planner/'`;
 *    2. `.github/workflows/deploy.yml` esiste ed è il workflow ufficiale
 *       (trigger su `main` + `workflow_dispatch`, permessi `pages: write` /
 *       `id-token: write`, `npm ci` + `npm run build` su Node 20, artefatto
 *       `./dist`, deploy con `actions/deploy-pages@v4`);
 *    3. ogni `src` / `href` di `dist/index.html` è prefissato con
 *       `/truck-planner/` e il file referenziato **esiste** in `dist/`;
 *    4. nel bundle JS/CSS non resta **nessun** riferimento assoluto non
 *       prefissato (`/assets/…`) che a runtime darebbe 404;
 *    5. **controprova:** la stessa risorsa richiesta alla radice (`/assets/…`,
 *       cioè ciò che accadrebbe senza `base`) risponde 404;
 *    6. **prova end-to-end:** un server statico locale monta `dist/` esattamente
 *       sotto `/truck-planner/` (come fa GitHub Pages) e Chrome headless apre
 *       l'URL reale: la pagina monta, il foglio di stile è applicato
 *       (`scrollbar-gutter: stable` calcolato), un click su `↔ Piatto` di
 *       `PLT INDU` carica un collo sul canvas, tutte le richieste della pagina
 *       restano sotto il prefisso e non c'è nessun errore in console.
 *
 *  Uso:  npm run build && node scripts/verify-github-pages.mjs
 *  Chiude sempre con `process.exit(0)` (successo) entro 20 secondi.
 * -------------------------------------------------------------------------- */

const EXPECTED_BASE = '/truck-planner/';
const EXPECTED_REPO = 'truck-planner';
const PAGES_PORT = Number(process.env.PAGES_PORT || 5288);
const DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT || 9341);
const WATCHDOG_MS = 20000;
const CHROME_PATH =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

const DIST_DIR = resolve('dist');
const WORKFLOW_PATH = resolve('.github', 'workflows', 'deploy.yml');
const VITE_CONFIG_PATH = resolve('vite.config.ts');

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

/* --- Server statico che imita GitHub Pages (project page in sottocartella) -- */

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Serve `dist/` **solo** sotto `base`: qualunque percorso fuori dalla
 * sottocartella risponde 404, esattamente come il dominio
 * `angelocasablancalabs.github.io` fuori dalla project page.
 */
const servePages = (distDir, base, log) =>
  new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      const respond = (status, body, type) => {
        log.push({ pathname, status });
        res.writeHead(status, { 'Content-Type': type });
        res.end(body);
      };

      if (!pathname.startsWith(base)) {
        respond(404, 'Not Found', 'text/plain; charset=utf-8');
        return;
      }

      let relative = pathname.slice(base.length);
      if (relative === '' || relative.endsWith('/')) relative += 'index.html';

      const filePath = resolve(join(distDir, relative));
      if (!filePath.startsWith(distDir + sep) && filePath !== distDir) {
        respond(403, 'Forbidden', 'text/plain; charset=utf-8');
        return;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        respond(404, 'Not Found', 'text/plain; charset=utf-8');
        return;
      }
      respond(200, readFileSync(filePath), CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream');
    });
    server.listen(PAGES_PORT, '127.0.0.1', () => resolveServer(server));
  });

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
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
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
    return new Promise((res, reject) => {
      this.pending.set(id, { resolve: res, reject });
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
      await new Promise((res, reject) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
      });
      return ws;
    } catch {
      if (Date.now() > deadline) throw new Error('impossibile aprire il websocket CDP');
      await sleep(150);
    }
  }
};

/** Click fisico sul centro di un elemento (evento fidato, come l'operatore). */
const clickElement = async (cdp, id) => {
  const box = await cdp.eval(`
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  `);
  if (!box) throw new Error(`elemento #${id} non trovato`);
  const base = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  return box;
};

/* --- Script ----------------------------------------------------------------- */

const readText = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

const main = async () => {
  const startedAt = Date.now();

  /* --- 1) `base` in vite.config.ts ------------------------------------- */
  const viteConfig = readText(VITE_CONFIG_PATH);
  check(
    '`vite.config.ts` dichiara `base: \'/truck-planner/\'`',
    !!viteConfig && /base:\s*'\/truck-planner\/'/.test(viteConfig),
    viteConfig ? (viteConfig.match(/base:.*/) ?? ['assente'])[0].trim() : 'file assente'
  );

  /* --- 2) Workflow GitHub Actions -------------------------------------- */
  const workflow = readText(WORKFLOW_PATH);
  check('.github/workflows/deploy.yml presente', !!workflow, WORKFLOW_PATH);
  if (workflow) {
    const lines = workflow.split(/\r?\n/);
    const has = (re) => lines.some((l) => re.test(l));
    const workflowChecks = [
      ['nome workflow `Deploy to GitHub Pages`', /^name:\s*Deploy to GitHub Pages\s*$/],
      ['trigger `push` su `main`', /^\s{4}branches:\s*\['main'\]\s*$/],
      ['trigger manuale `workflow_dispatch`', /^\s{2}workflow_dispatch:\s*$/],
      ['permessi lettura contenuti', /^\s{2}contents:\s*read\s*$/],
      ['permessi scrittura Pages', /^\s{2}pages:\s*write\s*$/],
      ['permessi OIDC `id-token: write`', /^\s{2}id-token:\s*write\s*$/],
      ['concorrenza sul gruppo `pages`', /^\s{2}group:\s*'pages'\s*$/],
      ['annullamento dei run in corso', /^\s{2}cancel-in-progress:\s*true\s*$/],
      ['ambiente `github-pages`', /^\s{6}name:\s*github-pages\s*$/],
      ['URL pubblicato da `steps.deployment.outputs.page_url`', /url:\s*\$\{\{\s*steps\.deployment\.outputs\.page_url\s*\}\}/],
      ['runner `ubuntu-latest`', /^\s{4}runs-on:\s*ubuntu-latest\s*$/],
      ['checkout del repository', /uses:\s*actions\/checkout@v4\s*$/],
      ['setup di Node', /uses:\s*actions\/setup-node@v4\s*$/],
      ['Node 20', /^\s{10}node-version:\s*20\s*$/],
      ['cache npm', /^\s{10}cache:\s*'npm'\s*$/],
      ['installazione riproducibile `npm ci`', /^\s{8}run:\s*npm ci\s*$/],
      ['build di produzione `npm run build`', /^\s{8}run:\s*npm run build\s*$/],
      ['setup Pages `configure-pages@v5`', /uses:\s*actions\/configure-pages@v5\s*$/],
      ['upload artefatto `upload-pages-artifact@v3`', /uses:\s*actions\/upload-pages-artifact@v3\s*$/],
      ['artefatto `./dist`', /^\s{10}path:\s*'\.\/dist'\s*$/],
      ['deploy `deploy-pages@v4`', /uses:\s*actions\/deploy-pages@v4\s*$/],
      ['id del passo di deploy `deployment`', /^\s{8}id:\s*deployment\s*$/],
    ];
    const missing = workflowChecks.filter(([, re]) => !has(re)).map(([label]) => label);
    check(
      `workflow completo (${workflowChecks.length - missing.length}/${workflowChecks.length} requisiti)`,
      missing.length === 0,
      missing.length ? `mancanti: ${missing.join(', ')}` : 'ufficiale Vite → Pages'
    );

    // Ordine dei passi: il deploy non può precedere la build.
    const order = [
      'actions/checkout@v4',
      'actions/setup-node@v4',
      'run: npm ci',
      'run: npm run build',
      'actions/configure-pages@v5',
      'actions/upload-pages-artifact@v3',
      'actions/deploy-pages@v4',
    ];
    const positions = order.map((needle) => workflow.indexOf(needle));
    check(
      'ordine dei passi corretto (checkout → setup → ci → build → pages → upload → deploy)',
      positions.every((p) => p >= 0) && positions.every((p, i) => i === 0 || p > positions[i - 1]),
      positions.join(' < ')
    );
  }

  /* --- 3) Artefatto di build ------------------------------------------- */
  const indexPath = join(DIST_DIR, 'index.html');
  const indexHtml = readText(indexPath);
  check('artefatto di build `dist/index.html` presente', !!indexHtml, indexPath);
  if (!indexHtml) {
    console.log('\nEsegui prima `npm run build`.');
    return;
  }

  const refs = [...indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const externalRefs = refs.filter((r) => /^[a-z]+:|^\/\//i.test(r));
  const localRefs = refs.filter((r) => !externalRefs.includes(r));
  check(
    `tutti i ${localRefs.length} riferimenti locali di index.html sono prefissati con \`${EXPECTED_BASE}\``,
    localRefs.length >= 3 && localRefs.every((r) => r.startsWith(EXPECTED_BASE)),
    localRefs.join(' | ')
  );

  const missingFiles = localRefs
    .map((r) => join(DIST_DIR, r.slice(EXPECTED_BASE.length)))
    .filter((p) => !existsSync(p));
  check(
    'ogni asset referenziato esiste dentro `dist/` (nessun 404 all\'avvio)',
    missingFiles.length === 0,
    missingFiles.length ? missingFiles.join(' | ') : `${localRefs.length} file verificati`
  );

  const bundleFiles = existsSync(join(DIST_DIR, 'assets'))
    ? readdirSync(join(DIST_DIR, 'assets')).filter((f) => /\.(js|css|mjs)$/.test(f))
    : [];
  const unprefixed = [];
  for (const file of bundleFiles) {
    const content = readFileSync(join(DIST_DIR, 'assets', file), 'utf8');
    for (const m of content.matchAll(/["'(](\/(?!truck-planner\/)[A-Za-z0-9._-]+\/)/g)) {
      unprefixed.push(`${file}: ${m[1]}`);
    }
  }
  check(
    `nessun percorso assoluto non prefissato nel bundle (${bundleFiles.length} file JS/CSS)`,
    bundleFiles.length > 0 && unprefixed.length === 0,
    unprefixed.length ? unprefixed.slice(0, 3).join(', ') : 'nessun `/assets/…` cablato'
  );

  /* --- 4) Server che imita GitHub Pages + controllo alla radice --------- */
  const requests = [];
  const server = await servePages(DIST_DIR, EXPECTED_BASE, requests);
  const pagesUrl = `http://127.0.0.1:${PAGES_PORT}${EXPECTED_BASE}`;

  // Controprova: alla radice del dominio il percorso non prefissato non esiste.
  const rootControl = await fetch(`http://127.0.0.1:${PAGES_PORT}/assets/${bundleFiles.find((f) => f.endsWith('.js')) ?? 'index.js'}`);
  check(
    'controprova: senza prefisso la stessa risorsa risponde 404 (la `base` è ciò che salva la pagina)',
    rootControl.status === 404,
    `HTTP ${rootControl.status} su /assets/…`
  );
  requests.length = 0; // da qui in poi si osserva solo il traffico della pagina reale

  const profileDir = mkdtempSync(join(tmpdir(), 'pages-profile-'));
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

    await cdp.send('Page.navigate', { url: pagesUrl });
    await waitFor(
      async () => cdp.eval(`return document.getElementById('btn-save-project') ? 1 : 0;`),
      10000,
      'mount dell\'applicazione'
    );

    /* --- 5) La pagina pubblicata funziona davvero --------------------- */
    const boot = await cdp.eval(`
      const deck = document.querySelector('.control-deck');
      return {
        url: location.pathname,
        title: document.title,
        hasDeck: !!deck,
        gutter: deck ? getComputedStyle(deck).scrollbarGutter : null,
        hasCanvas: !!document.querySelector('.canvas-hud'),
        catalogRows: document.querySelectorAll('[id^="pallet-row-"]').length,
        hasPlateInput: !!document.getElementById('vehicle-plate-input'),
        items: document.querySelectorAll('[data-canvas-item]').length,
      };
    `);

    check(
      `l'applicazione monta sull'URL di produzione \`${EXPECTED_BASE}\``,
      boot.hasDeck && boot.hasCanvas && boot.hasPlateInput && boot.catalogRows === 5,
      `deck=${boot.hasDeck} canvas=${boot.hasCanvas} righe catalogo=${boot.catalogRows}`
    );
    check(
      'il foglio di stile è caricato dalla sottocartella (CSS applicato: `scrollbar-gutter: stable`)',
      boot.gutter === 'stable',
      `computed=${boot.gutter}`
    );
    check(
      'nessun errore in console dopo il caricamento',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ') || 'console pulita'
    );

    const badRequests = requests.filter((r) => r.status !== 200);
    check(
      `tutte le ${requests.length} richieste della pagina sono sotto \`${EXPECTED_BASE}\` e rispondono 200`,
      requests.length >= 3 &&
        badRequests.length === 0 &&
        requests.every((r) => r.pathname.startsWith(EXPECTED_BASE)),
      badRequests.length
        ? badRequests.map((r) => `${r.pathname} → ${r.status}`).join(' | ')
        : requests.map((r) => r.pathname).join(' | ')
    );
    check(
      'favicon servita dal prefisso (`/truck-planner/favicon.svg`)',
      requests.some((r) => r.pathname === `${EXPECTED_BASE}favicon.svg` && r.status === 200),
      requests.filter((r) => r.pathname.endsWith('.svg')).map((r) => r.pathname).join(' | ') || 'nessuna'
    );

    // Interazione reale: il bundle React eseguito dalla sottocartella risponde.
    await clickElement(cdp, 'quick-piatto-INDU');
    const after = await waitFor(
      async () => {
        const state = await cdp.eval(`
          const total = [...document.querySelectorAll('*')]
            .map((el) => el.textContent)
            .find((t) => /^\\d+ Colli Totali$/.test((t || '').trim()));
          return {
            items: document.querySelectorAll('[data-canvas-item]').length,
            total: total ? total.trim() : null,
          };
        `);
        return state.items > 0 ? state : null;
      },
      4000,
      'il collo caricato sul canvas'
    );
    check(
      'interazione end-to-end: `↔ Piatto` di PLT INDU carica 1 collo sul canvas',
      after.items === 1 && after.total === '1 Colli Totali',
      `colli=${after.items} riepilogo=${after.total}`
    );
    check(
      'nessun errore in console dopo l\'interazione',
      cdp.consoleErrors.length === 0,
      cdp.consoleErrors.join(' | ') || 'console pulita'
    );

    // Ultimo controllo: i byte che GitHub Pages pubblicherà sono esattamente
    // l'artefatto di build, serviti come HTML.
    const servedResponse = await fetch(pagesUrl);
    const servedHtml = await servedResponse.text();
    check(
      'l\'HTML pubblicato coincide con `dist/index.html` ed è servito come `text/html`',
      servedResponse.status === 200 &&
        (servedResponse.headers.get('content-type') ?? '').startsWith('text/html') &&
        servedHtml === indexHtml,
      `HTTP ${servedResponse.status} · ${servedResponse.headers.get('content-type')}`
    );

    console.log(
      `\nRepository atteso: https://angelocasablancalabs.github.io${EXPECTED_BASE} (${EXPECTED_REPO})`
    );
  } finally {
    if (ws) ws.close();
    // `Browser.close` non va atteso: la risposta non arriva mai, perché il
    // browser termina prima di poterla scrivere (il watchdog scatterebbe).
    if (cdp) cdp.send('Browser.close').catch(() => {});
    await sleep(300);
    chrome.kill();
    server.close();
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
  clearTimeout(watchdog);
  console.log(`\n${passed}/${passed + failed} controlli superati in ${elapsed} s`);
  if (failed > 0) {
    console.log(`${failed} controlli FALLITI`);
    process.exit(1);
  }
  process.exit(0);
};

const watchdog = setTimeout(() => {
  console.error(`\nWatchdog: verifica interrotta dopo ${WATCHDOG_MS} ms`);
  process.exit(1);
}, WATCHDOG_MS);

main().catch((error) => {
  clearTimeout(watchdog);
  console.error(`\nVerifica fallita: ${error?.message ?? error}`);
  process.exit(1);
});
