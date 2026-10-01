import type { LabelDensity, PlacedItem, SideNote, VehicleConfig } from '../types';
import { calculateLdmMetrics, hasCollision, isOutOfBounds } from './snapping';
import {
  ALERT_COLOR,
  LDM_BADGE,
  LDM_BADGE_CENTER_X,
  LDM_BADGE_COLOR,
  LDM_BADGE_LEFT_X,
  LDM_BADGE_MUTED_COLOR,
  LDM_BADGE_RESERVED_LEFT,
  LDM_BADGE_RESERVED_RIGHT,
  LDM_GUIDE_CLOSING_LENGTH,
  LDM_GUIDE_COLOR,
  LDM_GUIDE_DASH,
  NOMINAL_QUOTA_CM,
  NOMINAL_QUOTA_COLOR,
  ldmBadgeRightCenterX,
  ldmBadgeRightLeftX,
} from '../constants';
import {
  AVERAGE_CHAR_WIDTH_RATIO,
  clipIdForItem,
  LABEL_DIMENSION_FONT_SIZE,
  LABEL_FONT_SIZE,
  LABEL_WRAP_FONT_SIZE,
  NARROW_ITEM_WIDTH_CM,
  shouldWrapLabel,
  splitLabelIntoTwoLines,
} from './labels';
import {
  NOTE_PADDING_CM,
  resolveNoteLayouts,
} from './sideNotes';
import {
  CABINA_CAPTION_BASELINE_CM,
  PLATE_BADGE_BORDER_COLOR,
  PLATE_BADGE_BORDER_DASH,
  PLATE_BADGE_BORDER_WIDTH,
  PLATE_BADGE_CORNER_RADIUS_CM,
  PLATE_BADGE_FILL,
  PLATE_BADGE_FONT_FAMILY,
  PLATE_BADGE_PLACEHOLDER_COLOR,
  PLATE_BADGE_TEXT_COLOR,
  WIDTH_QUOTA_BASELINE_CM,
  plateBadgeLayout,
} from './plateBadge';

/* -------------------------------------------------------------------------- *
 *  SPRINT D — ESPORTAZIONE IMMAGINE
 *
 *  Modulo puro + browser API per generare uno snapshot PNG "pulito" del pianale
 *  (nessun contorno di selezione, nessun lasso, nessun HUD) e copiarlo negli
 *  appunti di sistema, con fallback automatico su download del file.
 *
 *  Tutta la geometria è espressa in CENTIMETRI REALI del pianale: il viewBox
 *  dell'SVG è in cm, mentre la rasterizzazione avviene su un <canvas> a 2x
 *  (larghezza base 1200 px) per la massima nitidezza su schermi Retina.
 * -------------------------------------------------------------------------- */

/** Larghezza base (px CSS) dell'immagine esportata sul pianale. */
export const EXPORT_BASE_WIDTH = 1200;

/** Fattore di sovracampionamento dello snapshot (2 = Retina / zoom nitido). */
export const EXPORT_PIXEL_RATIO = 2;

/**
 * Area massima (px²) concessa al canvas di lavoro: limite prudenziale che evita
 * di superare i tetti di canvas dei browser (soprattutto Safari/iOS) quando il
 * rapporto d'aspetto del mezzo è molto allungato (bilico da 13,60 m).
 */
const MAX_CANVAS_AREA = 64_000_000;

/** Margine di sicurezza aggiunto sotto l'ultimo collo, per non tagliarlo (cm). */
export const BOTTOM_MARGIN_CM = 50;

/** Padding del viewBox attorno al pianale, in centimetri reali. */
const PADDING = { left: 26, right: 6, top: 40, bottom: 8 } as const;

/** Spazio minimo (cm) a sinistra per la dicitura della quota 13,20 m. */
const NOMINAL_QUOTA_RESERVED_LEFT = 44;

/**
 * Margine minimo (cm) dell'inquadratura attorno al pianale, a sinistra e a
 * destra: la scena contiene sempre il camion con un po' d'aria ai lati.
 */
const SCENE_MARGIN_CM = 40;

/**
 * Stacco (cm) dell'inquadratura dall'ingombro **reale** della scena (colli e
 * note): l'immagine non tocca mai il bordo dell'ultimo elemento disegnato.
 */
const SCENE_PADDING_CM = 20;

/**
 * Bordo superiore dell'inquadratura (cm): spazio per la card targa
 * (`-48 … -28 cm`), per la scritta `▲ CABINA ▲` e per la quota larghezza.
 * Con `-65 cm` l'immagine lascia 17 cm d'aria sopra il badge: nulla viene mai
 * tagliato, a nessuna larghezza di targa.
 */
