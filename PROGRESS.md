# PROGRESS.MD — TRUCK PLANNER 2D

## 1. PANORAMICA DEL PROGETTO
- **Applicazione:** `truck-planner` (Piattaforma vettoriale interattiva per la pianificazione e stiva merci 2D su semirimorchi e motrici refrigerate).
- **Stack Tecnologico:** Vite + React 19 + TypeScript (regola rigida `import type`) + Tailwind CSS v4 + Lucide React + Motore grafico SVG Vettoriale Nativo.
- **Sistema di Riferimento:** Coordinate cartesiane continue espresse in centimetri reali $(W, L)$.
  - $Y = 0$ (Alto): **▲ CABINA ▲**
  - $Y = \text{vehicle.length}$ (Basso): **PORTE POSTERIORI** (linea tratteggiata)
  - $X = 0$ (Sinistra): Parete sinistra
  - $X = \text{vehicle.width}$ (Destra): Parete destra

---

## 2. STATO ATTUALE & FUNZIONALITÀ VERIFICATE

### A. Canvas Vettoriale CAD a Schermo Intero
- **Viewport senza limiti:** L'elemento SVG occupa il 100% dell'area di lavoro sinistra (`w-full h-full`), eliminando qualsiasi ritaglio artificiale (clipping) sui lati.
- **Motore Zoom & Pan Fluido (mappatura rotellina stile CAD):**
  - **Rotellina pura:** Pan verticale (`pan.y -= deltaY`) per scorrere naturalmente il semirimorchio dall'alto (**Cabina**) verso il basso (**Porte posteriori**).
  - **`Shift` + Rotellina:** Pan orizzontale (`pan.x -= deltaX/deltaY`).
  - **`Ctrl`/`Cmd` + Rotellina:** Zoom fluido ancorato al puntatore del mouse (listener nativo non passivo `{ passive: false }`, range 60%–400%).
  - `e.preventDefault()` sempre attivo: nessuno scroll o zoom nativo della pagina del browser.
  - Pan libero (spostamento visuale) con drag sullo sfondo grigio (`cursor-grab`).
  - HUD flottante in basso a sinistra con pulsanti `−`, `+`, percentuale normalizzata e tasto **Reset/Fit to Screen** che ricalcola la vista d'insieme su qualsiasi risoluzione.

### B. Configurazione Mezzo Adattiva
- **Preset Ufficiali:**
  - `bilico_cc`: **Bilico frigo Fiori** ($2{,}50 \times 13{,}28\text{ m}$)
  - `bilico_std`: **Bilico frigo Standard** ($2{,}45 \times 13{,}28\text{ m}$)
  - `motrice_3a`: **Motrice 3 Assi** ($2{,}50 \times 7{,}60\text{ m}$)
  - `custom`: **Personalizzato...**
- **Logica Adattiva:** Quando è selezionato un preset standard la barra è pulita; solo se si seleziona `Personalizzato...` compaiono due campi numerici compatti (Larghezza e Lunghezza in cm) che aggiornano il pianale e la vista in tempo reale.

### C. Catalogo Colli a Righe Dense CAD (36px)
- **Compattazione al 50%:** I 5 formati standard (`PLT INDU`, `PLT EUR`, `PLT ½ EUR`, `CC`, `EC`) sono disposti in singole righe orizzontali compatte alte 36px con indicatore colore e nome.
- **Pulsanti Sdoppiati a 1-Click con "Spinta Gentile":**
  - A sinistra (prima scelta naturale): **`[ ↔ Piatto ]`** (lato largo verso cabina/porte, $W = \max, L = \min$).
  - A destra (seconda scelta): **`[ ↕ Punta ]`** (lato stretto verso cabina/porte, $W = \min, L = \max$).
- **Collo Sfuso Uniformato:** Box "Sfuso (Metri Lineari)" integrato nello stile neutro con input metri a tutta larghezza e pulsante de-enfatizzato coerente.

### D. Motore di Posizionamento & Fisica
- **Spawn Intelligente First-Fit:** Al click di aggiunta, il collo non va a $(0,0)$ ma cerca automaticamente il primo slot libero partendo da Cabina verso Porte, riempiendo da sinistra a destra e aprendo nuove file in modo compatto e ordinato.
- **Rotazione su Baricentro:** Premendo la **Barra Spaziatrice** (o tasto Ruota), il collo ruota facendo perno sul proprio centro geometrico $(cx, cy)$ e applica un auto-snap magnetico di assestamento a 10 cm per incollarsi alla parete o al bancale vicino.
- **Snap Magnetico:** Soglia a 5 cm per aggancio a filo pareti e colli adiacenti.
- **Gestione Sforamento Posteriore (Overhang) & Allarme Sagoma:**
  - Se il camion è saturo in lunghezza, il nuovo collo si accoda visivamente all'ultima fila sbordando oltre la linea tratteggiata delle porte (senza forzature all'indietro o false sovrapposizioni).
  - **Allarme Visivo:** Bordo rosso d'allarme (`#EF4444`) se il collo supera i confini del veicolo ($Y + L > \text{vehicle.length}$) o in caso di collisione (`isRectColliding`).
  - **Dragging Permissivo in Coda:** È possibile trascinare manualmente i colli fino a $150\text{ cm}$ fuori dalle porte posteriori per condurre prove di stiva, mantenendo rigido il blocco laterale sulle pareti.

