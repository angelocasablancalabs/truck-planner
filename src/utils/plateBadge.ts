/* -------------------------------------------------------------------------- *
 *  BADGE TARGA / IDENTIFICATIVO MEZZO (SPRINT J)
 *
 *  Un piano di carico deve riportare l'identificativo esatto del mezzo o la
 *  targa del semirimorchio, spesso accompagnata da diciture logistiche di
 *  piazzale (es. `XA000BB COME ARRIVA`, `XZ111AQ COME PARTE`).
 *
 *  La card tecnica in stile targa vive **sopra la scritta ▲ CABINA ▲**, nella
 *  fascia `-48 … -28 cm` del mondo vettoriale, ed è ridisegnata identica nelle
 *  tre rese dell'applicazione: canvas a schermo, snapshot PNG e scheda A4.
 *  Questo modulo è l'unica fonte di verità della sua geometria, così le tre
 *  rese non possono divergere (stesso principio di `utils/labels.ts`,
 *  `utils/sideNotes.ts` e `calculateLdmMetrics`).
 * -------------------------------------------------------------------------- */

/** ID del campo di testo della sidebar: il click sul badge vi porta il focus. */
export const PLATE_INPUT_ID = 'vehicle-plate-input';

/** Quota Y (cm) del bordo SUPERIORE della card: subito sopra `▲ CABINA ▲`. */
export const PLATE_BADGE_TOP_CM = -48;

/** Altezza (cm) della card: la fascia occupata è `-48 … -28 cm`. */
export const PLATE_BADGE_HEIGHT_CM = 20;

/** Quota Y (cm) del bordo inferiore della card (angolo arrotondato). */
export const PLATE_BADGE_BOTTOM_CM = PLATE_BADGE_TOP_CM + PLATE_BADGE_HEIGHT_CM;

/** Larghezza minima (cm) della card, anche con identificativi molto corti. */
export const PLATE_BADGE_MIN_WIDTH_CM = 130;

/** Larghezza (cm) riservata a ogni carattere dell'identificativo. */
export const PLATE_BADGE_CHAR_WIDTH_CM = 7.5;

/** Stacco (cm) della card dalle due pareti laterali del pianale. */
export const PLATE_BADGE_SIDE_GAP_CM = 20;

/** Corpo massimo del testo della targa (cm del mondo vettoriale = px a zoom 1). */
export const PLATE_BADGE_MAX_FONT_SIZE_CM = 10;

/** Larghezza media stimata di un glifo monospaziato, in em. */
const PLATE_BADGE_CHAR_RATIO = 0.6;

/** Testo segnaposto mostrato quando nessuna targa è stata digitata. */
export const PLATE_BADGE_PLACEHOLDER = '[ TARGA / IDENTIFICATIVO ]';

/** Geometria e stile della card, condivisi dalle tre rese. */
export const PLATE_BADGE_FILL = '#F8FAFC';
export const PLATE_BADGE_BORDER_COLOR = '#334155';
export const PLATE_BADGE_BORDER_WIDTH = 1.5;
export const PLATE_BADGE_BORDER_DASH = '5 4';
export const PLATE_BADGE_CORNER_RADIUS_CM = 3;
export const PLATE_BADGE_TEXT_COLOR = '#0F172A';
export const PLATE_BADGE_PLACEHOLDER_COLOR = '#94A3B8';
export const PLATE_BADGE_FONT_FAMILY = 'SFMono-Regular, Menlo, Consolas, monospace';

/* --- Fascia di intestazione sopra la Cabina -------------------------------- */

/**
 * Quota (cm) della didascalia `▲ CABINA ▲`: con il badge targa che occupa la
 * fascia `-48 … -28 cm`, la scritta e la quota larghezza scendono di
 * conseguenza e restano leggibili senza sovrapporsi alla card.
 */
export const CABINA_CAPTION_BASELINE_CM = -15;