const SCENE_TOP_CM = -65;

/** Corpi testo (cm reali), allineati al rendering del canvas a schermo. */
const FONT = {
  meter: 10,
  caption: 15,
  quota: 11,
} as const;

/** Palette CAD dello snapshot pulito (sobria, alto contrasto in stampa). */
const COLORS = {
  background: '#FFFFFF',
  deck: '#F8FAFC',
  wall: '#0F172A',
  grid: '#E2E8F0',
  gridText: '#94A3B8',
  caption: '#334155',
  name: '#1E293B',
  dimensions: '#475569',
  /** Riservato alle sole condizioni di allarme (collisione / fuori sagoma). */
  alert: ALERT_COLOR,
  nominalQuota: NOMINAL_QUOTA_COLOR,
  ldmGuide: LDM_GUIDE_COLOR,
  ldmBadge: LDM_BADGE_COLOR,
  /** Badge del lato MENO carico, col carico asimmetrico. */
  ldmBadgeMuted: LDM_BADGE_MUTED_COLOR,
  ldmBadgeText: '#FFFFFF',
} as const;

/** Font di sistema: leggibili sia a schermo sia nella rasterizzazione su canvas. */
const FONT_FAMILY = 'Helvetica, Arial, sans-serif';
/** Niente virgolette interne: la stringa viene interpolata in attributi XML. */
const MONO_FONT_FAMILY = 'SFMono-Regular, Menlo, Consolas, monospace';

/** Nome del file scaricato quando gli appunti non sono disponibili. */
const FALLBACK_FILE_NAME = 'piano-di-carico.png';

/**
 * Ingombro vettoriale completo della scena, in centimetri reali.
 * Include l'eventuale sforamento posteriore dei colli oltre le porte e **tutte**
 * le note laterali, ovunque siano state posizionate (a sinistra del rimorchio, a
 * destra o in coda).
 */
export interface PianoExtent {
  /** Bordo sinistro del viewBox (negativo: righello metrico e note a sinistra). */
  minX: number;
  /** Bordo superiore del viewBox (negativo: spazio per la scritta CABINA). */
  minY: number;
  /** Larghezza totale del viewBox (cm). */
  width: number;
  /** Altezza totale del viewBox (cm). */
  height: number;
  /** Y (cm) dell'ultimo elemento, sforamento posteriore incluso (+50 cm). */
  contentBottom: number;
  /** Y (cm) della linea tratteggiata delle porte posteriori. */
  doorLine: number;
  /** Y (cm) della didascalia "PORTE POSTERIORI". */
  doorLabelY: number;
}

/** Snapshot SVG autonomo + dimensioni in px CSS dell'immagine finale. */
export interface PianoSnapshot {
  /** Stringa SVG completa e auto-consistente (nessuna risorsa esterna). */
  svg: string;
  /** Larghezza in px CSS (prima del sovracampionamento). */
  width: number;
  /** Altezza in px CSS (prima del sovracampionamento). */
  height: number;
}

/**
 * Calcola l'ingombro della scena da esportare, con **inquadratura dinamica 2D**.
 *
 * L'altezza include gli eventuali colli che sforano dalle porte posteriori e il
 * fondo di ogni card di nota:
 * `maxY = max(vehicle.length, ...items.y + items.length, ...notes.y + note.height) + 50`.
 *
 * La larghezza include **tutte** le note, a qualunque ascissa:
 * `minX = min(-40, ...notes.x) - 20` e `maxX = max(vehicle.width + 40, ...notes.x + notes.width) + 20`,
 * uniti agli spazi già riservati ai righelli (quote metriche, quota 13,20 m,
 * badge LDM) perché nulla venga mai tagliato. Una nota trascinata a sinistra del
 * camion (`x < 0`) allarga quindi l'immagine verso sinistra, una nota in coda la
 * allunga verso il basso.
 *
 * @param vehicle      Configurazione del mezzo (dimensioni utili in cm)
 * @param items        Colli stivati sul pianale
 * @param labelDensity Densità etichette applicata all'immagine (`all` di default)
 * @param notes        Note laterali da includere nello snapshot
 */
