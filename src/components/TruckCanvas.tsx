import React, { useEffect, useRef, useState } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import type { VehicleConfig, PlacedItem, ItemPositionUpdate, LabelDensity } from '../types';
import {
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
  LDM_GUIDE_COLOR,
  NOMINAL_QUOTA_CM,
  NOMINAL_QUOTA_COLOR,
} from '../constants';
import {
  clipIdForItem,
  NARROW_ITEM_WIDTH_CM,
  shouldWrapLabel,
  splitLabelIntoTwoLines,
} from '../utils/labels';

/** Colori del rettangolo di selezione (lasso) e della selezione attiva. */
const SELECTION_COLOR = '#2563EB';
const LASSO_FILL = '#3B82F6';
const LASSO_FILL_OPACITY = 0.15;

/** Spostamento minimo (px schermo) oltre il quale un drag non è più un click. */
const DRAG_THRESHOLD_PX = 3;

/* --- Blocco corsa rotellina / pan (clamp sull'asse Y) ---------------------- */
/** Margine (px) che il camion non può superare: una porzione resta sempre visibile. */
const PAN_CLAMP_MARGIN_PX = 120;

/**
 * Blocca il pan verticale perché il semirimorchio non possa essere spinto
 * completamente fuori dalla visuale:
 * - `minPanY = -(vehicle.length * zoom) + 120` → le porte posteriori non salgono
 *   oltre la parte alta dello schermo;
 * - `maxPanY = containerHeight - 120` → la cabina non scende oltre il fondo.
 */
const clampPanY = (
  value: number,
  zoom: number,
  vehicleLength: number,
  containerHeight: number
): number => {
  const minPanY = -(vehicleLength * zoom) + PAN_CLAMP_MARGIN_PX;
  const maxPanY = containerHeight - PAN_CLAMP_MARGIN_PX;
  return Math.min(maxPanY, Math.max(minPanY, value));
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
  /** Tutti i membri trascinati (incluso il primario) con le posizioni iniziali. */
  members: {
    id: string;
    startX: number;
    startY: number;
    width: number;
    length: number;
  }[];
}

interface TruckCanvasProps {
  vehicle: VehicleConfig;
  items: PlacedItem[];
  selectedItemIds: string[];
  /** Densità delle etichette stampate dentro i colli. */
  labelDensity: LabelDensity;
  onChangeLabelDensity: (density: LabelDensity) => void;
  onSelectItems: (ids: string[]) => void;
  onUpdateItemsPos: (updates: ItemPositionUpdate[]) => void;
}

export const TruckCanvas: React.FC<TruckCanvasProps> = ({
  vehicle,
  items,
  selectedItemIds,
  labelDensity,
  onChangeLabelDensity,
  onSelectItems,
  onUpdateItemsPos,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingItem = useRef<DragState | null>(null);
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

  // Contatore dinamico LDM (metri lineari occupati): Y massima dei colli stivati.
  const maxOccupiedY = items.reduce((max, item) => Math.max(max, item.y + item.length), 0);
  const hasLdmBadge = maxOccupiedY > 0;

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

      // 1) Ctrl / Cmd + rotellina → Zoom fluido ancorato al cursore (stile CAD).
      if (e.ctrlKey || e.metaKey) {
        const mouse = toSvgPoint(e.clientX, e.clientY);
        if (!mouse) return;

        const deltaY = normalizeDelta(e.deltaY, e.deltaMode);
        const factor = Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY);

        setView((prev) => {
          const nextZoom = clampZoom(prev.zoom * factor, prev.fitZoom);
          if (nextZoom === prev.zoom) return prev;
          return zoomAroundPoint(prev, nextZoom, mouse);
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
      //    Il pan è clampato perché una porzione del pianale resti sempre visibile.
      const deltaY = normalizeDelta(e.deltaY, e.deltaMode);
      const containerHeight = container.getBoundingClientRect().height;
      setView((prev) => ({
        ...prev,
        pan: {
          ...prev.pan,
          y: clampPanY(prev.pan.y - deltaY, prev.zoom, vehicle.length, containerHeight),
        },
      }));
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [vehicle.length]);

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

    draggingItem.current = {
      primaryId: item.id,
      startCursor: cursor,
      startX: item.x,
      startY: item.y,
      primaryWidth: item.width,
      primaryLength: item.length,
      members,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
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
      // Pan verticale clampato: una porzione del pianale resta sempre in vista.
      const panHeight = measureViewport().h;
      setView((prev) => ({
        ...prev,
        pan: {
          x: panning.pan.x + (current.x - panning.start.x),
          y: clampPanY(
            panning.pan.y + (current.y - panning.start.y),
            prev.zoom,
            vehicle.length,
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

    const hits = items
      .filter((item) => isRectColliding(x, y, width, length, item))
      .map((item) => item.id);

    if (hits.length === 0) return;

    // Il lasso AGGIUNGE alla selezione corrente, senza duplicati.
    onSelectItems(Array.from(new Set([...selectedItemIds, ...hits])));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      // Il capture è sull'elemento che ha ricevuto il pointerdown (collo o sfondo).
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      // Il pointer capture potrebbe essere già stato rilasciato dal browser.
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

    panningView.current = null;
    setIsPanning(false);
    draggingItem.current = null;
  };

  // --- Zoom da pulsanti HUD (ancorato al centro del viewport) ---------------
  const zoomByStep = (sign: number) => {
    const center = { x: viewport.w / 2, y: viewport.h / 2 };
    setView((prev) => {
      const nextZoom = clampZoom(
        prev.zoom + sign * ZOOM_STEP_RATIO * prev.fitZoom,
        prev.fitZoom
      );
      if (nextZoom === prev.zoom) return prev;
      return zoomAroundPoint(prev, nextZoom, center);
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
          onSelectItems([]);
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
            {/* Un clipPath per ogni collo: il testo resta fisicamente dentro il
                proprio rettangolo e non può sbordare sui colli adiacenti. */}
            {items.map((item) => (
              <clipPath key={item.id} id={clipIdForItem(item.id)}>
                <rect width={item.width} height={item.length} />
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

            {/* Contatore dinamico LDM: linea guida alla Y massima occupata e badge
                scuro ad alto contrasto nel righello di sinistra. */}
            {hasLdmBadge && (
              <g>
                <line
                  x1={0}
                  y1={maxOccupiedY}
                  x2={vehicle.width}
                  y2={maxOccupiedY}
                  stroke={LDM_GUIDE_COLOR}
                  strokeWidth="1"
                  strokeDasharray="6 4"
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

            {/* Intestazione: CABINA */}
            <text
              x={vehicle.width / 2}
              y={-34}
              textAnchor="middle"
              className="text-[15px] font-bold fill-slate-700 tracking-wider"
            >
              ▲ [ CABINA ] ▲
            </text>

            {/* Quota larghezza utile */}
            <text
              x={vehicle.width / 2}
              y={-10}
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
              ▼ [ PORTE POSTERIORI ] ▼
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
