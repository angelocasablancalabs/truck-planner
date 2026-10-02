/* -------------------------------------------------------------------------- *
 *  BADGE TARGA / IDENTIFICATIVO MEZZO (SPRINT J → SPRINT J-quater)
 *
 *  Un piano di carico deve riportare l'identificativo esatto del mezzo o la
 *  targa del semirimorchio, spesso accompagnata da diciture logistiche di
 *  piazzale (es. `XA000BB COME ARRIVA`, `XZ111AQ COME PARTE`).
 *
 *  Il badge vive **sopra la didascalia `▲ CABINA ▲`** ed è ridisegnato identico
 *  nelle tre rese dell'applicazione: canvas a schermo, snapshot PNG e scheda A4.
 *  Questo modulo è l'unica fonte di verità della sua geometria, così le tre rese
 *  non possono divergere (stesso principio di `utils/labels.ts`,
 *  `utils/sideNotes.ts` e `calculateLdmMetrics`).
 *
 *  SPRINT J-bis — GERARCHIA VISIVA E SILENZIO A RIPOSO:
 *  - **Silente a vuoto:** con la targa vuota (o di soli spazi) la funzione
 *    restituisce `null`: nessun rettangolo, nessun tratteggio e nessun testo
 *    segnaposto vengono disegnati da nessuna delle tre rese. L'area sopra la
 *    Cabina resta completamente pulita e trasparente.
 *  - **Zero bordo (less is more):** quando la targa c'è, resta **solo il testo**
 *    monospaziato tecnico in `#0F172A`, senza alcun contorno.
 *  - **Gerarchia tipografica:** il corpo base è **30 px** (sezione AB), il
 *    doppio dei 15 px di `▲ CABINA ▲`.
 *
 *  SPRINT J-quater — LARGHEZZA ESTESA FUORI SPONDA:
 *  - La targa non è più vincolata alla larghezza del pianale: la fascia di
 *    scrittura arriva a **`vehicle.width + 100` cm** (≈ 350 cm sul bilico CC,
 *    cioè 50 cm di sforo per lato), quindi una dicitura logistica reale come
 *    `XA111NJ COME ARRIVA` (19 caratteri) conserva un corpo di **~26,7 px**
 *    invece di crollare a ~17 px dentro i 210 cm utili.
 *  - Il modulo espone anche l'**ingombro orizzontale reale del testo**
 *    (`textWidthCm`, `leftX`, `rightX`): `export.ts` e la scheda A4 lo usano
 *    per allargare il `viewBox`, così la scritta estesa non viene mai tagliata
 *    né nel PNG a 2400 px né in stampa PDF.
 * -------------------------------------------------------------------------- */

/** ID del campo di testo della sidebar: il click sul badge vi porta il focus. */
export const PLATE_INPUT_ID = 'vehicle-plate-input';

/**
 * Lunghezza massima (caratteri) della targa / identificativo mezzo: è il tetto
 * condiviso dal campo di testo della sidebar e dalla convalida dei file di
 * progetto (`utils/fileStorage.ts`), così un piano ripristinato non può portare
 * in scena una targa più lunga di quella digitabile a mano.
 */
export const PLATE_MAX_LENGTH = 40;

/**
 * Sforo massimo (cm) della targa **oltre le sponde laterali** del mezzo: la
 * fascia di scrittura può estendersi fino a `vehicle.width + 100` cm (≈ 350 cm
 * sul bilico CC) — cioè 50 cm per lato — senza essere tagliata dalle pareti.
 */
export const PLATE_MAX_OVERHANG_CM = 100;

/**
 * Margine (cm) di sicurezza del testo entro la larghezza massima estesa: la
 * fascia utile è `vehicle.width + PLATE_MAX_OVERHANG_CM − 20` cm.
 */
export const PLATE_BADGE_TEXT_INSET_CM = 20;

/**
 * Margine (cm) aggiunto all'ingombro reale del testo quando si calcola
 * l'inquadratura di export e di stampa: la scritta estesa resta sempre dentro
 * la cornice con un filo d'aria per lato.
 */
export const PLATE_BADGE_EXTENT_MARGIN_CM = 15;

/**
 * Corpo base del testo della targa: **30 px**, esattamente il **doppio** dei
 * 15 px di `▲ CABINA ▲`: la targa è il gradino più alto della gerarchia visiva
 * dell'intestazione.
 */
