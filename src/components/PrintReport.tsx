import { useEffect, useState } from 'react';
import type { LabelDensity, PlacedItem, SideNote, VehicleConfig } from '../types';
import { PALLET_CATALOG, NOMINAL_QUOTA_CM, NOMINAL_QUOTA_COLOR } from '../constants';
import { LDM_BADGE, LDM_BADGE_CENTER_X, LDM_BADGE_COLOR, LDM_BADGE_LEFT_X, LDM_BADGE_MUTED_COLOR, LDM_GUIDE_CLOSING_LENGTH, LDM_GUIDE_COLOR, LDM_GUIDE_DASH, ldmBadgeRightCenterX, ldmBadgeRightLeftX } from '../constants';
import { calculateLdmMetrics } from '../utils/snapping';
import { getPianoExtent, noteClipId } from '../utils/export';
import { resolveNoteLayouts, NOTE_PADDING_CM } from '../utils/sideNotes';
import {
  CABINA_CAPTION_BASELINE_CM,
  PLATE_BADGE_FONT_FAMILY,
  PLATE_BADGE_LETTER_SPACING_EM,
  PLATE_BADGE_TEXT_COLOR,
  WIDTH_QUOTA_BASELINE_CM,
  plateBadgeLayout,
} from '../utils/plateBadge';

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
  /** Quota nominale 13,20 m, come sul canvas a schermo. */
  nominalQuota: NOMINAL_QUOTA_COLOR,
  /** Linea guida del contatore LDM (blu CAD). */
  ldmGuide: LDM_GUIDE_COLOR,
  /** Badge del lato più carico (scuro primario). */
  ldmBadge: LDM_BADGE_COLOR,
  /** Badge del lato meno carico (slate intermedio). */
  ldmBadgeMuted: LDM_BADGE_MUTED_COLOR,
  ldmBadgeText: '#FFFFFF',
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
  /** Le note laterali non hanno formato/orientamento: la riga li lascia vuoti. */
  isNote?: boolean;
  /** Testo della nota, mostrato in sostituzione di formato e orientamento. */
  noteText?: string;
}

/** Arrotonda a due decimali: attributi SVG compatti. */
const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * ID del `clipPath` di una nota nella scheda stampata: la scheda vive nello
 * stesso documento del canvas, quindi il prefisso evita di collidere con il
 * `clipPath` omonimo disegnato dal canvas a schermo.
 */
const printNoteClipId = (noteId: string): string => `print-${noteClipId(noteId)}`;

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

/**
 * Righe di riepilogo delle note laterali di carico: una per nota, così le
 * istruzioni operative restano nel documento anche quando il disegno è molto
 * scalato (o con densità etichette `minimal`). La posizione riportata è quella
 * **2D** scelta dall'operatore (`X` e `Y` in metri, con X negativa quando la
 * nota vive a sinistra del semirimorchio).
 */
const buildNoteRows = (notes: SideNote[]): PrintSummaryRow[] =>
  notes.map((note) => ({
    key: `note|${note.id}`,
    client: 'Nota laterale',
    format: `X ${(note.x / 100).toFixed(2)} m · Y ${(note.y / 100).toFixed(2)} m`,
    orientation: '',
    quantity: 1,
    isNote: true,
    noteText: note.content.replace(/\s+/g, ' ').trim(),
  }));

interface PrintReportProps {
  vehicle: VehicleConfig;
  items: PlacedItem[];
  /** Note laterali di carico: incluse nel disegno vettoriale della scheda. */
  notes: SideNote[];
  /**
   * Targa / identificativo del mezzo: disegnato nel badge sopra la Cabina e
   * riportato come voce formale `Targa: …` nell'intestazione della scheda.
   */
  plate: string;
  /** Densità etichette dell'app: con `minimal` il disegno resta pulito. */
  labelDensity: LabelDensity;
}

/**
 * Scheda di carico ufficiale: intestazione, disegno vettoriale del camion
 * centrato sull'altezza utile A4 e tabella riepilogo in calce.
 *
 * Il disegno riporta gli stessi riferimenti metrici del canvas a schermo:
 * quota nominale 13,20 m (sui mezzi che la raggiungono), indicatori LDM
 * calcolati dalla funzione condivisa `calculateLdmMetrics` (Regola della Corsia
 * di Parete) e le note laterali di carico nella loro corsia a destra della
 * parete. Il dato ufficiale dei metri lineari è inoltre esposto come riga
 * dedicata nella tabella riassuntiva.
 */