### E. Sicurezza & Azioni Distruttive
- **Pulsante "Svuota":** Posizionato stabilmente nell'header di "Aggiungi Colli". Disabilitato e opaco a pianale vuoto; attivo e colorato in **rosso mattone istituzionale** (`text-red-800` / `#991B1B`) a pianale popolato, protetto da popup di conferma `window.confirm()`.
- **Pulsante "Cancella":** Colorato con la stessa tonalità rosso mattone istituzionale coerente.

### F. Formato Libero / Fuori Sagoma (Sprint A)
- **Nuova sezione compatta** in `ControlDeck.tsx`, sotto il blocco "Sfuso": titolo `Formato Libero / Fuori Sagoma` con legenda colore neutra (`#CBD5E1` / bordo `#475569`).
- **Campi input:**
  - **Nome / Cliente:** testo libero (default `Collo Custom`, segnaposto `Es. Macchinario`).
  - **Larghezza (W cm):** numerico, default `200`, range `10–300`.
  - **Lunghezza (L cm):** numerico, default `150`, range `10–1500`.
- **Pulsante `+ Aggiungi Fuori Sagoma`** (stile chiaro coerente `bg-slate-50 border-slate-200 hover:bg-blue-50 text-slate-700`).
- **Spawn:** il collo nasce col colore neutro di base e viene piazzato dal motore `findSmartSpawnPosition` (Cabina → Porte, first-fit), col nome/cliente digitato.
- **Voce di catalogo dedicata** `CUSTOM` in `constants.ts` (`CUSTOM_PALLET`), esclusa dalle righe dense del catalogo standard per non appesantire la lista CAD.

### G. Personalizzazione Collo Selezionato (Sprint A)
- **Modifica Nome / Cliente:** input di testo nel pannello `selectedItem`: l'aggiornamento è istantaneo e si riflette sia sul testo dentro il rettangolo nel canvas sia sul riepilogo stiva.
- **Palette Colori Rapida:** riga di 7 pastiglie tonde (fill pastello + bordo alto contrasto, pastiglia attiva evidenziata con ring blu):
  - Grigio `#E2E8F0` / `#475569` — Giallo `#FEF08A` / `#CA8A04` — Arancio `#FED7AA` / `#EA580C` — Verde `#DCFCE7` / `#16A34A` — Azzurro `#BAE6FD` / `#0284C7` — Lilla `#F3E8FF` / `#9333EA` — Rosa/Corallo `#FFE4E6` / `#E11D48`.
  - *(Logica storica, superata dalla **matrice 21 colori** della sezione O: le pastiglie applicavano anche un `borderColor` dedicato, ora il bordo è sempre `#334155`.)*
- **Callback di stato:** `handleUpdateItemProperties(id, updates: Partial<PlacedItem>)` in `App.tsx`, patch immutabile passata a `ControlDeck` (aggiorna `color` e `borderColor` sul collo selezionato).
  - *(Dalla sezione O la patch inviata dal selettore colori contiene il solo `color`.)*

### H. Selezione Multipla, Rettangolo Lasso & Azioni Batch (Sprint B)
- **Stato globale evoluto:** `selectedItemIds: string[]` (default `[]`) al posto del singolo `selectedItemId`, con `handleSelectItems(ids)`.
- **Selezione con Click:**
  - Click semplice su un collo → selezione singola `[item.id]`.
  - `Cmd` (macOS) / `Ctrl` (Windows) + Click → **toggle** dell'ID nella lista (aggiunge o rimuove).
  - Click su sfondo grigio → azzera la selezione (`[]`); un pan o un lasso appena conclusi NON azzerano la selezione.
- **Rettangolo Lasso (`Shift` + Drag sullo sfondo):**
  - Rettangolo tratteggiato in tempo reale: fill azzurro `#3B82F6` con opacity `0.15`, bordo blu `#2563EB` tratteggiato (`6 4`), disegnato in px schermo sopra il mondo trasformato.
  - Al rilascio (`pointerUp`) si calcola l'intersezione AABB in cm reali tra il lasso e ogni collo: i colli intersecati vengono **aggiunti** alla selezione (senza duplicati).
