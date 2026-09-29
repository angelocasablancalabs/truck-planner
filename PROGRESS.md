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
- **Righe divenute fisarmoniche (sezione W):** la riga a riposo resta alta 36px con freccina `ChevronRight`/`ChevronDown`; il click sulla riga espande il **cassetto del caricamento a lotti** (quantità, cliente/lotto, matrice colori e pulsanti `+ N di Piatto` / `+ N di Punta`), mentre i due micro-pulsanti di destra continuano a inserire **1 singolo collo al volo** con un click.
- **Pulsanti Sdoppiati a 1-Click con "Spinta Gentile":**
  - A sinistra (prima scelta naturale): **`[ ↔ Piatto ]`** (lato largo verso cabina/porte, $W = \max, L = \min$).
  - A destra (seconda scelta): **`[ ↕ Punta ]`** (lato stretto verso cabina/porte, $W = \min, L = \max$).
  - Le quote reali (`120×100 cm`) restano nel tooltip del pulsante, per non alzare la riga oltre i 36px.
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
> **Superata dalla sezione W:** il selettore a schede e la tabella autonoma dei lotti sono stati rimossi; la stiva sequenziale a lotti vive ora dentro l'**Accordion Multifunzione** di ogni riga di catalogo. Il motore di stiva progressiva first-fit descritto qui è la base di `handleAddBatch`.
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

### P. Corsa Estesa Dinamica del Pan Y per Colli Fuori Sagoma (Sprint F-bis)
1. **Quota di fondo dinamica (`effectiveLength`)** (`TruckCanvas.tsx`): l'altezza di riferimento del disegno non è più la sola `vehicle.length`, ma l'ingombro reale più profondo del carico:
   - `const maxItemBottom = items.reduce((max, item) => Math.max(max, item.y + item.length), 0);`
   - `const effectiveLength = Math.max(vehicle.length, maxItemBottom);`
2. **`clampPanY()` aggiornata** (`TruckCanvas.tsx`): il terzo parametro, prima `vehicleLength`, è ora `effectiveLength` e viene usato **sia** per l'altezza del disegno del **Caso A** (`truckTotalHeightPx = (effectiveLength + PAN_LABEL_MARGIN_CM) * zoom`, con centratura calcolata sull'ingombro effettivo) **sia** per il limite inferiore del **Caso B** (`minPanY = containerH − PAN_BOTTOM_MARGIN_PX − effectiveLength * zoom`).
   - Tutti e quattro i punti di applicazione passano ora `effectiveLength`: zoom `Ctrl`/`Cmd`+rotellina, rotellina pura (pan Y), drag di pan dello sfondo, pulsanti `+`/`−` dell'HUD. L'effetto della rotellina dipende da `effectiveLength` (non più da `vehicle.length`).
   - **Pianale in sagoma** (`effectiveLength === vehicle.length`, cioè tutti i colli dentro le porte): comportamento **identico** al passato, arresto rigido a filo PORTE POSTERIORI.
   - **Colli in eccesso oltre le porte** (fino a `REAR_OVERHANG_LIMIT` = 150 cm): il limite inferiore si estende dinamicamente e l'utente può scorrere con la rotellina fino all'ultimo collo sbordato per selezionarlo, trascinarlo o eliminarlo con `Canc`.
3. **Riallineamento automatico alla rimozione** (`TruckCanvas.tsx`): blocco di *aggiustamento dello stato durante il render* con guardia `clampedLength !== effectiveLength` (stesso pattern del fit a schermo) che riapplica il clamp quando la quota di fondo cambia. Eliminato il collo eccedente, il limite torna **automaticamente** a filo PORTE POSTERIORI e la vista vi si riallinea subito, senza restare appesa nello spazio grigio in attesa di un altro movimento di rotellina.
4. **Verifica headless (Chrome DevTools Protocol, zero dipendenze aggiunte):** **16/16 controlli superati** (watchdog 10 s rispettato, `Browser.close()` + `process.exit(0)`), nessun errore in console. Mezzo `bilico_cc` 250 × 1328 cm, viewport canvas 785 px di altezza, `fitZoom = 0.5008`.
   - **Invariante storica:** a pianale vuoto `pan.y = 60.00` px = `(785 − 1328 × 0.5008)/2` (fit 100%): nessuna regressione sul clamp preesistente.
   - **Collo fuori sagoma** (Formato Libero 100 × 28 cm) trascinato a **Y = 1450 cm** (fondo 1478 = 1328 + 150): `effectiveLength` = **1478**. A 60% (Caso A) `pan.y = 170.47` = `(785 − 1478 × 0.3133)/2`, contro `193.00` della vecchia formula basata su `vehicle.length`: il pianale si centra sull'ingombro reale.
   - **Zoom 160% (Caso B)** con 14 rotelline verso le porte: `pan.y = −449.18` = `785 − 50 − 1478 × 0.8354` (vecchio limite rigido `−329.00`). Il collo sbordato è **interamente inquadrato** (top 712,57 px, fondo 735,00 px = `containerH − 50`), mentre con il vecchio limite sarebbe rimasto tagliato fuori di **70,2 px** sotto il bordo basso.
   - **Selezione e cancellazione:** click sul collo sbordato → selezionato (`stroke #2563EB`); `Canc` → pianale vuoto e limite tornato **a filo PORTE POSTERIORI** (`pan.y = −329.00` = `785 − 50 − 1328 × 0.8354`, linea porte a 735,00 px = `containerH − 50`).
   - `npx tsc -b --force`, `npm run lint`, `npm run build` → **exit 0** (la build richiede un accesso completo: la confinazione del sandbox blocca lo `spawn` interno di Vite/rolldown, non il codice).

### Q. First-Fit Continuo a File anche in Sforamento Posteriore (Sprint G)
1. **`findSmartSpawnPosition` a due passate** (`src/utils/snapping.ts`): il vincolo rigido `y + length <= vehicle.length` è stato rimosso dal ciclo dei candidati `(X, Y)`.
   - **1ª passata** — first-fit dentro la sagoma utile estesa alla zona di sforamento posteriore consentita: `x + width <= vehicle.width` (pareti laterali **RIGIDE**, mai superate) **e** `y + length <= vehicle.length + REAR_OVERHANG_LIMIT` (150 cm), con l'invariante di non collisione `!items.some(other => isRectColliding(x, y, width, length, other))`.
   - **2ª passata** — se nessun incastro rientra nel buffer, il first-fit **continua** con il solo blocco laterale: i colli in eccesso proseguono a file ordinate anche oltre i 150 cm, invece di essere impilati in un'unica colonna a `X = 0`.
   - **Ultima rete di sicurezza invariata** (collo più largo del pianale, nessun candidato utile): accodo a `(0, maxY)`, la "verità visiva del piazzale" senza clamp che genererebbero false collisioni interne.
