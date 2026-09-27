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