- **Drag di Gruppo:** afferrando un collo già selezionato (gruppo > 1) si trascina l'intero gruppo con lo stesso delta $(\Delta X, \Delta Y)$, preservando le posizioni relative. Il collo afferrato guida lo snap magnetico su pareti/colli esterni al gruppo; il delta è clampato perché **tutti** i membri restino nella sagoma consentita (pareti rigide + buffer posteriore `REAR_OVERHANG_LIMIT`). Un solo `setState` per frame via `handleUpdateItemsPos(updates: ItemPositionUpdate[])`.
- **Feedback visivo:** bordo blu spesso sui colli selezionati + involucro tratteggiato attorno al gruppo quando la selezione è multipla.
- **Pannello Batch in sidebar:**
  - `selectedItems.length === 1` → interfaccia singola invariata (nome, quote, rotazione, palette, cancellazione).
  - `selectedItems.length > 1` → badge `X Colli`, campo Nome/Cliente cumulativo (placeholder `Assegna nome a tutti...`, valore vuoto se i nomi divergono), **palette batch** che colora istantaneamente tutti i colli, `Cancella (X)` in rosso mattone istituzionale e rotazione di gruppo.
- **Rotazione di gruppo:** la Barra Spaziatrice ruota tutti i colli selezionati, ciascuno sul proprio baricentro con riallineamento magnetico.

### I. Modulo "Stiva Sequenza" Multi-Tappa (Sprint C)
- **Selettore a schede in cima alla sidebar** (`ControlDeck.tsx`), sotto l'intestazione "TRUCK PLANNER":
  - `[ 📦 Carico Diretto ]` → catalogo manuale storico (invariato).
  - `[ ⚡ Stiva Sequenza ]` → generatore progressivo a lotti/tappe.
  - Scheda attiva `bg-white shadow-sm font-bold`, inattiva `text-slate-500 hover:text-slate-700`.
- **Scheda "Stiva Sequenza":** mantiene in alto la **Configurazione Mezzo** e in basso il **Riepilogo Stiva**; al centro il generatore.
- **Righe Lotto / Tappa** (card compatta su due linee):
  - Indice tappa, **Q.tà** (numero, min `1`, max `99`, default `1`).
  - **Formato**: `PLT EUR`, `PLT INDU`, `PLT ½ EUR`, `CC`, `EC` (default `PLT EUR`).
  - **Toggle Orientamento** `↔ Piatto` / `↕ Punta` (default Piatto).
  - **Cliente**: input testuale con placeholder `Es. COOP`.
  - **Pallino colore** ~~cliccabile: cicla i 7 colori pastello~~ → **matrice colori 7 × 3** cliccabile (sezione O), assegnata **a rotazione automatica** (tonalità media) ad ogni nuova riga (tappe distinguibili a vista).
  - **Cestino** (`Trash2` `w-3.5 h-3.5`) per rimuovere la riga.
- **`+ Aggiungi Riga Spedizione`** in coda alla lista.
- **Applicazione selezionabile:** `Sostituisci` (default, azzera il pianale) / `Accoda` (mantiene il carico e prosegue la sequenza).
- **Azione primaria `⚡ Esegui Stiva Sequenziale`** (`bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 rounded shadow`), disabilitata a lista vuota.
- **Motore `handleExecuteSequence(batches, mode)`** in `App.tsx`:
  - Ordine di stiva = ordine delle righe (tappa 1 → N), riempimento progressivo **Cabina → Porte posteriori**.
  - Per ogni lotto, per $i = 1 \dots \text{quantity}$: lookup in `PALLET_CATALOG`, calcolo di $W/L$ secondo l'orientamento (Piatto: $W=\max(D_1,D_2)$, $L=\min$; Punta: $W=\min$, $L=\max$), `findSmartSpawnPosition(W, L, vehicle, currentPlacedItems)`, creazione del `PlacedItem` con `name: batch.clientName || pallet.name` e colore di tappa.
  - Il collo appena creato entra subito in `currentPlacedItems`, quindi il collo successivo calcola lo spawn sul pianale aggiornato (**un solo `setItems` atomico** a fine sequenza).
- **Verifica headless (Chrome):** batch `3 × EUR [COOP]` + `2 × INDU [CONAD]` → atterraggio in ordine `(0,0) (120,0) (0,80) (120,80) (0,160)`, formati/quote e nomi cliente corretti; modalità `Accoda` → 10 colli totali; nessun errore runtime in console.