2. **Effetto:** i colli in eccesso si dispongono **a coppie/triplette affiancate da sinistra a destra** alla stessa quota (`X = 0`, `X = 120`, …) e ognuno, avendo `Y + length > vehicle.length`, riceve automaticamente il contorno rosso d'allarme `#EF4444` di `isOutOfBounds`. Nessuna modifica a `TruckCanvas.tsx` / `App.tsx` è stata necessaria.
3. **Verifica headless (Chrome DevTools Protocol, zero dipendenze aggiunte):** **18/18 controlli superati in 0,99 s** (watchdog 10 s rispettato, `chrome.kill()` + `process.exit(0)`), nessun errore in console. Mezzo `bilico_cc` 250 × 1328 cm, 30 PLT INDU di Piatto (120 × 100 cm) aggiunti dal catalogo.
   - I primi 26 INDU riempiono la sagoma in 13 file × 2 colli (`Y = 0 … 1200`), tutti con `Y + L <= 1328` e nessun bordo d'allarme.
   - **27° INDU a `(0, 1300)`** e **28° a `(120, 1300)`** affiancato a destra (`[0..120]` vs `[120..240]`): nessuna sovrapposizione, dove prima entrambi cadevano su `X = 0`; entrambi con `stroke #EF4444`.
   - **First-fit continuo oltre il buffer:** **29° a `(0, 1400)`** e **30° a `(120, 1400)`**, ancora affiancati e con allarme rosso.
   - Nessun collo sborda dalle pareti laterali (`X + W <= 250`) e **0 coppie in collisione** su tutti i 30 colli.
   - `npx tsc -b --force`, `npm run lint`, `npm run build` → **exit 0**.

### R. Regola del Baricentro LDM, Quota 13,20 m & Dati LDM nella Scheda PDF (Sprint G-bis)
> **Superata dalla sezione S:** l'attribuzione di un collo a un lato del pianale non è più quella del baricentro, ma la **Regola della Corsia di Parete** (`WALL_ZONE_THRESHOLD = 50` cm). Il resto della sezione (quota 13,20 m, dati LDM nella scheda A4, badge differenziati) resta valido.
1. **Funzione pura condivisa `calculateLdmMetrics(vehicle, items)`** (`src/utils/snapping.ts`): un'unica fonte di verità dell'ingombro in metri lineari, usata da canvas a schermo, export PNG e scheda di stampa A4 (nessuna discrepanza possibile tra le tre rese). Restituisce `LdmMetrics { leftY, rightY, isAsymmetric, maxOccupiedY }`.
   - **Regola del Baricentro:** un collo non appartiene più a un lato in base a un generico sconfinamento della mezzeria (che lo faceva contare su entrambi i lati o su nessuno), ma in base a **dove ricade il proprio centro geometrico** `cx = x + width / 2`: `cx < midX` → lato sinistro, altrimenti lato destro.
   - **Colli a tutta larghezza** (`width >= vehicle.width × 0.6`, es. `SFUSO` da 250 cm) occupano inevitabilmente **entrambi** i lati.
   - `isAsymmetric = items.length > 0 && |leftY − rightY| >= 1` (tolleranza `LDM_SYMMETRY_TOLERANCE_CM`); `maxOccupiedY = max(leftY, rightY)`.
2. **Rendering LDM allineato alla funzione condivisa** (`TruckCanvas.tsx`, `utils/export.ts`, `PrintReport.tsx`):
   - **Simmetrico:** unico indicatore a sinistra a quota `maxOccupiedY`, **linea guida continua** e badge scuro `#1E293B`.
   - **Asimmetrico:** lato sinistro linea `0 → midX` con badge `▶ X.XX m`, lato destro linea `midX → vehicle.width` con badge `◀ X.XX m` (badge a `LDM_BADGE_RIGHT_GAP = 14 cm` oltre la parete destra). Il valore **maggiore** usa lo sfondo scuro `#1E293B`, il **minore** lo slate `#475569`.
   - **Chiusura a filo:** le linee tratteggiate (`LDM_GUIDE_DASH = '6 4'`) sono completate da un segmento pieno di `LDM_GUIDE_CLOSING_LENGTH = 10` cm a filo mezzeria/parete, così il tratteggio non lascia la guida "sospesa" prima del bordo della propria metà pianale.
   - **Densità `minimal`:** linee guida e badge LDM non vengono disegnati in nessuna delle tre rese (disegno pulito); il **dato** resta comunque nella tabella della scheda A4.
   - In `export.ts` il gutter destro del viewBox viene riservato solo al caso asimmetrico (`getPianoExtent(vehicle, items, labelDensity)`); con `minimal` non si riserva più nulla.
3. **Scheda di carico A4 arricchita** (`src/components/PrintReport.tsx`, che ora riceve la prop `labelDensity` da `App.tsx`):
   - **Linea nominale 13,20 m:** se `vehicle.length >= 1320`, linea orizzontale tratteggiata a `Y = 1320` (`stroke #94A3B8`, `strokeDasharray="6 3"`) e dicitura `13.20m` nel righello sinistro, **identiche** al canvas a schermo.
   - **Indicatori LDM a disegno:** nel disegno vettoriale della scheda vengono riportate le stesse linee guida e gli stessi badge calcolati da `calculateLdmMetrics` (salvo densità `minimal`).
   - **Dato ufficiale LDM nella tabella in calce:** nuova riga evidenziata (`id="print-ldm-row"`, sfondo `bg-blue-50`) con etichetta `INGOMBRO LINEARE (LDM)` e valore `X.XX m` (simmetrico) oppure `Lato SX X.XX m | Lato DX X.XX m` (asimmetrico).
4. **Verifica headless (Chrome DevTools Protocol, zero dipendenze aggiunte):** **26/26 controlli superati** (watchdog 15 s rispettato, `Browser.close` + `process.exit(0)`), nessun errore in console. Mezzo `bilico_cc` 250 × 1328 cm.
   - **Regola del Baricentro (collo a cavallo):** un PLT EUR 80 × 120 trascinato a `X = 80` (centro geometrico 120 cm < mezzeria 125 cm) conta **solo** sul lato sinistro → `SX 1.20 m | DX 0.00 m`, sia sul canvas sia nella riga LDM della scheda A4.
   - **Asimmetrico (12 PLT INDU Piatto + 2 PLT EUR Punta, 14 colli):** disposizione `(0,0) … (120,500)` per gli INDU e `(0,600) (80,600)` per gli EUR → `SX 7.20 m` (badge scuro `#1E293B`) e `DX 6.00 m` (badge slate `#475569`), guide tratteggiate `0→125` / `125→250` con chiusure a filo, riga A4 `Lato SX 7.20 m | Lato DX 6.00 m`, viewBox scheda `-118 -38 450 1424` senza badge tagliati.
   - **Asimmetrico a quota nominale (24 PLT INDU Piatto + 2 PLT EUR Punta, 26 colli):** 12 file × 2 colli fino a `Y = 1200` e punte EUR in coda → `SX 1320 cm = 13.20 m` e `DX 1200 cm = 12.00 m`: badge `▶ 13.20 m` (scuro) e `◀ 12.00 m` (slate), riga A4 `Lato SX 13.20 m | Lato DX 12.00 m`, linea nominale 13,20 m presente e verificata.
   - **Simmetrico (2 PLT EUR Piatto 120 × 80):** `SX = DX = 0.80 m` → **un solo** badge scuro `▶ 0.80 m` e **una sola** linea guida continua `0 → 250` (nessun `stroke-dasharray`); riga A4 a valore unico `0.80 m`.
   - **Densità `minimal`:** 0 linee e 0 badge LDM su canvas **e** scheda A4, con la riga `INGOMBRO LINEARE (LDM)` ancora presente in tabella.
   - **Click su `Stampa / PDF`** → `window.print()` invocato; `npx tsc -b --force`, `npm run lint`, `npm run build` → **exit 0**.

