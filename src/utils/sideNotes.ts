import type { SideNote } from '../types';

/* -------------------------------------------------------------------------- *
 *  NOTE LATERALI DI CARICO (SIDE ANNOTATIONS) — geometria e testo condivisi
 *
 *  Le note sono posizionate **liberamente in 2D** (`x`, `y` in cm reali): di
 *  default nascono subito a destra della parete del semirimorchio
 *  (`x = vehicle.width + 30`), ma possono essere trascinate ovunque attorno al
 *  camion — anche a sinistra di esso (`x < 0`) o in coda — senza mai entrare nel
 *  calcolo dei metri lineari. Questo modulo è l'unica fonte di verità della loro
 *  geometria, così canvas a schermo (`TruckCanvas.tsx`), snapshot PNG
 *  (`utils/export.ts`) e scheda di stampa A4 (`components/PrintReport.tsx`)
 *  restano perfettamente coerenti.
 *
 *  Ogni nota è un **unico testo libero** (`content`) racchiuso nel proprio
 *  rettangolo: la larghezza (`width`), l'altezza (`height`) e il corpo del testo
 *  (`fontSize`, scala 11 / 14 / 18 px) sono scelti dall'operatore e valgono
 *  identici nelle tre rese.
 *
 *  Tutte le quote sono in CENTIMETRI REALI (unità del mondo vettoriale).
 * -------------------------------------------------------------------------- */

/** Offset (cm) della corsia note dalla parete destra: posizione di NASCITA. */
export const NOTE_LANE_OFFSET_CM = 30;

/** Larghezza di default della card di nota (cm). */
export const NOTE_DEFAULT_WIDTH_CM = 140;

/** Larghezza minima consentita per la card (cm). */
export const NOTE_MIN_WIDTH_CM = 70;

/** Larghezza massima consentita per la card (cm). */
export const NOTE_MAX_WIDTH_CM = 300;

/** Altezza minima consentita per la card (cm). */
export const NOTE_MIN_HEIGHT_CM = 40;

/** Altezza massima consentita per la card (cm). */
export const NOTE_MAX_HEIGHT_CM = 400;

/** Passo dei campi numerici di larghezza / altezza nella sidebar (cm). */
export const NOTE_SIZE_STEP_CM = 5;

/**
 * Padding interno della card (cm).
 *
 * È anche l'ascissa **relativa all'origine del box** del testo della nota:
 * dentro il gruppo `transform="translate(noteX, note.y)"` il `<text>` e ogni
 * suo `<tspan>` usano `x = NOTE_PADDING_CM` (10 cm), quindi il testo non può
 * mai finire fuori dalla sagoma del rettangolo colorato.
 */
export const NOTE_PADDING_CM = 10;

/** Spazio (cm) tra card adiacenti quando una nuova nota cerca posto libero. */
export const NOTE_STACK_GAP_CM = 6;

/**
 * Passo verticale di una riga di testo, in em rispetto al corpo scelto
 * (`noteLineHeightCm(11) = 13,97 cm`, `noteLineHeightCm(14) = 17,78 cm`,
 * `noteLineHeightCm(18) = 22,86 cm`).
 */
export const NOTE_LINE_HEIGHT_EM = 1.27;

/**
 * Baseline della prima riga, in em rispetto al corpo scelto
 * (`noteFirstBaselineCm(11) = 18,04 cm`, `noteFirstBaselineCm(14) = 22,96 cm`,
 * `noteFirstBaselineCm(18) = 29,52 cm`).
 */
export const NOTE_FIRST_BASELINE_EM = 1.64;

/** Scala dei corpi testo ammessi per una nota laterale (px). */
export const NOTE_FONT_SIZES = [11, 14, 18] as const;

/** Corpo di default di una nota laterale (px): la taglia "Media" `A`. */
export const NOTE_DEFAULT_FONT_SIZE = 14;

/** Limiti di sicurezza del corpo testo (px), coincidenti con la scala ufficiale. */
export const NOTE_MIN_FONT_SIZE = 11;
export const NOTE_MAX_FONT_SIZE = 18;

/** Battute minime per riga garantite anche sulla card più stretta (70 cm). */
export const NOTE_MIN_CHARS_PER_LINE = 4;

