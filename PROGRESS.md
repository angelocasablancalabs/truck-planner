# PROGRESS.MD — TRUCK PLANNER 2D

## 1. PANORAMICA DEL PROGETTO
- **Applicazione:** `truck-planner` (Piattaforma vettoriale interattiva per la pianificazione e stiva merci 2D su semirimorchi e motrici refrigerate).
- **Stack Tecnologico:** Vite + React 19 + TypeScript (regola rigida `import type`) + Tailwind CSS v4 + Lucide React + Motore grafico SVG Vettoriale Nativo.
- **Sistema di Riferimento:** Coordinate cartesiane continue espresse in centimetri reali $(W, L)$.
  - $Y = 0$ (Alto): **▲ [ CABINA ] ▲**
  - $Y = \text{vehicle.length}$ (Basso): **▼ [ PORTE POSTERIORI ] ▼** (linea tratteggiata)
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
  - `bilico_std`: **Bilico frigo Standard** ($2{,}46 \times 13{,}60\text{ m}$)
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
- **Callback di stato:** `handleUpdateItemProperties(id, updates: Partial<PlacedItem>)` in `App.tsx`, patch immutabile passata a `ControlDeck` (aggiorna `color` e `borderColor` sul collo selezionato).

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
  - **Pallino colore** cliccabile: cicla i 7 colori pastello, assegnati **a rotazione automatica** ad ogni nuova riga (tappe distinguibili a vista).
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

---

## 3. MAPPA ARCHITETTURALE DEI FILE
- `src/types.ts`: Tipi TypeScript (`VehicleConfig`, `PalletDefinition`, `PlacedItem`, `ItemPositionUpdate`, `AddItemOptions`, `LabelDensity`, `SequenceBatchItem`).
- `src/constants.ts`: Presets veicoli, catalogo colli e definizione `CUSTOM_PALLET` (fuori sagoma).
- `src/utils/snapping.ts`: Modulo matematico puro (`calculateSnapPosition`, `isRectColliding`, `isOutOfBounds`, `findSmartSpawnPosition`).
- `src/utils/export.ts`: Snapshot PNG pulito del pianale (`getPianoExtent`, `buildPianoSvg`, `rasterizeSnapshotToPng`, `copyCanvasToClipboard`) con copia negli appunti e fallback download.
- `src/components/TruckCanvas.tsx`: Render SVG fullscreen, Zoom/Pan da rotellina, selezione multipla (Cmd/Ctrl+Click, lasso Shift+Drag), drag di gruppo, eventi puntatore, segnalazione allarmi, HUD densità etichette (`LabelDensity`).
- `src/components/ControlDeck.tsx`: Plancia di comando con barra comandi rapida (`Copia Immagine` / `Stampa / PDF`), selettore a schede (`📦 Carico Diretto` / `⚡ Stiva Sequenza`), righe dense colli, selettore adattivo, box Formato Libero / Fuori Sagoma, generatore sequenziale a lotti/tappe, pannello selezione singola e batch (nome, palette, cancellazione di gruppo).
- `src/components/PrintReport.tsx`: Scheda di carico A4 (`#print-report`) per stampa / salvataggio PDF.
- `src/index.css`: Tailwind v4 + regole `@page` / `@media print` della scheda di carico.
- `src/App.tsx`: Stato globale della stiva, della selezione multipla (`selectedItemIds`) e della densità etichette (`labelDensity`), scorciatoie tastiera (`Spazio`, `Canc`), rotazione su baricentro, motore di stiva sequenziale (`handleExecuteSequence`), `handleUpdateItemsPos` / `handleUpdateItemProperties`.
- `AGENTS.md`: File di contesto e direttive tassative per gli agent AI.

---

## 4. PROSSIMI PASSI (NEXT SPRINT ROADMAP)
1. **Modulo Multi-Pianale:** gestione contemporanea di più mezzi/rimorchi nella stessa sessione di carico (finestre di stiva indipendenti, riepilogo unificato e trasferimento colli tra pianali).