/** Quota (cm) della quota larghezza utile, appena sopra la parete di Cabina. */
export const WIDTH_QUOTA_BASELINE_CM = -4.5;

/** Contenuto testuale risolto del badge. */
export interface PlateBadgeLabel {
  /** Testo da stampare (maiuscolo; segnaposto se la targa è vuota). */
  label: string;
  /** `true` se l'operatore ha digitato un identificativo reale. */
  hasPlate: boolean;
}

/** Normalizza la targa digitata: maiuscolo, senza spazi ai bordi. */
export const resolvePlateLabel = (plate: string): PlateBadgeLabel => {
  const trimmed = plate.trim();
  return trimmed.length > 0
    ? { label: trimmed.toUpperCase(), hasPlate: true }
    : { label: PLATE_BADGE_PLACEHOLDER, hasPlate: false };
};

/** Geometria completa della card targa in centimetri reali del pianale. */
export interface PlateBadgeLayout {
  /** Ascissa (cm) del bordo sinistro: card centrata sul pianale. */
  x: number;
  /** Quota (cm) del bordo superiore. */
  top: number;
  /** Larghezza (cm) della card. */
  width: number;
  /** Altezza (cm) della card. */
  height: number;
  /** Ascissa (cm) del centro: ancora di testo `text-anchor="middle"`. */
  centerX: number;
  /** Quota (cm) della mezzeria verticale della card. */
  centerY: number;
  /** Corpo del testo (cm): ridotto solo per identificativi molto lunghi. */
  fontSize: number;
  /** Contenuto testuale risolto. */
  label: string;
  /** `true` se è stata digitata una targa vera (bordo continuo). */
  hasPlate: boolean;
}

/**
 * Geometria della card targa per un dato mezzo.
 *
 * - **Larghezza dinamica:** `min(vehicle.width - 20, max(130, caratteri × 7,5))`,
 *   quindi la card cresce con la lunghezza dell'identificativo restando sempre
 *   dentro le pareti del mezzo.
 * - **Centratura:** la card è centrata sull'asse di mezzeria del pianale e vive
 *   nella fascia `-48 … -28 cm`, sopra la didascalia `▲ CABINA ▲`.
 * - **Corpo testo:** il massimo è 10 px; su targhe molto lunghe viene ridotto
 *   quel tanto che basta perché il testo non esca mai dal rettangolo.
 *
 * @param vehicleWidth Larghezza utile del mezzo in cm
 * @param plate        Targa / identificativo digitato (può essere vuoto)
 */
export const plateBadgeLayout = (vehicleWidth: number, plate: string): PlateBadgeLayout => {
  const { label, hasPlate } = resolvePlateLabel(plate);
  const charCount = Math.max(1, label.length);

  // Stessa formula del capitolato: mai più larga del pianale (meno 20 cm),
  // mai più stretta di 130 cm, proporzionale al numero di caratteri.
  const width = Math.max(
    40,
    Math.min(
      vehicleWidth - PLATE_BADGE_SIDE_GAP_CM,
      Math.max(PLATE_BADGE_MIN_WIDTH_CM, charCount * PLATE_BADGE_CHAR_WIDTH_CM)
    )
  );

  // Il corpo resta a 10 px finché il testo ci sta: 8 cm di respiro interno.
  const fontSize = Math.max(
    5,
    Math.min(
      PLATE_BADGE_MAX_FONT_SIZE_CM,
      (width - 8) / (charCount * PLATE_BADGE_CHAR_RATIO)
    )
  );

  return {
    x: (vehicleWidth - width) / 2,
    top: PLATE_BADGE_TOP_CM,
    width,
    height: PLATE_BADGE_HEIGHT_CM,
    centerX: vehicleWidth / 2,
    centerY: PLATE_BADGE_TOP_CM + PLATE_BADGE_HEIGHT_CM / 2,
    fontSize,
    label,
    hasPlate,
  };
};