### J. Toggle Densità Etichette (Sprint C)
- **Nuovo tipo `LabelDensity`** (`src/types.ts`): `'all' | 'client' | 'dimensions' | 'minimal'`; stato `labelDensity` in `App.tsx` (default `'all'`) passato a `TruckCanvas`.
- **Selettore a pastiglia nell'HUD flottante in basso a sinistra** (`TruckCanvas.tsx`), sopra i comandi Zoom/Pan: `[ Tutto | Cliente | Misure | Minimal ]`, stile sobrio CAD `text-[10px]`, attivo `bg-slate-800 text-white font-bold`.
- **Rendering dei colli:**
  - `all` → nome + quote $W \times L$ (comportamento storico).
  - `client` → **solo nome**, centrato in verticale, `text-[12px] font-bold`.
  - `dimensions` → **solo quote** `${item.width}×${item.length}` centrate.
  - `minimal` → **nessun `<text>` interno**, solo il blocco geometrico colorato.

### K. Condivisione & Output — "Copia Immagine" PNG & Scheda A4 (Sprint D)
- **Modulo `src/utils/export.ts`** (fortemente tipizzato, `import type` per ogni interfaccia):
  - `copyCanvasToClipboard(vehicle, items, labelDensity): Promise<boolean>` — genera lo snapshot PNG pulito del pianale e lo copia negli appunti di sistema; restituisce `true` se copiato, `false` se è scattato il fallback. Non lancia mai eccezioni.
  - **Ingombro dinamico:** `maxY = Math.max(vehicle.length, ...items.map(i => i.y + i.length)) + 50` → anche i colli che sforano dalle porte posteriori restano nell'immagine, mai tagliati.
  - **SVG autonomo e pulito** (`buildPianoSvg`): sfondo bianco, piano di carico, tacche metriche ogni metro con quota a sinistra, tutti i colli con colore/bordo/testo secondo `labelDensity`, sponde laterali, parete Cabina, linea tratteggiata delle porte e didascalie. Nessun contorno blu di selezione, nessun lasso, nessun elemento di HUD.
  - **Rasterizzazione 2x:** l'SVG è disegnato su un `<canvas>` offscreen a larghezza base 1200 px × 2 (2400 px reali) per la massima nitidezza su Retina/zoom; il fattore si riduce automaticamente solo se l'area supererebbe i limiti di canvas del browser.
  - **Appunti + fallback:** `await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])`; a qualsiasi rifiuto (permessi limitati, contesto non sicuro, API assente) scarica automaticamente `piano-di-carico.png`.