export const getPianoExtent = (
  vehicle: VehicleConfig,
  items: PlacedItem[],
  labelDensity: LabelDensity = 'all',
  notes: SideNote[] = []
): PianoExtent => {
  // Geometria reale delle card: altezza fissata dall'operatore o auto-adattata.
  const noteLayouts = notes.length > 0 ? resolveNoteLayouts(notes) : [];

  // Ingombro verticale della scena: pianale, colli (sforamento incluso) e note.
  const maxY =
    Math.max(
      vehicle.length,
      ...items.map((item) => item.y + item.length),
      ...noteLayouts.map((layout) => layout.note.y + layout.height)
    ) + BOTTOM_MARGIN_CM;

  // Ingombro orizzontale reale della scena: il pianale e tutte le note, dove sono.
  const sceneMinX =
    Math.min(-SCENE_MARGIN_CM, ...notes.map((note) => note.x)) - SCENE_PADDING_CM;
  const sceneMaxX =
    Math.max(
      vehicle.width + SCENE_MARGIN_CM,
      ...notes.map((note) => note.x + note.width)
    ) + SCENE_PADDING_CM;

  // Didascalia delle porte: sotto il pianale, oppure sotto l'eventuale sforamento.
  const hasOverhang = items.some((item) => item.y + item.length > vehicle.length);
  const doorLabelY = hasOverhang
    ? Math.max(...items.map((item) => item.y + item.length)) + 18
    : vehicle.length + 24;

  // Contatore LDM e quota nominale hanno bisogno di spazio nel righello sinistro.
  // Con densità `minimal` il contatore non viene disegnato: nessuno spazio extra.
  const ldm = calculateLdmMetrics(vehicle, items);
  const hasLdmBadge = labelDensity !== 'minimal' && ldm.maxOccupiedY > 0;
  const showsNominalQuota = vehicle.length >= NOMINAL_QUOTA_CM;
  const leftPadding = Math.max(
    PADDING.left,
    hasLdmBadge ? LDM_BADGE_RESERVED_LEFT : 0,
    showsNominalQuota ? NOMINAL_QUOTA_RESERVED_LEFT : 0
  );

  // Badge LDM del lato destro: vive FUORI dalla parete destra, quindi con un
  // carico asimmetrico il viewBox deve riservare spazio anche a destra.
  const needsRightLdmBadge = hasLdmBadge && ldm.isAsymmetric;
  const rightPadding = Math.max(
    PADDING.right,
    needsRightLdmBadge ? LDM_BADGE_RESERVED_RIGHT : 0
  );

  // Inquadratura finale: unione tra l'ingombro reale della scena (note comprese)
  // e gli spazi riservati ai righelli. Nessun elemento può restare fuori.
  const minX = Math.min(-leftPadding, sceneMinX);
  const maxX = Math.max(vehicle.width + rightPadding, sceneMaxX);
  const minY = SCENE_TOP_CM;

  return {
    minX,
    minY,
    width: maxX - minX,
    height: -minY + maxY + PADDING.bottom,
    contentBottom: maxY,
    doorLine: vehicle.length,
    doorLabelY,
  };
};

/** Escape XML: i nomi cliente sono testo libero digitato dall'operatore. */
const escapeXml = (value: string): string =>
  value.replace(
    /[<>&"']/g,
    (char) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;',
      })[char] ?? char
  );

/**
 * Tronca una stringa perché non esca dal rettangolo del collo.
 * La stima è volutamente conservativa (larghezza media dei glifi).
 */
const truncateToWidth = (text: string, maxWidthCm: number, fontSizeCm: number): string => {
  const maxChars = Math.max(
    1,
    Math.floor(maxWidthCm / (fontSizeCm * AVERAGE_CHAR_WIDTH_RATIO))
  );
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
};

/** Arrotonda a due decimali: stringhe SVG compatte e prive di rumore numerico. */
const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Etichette interne di un collo, secondo la densità scelta dall'operatore.
 * Lo snapshot esportato non contiene MAI i contorni blu di selezione o lasso.
 *
 * Stessa logica del canvas a schermo (`TruckCanvas.tsx`):
 * - sui colli stretti (≤ 70 cm) o con nomi lunghi il nome va a capo su due righe
 *   centrate (`<tspan>`) con corpo ridotto a 10 cm;
 * - il testo vive dentro il `clipPath` del collo (applicato da `renderItem`),
 *   quindi non può fisicamente sbordare sui colli adiacenti.
 *
 * @param item         Collo da etichettare
 * @param labelDensity Densità etichette (`all` | `client` | `dimensions` | `minimal`)
 */
