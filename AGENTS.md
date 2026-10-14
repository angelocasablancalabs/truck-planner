# AGENTS.md — TRUCK PLANNER 2D

## 1. MISSIONE DEL PROGETTO
`truck-planner` è una web app desktop-first ad alta precisione millimetrica per la pianificazione e l'ottimizzazione grafica del carico (stiva) su semirimorchi e motrici (prevalentemente frigorifere).
Sostituisce definitivamente i vecchi layout Excel a celle unite, operando su un piano cartesiano continuo 2D vettoriale.

---

## 2. STACK TECNOLOGICO TASSATIVO (ANTI-OBSOLESCENZA)
- **Framework & Runtime:** React 19 + TypeScript + Vite.
- **Styling:** Tailwind CSS v4 (utilizzare la sintassi moderna `@import "tailwindcss";`, no vecchi file di configurazione deprecati).
- **Icone:** `lucide-react`.
- **Motore Grafico:** **SVG Vettoriale Nativo**. Niente librerie pesanti o deprecate. Coordinate reali espresse in **centimetri (cm)** come numeri continui.
- **Regole TypeScript Rigide:** 
  - Usare SEMPRE `import type { ... } from './types'` quando si importano interfacce o tipi (onde evitare errori di runtime di tipo SyntaxError con Vite).
  - Codice tipizzato rigorosamente (`strict: true`).

---

## 3. DOMINIO LOGISTICO & REGOLE MATEMATICHE

### Orientamento del Pianale
- Il pianale è orientato **esclusivamente in verticale**:
  - `Y = 0` (in alto): **CABINA**
  - `Y = Lunghezza Veicolo` (in basso): **PORTE POSTERIORI**
  - `X = 0` (a sinistra): Parete sinistra
  - `X = Larghezza Veicolo` (a destra): Parete destra

### Preset Veicoli Principali
1. `bilico_cc`: Bilico CC Fiori — Larghezza **250 cm** × Lunghezza **1328 cm** (13,28 m). *(preset di default di ogni nuovo stallo)*
2. `bilico_std`: Bilico Frigo — Larghezza **245 cm** × Lunghezza **1328 cm** (13,28 m).
3. `motrice_3a`: Motrice 3 Assi — Larghezza **250 cm** × Lunghezza **760 cm** (7,60 m).
4. `custom`: Dimensioni libere fornite dall'utente.

### Catalogo Colli Ufficiale
Tutti i colli operano in centimetri reali $(W \times L)$ e sono ruotabili di $90^\circ$ (invertendo $W$ ed $L$), eccetto lo Sfuso:
1. `PLT INDU`: $100 \times 120\text{ cm}$
2. `PLT EUR`: $80 \times 120\text{ cm}$
3. `PLT ½ EUR`: $80 \times 60\text{ cm}$
4. `CC` (Carrello Olandese per piante): $56{,}5 \times 135\text{ cm}$
5. `EC` (Carrello metallico industriale): $61 \times 81\text{ cm}$ (Nota: con 250 cm di larghezza, entrano 4 EC per fila se ruotati sul lato da 61 cm!).
6. `SFUSO`: Collo che occupa l'intera larghezza utile del mezzo ($W = \text{vehicle.width}$) e richiede solo la lunghezza in metri lineari ($L$). Non è ruotabile.
7. `CUSTOM`: Collo fuori sagoma a dimensioni arbitrarie.

---

## 4. ARCHITETTURA MODULARE & PREDISPOSIZIONI FUTURE
- **Modalità Attiva:** `PIANALE` (Focus attuale al 100%), in versione **centrale multi-pianale** (fino a 3 mezzi, vedi §4-bis).
- **Predisposizione Futura:** `GANCIERA` (Carne fresca appesa su 5 o 6 binari al tetto con logica LIFO e bilanciamento baricentro).
  - *Regola per l'Agent:* Non implementare la ganciera adesso, ma mantenere i componenti del pianale isolati (es. dentro cartelle o componenti modulari) per consentire l'inserimento futuro di un selettore di modalità senza dover rifattorizzare il core.

---

## 4-bis. CENTRALE MULTI-PIANALE (FINO A 3 MEZZI)

### Modello dati
- **`DeckBay` (`src/types.ts`)** — lo **stallo**: `{ id, vehicle, plate, items, notes }`. È l'unità di lavoro della centrale: ogni mezzo ha mezzo, targa, colli e note **propri**, su **coordinate locali** (`0…width`, `0…length`). La posizione dello stallo nella scena **non è mai un dato salvato**.
- **`HistorySnapshot`** = `{ bays, activeBayId, labelDensity }`: Undo/Redo copre l'intera flotta (aggiunta ed eliminazione di un mezzo sono passi pieni).
- **`ProjectFile` — schema `version: 2`**: `{ version: 2, app, timestamp, bays, activeBayId, labelDensity }`. I file **v1** (pianale singolo) restano apribili: `utils/fileStorage.ts` li riconosce e li **migra al volo** in un unico stallo `bay-1`.