### L. Scheda di Carico A4 / PDF (Sprint D)
- **`src/components/PrintReport.tsx`:** componente montato accanto all'app e invisibile a schermo (`#print-report`):
  - **Header:** titolo `SCHEDA DI CARICO / PIANO DI STIVA`, data e ora di generazione (aggiornate all'evento `beforeprint`), nome configurazione mezzo, lunghezza e larghezza utile, totale colli.
  - **Corpo:** disegno vettoriale del camion (quote, tacche metriche, colli) centrato e ridimensionato per occupare l'altezza utile del foglio A4 (`preserveAspectRatio="xMidYMid meet"`).
  - **Tabella riepilogo in calce:** Cliente/Tappa, Formato (nome catalogo + quote $W \times L$), Orientamento (`Piatto ↔` / `Punta ↕`, dedotto dalla geometria reale del collo), Q.tà; colli omogenei accorpati e riga `TOTALE COLLI`.
- **Regole `@media print` in `src/index.css`:**
  - `@page { size: A4 portrait; margin: 10mm }`.
  - `#print-report` è `display: none` a schermo e in stampa diventa una colonna flex alta **277 mm** (A4 297 − 2×10 mm di margine), con `print-color-adjust: exact` per i colori pastello dei colli.
  - `#screen-app` (ControlDeck, HUD Zoom/Pan e selettore densità) è nascosto con `display: none !important`, così su carta resta **solo** la scheda di carico.
- **Barra comandi rapida in `ControlDeck.tsx`** (sotto il titolo TRUCK PLANNER):
  - **`Copia Immagine`** (`id="btn-copy-image"`, icona `Copy`) → invoca `copyCanvasToClipboard`; al successo diventa `Copiato!` con icona `Check` e testo verde per 2,5 s. Se scatta il fallback mostra `PNG salvato` in ambra con icona `Download` (feedback onesto: nessuna copia reale negli appunti).
  - **`Stampa / PDF`** (`id="btn-print-report"`, icona `Printer`) → invoca `window.print()`.
- **Verifica headless (Chrome DevTools Protocol, zero dipendenze aggiunte):** pulsanti presenti; click su `Stampa / PDF` → `window.print()` invocato; con media `print` emulata `#screen-app`/`.control-deck`/`.canvas-hud` sono `display:none` e `#print-report` è visibile a 277 mm con titolo, dati mezzo e tabella popolata; `Page.printToPDF` genera la scheda (≈110 kB); `Copia Immagine` scrive negli appunti (`Copiato!`) e, con appunti negati, scarica `piano-di-carico.png` valido a 2400×12732 px (sforamento posteriore incluso). Nessun errore in console.

### M. Super Fine-Tuning — Accordion, Pan Clamp, Bordi Antracite, Quota 13,20 m & Contatore LDM (Sprint E)
1. **Preset Standard aggiornato** (`constants.ts`): `bilico_std` → **Bilico frigo Standard (2,45 × 13,28 m)**, $W = 245\text{ cm}$, $L = 1328\text{ cm}$.
2. **Bordi dei colli uniformi (grigio antracite):** tutti i colli di `PALLET_CATALOG` usano l'unico `borderColor` `#334155` (costante `ITEM_BORDER_COLOR`). Il rosso `#EF4444` (`ALERT_COLOR`) è **riservato unicamente** alle condizioni di allarme (`hasCollision || isOutOfBounds`) sia in `TruckCanvas.tsx` sia in `export.ts`: nessun bordo di catalogo può più essere confuso con un allarme.
3. **Box ad accordion nella sidebar** (`ControlDeck.tsx`): i box **Sfuso** e **Formato Libero / Fuori Sagoma** sono collassabili con stati locali `isBulkOpen` / `isCustomOpen` (default `false`). Da chiusi mostrano una sola riga compatta cliccabile con freccina (`ChevronRight`), pastiglia colore, titolo e indicatore discreto (`2.0 m` / `200×150 cm`); al click la freccina diventa `ChevronDown` e compaiono i campi. La sidebar risale di oltre 150 px nei casi d'uso più frequenti.
4. **Blocco corsa rotellina (Pan Y clamp)** (`TruckCanvas.tsx`): il pan verticale è clampato sia sull'evento `wheel` sia sul drag dello sfondo tramite `clampPanY()` — `minPanY = -(vehicle.length × zoom) + 120` (le porte posteriori non salgono oltre la parte alta dello schermo) e `maxPanY = containerHeight - 120` (la cabina non scende oltre il fondo). Una porzione significativa del pianale resta sempre nel viewport. *(Logica storica, superata dal “Clamp Rigido Intelligente” della sezione N.)*
5. **Testo nei colli: clip-path & a capo** (`TruckCanvas.tsx` + `utils/export.ts`): ogni collo ha un `<clipPath id="clip-<id>">` rettangolare applicato al gruppo del testo, che quindi non può fisicamente traboccare sui colli adiacenti. Se il nome contiene uno spazio ed è lungo, o se il collo è stretto (≤ 70 cm, es. CC 56,5 cm), il nome va a capo su due `<tspan>` centrate (`x={item.width/2}`, `dy="-6"` / `dy="13"`) con corpo ridotto a `text-[10px]`; la stessa logica vive in `buildPianoSvg` per l'export PNG, con gli helper condivisi in `utils/labels.ts`.
6. **Quota 13,20 m & contatore dinamico LDM** (`TruckCanvas.tsx` + `utils/export.ts`):
   - Se `vehicle.length >= 1320`, una linea netta a $Y = 1320$ attraversa il pianale (`#94A3B8`, `strokeDasharray="6 3"`, `strokeWidth 1.5`) con la dicitura `13.20m` in `text-[10px] font-bold fill-slate-600` nel righello di sinistra.
   - `maxOccupiedY = items.reduce((max, i) => Math.max(max, i.y + i.length), 0)`: se $> 0$ viene tracciata una sottile linea guida tratteggiata `#2563EB` a $Y = maxOccupiedY$ e, nel righello di sinistra, un badge scuro ad alto contrasto (rettangolo `#1E293B` con testo bianco in grassetto `▶ X.XX m`, es. `▶ 3.60 m`). Entrambi presenti anche nello snapshot PNG esportato, con gutter sinistro del viewBox allargato automaticamente per ospitarli.

### N. Clamp Rigido Intelligente (Zero Spazio Vuoto) & Pulizia Didascalie (Sprint E-bis)
1. **`clampPanY()` riscritta in modalità “intelligente”** (`TruckCanvas.tsx`): elimina definitivamente lo spazio vuoto grigio sopra la Cabina o sotto le Porte posteriori.
   - **Costanti:** `PAN_TOP_MARGIN_PX = 40`, `PAN_BOTTOM_MARGIN_PX = 50`, `PAN_LABEL_MARGIN_CM = 80`; ingombro verticale di riferimento `truckTotalHeightPx = (vehicle.length + 80) × zoom`.
   - **Caso A — il camion entra interamente nello schermo** (`truckTotalHeightPx <= containerH`): `return (containerH - vehicle.length × zoom) / 2` → il pianale resta **centrato verticalmente** e non può più scivolare via (né con la rotellina né col drag).
   - **Caso B — il camion è più lungo dello schermo** (zoom elevato): `maxPanY = 40` (la **Cabina** si arresta a ridosso del bordo alto) e `minPanY = containerH - 50 - vehicle.length × zoom` (le **Porte** si arrestano a ridosso del bordo basso), con `return Math.max(minPanY, Math.min(maxPanY, panY))`.
   - **Punti di applicazione:** rotellina pura (pan Y), `Shift`+rotellina resta sul pan X, drag di pan dello sfondo con il mouse e — per conservare l'invariante “zero vuoto” — anche dopo ogni variazione di zoom (`Ctrl`/`Cmd`+rotellina e pulsanti `+`/`−` dell'HUD), dove il pan Y viene riallineato dal clamp subito dopo lo zoom ancorato al cursore/centro.
