import React, { useEffect, useRef, useState } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import type { VehicleConfig, PlacedItem } from '../types';
import { calculateSnapPosition, hasCollision, toPrecision } from '../utils/snapping';

/** Colore d'avviso per i colli in sovrapposizione (fuori sagoma). */
const COLLISION_COLOR = '#EF4444';

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

interface TruckCanvasProps {
  vehicle: VehicleConfig;
  items: PlacedItem[];
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
  onUpdateItemPos: (id: string, x: number, y: number) => void;
}

export const TruckCanvas: React.FC<TruckCanvasProps> = ({
  vehicle,
  items,
  selectedItemId,
  onSelectItem,
  onUpdateItemPos,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingItem = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const panningView = useRef<{ start: Point; pan: Point } | null>(null);

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

    const handleWheel = (e: WheelEvent) => {
      // Blocca lo scroll della pagina: listener nativo non passivo.
      e.preventDefault();
      const mouse = toSvgPoint(e.clientX, e.clientY);
      if (!mouse) return;

      // Normalizza le unità di delta (pixel, righe, pagine) dei vari device.
      const deltaY =
        e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const factor = Math.exp(-deltaY * WHEEL_ZOOM_SENSITIVITY);

      setView((prev) => {
        const nextZoom = clampZoom(prev.zoom * factor, prev.fitZoom);
        if (nextZoom === prev.zoom) return prev;
        return zoomAroundPoint(prev, nextZoom, mouse);
      });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  // --- Pan: trascinamento sullo sfondo grigio -------------------------------
  const handleBackgroundPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const start = toSvgPoint(e.clientX, e.clientY);
    if (!start) return;

    e.currentTarget.setPointerCapture(e.pointerId);
    panningView.current = { start, pan: { ...pan } };
    setIsPanning(true);
  };

  // --- Drag dei colli -------------------------------------------------------
  const handlePointerDown = (item: PlacedItem, e: React.PointerEvent) => {
    e.stopPropagation();
    onSelectItem(item.id);
    (e.target as Element).setPointerCapture(e.pointerId);

    // Offset in cm reali: indipendente dal livello di zoom e dal pan.
    const cursor = toCanvasCm(e.clientX, e.clientY);
    if (!cursor) return;

    draggingItem.current = {
      id: item.id,
      offsetX: cursor.x - item.x,
      offsetY: cursor.y - item.y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    // 1) Pan della vista: il pan è in px schermo, quindi non dipende dallo zoom.
    const panning = panningView.current;
    if (panning) {
      const current = toSvgPoint(e.clientX, e.clientY);
      if (!current) return;
      setView((prev) => ({
        ...prev,
        pan: {
          x: panning.pan.x + (current.x - panning.start.x),
          y: panning.pan.y + (current.y - panning.start.y),
        },
      }));
      return;
    }

    // 2) Trascinamento di un collo, sempre in centimetri reali del pianale.
    if (!draggingItem.current) return;
    const cursor = toCanvasCm(e.clientX, e.clientY);
    if (!cursor) return;

    const item = items.find((i) => i.id === draggingItem.current?.id);
    if (!item) return;

    const rawX = cursor.x - draggingItem.current.offsetX;
    const rawY = cursor.y - draggingItem.current.offsetY;

    // Snap magnetico su pareti del mezzo e bordi dei colli adiacenti,
    // con clamping finale nella sagoma utile del pianale.
    const snapped = calculateSnapPosition(
      rawX,
      rawY,
      item.width,
      item.length,
      vehicle,
      items.filter((i) => i.id !== item.id)
    );

    const newX = toPrecision(snapped.x);
    const newY = toPrecision(snapped.y);

    // Evita aggiornamenti di stato inutili (e render ridondanti).
    if (newX === item.x && newY === item.y) return;

    onUpdateItemPos(item.id, newX, newY);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      // Il capture è sull'elemento che ha ricevuto il pointerdown (collo o sfondo).
      (e.target as Element).releasePointerCapture(e.pointerId);
    } catch {
      // Il pointer capture potrebbe essere già stato rilasciato dal browser.
    }
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

  return (
    <div className="relative w-full h-full overflow-hidden bg-slate-100 select-none">
      <div
        ref={containerRef}
        className="w-full h-full"
        onClick={() => onSelectItem(null)}
        onPointerDown={handleBackgroundPointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Viewport CAD a tutto schermo: nessun viewBox, 1 unità SVG = 1 px.
            Tutto il "mondo" (pianale, quote, colli) vive dentro il <g> trasformato. */}
        <svg
          ref={svgRef}
          className={`w-full h-full block touch-none cursor-grab active:cursor-grabbing ${
            isPanning ? 'cursor-grabbing' : ''
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
              const isSelected = item.id === selectedItemId;
              const colliding = hasCollision(item, items);

              // Priorità: collisione (rosso) > selezione (blu) > bordo del collo.
              // Doppio contorno quando coesistono, così i due stati restano distinguibili.
              const outerStroke = colliding ? COLLISION_COLOR : isSelected ? '#2563EB' : item.borderColor;
              const outerStrokeWidth = colliding ? 2 : isSelected ? 3 : 1.5;

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
                  {colliding && isSelected && (
                    <rect
                      x={2.5}
                      y={2.5}
                      width={Math.max(0, item.width - 5)}
                      height={Math.max(0, item.length - 5)}
                      fill="none"
                      stroke="#2563EB"
                      strokeWidth={1.5}
                      rx={1.5}
                      pointerEvents="none"
                    />
                  )}
                  {/* Testo compatto all'interno del collo */}
                  <text
                    x={item.width / 2}
                    y={item.length / 2 - 3}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="text-[11px] font-bold fill-slate-800 pointer-events-none select-none"
                  >
                    {item.name}
                  </text>
                  <text
                    x={item.width / 2}
                    y={item.length / 2 + 11}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="text-[9px] font-mono fill-slate-600 pointer-events-none select-none"
                  >
                    {item.width}×{item.length}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {/* HUD flottante Zoom & Pan (basso a sinistra, sobrio e semi-trasparente) */}
      <div className="absolute bottom-5 left-5 z-10 flex items-center gap-0.5 rounded-lg border border-slate-300 bg-white/85 backdrop-blur-sm px-1.5 py-1 shadow-sm">
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
  );
};
