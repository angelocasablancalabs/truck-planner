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
 * Riga del modulo "Stiva Sequenza" (multi-tappa): descrive un lotto di colli
 * da stivare progressivamente dalla Cabina verso le Porte posteriori.
 *
 * Non esiste un `borderColor` di riga: il contorno dei colli è un invariante
 * globale (`ITEM_BORDER_COLOR`, grigio antracite `#334155`) e la tinta scelta
 * qui colora esclusivamente il riempimento del collo.
 */
export interface SequenceBatchItem {
  id: string;
  quantity: number;
  palletCode: string; // 'INDU' | 'EUR' | 'HALF_EUR' | 'CC' | 'EC'
  orientation: 'piatto' | 'punta';
  clientName: string;
  color: string;
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
