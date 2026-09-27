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
1. `bilico_cc`: Bilico CC / Olandese — Larghezza **250 cm** × Lunghezza **1328 cm** (13,28 m).
2. `bilico_std`: Bilico Frigo Standard — Larghezza **245 cm** × Lunghezza **1328 cm** (13,28 m).
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
- **Modalità Attiva:** `PIANALE` (Focus attuale al 100%).
- **Predisposizione Futura:** `GANCIERA` (Carne fresca appesa su 5 o 6 binari al tetto con logica LIFO e bilanciamento baricentro).
  - *Regola per l'Agent:* Non implementare la ganciera adesso, ma mantenere i componenti del pianale isolati (es. dentro cartelle o componenti modulari) per consentire l'inserimento futuro di un selettore di modalità senza dover rifattorizzare il core.

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