---

### S. Regola della Corsia di Parete (Wall Lane Rule) per l'LDM Asimmetrico (Sprint G-ter)
1. **Diagnosi dell'edge case (4 colonne di carrelli EC 61 × 81 cm):** con la Regola del Baricentro il terzo carrello di una fila da 4 (`X = 0, 61, 122, 183`), avendo il centro geometrico a 152,5 cm contro una mezzeria di 125 cm, veniva attribuito al **lato destro**: la corsia di parete destra (fascia 200÷250 cm) risultava così "coperta" e **l'indicatore destro spariva anche con la 4ª colonna completamente VUOTA**. Il difetto si manifesta da 3 carrelli in su: `SX = DX` (13,07 m / 13,07 m) e badge singolo al posto di due dati distinti.
2. **`calculateLdmMetrics` riscritta con la Regola della Corsia di Parete** (`src/utils/snapping.ts`), nuova costante esportata **`WALL_ZONE_THRESHOLD = 50`** (cm):
   - **Fascia parete sinistra:** `item.x <= 50`;
   - **Fascia parete destra:** `item.x + item.width >= vehicle.width - 50`;
   - **Colli a tutta larghezza** (`item.width >= vehicle.width × 0.6`, es. `SFUSO`): impegnano **sempre entrambe** le corsie;
   - un collo impegna una corsia **solo se la tocca davvero** (basta la condizione su una delle due, o su entrambe);
   - **Fallback per i colli puramente centrali** (nessuna delle due fasce toccata): il lato è deciso dal **bordo sinistro** (`item.x < midX` → sinistra, altrimenti destra) e **non dal baricentro**. È l'unico scostamento dal frammento di codice indicato nella richiesta, ed è indispensabile: con il baricentro il terzo carrello (centro 152,5 ≥ 125) tornerebbe a contare sul lato destro e il caso limite resterebbe **non risolto** (il task richiede espressamente SX ≠ DX e due badge a schermo). Con il bordo sinistro il carrello `X = 122 < 125` resta a sinistra e la corsia destra vuota viene segnalata.
   - `isAsymmetric` (`|leftY − rightY| >= LDM_SYMMETRY_TOLERANCE_CM = 1`) e `maxOccupiedY = max(leftY, rightY)` restano invariati; **nessun consumatore è stato modificato**: `TruckCanvas.tsx`, `utils/export.ts` e `PrintReport.tsx` continuano a usare `calculateLdmMetrics` come unica fonte di verità (aggiornati solo i commenti, da "Regola del Baricentro" a "Regola della Corsia di Parete").
3. **Verifica headless (Chrome DevTools Protocol, zero dipendenze aggiunte): 22/22 controlli superati in 3,25 s** (watchdog 15 s rispettato, `Browser.close()` + `process.exit(0)`), nessun errore in console. Mezzo `bilico_cc` 250 × 1328 cm.
   - **Unit (funzione pura importata dal dev server, `/src/utils/snapping.ts`):** 3 EC nella 1ª fila → `81 / 0` **asimmetrico** (prima `81 / 81`); + 4° EC → `81 / 81` simmetrico; 15 file da 4 EC (fondo 1215) → `1215 / 1215`; + 3 EC nella fila 16 → **`1296 / 1215` asimmetrico**; + 4° EC → `1296 / 1296`; Sfuso 250 × 200 → `200 / 200`; fallback centrale (X = 100 → SX 81 / DX 0; X = 130 → SX 0 / DX 81).
   - **End-to-end A (carico reale da 60 EC a punta: 15 file × 4 colonne, fondo 1215 cm):** badge singolo `▶ 12.15 m` scuro `#1E293B` con guida **continua** 0→250. Aggiunti **3 EC a punta nella fila 16** (X = 0/61/122, 4ª colonna vuota) → **due badge a schermo**: `▶ 12.96 m` scuro `#1E293B` (lato carico) e `◀ 12.15 m` slate `#475569`, guide tratteggiate `6 4` SX `0→125` a Y = 1296 e DX `125→250` a Y = 1215 (ciascuna con chiusura piena a filo mezzeria/parete); riga `#print-ldm-row` della scheda A4 allineata (`Lato SX 12.96 m | Lato DX 12.15 m`). Aggiunto il **4° EC** → simmetria `▶ 12.96 m` con badge singolo e guida continua.
   - **End-to-end B (quote citate 13,07 / 12,26 m):** 15 file da 4 EC + un collo a tutta larghezza di 11 cm che porta il fondo dell'ultima fila completa a **Y = 1226 cm** + 3 EC a punta nella fila 16 (**Y = 1307 cm**) → **`▶ 13.07 m` scuro `#1E293B` e `◀ 12.26 m` slate `#475569`, entrambi presenti a schermo**; aggiunto il 4° EC → **simmetria 13,07 m con badge singolo** e guida continua. *(Con la sola geometria di catalogo gli EC 61 × 81 a punta producono file da 81 cm: le 15 file chiudono a 1215 cm, cioè 11 cm in meno su entrambe le quote citate; l'invariante — asimmetria pari a una fila di EC — è identica.)*
   - **Export PNG (`buildPianoSvg` / `getPianoExtent`):** badge `▶ 12.96 m` + `◀ 12.15 m`, 2 guide tratteggiate e gutter destro riservato nel caso asimmetrico (viewBox 450 cm contro 374 cm del simmetrico, 0 tratteggi e badge singolo).
   - **Evidenza grafica:** `shots/canvas-ldm-corsia-parete.png` (63 colli, due badge) e `shots/canvas-ldm-corsia-parete-1307-1226.png` (le quote citate dal task, badge scuro + slate).
   - `npx tsc -b --force`, `npm run lint`, `npm run build` → **exit 0**.

---

