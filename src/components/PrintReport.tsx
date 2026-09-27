import { useEffect, useState } from 'react';
import type { PlacedItem, VehicleConfig } from '../types';
import { PALLET_CATALOG } from '../constants';
import { getPianoExtent } from '../utils/export';

/* -------------------------------------------------------------------------- *
 *  SPRINT D — SCHEDA DI CARICO A4 / PDF
 *
 *  Il componente vive sempre nel DOM ma è invisibile a schermo: le regole
 *  `@media print` di `src/index.css` nascondono l'interfaccia interattiva
 *  (#screen-app) e mostrano solo `#print-report` a tutta pagina A4 portrait.
 * -------------------------------------------------------------------------- */

/** Corpi testo della scheda stampata, in centimetri reali del pianale. */
const PRINT_FONT = {
  name: 13,
  dimensions: 10,
  meter: 11,
  caption: 17,
  quota: 13,
} as const;

/** Palette CAD della scheda (identica allo snapshot PNG esportato). */
const COLORS = {
  wall: '#0F172A',
  deck: '#F8FAFC',
  grid: '#E2E8F0',
  gridText: '#94A3B8',
  caption: '#334155',
  name: '#1E293B',
  dimensions: '#475569',
} as const;

const FONT_FAMILY = 'Helvetica, Arial, sans-serif';
const MONO_FONT_FAMILY = '"SFMono-Regular", Menlo, Consolas, monospace';

/** Riga della tabella riepilogo in calce (colli omogenei accorpati). */
interface PrintSummaryRow {
  key: string;
  client: string;
  format: string;
  orientation: string;
  quantity: number;
}

/** Arrotonda a due decimali: attributi SVG compatti. */
const round = (value: number): number => Math.round(value * 100) / 100;

/** Tronca il testo perché non esca dal rettangolo del collo. */
const truncateToWidth = (text: string, maxWidthCm: number, fontSizeCm: number): string => {
  const maxChars = Math.max(1, Math.floor(maxWidthCm / (fontSizeCm * 0.58)));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
};

/**
 * Accorpa i colli in righe di riepilogo: stesso cliente, stesso formato e
 * stesso orientamento diventano un'unica riga con la quantità totale.
 * L'ordine di apparizione è quello di stiva (Cabina → Porte posteriori).
 */
const buildSummaryRows = (items: PlacedItem[]): PrintSummaryRow[] => {
  const rows = new Map<string, PrintSummaryRow>();

  for (const item of items) {
    const catalogName = PALLET_CATALOG.find((pallet) => pallet.code === item.code)?.name ?? item.code;
    const format = `${catalogName} · ${item.width}×${item.length} cm`;
    // Orientamento dedotto dalla geometria reale del collo sul pianale.
    const orientation = item.width >= item.length ? 'Piatto ↔' : 'Punta ↕';
    const key = `${item.name}|${format}|${orientation}`;

    const existing = rows.get(key);
    if (existing) existing.quantity += 1;
    else rows.set(key, { key, client: item.name, format, orientation, quantity: 1 });
  }

  return Array.from(rows.values());
};

interface PrintReportProps {
  vehicle: VehicleConfig;
  items: PlacedItem[];
}

/**
 * Scheda di carico ufficiale: intestazione, disegno vettoriale del camion
 * centrato sull'altezza utile A4 e tabella riepilogo in calce.
 */
