import React, { useRef } from 'react';
import type { VehicleConfig, PlacedItem } from '../types';
import { calculateSnapPosition, hasCollision, toPrecision } from '../utils/snapping';

/** Colore d'avviso per i colli in sovrapposizione (fuori sagoma). */
const COLLISION_COLOR = '#EF4444';

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
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingItem = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);

  // Margini del disegno in cm per fare spazio alle quote e alle indicazioni
  const marginX = 40;
  const marginY = 50;
  const totalViewWidth = vehicle.width + marginX * 2;
  const totalViewHeight = vehicle.length + marginY * 2;

  // Calcolo delle tacche metriche ogni metro (100 cm)
  const meterMarkers = [];
  for (let y = 100; y < vehicle.length; y += 100) {
    meterMarkers.push(y);
  }

  // Gestione interattiva del trascinamento
  const handlePointerDown = (item: PlacedItem, e: React.PointerEvent) => {
    e.stopPropagation();
    onSelectItem(item.id);
    (e.target as Element).setPointerCapture(e.pointerId);

    const svg = svgRef.current;
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());

    draggingItem.current = {
      id: item.id,
      offsetX: svgP.x - (marginX + item.x),
      offsetY: svgP.y - (marginY + item.y),
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!draggingItem.current || !svgRef.current) return;
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse());

    const item = items.find((i) => i.id === draggingItem.current?.id);
    if (!item) return;

    const rawX = svgP.x - marginX - draggingItem.current.offsetX;
    const rawY = svgP.y - marginY - draggingItem.current.offsetY;

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

  const handlePointerUp = (e: React.PointerEvent) => {
    if (draggingItem.current) {
      try {
        (e.target as Element).releasePointerCapture(e.pointerId);
      } catch {
        // Il pointer capture potrebbe essere già stato rilasciato dal browser.
      }
      draggingItem.current = null;
    }
  };

  return (
    <div
      className="flex justify-center items-center h-full w-full bg-slate-100 overflow-y-auto p-4 select-none"
      onClick={() => onSelectItem(null)}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${totalViewWidth} ${totalViewHeight}`}
        className="h-[92vh] max-w-full drop-shadow-md bg-white rounded-lg border border-slate-300"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* Intestazione: CABINA */}
        <text
          x={totalViewWidth / 2}
          y={marginY - 18}
          textAnchor="middle"
          className="text-[15px] font-bold fill-slate-700 tracking-wider"
        >
          ▲ [ CABINA ] ▲
        </text>

        {/* Parete frontale Cabina */}
        <line
          x1={marginX}
          y1={marginY}
          x2={marginX + vehicle.width}
          y2={marginY}
          stroke="#0F172A"
          strokeWidth="4"
        />

        {/* Spalla Laterale Sinistra */}
        <line
          x1={marginX}
          y1={marginY}
          x2={marginX}
          y2={marginY + vehicle.length}
          stroke="#0F172A"
          strokeWidth="3"
        />

        {/* Spalla Laterale Destra */}
        <line
          x1={marginX + vehicle.width}
          y1={marginY}
          x2={marginX + vehicle.width}
          y2={marginY + vehicle.length}
          stroke="#0F172A"
          strokeWidth="3"
        />

        {/* Righelli metrici di fondo (linee ogni metro) */}
        {meterMarkers.map((yVal) => (
          <g key={yVal}>
            <line
              x1={marginX}
              y1={marginY + yVal}
              x2={marginX + vehicle.width}
              y2={marginY + yVal}
              stroke="#E2E8F0"
              strokeDasharray="4 4"
              strokeWidth="1"
            />
            <text
              x={marginX - 8}
              y={marginY + yVal + 4}
              textAnchor="end"
              className="text-[10px] fill-slate-400 font-mono"
            >
              {(yVal / 100).toFixed(0)}m
            </text>
          </g>
        ))}

        {/* Parete posteriore / PORTE */}
        <line
          x1={marginX}
          y1={marginY + vehicle.length}
          x2={marginX + vehicle.width}
          y2={marginY + vehicle.length}
          stroke="#0F172A"
          strokeWidth="4"
          strokeDasharray="16 8"
        />
        <text
          x={totalViewWidth / 2}
          y={marginY + vehicle.length + 26}
          textAnchor="middle"
          className="text-[14px] font-bold fill-slate-700 tracking-wider"
        >
          ▼ [ PORTE POSTERIORI ] ▼
        </text>

        {/* Quota larghezza utile */}
        <text
          x={totalViewWidth / 2}
          y={marginY - 5}
          textAnchor="middle"
          className="text-[11px] font-mono fill-slate-500"
        >
          {vehicle.width} cm
        </text>

        {/* Rendering dei Colli Stivati */}
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
              transform={`translate(${marginX + item.x}, ${marginY + item.y})`}
              onPointerDown={(e) => handlePointerDown(item, e)}
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
      </svg>
    </div>
  );
};