/**
 * Larghezza media di un glifo in em, usata per stimare quante battute entrano
 * nella card: il valore è prudenziale (i font di sistema sono più stretti),
 * così il testo non supera mai il bordo destro del rettangolo.
 */
export const NOTE_CHAR_WIDTH_EM = 0.56;

/**
 * Margine di sicurezza applicato alla stima delle battute per riga. La misura
 * reale dei glifi dipende dal font disponibile nel browser: questa tolleranza
 * (6% in meno di caratteri) assorbe le differenze e garantisce che l'ultima
 * lettera della riga non tocchi mai il bordo della card.
 */
export const NOTE_WRAP_SAFETY = 0.94;

/**
 * Corpo massimo che entra in una card larga `width` cm, in px: derivato dal
 * numero minimo di battute per riga (`NOTE_MIN_CHARS_PER_LINE`). Con la
 * larghezza minima di 70 cm il tetto è ~23 px, quindi **non** intacca mai la
 * scala ufficiale 11 / 14 / 18 px: interviene solo su valori fuori scala.
 */
export const maxNoteFontSizeForWidth = (width: number): number => {
  const availableCm = Math.max(10, width - 2 * NOTE_PADDING_CM);
  const minPerChar = NOTE_MIN_CHARS_PER_LINE * NOTE_CHAR_WIDTH_EM * NOTE_WRAP_SAFETY;
  return Math.max(NOTE_MIN_FONT_SIZE, availableCm / minPerChar);
};

/** Dimensione misurata della card: altezza, righe di testo e corpo applicato. */
export interface NoteGeometry {
  /** Altezza effettiva della card in cm (quella scelta, se presente). */
  height: number;
  /** Righe di testo già mandate a capo. */
  lines: string[];
  /** Corpo del testo effettivamente applicato (px), entro i limiti di sicurezza. */
  fontSize: number;
  /** Passo verticale (cm) tra le righe, proporzionale al corpo del testo. */
  lineHeightCm: number;
  /** Baseline (cm) della prima riga, relativa all'origine del box. */
  firstBaselineCm: number;
  /** Caratteri massimi per riga con il corpo effettivo. */
  maxChars: number;
  /** Altezza (cm) richiesta dal testo: se supera `height`, il testo è ritagliato. */
  textHeight: number;
}

/**
 * Altezza (cm) di una riga di testo, proporzionale al corpo scelto
 * (`NOTE_LINE_HEIGHT_EM` em): alla scala ufficiale 11 / 14 / 18 px il passo vale
 * 13,97 / 17,78 / 22,86 cm.
 */
export const noteLineHeightCm = (fontSize: number): number => fontSize * NOTE_LINE_HEIGHT_EM;

/** Baseline (cm) della prima riga, relativa all'origine del box. */
export const noteFirstBaselineCm = (fontSize: number): number =>
  fontSize * NOTE_FIRST_BASELINE_EM;

/**
 * Sottoinsieme di `SideNote` sufficiente a calcolare testo e geometria della
 * card: consente di misurare anche una nota ancora in fase di bozza (senza ID né
 * quote definitive), come accade allo spawn o nel pannello della sidebar.
 */
export type NoteGeometryInput = Pick<SideNote, 'content' | 'width'> &
  Partial<Pick<SideNote, 'height' | 'fontSize'>>;

/**
 * Corpo del testo realmente applicabile nella card: il valore scelto
 * dall'operatore (11 / 14 / 18 px) viene solo limitato perché il testo possa
 * entrare nella larghezza disponibile, senza mai riscriverlo al ribasso in modo
 * arbitrario.
 */
export const resolveNoteFontSize = (note: NoteGeometryInput): number => {
  const requested = Number(note.fontSize) || NOTE_DEFAULT_FONT_SIZE;
  const clamped = Math.max(NOTE_MIN_FONT_SIZE, Math.min(NOTE_MAX_FONT_SIZE, requested));
  // I corpi 11 / 14 / 18 px sono sempre rispettati alla larghezza di default
  // (140 cm); il tetto entra in gioco solo su valori fuori scala.
  return Math.min(clamped, maxNoteFontSizeForWidth(note.width));
};