export const PLATE_BADGE_FONT_SIZE = 30;

/** Corpo minimo (px) del testo: si raggiunge solo con la targa a 40 caratteri. */
export const PLATE_BADGE_MIN_FONT_SIZE = 5;

/**
 * Spaziatura tra i caratteri (em) del testo della targa: rende l'identificativo
 * più leggibile in stile targa e **rientra** nel calcolo del corpo, così la
 * scritta non può mai superare la larghezza utile del semirimorchio.
 */
export const PLATE_BADGE_LETTER_SPACING_EM = 0.05;

/** Larghezza media stimata di un glifo monospaziato, in em. */
const PLATE_BADGE_CHAR_RATIO = 0.6;

/**
 * Avanzamento medio (em) di un carattere, **spaziatura inclusa**: è il
 * coefficiente unico con cui si passa dal corpo del testo al suo ingombro
 * orizzontale in cm (`larghezza = caratteri × corpo × 0.65`). Lo usano la scala
 * del corpo qui sotto, `export.ts` e la scheda A4 per inquadrare la targa
 * estesa: una sola fonte di verità, nessuna divergenza possibile.
 */
export const PLATE_BADGE_CHAR_ADVANCE_EM =
  PLATE_BADGE_CHAR_RATIO + PLATE_BADGE_LETTER_SPACING_EM;

/**
 * Ingombro reale del riquadro di testo (em), **misurato** sul rendering di
 * Chrome con `dominant-baseline: middle` e font monospaziato di sistema:
 * il glifo sale di ~`0.72 em` sopra la mezzeria e scende di ~`0.27 em` sotto.
 * Le stesse proporzioni valgono per la didascalia `▲ CABINA ▲`, quindi due soli
 * coefficienti descrivono tutto il blocco di intestazione.
 */
const PLATE_BADGE_TEXT_ASCENT_EM = 0.72;
const PLATE_BADGE_TEXT_DESCENT_EM = 0.27;

/** Colore del testo della targa (slate-900, alto contrasto in stampa). */
export const PLATE_BADGE_TEXT_COLOR = '#0F172A';

/** Font monospaziato tecnico, coerente con le quote del pianale. */
export const PLATE_BADGE_FONT_FAMILY = 'SFMono-Regular, Menlo, Consolas, monospace';

/* --- Fascia di intestazione sopra la Cabina -------------------------------- */
/*
 * Con il corpo a **30 px** il glifo della targa è alto ~30 cm reali: la vecchia
 * fascia `-48 … -28 cm`, dimensionata su un corpo da 18 px, non basta più.
 * L'intero blocco di intestazione sale quindi di ~25 cm e le tre quote sono
 * **derivate a catena**, così crescere ancora il corpo non può far sovrapporre
 * la scritta alla didascalia `▲ CABINA ▲` né tantomeno tagliarla.
 */

/**
 * Stacco (cm) tra il fondo del glifo della targa e l'inizio di `▲ CABINA ▲`.
 * Vale ~5 px a schermo nella vista d'insieme: è la distanza che rende leggibile
 * la gerarchia senza che la targa sembri appoggiata sulla didascalia.
 */
const PLATE_BADGE_CAPTION_GAP_CM = 13;

/**
 * Ingombro (cm) del glifo della targa al corpo massimo, sopra e sotto la propria
 * mezzeria: sono le due quote con cui si risale dal blocco di intestazione alla
 * posizione del testo.
 */
const PLATE_BADGE_TEXT_ASCENT_CM = PLATE_BADGE_FONT_SIZE * PLATE_BADGE_TEXT_ASCENT_EM;
const PLATE_BADGE_TEXT_DESCENT_CM = PLATE_BADGE_FONT_SIZE * PLATE_BADGE_TEXT_DESCENT_EM;
/** Altezza complessiva (cm) della fascia occupata dal solo glifo della targa. */
export const PLATE_BADGE_TEXT_HEIGHT_CM = PLATE_BADGE_TEXT_ASCENT_CM + PLATE_BADGE_TEXT_DESCENT_CM;

/* --- Quote del blocco di intestazione (dall'alto verso il basso) -----------
 * Cabina (Y = 0) è in alto: più il valore è negativo, più la quota è in alto.
 * L'ordine di dichiarazione è l'ordine dei riferimenti: didascalia → targa →
 * sommità della fascia, così ogni costante può usare quelle già definite.
 * ------------------------------------------------------------------------- */

