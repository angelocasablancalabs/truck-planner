import React, { useEffect, useRef, useState } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import type {
  PlacedItem,
  ItemPositionUpdate,
  LabelDensity,
  SideNote,
  DeckBay,
} from '../types';
import {
  calculateLdmMetrics,
  calculateSnapPosition,
  formatLdmMeters,
  hasCollision,
  isOutOfBounds,
  isRectColliding,
  toPrecision,
  REAR_OVERHANG_LIMIT,
} from '../utils/snapping';
import {
  ALERT_COLOR,
  LDM_BADGE,
  LDM_BADGE_CENTER_X,
  LDM_BADGE_COLOR,
  LDM_BADGE_LEFT_X,
  LDM_BADGE_MUTED_COLOR,
  LDM_GUIDE_CLOSING_LENGTH,
  LDM_GUIDE_COLOR,
  LDM_GUIDE_DASH,
  NOMINAL_QUOTA_CM,
  NOMINAL_QUOTA_COLOR,
  ldmBadgeRightCenterX,
  ldmBadgeRightLeftX,
} from '../constants';
import {
  clipIdForItem,
  NARROW_ITEM_WIDTH_CM,
  shouldWrapLabel,
  splitLabelIntoTwoLines,
} from '../utils/labels';
import {
  NOTE_MAX_HEIGHT_CM,
  NOTE_MAX_WIDTH_CM,
  NOTE_MIN_HEIGHT_CM,
  NOTE_MIN_WIDTH_CM,
  NOTE_PADDING_CM,
  NOTE_RESIZE_HANDLE_COLOR,
  NOTE_RESIZE_HANDLE_SIZE_CM,
  noteMaxX,
  noteMinX,
  resolveNoteLayouts,
} from '../utils/sideNotes';
import {
  CABINA_CAPTION_BASELINE_CM,
  CABINA_CAPTION_FONT_SIZE,
  PLATE_BADGE_FONT_FAMILY,
  PLATE_BADGE_LETTER_SPACING_EM,
  PLATE_BADGE_TEXT_COLOR,
  PLATE_BADGE_TOP_CM,
  PLATE_INPUT_ID,
  WIDTH_QUOTA_BASELINE_CM,
  plateBadgeLayout,
} from '../utils/plateBadge';
import {
  BAY_HEADER_BG,
  BAY_HEADER_BG_ACTIVE,
  BAY_HEADER_BORDER,
  BAY_HEADER_BORDER_ACTIVE,
  BAY_HEADER_BOTTOM_CM,
  BAY_HEADER_HEIGHT_CM,
  BAY_HEADER_PADDING_CM,
  BAY_HEADER_TEXT,
  BAY_HEADER_TEXT_ACTIVE,
  BAY_HEADER_TITLE_FONT_CM,
  BAY_HEADER_TOP_CM,
  BAY_HEADER_WIDTH_CM,
  bayLabel,
  bayOffsets,
} from '../utils/bays';

/** Colori del rettangolo di selezione (lasso) e della selezione attiva. */
const SELECTION_COLOR = '#2563EB';
const LASSO_FILL = '#3B82F6';
const LASSO_FILL_OPACITY = 0.15;

/* --- DRAG OVERLAY CROSS-PIANALE ------------------------------------------- */

/** Opacità della sagoma "fantasma" lasciata nello stallo di partenza. */
const GHOST_OPACITY = 0.35;

/** Tratteggio del bordo dei colli fantasma rimasti nello stallo di partenza. */
const GHOST_DASH = '4 2';

/** Opacità dei colli in transito nel canale neutro fra due stalli. */
const TRANSIT_OPACITY = 0.75;

/** Colore d'allarme del collo in transito (nessuno stallo sotto il cursore). */
const TRANSIT_COLOR = '#F59E0B';

/**
 * Spessore (cm) del contorno di evidenziazione del pianale bersaglio. Il tratto
 * vive alle coordinate reali del pianale, quindi cresce con lo zoom: 6 cm
 * restano leggibili sia nella vista d'insieme della flotta sia a forte zoom.
 */
const DROP_HIGHLIGHT_STROKE_CM = 6;

/**
 * Colore del bordo dei **colli in movimento** del Drag Overlay: bianco puro,
 * così il blocco trascinato resta distinto dai colli già stivati (bordo
 * antracite `ITEM_BORDER_COLOR`) senza introdurre una terza tinta di stato —
 * rosso = allarme, blu = selezione, ambra = transito nel canale neutro.
 */
const DRAG_OVERLAY_BORDER = '#FFFFFF';

/**
 * Membro sintetico del Drag Overlay.
 *
 * I membri del gesto vengono "congelati" al `pointerDown` con le sole misure e
 * le coordinate di partenza; il collo vivo (nome, tinta, rotazione) può nel
 * frattempo uscire dalla lista dello stallo di origine — accade puntualmente nel
 * trasferimento cross-pianale, dove al rilascio il collo cambia pianale. Questo
 * segnaposto garantisce che il disegno del blocco in movimento non dipenda mai
 * dalla presenza del collo nella stiva corrente: il rettangolo conserva misure e
 * geometria esatte, mentre le etichette (nome e quote) degradano con eleganza.
 */
const toOverlayPlaceholder = (member: {
  id: string;
  width: number;
  length: number;
}): PlacedItem => ({
  id: member.id,
  code: '',
  name: '',
  width: member.width,
  length: member.length,
  x: 0,
  y: 0,
  rotation: 0,
  color: '#E2E8F0',
  borderColor: '#334155',
});

/** Font di sistema delle etichette dell'header dello stallo (SVG). */
const FONT_FAMILY_LABEL = 'Helvetica, Arial, sans-serif';

/**
 * Spostamento minimo (px schermo) oltre il quale un drag non è più un click.
 */
const DRAG_THRESHOLD_PX = 3;

/** Spostamento minimo (cm reali) perché il drag di una nota sia registrato. */
const NOTE_DRAG_THRESHOLD_CM = 0.2;

/** ID del `clipPath` che ritaglia il testo di una nota sul proprio box. */
const clipIdForNote = (noteId: string): string => `note-clip-${noteId}`;

/* --- Clamp rigido intelligente del pan (asse Y) --------------------------- */
/** Margine (px) riservato in alto all'header dello stallo e alla targa. */
const PAN_TOP_MARGIN_PX = 40;
/** Margine (px) riservato in basso alla didascalia "PORTE POSTERIORI". */
const PAN_BOTTOM_MARGIN_PX = 50;
/**
 * Altezza (cm reali) della fascia sopra la Cabina occupata dall'**header dello
 * stallo**, dal testo della targa (corpo base 30 px), dalla didascalia
 * `▲ CABINA ▲` e dalle quote: a zoom elevato questa distanza cresce in pixel e
 * gli elementi uscivano tagliati fuori dal bordo alto del viewport. È **derivata**
 * dal modulo condiviso `utils/bays.ts` (header) e `utils/plateBadge.ts` (targa):
 * il punto più alto in assoluto è il bordo superiore dell'header, quindi
 * ingrandire ancora il corpo della targa non può più tagliarne la cima.
 */
const CABINA_LABEL_OFFSET_CM = -Math.min(BAY_HEADER_TOP_CM, PLATE_BADGE_TOP_CM);

/**
 * Altezza logica (cm) della scena **sopra la Cabina**: la fascia che ospita
 * l'header dello stallo, la targa e le didascalie.
 *
 * `fitView` e il clamp del pan lavorano sull'**altezza logica complessiva**
 * (`layoutLength + CABINA_ELEVATION_CM`), non sulla sola lunghezza del mezzo:
 * senza questo margine l'inquadratura "adatta a schermo" taglierebbe fuori
 * proprio l'intestazione degli stalli. Il difetto non si vede con un solo mezzo
 * (dove la fascia resta a schermo per via del padding) ma diventa evidente con
 * più mezzi affiancati, perché lo zoom d'insieme è più basso.
 */
const CABINA_ELEVATION_CM = CABINA_LABEL_OFFSET_CM;
/**
 * Ingombro verticale (cm) delle didascalie, sommato alla lunghezza del mezzo
 * per decidere se il pianale entra interamente nello schermo (Caso A).
 *
 * Vale il **doppio** della fascia di intestazione: nel Caso A la centrale è
 * centrata e metà del margine finisce sopra la Cabina, quindi servono almeno
 * `2 × CABINA_LABEL_OFFSET_CM` perché l'header dello stallo e la targa non
 * vengano mai tagliati dal bordo alto anche nella condizione limite
 * `(L + margine) × zoom = containerH`.
 */
const PAN_LABEL_MARGIN_CM = 2 * CABINA_LABEL_OFFSET_CM;

/**
 * Clamp rigido intelligente del pan verticale: elimina lo spazio vuoto grigio
 * sopra la Cabina e sotto le Porte posteriori.
 *
 * L'altezza del disegno non è più la sola `vehicle.length` ma la **quota di
 * fondo dinamica** `effectiveLength = max(vehicle.length, maxItemBottom)`: se un
 * collo sfora oltre le porte posteriori la corsa si estende fino a includerlo,
 * mentre a pianale in sagoma (`effectiveLength === vehicle.length`) il
 * comportamento resta identico al passato.
 *
 * - **Caso A** — il camion (compresi gli eventuali colli sbordati) entra
 *   interamente nell'altezza dello schermo
 *   (`(effectiveLength + PAN_LABEL_MARGIN_CM) * zoom <= containerH`): il pianale
 *   resta centrato verticalmente nel viewport e non può scivolare via.
 * - **Caso B** — il camion è più lungo dello schermo (zoom elevato): la Cabina
 *   si arresta a ridosso del bordo alto (`maxPanY = 40 + offset × zoom`, che
 *   tiene dentro anche l'header dello stallo, il badge targa e la didascalia
 *   `▲ CABINA ▲`) e le Porte posteriori a ridosso di quello basso
 *   (`minPanY = containerH - 50 - effectiveLength * zoom`).
 */
const clampPanY = (
  panY: number,
  zoom: number,
  effectiveLength: number,
  containerH: number
): number => {
  const truckTotalHeightPx = (effectiveLength + PAN_LABEL_MARGIN_CM) * zoom;

  // Caso A: il camion entra interamente nello schermo → pianale centrato sul
  // proprio ingombro effettivo (colli sbordati inclusi).
  if (truckTotalHeightPx <= containerH) {
    return (containerH - effectiveLength * zoom) / 2;
  }

  // Caso B: il camion è più lungo dello schermo → clamp rigoroso ai due bordi.
  const maxPanY = PAN_TOP_MARGIN_PX + CABINA_LABEL_OFFSET_CM * zoom;
  const minPanY = containerH - PAN_BOTTOM_MARGIN_PX - effectiveLength * zoom;
  return Math.max(minPanY, Math.min(maxPanY, panY));
};

/**
 * Opzioni del selettore di densità etichette nell'HUD (basso a sinistra).
 * Etichette volutamente brevi per un look sobrio CAD.
 */
const LABEL_DENSITY_OPTIONS: { value: LabelDensity; label: string; title: string }[] = [
  { value: 'all', label: 'Tutto', title: 'Nome cliente + quote (W × L)' },
  { value: 'client', label: 'Cliente', title: 'Solo nome cliente' },
  { value: 'dimensions', label: 'Misure', title: 'Solo quote (W × L)' },
  { value: 'minimal', label: 'Minimal', title: 'Nessuna etichetta' },
];

// --- Motore Zoom & Pan (viewport CAD "infinito") ----------------------------
/** Zoom minimo come rapporto rispetto alla vista "adatta a schermo" (0.6 = 60%). */
const MIN_ZOOM_RATIO = 0.6;
/** Zoom massimo come rapporto rispetto alla vista "adatta a schermo" (4 = 400%). */
const MAX_ZOOM_RATIO = 4;
/** Passo dei pulsanti HUD, come rapporto (0.2 = +20% per click). */
const ZOOM_STEP_RATIO = 0.2;
/** Sensibilità della rotellina: valori bassi = zoom più dolce. */
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
/** Spazio (px) riservato nel fit alle scritte CABINA / PORTE POSTERIORI. */
const FIT_PADDING_X = 80;
const FIT_PADDING_Y = 120;

interface Point {
  x: number;
  y: number;
}

interface ViewportSize {
  w: number;
  h: number;
}