2. **Pulizia delle didascalie del semirimorchio** (`TruckCanvas.tsx`, `utils/export.ts` → `buildPianoSvg`, `components/PrintReport.tsx`): in alto resta `▲ CABINA ▲` (rimosse le parentesi quadre), in basso resta `PORTE POSTERIORI` (rimosse sia le parentesi quadre sia i triangoli `▼ … ▼`). Nessun'altra modifica grafica: quote metriche, linea tratteggiata delle porte e gutter del viewBox restano invariati.
3. **Verifica headless (Chrome DevTools Protocol, zero dipendenze aggiunte):** 17/17 controlli superati in ≈2,2 s (limite 10 s), `browser.close()` + `process.exit(0)`.
   - Zoom 100% (default `bilico_cc` 250 × 1328 cm, viewport 1060 × 813 px): HUD `100%`, `pan.y = 60.00` esattamente `(containerH − L×zoom)/2`, spazio grigio simmetrico sopra/sotto (60 px / 60 px); cinque rotelline verso l'alto **non** spostano il pianale (resta centrato).
   - Zoom 240% (7 click su `+`): HUD `240%`, `(L+80)×zoom = 1763 > 813` → Caso B attivo; rotellina **e** drag del mouse verso il basso bloccano `pan.y` a **40.00** (margine Cabina); rotellina **e** drag verso l'alto bloccano `pan.y` a **−900.20** = `containerH − 50 − L×zoom` (margine Porte).
   - Reset/Adatta a schermo → `pan.y = 60.00` (di nuovo centrato). Didascalie presenti e prive di parentesi su canvas, scheda A4 `#print-report` e SVG esportato da `buildPianoSvg`. Nessun errore in console.

### O. Finiture di Precisione — Bordi Antracite Rigidi, Cabina ad Alto Zoom, Doppio LDM Asimmetrico & Matrice 21 Tonalità (Sprint F)
1. **Bordo antracite RIGIDO su ogni collo** (`App.tsx`, `ControlDeck.tsx`, `constants.ts`, `types.ts`): qualunque sia la tinta assegnata a un collo — in inserimento da catalogo, in stiva sequenziale o con un cambio colore successivo — il `borderColor` resta **sempre** `ITEM_BORDER_COLOR` (`#334155`). Solo l'allarme (`hasCollision || isOutOfBounds` → `#EF4444`) e la selezione (`#2563EB`) hanno il diritto di sovrascriverlo.
   - `CUSTOM_PALLET.borderColor`: da `#475569` a `ITEM_BORDER_COLOR`.
   - `handleAddItem` e `handleExecuteSequence` (`App.tsx`) scrivono `borderColor: ITEM_BORDER_COLOR`, non più il bordo del catalogo o della tappa.
   - Rimosso il campo `borderColor` da `SequenceBatchItem` (`types.ts`): il contorno non è più una proprietà di riga, quindi non può più divergere per costruzione.
   - La matrice colori di `ControlDeck.tsx` invia **solo** `{ color: selectedHex }` a `handleUpdateItemProperties`: nessun `borderColor` viene più toccato dal selettore.
