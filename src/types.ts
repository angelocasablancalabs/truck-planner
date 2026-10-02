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
 * Fotogramma della cronologia Undo / Redo (snapshot engine).
 *
 * Contiene **tutto lo stato logico del piano di carico** — colli, note laterali,
 * configurazione del mezzo, targa e densità etichette — cioè esattamente ciò che
 * viene salvato nel file di progetto (`ProjectFile`). Così ogni azione è
 * realmente annullabile, compresa l'**apertura di un piano salvato**, che cambia
 * in un colpo solo mezzo, targa, colli, note e densità: un `Ctrl / Cmd + Z`
 * riporta in scena il lavoro precedente senza residui.
 *
 * Selezione, zoom e pan restano invece stati di interfaccia e non entrano nella
 * cronologia. I due elenchi sono sempre **copie profonde**: uno snapshot non
 * condivide alcun riferimento con lo stato vivo, quindi non può essere corrotto
 * da mutazioni successive.
 */
export interface HistorySnapshot {
  items: PlacedItem[];
  notes: SideNote[];
  /** Configurazione del mezzo al momento del fotogramma. */
  vehicle: VehicleConfig;
  /** Targa / identificativo del mezzo al momento del fotogramma. */
  plate: string;
  /** Densità etichette attiva al momento del fotogramma. */
  labelDensity: LabelDensity;
}

/**
 * Struttura ufficiale del file di progetto (`.json`).
 *
 * È il formato di **salvataggio, backup, ripristino e condivisione** di un
 * lavoro completo: contiene l'intero stato logico del piano di carico — mezzo,
 * targa, colli, note laterali e densità etichette — e nulla di effimero
 * (selezione, zoom e pan restano stati di interfaccia e non vengono esportati).
 *
 * `version` e `app` sono la firma del formato: permettono di riconoscere un
 * file di Truck Planner e di gestirne in futuro l'evoluzione senza ambiguità.
 */
export interface ProjectFile {
  /** Versione dello schema del file (attualmente l'unica: `1`). */
  version: 1;
  /** Firma dell'applicazione che ha prodotto il file. */
  app: 'truck-planner';
  /** Data e ora ISO 8601 del salvataggio. */
  timestamp: string;
  /** Configurazione del mezzo (preset o dimensioni personalizzate). */
  vehicle: VehicleConfig;
  /** Targa / identificativo del mezzo (stringa vuota se non compilata). */
  plate: string;
  /** Colli posizionati sul pianale, con coordinate e tinte. */
  items: PlacedItem[];
  /** Note laterali di carico posizionate in 2D attorno al pianale. */
  notes: SideNote[];
  /** Densità delle etichette attiva al momento del salvataggio. */
  labelDensity: LabelDensity;
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