export const PrintReport: React.FC<PrintReportProps> = ({ vehicle, items }) => {
  // Data/ora di generazione: aggiornata all'apertura della stampa del browser.
  const [generatedAt, setGeneratedAt] = useState<Date>(() => new Date());

  useEffect(() => {
    const refreshTimestamp = () => setGeneratedAt(new Date());
    window.addEventListener('beforeprint', refreshTimestamp);
    return () => window.removeEventListener('beforeprint', refreshTimestamp);
  }, []);

  const extent = getPianoExtent(vehicle, items);
  const rows = buildSummaryRows(items);

  // "Bilico frigo Fiori (2,50 × 13,28 m)" → "Bilico frigo Fiori"
  const vehicleName = vehicle.name.replace(/\s*\(.*\)\s*$/, '');
  const generatedLabel = generatedAt.toLocaleString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div id="print-report">
      {/* --- Intestazione scheda ------------------------------------------- */}
      <header className="flex items-end justify-between border-b-2 border-slate-800 pb-1.5">
        <div>
          <h1 className="text-[15pt] font-black tracking-tight text-slate-900">
            SCHEDA DI CARICO / PIANO DI STIVA
          </h1>
          <p className="text-[8pt] text-slate-500">
            Truck Planner 2D — documento generato il {generatedLabel}
          </p>
        </div>
        <div className="text-right text-[8pt] leading-tight text-slate-700">
          <div className="text-[10pt] font-bold text-slate-900">{vehicleName}</div>
          <div className="font-mono">
            Lunghezza utile: {vehicle.length} cm — Larghezza utile: {vehicle.width} cm
          </div>
          <div className="font-mono font-bold">{items.length} colli caricati</div>
        </div>
      </header>

      {/* --- Disegno vettoriale del camion --------------------------------- */}
      <div className="print-drawing">
        <svg
          viewBox={`${extent.minX} ${extent.minY} ${round(extent.width)} ${round(extent.height)}`}
          preserveAspectRatio="xMidYMid meet"
          className="h-full w-full"
        >
          {/* Piano di carico */}
          <rect x={0} y={0} width={vehicle.width} height={vehicle.length} rx={2} fill={COLORS.deck} />

          {/* Tacche metriche ogni metro */}
          {Array.from({ length: Math.max(0, Math.floor((vehicle.length - 1) / 100)) }, (_, i) => (i + 1) * 100).map(
            (y) => (
              <g key={y}>
                <line
                  x1={0}
                  y1={y}
                  x2={vehicle.width}
                  y2={y}
                  stroke={COLORS.grid}
                  strokeWidth={1}
                  strokeDasharray="4 4"
                />
                <text
                  x={-4}
                  y={y + PRINT_FONT.meter * 0.35}
                  textAnchor="end"
                  fontFamily={MONO_FONT_FAMILY}
                  fontSize={PRINT_FONT.meter}
                  fill={COLORS.gridText}
                >
                  {y / 100}m
                </text>
              </g>
            )
          )}

          {/* Colli stivati (nessun contorno di selezione in stampa) */}
          {items.map((item) => {
            const centerX = item.width / 2;
            const centerY = item.length / 2;
            const nameFont = Math.min(PRINT_FONT.name, item.width * 0.2, item.length * 0.28);
            const dimFont = Math.min(PRINT_FONT.dimensions, item.width * 0.16, item.length * 0.22);

            return (
              <g key={item.id} transform={`translate(${round(item.x)}, ${round(item.y)})`}>
                <rect
                  width={round(item.width)}
                  height={round(item.length)}
                  rx={2}
                  fill={item.color}
                  stroke={item.borderColor}
                  strokeWidth={1.5}
                />
                <text
                  x={round(centerX)}
                  y={round(centerY - dimFont * 0.6 + nameFont * 0.35)}
                  textAnchor="middle"
                  fontFamily={FONT_FAMILY}
                  fontSize={round(nameFont)}
                  fontWeight="bold"
                  fill={COLORS.name}
                >
                  {truncateToWidth(item.name, Math.max(4, item.width - 6), nameFont)}
                </text>
                <text
                  x={round(centerX)}
                  y={round(centerY + nameFont * 0.6 + dimFont * 0.35)}
                  textAnchor="middle"
                  fontFamily={MONO_FONT_FAMILY}
                  fontSize={round(dimFont)}
                  fill={COLORS.dimensions}
                >
                  {item.width}×{item.length}
                </text>
              </g>
            );
          })}

          {/* Sponde laterali, parete Cabina e linea tratteggiata delle porte */}
          <line x1={0} y1={0} x2={vehicle.width} y2={0} stroke={COLORS.wall} strokeWidth={4} />
          <line x1={0} y1={0} x2={0} y2={vehicle.length} stroke={COLORS.wall} strokeWidth={3} />
          <line
            x1={vehicle.width}
            y1={0}
            x2={vehicle.width}
            y2={vehicle.length}
            stroke={COLORS.wall}
            strokeWidth={3}
          />
          <line
            x1={0}
            y1={vehicle.length}
            x2={vehicle.width}
            y2={vehicle.length}
            stroke={COLORS.wall}
            strokeWidth={3}
            strokeDasharray="16 8"
          />

          {/* Intestazioni */}
          <text
            x={vehicle.width / 2}
            y={round(extent.minY + PRINT_FONT.caption * 1.05)}
            textAnchor="middle"
            fontFamily={FONT_FAMILY}
            fontSize={PRINT_FONT.caption}
            fontWeight="bold"
            fill={COLORS.caption}
          >
            ▲ [ CABINA ] ▲
          </text>
          <text
            x={vehicle.width / 2}
            y={round(-PRINT_FONT.quota * 0.4)}
            textAnchor="middle"
            fontFamily={MONO_FONT_FAMILY}
            fontSize={PRINT_FONT.quota}
            fill={COLORS.gridText}
          >
            {vehicle.width} cm
          </text>
          <text
            x={vehicle.width / 2}
            y={round(extent.doorLabelY)}
            textAnchor="middle"
            fontFamily={FONT_FAMILY}
            fontSize={PRINT_FONT.caption * 0.93}
            fontWeight="bold"
            fill={COLORS.caption}
          >
            ▼ [ PORTE POSTERIORI ] ▼
          </text>
        </svg>
      </div>

      {/* --- Tabella riepilogo in calce ------------------------------------ */}
      <section className="print-table">
        <table className="w-full border-collapse text-[8pt]">
          <thead>
            <tr className="bg-slate-100 text-left text-[7.5pt] uppercase tracking-wider text-slate-600">
              <th className="border border-slate-300 px-1.5 py-1">Cliente / Tappa</th>
              <th className="border border-slate-300 px-1.5 py-1">Formato</th>
              <th className="border border-slate-300 px-1.5 py-1">Orientamento</th>
              <th className="border border-slate-300 px-1.5 py-1 text-right">Q.tà</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="border border-slate-300 px-1.5 py-1 italic text-slate-400"
                >
                  Nessun collo caricato sul pianale.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.key}>
                  <td className="border border-slate-300 px-1.5 py-1 font-semibold text-slate-800">
                    {row.client}
                  </td>
                  <td className="border border-slate-300 px-1.5 py-1 font-mono text-slate-700">
                    {row.format}
                  </td>
                  <td className="border border-slate-300 px-1.5 py-1 text-slate-700">
                    {row.orientation}
                  </td>
                  <td className="border border-slate-300 px-1.5 py-1 text-right font-mono font-bold text-slate-900">
                    {row.quantity}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 font-bold text-slate-900">
              <td colSpan={3} className="border border-slate-300 px-1.5 py-1 text-right uppercase">
                Totale colli
              </td>
              <td className="border border-slate-300 px-1.5 py-1 text-right font-mono">
                {items.length}
              </td>
            </tr>
          </tfoot>
        </table>
      </section>
    </div>
  );
};
