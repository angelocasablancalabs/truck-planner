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
- **Motore Zoom & Pan Fluido:**
  - Range di zoom da 60% a 400% con rotellina del mouse (listener nativo non passivo `{ passive: false }` ancorato al puntatore del mouse).
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

---

## 3. MAPPA ARCHITETTURALE DEI FILE
- `src/types.ts`: Tipi TypeScript (`VehicleConfig`, `PalletDefinition`, `PlacedItem`, `AddItemOptions`).
- `src/constants.ts`: Presets veicoli e catalogo colli.
- `src/utils/snapping.ts`: Modulo matematico puro (`calculateSnapPosition`, `isRectColliding`, `isOutOfBounds`, `findSmartSpawnPosition`).
- `src/components/TruckCanvas.tsx`: Render SVG fullscreen, gestione Zoom/Pan anchored, eventi puntatore e segnalazione allarmi.
- `src/components/ControlDeck.tsx`: Plancia di comando, righe dense colli, selettore adattivo, gestione rimozione sicura.
- `src/App.tsx`: Stato globale della stiva, scorciatoie tastiera (`Spazio`, `Canc`), rotazione su baricentro.
- `AGENTS.md`: File di contesto e direttive tassative per gli agent AI.

---

## 4. PROSSIMI PASSI (NEXT SPRINT ROADMAP)
1. **Formato Libero / Collo Fuori Sagoma:** Box nella sidebar per generare colli con dimensioni personalizzate arbitrarie ($W \times L$) e nome personalizzato.
2. **Selezione Multipla (`Ctrl + Click` o Rettangolo Lasso):** Selezione simultanea di più colli per spostamenti di gruppo o cancellazione multipla.
3. **Modulo "Stiva Sequenza" (Multi-Tappa / Batch):** Griglia di inserimento progressivo per tappe di viaggio con caricamento ordinato da Cabina a Porte.
4. **Condivisione & Output:** Pulsanti "Copia Immagine" negli appunti (PNG) per WhatsApp/Email e "Salva PDF" report di carico.