const renderItemLabels = (item: PlacedItem, labelDensity: LabelDensity): string => {
  if (labelDensity === 'minimal') return '';

  const centerX = item.width / 2;
  const centerY = item.length / 2;
  const isNarrow = item.width <= NARROW_ITEM_WIDTH_CM;

  const lines = shouldWrapLabel(item.name, item.width)
    ? splitLabelIntoTwoLines(item.name)
    : null;
  const nameFont = lines ? LABEL_WRAP_FONT_SIZE : LABEL_FONT_SIZE;
  const dimFont = isNarrow ? LABEL_WRAP_FONT_SIZE : LABEL_DIMENSION_FONT_SIZE;
  const textMaxWidth = Math.max(4, item.width - 6);

  /** Due righe centrate con i `dy` identici al rendering a schermo. */
  const twoLineText = (content: [string, string], fontSize: number): string =>
    `<text x="${round(centerX)}" y="${round(centerY)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${round(
      fontSize
    )}" font-weight="bold" fill="${COLORS.name}"><tspan x="${round(centerX)}" dy="-6">${escapeXml(
      content[0]
    )}</tspan><tspan x="${round(centerX)}" dy="13">${escapeXml(content[1])}</tspan></text>`;

  if (labelDensity === 'client') {
    if (lines) return twoLineText(lines, nameFont);

    const label = escapeXml(truncateToWidth(item.name, textMaxWidth, nameFont));
    return `<text x="${round(centerX)}" y="${round(centerY + nameFont * 0.35)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${round(nameFont)}" font-weight="bold" fill="${COLORS.name}">${label}</text>`;
  }

  if (labelDensity === 'dimensions') {
    const label = `${item.width}×${item.length}`;
    return `<text x="${round(centerX)}" y="${round(centerY + nameFont * 0.35)}" text-anchor="middle" font-family="${MONO_FONT_FAMILY}" font-size="${round(nameFont)}" font-weight="bold" fill="${COLORS.dimensions}">${label}</text>`;
  }

  // Densità `all`: nome (su una o due righe) sopra, quote sotto.
  const dimensions = `${item.width}×${item.length}`;

  if (lines) {
    return `<text x="${round(centerX)}" y="${round(centerY)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${round(
      nameFont
    )}" font-weight="bold" fill="${COLORS.name}"><tspan x="${round(centerX)}" dy="-6">${escapeXml(
      lines[0]
    )}</tspan><tspan x="${round(centerX)}" dy="13">${escapeXml(
      lines[1]
    )}</tspan><tspan x="${round(centerX)}" dy="12" font-family="${MONO_FONT_FAMILY}" font-size="${round(
      dimFont
    )}" font-weight="normal" fill="${COLORS.dimensions}">${dimensions}</tspan></text>`;
  }

  const name = escapeXml(truncateToWidth(item.name, textMaxWidth, nameFont));
  return [
    `<text x="${round(centerX)}" y="${round(centerY - dimFont * 0.6 + nameFont * 0.35)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${round(nameFont)}" font-weight="bold" fill="${COLORS.name}">${name}</text>`,
    `<text x="${round(centerX)}" y="${round(centerY + nameFont * 0.6 + dimFont * 0.35)}" text-anchor="middle" font-family="${MONO_FONT_FAMILY}" font-size="${round(dimFont)}" fill="${COLORS.dimensions}">${dimensions}</text>`,
  ].join('');
};

/**
 * Rettangolo colorato del collo (fill pastello + bordo di catalogo).
 * Il ROSSO è riservato alle sole condizioni di allarme (collisione / fuori
 * sagoma), esattamente come sul canvas a schermo.
 */
const renderItem = (
  item: PlacedItem,
  items: PlacedItem[],
  vehicle: VehicleConfig,
  labelDensity: LabelDensity
): string => {
  const isAlert = hasCollision(item, items) || isOutOfBounds(item, vehicle);
  const stroke = isAlert ? COLORS.alert : item.borderColor;
  const strokeWidth = isAlert ? 2 : 1.5;

  return [
    `<g transform="translate(${round(item.x)}, ${round(item.y)})">`,
    `<rect width="${round(item.width)}" height="${round(item.length)}" rx="2" fill="${item.color}" stroke="${stroke}" stroke-width="${strokeWidth}"/>`,
    `<g clip-path="url(#${clipIdForItem(item.id)})">${renderItemLabels(item, labelDensity)}</g>`,
    `</g>`,
  ].join('');
};

/** ID del `clipPath` che ritaglia il testo di una nota sul proprio box. */
export const noteClipId = (noteId: string): string => `note-clip-${noteId}`;

/**
 * Note laterali nello snapshot SVG: una card per nota, **alle proprie coordinate
 * 2D** (`note.x`, `note.y` in cm reali) e con la stessa geometria del canvas a
 * schermo, così l'immagine condivisa su WhatsApp riporta le istruzioni operative
 * esattamente dove le ha posizionate il disponente (a destra del camion, a
 * sinistra, lungo il pianale o in coda).
 *
 * Ogni card contiene un **unico testo** (`content`) mandato a capo in `<tspan>`
 * a coordinate relative all'origine del box (`x = 10` cm): larghezza, altezza e
 * corpo del testo sono quelli scelti dall'operatore. **Nessun bordo**: lo
 * snapshot non ha selezione, quindi la card è puro testo fluttuante.
 *
 * @param notes Note da disegnare, nell'ordine di creazione
 */