### T. Note Laterali di Carico (Side Annotations) su Canvas, Export PNG & Scheda A4 (Sprint H)
1. **Nuovo tipo `SideNote`** (`src/types.ts`): `{ id, y, title, content, color, borderColor, width }` — la quota `y` è in cm lungo il camion (0 = Cabina), `color` è il pastello di sfondo (ereditato dal collo o bianco neutro), `borderColor` vale `#94A3B8` (o `#CBD5E1`), `width` è la larghezza fissa della card (140 cm). Usato con `import type` da tutti i consumatori.
2. **Modulo puro condiviso `src/utils/sideNotes.ts`**: unica fonte di verità della geometria delle note, così canvas, PNG e scheda A4 non possono divergere.
   - Costanti: `NOTE_LANE_OFFSET_CM = 30` (stacco dalla parete destra), `NOTE_DEFAULT_WIDTH_CM = 140`, `NOTE_MIN_HEIGHT_CM = 70`, `NOTE_PADDING_CM = 8`, `NOTE_LINE_HEIGHT_CM = 14`, `NOTE_STACK_GAP_CM = 6`, `NOTE_MAX_CHARS_PER_LINE = 28`, `NOTE_BORDER_COLOR = '#94A3B8'`, `NOTE_BORDER_COLOR_SOFT = '#CBD5E1'`, `NOTE_PASTEL_COLORS` (7 tinte pastello + bianco neutro `#FFFFFF`).
   - `wrapNoteText(text, maxChars)`: a capo automatico pulito che rispetta gli a capo digitati, spezza le parole troppo lunghe e conserva le righe vuote.
   - `noteGeometry(note, maxChars)`: altezza della card calcolata sulle righe reali (`26 + righe × 14` cm) con minimo assoluto di 70 cm.
   - `resolveNoteLayouts(notes, maxChars)`: dispone le card nella corsia e risolve le sovrapposizioni **spingendo in basso** la card in conflitto (`NOTE_STACK_GAP_CM`), senza mai invalidare la quota scelta dall'operatore.
3. **Stato globale e callback** (`src/App.tsx`): `notes: SideNote[]` (default `[]`) e `selectedNoteId: string | null` (default `null`), con `handleAddNote(Omit<SideNote,'id'>)`, `handleUpdateNote(id, updates)`, `handleDeleteNote(id)`, `handleUpdateNotePos(id, y)` e `handleSelectNote(id)` (la selezione di una nota azzera quella dei colli, e viceversa: le due modalità non coesistono). **Scorciatoia `Canc`**: con una nota attiva e nessun collo selezionato elimina la nota; le textarea sono escluse dall'intercettazione, quindi non si cancella nulla mentre si scrive.
4. **Creazione rapida con eredità automatica** (`src/components/ControlDeck.tsx`): con uno o più colli selezionati compare il pulsante sobrio `[ 📝 Aggiungi Nota Laterale ]` (icona `FileText` di `lucide-react`). La nuova nota nasce con `y = min(Y dei colli selezionati)`, `title = nome del primo collo`, `color = colore di riempimento esatto del collo`, `borderColor = '#94A3B8'`, `width = 140`, testo guidato `"Inserisci nota operativa..."`, ed entra subito in editing.
5. **Pannello "Nota Laterale Selezionata"** (`src/components/ControlDeck.tsx`): titolo/cliente compatto, textarea multi-riga per le istruzioni operative (con nota sul wrap a 28 caratteri), palette rapida di 7 pastiglie pastello + casella **bianco neutro** (`aria-pressed` sulla tinta attiva) e pulsante **`Cancella Nota`** in rosso mattone istituzionale (`text-red-800`); badge di appoggio con la quota `Y x.x cm`.
6. **Rendering nel canvas** (`src/components/TruckCanvas.tsx`): corsia dedicata a `X = vehicle.width + NOTE_LANE_OFFSET_CM` (280 cm sul bilico CC) — **fuori dal pianale utile, quindi nessun impatto sui metri lineari**. Grafica CAD sobria: `<rect rx={4} fill={note.color} stroke={isSelected ? '#2563EB' : note.borderColor} strokeWidth={isSelected ? 2 : 1} filter="url(#side-note-shadow)" />` con ombra discreta dedicata, titolo `text-[12px] font-bold fill-slate-800` e testo `text-[10px] fill-slate-700` spezzato in `<tspan>` (x allineata, passo 14 cm). Interazione: il click seleziona la nota (deselezionando i colli) e il trascinamento col puntatore la sposta lungo l'asse **Y**, clampato tra `0` e la quota di fondo dinamica `effectiveLength` (quindi anche oltre le porte, fino all'ultimo collo sbordato).
7. **Inclusione in export PNG e scheda A4** (`src/utils/export.ts` + `src/components/PrintReport.tsx`):
   - `getPianoExtent(vehicle, items, labelDensity, notes)` allarga il gutter destro della corsia note di `NOTE_LANE_OFFSET_CM + NOTE_DEFAULT_WIDTH_CM + 40` (210 cm) **solo quando ci sono note**, e allunga l'altezza se una card scende sotto l'ultimo collo: sul bilico CC si passa da 374 cm (simmetrico senza note) a 578 cm (118 di righello SX + 250 + 210 di corsia; con badge LDM asimmetrico a destra: 450 → 578 cm). Senza note **tutto resta identico a prima**.
   - `buildPianoSvg(vehicle, items, labelDensity, notes)` disegna le card con colore, bordo, titolo in grassetto e righe di testo in `<tspan>`; `copyCanvasToClipboard(..., notes)` le propaga allo snapshot a 2400 px.
   - `PrintReport` riceve le note, le ridisegna nel vettoriale della scheda con la stessa geometria, ne riporta il conteggio in intestazione (`N note laterali`) e le elenca nelle righe `Note laterali di carico` / `#print-note-row` della tabella in calce (titolo, quota `Y x.xx m` e testo integrale), così le istruzioni restano nel documento anche se il disegno è molto scalato.
8. **Verifica headless (Chrome DevTools Protocol, zero dipendenze aggiunte): 34/34 controlli superati** sul bundle di produzione servito da `vite preview` + **18/18** sullo harness del dev server (viewBox, rasterizzazione e pixel del PNG), `Browser.close` + `process.exit(0)`, nessun errore in console.
   - **Eredità:** click su un PLT INDU → `[Aggiungi Nota Laterale]` → card a `Y = 0` (quota del collo), `X = 280`, `140 × 70 cm`, `rx=4`, ombra attiva, titolo `PLT INDU`, riempimento `#E2E8F0` (identico al collo), bordo di selezione `#2563EB` che diventa `#94A3B8` a selezione persa.
   - **Testo:** contenuto `"Nota questi bancali sono poco stabili, fare attenzione durante il carico!"` → 4 `<tspan>` con x allineata a 288 cm, massimo 24 caratteri per riga, passo verticale esatto 14 cm, altezza card cresciuta a **82 cm**.
   - **Drag:** trascinamento verso il basso `y 0 → 232,6` con ascissa invariata a 280; trascinamento di 2000 cm → quota **clampata a 1328 cm** (`effectiveLength`).
   - **Export:** viewBox con note `-118 -38 578 1424` contro `-118 -38 450 1424` senza note (Δ 128 cm), corsia note a 280 cm anche nell'SVG; PNG rasterizzato 2400 px con **pixel campionato nel centro della card = `rgba(226,232,240,255)`** (colore ereditato) e card disegnata **sopra** la linea guida LDM. Nel test end-to-end il pulsante `Copia Immagine` completa l'esportazione (`Copiato!`) e la scheda A4 riporta la card (`stroke #94A3B8`), il viewBox `578` e il contatore delle note.
   - **Evidenza grafica:** `shots/canvas-note-laterali.png` (card a fianco del bancale, pannello sidebar con titolo/contenuto/palette e riepilogo).
   - `npx tsc -b --force`, `npm run lint`, `npm run build` → **exit 0**.
