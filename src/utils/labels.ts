/* -------------------------------------------------------------------------- *
 *  ETICHETTE INTERNE DEI COLLI — geometria condivisa
 *
 *  Le coordinate del pianale sono centimetri reali: anche i corpi dei font sono
 *  quindi espressi in centimetri (unità del mondo vettoriale). Le stesse costanti
 *  e le stesse funzioni sono usate dal canvas a schermo (`TruckCanvas.tsx`) e
 *  dallo snapshot di esportazione (`export.ts`), così le due rese coincidono.
 * -------------------------------------------------------------------------- */

/** Corpo (cm) del nome collo quando sta su una sola riga. */
export const LABEL_FONT_SIZE = 11;

/** Corpo (cm) ridotto quando il nome viene spezzato su due righe. */
export const LABEL_WRAP_FONT_SIZE = 10;

/** Corpo (cm) delle quote (W × L) su un collo largo. */
export const LABEL_DIMENSION_FONT_SIZE = 9;

/** Frazione di larghezza media di un glifo rispetto al corpo del font (stima). */
export const AVERAGE_CHAR_WIDTH_RATIO = 0.58;

/** Sotto questa larghezza (cm) il collo è considerato stretto (es. CC 56,5 cm). */
export const NARROW_ITEM_WIDTH_CM = 70;

/** Margine interno (cm) da lasciare libero ai lati del testo. */
export const LABEL_SIDE_PADDING_CM = 6;

/** Stima (cm) della larghezza occupata da una stringa al corpo indicato. */
export const estimateTextWidth = (text: string, fontSize: number): number =>
  text.length * fontSize * AVERAGE_CHAR_WIDTH_RATIO;

/** Larghezza utile (cm) disponibile per il testo dentro un collo largo `itemWidthCm`. */
export const labelAvailableWidth = (itemWidthCm: number): number =>
  Math.max(4, itemWidthCm - LABEL_SIDE_PADDING_CM);

/**
 * Decide se l'etichetta di un collo deve andare a capo su due righe.
 *
 * Regole:
 * - se il nome contiene uno spazio ed è più largo del collo → due righe;
 * - se il collo è stretto (≤ 70 cm) e il nome contiene uno spazio → due righe;
 * - se il nome non contiene spazi, si va a capo solo quando eccede davvero.
 * Un nome corto su un collo stretto (es. "CC", "EC") resta quindi su una riga.
 *
 * @param name       Nome / cliente stampato dentro il collo
 * @param itemWidthCm Larghezza reale del collo in cm
 */
export const shouldWrapLabel = (name: string, itemWidthCm: number): boolean => {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;

  const hasSpace = /\s/.test(trimmed);
  const overflows =
    estimateTextWidth(trimmed, LABEL_FONT_SIZE) > labelAvailableWidth(itemWidthCm);

  if (hasSpace) return overflows || itemWidthCm <= NARROW_ITEM_WIDTH_CM;
  return overflows;
};

/**
 * Spezza un'etichetta su due righe centrate e bilanciate.
 *
 * - Con più parole: taglio sullo spazio che meglio equilibra le due righe.
 * - Con una sola parola troppo lunga: taglio centrale (il `clipPath` del collo
 *   impedisce comunque qualsiasi traboccamento sui colli adiacenti).
 *
 * @returns Le due righe, oppure `null` se il testo non è spezzabile.
 */
export const splitLabelIntoTwoLines = (name: string): [string, string] | null => {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed.length < 2) return null;

  const words = trimmed.split(' ');
  if (words.length >= 2) {
    const total = words.reduce((sum, word) => sum + word.length, 0);
    let running = 0;
    let splitIndex = 1;
    let bestDelta = Number.POSITIVE_INFINITY;

    for (let i = 1; i < words.length; i += 1) {
      running += words[i - 1].length;
      const delta = Math.abs(running - (total - running));
      if (delta < bestDelta) {
        bestDelta = delta;
        splitIndex = i;
      }
    }

    const first = words.slice(0, splitIndex).join(' ');
    const second = words.slice(splitIndex).join(' ');
    return second.length > 0 ? [first, second] : null;
  }

  if (trimmed.length < 4) return null;
  const middle = Math.ceil(trimmed.length / 2);
  return [trimmed.slice(0, middle), trimmed.slice(middle)];
};

/**
 * ID del `clipPath` che ritaglia il testo dentro il singolo collo.
 * L'ID è normalizzato per essere sempre valido come riferimento SVG.
 */
export const clipIdForItem = (itemId: string): string =>
  `clip-${itemId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