### Dove vive cosa
| Responsabilità | File |
| --- | --- |
| Stato flotta, `activeBayId`, getter del mezzo attivo, `updateActiveBay` / `updateActiveItems` / `updateActiveNotes`, `handleAddBay` / `handleDeleteBay` | `src/App.tsx` |
| Geometria degli stalli: `BAY_SPACING_CM` (180 cm), `bayOffsets`, `nextBayOffset`, geometria dell'header, `MAX_BAYS` | `src/utils/bays.ts` |
| Fabbrica dello stallo di default (`createDefaultBay`) e `MAX_BAYS` | `src/constants.ts` |
| Canvas affiancato + header di stallo (pillola pulita, senza "X") | `src/components/TruckCanvas.tsx` |
| Pillole del Mezzo Attivo + Totale Flotta + comando `Elimina` + orientamento di stampa | `src/components/ControlDeck.tsx` |
| Una pagina A4 per mezzo + foglio unico di flotta (verticale con 1–2 mezzi, panoramico con 3) | `src/components/PrintReport.tsx`, `src/utils/export.ts` (`getFleetExtent`, `buildFleetSvg`) |

### Regole non negoziabili
1. **Coordinate locali:** colli e note di uno stallo vivono sempre in `0…width` / `0…length`. La traslazione che li affianca è **solo presentazione** (`bayOffsets`) e non deve mai entrare nei dati salvati.
2. **Una sola porta d'ingresso:** ogni mutazione della stiva passa da `updateActiveBay` / `updateActiveItems` / `updateActiveNotes` — mai `setBays` sparso nei gestori.
3. **Getter del mezzo attivo:** `resolveActiveBay(bays, activeBayId)` con fallback al primo stallo, così l'app non resta mai senza bersaglio dopo un Undo o l'apertura di un file.
4. **Limiti:** massimo `MAX_BAYS = 3` mezzi; l'ultimo stallo rimasto non è mai eliminabile e l'eliminazione di uno stallo con carico chiede conferma (`window.confirm`).
5. **Separazione degli spazi:** lo stacco `BAY_SPACING_CM = 180` cm accoglie righello metrico e badge LDM senza collisioni; l'header di stallo resta entro `BAY_HEADER_WIDTH_CM` per non invadere il pianale successivo.
6. **Stampa a due modalità:** `clean` = un unico foglio con tutti i pianali affiancati — **A4 verticale** con 1 o 2 mezzi, **A4 panoramico** con 3 (`bays.length >= 3`); `full` = **A4 verticale**, una pagina per mezzo più la pagina di servizio `TOTALE FLOTTA`. L'orientamento è deciso da `ControlDeck.triggerPrint`, che inietta la regola `@page` in `<head>` durante la stampa e — solo in orizzontale — marca `<html>` con `data-print-landscape="true"` (il CSS adatta `.print-clean-sheet`): in CSS `@page` non ammette selettori di modalità. Entrambi gli attributi e il foglio temporaneo sono rimossi all'`afterprint`.
7. **Nessun comando distruttivo sul canvas:** l'header di stallo è una pillola cliccabile (`MEZZO n` + badge `ATTIVO`) e **non** porta alcuna icona "X" / cestino; l'eliminazione di un mezzo passa solo dal pulsante `Elimina` della sidebar (`#btn-delete-bay`).

### Verifica automatica
`node scripts/verify-multi-bay.mjs http://localhost:5199/truck-planner/` (con il dev server attivo) copre affiancamento, limite di flotta, pillole, totale flotta, salvataggio v2, migrazione v1, eliminazione con conferma, l'assenza di ogni icona "X" sul canvas, la geometria dell'header di stallo e le due stampe con l'orientamento misurato sotto emulazione di stampa (verticale con 1–2 mezzi, panoramico con 3).

---

## 5. REQUISITI FUNZIONALI ATTUALI (ROADMAP OPERATIVA)

### Step 1: Canvas Base & Interattività (COMPLETATO)
- Rendering SVG del camion con quote metriche, Cabina e Porte.
- Aggiunta colli con click rapido o input sfuso.
- Trascina colli con pointer events.
- Rotazione rapida 90° con tasto Spazio o icona.
- Cancellazione con tasto `Canc` o icona cestino.

### Step 2: Precisione, Snapping Magnetico & Selezione (IN CORSO)
- **Snap Magnetico:** Quando un collo viene trascinato entro 5 cm dalla parete del camion o dal bordo di un collo adiacente, deve agganciarsi magneticamente a filo.
- **Rilevamento Collisioni:** Segnalazione visiva (bordo rosso/arancio) se due colli si sovrappongono o se escono dalla sagoma utile del camion.
- **Selezione Multipla:** Supporto per `Ctrl + Click` per selezionare più colli contemporaneamente e spostarli o cancellarli assieme.

### Step 3: Input Sequenziale a Lotti (Multi-Tappa)
- Form per inserimento rapido a righe (es. `4 INDU [Cliente A]` + `3 EUR [Cliente B]`).
- Motore di stiva automatica progressivo (dalla cabina verso le porte).

### Step 4: Condivisione & Output
- Pulsante per copiare negli appunti di sistema lo screenshot PNG ad alta risoluzione del pianale (per WhatsApp / Mail).
- Esportazione report di carico in PDF pulito.

---

## 6. LINEE GUIDA OPERATIVE PER GLI AGENTS
1. **Modifiche Mirate:** Non riscrivere interi file se basta modificare poche righe. Rispetta la struttura esistente.
2. **Nessun Regression Bug:** Prima di completare un task, assicurarsi che il server Vite non segnali errori di compilazione TypeScript.
3. **Design Sober & CAD-like:** Rispettare lo stile grafico minimale (sfondo bianco/grigio tenue, linee 1px nette, colori pastello ad alto contrasto per i colli, niente ombre superflue o 3D).