9. **Nota di scostamento dalla specifica:** la formula `viewBoxWidth = vehicle.width + 30 + 140 + 40` (460 cm) descrive la sola corsia note su un carico **senza** righelli: con un carico reale si somma la riserva già esistente del righello sinistro (quota 13,20 m / badge LDM), che il codice continua a calcolare. Il comportamento implementato è quindi `vehicle.width + riserva sinistra + 210 cm di corsia note`, con la corsia sempre a `width + 30`.

---

### U. Compattazione Scorciatoie del Footer in Popover Fluttuante (Sprint H-bis)
1. **Footer di `ControlDeck.tsx` compattato:** l'elenco statico aperto delle 7 scorciatoie (~160-180 px di altezza verticale, con `<kbd>` chiari su sfondo grigio) è sostituito da un **unico trigger discreto** su una sola riga sottile: `[ ⓘ Scorciatoie da tastiera ]` in `text-[11px] text-slate-400`, che al passaggio del mouse vira a `text-slate-700` con l'icona `Info` in blu (`group-hover:text-blue-600`). Il contenitore è `mt-auto border-t border-slate-200 pt-3 flex justify-between items-center relative` (29,5 px misurati, contro i ~160-180 px precedenti: **circa 150 px restituiti alla sidebar**).
2. **Popover fluttuante verso l'alto (hover puro, nessuno stato React):** il blocco informativo è un figlio assoluto del trigger (`absolute bottom-full left-0 mb-2 w-72`), quindi si apre **sopra** il pulsante senza occupare layout. Estetica scura coerente: `bg-slate-900 text-slate-100`, bordo `border-slate-800`, `rounded-lg shadow-xl`, `z-50`, intestazione `Guida Rapida Scorciatoie` con icona `Info` blu e divisore `border-slate-700`, tasti `<kbd>` in `bg-slate-800 border-slate-700 font-mono text-[10px]`; 7 voci (Ruota 90°, Elimina collo / nota, Selezione multipla, Lasso di selezione, Pan verticale Cabina ↔ Porte, Pan orizzontale, Zoom al cursore).
3. **Mostra/nascondi senza JavaScript:** visibilità pilotata dalle classi di gruppo `opacity-0 pointer-events-none` → `group-hover:opacity-100 group-hover:pointer-events-auto` con `transition-all duration-200`. Il popover non intercetta il mouse da chiuso (`pointer-events-none`) e non introduce stati aggiuntivi nel componente.
4. **Verifica headless (Chrome DevTools Protocol, zero dipendenze aggiunte): 12/12 controlli superati** a **1600×1200** e **12/12** a **700×1000** (plancia `w-80`), `chrome.kill()` + `process.exit(0)`, nessun errore in console.
   - **Footer a riposo:** altezza **29,50 px** (una sola riga), popover con `opacity: 0` e `pointer-events: none` — nessuna lista aperta.
   - **All'hover:** `opacity: 1` / `pointer-events: auto`, rettangolo `L1237 T923,5 R1525 B1155,5` con trigger a `top 1163,5`: il popover è **interamente sopra** il trigger e **completamente dentro** il viewport (nessun taglio, né in alto né a destra, `scrollWidth 383 = clientWidth 383` → nessuna barra orizzontale). A 700 px di larghezza resta dentro il bordo della plancia (`popover right 689 ≤ deck right 700`).
   - **Contenuto:** 8 righe (1 intestazione + 7 voci) e 6 `<kbd>`, con i testi delle 7 scorciatoie tutti presenti; sfondo `slate-900` (`oklch(0.208 0.042 265.755)`), `z-index 50`, `position: absolute`.
   - **Nessun ingombro:** il footer resta **29,50 px** anche a popover aperto (overlay puro).
   - **Evidenza grafica:** `shots/footer-scorciatoie-compatto-1600x1200.png` (riga sottile a riposo) e `shots/footer-scorciatoie-popover-1600x1200.png` (popover scuro aperto verso l'alto).
   - `npx tsc -b --force`, `npm run lint`, `npm run build` → **exit 0**.

---

### V. Note Laterali — Testo Unico, Offset Corretto, Corpo Testo & Maniglia di Ridimensionamento (Sprint H-ter)
1. **Diagnosi del difetto di resa** (`src/components/TruckCanvas.tsx`): nel gruppo della nota (`transform="translate(noteX, note.y)"`) il `<text>` operativo aveva `x = NOTE_PADDING_CM` **relativo** all'origine del box, mentre ogni `<tspan>` riceveva `x = noteLaneX + NOTE_PADDING_CM` (**assoluto**, 290 cm): la coordinata del `tspan` prevale su quella del padre, quindi ogni riga di testo finiva **290 cm a destra del rettangolo**, nello spazio grigio. Inoltre la card era divisa in due campi ridondanti (titolo in grassetto + contenuto).
2. **`SideNote` unificata** (`src/types.ts`): rimossi `title` e la larghezza fissa; il tipo ora è `{ id, y, content, color, borderColor, width, height?, fontSize? }` — **un unico testo libero** (`content`, multi-riga), larghezza in cm (default 140, min 70, max 300), altezza esplicita opzionale (min 40, max 400) e corpo del testo in px (`9 | 11 | 14`, default 11).
3. **Geometria condivisa riscritta** (`src/utils/sideNotes.ts`, unica fonte di verità per canvas, PNG e scheda A4):
   - `NOTE_PADDING_CM = 10` è ora anche l'ascissa **relativa all'origine del box** di `<text>` e di ogni `<tspan>`;
   - `noteLineHeightCm(fontSize) = 14 × fontSize / 11` e `noteFirstBaselineCm(fontSize) = 18 × fontSize / 11`: passo e baseline scalano col corpo scelto (a 14 px → 17,82 cm / 22,91 cm);
   - `resolveNoteFontSize(note)` rispetta i corpi 9/11/14 px (il tetto di sicurezza `maxNoteFontSizeForWidth(width) = width / 10` interviene solo su card molto strette) e `noteCharsPerLine(width, fontSize)` deduce le battute per riga da larghezza **e** corpo, con tolleranza di sicurezza `NOTE_WRAP_SAFETY = 0.94` perché l'ultima lettera non tocchi mai il bordo;
   - `noteGeometry(note)` restituisce `{ height, lines, fontSize, lineHeightCm, firstBaselineCm, maxChars, textHeight }`: se l'operatore ha fissato l'altezza (`note.height`) il box usa quella misura, altrimenti si adatta al testo (`baseline + righe × passo + discesa + 6 cm`, minimo 40 cm); `textHeight > height` segnala che il testo va ritagliato;
   - `resolveNoteLayouts(notes)` conserva la spinta verso il basso anti-sovrapposizione (nessun parametro `maxChars` esterno: deriva dal corpo di ogni nota).
4. **Rendering del canvas** (`src/components/TruckCanvas.tsx`): il box è `<rect width={note.width} height={height} />` con origine `(0, 0)`; il testo è un unico `<text x={10} fontSize={fontSize}>` con `<tspan x={10} y={firstBaselineCm + i × lineHeightCm}>`: **tutto il contenuto vive rigorosamente dentro il rettangolo colorato**. Un `clipPath` per nota (`note-clip-<id>`) interviene **solo** se l'operatore ha ridotto il box a un'altezza inferiore a quella del testo.
5. **Maniglia di ridimensionamento** (`src/components/TruckCanvas.tsx` + `src/App.tsx`): quando `selectedNoteId === note.id`, nell'angolo basso-destro compare `<rect x={w - 8} y={h - 8} width={8} height={8} rx={1.5} fill="#2563EB" className="cursor-se-resize" />`. Il `pointerdown` sulla maniglia (`handleNoteResizePointerDown`) fa `stopPropagation()` — quindi non trascina la card e non fa pan del canvas — e il trascinamento aggiorna `width` (clamp **70–300 cm**) e `height` (clamp **40–400 cm**) tramite la nuova callback `onUpdateNoteSize` → `handleUpdateNoteSize` in `App.tsx` (un solo `setState` per frame, `height` diventa esplicita: da quel momento il box non si riadatta più al testo).
6. **Pannello sidebar** (`src/components/ControlDeck.tsx`, "Nota Laterale Selezionata"):
   - rimosso il campo **Titolo / Cliente** (e l'`#note-title-input`): resta la sola textarea generosa `TESTO DELLA NOTA` (placeholder `Scrivi avvertenze, cliente o note operative...`, `rows = 5`) con l'indicazione dinamica delle battute per riga;
   - nuovo selettore compatto a 3 pulsanti `Dimensione Testo: [ A- (9px) | A (11px) | A+ (14px) ]` (`data-font-size`, `aria-pressed`) che aggiorna `fontSize` della nota attiva;
   - due input numerici affiancati `Larghezza (W cm)` (`#note-width-input`, step 5, min 70, max 300) e `Altezza (H cm)` (`#note-height-input`, step 5, min 40, max 400), con clamp applicato in scrittura e valore H allineato all'altezza reale del box (esplicita o misurata sul testo);
   - palette invariata (bianco neutro `#FFFFFF` + 7 pastiglie pastello) e pulsante `Cancella Nota` in rosso mattone;
   - **`Aggiungi Nota Laterale`** sui colli selezionati: la nota nasce con `content` pre-popolato col nome del primo collo selezionato (es. `"PRODIVA 3S - "`, helper `buildNoteSeedText`), ereditando quota Y e colore come prima, più `width = 140` e `fontSize = 11`.
7. **Allineamento di export PNG e scheda A4** (`src/utils/export.ts` + `src/components/PrintReport.tsx`): `getPianoExtent` riserva a destra la **card più larga effettivamente presente** (`NOTE_LANE_OFFSET_CM + max(note.width) + 40`) e usa `resolveNoteLayouts` anche per la quota di fondo; `renderNotes` e il vettoriale della scheda ridisegnano l'unico `content` spezzato da `wrapNoteText` con `<tspan x="10">` (coordinate relative), `note.width`, `note.height` e `note.fontSize`, con lo stesso `clipPath` (`noteClipId`) solo dove il testo eccede il box. Rimossa ogni logica di titolo separato e la riga di tabella mostra `Nota laterale` + quota `Y x.xx m` + testo integrale in `#print-note-row`.
8. **Verifica headless (Chrome DevTools Protocol, zero dipendenze aggiunte): 39/39 controlli superati**, `Browser.close()` + `process.exit(0)`, nessun errore in console. Tutte le misure sono prese **relative al rettangolo della card** (in cm reali), quindi indipendenti da pan/zoom.
   - **Contenimento:** contenuto `PLT INDU: bancali poco stabili, attenzione durante il carico e controllo dei cinghiali.` → 6 righe, `x` del testo e di **tutti** i `<tspan>` = **10 cm**, bounding box del testo `[10,0 .. 102,9]` contro box `140 × 113` (nessun testo nel grigio, né a destra né sotto).
   - **Font size:** click su `A-` → `font-size 9 px` (computed 9 px), `A+` → `14 px`, `A` → `11 px`, con `aria-pressed` corretto; l'altezza reale del testo passa da **59,4 cm** (9 px) a **143,3 cm** (14 px) — la dimensione è davvero applicata e il testo, auto-mandato a capo, resta sempre entro i bordi (a 14 px: box 140 × 178, testo `[10 .. 88,8]`).
   - **Maniglia:** presente sulla sola nota selezionata, `8 × 8` a `rx=1.5`, `fill #2563EB`, cursore `se-resize`, ancorata a `(W−8, H−8)`; drag verso il basso-destra `140 × 113 → 200 × 193` **senza spostare la card** (`translate` invariato) e con i campi sidebar allineati (`200 × 193`); drag di −500 cm → **clamp a 70 × 40 cm** con `clipPath` attivo (`clipped=true`, fondo del testo misurato 40,0 cm = H).
   - **Export SVG:** card nella corsia (`translate(280, 0)`), `rect 140 × 200` (altezza utente rispettata), tutti i `<tspan x="10">` con baseline 18 cm e passo 14 cm (11 px) e baseline 22,91 / passo 17,82 cm (14 px), viewBox 504 cm con corsia note riservata, **nessun** titolo in grassetto `#1E293B`.
   - **Scheda A4:** card ridisegnata nella corsia con `text x = 10` e 11 `<tspan x="10">`, testo integrale e riga `#print-note-row` in tabella; nessun titolo separato.
   - **Evidenza grafica:** `shots/note-laterali-testo-unico.png` (testo interamente dentro il rettangolo + maniglia blu sull'angolo basso-destro).
   - `npx tsc -b --force`, `npm run lint`, `npm run build` → **exit 0**.

---

### W. Fusione Stiva Sequenziale nel Catalogo Colli — Accordion Multifunzione (Sprint I)
1. **Selettore a schede eliminato** (`src/components/ControlDeck.tsx`): rimossi lo stato `activeTab`, il tipo `DeckTab`, i pulsanti `[ 📦 Carico Diretto ] | [ ⚡ Stiva Sequenza ]` e l'intero blocco autonomo della tabella sequenziale (`LOTTI / TAPPE DI CONSEGNA` con righe lotto, toggle orientamento, modalità `Sostituisci`/`Accoda` e pulsante `⚡ Esegui Stiva Sequenziale`). L'interfaccia è tornata **unica**: sotto `Aggiungi Colli` la sidebar mostra direttamente il catalogo, senza passaggi intermedi.
   - Rimossi di conseguenza: il tipo `SequenceBatchItem` (`src/types.ts`), la prop `onExecuteSequence` e il motore `handleExecuteSequence` (`src/App.tsx`, sostituito da `handleAddBatch`), le costanti `SEQUENCE_*` / `SEQUENCE_FORMATS` / `DEFAULT_SEQUENCE_FORMAT` e l'import `COLOR_FAMILY_MEDIUM_SHADES` (la tonalità del lotto è ora scelta dall'operatore, non più assegnata a rotazione).
2. **Accordion Multifunzione su ogni riga di formato** (`ControlDeck.tsx`, i 5 colli standard `PLT INDU`, `PLT EUR`, `PLT ½ EUR`, `CC`, `EC`):
   - **Stato:** `openPalletCode: string | null` (default `null`, al massimo **un** cassetto aperto) e `batchDrafts: Record<string, PalletBatchDraft>` (`{ quantity, name, color }`, uno per formato: la bozza digitata sopravvive alla chiusura del cassetto).
   - **Riga a riposo (36 px misurati):** a sinistra l'area cliccabile con `ChevronRight`/`ChevronDown`, pallino colore e nome del formato (id `pallet-row-<CODE>`, `aria-expanded`/`aria-controls`); a destra i due micro-pulsanti di inserimento **singolo** `[ ↔ Piatto ]` (id `quick-piatto-<CODE>`) e `[ ↕ Punta ]` (id `quick-punta-<CODE>`), ciascuno con `e.stopPropagation()` per non innescare l'apertura dell'accordion. Le quote `120×100` restano nel `title` del pulsante, così la riga resta alta 36 px.
   - **Cassetto espanso** (`openPalletCode === pallet.code`, id `pallet-batch-<CODE>`, classi `bg-slate-50 border border-slate-200 rounded p-2.5 space-y-2 mt-1` + inset orizzontale):
     - `Q.tà` (id `batch-qty-<CODE>`): input numerico compatto `w-16 bg-white border border-slate-300 text-xs rounded p-1 font-mono text-center`, min `1`, max `99`, **default `10`**.
     - `Cliente / Lotto` (id `batch-name-<CODE>`): input testo con placeholder `Es. CONAD`.
     - **Matrice colori 7 × 3** riusata da `renderColorMatrix` (aria-label `Colore lotto <formato> <famiglia> <sfumatura>`): pre-imposta la tinta del lotto, default = colore di catalogo del formato.
     - **Due pulsanti di stiva massiva** (id `batch-add-piatto-<CODE>` / `batch-add-punta-<CODE>`, classi `flex-1 bg-white hover:bg-blue-50 border border-slate-300 hover:border-blue-400 text-slate-800 text-xs font-semibold py-1.5 rounded flex items-center justify-center gap-1 transition shadow-sm`) con etichetta dinamica `+ {Q.tà} di Piatto` / `+ {Q.tà} di Punta`.
3. **Motore batch `handleAddBatch(pallet, quantity, orientation, name?, color?)`** (`src/App.tsx`), esposto a `ControlDeck` come prop `onAddBatch`:
   - Clamp della quantità a `1–99` (`BATCH_MIN_QUANTITY` / `BATCH_MAX_QUANTITY`, default `10`).
   - Calcolo di $W$ e $L$ dall'orientamento (Piatto: $W = \max, L = \min$; Punta: $W = \min, L = \max$).
   - **Un unico ciclo sincrono** `for i = 1…quantity`: `findSmartSpawnPosition(W, L, vehicle, current)` sul pianale già aggiornato dai colli precedenti → il lotto si dispone ordinatamente dalla **Cabina verso le Porte** riempiendo da sinistra a destra.
   - Ogni `PlacedItem` nasce con `name: name || pallet.name`, `color: color || pallet.color` e `borderColor: ITEM_BORDER_COLOR` (`#334155`, invariante rigido: la tinta del lotto colora solo il riempimento).
   - **Aggiornamento atomico:** la lista temporanea `current` viene restituita in un solo `setItems` (un solo render per l'intero lotto); la selezione viene azzerata.
4. **Verifica headless (Chrome DevTools Protocol, zero dipendenze aggiunte): 14/14 controlli superati in 3,7 s** (watchdog 15 s rispettato, `chrome.kill()` + `process.exit(0)`), nessun errore in console. Mezzo `bilico_cc` 250 × 1328 cm, viewport 1600 × 1200.
   - **Fusione:** nessuna occorrenza di `Stiva Sequenza` / `Carico Diretto` nel DOM, `[role="tab"]`/`[role="tablist"]` assenti, 5 righe di catalogo presenti in ordine (`INDU, EUR, HALF_EUR, CC, EC`) e sidebar che mostra direttamente `Aggiungi Colli`.
   - **Riga a riposo:** altezza **36 px** esatti con cassetto assente.
   - **Click singolo:** `#quick-piatto-INDU` → **1** collo `120×100` a `(0,0)`, riempimento `#E2E8F0`, nessuna apertura del cassetto.
   - **Lotto:** click su `#pallet-row-EUR` → cassetto `329×175 px` con default `Q.tà 10` e pulsante `+ 10 di Piatto`; impostati `Q.tà 6`, `Cliente "COOP"` e tinta **Verde scuro** (`rgb(74,222,128)` = `#4ADE80`, `aria-pressed=true`) l'etichetta del pulsante diventa `+ 6 di Piatto`. Al click atterrano **6 PLT EUR 120 × 80 verdi** in posizione `(0,0) (120,0) (0,80) (120,80) (0,160) (120,160)`, tutti etichettati `COOP`, tutti col bordo antracite `#334155` e **nessun allarme**; il riepilogo riporta `6 Colli Totali` e la riga `COOP: 6`.
   - **Evidenza grafica:** `shots/accordion-multifunzione-a-riposo.png` (catalogo a riposo, nessuna scheda) e `shots/accordion-multifunzione-lotto.png` (cassetto EUR aperto con Q.tà 6 / COOP / matrice colori + 6 colli verdi stivati da Cabina a Porte).
   - `npx tsc -b --force`, `npm run lint`, `npm run build` → **exit 0**.

---

## 3. MAPPA ARCHITETTURALE DEI FILE

- `src/types.ts`: Tipi TypeScript (`VehicleConfig`, `PalletDefinition`, `PlacedItem`, `ItemPositionUpdate`, `AddItemOptions`, `LabelDensity`, **`SideNote`** — nota laterale di carico a **testo unico** `{ y, content, color, borderColor, width, height?, fontSize? }`). Il tipo `SequenceBatchItem` è stato **eliminato** con la fusione nell'Accordion Multifunzione (sezione W): il contorno dei colli resta l'invariante globale `ITEM_BORDER_COLOR`.
- `src/constants.ts`: Presets veicoli, catalogo colli (bordo unico antracite `#334155`), `CUSTOM_PALLET` (fuori sagoma), **matrice colori stile Excel** (`ColorFamily`, `COLOR_FAMILIES` 7 famiglie × 3 sfumature; la vecchia costante `COLOR_FAMILY_MEDIUM_SHADES` di rotazione automatica delle tappe è stata rimossa con la sezione W), costanti di rendering condivise (`ALERT_COLOR`, `NOMINAL_QUOTA_CM`, `LDM_BADGE`, `LDM_BADGE_MUTED_COLOR`, `LDM_SYMMETRY_TOLERANCE_CM`, `LDM_GUIDE_COLOR`, `LDM_GUIDE_DASH`, `LDM_GUIDE_CLOSING_LENGTH`, helper `ldmBadgeRightLeftX` / `ldmBadgeRightCenterX`, `LDM_BADGE_RESERVED_RIGHT`).
- `src/utils/snapping.ts`: Modulo matematico puro (`calculateSnapPosition`, `isRectColliding`, `isOutOfBounds`, `findSmartSpawnPosition` — first-fit a due passate: prima dentro la sagoma estesa fino a `vehicle.length + REAR_OVERHANG_LIMIT`, poi continuo a file ordinate oltre il buffer, con pareti laterali sempre rigide) e **`calculateLdmMetrics` con la Regola della Corsia di Parete** (`WALL_ZONE_THRESHOLD = 50` cm; `LdmMetrics { leftY, rightY, isAsymmetric, maxOccupiedY }`), unica fonte di verità dell'ingombro LDM per canvas, export PNG e scheda A4.
- `src/utils/labels.ts`: Geometria condivisa delle etichette dei colli (`shouldWrapLabel`, `splitLabelIntoTwoLines`, `clipIdForItem`, corpi font in cm), usata sia dal canvas a schermo sia dall'export PNG.
- `src/utils/sideNotes.ts`: Geometria e testo condivisi delle **note laterali di carico** (`wrapNoteText`, `noteGeometry` — altezza auto-adattata o esplicita, corpo 9/11/14 px, passo e baseline proporzionali, `textHeight` per il clip, `noteCharsPerLine`, `resolveNoteFontSize`, `resolveNoteLayouts` con spinta verso il basso anti-sovrapposizione, `buildNoteSeedText`, limiti `NOTE_MIN/MAX_WIDTH_CM` 70–300 e `NOTE_MIN/MAX_HEIGHT_CM` 40–400, `NOTE_PADDING_CM = 10` come ascissa relativa del testo, costanti di corsia/colori pastello + bianco neutro), unica fonte di verità per canvas, export PNG e scheda A4.
- `src/utils/export.ts`: Snapshot PNG pulito del pianale (`getPianoExtent` con `labelDensity` e `notes`, `buildPianoSvg`, `rasterizeSnapshotToPng`, `copyCanvasToClipboard`) con doppio badge LDM asimmetrico calcolato da `calculateLdmMetrics`, **corsia delle note laterali** (gutter destro allargato e card ridisegnate), gutter destro dedicato e copia negli appunti con fallback download.
- `src/components/TruckCanvas.tsx`: Render SVG fullscreen, Zoom/Pan da rotellina con **clamp rigido intelligente** del pan Y (centratura automatica se il mezzo entra nello schermo, altrimenti blocco Cabina a `40 + 32 × zoom` per tenere dentro la didascalia e Porte a ridosso del bordo basso) e **quota di fondo dinamica** `effectiveLength = max(vehicle.length, maxItemBottom)` che estende la corsa fino ai colli sbordati oltre le porte, con riallineamento automatico quando rientrano, didascalie `▲ CABINA ▲` e `PORTE POSTERIORI`, quota nominale 13,20 m e **LDM da `calculateLdmMetrics`** (simmetrico continuo / asimmetrico tratteggiato SX + DX, nascosto con densità `minimal`), etichette con `clipPath` e a capo automatico, selezione multipla (Cmd/Ctrl+Click, lasso Shift+Drag), drag di gruppo, eventi puntatore, segnalazione allarmi, HUD densità etichette (`LabelDensity`) e **corsia delle note laterali** a `X = width + 30` (testo unico a coordinate **relative** al box con `x = 10`, drag lungo l'asse Y clampato a `effectiveLength`, **maniglia di ridimensionamento** 8 × 8 cm `#2563EB` sull'angolo basso-destro che aggiorna W 70–300 cm e H 40–400 cm senza muovere la nota né panare la vista).
- `src/components/ControlDeck.tsx`: Plancia di comando **unica** (nessun selettore a schede, sezione W) con barra comandi rapida (`Copia Immagine` / `Stampa / PDF`), **Accordion Multifunzione del catalogo** (righe a 36 px con freccina `ChevronRight`/`ChevronDown`, pallino colore, nome formato e micro-pulsanti `↔ Piatto` / `↕ Punta` per il collo singolo; cassetto a lotti con `Q.tà` 1–99 default 10, `Cliente / Lotto`, matrice colori 7 × 3 e pulsanti `+ N di Piatto` / `+ N di Punta`), selettore adattivo del mezzo, box ad accordion Sfuso e Formato Libero / Fuori Sagoma, pannello selezione singola e batch (nome, **matrice colori 7 × 3**, cancellazione di gruppo), **pannello "Nota Laterale Selezionata"** (unica textarea `TESTO DELLA NOTA`, selettore `Dimensione Testo` A-/A/A+ 9/11/14 px, campi `W cm` e `H cm` con clamp 70–300 / 40–400, palette pastello + bianco neutro, `Cancella Nota`) con pulsante di creazione a eredità automatica (content pre-popolato col nome del primo collo) e **footer compattato** con trigger `ⓘ Scorciatoie da tastiera` che apre su hover il **popover fluttuante scuro verso l'alto** (Guida Rapida Scorciatoie, 7 voci).
- `src/components/PrintReport.tsx`: Scheda di carico A4 (`#print-report`) per stampa / salvataggio PDF, con linea nominale 13,20 m, indicatori LDM vettoriali da `calculateLdmMetrics`, **note laterali ridisegnate nella loro corsia** (testo unico a coordinate relative `x = 10` cm, con `width`/`height`/`fontSize` scelti dall'operatore) e riga ufficiale `INGOMBRO LINEARE (LDM)` nella tabella riassuntiva.
- `src/index.css`: Tailwind v4 + regole `@page` / `@media print` della scheda di carico.
- `src/App.tsx`: Stato globale della stiva, della selezione multipla (`selectedItemIds`), della densità etichette (`labelDensity`) e delle **note laterali** (`notes`, `selectedNoteId`), scorciatoie tastiera (`Spazio`, `Canc` — che elimina la nota attiva quando non ci sono colli selezionati), rotazione su baricentro, **motore batch `handleAddBatch(pallet, quantity, orientation, name?, color?)`** (ciclo sincrono first-fit Cabina → Porte con un solo `setItems` atomico, unico motore di stiva dopo la fusione dell'Accordion Multifunzione — sezione W; il vecchio `handleExecuteSequence` è stato rimosso), `handleUpdateItemsPos` / `handleUpdateItemProperties`, `handleAddNote` / `handleUpdateNote` / `handleDeleteNote` / `handleUpdateNotePos` / **`handleUpdateNoteSize`** (ridimensionamento della card dalla maniglia, con `width` e `height` clampate); ogni collo nasce con `borderColor: ITEM_BORDER_COLOR` (bordo antracite rigido).
- `AGENTS.md`: File di contesto e direttive tassative per gli agent AI.

---

## 4. PROSSIMI PASSI (NEXT SPRINT ROADMAP)
1. **Modulo Multi-Pianale:** gestione contemporanea di più mezzi/rimorchi nella stessa sessione di carico (finestre di stiva indipendenti, riepilogo unificato e trasferimento colli tra pianali).