/**
 * Vista vettoriale del pianale.
 * - `zoom`: px schermo per centimetro reale (1 unità SVG = 1 px, nessun viewBox).
 * - `pan`: origine del mondo in px, dall'angolo alto-sinistro dell'SVG.
 * - `fitZoom`: zoom della vista d'insieme, riferimento per il 100% dell'HUD.
 */
interface ViewTransform {
  zoom: number;
  pan: Point;
  fitZoom: number;
}

/**
 * Reset / Adatta a schermo: calcola lo zoom che fa entrare **l'intera centrale**
 * nel viewport — tutti i pianali affiancati con la loro intestazione (header
 * dello stallo, targa e didascalie) — e il pan che la centra esattamente.
 *
 * L'inquadratura è guidata da due soli numeri: la larghezza totale della scena
 * (`totalWidth`, cioè i soli pianali reali) e l'**altezza logica**
 * (`logicalLength`, cioè la lunghezza del mezzo più profondo più la fascia sopra
 * la Cabina). Con un solo mezzo il risultato coincide con la vista storica del
 * singolo pianale, intestazione compresa, e il mezzo torna a grandezza piena.
 */
const fitView = (
  totalWidth: number,
  logicalLength: number,
  viewport: ViewportSize
): ViewTransform => {
  const availableW = Math.max(1, viewport.w - FIT_PADDING_X);
  const availableH = Math.max(1, viewport.h - FIT_PADDING_Y);
  const safeWidth = Math.max(1, totalWidth);
  const safeLength = Math.max(1, logicalLength);
  const fitZoom = Math.max(0.01, Math.min(availableW / safeWidth, availableH / safeLength));

  return {
    zoom: fitZoom,
    pan: {
      x: (viewport.w - safeWidth * fitZoom) / 2,
      // La Cabina (Y = 0) lascia in alto la fascia dell'intestazione: il pianale
      // risulta così centrato sul proprio ingombro reale, header compreso.
      y: (viewport.h - safeLength * fitZoom) / 2 + CABINA_ELEVATION_CM * fitZoom,
    },
    fitZoom,
  };
};

/** Blocca lo zoom nell'intervallo 60%–400% della vista d'insieme. */
const clampZoom = (value: number, fitZoom: number): number =>
  Math.min(fitZoom * MAX_ZOOM_RATIO, Math.max(fitZoom * MIN_ZOOM_RATIO, value));

/**
 * Zoom ancorato a un punto dello schermo (px locali all'SVG): il punto sotto il
 * cursore resta fermo, come in CAD / Google Maps.
 *   newPan = mouse - (mouse - pan) * (newZoom / zoom)
 */
const zoomAroundPoint = (prev: ViewTransform, nextZoom: number, mouse: Point): ViewTransform => ({
  ...prev,
  zoom: nextZoom,
  pan: {
    x: mouse.x - (mouse.x - prev.pan.x) * (nextZoom / prev.zoom),
    y: mouse.y - (mouse.y - prev.pan.y) * (nextZoom / prev.zoom),
  },
});

/**
 * Stato del trascinamento (singolo o di gruppo).
 * Il gruppo è "congelato" al pointerdown: si memorizzano le posizioni di
 * partenza e si applica a tutti lo stesso delta (ΔX, ΔY), preservando le
 * posizioni relative.
 *
 * Dalla **Fase 2** il gesto non è più confinato al pianale di partenza: il
 * cursore viene seguito in **coordinate di mondo** (`startCursor`), così il
 * gruppo può attraversare il canale di 180 cm fra due stalli e agganciarsi a un
 * altro mezzo. Per questo lo stato ricorda lo stallo di origine e la sua
 * traslazione: servono a riportare il cursore nel sistema locale del pianale
 * che di volta in volta si trova sotto il puntatore.
 */
interface DragState {
  /** ID del collo afferrato dal puntatore (quello che guida lo snap). */
  primaryId: string;
  /** Stallo a cui appartiene il gruppo trascinato (le sue coordinate sono locali). */
  sourceBayId: string;
  /** Traslazione orizzontale (cm) dello stallo di partenza nel mondo. */
  sourceBayOffset: number;
  /**
   * Cursore al pointerdown in **cm di mondo** (origine = parete sinistra del
   * primo stallo): è il riferimento unico di `deltaX` / `deltaY`, valido sia
   * dentro il pianale di partenza sia nel canale fra due stalli.
   */
  startCursor: Point;
  /** Posizione di partenza del collo afferrato (cm, locali allo stallo). */
  startX: number;
  startY: number;
  primaryWidth: number;
  primaryLength: number;
  /** `true` appena il trascinamento ha davvero spostato il gruppo: è la
   *  condizione con cui il gesto viene convalidato nella cronologia. */
  moved: boolean;
  /** Tutti i membri trascinati (incluso il primario) con le posizioni iniziali. */
  members: {
    id: string;
    startX: number;
    startY: number;
    width: number;
    length: number;
  }[];
}

/**
 * Membro del **Drag Overlay**: il collo in movimento, la sua posizione di
 * **mondo** (dove viene disegnato) e la sua posizione **locale** rispetto allo
 * stallo che in questo istante si trova sotto il cursore (le coordinate che
 * verranno scritte nella stiva al rilascio).
 */
interface DragOverlayMember {
  item: PlacedItem;
  /** Ascissa (cm) nel mondo: `offset dello stallo bersaglio + localX`. */
  worldX: number;
  /** Quota (cm) nel mondo: identica a `localY` (gli stalli non si traslano in Y). */
  worldY: number;
  /** Ascissa (cm) locale allo stallo bersaglio: quella che verrà salvata. */
  localX: number;
  /** Quota (cm) locale allo stallo bersaglio: quella che verrà salvata. */
  localY: number;
}

/**
 * Stato del **Drag Overlay** (livello SVG globale in testa al DOM): vive solo
 * durante il trascinamento di colli e descrive il blocco in movimento.
 *
 * - `targetBayId === null` → il cursore è nel **canale di 180 cm** (o fuori
 *   sagoma): i colli volano liberi, non agganciati, e al rilascio scatta
 *   l'**annullamento elastico** (Opzione A: nessuna mutazione, nessun passo di
 *   Undo).
 * - `targetBayId === sourceBayId` → spostamento interno al pianale di partenza
 *   (stessa fisica di snap di sempre).
 * - `targetBayId !== sourceBayId` → **trasferimento cross-pianale**: al rilascio
 *   il blocco passa allo stallo bersaglio, che diventa il Mezzo Attivo.
 */
interface DragOverlayState {
  sourceBayId: string;
  /** Stallo sotto il cursore, oppure `null` nel canale di 180 cm. */
  targetBayId: string | null;
  /** Indice dello stallo bersaglio (`-1` quando `targetBayId` è `null`). */
  targetBayIndex: number;
  members: DragOverlayMember[];
}

/**
 * Stato del trascinamento di una nota laterale: la card si sposta **liberamente
 * in 2D** (`ΔX`, `ΔY` in cm reali), quindi può essere portata a sinistra del
 * rimorchio (`X < 0`), oltre la parete destra, lungo il pianale o in coda.
 */
interface NoteDragState {
  id: string;
  /** Traslazione orizzontale (cm) dello stallo di appartenenza della nota. */
  bayOffsetCm: number;
  /** Larghezza utile (cm) del mezzo: delimita lo spazio di lavoro della nota. */
  vehicleWidth: number;
  /** Cursore in cm reali **locali allo stallo** al momento del pointerdown. */
  startCursorX: number;
  startCursorY: number;
  /** Posizione di partenza della nota (cm, locali allo stallo). */
  startX: number;
  startY: number;
  /** Spostamento minimo (cm) che ha già promosso il gesto a trascinamento. */
  moved: boolean;
}

/**
 * Stato del ridimensionamento di una nota laterale: la maniglia vive
 * nell'angolo basso-destro della card, quindi trascinandola si aggiornano
 * larghezza e altezza del box (mai la quota Y, che resta quella della corsia).
 */
interface NoteResizeState {
  id: string;
  /** Traslazione orizzontale (cm) dello stallo di appartenenza della nota. */
  bayOffsetCm: number;
  /** Larghezza utile (cm) del mezzo a cui appartiene la nota. */
  vehicleWidth: number;
  /** Cursore in cm reali **locali allo stallo** al momento del pointerdown. */
  startCursorX: number;
  startCursorY: number;
  /** Dimensioni di partenza del box (cm). */
  startWidth: number;
  startHeight: number;
  /** `true` appena larghezza o altezza sono cambiate davvero. */
  moved: boolean;
}

interface TruckCanvasProps {
  /**
   * **Flotta** degli stalli affiancati (da 1 a `MAX_BAYS`): ogni mezzo è un mondo
   * a sé con il proprio pianale, i propri colli e le proprie note, su coordinate
   * **locali**. La traslazione orizzontale che li affianca vive in
   * `utils/bays.ts` ed è pura presentazione: nessuna coordinata salvata dipende
   * dalla posizione dello stallo nella scena.
   */
  bays: DeckBay[];
  /** Stallo attivo: unico bersaglio di sidebar e ispettore. */
  activeBayId: string;
  selectedItemIds: string[];
  /** Nota selezionata (null = nessuna): bordo blu sulla card e pannello sidebar. */
  selectedNoteId: string | null;
  /** Densità delle etichette stampate dentro i colli. */
  labelDensity: LabelDensity;
  onChangeLabelDensity: (density: LabelDensity) => void;
  /** Cambio del Mezzo Attivo (click sull'header dello stallo o sul suo pianale). */
  onSelectBay: (bayId: string) => void;
  onSelectItems: (ids: string[]) => void;
  /** Selezione di una nota (azzera la selezione dei colli). */
  onSelectNote: (id: string | null) => void;
  /** Trascinamento libero 2D di una nota (X e Y in cm reali). */
  onUpdateNotePos: (id: string, x: number, y: number) => void;
  /** Ridimensionamento della card di nota (larghezza / altezza in cm). */
  onUpdateNoteSize: (id: string, size: { width: number; height: number }) => void;
  onUpdateItemsPos: (updates: ItemPositionUpdate[]) => void;
  /**
   * **Trasferimento cross-pianale** (drag & drop fra due mezzi): sposta
   * atomicamente i colli indicati dallo stallo di partenza a quello bersaglio,
   * convertendo le `placements` (già in coordinate **locali** del bersaglio) e
   * rendendo il bersaglio il nuovo Mezzo Attivo. L'intero gesto è **un solo
   * passo** di Undo, convalidato dal canvas al `pointerUp`.
   */
  onTransferItems?: (
    sourceBayId: string,
    targetBayId: string,
    placements: ItemPositionUpdate[]
  ) => void;
  /**
   * Cronologia Undo / Redo — Regola del Drag:
   * il canvas apre il gesto al `pointerDown` (`onBeginHistoryGesture`), non
   * registra nulla durante il `pointerMove` e lo convalida al `pointerUp`
   * (`onCommitHistoryGesture(true)`) solo se il trascinamento ha cambiato
   * davvero le coordinate: l'intero drag vale così **un singolo passo** di Undo.
   */
  onBeginHistoryGesture: () => void;
  onCommitHistoryGesture: (changed: boolean) => void;
}

