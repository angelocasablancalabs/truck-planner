export interface VehicleConfig {
  id: string;
  name: string;
  width: number;  // in cm (es. 250)
  length: number; // in cm (es. 1328)
}

export interface PalletDefinition {
  code: string;
  name: string;
  width: number;  // cm
  length: number; // cm
  color: string;
  borderColor: string;
  rotatable: boolean;
  isBulk?: boolean;
}

export interface PlacedItem {
  id: string;
  code: string;
  name: string;
  width: number;   // larghezza attuale in cm
  length: number;  // lunghezza attuale in cm
  x: number;       // coordinata X in cm (da parete sinistra 0)
  y: number;       // coordinata Y in cm (da Cabina 0)
  rotation: number;// 0 o 90 gradi
  color: string;
  borderColor: string;
  label?: string;
}

/**
 * Aggiornamento di posizione di un collo (cm reali del pianale).
 * Usato sia dal drag singolo sia dal drag di gruppo, che invia più update
 * nello stesso frame per mantenere le posizioni relative del gruppo.
 */
export interface ItemPositionUpdate {
  id: string;
  x: number;
  y: number;
}

/**
 * Densità delle etichette stampate sopra ogni collo nel canvas:
 * - `all`:        nome cliente + quote (W × L) — comportamento storico.
 * - `client`:     solo il nome, centrato e più leggibile.
 * - `dimensions`: solo le quote, centrate.
 * - `minimal`:    nessun testo, solo il blocco geometrico colorato.
 */
export type LabelDensity = 'all' | 'client' | 'dimensions' | 'minimal';

/**
 * Nota laterale di carico (Side Annotation).
 *
 * Il disponente la posiziona **liberamente in 2D** attorno al pianale per
 * tramandare istruzioni operative e avvertenze (es. "bancali poco stabili, fare
 * attenzione durante il carico!"). Una nota può stare a destra del semirimorchio
 * (posizione di default), a sinistra di esso (`x < 0`), in coda o sopra il
 * pianale: l'inquadratura dello snapshot PNG e della scheda A4 si allarga da
 * sola per contenerla.
 *
 * A riposo la card **non ha alcun bordo** (puro testo fluttuante): il contorno
 * blu di selezione compare solo quando la nota è attiva.
 */
export interface SideNote {
  id: string;
  /** Posizione X in cm: 0 = parete sinistra, vehicle.width = parete destra.
   *  Può essere negativa (a sinistra del rimorchio) o oltre la parete destra. */
  x: number;
  /** Quota Y in cm lungo il camion (0 = Cabina, vehicle.length = Porte). */
  y: number;
  /** Testo unico della nota (multi-riga): nessun titolo separato. */
  content: string;
  /** Sfondo pastello della card (ereditato dal collo selezionato, o bianco). */
  color: string;
  /** Colore del bordo storico della card: non più disegnato a riposo (sezione
   *  "zero bordi"), resta come metadato per future evidenziazioni. */
  borderColor: string;
  /** Larghezza in cm (default 140, min 70, max 300). */
  width: number;
  /** Altezza esplicita in cm (se ridimensionata dalla maniglia, min 40). */
  height?: number;
  /** Dimensione del font in px (11, 14 o 18; default 14). */
  fontSize?: 11 | 14 | 18 | number;
}

/**
 * **STALLO (BAY)** — un singolo pianale della centrale multi-mezzo.
 *
 * La centrale può ospitare fino a **tre mezzi contemporanei** nello stesso
 * canvas e nello stesso file JSON: ogni stallo è un mondo a sé, con la propria
 * configurazione veicolo, la propria targa, i propri colli e le proprie note
 * laterali.
 *
 * Le coordinate di `items` e `notes` sono **locali allo stallo**
 * (`0 … vehicle.width`, `0 … vehicle.length`): la traslazione orizzontale che
 * li affianca nel canvas è pura presentazione e vive in `utils/bays.ts`, così
 * nessun dato salvato dipende dalla posizione dello stallo nella scena.
 */