export const PrintReport: React.FC<PrintReportProps> = ({
  vehicle,
  items,
  notes,
  plate,
  labelDensity,
}) => {
  // Data/ora di generazione: aggiornata all'apertura della stampa del browser.
  const [generatedAt, setGeneratedAt] = useState<Date>(() => new Date());

  useEffect(() => {
    const refreshTimestamp = () => setGeneratedAt(new Date());
    window.addEventListener('beforeprint', refreshTimestamp);
    return () => window.removeEventListener('beforeprint', refreshTimestamp);
  }, []);

  /**
   * Inquadratura della scheda: `getPianoExtent` riceve anche la **targa**, perché
   * il testo può sforare di 50 cm per lato oltre le sponde (`vehicle.width + 100`
   * cm). Il `viewBox` include l'ingombro reale della scritta
   * (`plateLeftX = vehicle.width / 2 − textWidthCm / 2 − 15` e
   * `plateRightX = vehicle.width / 2 + textWidthCm / 2 + 15`, con
   * `textWidthCm = caratteri × fontSize × 0.65`): nemmeno in stampa PDF la targa
   * estesa può essere tagliata ai bordi.
   */
  const extent = getPianoExtent(vehicle, items, labelDensity, notes, plate);
  /**
   * Badge targa / identificativo mezzo (**solo testo**): geometria dal modulo
   * condiviso `utils/plateBadge.ts`, identica al canvas a schermo e allo snapshot
   * PNG. Con targa vuota la funzione restituisce `null` e sulla scheda non viene
   * disegnato alcunché sopra la Cabina.
   */
  const plateBadge = plateBadgeLayout(vehicle.width, plate);
  const rows = buildSummaryRows(items);
  /** Righe di riepilogo delle note laterali (titolo, quota e testo). */
  const noteRows = buildNoteRows(notes);
  /** Card delle note laterali, con la stessa geometria del canvas a schermo. */
  const noteLayouts = resolveNoteLayouts(notes);

  /**
   * Ingombro LDM dei due lati (Regola della Corsia di Parete), dalla stessa
   * funzione pura che alimenta canvas a schermo ed export PNG: la scheda
   * stampata non può divergere da ciò che l'operatore vede sul pianale.
   */
  const ldm = calculateLdmMetrics(vehicle, items);
  /** Asse di mezzeria: separa i due indicatori nel caso asimmetrico. */
  const ldmMidX = vehicle.width / 2;
  /** Con densità `minimal` linee e badge LDM non vengono disegnati. */
  const showsLdmIndicator = labelDensity !== 'minimal' && ldm.maxOccupiedY > 0;
  /**
   * Riga LDM della tabella: il dato ufficiale dei metri lineari resta nel
   * documento anche con densità `minimal` (che pulisce solo il disegno).
   */
  const showsLdmRow = ldm.maxOccupiedY > 0;
  /** Lato più carico → badge scuro primario; l'altro → slate intermedio. */
  const leftLdmBadgeColor =
    ldm.leftY >= ldm.rightY ? COLORS.ldmBadge : COLORS.ldmBadgeMuted;
  const rightLdmBadgeColor =
    ldm.leftY >= ldm.rightY ? COLORS.ldmBadgeMuted : COLORS.ldmBadge;
  /** Riferimento della quota nominale 13,20 m (solo sui mezzi che la raggiungono). */
  const showsNominalQuota = vehicle.length >= NOMINAL_QUOTA_CM;

  /** Badge LDM: rettangolo ad alto contrasto + dicitura bianca centrata (cm reali). */
  const renderLdmBadge = (
    leftX: number,
    centerX: number,
    y: number,
    label: string,
    fill: string
  ) => (
    <g>
      <rect
        x={round(leftX)}
        y={round(y - LDM_BADGE.height / 2)}
        width={LDM_BADGE.width}
        height={LDM_BADGE.height}
        rx={3}
        fill={fill}
      />
      <text
        x={round(centerX)}
        y={round(y + PRINT_FONT.meter * 0.35)}
        textAnchor="middle"
        fontFamily={FONT_FAMILY}
        fontSize={PRINT_FONT.meter}
        fontWeight="bold"
        fill={COLORS.ldmBadgeText}
      >
        {label}
      </text>
    </g>
  );

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
          {/* Voce formale della targa: resta nel documento anche se il disegno
              è molto scalato, e vale `N.D.` quando nessuna targa è stata
              digitata in sidebar. */}
          <div id="print-plate-row" className="font-mono font-bold text-slate-900">
            Targa: {plate || 'N.D.'}
          </div>
          <div className="font-mono font-bold">{items.length} colli caricati</div>
          {notes.length > 0 && (
            <div className="font-mono font-bold">{notes.length} note laterali</div>
          )}
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

          {/* Quota nominale 13,20 m: identica al canvas a schermo
              (`stroke #94A3B8`, tratteggio 6 3, dicitura nel righello sinistro).
              Presente solo sui mezzi che raggiungono i 1320 cm. */}
          {showsNominalQuota && (
            <g>
              <line
                x1={0}
                y1={NOMINAL_QUOTA_CM}
                x2={vehicle.width}
                y2={NOMINAL_QUOTA_CM}
                stroke={COLORS.nominalQuota}
                strokeWidth={1.5}
                strokeDasharray="6 3"
              />
              <text
                x={-4}
                y={round(NOMINAL_QUOTA_CM + PRINT_FONT.meter * 0.4)}
                textAnchor="end"
                fontFamily={MONO_FONT_FAMILY}
                fontSize={PRINT_FONT.meter}
                fontWeight="bold"
                fill={COLORS.caption}
              >
                13.20m
              </text>
            </g>
          )}

          {/* Indicatori LDM dal calcolo condiviso `calculateLdmMetrics`:
              simmetrico → linea guida continua + badge scuro a sinistra;
              asimmetrico → due linee tratteggiate (metà SX e metà DX) con badge
              nel righello sinistro ed esterno alla parete destra. */}
          {showsLdmIndicator && !ldm.isAsymmetric && (
            <g>
              <line
                x1={0}
                y1={round(ldm.maxOccupiedY)}
                x2={vehicle.width}
                y2={round(ldm.maxOccupiedY)}
                stroke={COLORS.ldmGuide}
                strokeWidth={1}
              />
              {renderLdmBadge(
                LDM_BADGE_LEFT_X,
                LDM_BADGE_CENTER_X,
                ldm.maxOccupiedY,
                `▶ ${(ldm.maxOccupiedY / 100).toFixed(2)} m`,
                COLORS.ldmBadge
              )}
            </g>
          )}

          {showsLdmIndicator && ldm.isAsymmetric && (
            <g>
              {/* Lato sinistro: linea tratteggiata 0 → mezzeria, chiusa a filo
                  da un segmento pieno (il tratteggio non deve restare sospeso). */}
              <line
                x1={0}
                y1={round(ldm.leftY)}
                x2={round(ldmMidX)}
                y2={round(ldm.leftY)}
                stroke={COLORS.ldmGuide}
                strokeWidth={1}
                strokeDasharray={LDM_GUIDE_DASH}
              />
              <line
                x1={round(Math.max(0, ldmMidX - LDM_GUIDE_CLOSING_LENGTH))}
                y1={round(ldm.leftY)}
                x2={round(ldmMidX)}
                y2={round(ldm.leftY)}
                stroke={COLORS.ldmGuide}
                strokeWidth={1}
              />
              {renderLdmBadge(
                LDM_BADGE_LEFT_X,
                LDM_BADGE_CENTER_X,
                ldm.leftY,
                `▶ ${(ldm.leftY / 100).toFixed(2)} m`,
                leftLdmBadgeColor
              )}

              {/* Lato destro: linea tratteggiata mezzeria → parete, badge esterno. */}
              <line
                x1={round(ldmMidX)}
                y1={round(ldm.rightY)}
                x2={vehicle.width}
                y2={round(ldm.rightY)}
                stroke={COLORS.ldmGuide}
                strokeWidth={1}
                strokeDasharray={LDM_GUIDE_DASH}
              />
              <line
                x1={round(Math.max(ldmMidX, vehicle.width - LDM_GUIDE_CLOSING_LENGTH))}
                y1={round(ldm.rightY)}
                x2={vehicle.width}
                y2={round(ldm.rightY)}
                stroke={COLORS.ldmGuide}
                strokeWidth={1}
              />
              {renderLdmBadge(
                ldmBadgeRightLeftX(vehicle.width),
                ldmBadgeRightCenterX(vehicle.width),
                ldm.rightY,
                `◀ ${(ldm.rightY / 100).toFixed(2)} m`,
                rightLdmBadgeColor
              )}
            </g>
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

          {/* Note laterali di carico: alle loro coordinate 2D (a destra del
              camion, a sinistra, lungo il pianale o in coda), con la stessa
              geometria del canvas a schermo e dello snapshot PNG. Ogni card
              contiene l'unico testo della nota, a coordinate relative al proprio
              box (`x = 10` cm), con la larghezza, l'altezza e il corpo scelti
              dall'operatore. **Nessun bordo**: in scheda la nota è puro testo
              fluttuante. */}
          {noteLayouts.map(
            ({ note, height, lines, fontSize, firstBaselineCm, lineHeightCm, textHeight }) => {
              const text = (
                <text
                  x={NOTE_PADDING_CM}
                  fontFamily={FONT_FAMILY}
                  fontSize={round(fontSize)}
                  fill={COLORS.dimensions}
                >
                  {lines.map((line, index) => (
                    <tspan
                      key={index}
                      x={NOTE_PADDING_CM}
                      y={round(firstBaselineCm + index * lineHeightCm)}
                    >
                      {line}
                    </tspan>
                  ))}
                </text>
              );

              return (
                <g key={note.id}>
                  {/* Il clipPath deve esistere nel DOM della scheda, altrimenti
                      un box più basso del testo non verrebbe ritagliato. */}
                  {textHeight > height && (
                    <defs>
                      <clipPath id={printNoteClipId(note.id)}>
                        <rect width={round(note.width)} height={round(height)} />
                      </clipPath>
                    </defs>
                  )}
                  <g transform={`translate(${round(note.x)}, ${round(note.y)})`}>
                    <rect
                      width={round(note.width)}
                      height={round(height)}
                      rx={4}
                      fill={note.color}
                    />
                    {textHeight > height ? (
                      <g clipPath={`url(#${printNoteClipId(note.id)})`}>{text}</g>
                    ) : (
                      text
                    )}
                  </g>
                </g>
              );
            }
          )}

          {/* Badge targa / identificativo mezzo: **solo testo** sopra la Cabina,
              con la stessa geometria e lo stesso corpo del canvas a schermo
              (corpo base 30 px, fascia di intestazione sopra `▲ CABINA ▲`).
              Zero bordo e zero tratteggio: con targa vuota il blocco non esiste
              e la fascia resta pulita. La scritta può sforare di 50 cm per lato
              oltre le sponde: è il `viewBox` qui sopra a contenerla. */}
          {plateBadge && (
            <g id="print-plate-badge">
              <text
                x={round(plateBadge.centerX)}
                y={round(plateBadge.centerY)}
                textAnchor="middle"
                dominantBaseline="middle"
                fontFamily={PLATE_BADGE_FONT_FAMILY}
                fontSize={round(plateBadge.fontSize)}
                fontWeight="900"
                letterSpacing={`${PLATE_BADGE_LETTER_SPACING_EM}em`}
                stroke="none"
                strokeWidth={0}
                fill={PLATE_BADGE_TEXT_COLOR}
              >
                {plateBadge.label}
              </text>
            </g>
          )}

          {/* Intestazioni (la didascalia CABINA vive SOTTO la fascia targa) */}
          <text
            x={vehicle.width / 2}
            y={CABINA_CAPTION_BASELINE_CM}
            textAnchor="middle"
            fontFamily={FONT_FAMILY}
            fontSize={PRINT_FONT.caption}
            fontWeight="bold"
            fill={COLORS.caption}
          >
            ▲ CABINA ▲
          </text>
          <text
            x={vehicle.width / 2}
            y={WIDTH_QUOTA_BASELINE_CM}
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
            PORTE POSTERIORI
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
            {/* Note laterali di carico: istruzioni operative ufficiali del
                documento, con titolo, quota e testo integrale. */}
            {noteRows.length > 0 && (
              <tr id="print-notes-header" className="bg-slate-100 text-[7.5pt] uppercase tracking-wider text-slate-600">
                <td colSpan={4} className="border border-slate-300 px-1.5 py-1 font-bold">
                  Note laterali di carico
                </td>
              </tr>
            )}
            {noteRows.map((row) => (
              <tr key={row.key} id="print-note-row">
                <td className="border border-slate-300 px-1.5 py-1 font-semibold text-slate-800">
                  {row.client}
                </td>
                <td className="border border-slate-300 px-1.5 py-1 font-mono text-slate-700">
                  {row.format}
                </td>
                <td
                  colSpan={2}
                  className="border border-slate-300 px-1.5 py-1 italic text-slate-700"
                >
                  {row.noteText || '—'}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {/* Dato ufficiale LDM: riga dedicata ed evidenziata, calcolata dalla
                funzione condivisa `calculateLdmMetrics` (Regola della Corsia di
                Parete). */}
            {showsLdmRow && (
              <tr
                id="print-ldm-row"
                className="bg-blue-50 font-bold text-slate-900"
              >
                <td colSpan={3} className="border border-slate-300 px-1.5 py-1 uppercase">
                  Ingombro Lineare (LDM)
                </td>
                <td className="border border-slate-300 px-1.5 py-1 text-right font-mono">
                  {ldm.isAsymmetric
                    ? `Lato SX ${(ldm.leftY / 100).toFixed(2)} m | Lato DX ${(ldm.rightY / 100).toFixed(2)} m`
                    : `${(ldm.maxOccupiedY / 100).toFixed(2)} m`}
                </td>
              </tr>
            )}
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