2. **Fix scroll Cabina ad alto zoom** (`TruckCanvas.tsx` → `clampPanY()`): nuova costante `CABINA_LABEL_OFFSET_CM = 32` (cm reali della fascia sopra la Cabina occupata dalla scritta `▲ CABINA ▲` e dalle quote). Nel **Caso B** il limite superiore diventa `maxPanY = PAN_TOP_MARGIN_PX + CABINA_LABEL_OFFSET_CM * zoom`, cioè l'altezza della scritta **scalata per lo zoom**: a 100%, 200% e 400%, scorrendo tutto in alto verso la Cabina, la didascalia e le quote restano interamente dentro il viewport (niente più scritta tagliata fuori) e non si crea spazio vuoto eccessivo. Il **Caso A** (mezzo interamente visibile) resta invariato e continua a centrare il pianale.
3. **Doppio indicatore LDM Asimmetrico (Lato SX e DX)** (`TruckCanvas.tsx` + `utils/export.ts`): l'ingombro in metri lineari non è più un unico massimo globale ma viene calcolato **per lato** rispetto all'asse di mezzeria `midX = vehicle.width / 2`:
   - `leftY = items.filter(i => i.x < midX).reduce((max, i) => Math.max(max, i.y + i.length), 0)`
   - `rightY = items.filter(i => (i.x + i.width) > midX).reduce((max, i) => Math.max(max, i.y + i.length), 0)`
   - **Carico simmetrico** (`Math.abs(leftY - rightY) < 1`, costante `LDM_SYMMETRY_TOLERANCE_CM`): singolo indicatore storico a sinistra, **linea guida continua** a $Y = \max(leftY, rightY)$ e badge scuro `#1E293B` (`▶ X.XX m`).
   - **Carico asimmetrico**: due indicatori tratteggiati (`strokeDasharray="6 4"`), ciascuno solo sulla propria metà pianale — sinistro da $X = 0$ a `midX` con badge nel righello sinistro (`▶ X.XX m`), destro da `midX` a `vehicle.width` con badge **all'esterno della parete destra**, a `LDM_BADGE_RIGHT_GAP = 14 cm` oltre `vehicle.width` (`◀ X.XX m`).
   - **Differenziazione cromatica:** il lato con l'ingombro **maggiore** usa lo sfondo scuro primario `#1E293B` (`LDM_BADGE_COLOR`), quello **minore** lo slate intermedio `#475569` (`LDM_BADGE_MUTED_COLOR`).
   - In `export.ts` la stessa logica vive in `computeLdmSides()` + `getPianoExtent()`: con carico asimmetrico il gutter **destro** del viewBox viene allargato automaticamente di `LDM_BADGE_RESERVED_RIGHT` (82 cm) per ospitare il badge esterno (`getPianoExtent().width` = 450 cm contro 374 cm del caso simmetrico), così nello snapshot PNG nessun badge viene tagliato.
4. **Matrice tonalità a 21 colori stile Excel** (`constants.ts` + `ControlDeck.tsx`): la vecchia lista piatta di 7 pastiglie è sostituita dalla matrice tipizzata **7 famiglie × 3 sfumature** (`ColorFamily`, `COLOR_FAMILIES`: Grigio, Azzurro, Verde, Giallo, Arancio, Corallo, Viola; tonalità `light` / `medium` / `dark`).
   - Nel pannello **Selezionato** (singolo collo o gruppo batch) e in ogni riga del generatore **Stiva Sequenza** viene renderizzata la matrice compatta **7 colonne × 3 righe** (riga 1 chiara, riga 2 media, riga 3 scura) tramite l'helper `renderColorMatrix(activeColor, onPick, ariaPrefix)`.
   - Ogni casella è un rettangolino `w-5 h-4.5` (20 × 18 px) `rounded-sm border border-slate-300 hover:scale-110 transition cursor-pointer`; la tinta attiva è evidenziata da `ring-2 ring-blue-600` (`aria-pressed`).
   - Il click applica **solo** il riempimento (`color`) al collo o ai colli selezionati, conservando il bordo `#334155`; nelle righe di Stiva Sequenza la tinta scelta colora i colli del lotto alla successiva esecuzione.
   - Le nuove righe di tappa ricevono automaticamente la tonalità *media* a rotazione (`COLOR_FAMILY_MEDIUM_SHADES`), così restano distinguibili a vista senza altre scelte.
5. **Verifica headless (Chrome DevTools Protocol, zero dipendenze aggiunte):** **19/19 controlli superati in 5,1 s** (watchdog 15 s), `Browser.close` + `process.exit(0)`, nessun errore in console.
   - Matrice: 21 caselle su 3 righe, celle 20 × 18 px, esattamente una tinta `aria-pressed` (la tonalità di catalogo del collo selezionato).
   - LDM su canvas: 1 collo EUR piatto → due badge `▶ 0.80 m` (`#1E293B`) e `◀ 0.00 m` (`#475569`) con linee tratteggiate `0→125` e `125→250`; 2 colli → indicatore singolo `▶ 0.80 m` con linea **continua** `0→250` (nessun `stroke-dasharray`); 3 colli → `▶ 1.60 m` scuro a SX e `◀ 0.80 m` slate a DX.
   - Bordi: click sulla tinta `Viola scuro` → il collo assume `fill #D8B4FE` mantenendo `stroke #334155` (e `#2563EB` mentre è selezionato); stesso esito per il collo generato da `Esegui Stiva Sequenziale` con tinta tappa `Corallo scuro` (fill `#FDA4AF`, stroke `#334155`).
   - Export PNG: `buildPianoSvg` replica badge, tratteggi e colori differenziati; viewBox 450 cm (asimmetrico) vs 374 cm (simmetrico), un solo badge e linea continua nel caso simmetrico.
   - Cabina: a 240% e 400%, dopo lo scroll completo verso l'alto, `pan.y` si arresta a `40 + 32 × zoom` (79,61 px a 240% e 106,02 px a 400%): `▲ CABINA ▲` (top 18 px / 3 px) e la quota larghezza restano **interamente** dentro un viewport di 805 px — con la vecchia formula (`maxPanY = 40`) la scritta sarebbe uscita di ~15 px a 240% e di ~53 px a 400%.