/** Quote di chiusura della card: padding inferiore (cm) e discesa dei glifi (em). */
export const NOTE_BOTTOM_PADDING_CM = 6;
export const NOTE_DESCENDER_EM = 0.4;

/** Caratteri massimi per riga nella card, dedotti da larghezza e corpo del
 * testo: una card più larga (o un corpo più piccolo) ospita più battute. */
export const noteCharsPerLine = (width: number, fontSize: number): number => {
  const availableCm = Math.max(10, width - 2 * NOTE_PADDING_CM);
  const perChar = Math.max(0.5, fontSize * NOTE_CHAR_WIDTH_EM);
  return Math.max(4, Math.floor((availableCm / perChar) * NOTE_WRAP_SAFETY));
};

/**
 * Spezza il testo della nota in righe da al più `maxChars` caratteri,
 * rispettando gli a capo digitati dall'operatore e spezzando le parole troppo
 * lunghe. Funzione pura, condivisa dalle tre rese.
 */
export const wrapNoteText = (text: string, maxChars: number): string[] => {
  const limit = Math.max(1, Math.floor(maxChars));
  const lines: string[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const words = rawLine.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let line = '';
    for (const word of words) {
      if (line.length === 0) {
        line = word;
      } else if (line.length + 1 + word.length <= limit) {
        line = `${line} ${word}`;
      } else {
        lines.push(line);
        line = word;
      }

      // Parola singola più lunga del limite: spezzata a forza.
      while (line.length > limit) {
        lines.push(line.slice(0, limit));
        line = line.slice(limit);
      }
    }

    if (line.length > 0) lines.push(line);
  }

  // Una nota vuota conserva una riga (card snella ma leggibile).
  return lines.length > 0 ? lines : [''];
};

/**
 * Geometria della card di una nota.
 *
 * - **Larghezza**: quella scelta dall'operatore (`note.width`).
 * - **Altezza**: se l'operatore l'ha fissata con la maniglia di resize
 *   (`note.height`) il box ha esattamente quella misura; altrimenti l'altezza
 *   si adatta al testo (padding + righe × passo), con il minimo di
 *   `NOTE_MIN_HEIGHT_CM` cm.
 * - **Testo**: mandato a capo su `noteCharsPerLine(width, fontSize)` caratteri,
 *   con il corpo scelto dall'operatore.
 */
export const noteGeometry = (note: NoteGeometryInput): NoteGeometry => {
  const fontSize = resolveNoteFontSize(note);
  const maxChars = noteCharsPerLine(note.width, fontSize);
  const lines = wrapNoteText(note.content, maxChars);
  const lineHeightCm = noteLineHeightCm(fontSize);
  const firstBaselineCm = noteFirstBaselineCm(fontSize);

  const explicitHeight = Number(note.height);
  const hasExplicitHeight = Number.isFinite(explicitHeight) && explicitHeight > 0;
  // Altezza richiesta dal testo: baseline della prima riga + corpo di tutte le
  // righe (compresa la discesa dei glifi) + padding inferiore. Il box
  // auto-adattato è quindi sempre sufficiente a contenere il testo per intero.
  const textHeight =
    firstBaselineCm + lines.length * lineHeightCm + NOTE_DESCENDER_EM * fontSize + NOTE_BOTTOM_PADDING_CM;
  const height = hasExplicitHeight
    ? explicitHeight
    : Math.max(NOTE_MIN_HEIGHT_CM, Math.ceil(textHeight));

  return {
    height,
    lines,
    fontSize,
    lineHeightCm,
    firstBaselineCm,
    maxChars,
    textHeight,
  };
};

/**
 * Geometria delle card di nota, nell'ordine di creazione.
 *
 * Il posizionamento è **liberamente 2D** (`note.x`, `note.y` in cm reali): ogni
 * nota conserva esattamente le coordinate scelte dall'operatore, quindi la
 * funzione non sposta né riallinea nulla — si limita a misurarne il testo e
 * l'altezza reale. Eventuali sovrapposizioni sono una scelta dell'operatore,
 * non una condizione da correggere d'ufficio (l'anti-sovrapposizione vive solo
 * allo spawn di una nuova nota, in `findFreeNoteY`).
 *
 * @param notes Note da misurare, nell'ordine di creazione
 * @returns Array di `{ note, height, lines, ... }` allineato all'input
 */