export const TruckCanvas: React.FC<TruckCanvasProps> = ({
  bays,
  activeBayId,
  selectedItemIds,
  selectedNoteId,
  labelDensity,
  onChangeLabelDensity,
  onSelectBay,
  onSelectItems,
  onSelectNote,
  onUpdateNotePos,
  onUpdateNoteSize,
  onUpdateItemsPos,
  onTransferItems,
  onBeginHistoryGesture,
  onCommitHistoryGesture,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingItem = useRef<DragState | null>(null);
  const draggingNote = useRef<NoteDragState | null>(null);
  const resizingNote = useRef<NoteResizeState | null>(null);
  const panningView = useRef<{ start: Point; pan: Point; moved: boolean } | null>(null);

  /**
   * **Drag Overlay**: descrive il blocco di colli attualmente in movimento fra
   * gli stalli (o nel canale neutro di 180 cm). Vive solo durante il gesto: è
   * alimentato da `handlePointerMove` e consumato da `handlePointerUp`, che da
   * qui ricava lo stallo bersaglio e le coordinate locali da salvare.
   */
  const [dragOverlay, setDragOverlay] = useState<DragOverlayState | null>(null);
  /**
   * Specchio del Drag Overlay in una `ref`: il `pointerUp` chiude il gesto sempre
   * sull'**ultimo** frame calcolato, senza dipendere dal fatto che React abbia
   * già ri-renderizzato dopo l'ultimo `pointerMove` (le due closure di evento
   * sono indipendenti).
   */
  const dragOverlayRef = useRef<DragOverlayState | null>(null);
  const applyDragOverlay = (next: DragOverlayState | null) => {
    dragOverlayRef.current = next;
    setDragOverlay(next);
  };

  // Lasso: vertice iniziale in cm reali + rettangolo in px schermo per il disegno.
  const lassoStart = useRef<Point | null>(null);
  const [lasso, setLasso] = useState<{ start: Point; current: Point } | null>(null);

  // Un pan o un lasso non devono essere interpretati come "click sullo sfondo"
  // (che azzera la selezione).
  const suppressBackgroundClick = useRef(false);

  // Dimensioni reali (px) del viewport, misurate sul container.
  const [viewport, setViewport] = useState<ViewportSize>({ w: 0, h: 0 });
  // Vista vettoriale: nasce "adatta a schermo" appena il container è misurato.
  const [view, setView] = useState<ViewTransform>({ zoom: 1, pan: { x: 0, y: 0 }, fitZoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const { zoom, pan, fitZoom } = view;

  // Calcolo delle tacche metriche ogni metro (100 cm).
  // Ogni stallo disegna le proprie: qui si prepara la sola sequenza delle quote.

  /**
   * NOTE LATERALI dello stallo attivo: posizionamento **liberamente 2D**. Di
   * default nascono a `X = vehicle.width + NOTE_LANE_OFFSET_CM` (subito a destra
   * della parete), ma possono essere trascinate ovunque attorno al camion — anche
   * a sinistra del rimorchio. Le card non entrano mai nel calcolo dei metri
   * lineari e nessuna viene spostata d'ufficio: `resolveNoteLayouts` si limita a
   * misurarle.
   */
  const selectedNoteIdSet = new Set(selectedNoteId ? [selectedNoteId] : []);
  /** Set degli ID selezionati: vale per il solo stallo attivo (selezione locale). */
  const selectedIdSet = new Set(selectedItemIds);
  /**
   * Set degli ID che compongono il blocco in movimento (Drag Overlay): nello
   * stallo di partenza quei colli vengono resi come **sagoma fantasma**, perché
   * a viaggiare è la copia disegnata nel layer globale.
   */
  const overlayMemberIdSet = new Set(
    (dragOverlay?.members ?? []).map((member) => member.item.id)
  );

  /* ------------------------------------------------------------------------ *
   *  GEOMETRIA DELLA CENTRALE MULTI-PIANALE
   *
   *  Ogni stallo è un mondo di coordinate **locali**: la traslazione che lo
   *  affianca (`bayOffsets`, da `utils/bays.ts`) è pura presentazione. Il modello
   *  di vista qui sotto precalcola, per ciascun mezzo, tutto ciò che serve al
   *  disegno (tacche metriche, quota nominale, contatore LDM, targa e note): il
   *  ciclo di rendering resta così una semplice lettura.
   * ------------------------------------------------------------------------ */
  const offsets = bayOffsets(bays);
  const activeBay = bays.find((bay) => bay.id === activeBayId) ?? bays[0];

  /**
   * Modello di vista di un singolo stallo: tutto ciò che dipende dalle sue
   * coordinate locali, già risolto una volta sola.
   */
  interface BayViewModel {
    bay: DeckBay;
    index: number;
    /** Traslazione orizzontale (cm) dello stallo nel mondo. */
    offset: number;
    items: PlacedItem[];
    notes: SideNote[];
    /** Tacche metriche ogni metro (cm). */
    meterMarkers: number[];
    /** `true` se il mezzo raggiunge la quota nominale di 13,20 m. */
    showsNominalQuota: boolean;
    /** Quota di fondo dinamica: `max(vehicle.length, ultimo collo sbordato)`. */
    effectiveLength: number;
    /** Metri lineari occupati, dalla funzione condivisa `calculateLdmMetrics`. */
    ldm: ReturnType<typeof calculateLdmMetrics>;
    showsLdmIndicator: boolean;
    ldmIsSymmetric: boolean;
    leftLdmBadgeColor: string;
    rightLdmBadgeColor: string;
    rightLdmBadgeLeftX: number;
    rightLdmBadgeCenterX: number;
    /** Badge targa (null a targa vuota): geometria dal modulo condiviso. */
    plateBadge: ReturnType<typeof plateBadgeLayout>;
    /** Card delle note laterali, con la stessa geometria delle tre rese. */
    noteLayouts: ReturnType<typeof resolveNoteLayouts>;
  }

  const bayViews: BayViewModel[] = bays.map((bay, index) => {
    const bayLdm = calculateLdmMetrics(bay.vehicle, bay.items);
    const maxItemBottom = bay.items.reduce((max, item) => Math.max(max, item.y + item.length), 0);
    // Lato più carico = badge scuro primario; lato meno carico = slate intermedio.
    const leftIsHeavier = bayLdm.leftY >= bayLdm.rightY;

    return {
      bay,
      index,
      offset: offsets[index],
      items: bay.items,
      notes: bay.notes,
      meterMarkers: Array.from(
        { length: Math.max(0, Math.ceil(bay.vehicle.length / 100) - 1) },
        (_, i) => (i + 1) * 100
      ).filter((y) => y < bay.vehicle.length),
      showsNominalQuota: bay.vehicle.length >= NOMINAL_QUOTA_CM,
      effectiveLength: Math.max(bay.vehicle.length, maxItemBottom),
      ldm: bayLdm,
      showsLdmIndicator: labelDensity !== 'minimal' && bayLdm.maxOccupiedY > 0,
      ldmIsSymmetric: !bayLdm.isAsymmetric,
      leftLdmBadgeColor: leftIsHeavier ? LDM_BADGE_COLOR : LDM_BADGE_MUTED_COLOR,
      rightLdmBadgeColor: leftIsHeavier ? LDM_BADGE_MUTED_COLOR : LDM_BADGE_COLOR,
      rightLdmBadgeLeftX: ldmBadgeRightLeftX(bay.vehicle.width),
      rightLdmBadgeCenterX: ldmBadgeRightCenterX(bay.vehicle.width),
      plateBadge: plateBadgeLayout(bay.vehicle.width, bay.plate),
      noteLayouts: resolveNoteLayouts(bay.notes),
    };
  });

  const activeBayView = bayViews.find((view) => view.bay.id === activeBay?.id) ?? bayViews[0];
  /**
   * Quota di fondo dinamica di riferimento per la vista: la più profonda fra i
   * mezzi in scena. Il pan verticale della centrale si estende così fino a
   * contenere anche il carico più lungo (o il collo sbordato più lontano).
   */
  const layoutLength = Math.max(0, ...bayViews.map((view) => view.effectiveLength));
  /**
   * Altezza logica della scena: pianale più profondo **più** la fascia sopra la
   * Cabina che ospita header dello stallo, targa e didascalie. È la misura su cui
   * si calcola lo zoom "adatta a schermo", così l'intestazione dei mezzi non
   * finisce mai fuori dal viewport.
   */
  const logicalLength = layoutLength + CABINA_ELEVATION_CM;

  /* --- Ingombro orizzontale della scena ----------------------------------- *
   *  Si contano **solo i pianali reali**: da X = 0 all'estremità destra
   *  dell'ultimo mezzo in flotta. Nessuno spazio viene riservato a un ipotetico
   *  stallo successivo, così con un solo camion l'inquadratura "adatta a
   *  schermo" lo riporta a grandezza piena e perfettamente centrato. I nuovi
   *  mezzi si aggiungono esclusivamente dal pulsante `+ Mezzo` della sidebar.
   * ------------------------------------------------------------------------ */
  const lastOffset = offsets[offsets.length - 1] ?? 0;
  const lastBay = bays[bays.length - 1];
  const totalWidth = lastBay ? lastOffset + lastBay.vehicle.width : 0;

  /**
   * Trascinamento di una nota: si aggiornano **entrambe** le coordinate in cm
   * reali (`ΔX`, `ΔY` dal pointerdown). La Y resta clampata tra 0 (Cabina) e la
   * quota di fondo dinamica `effectiveLength` (Porte posteriori o ultimo collo
   * sbordato); la X può invece andare a sinistra del rimorchio (`X < 0`) o oltre
   * la parete destra, entro lo spazio di lavoro `noteMinX` / `noteMaxX`.
   *
   * Le coordinate delle note sono **locali allo stallo**: il cursore di mondo
   * viene riportato in quel sistema sottraendo la traslazione `bayOffsetCm`.
   */
  const handleNotePointerDown = (
    note: SideNote,
    bayOffsetCm: number,
    vehicleWidth: number,
    e: React.PointerEvent
  ) => {
    if (e.button !== 0) return;
    // Il gesto è della nota: non deve né selezionare i colli né panare la vista.
    e.stopPropagation();

    const cursor = toCanvasCm(e.clientX, e.clientY);
    if (!cursor) return;
    const localX = cursor.x - bayOffsetCm;

    (e.target as Element).setPointerCapture(e.pointerId);
    onSelectNote(note.id);
    // Apre il gesto in cronologia: il fotogramma verrà convalidato al rilascio
    // solo se la nota si è davvero spostata (1 drag = 1 passo di Undo).
    onBeginHistoryGesture();
    draggingNote.current = {
      id: note.id,
      startCursorX: localX,
      startCursorY: cursor.y,
      startX: note.x,
      startY: note.y,
      bayOffsetCm,
      vehicleWidth,
      moved: false,
    };
  };

  /**
   * Pointerdown sulla maniglia di ridimensionamento (angolo basso-destro):
   * il gesto appartiene alla maniglia, quindi non trascina la card né fa pan
   * del canvas. Larghezza e altezza vengono poi aggiornate in `pointerMove`.
   */
  const handleNoteResizePointerDown = (
    note: SideNote,
    height: number,
    bayOffsetCm: number,
    vehicleWidth: number,
    e: React.PointerEvent
  ) => {
    if (e.button !== 0) return;
    // Doppia barriera: la maniglia non deve mai muovere la nota o la vista.
    e.stopPropagation();

    const cursor = toCanvasCm(e.clientX, e.clientY);
    if (!cursor) return;

    (e.target as Element).setPointerCapture(e.pointerId);
    onSelectNote(note.id);
    // Anche il ridimensionamento è un gesto unico agli occhi della cronologia.
    onBeginHistoryGesture();
    resizingNote.current = {
      id: note.id,
      startCursorX: cursor.x - bayOffsetCm,
      startCursorY: cursor.y,
      startWidth: note.width,
      startHeight: height,
      bayOffsetCm,
      vehicleWidth,
      moved: false,
    };
  };

  // --- Misura del viewport --------------------------------------------------
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setViewport((prev) =>
        prev.w === rect.width && prev.h === rect.height ? prev : { w: rect.width, h: rect.height }
      );
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** Misura "a richiesta" (usata dal reset, sempre aggiornata). */
  const measureViewport = (): ViewportSize => {
    const el = containerRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return { w: rect.width, h: rect.height };
    }
    return viewport;
  };

  /** Reset / Adatta: vista d'insieme completa della centrale, centrata. */
  const resetView = () => setView(fitView(totalWidth, logicalLength, measureViewport()));

  /**
   * Firma della **struttura della scena**: cambia quando cambia il numero di
   * stalli o le loro dimensioni — cioè ogni volta che l'inquadratura d'insieme
   * va rifatta. Il passaggio da un mezzo all'altro (stessa flotta) **non** la
   * cambia: la vista resta dove l'operatore l'ha lasciata.
   *
   * Nota: il clamp verticale fa parte del disegno, non della firma. Un carico
   * appena aggiunto non deve far saltare lo zoom: la corsa verticale viene
   * riallineata dal secondo effetto qui sotto.
   */
  const fitSignature = bays
    .map((bay) => `${bay.id}:${bay.vehicle.width}:${bay.vehicle.length}`)
    .join('|');
  const [fittedSignature, setFittedSignature] = useState<string | null>(null);
  const isViewportReady = viewport.w > 0 && viewport.h > 0;
  if (isViewportReady && fittedSignature !== fitSignature) {
    setFittedSignature(fitSignature);
    setView(fitView(totalWidth, logicalLength, viewport));
  }

  /**
   * Riallineamento alla quota di fondo dinamica (stesso pattern di
   * "aggiustamento dello stato durante il render"): quando il collo sbordato
   * viene eliminato — o rientra in sagoma — il limite inferiore torna a filo
   * PORTE POSTERIORI e la vista vi si riallinea subito, senza restare appesa
   * nello spazio grigio in attesa di un altro movimento di rotellina.
   */
  const [clampedLength, setClampedLength] = useState<number | null>(null);
  if (isViewportReady && clampedLength !== layoutLength) {
    setClampedLength(layoutLength);
    setView((prev) => {
      const clampedY = clampPanY(prev.pan.y, prev.zoom, layoutLength, viewport.h);
      if (clampedY === prev.pan.y) return prev;
      return { ...prev, pan: { ...prev.pan, y: clampedY } };
    });
  }

  // --- Conversioni di coordinate -------------------------------------------
  /** Posizione schermo → px locali all'SVG (1 unità SVG = 1 px, niente viewBox). */
  const toSvgPoint = (clientX: number, clientY: number): Point | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  /**
   * Posizione schermo → centimetri reali del pianale:
   *   cmX = (screenX - pan.x) / zoom
   * Lo snap magnetico e le collisioni lavorano quindi sempre in cm reali,
   * a qualunque livello di zoom o spostamento della vista.
   */
  const toCanvasCm = (clientX: number, clientY: number): Point | null => {
    const p = toSvgPoint(clientX, clientY);
    if (!p) return null;
    return { x: (p.x - pan.x) / zoom, y: (p.y - pan.y) / zoom };
  };

  // --- Rotellina: zoom ancorato al cursore ----------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    /** Normalizza le unità di delta (pixel, righe, pagine) dei vari device. */
    const normalizeDelta = (delta: number, mode: number): number =>
      mode === 1 ? delta * 16 : mode === 2 ? delta * 400 : delta;

    const handleWheel = (e: WheelEvent) => {
      // Blocca SEMPRE lo scroll e lo zoom nativo della pagina: listener non passivo.
      e.preventDefault();

      const containerHeight = container.getBoundingClientRect().height;

      // 1) Ctrl / Cmd + rotellina → Zoom fluido ancorato al cursore (stile CAD).
      //    Una volta applicato lo zoom, il pan Y viene riallineato dal clamp
      //    rigido: nessuno spazio vuoto compare sopra la Cabina o sotto le Porte.
      if (e.ctrlKey || e.metaKey) {
        const mouse = toSvgPoint(e.clientX, e.clientY);
        if (!mouse) return;

        const deltaY = normalizeDelta(e.deltaY, e.deltaMode);
        const factor = Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY);

        setView((prev) => {
          const nextZoom = clampZoom(prev.zoom * factor, prev.fitZoom);
          if (nextZoom === prev.zoom) return prev;
          const zoomed = zoomAroundPoint(prev, nextZoom, mouse);
          return {
            ...zoomed,
            pan: {
              ...zoomed.pan,
              y: clampPanY(zoomed.pan.y, zoomed.zoom, layoutLength, containerHeight),
            },
          };
        });
        return;
      }

      // 2) Shift + rotellina → Pan orizzontale (X).
      //    Alcuni sistemi traslano già deltaY in deltaX: si usa quello disponibile.
      if (e.shiftKey) {
        const deltaX = normalizeDelta(e.deltaX !== 0 ? e.deltaX : e.deltaY, e.deltaMode);
        setView((prev) => ({
          ...prev,
          pan: { ...prev.pan, x: prev.pan.x - deltaX },
        }));
        return;
      }

      // 3) Rotellina pura → Pan verticale (Y): scorre il semirimorchio
      //    dall'alto (Cabina) verso il basso (Porte posteriori).
      //    Clamp rigido: il pianale resta centrato se entra nello schermo,
      //    altrimenti Cabina e Porte si arrestano a ridosso dei bordi.
      const deltaY = normalizeDelta(e.deltaY, e.deltaMode);
      setView((prev) => ({
        ...prev,
        pan: {
          ...prev.pan,
          y: clampPanY(prev.pan.y - deltaY, prev.zoom, layoutLength, containerHeight),
        },
      }));
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [layoutLength]);

  // --- Sfondo: Pan (drag semplice) oppure Lasso (Shift + drag) --------------
  const handleBackgroundPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const start = toSvgPoint(e.clientX, e.clientY);
    if (!start) return;

    suppressBackgroundClick.current = false;
    e.currentTarget.setPointerCapture(e.pointerId);

    // Shift + drag → rettangolo di selezione (lasso) in aggiunta alla selezione.
    if (e.shiftKey) {
      const startCm = toCanvasCm(e.clientX, e.clientY);
      if (!startCm) return;
      lassoStart.current = startCm;
      setLasso({ start, current: start });
      return;
    }

    panningView.current = { start, pan: { ...pan }, moved: false };
    setIsPanning(true);
  };

  // --- Drag dei colli (singolo o di gruppo) ---------------------------------
  /**
   * Pointerdown su un collo. `bay` è lo stallo a cui il collo appartiene: se non
   * è quello attivo il click lo **attiva** (senza rubare il gesto: il
   * trascinamento prosegue regolarmente sul pianale appena selezionato).
   */
  const handlePointerDown = (item: PlacedItem, bay: DeckBay, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();

    // Il collo appartiene a un altro mezzo: quel mezzo diventa l'attivo.
    if (bay.id !== activeBayId) onSelectBay(bay.id);

    // Cmd (macOS) / Ctrl (Windows) + click → toggle dell'ID nella selezione.
    const additive = e.metaKey || e.ctrlKey;
    let nextIds: string[];

    if (additive) {
      nextIds = selectedItemIds.includes(item.id)
        ? selectedItemIds.filter((id) => id !== item.id)
        : [...selectedItemIds, item.id];
      onSelectItems(nextIds);
    } else if (selectedItemIds.includes(item.id)) {
      // Già nel gruppo: mantiene la selezione per permettere il drag di gruppo.
      nextIds = selectedItemIds;
    } else {
      nextIds = [item.id];
      onSelectItems(nextIds);
    }

    // Collo appena deselezionato con Cmd/Ctrl: nessun trascinamento.
    if (!nextIds.includes(item.id)) {
      draggingItem.current = null;
      return;
    }

    const cursor = toCanvasCm(e.clientX, e.clientY);
    if (!cursor) return;

    (e.target as Element).setPointerCapture(e.pointerId);

    /**
     * Stallo di partenza del gesto: il cursore viene tracciato in **cm di
     * mondo** (origine = parete sinistra del primo stallo), mentre il delta di
     * trascinamento viene applicato alle coordinate **locali** dei colli, che
     * vivono in `item.x` / `item.y`.
     */
    const sourceBayIndex = bays.findIndex((other) => other.id === bay.id);
    const sourceBayOffset = offsets[sourceBayIndex] ?? 0;

    // Congela il gruppo: il drag partirà solo se il puntatore si muove davvero.
    const memberIdSet = new Set(nextIds);
    const members = bay.items
      .filter((other) => memberIdSet.has(other.id))
      .map((other) => ({
        id: other.id,
        startX: other.x,
        startY: other.y,
        width: other.width,
        length: other.length,
      }));

    // Apre il gesto in cronologia PRIMA che il pointerMove tocchi la stiva:
    // durante il movimento non verrà registrato nulla.
    onBeginHistoryGesture();

    draggingItem.current = {
      primaryId: item.id,
      sourceBayId: bay.id,
      sourceBayOffset,
      // Cursore di MONDO: da qui in poi ogni stallo sotto il puntatore si
      // ricava per semplice sottrazione della propria traslazione.
      startCursor: cursor,
      startX: item.x,
      startY: item.y,
      primaryWidth: item.width,
      primaryLength: item.length,
      moved: false,
      members,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // 0) Ridimensionamento di una nota: la maniglia guida larghezza e altezza,
    //    entrambe clampate nei limiti consentiti (70–300 cm × 40–400 cm).
    const resize = resizingNote.current;
    if (resize) {
      const cursor = toCanvasCm(e.clientX, e.clientY);
      if (!cursor) return;
      const localX = cursor.x - resize.bayOffsetCm;
      const width = Math.max(
        NOTE_MIN_WIDTH_CM,
        Math.min(NOTE_MAX_WIDTH_CM, resize.startWidth + (localX - resize.startCursorX))
      );
      const height = Math.max(
        NOTE_MIN_HEIGHT_CM,
        Math.min(NOTE_MAX_HEIGHT_CM, resize.startHeight + (cursor.y - resize.startCursorY))
      );
      if (width !== resize.startWidth || height !== resize.startHeight) {
        resize.moved = true;
        onUpdateNoteSize(resize.id, { width: toPrecision(width), height: toPrecision(height) });
      }
      return;
    }

    // 1) Trascinamento libero 2D di una nota laterale: si aggiornano sia la X sia
    //    la Y in cm reali. La X può uscire dal pianale (anche negativa), la Y è
    //    clampata tra Cabina (0) e quota di fondo dinamica.
    const noteDrag = draggingNote.current;
    if (noteDrag) {
      const cursor = toCanvasCm(e.clientX, e.clientY);
      if (!cursor) return;
      const deltaX = cursor.x - noteDrag.bayOffsetCm - noteDrag.startCursorX;
      const deltaY = cursor.y - noteDrag.startCursorY;
      if (Math.hypot(deltaX, deltaY) > NOTE_DRAG_THRESHOLD_CM) noteDrag.moved = true;
      if (!noteDrag.moved) return;
      const nextX = Math.max(
        noteMinX(noteDrag.vehicleWidth),
        Math.min(noteMaxX(noteDrag.vehicleWidth), noteDrag.startX + deltaX)
      );
      const nextY = Math.max(0, Math.min(layoutLength, noteDrag.startY + deltaY));
      onUpdateNotePos(noteDrag.id, nextX, nextY);
      return;
    }

    // 1) Lasso attivo: aggiorna il rettangolo visualizzato.
    if (lassoStart.current) {
      const current = toSvgPoint(e.clientX, e.clientY);
      if (!current) return;
      setLasso((prev) => (prev ? { ...prev, current } : prev));
      return;
    }

    // 2) Pan della vista: il pan è in px schermo, quindi non dipende dallo zoom.
    const panning = panningView.current;
    if (panning) {
      const current = toSvgPoint(e.clientX, e.clientY);
      if (!current) return;
      if (
        !panning.moved &&
        Math.hypot(current.x - panning.start.x, current.y - panning.start.y) > DRAG_THRESHOLD_PX
      ) {
        panning.moved = true;
      }
      // Pan verticale sotto clamp rigido: nessuno spazio vuoto ai due estremi.
      const panHeight = measureViewport().h;
      setView((prev) => ({
        ...prev,
        pan: {
          x: panning.pan.x + (current.x - panning.start.x),
          y: clampPanY(
            panning.pan.y + (current.y - panning.start.y),
            prev.zoom,
            layoutLength,
            panHeight
          ),
        },
      }));
      return;
    }

    // 3) Trascinamento (singolo o di gruppo) — **cross-pianale**.
    //    Il gesto non è più confinato al camion di partenza: il cursore viene
    //    seguito in cm di mondo e, a ogni frame, si determina quale stallo della
    //    centrale sta sotto il puntatore. Se è il pianale di origine vale la
    //    fisica di sempre; se è un ALTRO mezzo il blocco si aggancia
    //    magneticamente alle sue pareti e ai suoi colli; nel canale di 180 cm
    //    fra due stalli (o fuori dalla flotta) il blocco vola libero.
    const drag = draggingItem.current;
    if (!drag) return;
    const cursor = toCanvasCm(e.clientX, e.clientY);
    if (!cursor) return;

    const deltaX = cursor.x - drag.startCursor.x;
    const deltaY = cursor.y - drag.startCursor.y;

    // Un trascinamento diventa tale solo oltre la soglia in pixel: sotto quella
    // distanza il gesto resta un click (nessuno spostamento, nessun fotogramma).
    if (!drag.moved && Math.hypot(deltaX, deltaY) * zoom < DRAG_THRESHOLD_PX) return;
    drag.moved = true;

    // Colli e sagoma del mezzo di PARTENZA: servono al ramo di spostamento
    // interno (il gesto non deve mai agganciarsi ai propri stessi membri).
    const sourceView = bayViews.find((view) => view.bay.id === drag.sourceBayId) ?? bayViews[0];
    if (!sourceView) return;
    const sourceVehicle = sourceView.bay.vehicle;
    const sourceItems = sourceView.items;
    const groupIds = new Set(drag.members.map((member) => member.id));
    const primaryMember =
      drag.members.find((member) => member.id === drag.primaryId) ?? drag.members[0];
    if (!primaryMember) return;

    // Sagoma orizzontale di uno stallo nel mondo: `offset ≤ X ≤ offset + width`.
    const hoveredBayView =
      bayViews.find(
        (view) => cursor.x >= view.offset && cursor.x <= view.offset + view.bay.vehicle.width
      ) ?? null;

    /* --- Caso A: il cursore è nel canale di 180 cm (o fuori dalla flotta) ---
     * Nessuno snap: il blocco segue il puntatore in coordinate di mondo e, al
     * rilascio, l'operazione viene **annullata elasticamente** (Opzione A). */
    if (!hoveredBayView) {
      applyDragOverlay({
        sourceBayId: drag.sourceBayId,
        targetBayId: null,
        targetBayIndex: -1,
        members: drag.members.map((member) => {
          // Quota di sicurezza: i colli non escono mai dalla fascia verticale
          // del layout (Cabina in alto, buffer di sforamento posteriore in basso).
          const worldY = Math.max(
            0,
            Math.min(layoutLength + REAR_OVERHANG_LIMIT - member.length, member.startY + deltaY)
          );
          return {
            item: sourceItems.find((item) => item.id === member.id) ?? toOverlayPlaceholder(member),
            worldX: drag.sourceBayOffset + member.startX + deltaX,
            worldY,
            localX: member.startX + deltaX,
            localY: worldY,
          };
        }),
      });
      return;
    }

    /* --- Caso B: il cursore è dentro la sagoma di uno stallo ---------------- */
    const targetVehicle = hoveredBayView.bay.vehicle;
    const isSameBay = hoveredBayView.bay.id === drag.sourceBayId;

    // Coordinate LOCALI proposte per il membro primario nello stallo bersaglio.
    const proposedLocalX =
      drag.sourceBayOffset + primaryMember.startX + deltaX - hoveredBayView.offset;
    const proposedLocalY = primaryMember.startY + deltaY;

    // Snap magnetico su pareti e colli dello stallo bersaglio. Nello stallo di
    // partenza i membri del gruppo vengono esclusi (non si agganciano a se
    // stessi); su un altro mezzo l'esclusione è superflua ma innocua.
    const snapped = calculateSnapPosition(
      proposedLocalX,
      proposedLocalY,
      primaryMember.width,
      primaryMember.length,
      targetVehicle,
      hoveredBayView.items.filter((other) => !groupIds.has(other.id))
    );

    // Il blocco è RIGIDO: lo scarto fra posizione agganciata e posizione grezza
    // vale per tutti i membri, quindi le posizioni relative non cambiano mai.
    const snapDx = snapped.x - proposedLocalX;
    const snapDy = snapped.y - proposedLocalY;

    const rawLocalX = (member: { startX: number }): number =>
      drag.sourceBayOffset + member.startX + deltaX - hoveredBayView.offset + snapDx;
    const rawLocalY = (member: { startY: number }): number => member.startY + deltaY + snapDy;

    // Clamping di gruppo: TUTTO il blocco deve rientrare nella sagoma del mezzo
    // bersaglio (pareti laterali e Cabina rigide, sforamento posteriore
    // consentito fino al buffer). Lo scarto è unico, quindi la geometria
    // reciproca resta intatta.
    let localDxMin = -Infinity;
    let localDxMax = Infinity;
    let localDyMin = -Infinity;
    let localDyMax = Infinity;

    for (const member of drag.members) {
      if (isSameBay) {
        // Stallo di partenza: si conserva esattamente la fisica storica, che
        // lavora sul delta invece che sulla posizione assoluta.
        localDxMin = Math.max(localDxMin, -member.startX);
        localDxMax = Math.min(localDxMax, sourceVehicle.width - member.width - member.startX);
        localDyMin = Math.max(localDyMin, -member.startY);
        localDyMax = Math.min(
          localDyMax,
          sourceVehicle.length + REAR_OVERHANG_LIMIT - member.length - member.startY
        );
      } else {
        localDxMin = Math.max(localDxMin, -rawLocalX(member));
        localDxMax = Math.min(localDxMax, targetVehicle.width - member.width - rawLocalX(member));
        localDyMin = Math.max(localDyMin, -rawLocalY(member));
        localDyMax = Math.min(
          localDyMax,
          targetVehicle.length + REAR_OVERHANG_LIMIT - member.length - rawLocalY(member)
        );
      }
    }

    const groupDx = localDxMin <= localDxMax ? Math.max(localDxMin, Math.min(localDxMax, 0)) : 0;
    const groupDy = localDyMin <= localDyMax ? Math.max(localDyMin, Math.min(localDyMax, 0)) : 0;

    const overlayMembers: DragOverlayMember[] = drag.members.map((member) => {
      const localX = rawLocalX(member) + groupDx;
      const localY = rawLocalY(member) + groupDy;
      return {
        item: sourceItems.find((item) => item.id === member.id) ?? toOverlayPlaceholder(member),
        worldX: hoveredBayView.offset + localX,
        worldY: localY,
        localX,
        localY,
      };
    });

    // Spostamento interno allo stallo di partenza: la stiva viene aggiornata
    // **live** come nel drag storico (un solo passo di Undo al rilascio). Nel
    // trasferimento cross-pianale, invece, nulla viene mutato finché il
    // puntatore non viene rilasciato su un bersaglio valido: nessuna stiva
    // intermedia da dover riparare se il gesto finisce nel canale neutro.
    if (isSameBay) {
      onUpdateItemsPos(
        overlayMembers.map((member) => ({
          id: member.item.id,
          x: toPrecision(member.localX),
          y: toPrecision(member.localY),
        }))
      );
    }

    applyDragOverlay({
      sourceBayId: drag.sourceBayId,
      targetBayId: hoveredBayView.bay.id,
      targetBayIndex: hoveredBayView.index,
      members: overlayMembers,
    });
  };

  /**
   * Selezione via lasso: AABB in cm **di mondo** tra il rettangolo tracciato e
   * ogni collo di **tutti** gli stalli (le coordinate locali vengono traslate
   * nella loro origine di mondo). Così un solo gesto può raccogliere bancali da
   * più mezzi affiancati, esattamente come si vede a schermo.
   */
  const applyLassoSelection = (endCm: Point) => {
    const start = lassoStart.current;
    if (!start) return;

    const x = Math.min(start.x, endCm.x);
    const y = Math.min(start.y, endCm.y);
    const width = Math.abs(endCm.x - start.x);
    const length = Math.abs(endCm.y - start.y);

    const hitItemIds = bayViews.flatMap((view) =>
      view.items
        .filter((item) =>
          isRectColliding(x - view.offset, y, width, length, item)
        )
        .map((item) => item.id)
    );

    // Selezione ESCLUSIVA: il lasso sostituisce integralmente la selezione
    // corrente. Qualsiasi collo selezionato in precedenza e non intersecato dal
    // rettangolo viene deselezionato all'istante (nessuna selezione cumulativa).
    if (hitItemIds.length === 0) {
      onSelectItems([]);
      return;
    }

    // Il lasso diventa il nuovo criterio di "mezzo attivo": vince lo stallo del
    // primo collo raccolto, così l'ispettore comanda ciò che si è appena
    // selezionato anche quando i colli arrivano da pianali diversi.
    const owningBay = bayViews.find((view) =>
      view.items.some((item) => item.id === hitItemIds[0])
    );
    if (owningBay && owningBay.bay.id !== activeBayId) onSelectBay(owningBay.bay.id);
    onSelectItems(hitItemIds);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      // Il capture è sull'elemento che ha ricevuto il pointerdown (collo o sfondo).
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      // Il pointer capture potrebbe essere già stato rilasciato dal browser.
    }

    // Rilascio dopo il ridimensionamento di una nota: la selezione resta e il
    // click di sfondo non deve azzerarla. La cronologia convalida il gesto solo
    // se le dimensioni sono davvero cambiate.
    const resize = resizingNote.current;
    if (resize) {
      resizingNote.current = null;
      onCommitHistoryGesture(resize.moved);
      suppressBackgroundClick.current = true;
      return;
    }

    // Rilascio dopo il trascinamento di una nota laterale: la selezione della
    // nota resta, mentre il click di sfondo non deve azzerarla.
    const noteDrag = draggingNote.current;
    if (noteDrag) {
      if (noteDrag.moved) suppressBackgroundClick.current = true;
      draggingNote.current = null;
      onCommitHistoryGesture(noteDrag.moved);
      return;
    }

    // Chiusura del lasso: calcolo dell'intersezione al rilascio del mouse.
    if (lassoStart.current) {
      const endCm = toCanvasCm(e.clientX, e.clientY);
      if (endCm) applyLassoSelection(endCm);
      lassoStart.current = null;
      setLasso(null);
      suppressBackgroundClick.current = true;
      return;
    }

    if (panningView.current?.moved) suppressBackgroundClick.current = true;

    /* --- Chiusura del trascinamento di colli -------------------------------- *
     *  L'intero gesto entra in cronologia come **UN solo passo**, e solo se ha
     *  davvero prodotto una mutazione:
     *   - rilascio su un ALTRO mezzo  → trasferimento atomico cross-pianale;
     *   - rilascio sullo stesso mezzo → posizioni già aggiornate live, si
     *     convalida il fotogramma;
     *   - rilascio nel canale di 180 cm (Opzione A) → **annullamento elastico**:
     *     nessuna mutazione è mai avvenuta (la stiva non è stata toccata durante
     *     il transito), i colli rientrano da soli alla posizione di partenza e
     *     nessun passo viene aggiunto alla cronologia.
     * ------------------------------------------------------------------------ */
    const itemDrag = draggingItem.current;
    const overlay = dragOverlayRef.current;

    if (itemDrag) {
      if (itemDrag.moved && overlay && overlay.targetBayId !== null) {
        if (overlay.targetBayId !== overlay.sourceBayId) {
          // TRASFERIMENTO TRA MEZZI DIVERSI: un solo aggiornamento atomico, con
          // le coordinate già convertite nel sistema locale del bersaglio.
          const placements: ItemPositionUpdate[] = overlay.members.map((member) => ({
            id: member.item.id,
            x: toPrecision(member.localX),
            y: toPrecision(member.localY),
          }));
          onTransferItems?.(overlay.sourceBayId, overlay.targetBayId, placements);
        }
        // Spostamento interno allo stallo di partenza: le posizioni sono già in
        // scena (aggiornate live durante il `pointerMove`), resta da convalidare
        // il fotogramma aperto al `pointerDown`.
        onCommitHistoryGesture(true);
        // Il rilascio non è un click sullo sfondo: la selezione (che segue i
        // colli appena trasferiti) non deve essere azzerata.
        suppressBackgroundClick.current = true;
      } else {
        // Click puro oppure rilascio nel canale di 180 cm: nessun passo di Undo.
        onCommitHistoryGesture(false);
      }
      setDragOverlay(null);
      dragOverlayRef.current = null;
      draggingItem.current = null;
    }

    panningView.current = null;
    setIsPanning(false);
  };

  // --- Zoom da pulsanti HUD (ancorato al centro del viewport) ---------------
  const zoomByStep = (sign: number) => {
    const center = { x: viewport.w / 2, y: viewport.h / 2 };
    const containerHeight = measureViewport().h;
    setView((prev) => {
      const nextZoom = clampZoom(
        prev.zoom + sign * ZOOM_STEP_RATIO * prev.fitZoom,
        prev.fitZoom
      );
      if (nextZoom === prev.zoom) return prev;
      const zoomed = zoomAroundPoint(prev, nextZoom, center);
      // Riallineamento verticale: il pianale non può lasciare vuoto ai bordi.
      return {
        ...zoomed,
        pan: {
          ...zoomed.pan,
          y: clampPanY(zoomed.pan.y, zoomed.zoom, layoutLength, containerHeight),
        },
      };
    });
  };

  const zoomPercent = Math.round((zoom / fitZoom) * 100);
  const canZoomOut = zoom > fitZoom * MIN_ZOOM_RATIO + 0.0001;
  const canZoomIn = zoom < fitZoom * MAX_ZOOM_RATIO - 0.0001;

  const selectedItems = (activeBayView?.items ?? []).filter((item) => selectedIdSet.has(item.id));

  // Involucro del gruppo selezionato: mostrato solo con selezione multipla,
  // per rendere evidente che i colli si muoveranno assieme.
  const groupBounds =
    selectedItems.length > 1
      ? {
          x: Math.min(...selectedItems.map((item) => item.x)),
          y: Math.min(...selectedItems.map((item) => item.y)),
          right: Math.max(...selectedItems.map((item) => item.x + item.width)),
          bottom: Math.max(...selectedItems.map((item) => item.y + item.length)),
        }
      : null;

  /**
   * Etichette interne di un collo.
   *
   * - `minimal` non stampa alcun `<text>` (solo blocco colorato).
   * - Sui colli stretti (≤ 70 cm, es. CC da 56,5 cm) o con nomi troppo lunghi il
   *   nome va a capo su due righe centrate (`<tspan>`), con corpo ridotto a
   *   10 px per la massima leggibilità.
   * - Il testo è sempre racchiuso nel `clipPath` del collo: nessun traboccamento.
   */
  const renderItemLabels = (item: PlacedItem): React.ReactNode => {
    if (labelDensity === 'minimal') return null;

    const centerX = item.width / 2;
    const centerY = item.length / 2;
    const isNarrow = item.width <= NARROW_ITEM_WIDTH_CM;
    const lines = shouldWrapLabel(item.name, item.width)
      ? splitLabelIntoTwoLines(item.name)
      : null;

    // Corpi font allineati alle costanti di `utils/labels.ts` (unità = cm).
    const baseClass = 'pointer-events-none select-none';
    const nameFontClass = lines ? 'text-[10px]' : 'text-[11px]';
    const dimensionFontClass = isNarrow ? 'text-[10px]' : 'text-[9px]';

    if (labelDensity === 'client') {
      if (lines) {
        return (
          <text
            x={centerX}
            y={centerY}
            textAnchor="middle"
            className={`text-[10px] font-bold fill-slate-800 ${baseClass}`}
          >
            <tspan x={centerX} dy="-6">
              {lines[0]}
            </tspan>
            <tspan x={centerX} dy="13">
              {lines[1]}
            </tspan>
          </text>
        );
      }

      return (
        <text
          x={centerX}
          y={centerY}
          textAnchor="middle"
          dominantBaseline="middle"
          className={`text-[12px] font-bold fill-slate-800 ${baseClass}`}
        >
          {item.name}
        </text>
      );
    }

    if (labelDensity === 'dimensions') {
      return (
        <text
          x={centerX}
          y={centerY}
          textAnchor="middle"
          dominantBaseline="middle"
          className={`${isNarrow ? 'text-[10px]' : 'text-[12px]'} font-mono font-bold fill-slate-700 ${baseClass}`}
        >
          {item.width}×{item.length}
        </text>
      );
    }

    // Densità `all`: nome (su una o due righe) + quote.
    if (lines) {
      return (
        <text
          x={centerX}
          y={centerY}
          textAnchor="middle"
          className={`text-[10px] font-bold fill-slate-800 ${baseClass}`}
        >
          <tspan x={centerX} dy="-6">
            {lines[0]}
          </tspan>
          <tspan x={centerX} dy="13">
            {lines[1]}
          </tspan>
          <tspan
            x={centerX}
            dy="12"
            className={`${dimensionFontClass} font-mono font-normal fill-slate-600`}
          >
            {item.width}×{item.length}
          </tspan>
        </text>
      );
    }

    return (
      <>
        <text
          x={centerX}
          y={centerY - 3}
          textAnchor="middle"
          dominantBaseline="middle"
          className={`${nameFontClass} font-bold fill-slate-800 ${baseClass}`}
        >
          {item.name}
        </text>
        <text
          x={centerX}
          y={centerY + 11}
          textAnchor="middle"
          dominantBaseline="middle"
          className={`${dimensionFontClass} font-mono fill-slate-600 ${baseClass}`}
        >
          {item.width}×{item.length}
        </text>
      </>
    );
  };

  /**
   * Intestazione dello **stallo**: pillola a **riga singola** sopra la Cabina,
   * centrata sulla larghezza del pianale, con il solo nome del mezzo
   * (`MEZZO 1`) e la pillola `ATTIVO`.
   *
   * - stallo **attivo** → bordo blu primario `#2563EB`, fondo azzurrato e badge
   *   `ATTIVO`;
   * - stallo inattivo → bordo grigio tenue e testo ardesia.
   *
   * Targa e preset **non** sono ripetuti qui: la targa vive già nel proprio badge
   * sopra la Cabina e il preset nel menu "Configurazione Mezzo" della sidebar.
   * L'header è una pillola **pulita**: un click rende il mezzo attivo, mentre
   * l'eliminazione è gestita esclusivamente dal pulsante `Elimina` della sidebar
   * (nessuna icona "X" / cestino sul canvas). Vive alle **coordinate locali**
   * dello stallo: è il gruppo traslato a portarlo nella posizione giusta.
   */
  const renderBayHeader = (view: BayViewModel): React.ReactNode => {
    const isActive = view.bay.id === activeBayId;
    // Pillola **centrata** sulla larghezza del pianale: con un solo mezzo il
    // riquadro resta sull'asse del camion, con più mezzi non invade mai il
    // pianale successivo (140 cm su 180 cm di stacco).
    const headerX = (view.bay.vehicle.width - BAY_HEADER_WIDTH_CM) / 2;
    // Bordo destro **utile**: il badge `ATTIVO` si accosta a questo margine.
    const rightX = headerX + BAY_HEADER_WIDTH_CM - BAY_HEADER_PADDING_CM;

    return (
      <g
        data-canvas-bay-header={view.bay.id}
        className="cursor-pointer select-none"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          // Il click è dell'header: non deve azzerare la selezione dei colli.
          e.stopPropagation();
          onSelectBay(view.bay.id);
        }}
      >
        {/* Pillola / Tab a riga singola: nome del mezzo e badge `ATTIVO` */}
        <rect
          x={headerX}
          y={BAY_HEADER_TOP_CM}
          width={BAY_HEADER_WIDTH_CM}
          height={BAY_HEADER_HEIGHT_CM}
          rx={6}
          fill={isActive ? BAY_HEADER_BG_ACTIVE : BAY_HEADER_BG}
          stroke={isActive ? BAY_HEADER_BORDER_ACTIVE : BAY_HEADER_BORDER}
          strokeWidth={isActive ? 1.5 : 1}
        />

        {/* Nome dello stallo: `MEZZO 1` / `MEZZO 2` / `MEZZO 3`. Targa e preset
            non vengono ripetuti qui: vivono già nel badge targa sopra la Cabina
            e nel menu "Configurazione Mezzo" della sidebar. */}
        <text
          x={headerX + 10}
          y={BAY_HEADER_TOP_CM + 17}
          fontFamily={FONT_FAMILY_LABEL}
          fontSize={BAY_HEADER_TITLE_FONT_CM}
          fontWeight="800"
          letterSpacing="0.04em"
          fill={isActive ? BAY_HEADER_TEXT_ACTIVE : BAY_HEADER_TEXT}
        >
          {bayLabel(view.index)}
        </text>

        {/* Pillola `ATTIVO`: solo sullo stallo comandato da sidebar e ispettore.
            Accostata al bordo destro utile dell'header, ora che nessun disco di
            eliminazione occupa più quello spazio. */}
        {isActive && (
          <g>
            <rect
              x={rightX - 40}
              y={BAY_HEADER_TOP_CM + 6}
              width={40}
              height={14}
              rx={7}
              fill={BAY_HEADER_BORDER_ACTIVE}
            />
            <text
              x={rightX - 20}
              y={BAY_HEADER_TOP_CM + 16}
              textAnchor="middle"
              fontFamily={FONT_FAMILY_LABEL}
              fontSize={7.5}
              fontWeight="bold"
              letterSpacing="0.06em"
              fill="#FFFFFF"
            >
              ATTIVO
            </text>
          </g>
        )}
      </g>
    );
  };

  return (
    <div className="relative w-full h-full overflow-hidden bg-slate-100 select-none">
      <div
        ref={containerRef}
        className="w-full h-full"
        onClick={() => {
          // Un pan o un lasso terminati poco fa non azzerano la selezione.
          if (suppressBackgroundClick.current) {
            suppressBackgroundClick.current = false;
            return;
          }
          // Il click sullo sfondo azzera ogni selezione: colli E nota attiva
          // (le due modalità non coesistono, quindi tornano a riposo assieme).
          onSelectItems([]);
          onSelectNote(null);
        }}
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Viewport CAD a tutto schermo: nessun viewBox, 1 unità SVG = 1 px.
            Tutto il "mondo" (pianale, quote, colli) vive dentro il <g> trasformato. */}
        <svg
          ref={svgRef}
          className={`w-full h-full block touch-none ${
            lasso ? 'cursor-crosshair' : isPanning ? 'cursor-grabbing' : 'cursor-grab'
          }`}
        >
          <defs>
            <filter id="truck-shadow" x="-20%" y="-10%" width="140%" height="120%">
              <feDropShadow
                dx="0"
                dy="2"
                stdDeviation="3"
                floodColor="#0F172A"
                floodOpacity="0.18"
              />
            </filter>
            {/* Ombra sobria delle card di nota: stacca la corsia note dal fondo
                grigio senza introdurre volumetrie superflue. */}
            <filter id="side-note-shadow" x="-15%" y="-10%" width="130%" height="125%">
              <feDropShadow
                dx="0"
                dy="1.4"
                stdDeviation="2"
                floodColor="#0F172A"
                floodOpacity="0.14"
              />
            </filter>
            {/* Un clipPath per OGNI collo della centrale: il testo resta
                fisicamente dentro il proprio rettangolo e non può sbordare sui
                colli adiacenti, neppure su quelli di un altro mezzo. */}
            {bayViews.flatMap((view) =>
              view.items.map((item) => (
                <clipPath key={item.id} id={clipIdForItem(item.id)}>
                  <rect width={item.width} height={item.length} />
                </clipPath>
              ))
            )}
            {/* Un clipPath per ogni nota: interviene solo se l'operatore ha
                ridotto il box a un'altezza inferiore a quella del testo. */}
            {bayViews.flatMap((view) =>
              view.noteLayouts.map(({ note, height }) => (
                <clipPath key={note.id} id={clipIdForNote(note.id)}>
                  <rect width={note.width} height={height} />
                </clipPath>
              ))
            )}
          </defs>

          {/* MONDO VETTORIALE: origine (0,0) = angolo alto-sinistra del PRIMO
              pianale (Cabina in alto, Porte posteriori in basso). Unità =
              centimetri reali; ogni stallo successivo è traslato di `offset` cm.
              Nascosto finché il viewport non è misurato, così non c'è alcun flash.
              `data-canvas-world` è l'aggancio stabile allo zoom/pan della vista:
              i gruppi di stallo hanno una propria traslazione e non sono quindi
              utilizzabili per risalire alla trasformazione del mondo. */}
          <g
            data-canvas-world="world"
            transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}
            style={{ visibility: isViewportReady ? 'visible' : 'hidden' }}
          >
            {/* UN GRUPPO PER CIASCUN MEZZO: il pianale, la cabina, le porte, le
                tacche metriche, i colli e le note vivono nelle coordinate LOCALI
                  dello stallo; è questa traslazione ad affiancarli nella scena. */}
              {bayViews.map((view) => (
                <g
                  key={view.bay.id}
                  data-canvas-bay={view.bay.id}
                  transform={`translate(${view.offset}, 0)`}
                >
                  {/* Corpo del semirimorchio: oggetto vettoriale, nessun clipping ai lati */}
                  <rect
                    x={0}
                    y={0}
                    width={view.bay.vehicle.width}
                    height={view.bay.vehicle.length}
                    rx={4}
                    fill="white"
                    filter="url(#truck-shadow)"
                  />

              {/* Parete frontale Cabina */}
              <line
                x1={0}
                y1={0}
                x2={view.bay.vehicle.width}
                y2={0}
                stroke="#0F172A"
                strokeWidth="4"
              />

              {/* Spalla Laterale Sinistra */}
              <line
                x1={0}
                y1={0}
                x2={0}
                y2={view.bay.vehicle.length}
                stroke="#0F172A"
                strokeWidth="3"
              />

              {/* Spalla Laterale Destra */}
              <line
                x1={view.bay.vehicle.width}
                y1={0}
                x2={view.bay.vehicle.width}
                y2={view.bay.vehicle.length}
                stroke="#0F172A"
                strokeWidth="3"
              />

              {/* Righelli metrici di fondo (linee ogni metro) */}
              {view.meterMarkers.map((yVal) => (
                <g key={yVal}>
                  <line
                    x1={0}
                    y1={yVal}
                    x2={view.bay.vehicle.width}
                    y2={yVal}
                    stroke="#E2E8F0"
                    strokeDasharray="4 4"
                    strokeWidth="1"
                  />
                  <text
                    x={-8}
                    y={yVal + 4}
                    textAnchor="end"
                    className="text-[10px] fill-slate-400 font-mono"
                  >
                    {(yVal / 100).toFixed(0)}m
                  </text>
                </g>
              ))}

              {/* Quota nominale 13,20 m: linea netta attraverso il pianale + dicitura
                  nel righello di sinistra. Presente solo sui mezzi da 13,20 m in su. */}
              {view.showsNominalQuota && (
                <g>
                  <line
                    x1={0}
                    y1={NOMINAL_QUOTA_CM}
                    x2={view.bay.vehicle.width}
                    y2={NOMINAL_QUOTA_CM}
                    stroke={NOMINAL_QUOTA_COLOR}
                    strokeDasharray="6 3"
                    strokeWidth="1.5"
                  />
                  <text
                    x={-8}
                    y={NOMINAL_QUOTA_CM + 4}
                    textAnchor="end"
                    className="text-[10px] font-bold fill-slate-600 font-mono"
                  >
                    13.20m
                  </text>
                </g>
              )}

              {/* Contatore dinamico LDM (metri lineari occupati), dalla funzione
                  condivisa `calculateLdmMetrics` con la Regola della Corsia di
                  Parete.
                  - Carico simmetrico: singolo indicatore a sinistra, linea guida
                    continua alla Y massima, badge scuro `#1E293B`.
                  - Carico asimmetrico: due indicatori tratteggiati, ciascuno sulla
                    propria metà pianale; il lato più carico ha il badge scuro
                    primario, quello meno carico lo slate intermedio `#475569`.
                    Il badge destro vive FUORI dalla parete destra.
                  - Densità `minimal`: nessuna linea e nessun badge (disegno pulito). */}
              {view.showsLdmIndicator && view.ldmIsSymmetric && (
                <g>
                  <line
                    x1={0}
                    y1={view.ldm.maxOccupiedY}
                    x2={view.bay.vehicle.width}
                    y2={view.ldm.maxOccupiedY}
                    stroke={LDM_GUIDE_COLOR}
                    strokeWidth="1"
                  />
                  <rect
                    x={LDM_BADGE_LEFT_X}
                    y={view.ldm.maxOccupiedY - LDM_BADGE.height / 2}
                    width={LDM_BADGE.width}
                    height={LDM_BADGE.height}
                    rx={3}
                    fill={LDM_BADGE_COLOR}
                  />
                  <text
                    x={LDM_BADGE_CENTER_X}
                    y={view.ldm.maxOccupiedY + 3.5}
                    textAnchor="middle"
                    className="text-[10px] font-bold fill-white"
                  >
                    {formatLdmMeters(view.ldm.maxOccupiedY)} m ▶
                  </text>
                </g>
              )}

              {view.showsLdmIndicator && !view.ldmIsSymmetric && (
                <g>
                  {/* Indicatore SX: metà sinistra del pianale. */}
                  <line
                    x1={0}
                    y1={view.ldm.leftY}
                    x2={view.bay.vehicle.width / 2}
                    y2={view.ldm.leftY}
                    stroke={LDM_GUIDE_COLOR}
                    strokeWidth="1"
                    strokeDasharray={LDM_GUIDE_DASH}
                  />
                  {/* Chiusura a filo mezzeria: il tratteggio non deve lasciare la
                      linea "sospesa" prima dell'asse di mezzeria. */}
                  <line
                    x1={Math.max(0, view.bay.vehicle.width / 2 - LDM_GUIDE_CLOSING_LENGTH)}
                    y1={view.ldm.leftY}
                    x2={view.bay.vehicle.width / 2}
                    y2={view.ldm.leftY}
                    stroke={LDM_GUIDE_COLOR}
                    strokeWidth="1"
                  />
                  <rect
                    x={LDM_BADGE_LEFT_X}
                    y={view.ldm.leftY - LDM_BADGE.height / 2}
                    width={LDM_BADGE.width}
                    height={LDM_BADGE.height}
                    rx={3}
                    fill={view.leftLdmBadgeColor}
                  />
                  <text
                    x={LDM_BADGE_CENTER_X}
                    y={view.ldm.leftY + 3.5}
                    textAnchor="middle"
                    className="text-[10px] font-bold fill-white"
                  >
                    {formatLdmMeters(view.ldm.leftY)} m ▶
                  </text>

                  {/* Indicatore DX: metà destra del pianale, badge oltre la parete. */}
                  <line
                    x1={view.bay.vehicle.width / 2}
                    y1={view.ldm.rightY}
                    x2={view.bay.vehicle.width}
                    y2={view.ldm.rightY}
                    stroke={LDM_GUIDE_COLOR}
                    strokeWidth="1"
                    strokeDasharray={LDM_GUIDE_DASH}
                  />
                  {/* Chiusura a filo parete destra (stesso motivo del lato SX). */}
                  <line
                    x1={Math.max(view.bay.vehicle.width / 2, view.bay.vehicle.width - LDM_GUIDE_CLOSING_LENGTH)}
                    y1={view.ldm.rightY}
                    x2={view.bay.vehicle.width}
                    y2={view.ldm.rightY}
                    stroke={LDM_GUIDE_COLOR}
                    strokeWidth="1"
                  />
                  <rect
                    x={view.rightLdmBadgeLeftX}
                    y={view.ldm.rightY - LDM_BADGE.height / 2}
                    width={LDM_BADGE.width}
                    height={LDM_BADGE.height}
                    rx={3}
                    fill={view.rightLdmBadgeColor}
                  />
                  <text
                    x={view.rightLdmBadgeCenterX}
                    y={view.ldm.rightY + 3.5}
                    textAnchor="middle"
                    className="text-[10px] font-bold fill-white"
                  >
                    ◀ {formatLdmMeters(view.ldm.rightY)} m
                  </text>
                </g>
              )}

              {/* Parete posteriore / PORTE */}
              <line
                x1={0}
                y1={view.bay.vehicle.length}
                x2={view.bay.vehicle.width}
                y2={view.bay.vehicle.length}
                stroke="#0F172A"
                strokeWidth="3"
                strokeDasharray="16 8"
              />

              {/* BADGE TARGA / IDENTIFICATIVO MEZZO: **solo testo** monospaziato
                  tecnico, centrato sull'asse del pianale nella fascia di
                  intestazione (corpo base 30 px), sopra la didascalia ▲ CABINA ▲.
                  - **Silente a riposo:** con targa vuota il blocco non esiste
                    affatto (nessun rettangolo, nessun tratteggio, nessun
                    segnaposto): l'area sopra la Cabina è pulita e trasparente.
                  - **Zero bordo:** nessun contorno (`stroke="none"`), solo testo.
                  - **Gerarchia:** corpo base 30 px, il doppio dei 15 px di
                    `▲ CABINA ▲`, ridotto solo per le targhe molto lunghe. La
                    fascia di scrittura può sforare di 50 cm per lato oltre le
                    sponde del mezzo (`view.bay.vehicle.width + 100` cm).
                  Il click riporta il focus sul campo di testo della sidebar, così
                  il badge funziona da secondo aggancio della stessa informazione. */}
              {view.plateBadge && (
                <g
                  id="canvas-plate-badge"
                  className="cursor-pointer"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    // Il click è del badge: non deve azzerare la selezione dei colli.
                    e.stopPropagation();
                    document.getElementById(PLATE_INPUT_ID)?.focus();
                  }}
                >
                  <text
                    x={view.plateBadge.centerX}
                    y={view.plateBadge.centerY}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontFamily={PLATE_BADGE_FONT_FAMILY}
                    fontSize={view.plateBadge.fontSize}
                    fontWeight="900"
                    letterSpacing={`${PLATE_BADGE_LETTER_SPACING_EM}em`}
                    stroke="none"
                    strokeWidth={0}
                    fill={PLATE_BADGE_TEXT_COLOR}
                    className="pointer-events-none select-none"
                  >
                    {view.plateBadge.label}
                  </text>
                </g>
              )}

              {/* Intestazione: CABINA (sotto la targa). Il corpo è la costante
                  condivisa `CABINA_CAPTION_FONT_SIZE`: è la quota bassa della
                  gerarchia su cui è calcolata la posizione della targa. */}
              <text
                id="canvas-cabina-caption"
                x={view.bay.vehicle.width / 2}
                y={CABINA_CAPTION_BASELINE_CM}
                textAnchor="middle"
                fontSize={CABINA_CAPTION_FONT_SIZE}
                className="font-bold fill-slate-700 tracking-wider"
              >
                ▲ CABINA ▲
              </text>

              {/* Quota larghezza utile */}
              <text
                x={view.bay.vehicle.width / 2}
                y={WIDTH_QUOTA_BASELINE_CM}
                textAnchor="middle"
                className="text-[11px] font-mono fill-slate-500"
              >
                {view.bay.vehicle.width} cm
              </text>

              {/* Didascalia: PORTE POSTERIORI */}
              <text
                x={view.bay.vehicle.width / 2}
                y={view.bay.vehicle.length + 28}
                textAnchor="middle"
                className="text-[14px] font-bold fill-slate-700 tracking-wider"
              >
                PORTE POSTERIORI
              </text>

              {/* Rendering dei Colli Stivati — coordinate = cm reali del pianale */}
              {view.items.map((item) => {
                const isSelected = selectedIdSet.has(item.id);
                /**
                 * Collo che appartiene al blocco in movimento (Drag Overlay):
                 * nello stallo di partenza resta come **sagoma fantasma**
                 * (`opacity 0.35`, bordo tratteggiato), perché a viaggiare è la
                 * copia disegnata nel layer globale `#canvas-drag-overlay`.
                 */
                const isGhost = overlayMemberIdSet.has(item.id);
                // Allarme: collisione con altri colli OPPURE sforamento della
                // sagoma utile (es. accodamento oltre le porte posteriori).
                const alert = hasCollision(item, view.items) || isOutOfBounds(item, view.bay.vehicle);

                // Priorità: allarme (rosso) > selezione (blu) > bordo del collo.
                // Il ROSSO è riservato alle sole condizioni di allarme: il bordo di
                // catalogo è sempre il grigio antracite uniforme.
                // Doppio contorno quando coesistono, così i due stati restano distinguibili.
                const outerStroke = alert
                  ? ALERT_COLOR
                  : isSelected
                    ? SELECTION_COLOR
                    : item.borderColor;
                const outerStrokeWidth = alert ? 2 : isSelected ? 3 : 1.5;

                return (
                  <g
                    key={item.id}
                    data-canvas-item={item.code}
                    data-item-id={item.id}
                    transform={`translate(${item.x}, ${item.y})`}
                    onPointerDown={(e) => handlePointerDown(item, view.bay, e)}
                    onClick={(e) => e.stopPropagation()}
                    className="cursor-move transition-shadow"
                    opacity={isGhost ? GHOST_OPACITY : 1}
                  >
                    <rect
                      width={item.width}
                      height={item.length}
                      fill={item.color}
                      stroke={outerStroke}
                      strokeWidth={outerStrokeWidth}
                      strokeDasharray={isGhost ? GHOST_DASH : undefined}
                      rx={2}
                      className={isSelected && !isGhost ? 'filter drop-shadow-lg' : ''}
                    />
                    {alert && isSelected && !isGhost && (
                      <rect
                        x={2.5}
                        y={2.5}
                        width={Math.max(0, item.width - 5)}
                        height={Math.max(0, item.length - 5)}
                        fill="none"
                        stroke={SELECTION_COLOR}
                        strokeWidth={1.5}
                        rx={1.5}
                        pointerEvents="none"
                      />
                    )}
                    {/* Etichette interne: dipendono dalla densità scelta nell'HUD.
                        `minimal` non stampa alcun <text> (solo blocco colorato).
                        Il gruppo è ritagliato dal clipPath del collo: il testo non
                        può fisicamente sbordare sui colli adiacenti. */}
                    <g clipPath={`url(#${clipIdForItem(item.id)})`}>
                      {renderItemLabels(item)}
                    </g>
                  </g>
                );
              })}

                  {/* Involucro del gruppo selezionato (solo con selezione multipla):
                      indica visivamente che i colli si sposteranno assieme. Vive nel
                      solo stallo che possiede la selezione. */}
                  {view.items.some((item) => selectedIdSet.has(item.id)) && groupBounds && (
                    <rect
                      x={groupBounds.x - 6}
                      y={groupBounds.y - 6}
                      width={groupBounds.right - groupBounds.x + 12}
                      height={groupBounds.bottom - groupBounds.y + 12}
                      fill="none"
                      stroke={SELECTION_COLOR}
                      strokeWidth={1.5}
                      strokeDasharray="10 5"
                      rx={3}
                      opacity={0.75}
                      pointerEvents="none"
                    />
                )}

                {/* NOTE LATERALI 2D LIBERE dello stallo: ogni card vive alle proprie
                    coordinate (x, y) in cm reali — quindi può stare a destra del
                    camion, a sinistra (`x < 0`), lungo il pianale o in coda.
                    Cliccando una nota la si seleziona (e si deselezionano i colli);
                    trascinandola con il puntatore si sposta liberamente in X e Y,
                    mentre la maniglia nell'angolo basso-destro ne ridimensiona il
                    box. */}
                {view.noteLayouts.map(
                  ({ note, height, lines, fontSize, firstBaselineCm, lineHeightCm, textHeight }) => {
                    const isSelected = selectedNoteIdSet.has(note.id);

                    return (
                      <g
                        key={note.id}
                        data-canvas-note={note.id}
                        transform={`translate(${note.x}, ${note.y})`}
                        onPointerDown={(e) =>
                          handleNotePointerDown(note, view.offset, view.bay.vehicle.width, e)
                        }
                        onClick={(e) => e.stopPropagation()}
                        className="cursor-move"
                      >
                        {/* ZERO BORDI A RIPOSO: la card è puro testo fluttuante; solo la
                            nota selezionata mostra il contorno blu CAD di evidenziazione. */}
                        <rect
                          width={note.width}
                          height={height}
                          rx={4}
                          fill={note.color}
                          stroke={isSelected ? SELECTION_COLOR : 'none'}
                          strokeWidth={isSelected ? 2 : 0}
                          filter="url(#side-note-shadow)"
                        />

                        {/* UNICO TESTO DELLA NOTA: coordinate RELATIVE all'origine del
                            box (il gruppo è già traslato in `note.x, note.y`).
                            `x = 10` per il testo e per ogni `tspan`, così l'intero
                            contenuto resta rigorosamente dentro il rettangolo. Il
                            clip aggiuntivo vale solo per un box più basso del testo. */}
                        <g
                          clipPath={
                            textHeight > height ? `url(#${clipIdForNote(note.id)})` : undefined
                          }
                        >
                          <text
                            x={NOTE_PADDING_CM}
                            fontSize={fontSize}
                            className="fill-slate-700 pointer-events-none select-none"
                          >
                            {lines.map((line, index) => (
                              <tspan
                                key={index}
                                x={NOTE_PADDING_CM}
                                y={firstBaselineCm + index * lineHeightCm}
                              >
                                {line}
                              </tspan>
                            ))}
                          </text>
                        </g>

                        {/* MANIGLIA DI RIDIMENSIONAMENTO (angolo basso-destro):
                            visibile solo sulla nota selezionata. Il gesto è catturato
                            qui e non propaga né alla card (drag Y) né al canvas (pan). */}
                        {isSelected && (
                          <rect
                            x={note.width - NOTE_RESIZE_HANDLE_SIZE_CM}
                            y={height - NOTE_RESIZE_HANDLE_SIZE_CM}
                            width={NOTE_RESIZE_HANDLE_SIZE_CM}
                            height={NOTE_RESIZE_HANDLE_SIZE_CM}
                            rx={1.5}
                            fill={NOTE_RESIZE_HANDLE_COLOR}
                            className="cursor-se-resize"
                            onPointerDown={(e) =>
                              handleNoteResizePointerDown(
                                note,
                                height,
                                view.offset,
                                view.bay.vehicle.width,
                                e
                              )
                            }
                            onClick={(e) => e.stopPropagation()}
                          />
                        )}
                      </g>
                    );
                  }
                )}

                {/* Intestazione dello stallo: pillola a riga singola con il nome
                    del mezzo, il badge `ATTIVO` e il disco di eliminazione. */}
                {renderBayHeader(view)}

                {/* ZONA DI RILASCIO (Drag Overlay cross-pianale): quando il
                    cursore è dentro la sagoma di un ALTRO stallo, il pianale
                    bersaglio mostra un contorno blu di evidenziazione e, sopra la
                    Cabina, l'invito esplicito al rilascio. Il livello è disegnato
                    per ultimo, quindi resta sopra il fondo bianco del mezzo. */}
                {dragOverlay &&
                  dragOverlay.targetBayId === view.bay.id &&
                  dragOverlay.targetBayId !== dragOverlay.sourceBayId && (
                    <g data-canvas-drop-target={view.bay.id} pointerEvents="none">
                      <rect
                        x={0}
                        y={0}
                        width={view.bay.vehicle.width}
                        height={view.bay.vehicle.length}
                        rx={4}
                        fill="none"
                        stroke={SELECTION_COLOR}
                        strokeWidth={DROP_HIGHLIGHT_STROKE_CM}
                        strokeDasharray="10 5"
                        opacity={0.9}
                      />
                      {/* Badge di rilascio: vive nella fascia di intestazione,
                          **sotto** la pillola `MEZZO n` (`BAY_HEADER_BOTTOM_CM`)
                          e con margine di sicurezza sopra la sommità del glifo
                          della targa, così resta sempre a schermo senza coprire
                          né l'header dello stallo né la targa del mezzo. */}
                      <g
                        transform={`translate(${view.bay.vehicle.width / 2}, ${
                          BAY_HEADER_BOTTOM_CM + 20
                        })`}
                      >
                        {/* Pastiglia centrata sull'asse del pianale: l'ingombro
                            (304 cm) è tarato sulla battuta più lunga possibile
                            (`📥 Rilascia per caricare su MEZZO n`, ~300 cm con le
                            metriche reali di Helvetica sui glifi emoji), così il
                            testo non sborda mai dal proprio fondo blu. */}
                        <rect
                          x={-152}
                          y={-24}
                          width={304}
                          height={34}
                          rx={6}
                          fill={SELECTION_COLOR}
                        />
                        <text
                          x={0}
                          y={0}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fontFamily={FONT_FAMILY_LABEL}
                          fontSize={15}
                          fontWeight="800"
                          fill="#FFFFFF"
                        >
                          📥 Rilascia per caricare su MEZZO {view.index + 1}
                        </text>
                      </g>
                    </g>
                  )}
              </g>
            ))}

            {/* ---------------------------------------------------------------- *
             *  DRAG OVERLAY — LIVELLO SVG GLOBALE (in coda al mondo)
             *
             *  I colli in movimento vivono QUI, in coordinate di mondo, sopra
             *  **tutti** gli stalli: il fondo bianco (`fill="white"`) del camion
             *  adiacente non può più coprirli mentre attraversano il canale di
             *  180 cm. L'ombra CAD (`drop-shadow-lg`) li stacca dal piano e il
             *  layer non intercetta alcun evento (`pointerEvents="none"`), così il
             *  pointer capture del gesto resta sul collo di partenza.
             * ----------------------------------------------------------------- */}
            {dragOverlay && (
              <g id="canvas-drag-overlay" data-canvas-drag-overlay="true" pointerEvents="none">
                {dragOverlay.members.map((member) => {
                  const isInTransit = dragOverlay.targetBayId === null;
                  return (
                    <g
                      key={`overlay-${member.item.id}`}
                      transform={`translate(${member.worldX}, ${member.worldY})`}
                      opacity={isInTransit ? TRANSIT_OPACITY : 1}
                      filter="url(#truck-shadow)"
                    >
                      <rect
                        width={member.item.width}
                        height={member.item.length}
                        fill={member.item.color}
                        stroke={isInTransit ? TRANSIT_COLOR : DRAG_OVERLAY_BORDER}
                        strokeWidth={2.5}
                        strokeDasharray={isInTransit ? '6 3' : undefined}
                        rx={2}
                      />
                      <g clipPath={`url(#${clipIdForItem(member.item.id)})`}>
                        {renderItemLabels(member.item)}
                      </g>
                      {isInTransit && (
                        <text
                          x={member.item.width / 2}
                          y={member.item.length / 2 + 3}
                          textAnchor="middle"
                          className="text-[9px] font-bold fill-slate-700 select-none"
                        >
                          (zona neutra)
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            )}
          </g>

          {/* Rettangolo di selezione (lasso): disegnato in px schermo, sopra il
              mondo trasformato, così bordo e tratteggio restano costanti. */}
          {lasso && (
            <rect
              x={Math.min(lasso.start.x, lasso.current.x)}
              y={Math.min(lasso.start.y, lasso.current.y)}
              width={Math.abs(lasso.current.x - lasso.start.x)}
              height={Math.abs(lasso.current.y - lasso.start.y)}
              fill={LASSO_FILL}
              fillOpacity={LASSO_FILL_OPACITY}
              stroke={SELECTION_COLOR}
              strokeWidth={1}
              strokeDasharray="6 4"
              pointerEvents="none"
            />
          )}
        </svg>
      </div>

      {/* HUD flottante (basso a sinistra): densità etichette + Zoom & Pan.
          `print:hidden`: l'HUD non deve comparire sulla scheda A4 stampata. */}
      <div className="canvas-hud print:hidden absolute bottom-5 left-5 z-10 flex flex-col items-start gap-1.5">
        {/* Selettore compatto densità etichette (stile sobrio CAD) */}
        <div
          role="group"
          aria-label="Densità etichette"
          className="flex items-center gap-0.5 rounded-lg border border-slate-300 bg-white/90 backdrop-blur-sm px-1 py-0.5 shadow-sm"
        >
          {LABEL_DENSITY_OPTIONS.map((option) => {
            const isActive = labelDensity === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onChangeLabelDensity(option.value)}
                title={option.title}
                aria-pressed={isActive}
                className={`rounded px-2 py-1 text-[10px] leading-none transition ${
                  isActive
                    ? 'bg-slate-800 text-white font-bold'
                    : 'text-slate-500 hover:text-slate-700 font-medium hover:bg-slate-100'
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-0.5 rounded-lg border border-slate-300 bg-white/85 backdrop-blur-sm px-1.5 py-1 shadow-sm">
          <button
            type="button"
            onClick={() => zoomByStep(-1)}
            disabled={!canZoomOut}
            title="Zoom Out"
            aria-label="Zoom Out"
            className="flex h-7 w-7 items-center justify-center rounded text-slate-600 transition hover:bg-slate-100 hover:text-blue-600 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <Minus className="h-4 w-4" />
          </button>

          <span className="min-w-[3.25rem] text-center text-xs font-mono font-bold text-slate-700 tabular-nums">
            {zoomPercent}%
          </span>

          <button
            type="button"
            onClick={() => zoomByStep(1)}
            disabled={!canZoomIn}
            title="Zoom In"
            aria-label="Zoom In"
            className="flex h-7 w-7 items-center justify-center rounded text-slate-600 transition hover:bg-slate-100 hover:text-blue-600 disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <Plus className="h-4 w-4" />
          </button>

          <div className="mx-1 h-5 w-px bg-slate-200" />

          <button
            type="button"
            onClick={resetView}
            title="Reset / Adatta a schermo (100%)"
            aria-label="Reset / Adatta a schermo"
            className="flex h-7 w-7 items-center justify-center rounded text-slate-600 transition hover:bg-slate-100 hover:text-blue-600"
          >
            <Maximize className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