/**
 * Corpo (px) della didascalia `▲ CABINA ▲`: è la quota bassa della gerarchia
 * tipografica dell'intestazione e serve a calcolare la sommità del suo glifo,
 * sotto la quale deve restare il testo della targa.
 */
export const CABINA_CAPTION_FONT_SIZE = 15;

/**
 * Quota (cm) della didascalia `▲ CABINA ▲`: vive sotto il glifo della targa e
 * sopra la quota larghezza, senza sovrapporsi a nessuno dei due.
 */
export const CABINA_CAPTION_BASELINE_CM = -27;

/**
 * Quota (cm) della mezzeria verticale del testo della targa: con
 * `dominant-baseline: middle` è anche la baseline passata al renderer.
 * Il testo **sale** dalla sommità del glifo di CABINA di uno stacco e di tutta
 * la metà inferiore del proprio glifo, quindi la targa non può mai invaderla —
 * nemmeno al corpo massimo.
 */
export const PLATE_BADGE_CENTER_Y_CM =
  CABINA_CAPTION_BASELINE_CM -
  CABINA_CAPTION_FONT_SIZE * PLATE_BADGE_TEXT_ASCENT_EM -
  PLATE_BADGE_CAPTION_GAP_CM -
  PLATE_BADGE_TEXT_DESCENT_CM;

/**
 * Quota (cm) del bordo superiore della fascia targa: coincide con il **punto più
 * alto di tutta l'intestazione sopra la Cabina** ed è la quota di riferimento
 * per il clamp del pan (`CABINA_LABEL_OFFSET_CM`) e per l'inquadratura
 * dell'export (`SCENE_TOP_CM`).
 */
export const PLATE_BADGE_TOP_CM = PLATE_BADGE_CENTER_Y_CM - PLATE_BADGE_TEXT_ASCENT_CM;

/**
 * Quota (cm) del bordo inferiore del glifo della targa al corpo massimo: deve
 * restare **sopra** `CABINA_CAPTION_BASELINE_CM - 15 × ascent` (sommità del
 * glifo di CABINA), con lo stacco `PLATE_BADGE_CAPTION_GAP_CM`.
 */
export const PLATE_BADGE_BOTTOM_CM = PLATE_BADGE_CENTER_Y_CM + PLATE_BADGE_TEXT_DESCENT_CM;

/** Quota (cm) della quota larghezza utile, appena sopra la parete di Cabina. */
export const WIDTH_QUOTA_BASELINE_CM = -9;

/* --- Testo risolto --------------------------------------------------------- */

/** Contenuto testuale risolto della targa. */
export interface PlateBadgeLabel {
  /** Testo da stampare (maiuscolo, senza spazi ai bordi). */
  label: string;
  /** `true` se l'operatore ha digitato un identificativo reale. */
  hasPlate: boolean;
}

/**
 * Normalizza la targa digitata: maiuscolo e senza spazi ai bordi.
 * Con testo assente (o di soli spazi) il contenuto è la stringa vuota e
 * `hasPlate` è `false`: le tre rese non disegnano nulla.
 */
export const resolvePlateLabel = (plate: string): PlateBadgeLabel => {
  const trimmed = plate.trim();
  return trimmed.length > 0
    ? { label: trimmed.toUpperCase(), hasPlate: true }
    : { label: '', hasPlate: false };
};

/** Geometria completa del testo della targa in centimetri reali del pianale. */
export interface PlateBadgeLayout {
  /** Ascissa (cm) del bordo sinistro della fascia ESTESA (negativa: fuori sponda). */
  x: number;
  /** Larghezza (cm) della fascia estesa: `vehicle.width + 100`. */
  width: number;
  /** Quota (cm) del bordo superiore della fascia (punto più alto dell'intestazione). */
  top: number;
  /** Quota (cm) del bordo inferiore del glifo al corpo massimo. */
  bottom: number;
  /** Ascissa (cm) del centro: ancora di testo `text-anchor="middle"`. */
  centerX: number;
  /** Quota (cm) della mezzeria verticale: baseline con `dominant-baseline`. */
  centerY: number;
  /** Corpo del testo (px): 30, ridotto solo per gli identificativi più lunghi. */
  fontSize: number;
  /**
   * Ingombro orizzontale reale della scritta (cm):
   * `caratteri × fontSize × PLATE_BADGE_CHAR_ADVANCE_EM`.
   */
  textWidthCm: number;
  /**
   * Bordo sinistro dell'ingombro del testo (cm) più il margine di sicurezza:
   * è il valore da includere nel `minX` dell'inquadratura di export/stampa.
   */
  leftX: number;
  /**
   * Bordo destro dell'ingombro del testo (cm) più il margine di sicurezza:
   * è il valore da includere nel `maxX` dell'inquadratura di export/stampa.
   */
  rightX: number;
  /** Contenuto testuale risolto. */
  label: string;
  /** `true` se è stata digitata una targa vera. */
  hasPlate: boolean;
}