export interface DeckBay {
  /** Identificativo univoco dello stallo (es. `bay-1`, `bay-2`, `bay-3`). */
  id: string;
  /** Configurazione indipendente del veicolo (preset di catalogo o custom). */
  vehicle: VehicleConfig;
  /** Targa / identificativo del mezzo (stringa vuota se non compilata). */
  plate: string;
  /** Colli stivati, con coordinate **locali** al pianale (cm reali). */
  items: PlacedItem[];
  /** Note laterali di carico, con coordinate **locali** al pianale. */
  notes: SideNote[];
}

/**
 * Fotogramma della cronologia Undo / Redo (snapshot engine).
 *
 * Contiene **tutto lo stato logico del piano di carico** — l'intera flotta di
 * stalli (mezzi, targhe, colli e note) più lo stallo attivo e la densità
 * etichette — cioè esattamente ciò che viene salvato nel file di progetto
 * (`ProjectFile`). Così ogni azione è realmente annullabile, compresa
 * l'**apertura di un piano salvato** e l'**aggiunta o l'eliminazione di un
 * mezzo**, che cambiano in un colpo solo l'intera scena: un `Ctrl / Cmd + Z`
 * riporta in scena il lavoro precedente senza residui.
 *
 * Selezione, zoom e pan restano invece stati di interfaccia e non entrano nella
 * cronologia. La flotta è sempre una **copia profonda**: uno snapshot non
 * condivide alcun riferimento con lo stato vivo, quindi non può essere corrotto
 * da mutazioni successive.
 */
export interface HistorySnapshot {
  /** Flotta completa degli stalli al momento del fotogramma. */
  bays: DeckBay[];
  /** Stallo attivo (il mezzo comandato da sidebar e ispettore). */
  activeBayId: string;
  /** Densità etichette attiva al momento del fotogramma. */
  labelDensity: LabelDensity;
}

/**
 * Struttura ufficiale del file di progetto (`.json`) — **schema v2**.
 *
 * È il formato di **salvataggio, backup, ripristino e condivisione** di un
 * lavoro completo: contiene l'intera centrale multi-pianale — fino a tre stalli,
 * ciascuno con mezzo, targa, colli e note laterali — più lo stallo attivo e la
 * densità etichette, e nulla di effimero (selezione, zoom e pan restano stati di
 * interfaccia e non vengono esportati).
 *
 * `version` e `app` sono la firma del formato: permettono di riconoscere un file
 * di Truck Planner e di gestirne l'evoluzione senza ambiguità. I file **v1**
 * (a pianale singolo) restano apribili: `utils/fileStorage.ts` li riconosce e li
 * migra al volo in un unico stallo.
 */
export interface ProjectFile {
  /** Versione dello schema del file: `2` dalla centrale multi-pianale. */
  version: 2;
  /** Firma dell'applicazione che ha prodotto il file. */
  app: 'truck-planner';
  /** Data e ora ISO 8601 del salvataggio. */
  timestamp: string;
  /** Flotta degli stalli (da 1 a 3), nell'ordine di affiancamento a schermo. */
  bays: DeckBay[];
  /** Stallo attivo al momento del salvataggio (opzionale: default al primo). */
  activeBayId?: string;
  /** Densità delle etichette attiva al momento del salvataggio. */
  labelDensity: LabelDensity;
  /* --- Campi dello schema v1: solo in lettura, per l'auto-migrazione --------- */
  /** @deprecated Schema v1 — migrato in `bays[0].vehicle`. */
  vehicle?: VehicleConfig;
  /** @deprecated Schema v1 — migrato in `bays[0].plate`. */
  plate?: string;
  /** @deprecated Schema v1 — migrato in `bays[0].items`. */
  items?: PlacedItem[];
  /** @deprecated Schema v1 — migrato in `bays[0].notes`. */
  notes?: SideNote[];
}

/** Variante di caricamento scelta in console (Punta / Piatto / Sfuso). */
export interface AddItemOptions {
  /** Larghezza imposta in cm (es. 100 per Punta, 120 per Piatto). */
  width?: number;
  /** Lunghezza imposta in cm (es. 120 per Punta, 100 per Piatto). */
  length?: number;
  /** Rotazione iniziale in gradi: 0 = Punta (lato corto verso le porte), 90 = Piatto. */
  rotation?: number;
  /** Nome / cliente personalizzato (usato dai colli "Formato Libero / Fuori Sagoma"). */
  name?: string;
}
