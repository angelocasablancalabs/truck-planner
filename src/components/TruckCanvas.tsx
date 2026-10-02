import React, { useEffect, useRef, useState } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import type {
  VehicleConfig,
  PlacedItem,
  ItemPositionUpdate,
  LabelDensity,
  SideNote,
} from '../types';
import {
  calculateLdmMetrics,
  calculateSnapPosition,
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

/** Colori del rettangolo di selezione (lasso) e della selezione attiva. */
const SELECTION_COLOR = '#2563EB';
const LASSO_FILL = '#3B82F6';
const LASSO_FILL_OPACITY = 0.15;

/**
 * Spostamento minimo (px schermo) oltre il quale un drag non è più un click.
 */
const DRAG_THRESHOLD_PX = 3;

/** Spostamento minimo (cm reali) perché il drag di una nota sia registrato. */
const NOTE_DRAG_THRESHOLD_CM = 0.2;

/** ID del `clipPath` che ritaglia il testo di una nota sul proprio box. */
const clipIdForNote = (noteId: string): string => `note-clip-${noteId}`;

/* --- Clamp rigido intelligente del pan (asse Y) --------------------------- */
/** Margine (px) riservato in alto alla didascalia "▲ CABINA ▲". */
const PAN_TOP_MARGIN_PX = 40;
/** Margine (px) riservato in basso alla didascalia "PORTE POSTERIORI". */
const PAN_BOTTOM_MARGIN_PX = 50;
/**
 * Altezza (cm reali) della fascia sopra la Cabina occupata dal testo della targa
 * (corpo base 30 px), dalla didascalia `▲ CABINA ▲` e dalle quote: a zoom
 * elevato questa distanza cresce in pixel e gli elementi uscivano tagliati fuori
 * dal bordo alto del viewport. È **derivata** dal modulo condiviso
 * `utils/plateBadge.ts` (punto più alto dell'intestazione, `-71 cm`), quindi
 * ingrandire ancora il corpo della targa non può più tagliarne la cima: il
 * limite di pan del Caso B la include, scalata per lo zoom.
 */
const CABINA_LABEL_OFFSET_CM = -PLATE_BADGE_TOP_CM;
/**
 * Ingombro verticale (cm) delle didascalie, sommato alla lunghezza del mezzo
 * per decidere se il pianale entra interamente nello schermo (Caso A).
 *
 * Vale il **doppio** della fascia di intestazione: nel Caso A il pianale è
 * centrato e metà del margine finisce sopra la Cabina, quindi servono almeno
 * `2 × CABINA_LABEL_OFFSET_CM` perché la targa a 30 px non venga mai tagliata
 * dal bordo alto anche nella condizione limite `(L + margine) × zoom = containerH`.
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
 *   si arresta a ridosso del bordo alto (`maxPanY = 40 + 55 * zoom`, che tiene
 *   dentro anche il badge targa e la didascalia `▲ CABINA ▲`) e le Porte
 *   posteriori a ridosso di quello basso
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
 * Reset / Adatta a schermo: calcola lo zoom che fa entrare l'intero
 * semirimorchio nel viewport (con margine per le scritte Cabina/Porte)
 * e il pan che lo centra esattamente.
 */
const fitView = (vehicle: VehicleConfig, viewport: ViewportSize): ViewTransform => {
  const availableW = Math.max(1, viewport.w - FIT_PADDING_X);
  const availableH = Math.max(1, viewport.h - FIT_PADDING_Y);
  const fitZoom = Math.max(
    0.01,
    Math.min(availableW / vehicle.width, availableH / vehicle.length)
  );

  return {
    zoom: fitZoom,
    pan: {
      x: (viewport.w - vehicle.width * fitZoom) / 2,
      y: (viewport.h - vehicle.length * fitZoom) / 2,
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
 */
interface DragState {
  /** ID del collo afferrato dal puntatore (quello che guida lo snap). */
  primaryId: string;
  /** Cursore in cm reali al momento del pointerdown. */
  startCursor: Point;
  /** Posizione di partenza del collo afferrato (cm). */
  startX: number;
  startY: number;
  primaryWidth: number;
  primaryLength: number;
  /** `true` appena il trascinamento ha davvero spostato il gruppo (cm reali):
   *  è la condizione con cui il gesto viene convalidato nella cronologia. */
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
 * Stato del trascinamento di una nota laterale: la card si sposta **liberamente
 * in 2D** (`ΔX`, `ΔY` in cm reali), quindi può essere portata a sinistra del
 * rimorchio (`X < 0`), oltre la parete destra, lungo il pianale o in coda.
 */
interface NoteDragState {
  id: string;
  /** Cursore in cm reali al momento del pointerdown. */
  startCursorX: number;
  startCursorY: number;
  /** Posizione di partenza della nota (cm). */
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
  /** Cursore in cm reali al momento del pointerdown sulla maniglia. */
  startCursorX: number;
  startCursorY: number;
  /** Dimensioni di partenza del box (cm). */
  startWidth: number;
  startHeight: number;
  /** `true` appena larghezza o altezza sono cambiate davvero. */
  moved: boolean;
}

interface TruckCanvasProps {
  vehicle: VehicleConfig;
  items: PlacedItem[];
  /** Note laterali: vivono nella corsia a destra della parete del mezzo. */
  notes: SideNote[];
  /**
   * Targa / identificativo del mezzo: disegnato nel badge tecnico sopra la
   * Cabina, centrato sull'asse del pianale e aggiornato in tempo reale. Un click
   * sul badge riporta il focus sul campo di testo della sidebar.
   */
  plate: string;
  selectedItemIds: string[];
  /** Nota selezionata (null = nessuna): bordo blu sulla card e pannello sidebar. */
  selectedNoteId: string | null;
  /** Densità delle etichette stampate dentro i colli. */
  labelDensity: LabelDensity;
  onChangeLabelDensity: (density: LabelDensity) => void;
  onSelectItems: (ids: string[]) => void;
  /** Selezione di una nota (azzera la selezione dei colli). */
  onSelectNote: (id: string | null) => void;
  /** Trascinamento libero 2D di una nota (X e Y in cm reali). */
  onUpdateNotePos: (id: string, x: number, y: number) => void;
  /** Ridimensionamento della card di nota (larghezza / altezza in cm). */
  onUpdateNoteSize: (id: string, size: { width: number; height: number }) => void;
  onUpdateItemsPos: (updates: ItemPositionUpdate[]) => void;
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
  vehicle,
  items,
  notes,
  plate,
  selectedItemIds,
  selectedNoteId,
  labelDensity,
  onChangeLabelDensity,
  onSelectItems,
  onSelectNote,
  onUpdateNotePos,
  onUpdateNoteSize,
  onUpdateItemsPos,
  onBeginHistoryGesture,
  onCommitHistoryGesture,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingItem = useRef<DragState | null>(null);
  const draggingNote = useRef<NoteDragState | null>(null);
  const resizingNote = useRef<NoteResizeState | null>(null);
  const panningView = useRef<{ start: Point; pan: Point; moved: boolean } | null>(null);

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

  // Calcolo delle tacche metriche ogni metro (100 cm)
  const meterMarkers = [];
  for (let y = 100; y < vehicle.length; y += 100) {
    meterMarkers.push(y);
  }

  // Quota nominale 13,20 m: tracciata solo sui mezzi che la raggiungono.
  const showsNominalQuota = vehicle.length >= NOMINAL_QUOTA_CM;

  /**
   * Contatore dinamico LDM (metri lineari occupati), calcolato con la **Regola
   * della Corsia di Parete** dalla funzione pura condivisa `calculateLdmMetrics`:
   * un collo impegna una corsia di parete solo se la tocca davvero, mentre i
   * colli a tutta larghezza (es. Sfuso) occupano inevitabilmente entrambe le
   * corsie. La stessa funzione alimenta l'export PNG e la scheda di stampa A4,
   * quindi le tre rese non possono divergere.
   */
  const midX = vehicle.width / 2;
  const ldm = calculateLdmMetrics(vehicle, items);
  const leftOccupiedY = ldm.leftY;
  const rightOccupiedY = ldm.rightY;
  const maxOccupiedY = ldm.maxOccupiedY;

  /**
   * Con densità etichette `minimal` il disegno resta volutamente pulito: le
   * linee guida e i badge LDM vengono nascosti (il dato resta comunque nella
   * tabella della scheda A4).
   */
  const showsLdmIndicator = labelDensity !== 'minimal' && maxOccupiedY > 0;

  /**
   * Quota di fondo dinamica: l'ingombro più profondo del carico può superare la
   * lunghezza del mezzo (colli in eccesso accodati oltre le porte posteriori,
   * fino a `REAR_OVERHANG_LIMIT`). La corsa di pan verticale si estende di
   * conseguenza, così l'ultimo collo sbordato resta raggiungibile con la
   * rotellina per selezionarlo, trascinarlo o eliminarlo. A pianale in sagoma
   * `effectiveLength` coincide con `vehicle.length` e nulla cambia.
   */
  const maxItemBottom = items.reduce((max, item) => Math.max(max, item.y + item.length), 0);
  const effectiveLength = Math.max(vehicle.length, maxItemBottom);
  // Sotto la tolleranza di 1 cm i due lati sono considerati simmetrici.
  const ldmIsSymmetric = !ldm.isAsymmetric;
  // Lato più carico = badge scuro primario; lato meno carico = slate intermedio.
  const leftLdmIsHeavier = leftOccupiedY >= rightOccupiedY;
  const leftLdmBadgeColor = leftLdmIsHeavier ? LDM_BADGE_COLOR : LDM_BADGE_MUTED_COLOR;
  const rightLdmBadgeColor = leftLdmIsHeavier ? LDM_BADGE_MUTED_COLOR : LDM_BADGE_COLOR;
  // Badge del lato destro: subito oltre la parete destra del pianale.
  const rightLdmBadgeLeftX = ldmBadgeRightLeftX(vehicle.width);
  const rightLdmBadgeCenterX = ldmBadgeRightCenterX(vehicle.width);

  /**
   * Badge Targa / Identificativo Mezzo: **solo testo**, centrato sull'asse del
   * pianale nella fascia di intestazione (corpo base 30 px), sopra la didascalia
   * `▲ CABINA ▲`. La scritta può sforare di 50 cm per lato oltre le sponde: la
   * geometria arriva dal modulo condiviso `utils/plateBadge.ts`, quindi canvas,
   * snapshot PNG e scheda A4 disegnano esattamente la stessa scritta.
   *
   * A riposo — targa vuota o di soli spazi — la funzione restituisce `null`:
   * l'area sopra la Cabina resta completamente pulita e trasparente, senza
   * rettangoli tratteggiati né testi segnaposto.
   */
  const plateBadge = plateBadgeLayout(vehicle.width, plate);

  /**
   * Note laterali: posizionamento **liberamente 2D**. Di default nascono a
   * `X = vehicle.width + NOTE_LANE_OFFSET_CM` (subito a destra della parete), ma
   * possono essere trascinate ovunque attorno al camion — anche a sinistra del
   * rimorchio. Le card non entrano mai nel calcolo dei metri lineari e nessuna
   * viene spostata d'ufficio: `resolveNoteLayouts` si limita a misurarle.
   */
  const noteLayouts = resolveNoteLayouts(notes);
  const selectedNoteIdSet = new Set(selectedNoteId ? [selectedNoteId] : []);

  /**
   * Trascinamento di una nota: si aggiornano **entrambe** le coordinate in cm
   * reali (`ΔX`, `ΔY` dal pointerdown). La Y resta clampata tra 0 (Cabina) e la
   * quota di fondo dinamica `effectiveLength` (Porte posteriori o ultimo collo
   * sbordato); la X può invece andare a sinistra del rimorchio (`X < 0`) o oltre
   * la parete destra, entro lo spazio di lavoro `noteMinX` / `noteMaxX`.
   */
  const handleNotePointerDown = (note: SideNote, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Il gesto è della nota: non deve né selezionare i colli né panare la vista.
    e.stopPropagation();

    const cursor = toCanvasCm(e.clientX, e.clientY);
    if (!cursor) return;

    (e.target as Element).setPointerCapture(e.pointerId);
    onSelectNote(note.id);
    // Apre il gesto in cronologia: il fotogramma verrà convalidato al rilascio
    // solo se la nota si è davvero spostata (1 drag = 1 passo di Undo).
    onBeginHistoryGesture();
    draggingNote.current = {
      id: note.id,
      startCursorX: cursor.x,
      startCursorY: cursor.y,
      startX: note.x,
      startY: note.y,
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
      startCursorX: cursor.x,
      startCursorY: cursor.y,
      startWidth: note.width,
      startHeight: height,
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

  /** Reset / Adatta: vista d'insieme completa del camion centrata. */
  const resetView = () => setView(fitView(vehicle, measureViewport()));

  // Adatta a schermo al primo render utile e ad ogni cambio mezzo
  // (pattern React di "aggiustamento dello stato durante il render").
  const fitSignature = `${vehicle.id}:${vehicle.width}:${vehicle.length}`;
  const [fittedSignature, setFittedSignature] = useState<string | null>(null);
  const isViewportReady = viewport.w > 0 && viewport.h > 0;
  if (isViewportReady && fittedSignature !== fitSignature) {
    setFittedSignature(fitSignature);
    setView(fitView(vehicle, viewport));
  }

  /**
   * Riallineamento alla quota di fondo dinamica (stesso pattern di
   * "aggiustamento dello stato durante il render"): quando il collo sbordato
   * viene eliminato — o rientra in sagoma — il limite inferiore torna a filo
   * PORTE POSTERIORI e la vista vi si riallinea subito, senza restare appesa
   * nello spazio grigio in attesa di un altro movimento di rotellina.
   */
  const [clampedLength, setClampedLength] = useState<number | null>(null);
  if (isViewportReady && clampedLength !== effectiveLength) {
    setClampedLength(effectiveLength);
    setView((prev) => {
      const clampedY = clampPanY(prev.pan.y, prev.zoom, effectiveLength, viewport.h);
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
              y: clampPanY(zoomed.pan.y, zoomed.zoom, effectiveLength, containerHeight),
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
          y: clampPanY(prev.pan.y - deltaY, prev.zoom, effectiveLength, containerHeight),
        },
      }));
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [effectiveLength]);

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
  const handlePointerDown = (item: PlacedItem, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();

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

    // Congela il gruppo: il drag partirà solo se il puntatore si muove davvero.
    const memberIds = new Set(nextIds);
    const members = items
      .filter((other) => memberIds.has(other.id))
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
      const width = Math.max(
        NOTE_MIN_WIDTH_CM,
        Math.min(NOTE_MAX_WIDTH_CM, resize.startWidth + (cursor.x - resize.startCursorX))
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
      const deltaX = cursor.x - noteDrag.startCursorX;
      const deltaY = cursor.y - noteDrag.startCursorY;
      if (Math.hypot(deltaX, deltaY) > NOTE_DRAG_THRESHOLD_CM) noteDrag.moved = true;
      if (!noteDrag.moved) return;
      const nextX = Math.max(
        noteMinX(vehicle.width),
        Math.min(noteMaxX(vehicle.width), noteDrag.startX + deltaX)
      );
      const nextY = Math.max(0, Math.min(effectiveLength, noteDrag.startY + deltaY));
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
            effectiveLength,
            panHeight
          ),
        },
      }));
      return;
    }

    // 3) Trascinamento (singolo o di gruppo), sempre in centimetri reali.
    const drag = draggingItem.current;
    if (!drag) return;
    const cursor = toCanvasCm(e.clientX, e.clientY);
    if (!cursor) return;

    const deltaX = cursor.x - drag.startCursor.x;
    const deltaY = cursor.y - drag.startCursor.y;

    // Il collo afferrato guida lo snap magnetico su pareti e colli esterni al
    // gruppo; gli altri membri ricevono poi lo stesso delta.
    const groupIds = new Set(drag.members.map((member) => member.id));
    const snapped = calculateSnapPosition(
      drag.startX + deltaX,
      drag.startY + deltaY,
      drag.primaryWidth,
      drag.primaryLength,
      vehicle,
      items.filter((other) => !groupIds.has(other.id))
    );

    let dx = snapped.x - drag.startX;
    let dy = snapped.y - drag.startY;

    // Clamping del delta: TUTTO il gruppo deve restare nella sagoma consentita
    // (pareti laterali rigide, cabina rigida, buffer posteriore di overhang).
    let dxMin = -Infinity;
    let dxMax = Infinity;
    let dyMin = -Infinity;
    let dyMax = Infinity;

    for (const member of drag.members) {
      dxMin = Math.max(dxMin, -member.startX);
      dxMax = Math.min(dxMax, vehicle.width - member.width - member.startX);
      dyMin = Math.max(dyMin, -member.startY);
      dyMax = Math.min(
        dyMax,
        vehicle.length + REAR_OVERHANG_LIMIT - member.length - member.startY
      );
    }

    if (dxMin <= dxMax) dx = Math.max(dxMin, Math.min(dxMax, dx));
    if (dyMin <= dyMax) dy = Math.max(dyMin, Math.min(dyMax, dy));

    // Spostamento reale: il gesto avrà diritto a un passo di Undo al rilascio.
    if (dx !== 0 || dy !== 0) drag.moved = true;

    const updates: ItemPositionUpdate[] = drag.members.map((member) => ({
      id: member.id,
      x: toPrecision(member.startX + dx),
      y: toPrecision(member.startY + dy),
    }));

    onUpdateItemsPos(updates);
  };

  /** Selezione via lasso: AABB in cm tra il rettangolo tracciato e ogni collo. */
  const applyLassoSelection = (endCm: Point) => {
    const start = lassoStart.current;
    if (!start) return;

    const x = Math.min(start.x, endCm.x);
    const y = Math.min(start.y, endCm.y);
    const width = Math.abs(endCm.x - start.x);
    const length = Math.abs(endCm.y - start.y);

    const hitItemIds = items
      .filter((item) => isRectColliding(x, y, width, length, item))
      .map((item) => item.id);

    // Selezione ESCLUSIVA: il lasso sostituisce integralmente la selezione
    // corrente. Qualsiasi collo selezionato in precedenza e non intersecato dal
    // rettangolo viene deselezionato all'istante (nessuna selezione cumulativa).
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

    // Trascinamento di colli concluso: l'intero gesto entra in cronologia come
    // UN solo passo (e solo se ha davvero spostato qualcosa).
    const itemDrag = draggingItem.current;
    if (itemDrag) onCommitHistoryGesture(itemDrag.moved);

    panningView.current = null;
    setIsPanning(false);
    draggingItem.current = null;
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
          y: clampPanY(zoomed.pan.y, zoomed.zoom, effectiveLength, containerHeight),
        },
      };
    });
  };

  const zoomPercent = Math.round((zoom / fitZoom) * 100);
  const canZoomOut = zoom > fitZoom * MIN_ZOOM_RATIO + 0.0001;
  const canZoomIn = zoom < fitZoom * MAX_ZOOM_RATIO - 0.0001;

  const selectedIdSet = new Set(selectedItemIds);
  const selectedItems = items.filter((item) => selectedIdSet.has(item.id));

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
            {/* Un clipPath per ogni collo: il testo resta fisicamente dentro il
                proprio rettangolo e non può sbordare sui colli adiacenti. */}
            {items.map((item) => (
              <clipPath key={item.id} id={clipIdForItem(item.id)}>
                <rect width={item.width} height={item.length} />
              </clipPath>
            ))}
            {/* Un clipPath per ogni nota: interviene solo se l'operatore ha
                ridotto il box a un'altezza inferiore a quella del testo. */}
            {noteLayouts.map(({ note, height }) => (
              <clipPath key={note.id} id={clipIdForNote(note.id)}>
                <rect width={note.width} height={height} />
              </clipPath>
            ))}
          </defs>

          {/* MONDO VETTORIALE: origine (0,0) = angolo alto-sinistra del pianale
              (Cabina in alto, Porte posteriori in basso). Unità = centimetri reali.
              Nascosto finché il viewport non è misurato, così non c'è alcun flash. */}
          <g
            transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}
            style={{ visibility: isViewportReady ? 'visible' : 'hidden' }}
          >
            {/* Corpo del semirimorchio: oggetto vettoriale, nessun clipping ai lati */}
            <rect
              x={0}
              y={0}
              width={vehicle.width}
              height={vehicle.length}
              rx={4}
              fill="white"
              filter="url(#truck-shadow)"
            />

            {/* Parete frontale Cabina */}
            <line
              x1={0}
              y1={0}
              x2={vehicle.width}
              y2={0}
              stroke="#0F172A"
              strokeWidth="4"
            />

            {/* Spalla Laterale Sinistra */}
            <line
              x1={0}
              y1={0}
              x2={0}
              y2={vehicle.length}
              stroke="#0F172A"
              strokeWidth="3"
            />

            {/* Spalla Laterale Destra */}
            <line
              x1={vehicle.width}
              y1={0}
              x2={vehicle.width}
              y2={vehicle.length}
              stroke="#0F172A"
              strokeWidth="3"
            />

            {/* Righelli metrici di fondo (linee ogni metro) */}
            {meterMarkers.map((yVal) => (
              <g key={yVal}>
                <line
                  x1={0}
                  y1={yVal}
                  x2={vehicle.width}
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
            {showsNominalQuota && (
              <g>
                <line
                  x1={0}
                  y1={NOMINAL_QUOTA_CM}
                  x2={vehicle.width}
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
            {showsLdmIndicator && ldmIsSymmetric && (
              <g>
                <line
                  x1={0}
                  y1={maxOccupiedY}
                  x2={vehicle.width}
                  y2={maxOccupiedY}
                  stroke={LDM_GUIDE_COLOR}
                  strokeWidth="1"
                />
                <rect
                  x={LDM_BADGE_LEFT_X}
                  y={maxOccupiedY - LDM_BADGE.height / 2}
                  width={LDM_BADGE.width}
                  height={LDM_BADGE.height}
                  rx={3}
                  fill={LDM_BADGE_COLOR}
                />
                <text
                  x={LDM_BADGE_CENTER_X}
                  y={maxOccupiedY + 3.5}
                  textAnchor="middle"
                  className="text-[10px] font-bold fill-white"
                >
                  ▶ {(maxOccupiedY / 100).toFixed(2)} m
                </text>
              </g>
            )}

            {showsLdmIndicator && !ldmIsSymmetric && (
              <g>
                {/* Indicatore SX: metà sinistra del pianale. */}
                <line
                  x1={0}
                  y1={leftOccupiedY}
                  x2={midX}
                  y2={leftOccupiedY}
                  stroke={LDM_GUIDE_COLOR}
                  strokeWidth="1"
                  strokeDasharray={LDM_GUIDE_DASH}
                />
                {/* Chiusura a filo mezzeria: il tratteggio non deve lasciare la
                    linea "sospesa" prima dell'asse di mezzeria. */}
                <line
                  x1={Math.max(0, midX - LDM_GUIDE_CLOSING_LENGTH)}
                  y1={leftOccupiedY}
                  x2={midX}
                  y2={leftOccupiedY}
                  stroke={LDM_GUIDE_COLOR}
                  strokeWidth="1"
                />
                <rect
                  x={LDM_BADGE_LEFT_X}
                  y={leftOccupiedY - LDM_BADGE.height / 2}
                  width={LDM_BADGE.width}
                  height={LDM_BADGE.height}
                  rx={3}
                  fill={leftLdmBadgeColor}
                />
                <text
                  x={LDM_BADGE_CENTER_X}
                  y={leftOccupiedY + 3.5}
                  textAnchor="middle"
                  className="text-[10px] font-bold fill-white"
                >
                  ▶ {(leftOccupiedY / 100).toFixed(2)} m
                </text>

                {/* Indicatore DX: metà destra del pianale, badge oltre la parete. */}
                <line
                  x1={midX}
                  y1={rightOccupiedY}
                  x2={vehicle.width}
                  y2={rightOccupiedY}
                  stroke={LDM_GUIDE_COLOR}
                  strokeWidth="1"
                  strokeDasharray={LDM_GUIDE_DASH}
                />
                {/* Chiusura a filo parete destra (stesso motivo del lato SX). */}
                <line
                  x1={Math.max(midX, vehicle.width - LDM_GUIDE_CLOSING_LENGTH)}
                  y1={rightOccupiedY}
                  x2={vehicle.width}
                  y2={rightOccupiedY}
                  stroke={LDM_GUIDE_COLOR}
                  strokeWidth="1"
                />
                <rect
                  x={rightLdmBadgeLeftX}
                  y={rightOccupiedY - LDM_BADGE.height / 2}
                  width={LDM_BADGE.width}
                  height={LDM_BADGE.height}
                  rx={3}
                  fill={rightLdmBadgeColor}
                />
                <text
                  x={rightLdmBadgeCenterX}
                  y={rightOccupiedY + 3.5}
                  textAnchor="middle"
                  className="text-[10px] font-bold fill-white"
                >
                  ◀ {(rightOccupiedY / 100).toFixed(2)} m
                </text>
              </g>
            )}

            {/* Parete posteriore / PORTE */}
            <line
              x1={0}
              y1={vehicle.length}
              x2={vehicle.width}
              y2={vehicle.length}
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
                  sponde del mezzo (`vehicle.width + 100` cm).
                Il click riporta il focus sul campo di testo della sidebar, così
                il badge funziona da secondo aggancio della stessa informazione. */}
            {plateBadge && (
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
                  x={plateBadge.centerX}
                  y={plateBadge.centerY}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontFamily={PLATE_BADGE_FONT_FAMILY}
                  fontSize={plateBadge.fontSize}
                  fontWeight="900"
                  letterSpacing={`${PLATE_BADGE_LETTER_SPACING_EM}em`}
                  stroke="none"
                  strokeWidth={0}
                  fill={PLATE_BADGE_TEXT_COLOR}
                  className="pointer-events-none select-none"
                >
                  {plateBadge.label}
                </text>
              </g>
            )}

            {/* Intestazione: CABINA (sotto la targa). Il corpo è la costante
                condivisa `CABINA_CAPTION_FONT_SIZE`: è la quota bassa della
                gerarchia su cui è calcolata la posizione della targa. */}
            <text
              id="canvas-cabina-caption"
              x={vehicle.width / 2}
              y={CABINA_CAPTION_BASELINE_CM}
              textAnchor="middle"
              fontSize={CABINA_CAPTION_FONT_SIZE}
              className="font-bold fill-slate-700 tracking-wider"
            >
              ▲ CABINA ▲
            </text>

            {/* Quota larghezza utile */}
            <text
              x={vehicle.width / 2}
              y={WIDTH_QUOTA_BASELINE_CM}
              textAnchor="middle"
              className="text-[11px] font-mono fill-slate-500"
            >
              {vehicle.width} cm
            </text>

            {/* Didascalia: PORTE POSTERIORI */}
            <text
              x={vehicle.width / 2}
              y={vehicle.length + 28}
              textAnchor="middle"
              className="text-[14px] font-bold fill-slate-700 tracking-wider"
            >
              PORTE POSTERIORI
            </text>

            {/* Rendering dei Colli Stivati — coordinate = cm reali del pianale */}
            {items.map((item) => {
              const isSelected = selectedIdSet.has(item.id);
              // Allarme: collisione con altri colli OPPURE sforamento della
              // sagoma utile (es. accodamento oltre le porte posteriori).
              const alert = hasCollision(item, items) || isOutOfBounds(item, vehicle);

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
                  onPointerDown={(e) => handlePointerDown(item, e)}
                  onClick={(e) => e.stopPropagation()}
                  className="cursor-move transition-shadow"
                >
                  <rect
                    width={item.width}
                    height={item.length}
                    fill={item.color}
                    stroke={outerStroke}
                    strokeWidth={outerStrokeWidth}
                    rx={2}
                    className={isSelected ? 'filter drop-shadow-lg' : ''}
                  />
                  {alert && isSelected && (
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
                indica visivamente che i colli si sposteranno assieme. */}
            {groupBounds && (
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

            {/* NOTE LATERALI 2D LIBERE: ogni card vive alle proprie coordinate
                (x, y) in cm reali, quindi può stare a destra del camion, a
                sinistra (`x < 0`), lungo il pianale o in coda. Cliccando una nota
                la si seleziona (e si deselezionano i colli); trascinandola con il
                puntatore si sposta liberamente in X e Y, mentre la maniglia
                nell'angolo basso-destro ne ridimensiona il box. */}
            {noteLayouts.map(({ note, height, lines, fontSize, firstBaselineCm, lineHeightCm, textHeight }) => {
              const isSelected = selectedNoteIdSet.has(note.id);

              return (
                <g
                  key={note.id}
                  data-canvas-note={note.id}
                  transform={`translate(${note.x}, ${note.y})`}
                  onPointerDown={(e) => handleNotePointerDown(note, e)}
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
                      onPointerDown={(e) => handleNoteResizePointerDown(note, height, e)}
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
                </g>
              );
            })}
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