/**
 * Geometria del testo della targa per un dato mezzo, oppure `null` quando la
 * targa è vuota: in quel caso **nessuna** delle tre rese disegna alcunché e
 * l'area sopra la Cabina resta pulita e trasparente.
 *
 * - **Silenzio a riposo:** `plate` vuota o di soli spazi → `null`.
 * - **Centratura:** il testo è centrato sull'asse di mezzeria del pianale, nella
 *   fascia `PLATE_BADGE_TOP_CM … PLATE_BADGE_BOTTOM_CM`, sopra la didascalia
 *   `▲ CABINA ▲`.
 * - **Larghezza estesa fuori sponda:** la fascia di scrittura arriva a
 *   `vehicle.width + PLATE_MAX_OVERHANG_CM` cm (≈ 350 cm sul bilico CC), quindi
 *   la targa può sforare di 50 cm per lato oltre le pareti. Il tetto del corpo
 *   resta **30 px**.
 * - **Corpo testo:** `clamp(5, (larghezza massima estesa − 20) / (caratteri ×
 *   0.65), 30)`. Sul bilico da 250 cm la fascia utile vale 330 cm: una targa da
 *   16 caratteri o meno resta al corpo pieno di **30 px**, una da 19
 *   (`XA111NJ COME ARRIVA`) scende a **~26,7 px**, una da 24 a ~21,2 px, una da
 *   36 a ~14,1 px e una da 40 a ~12,7 px — sempre senza sbordare dalla fascia
 *   estesa.
 *
 * @param vehicleWidth Larghezza utile del mezzo in cm
 * @param plate        Targa / identificativo digitato (può essere vuoto)
 */
export const plateBadgeLayout = (
  vehicleWidth: number,
  plate: string
): PlateBadgeLayout | null => {
  const { label, hasPlate } = resolvePlateLabel(plate);
  if (!hasPlate) return null;

  const charCount = Math.max(1, label.length);
  // Larghezza massima ESTESA della targa: 100 cm oltre le sponde del mezzo
  // (≈ 350 cm sul bilico CC, cioè 50 cm di sforo per lato).
  const maxPlateWidthCm = vehicleWidth + PLATE_MAX_OVERHANG_CM;
  // Fascia utile al testo: la larghezza estesa al netto del margine di sicurezza.
  const availableWidth = Math.max(0, maxPlateWidthCm - PLATE_BADGE_TEXT_INSET_CM);
  // Corpo proporzionale: 30 px finché il testo ci sta (larghezza del glifo +
  // spaziatura), poi scala quanto basta per restare nella fascia estesa.
  const proportionalFontSize =
    availableWidth / (charCount * PLATE_BADGE_CHAR_ADVANCE_EM);
  const fontSize = Math.max(
    PLATE_BADGE_MIN_FONT_SIZE,
    Math.min(PLATE_BADGE_FONT_SIZE, proportionalFontSize)
  );
  // Ingombro orizzontale reale della scritta, spaziatura inclusa.
  const textWidthCm = charCount * fontSize * PLATE_BADGE_CHAR_ADVANCE_EM;
  const centerX = vehicleWidth / 2;
  const halfText = textWidthCm / 2;

  return {
    x: (vehicleWidth - maxPlateWidthCm) / 2,
    width: maxPlateWidthCm,
    top: PLATE_BADGE_TOP_CM,
    bottom: PLATE_BADGE_BOTTOM_CM,
    centerX,
    centerY: PLATE_BADGE_CENTER_Y_CM,
    fontSize,
    textWidthCm,
    leftX: centerX - halfText - PLATE_BADGE_EXTENT_MARGIN_CM,
    rightX: centerX + halfText + PLATE_BADGE_EXTENT_MARGIN_CM,
    label,
    hasPlate,
  };
};