const renderNotes = (notes: SideNote[]): string => {
  const layouts = resolveNoteLayouts(notes);

  // Clip solo dove serve: un box più basso del testo (altezza fissata a mano)
  // non deve far uscire le righe di troppo dalla sagoma colorata.
  const clipped = layouts.filter((layout) => layout.textHeight > layout.height);
  const defs =
    clipped.length > 0
      ? `<defs>${clipped
          .map(
            ({ note, height }) =>
              `<clipPath id="${noteClipId(note.id)}"><rect width="${round(
                note.width
              )}" height="${round(height)}"/></clipPath>`
          )
          .join('')}</defs>`
      : '';

  const cards = layouts
    .map(({ note, height, lines, fontSize, firstBaselineCm, lineHeightCm, textHeight }) => {
      const body = lines
        .map(
          (line, index) =>
            `<tspan x="${round(NOTE_PADDING_CM)}" y="${round(
              firstBaselineCm + index * lineHeightCm
            )}">${escapeXml(line)}</tspan>`
        )
        .join('');

      const text = `<text font-family="${FONT_FAMILY}" font-size="${round(
        fontSize
      )}" fill="${COLORS.dimensions}">${body}</text>`;

      return [
        `<g transform="translate(${round(note.x)}, ${round(note.y)})">`,
        `<rect width="${round(note.width)}" height="${round(
          height
        )}" rx="4" fill="${note.color}"/>`,
        textHeight > height
          ? `<g clip-path="url(#${noteClipId(note.id)})">${text}</g>`
          : text,
        `</g>`,
      ].join('');
    })
    .join('');

  return `${defs}${cards}`;
};

/**
 * Badge Targa / Identificativo Mezzo nello snapshot SVG.
 *
 * Stessa card vettoriale del canvas a schermo (geometria dal modulo condiviso
 * `utils/plateBadge.ts`): rettangolo `rx=3` con sfondo `#F8FAFC` e bordo
 * antracite, centrato sull'asse del pianale nella fascia `-48 … -28 cm`.
 * Con targa vuota il bordo diventa tratteggiato e compare il segnaposto
 * `[ TARGA / IDENTIFICATIVO ]` in grigio; con targa digitata il testo è in
 * maiuscolo monospaziato in grassetto.
 *
 * @param vehicle Configurazione del mezzo (per larghezza e centratura)
 * @param plate   Targa / identificativo digitato dall'operatore
 */
const renderPlateBadge = (vehicle: VehicleConfig, plate: string): string => {
  const badge = plateBadgeLayout(vehicle.width, plate);
  const dash = badge.hasPlate ? '' : ` stroke-dasharray="${PLATE_BADGE_BORDER_DASH}"`;
  const textColor = badge.hasPlate ? PLATE_BADGE_TEXT_COLOR : PLATE_BADGE_PLACEHOLDER_COLOR;

  return [
    `<g id="export-plate-badge">`,
    `<rect x="${round(badge.x)}" y="${round(badge.top)}" width="${round(
      badge.width
    )}" height="${round(badge.height)}" rx="${PLATE_BADGE_CORNER_RADIUS_CM}" fill="${
      PLATE_BADGE_FILL
    }" stroke="${PLATE_BADGE_BORDER_COLOR}" stroke-width="${PLATE_BADGE_BORDER_WIDTH}"${dash}/>`,
    `<text x="${round(badge.centerX)}" y="${round(
      badge.centerY
    )}" text-anchor="middle" dominant-baseline="middle" font-family="${
      PLATE_BADGE_FONT_FAMILY
    }" font-size="${round(badge.fontSize)}" font-weight="bold" fill="${textColor}">${escapeXml(
      badge.label
    )}</text>`,
    `</g>`,
  ].join('');
};