export const resolveNoteLayouts = (
  notes: SideNote[]
): (NoteGeometry & { note: SideNote })[] =>
  notes.map((note) => ({ note, ...noteGeometry(note) }));

/**
 * Quota Y libera più vicina a quella richiesta per una **nuova** nota: scorre
 * verso il basso finché il rettangolo non tocca nessuna card esistente
 * (`NOTE_STACK_GAP_CM` di stacco). Serve solo a evitare che due note create di
 * seguito nascano una sopra l'altra: le note già piazzate non vengono **mai**
 * spostate d'ufficio, perché il posizionamento 2D è interamente in mano
 * all'operatore.
 *
 * @param notes    Note già presenti sul pianale
 * @param position posizione desiderata della nuova card (cm reali)
 * @param draft    contenuto e larghezza della nuova card (per misurarne l'altezza)
 */
export const findFreeNoteY = (
  notes: SideNote[],
  position: { x: number; y: number },
  draft: NoteGeometryInput
): number => {
  const obstacles = resolveNoteLayouts(notes);
  const width = draft.width;
  const height = noteGeometry(draft).height;
  let top = position.y;

  let moved = true;
  while (moved) {
    moved = false;
    for (const { note, height: otherHeight } of obstacles) {
      const overlapsX = position.x < note.x + note.width && note.x < position.x + width;
      const overlapsY = top < note.y + otherHeight && note.y < top + height;
      if (overlapsX && overlapsY) {
        top = note.y + otherHeight + NOTE_STACK_GAP_CM;
        moved = true;
      }
    }
  }

  return Math.max(0, Math.round(top * 100) / 100);
};

/**
 * Colori della card di nota: le 7 famiglie pastello della matrice colori più
 * il bianco neutro, per una nota che non deve competere coi colori dei colli.
 */
export const NOTE_PASTEL_COLORS: string[] = [
  '#F1F5F9', // Grigio chiaro
  '#E0F2FE', // Azzurro
  '#DCFCE7', // Verde
  '#FEF9C3', // Giallo
  '#FFEDD5', // Arancio
  '#FFE4E6', // Corallo
  '#F3E8FF', // Viola
  '#FFFFFF', // Bianco neutro
];

/** Bordi storici della card: non più disegnati a riposo ("zero bordi"), restano
 *  come metadato e per future evidenziazioni. */
export const NOTE_BORDER_COLOR = '#94A3B8';
export const NOTE_BORDER_COLOR_SOFT = '#CBD5E1';

/** Colore della maniglia di ridimensionamento (stesso blu CAD della selezione). */
export const NOTE_RESIZE_HANDLE_COLOR = '#2563EB';

/** Lato (cm) della maniglia di resize disegnata nell'angolo basso-destro. */
export const NOTE_RESIZE_HANDLE_SIZE_CM = 8;

/**
 * Semiampiezza (cm) dello spazio di lavoro 2D attorno al pianale: una nota può
 * essere trascinata molto a sinistra (`X < 0`), oltre la parete destra, sopra la
 * Cabina o in coda, ma non all'infinito — così non può mai perdersi fuori scena.
 */
export const NOTE_WORKSPACE_MARGIN_CM = 600;

/** Ascissa minima (cm) consentita all'origine di una nota. */
export const noteMinX = (vehicleWidth: number): number =>
  -(vehicleWidth + NOTE_WORKSPACE_MARGIN_CM);

/** Ascissa massima (cm) consentita all'origine di una nota. */
export const noteMaxX = (vehicleWidth: number): number =>
  vehicleWidth + NOTE_WORKSPACE_MARGIN_CM;

/**
 * Testo di partenza di una nota creata dai colli selezionati: il nome del primo
 * collo fa da intestazione immediata, pronto per essere completato.
 */
export const buildNoteSeedText = (itemName: string): string => {
  const name = itemName.trim();
  return name.length > 0 ? `${name} - ` : '';
};