---

## 3. MAPPA ARCHITETTURALE DEI FILE
- `src/types.ts`: Tipi TypeScript (`VehicleConfig`, `PalletDefinition`, `PlacedItem`, `ItemPositionUpdate`, `AddItemOptions`, `LabelDensity`, `SequenceBatchItem` — senza `borderColor`: il contorno dei colli è l'invariante globale `ITEM_BORDER_COLOR`).
- `src/constants.ts`: Presets veicoli, catalogo colli (bordo unico antracite `#334155`), `CUSTOM_PALLET` (fuori sagoma), **matrice colori stile Excel** (`ColorFamily`, `COLOR_FAMILIES` 7 famiglie × 3 sfumature, `COLOR_FAMILY_MEDIUM_SHADES`), costanti di rendering condivise (`ALERT_COLOR`, `NOMINAL_QUOTA_CM`, `LDM_BADGE`, `LDM_BADGE_MUTED_COLOR`, `LDM_SYMMETRY_TOLERANCE_CM`, helper `ldmBadgeRightLeftX` / `ldmBadgeRightCenterX`, `LDM_BADGE_RESERVED_RIGHT`).
- `src/utils/snapping.ts`: Modulo matematico puro (`calculateSnapPosition`, `isRectColliding`, `isOutOfBounds`, `findSmartSpawnPosition`).
- `src/utils/labels.ts`: Geometria condivisa delle etichette dei colli (`shouldWrapLabel`, `splitLabelIntoTwoLines`, `clipIdForItem`, corpi font in cm), usata sia dal canvas a schermo sia dall'export PNG.
- `src/utils/export.ts`: Snapshot PNG pulito del pianale (`computeLdmSides`, `getPianoExtent`, `buildPianoSvg`, `rasterizeSnapshotToPng`, `copyCanvasToClipboard`) con doppio badge LDM asimmetrico, gutter destro dedicato e copia negli appunti con fallback download.
- `src/components/TruckCanvas.tsx`: Render SVG fullscreen, Zoom/Pan da rotellina con **clamp rigido intelligente** del pan Y (centratura automatica se il mezzo entra nello schermo, altrimenti blocco Cabina a `40 + 32 × zoom` per tenere dentro la didascalia e Porte a ridosso del bordo basso), didascalie `▲ CABINA ▲` e `PORTE POSTERIORI`, quota nominale 13,20 m e **doppio indicatore LDM per lato** (simmetrico continuo / asimmetrico tratteggiato SX + DX), etichette con `clipPath` e a capo automatico, selezione multipla (Cmd/Ctrl+Click, lasso Shift+Drag), drag di gruppo, eventi puntatore, segnalazione allarmi, HUD densità etichette (`LabelDensity`).
- `src/components/ControlDeck.tsx`: Plancia di comando con barra comandi rapida (`Copia Immagine` / `Stampa / PDF`), selettore a schede (`📦 Carico Diretto` / `⚡ Stiva Sequenza`), righe dense colli, selettore adattivo, box ad accordion Sfuso e Formato Libero / Fuori Sagoma, generatore sequenziale a lotti/tappe, pannello selezione singola e batch (nome, **matrice colori 7 × 3**, cancellazione di gruppo) e matrice colori in ogni riga di tappa.
- `src/components/PrintReport.tsx`: Scheda di carico A4 (`#print-report`) per stampa / salvataggio PDF.
- `src/index.css`: Tailwind v4 + regole `@page` / `@media print` della scheda di carico.
- `src/App.tsx`: Stato globale della stiva, della selezione multipla (`selectedItemIds`) e della densità etichette (`labelDensity`), scorciatoie tastiera (`Spazio`, `Canc`), rotazione su baricentro, motore di stiva sequenziale (`handleExecuteSequence`), `handleUpdateItemsPos` / `handleUpdateItemProperties`; ogni collo nasce con `borderColor: ITEM_BORDER_COLOR` (bordo antracite rigido).
- `AGENTS.md`: File di contesto e direttive tassative per gli agent AI.

---

## 4. PROSSIMI PASSI (NEXT SPRINT ROADMAP)
1. **Modulo Multi-Pianale:** gestione contemporanea di più mezzi/rimorchi nella stessa sessione di carico (finestre di stiva indipendenti, riepilogo unificato e trasferimento colli tra pianali).