/**
 * Costruisce lo snapshot SVG autonomo e pulito del pianale.
 *
 * Contenuto (in cm reali, Y = 0 in alto verso la Cabina):
 * sfondo bianco, piano di carico, tacche metriche ogni metro, quota nominale
 * 13,20 m (sui mezzi che la raggiungono), linea guida e badge del contatore
 * dinamico LDM, tutti i colli con colore/bordo/testo ritagliato dal proprio
 * clipPath, le note laterali **alle loro coordinate 2D** (se presenti), il badge
 * **targa / identificativo mezzo** sopra la Cabina, sponde laterali, parete
 * Cabina, linea tratteggiata delle porte posteriori e didascalie. Nessun
 * elemento di interfaccia.
 *
 * @param vehicle      Configurazione del mezzo
 * @param items        Colli stivati
 * @param labelDensity Densità delle etichette (`all` | `client` | `dimensions` | `minimal`)
 * @param notes        Note laterali di carico da includere nell'immagine
 * @param plate        Targa / identificativo del mezzo (default: segnaposto)
 */
export const buildPianoSvg = (
  vehicle: VehicleConfig,
  items: PlacedItem[],
  labelDensity: LabelDensity,
  notes: SideNote[] = [],
  plate: string = ''
): PianoSnapshot => {
  const extent = getPianoExtent(vehicle, items, labelDensity, notes);
  const pxPerCm = EXPORT_BASE_WIDTH / extent.width;
  const height = Math.max(1, Math.round(extent.height * pxPerCm));

  const parts: string[] = [];

  // Sfondo bianco pieno (lo snapshot deve restare leggibile su qualsiasi chat).
  parts.push(
    `<rect x="${extent.minX}" y="${extent.minY}" width="${round(extent.width)}" height="${round(
      extent.height
    )}" fill="${COLORS.background}"/>`
  );

  // Piano di carico utile (leggera campitura, silhouette leggibile).
  parts.push(
    `<rect x="0" y="0" width="${vehicle.width}" height="${vehicle.length}" rx="2" fill="${COLORS.deck}"/>`
  );

  // Definizioni: un clipPath per collo, così il testo non può sbordare.
  if (items.length > 0) {
    parts.push(
      `<defs>${items
        .map(
          (item) =>
            `<clipPath id="${clipIdForItem(item.id)}"><rect width="${round(
              item.width
            )}" height="${round(item.length)}"/></clipPath>`
        )
        .join('')}</defs>`
    );
  }

  // Tacche metriche: linea ogni metro + quota a sinistra del pianale.
  for (let y = 100; y < vehicle.length; y += 100) {
    parts.push(
      `<line x1="0" y1="${y}" x2="${vehicle.width}" y2="${y}" stroke="${COLORS.grid}" stroke-width="1" stroke-dasharray="4 4"/>`,
      `<text x="-4" y="${round(y + FONT.meter * 0.35)}" text-anchor="end" font-family="${MONO_FONT_FAMILY}" font-size="${FONT.meter}" fill="${COLORS.gridText}">${y / 100}m</text>`
    );
  }

  // Quota nominale 13,20 m: linea netta + dicitura nel righello sinistro.
  if (vehicle.length >= NOMINAL_QUOTA_CM) {
    parts.push(
      `<line x1="0" y1="${NOMINAL_QUOTA_CM}" x2="${vehicle.width}" y2="${NOMINAL_QUOTA_CM}" stroke="${COLORS.nominalQuota}" stroke-width="1.5" stroke-dasharray="6 3"/>`,
      `<text x="-4" y="${round(
        NOMINAL_QUOTA_CM + FONT.meter * 0.4
      )}" text-anchor="end" font-family="${MONO_FONT_FAMILY}" font-size="${FONT.meter}" font-weight="bold" fill="${COLORS.caption}">13.20m</text>`
    );
  }

  // Contatore dinamico LDM (metri lineari occupati), dalla funzione pura
  // condivisa `calculateLdmMetrics` (Regola della Corsia di Parete): carico
  // simmetrico → singolo indicatore a sinistra con linea guida continua; carico
  // asimmetrico → due indicatori tratteggiati (metà SX e metà DX), con il lato
  // più carico in scuro primario e quello meno carico in slate intermedio. Con
  // densità `minimal` l'immagine resta pulita: nessuna linea e nessun badge.
  const ldm = calculateLdmMetrics(vehicle, items);
  const maxOccupiedY = ldm.maxOccupiedY;
  /** Asse di mezzeria del pianale (cm): separa i due indicatori asimmetrici. */
  const ldmMidX = vehicle.width / 2;

  if (labelDensity !== 'minimal' && maxOccupiedY > 0) {
    const leftBadgeColor = ldm.leftY >= ldm.rightY ? COLORS.ldmBadge : COLORS.ldmBadgeMuted;
    const rightBadgeColor = ldm.leftY >= ldm.rightY ? COLORS.ldmBadgeMuted : COLORS.ldmBadge;

    /** Badge rettangolare + dicitura, alla Y indicata. */
    const badge = (x: number, centerX: number, y: number, label: string, fill: string): string =>
      `<rect x="${round(x)}" y="${round(y - LDM_BADGE.height / 2)}" width="${
        LDM_BADGE.width
      }" height="${LDM_BADGE.height}" rx="3" fill="${fill}"/><text x="${round(
        centerX
      )}" y="${round(y + 3.5)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${
        FONT.meter
      }" font-weight="bold" fill="${COLORS.ldmBadgeText}">${label}</text>`;

    if (!ldm.isAsymmetric) {
      // Linea guida continua a tutta larghezza + badge scuro nel righello sinistro.
      parts.push(
        `<line x1="0" y1="${round(maxOccupiedY)}" x2="${vehicle.width}" y2="${round(
          maxOccupiedY
        )}" stroke="${COLORS.ldmGuide}" stroke-width="1"/>`,
        badge(
          LDM_BADGE_LEFT_X,
          LDM_BADGE_CENTER_X,
          maxOccupiedY,
          `▶ ${(maxOccupiedY / 100).toFixed(2)} m`,
          COLORS.ldmBadge
        )
      );
    } else {
      // Lato sinistro: linea tratteggiata 0 → mezzeria, badge nel righello sinistro.
      // Il segmento pieno finale evita che il tratteggio lasci la linea sospesa.
      parts.push(
        `<line x1="0" y1="${round(ldm.leftY)}" x2="${round(ldmMidX)}" y2="${round(
          ldm.leftY
        )}" stroke="${COLORS.ldmGuide}" stroke-width="1" stroke-dasharray="${LDM_GUIDE_DASH}"/>`,
        `<line x1="${round(Math.max(0, ldmMidX - LDM_GUIDE_CLOSING_LENGTH))}" y1="${round(
          ldm.leftY
        )}" x2="${round(ldmMidX)}" y2="${round(ldm.leftY)}" stroke="${
          COLORS.ldmGuide
        }" stroke-width="1"/>`,
        badge(
          LDM_BADGE_LEFT_X,
          LDM_BADGE_CENTER_X,
          ldm.leftY,
          `▶ ${(ldm.leftY / 100).toFixed(2)} m`,
          leftBadgeColor
        )
      );

      // Lato destro: linea tratteggiata mezzeria → parete, badge OLTRE la parete.
      parts.push(
        `<line x1="${round(ldmMidX)}" y1="${round(ldm.rightY)}" x2="${
          vehicle.width
        }" y2="${round(ldm.rightY)}" stroke="${COLORS.ldmGuide}" stroke-width="1" stroke-dasharray="${LDM_GUIDE_DASH}"/>`,
        `<line x1="${round(
          Math.max(ldmMidX, vehicle.width - LDM_GUIDE_CLOSING_LENGTH)
        )}" y1="${round(ldm.rightY)}" x2="${vehicle.width}" y2="${round(
          ldm.rightY
        )}" stroke="${COLORS.ldmGuide}" stroke-width="1"/>`,
        badge(
          ldmBadgeRightLeftX(vehicle.width),
          ldmBadgeRightCenterX(vehicle.width),
          ldm.rightY,
          `◀ ${(ldm.rightY / 100).toFixed(2)} m`,
          rightBadgeColor
        )
      );
    }
  }

  // Colli stivati: colore, bordo e testo formattato secondo la densità.
  for (const item of items) parts.push(renderItem(item, items, vehicle, labelDensity));

  // Note laterali di carico: alle proprie coordinate 2D, anche a sinistra del
  // semirimorchio. Nessun contorno (né blu di selezione né bordo a riposo).
  if (notes.length > 0) parts.push(renderNotes(notes));

  // Sponde laterali e parete Cabina.
  parts.push(
    `<line x1="0" y1="0" x2="${vehicle.width}" y2="0" stroke="${COLORS.wall}" stroke-width="4"/>`,
    `<line x1="0" y1="0" x2="0" y2="${vehicle.length}" stroke="${COLORS.wall}" stroke-width="3"/>`,
    `<line x1="${vehicle.width}" y1="0" x2="${vehicle.width}" y2="${vehicle.length}" stroke="${COLORS.wall}" stroke-width="3"/>`
  );

  // Porte posteriori: linea tratteggiata alla fine del pianale utile.
  parts.push(
    `<line x1="0" y1="${vehicle.length}" x2="${vehicle.width}" y2="${vehicle.length}" stroke="${COLORS.wall}" stroke-width="3" stroke-dasharray="16 8"/>`
  );

  // Badge targa / identificativo mezzo: card tecnica sopra la Cabina, con la
  // stessa geometria del canvas a schermo (fascia `-48 … -28 cm`).
  parts.push(renderPlateBadge(vehicle, plate));

  // Intestazioni e quote. La didascalia `▲ CABINA ▲` vive SOTTO la card targa,
  // quindi ha una quota fissa condivisa (non più relativa al bordo superiore
  // dell'inquadratura, che ora è occupato dal badge).
  parts.push(
    `<text x="${vehicle.width / 2}" y="${CABINA_CAPTION_BASELINE_CM}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${FONT.caption}" font-weight="bold" fill="${COLORS.caption}">▲ CABINA ▲</text>`,
    `<text x="${vehicle.width / 2}" y="${WIDTH_QUOTA_BASELINE_CM}" text-anchor="middle" font-family="${MONO_FONT_FAMILY}" font-size="${FONT.quota}" fill="${COLORS.gridText}">${vehicle.width} cm</text>`,
    `<text x="${vehicle.width / 2}" y="${round(extent.doorLabelY)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${FONT.caption * 0.93}" font-weight="bold" fill="${COLORS.caption}">PORTE POSTERIORI</text>`
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${EXPORT_BASE_WIDTH}" height="${height}" viewBox="${extent.minX} ${extent.minY} ${round(
    extent.width
  )} ${round(extent.height)}"><title>Piano di carico ${escapeXml(vehicle.name)}</title>${parts.join(
    ''
  )}</svg>`;

  return { svg, width: EXPORT_BASE_WIDTH, height };
};

/**
 * Rasterizza una stringa SVG in un blob PNG tramite canvas HTML5 offscreen.
 *
 * Il canvas lavora a `EXPORT_PIXEL_RATIO`x (2x) per garantire nitidezza su
 * schermi Retina e in zoom; il fattore viene ridotto automaticamente solo se
 * l'area risultante supererebbe i limiti di canvas del browser.
 *
 * @param snapshot SVG autonomo + dimensioni logiche in px CSS
 */
export const rasterizeSnapshotToPng = (snapshot: PianoSnapshot): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const { svg, width, height } = snapshot;

    const maxRatio = Math.sqrt(MAX_CANVAS_AREA / Math.max(1, width * height));
    const ratio = Math.max(1, Math.min(EXPORT_PIXEL_RATIO, maxRatio));

    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const objectUrl = URL.createObjectURL(svgBlob);
    const image = new Image();

    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Contesto canvas 2D non disponibile');

        // Sfondo esplicito: il PNG non deve avere trasparenze inattese.
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(objectUrl);
            if (blob) resolve(blob);
            else reject(new Error('Conversione PNG fallita'));
          },
          'image/png'
        );
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        reject(error);
      }
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Rendering SVG fallito'));
    };

    image.src = objectUrl;
  });

/** Scarica un blob come file, con il nome indicato. */
const downloadBlob = (blob: Blob, fileName: string): void => {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoca differita: Safari ha bisogno che il click sia già stato processato.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
};

/**
 * Copia negli appunti di sistema lo snapshot PNG ad alta risoluzione del
 * pianale (per WhatsApp / Mail). Se l'API Clipboard non è disponibile o viene
 * negata (permessi, contesto non sicuro, browser non compatibile), scarica
 * automaticamente il file `piano-di-carico.png`.
 *
 * Non lancia mai: restituisce sempre un esito booleano.
 *
 * @param vehicle      Configurazione del mezzo
 * @param items        Colli stivati
 * @param labelDensity Densità delle etichette applicata allo snapshot
 * @param notes        Note laterali di carico da riportare nell'immagine
 * @param plate        Targa / identificativo del mezzo, riportato nel badge
 * @returns `true` se l'immagine è finita negli appunti, `false` se è stata scaricata
 */
export const copyCanvasToClipboard = async (
  vehicle: VehicleConfig,
  items: PlacedItem[],
  labelDensity: LabelDensity,
  notes: SideNote[] = [],
  plate: string = ''
): Promise<boolean> => {
  let pngBlob: Blob;

  try {
    pngBlob = await rasterizeSnapshotToPng(
      buildPianoSvg(vehicle, items, labelDensity, notes, plate)
    );
  } catch (error) {
    console.error('[export] Generazione dello snapshot PNG non riuscita:', error);
    return false;
  }

  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      throw new Error('Clipboard API non disponibile');
    }

    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    return true;
  } catch (error) {
    // Fallback silenzioso: permessi limitati o API assente → download del PNG.
    console.warn('[export] Copia negli appunti non disponibile, scarico il file:', error);
    downloadBlob(pngBlob, FALLBACK_FILE_NAME);
    return false;
  }
};
