import type { SideNote } from '../types';

/* -------------------------------------------------------------------------- *
 *  NOTE LATERALI DI CARICO (SIDE ANNOTATIONS) — geometria e testo condivisi
 *
 *  Le note vivono in una corsia dedicata a DESTRA della parete del
 *  semirimorchio: non occupano mai il pianale utile e non entrano nel calcolo
 *  dei metri lineari. Questo modulo è l'unica fonte di verità della loro
 *  geometria, così canvas a schermo (`TruckCanvas.tsx`), snapshot PNG
 *  (`utils/export.ts`) e scheda di stampa A4 (`components/PrintReport.tsx`)
 *  restano perfettamente coerenti.
 *
 *  Ogni nota è un **unico testo libero** (`content`) racchiuso nel proprio
 *  rettangolo: la larghezza (`width`), l'altezza (`height`) e il corpo del testo
 *  (`fontSize`) sono scelti dall'operatore e valgono identici nelle tre rese.
 *
 *  Tutte le quote sono in CENTIMETRI REALI (unità del mondo vettoriale).
 * -------------------------------------------------------------------------- */

/** Offset (cm) della corsia note dalla parete destra del semirimorchio. */
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

/** Spazio (cm) tra card adiacenti della stessa corsia (anti-sovrapposizione). */
export const NOTE_STACK_GAP_CM = 6;

/** Passo verticale (cm) della riga di testo con il corpo di default (11 px). */
export const NOTE_LINE_HEIGHT_CM = 14;

/** Baseline (cm) della prima riga con il corpo di default (11 px). */
export const NOTE_TEXT_TOP_CM = 18;

/** Corpi testo ammessi per una nota laterale (px). */
export const NOTE_FONT_SIZES = [9, 11, 14] as const;

/** Corpo di default di una nota laterale (px). */
export const NOTE_DEFAULT_FONT_SIZE = 11;

/** Limiti di sicurezza del corpo testo (px). */
export const NOTE_MIN_FONT_SIZE = 6;
export const NOTE_MAX_FONT_SIZE = 18;

/**
 * Corpo massimo che entra in una card larga `width` cm, in px: derivato dalla
 * larghezza media di un glifo, serve solo a impedire che una card molto stretta
 * (es. 70 cm) renda il testo illeggibile o sbordante.
 */
export const maxNoteFontSizeForWidth = (width: number): number =>
  Math.max(NOTE_MIN_FONT_SIZE, width / 10);

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
 * Altezza (cm) di una riga di testo, proporzionale al corpo scelto: il passo
 * storico di 14 cm vale per il corpo di default di 11 px.
 */
export const noteLineHeightCm = (fontSize: number): number =>
  (NOTE_LINE_HEIGHT_CM * fontSize) / NOTE_DEFAULT_FONT_SIZE;

/** Baseline (cm) della prima riga, relativa all'origine del box. */
export const noteFirstBaselineCm = (fontSize: number): number =>
  (NOTE_TEXT_TOP_CM * fontSize) / NOTE_DEFAULT_FONT_SIZE;

/**
 * Corpo del testo realmente applicabile nella card: il valore scelto
 * dall'operatore (9 / 11 / 14 px) viene solo limitato perché il testo possa
 * entrare nella larghezza disponibile, senza mai riscriverlo al ribasso in
 * modo arbitrario.
 */
export const resolveNoteFontSize = (note: SideNote): number => {
  const requested = Number(note.fontSize) || NOTE_DEFAULT_FONT_SIZE;
  const clamped = Math.max(NOTE_MIN_FONT_SIZE, Math.min(NOTE_MAX_FONT_SIZE, requested));
  // I corpi 9 / 11 / 14 px sono sempre rispettati alla larghezza di default
  // (140 cm); il tetto entra in gioco solo su card molto strette.
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
export const noteGeometry = (note: SideNote): NoteGeometry => {
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
 * Posiziona le card nella corsia note, tutte alla stessa ascissa
 * (`vehicle.width + NOTE_LANE_OFFSET_CM`), spingendo verso il basso solo le
 * note che si sovrappongono davvero.
 *
 * La quota Y resta quella scelta dall'operatore (o ereditata dai colli
 * selezionati); l'eventuale scostamento verticale è una mera risoluzione di
 * collisione grafica, quindi nessuna nota viene mai invalidata: il testo è
 * libero di eccedere l'altezza del mezzo e resta comunque nella propria corsia.
 *
 * @param notes Note da disporre, nell'ordine di creazione
 * @returns Array di `{ note, height, lines, ... }` allineato all'input
 */
export const resolveNoteLayouts = (
  notes: SideNote[]
): (NoteGeometry & { note: SideNote })[] => {
  const layouts = notes.map((note) => ({ note, ...noteGeometry(note) }));
  const placed: { top: number; bottom: number }[] = [];

  for (const layout of layouts) {
    const startY = layout.note.y;
    let top = startY;

    // Spinta verso il basso finché la card non trova posto libero (il contatto
    // a filo bordo non è una sovrapposizione: le card restano accostate).
    let moved = true;
    while (moved) {
      moved = false;
      for (const other of placed) {
        const overlaps = top < other.bottom && other.top < top + layout.height;
        if (overlaps) {
          top = other.bottom + NOTE_STACK_GAP_CM;
          moved = true;
        }
      }
    }

    placed.push({ top, bottom: top + layout.height });
    layout.note = top === startY ? layout.note : { ...layout.note, y: top };
  }

  return layouts;
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

/** Bordi ammessi per la card: antracite (eredità) o grigio chiaro. */
export const NOTE_BORDER_COLOR = '#94A3B8';
export const NOTE_BORDER_COLOR_SOFT = '#CBD5E1';

/** Colore della maniglia di ridimensionamento (stesso blu CAD della selezione). */
export const NOTE_RESIZE_HANDLE_COLOR = '#2563EB';

/** Lato (cm) della maniglia di resize disegnata nell'angolo basso-destro. */
export const NOTE_RESIZE_HANDLE_SIZE_CM = 8;

/**
 * Testo di partenza di una nota creata dai colli selezionati: il nome del primo
 * collo fa da intestazione immediata, pronto per essere completato.
 */
export const buildNoteSeedText = (itemName: string): string => {
  const name = itemName.trim();
  return name.length > 0 ? `${name} - ` : '';
};
