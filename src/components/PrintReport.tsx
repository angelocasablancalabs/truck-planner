import { useEffect, useState } from 'react';
import type { DeckBay, LabelDensity, PlacedItem, SideNote, VehicleConfig } from '../types';
import { PALLET_CATALOG, NOMINAL_QUOTA_CM, NOMINAL_QUOTA_COLOR } from '../constants';
import { LDM_BADGE, LDM_BADGE_CENTER_X, LDM_BADGE_COLOR, LDM_BADGE_LEFT_X, LDM_BADGE_MUTED_COLOR, LDM_GUIDE_CLOSING_LENGTH, LDM_GUIDE_COLOR, LDM_GUIDE_DASH, ldmBadgeRightCenterX, ldmBadgeRightLeftX } from '../constants';
import { calculateLdmMetrics, formatLdmMeters } from '../utils/snapping';
import type { LdmMetrics } from '../utils/snapping';
import { getFleetExtent, getPianoExtent, noteClipId } from '../utils/export';
import { bayOffsets } from '../utils/bays';
import { resolveNoteLayouts, NOTE_PADDING_CM } from '../utils/sideNotes';
import {
  AVERAGE_CHAR_WIDTH_RATIO,
  clipIdForItem,
  LABEL_FONT_SIZE,
  LABEL_WRAP_FONT_SIZE,
  NARROW_ITEM_WIDTH_CM,
  shouldWrapLabel,
  splitLabelIntoTwoLines,
} from '../utils/labels';
import {
  CABINA_CAPTION_BASELINE_CM,
  PLATE_BADGE_FONT_FAMILY,
  PLATE_BADGE_LETTER_SPACING_EM,
  PLATE_BADGE_TEXT_COLOR,
  WIDTH_QUOTA_BASELINE_CM,
  plateBadgeLayout,
} from '../utils/plateBadge';

/* -------------------------------------------------------------------------- *
 *  SCHEDA DI CARICO A4 / PDF — "PIANO DI CARICO"  (sezione AF)
 *
 *  Il componente vive sempre nel DOM ma è invisibile a schermo: le regole
 *  `@media print` di `src/index.css` nascondono l'interfaccia interattiva
 *  (#screen-app) e mostrano solo `#print-report`, impaginato in una o due
 *  pagine A4 portrait a seconda del numero di righe univoche di carico.
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

/**
 * Tronca il testo perché non esca dal rettangolo del collo.
 *
 * È solo l'ultima rete di sicurezza: i nomi composti vengono prima mandati a
 * capo su due righe da `shouldWrapLabel` / `splitLabelIntoTwoLines`, esattamente
 * come sul canvas a schermo e nello snapshot PNG (modulo `utils/labels.ts`).
 */
const truncateToWidth = (text: string, maxWidthCm: number, fontSizeCm: number): string => {
  const maxChars = Math.max(1, Math.floor(maxWidthCm / (fontSizeCm * AVERAGE_CHAR_WIDTH_RATIO)));
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

/**
 * Numero massimo di righe univoche di carico che restano in **Pagina 1**
 * (carico compatto: header, disegno e tabella sullo stesso foglio).
 * Da `4` righe in su il carico è considerato multi-tappa articolato e la
 * tabella viene impaginata in **Pagina 2** (paginazione dinamica A4).
 */
const PRINT_INLINE_TABLE_MAX_ROWS = 3;

/** Testo della nota di rinvio mostrata in calce alla Pagina 1 (carico articolato). */
const PRINT_PAGE_TWO_HINT = 'Tabella riepilogativa colli consultabile a Pagina 2 ➔';

interface PrintSummaryTableProps {
  /** Righe di carico accorpate (una per riferimento / formato / orientamento). */
  rows: PrintSummaryRow[];
  /** Righe delle note laterali di carico: istruzioni operative del documento. */
  noteRows: PrintSummaryRow[];
  /** Totale dei colli caricati: valore della riga `TOTALE COLLI`. */
  totalItems: number;
  /** Ingombro in metri lineari dalla funzione condivisa `calculateLdmMetrics`. */
  ldm: LdmMetrics;
}

/**
 * Tabella riepilogativa ufficiale della scheda di carico.
 *
 * Vive in Pagina 1 quando il carico è compatto (`rowCount <= 3`) e in Pagina 2
 * quando il carico è articolato (`rowCount >= 4`), con la stessa struttura in
 * entrambi i casi:
 *   - colonne `RIFERIMENTO | Q.TÀ | FORMATO | ORIENTAMENTO` (la quantità è la
 *     seconda colonna, centrata e in grassetto, allineata verticalmente tra
 *     intestazione, righe di lotto e totale);
 *   - penultima riga `TOTALE COLLI` (colonne 3 e 4 unite e vuote);
 *   - ultima riga a **tutta larghezza** (`colSpan 4`) con il dato ufficiale
 *     dell'ingombro lineare effettivo (LDM), simmetrico o asimmetrico.
 */
const PrintSummaryTable: React.FC<PrintSummaryTableProps> = ({
  rows,
  noteRows,
  totalItems,
  ldm,
}) => (
  <section className="print-table">
    <table className="w-full border-collapse text-[8pt]">
      <thead>
        <tr className="bg-slate-100 text-left text-[7.5pt] uppercase tracking-wider text-slate-600">
          <th className="border border-slate-300 px-1.5 py-1">Riferimento</th>
          <th className="border border-slate-300 px-1.5 py-1 text-center">Q.tà</th>
          <th className="border border-slate-300 px-1.5 py-1">Formato</th>
          <th className="border border-slate-300 px-1.5 py-1">Orientamento</th>
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
              <td className="border border-slate-300 px-1.5 py-1 text-center font-mono font-bold text-slate-900">
                {row.quantity}
              </td>
              <td className="border border-slate-300 px-1.5 py-1 font-mono text-slate-700">
                {row.format}
              </td>
              <td className="border border-slate-300 px-1.5 py-1 text-slate-700">
                {row.orientation}
              </td>
            </tr>
          ))
        )}
        {/* Note laterali di carico: istruzioni operative ufficiali del documento,
            con posizione 2D e testo integrale. */}
        {noteRows.length > 0 && (
          <tr
            id="print-notes-header"
            className="bg-slate-100 text-[7.5pt] uppercase tracking-wider text-slate-600"
          >
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
            <td className="border border-slate-300 px-1.5 py-1 text-center font-mono text-slate-400">
              —
            </td>
            <td className="border border-slate-300 px-1.5 py-1 font-mono text-slate-700">
              {row.format}
            </td>
            <td className="border border-slate-300 px-1.5 py-1 italic text-slate-700">
              {row.noteText || '—'}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        {/* Penultima riga: totale dei colli, incolonnato sotto le quantità. */}
        <tr id="print-total-row" className="bg-slate-50 font-bold text-slate-900">
          <td className="border border-slate-300 px-1.5 py-1">TOTALE COLLI</td>
          <td className="border border-slate-300 px-1.5 py-1 text-center font-mono">
            {totalItems}
          </td>
          <td colSpan={2} className="border border-slate-300 px-1.5 py-1"></td>
        </tr>
        {/* Ultima riga a tutta larghezza: dato ufficiale dell'ingombro lineare. */}
        <tr id="print-ldm-row" className="bg-blue-50 font-bold text-slate-900">
          <td colSpan={4} className="border border-slate-300 px-1.5 py-1">
            Ingombro Lineare Effettivo (LDM):{' '}
            {ldm.isAsymmetric
              ? `Lato SX ${formatLdmMeters(ldm.leftY)} m | Lato DX ${formatLdmMeters(ldm.rightY)} m`
              : `${formatLdmMeters(ldm.maxOccupiedY)} m`}
          </td>
        </tr>
      </tfoot>
    </table>
  </section>
);

interface PrintReportProps {
  /**
   * **Flotta** della centrale multi-pianale: la scheda completa genera **una
   * pagina A4 per ciascun mezzo**, mentre la stampa della sola grafica affianca
   * tutti i pianali su un unico foglio A4 panoramico.
   */
  bays: DeckBay[];
  /** Densità etichette dell'app: con `minimal` il disegno resta pulito. */
  labelDensity: LabelDensity;
}

/**
 * Parametri del **disegno vettoriale di un singolo stallo**: sono gli stessi
 * della scheda storica a pianale singolo, più la traslazione di mondo che
 * affianca i mezzi nello stesso `viewBox`.
 */
interface PrintBayDrawingProps {
  vehicle: VehicleConfig;
  items: PlacedItem[];
  /** Note laterali di carico: incluse nel disegno vettoriale della scheda. */
  notes: SideNote[];
  /**
   * Targa / identificativo del mezzo: disegnata a caratteri cubitali (30 px)
   * sopra la Cabina nel vettoriale della scheda e usata per l'inquadratura.
   */
  plate: string;
  /** Densità etichette dell'app: con `minimal` il disegno resta pulito. */
  labelDensity: LabelDensity;
  /**
   * Traslazione orizzontale (cm) dello stallo nel `viewBox`: `0` per la scheda
   * a un mezzo per pagina, l'offset di flotta per la stampa panoramica.
   */
  xOffset: number;
  /** Quota (cm) della didascalia `PORTE POSTERIORI` su questo stallo. */
  doorLabelY: number;
}

/**
 * **Disegno vettoriale di un singolo stallo** (pianale, targhe, quote, colli e
 * note).
 *
 * Contenuto identico a schermo, allo snapshot PNG e alla scheda stampata:
 * - piano di carico con tacche metriche ogni metro e quota nominale 13,20 m sui
 *   mezzi che la raggiungono;
 * - contatore LDM dal calcolo condiviso `calculateLdmMetrics` (Regola della
 *   Corsia di Parete), simmetrico o asimmetrico;
 * - tutti i colli con colore, bordo e testo ritagliato dal proprio `clipPath`;
 * - note laterali di carico alle loro coordinate 2D;
 * - badge targa esteso fuori sponda e didascalie `▲ CABINA ▲` / `PORTE POSTERIORI`.
 *
 * `xOffset` trasla l'intero blocco nella scena: è ciò che permette di affiancare
 * più mezzi nello stesso `viewBox` (stampa panoramica).
 */
const PrintBayDrawing: React.FC<PrintBayDrawingProps> = ({
  vehicle,
  items,
  notes,
  plate,
  labelDensity,
  xOffset,
  doorLabelY,
}) => {
  const plateBadge = plateBadgeLayout(vehicle.width, plate);
  const noteLayouts = resolveNoteLayouts(notes);
  const ldm = calculateLdmMetrics(vehicle, items);
  const ldmMidX = vehicle.width / 2;
  const showsLdmIndicator = labelDensity !== 'minimal' && ldm.maxOccupiedY > 0;
  const leftLdmBadgeColor = ldm.leftY >= ldm.rightY ? COLORS.ldmBadge : COLORS.ldmBadgeMuted;
  const rightLdmBadgeColor = ldm.leftY >= ldm.rightY ? COLORS.ldmBadgeMuted : COLORS.ldmBadge;
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

  return (
    <g transform={`translate(${round(xOffset)}, 0)`}>
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
            `${formatLdmMeters(ldm.maxOccupiedY)} m ▶`,
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
            `${formatLdmMeters(ldm.leftY)} m ▶`,
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
            `◀ ${formatLdmMeters(ldm.rightY)} m`,
            rightLdmBadgeColor
          )}
        </g>
      )}

      {/* Colli stivati (nessun contorno di selezione in stampa).
          Le etichette adottano la STESSA logica multi-riga del canvas a
          schermo (`TruckCanvas.tsx`) e dello snapshot PNG (`export.ts`),
          dagli helper condivisi di `utils/labels.ts`: i nomi composti
          ("MIGHIRIAN c/o RAOUL") vanno a capo su due `<tspan>` centrate
          invece di essere troncati con i puntini. Il testo resta comunque
          ritagliato dal `clipPath` del proprio collo, quindi non può
          sbordare sui colli adiacenti. */}
      {items.map((item) => {
        const centerX = item.width / 2;
        const centerY = item.length / 2;
        const isNarrow = item.width <= NARROW_ITEM_WIDTH_CM;
        const baseNameFont = Math.min(PRINT_FONT.name, item.width * 0.2, item.length * 0.28);
        const dimFont = Math.min(PRINT_FONT.dimensions, item.width * 0.16, item.length * 0.22);
        /**
         * Due righe bilanciate dal modulo condiviso: `null` quando il nome
         * sta comodamente su una riga sola.
         */
        const lines = shouldWrapLabel(item.name, item.width)
          ? splitLabelIntoTwoLines(item.name)
          : null;
        /** A capo = corpo ridotto, come `text-[10px]` vs `text-[11px]` a schermo. */
        const nameFont = lines
          ? baseNameFont * (LABEL_WRAP_FONT_SIZE / LABEL_FONT_SIZE)
          : baseNameFont;
        const dimensions = `${item.width}×${item.length}`;
        const textMaxWidth = Math.max(4, item.width - 6);
        /**
         * Clip del collo nella scheda: il prefisso `print-` evita di
         * collidere con il `clipPath` omonimo del canvas a schermo, che vive
         * nello stesso documento (stesso accorgimento di `printNoteClipId`).
         */
        const clipId = `print-${clipIdForItem(item.id)}`;

        /** Etichette interne secondo la densità scelta dall'operatore. */
        const labels = (() => {
          if (labelDensity === 'minimal') return null;

          // Nome su due righe centrate: gli stessi `dy` del canvas e del PNG.
          const wrappedName = lines && (
            <text
              x={round(centerX)}
              y={round(centerY)}
              textAnchor="middle"
              fontFamily={FONT_FAMILY}
              fontSize={round(nameFont)}
              fontWeight="bold"
              fill={COLORS.name}
            >
              <tspan x={round(centerX)} dy={-6}>
                {lines[0]}
              </tspan>
              <tspan x={round(centerX)} dy={13}>
                {lines[1]}
              </tspan>
            </text>
          );

          if (labelDensity === 'client') {
            // Solo nome: su due righe se il nome è composto, altrimenti troncato.
            return (
              wrappedName || (
                <text
                  x={round(centerX)}
                  y={round(centerY + nameFont * 0.35)}
                  textAnchor="middle"
                  fontFamily={FONT_FAMILY}
                  fontSize={round(nameFont)}
                  fontWeight="bold"
                  fill={COLORS.name}
                >
                  {truncateToWidth(item.name, textMaxWidth, nameFont)}
                </text>
              )
            );
          }

          if (labelDensity === 'dimensions') {
            // Solo quota dimensionale, centrata nel collo.
            return (
              <text
                x={round(centerX)}
                y={round(centerY + nameFont * 0.35)}
                textAnchor="middle"
                fontFamily={MONO_FONT_FAMILY}
                fontSize={round(isNarrow ? nameFont * 0.9 : nameFont)}
                fontWeight="bold"
                fill={COLORS.dimensions}
              >
                {dimensions}
              </text>
            );
          }

          // Densità `all`: nome (su una o due righe) e quota subito sotto.
          if (lines) {
            return (
              <text
                x={round(centerX)}
                y={round(centerY)}
                textAnchor="middle"
                fontFamily={FONT_FAMILY}
                fontSize={round(nameFont)}
                fontWeight="bold"
                fill={COLORS.name}
              >
                <tspan x={round(centerX)} dy={-6}>
                  {lines[0]}
                </tspan>
                <tspan x={round(centerX)} dy={13}>
                  {lines[1]}
                </tspan>
                <tspan
                  x={round(centerX)}
                  dy={12}
                  fontFamily={MONO_FONT_FAMILY}
                  fontSize={round(dimFont)}
                  fontWeight="normal"
                  fill={COLORS.dimensions}
                >
                  {dimensions}
                </tspan>
              </text>
            );
          }

          return (
            <>
              <text
                x={round(centerX)}
                y={round(centerY - dimFont * 0.6 + nameFont * 0.35)}
                textAnchor="middle"
                fontFamily={FONT_FAMILY}
                fontSize={round(nameFont)}
                fontWeight="bold"
                fill={COLORS.name}
              >
                {truncateToWidth(item.name, textMaxWidth, nameFont)}
              </text>
              <text
                x={round(centerX)}
                y={round(centerY + nameFont * 0.6 + dimFont * 0.35)}
                textAnchor="middle"
                fontFamily={MONO_FONT_FAMILY}
                fontSize={round(dimFont)}
                fill={COLORS.dimensions}
              >
                {dimensions}
              </text>
            </>
          );
        })();

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
            <defs>
              <clipPath id={clipId}>
                <rect width={round(item.width)} height={round(item.length)} />
              </clipPath>
            </defs>
            <g clipPath={`url(#${clipId})`}>{labels}</g>
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
                <rect width={round(note.width)} height={round(height)} rx={4} fill={note.color} />
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
          oltre le sponde: è il `viewBox` a contenerla. */}
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
        y={round(doorLabelY)}
        textAnchor="middle"
        fontFamily={FONT_FAMILY}
        fontSize={PRINT_FONT.caption * 0.93}
        fontWeight="bold"
        fill={COLORS.caption}
      >
        PORTE POSTERIORI
      </text>
    </g>
  );
};

/**
 * Scheda di carico ufficiale — **PIANO DI CARICO** della centrale multi-pianale.
 *
 * Genera **una pagina A4 per ciascun mezzo** della flotta: ognuna con la propria
 * intestazione (nome del mezzo e dimensioni), la targa, il disegno vettoriale e
 * la tabella riassuntiva dei clienti / lotti, con **paginazione dinamica**:
 *   - `rowCount <= 3` → carico compatto: disegno e tabella in un'unica pagina;
 *   - `rowCount >= 4` → carico multi-tappa articolato: il disegno resta a
 *     grandezza piena, la tabella completa scatta nella pagina successiva con
 *     salto pagina forzato.
 *
 * Nella modalità **Solo Grafica** (`data-print-mode="clean"`) le pagine vengono
 * ridotte a un unico foglio A4 **panoramico** con tutti i pianali affiancati:
 * è qui che serve `getFleetExtent`, che unisce gli ingombri di tutti gli stalli.
 *
 * Il disegno riporta gli stessi riferimenti metrici del canvas a schermo:
 * quota nominale 13,20 m (sui mezzi che la raggiungono), indicatori LDM
 * calcolati dalla funzione condivisa `calculateLdmMetrics` (Regola della Corsia
 * di Parete) e le note laterali di carico alle loro coordinate 2D.
 */
export const PrintReport: React.FC<PrintReportProps> = ({ bays, labelDensity }) => {
  // Data/ora di generazione: aggiornata all'apertura della stampa del browser.
  const [generatedAt, setGeneratedAt] = useState<Date>(() => new Date());

  useEffect(() => {
    const refreshTimestamp = () => setGeneratedAt(new Date());
    window.addEventListener('beforeprint', refreshTimestamp);
    return () => window.removeEventListener('beforeprint', refreshTimestamp);
  }, []);

  /** Data e ora di generazione, separate (`02/10/2026 • 10:49`). */
  const generatedDate = generatedAt.toLocaleDateString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const generatedTime = generatedAt.toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const generatedLabel = `${generatedDate} • ${generatedTime}`;

  /**
   * Inquadratura dell'unico foglio della modalità **Solo Grafica**: unisce gli
   * ingombri di tutti gli stalli affiancati (`getFleetExtent`), targhe estese
   * fuori sponda comprese.
   */
  const fleetExtent = getFleetExtent(bays, labelDensity);
  const offsets = bayOffsets(bays);

  /** Riepilogo generale della flotta, stampato come ultima pagina di servizio. */
  const fleetItems = bays.reduce((sum, bay) => sum + bay.items.length, 0);
  const fleetLdm = bays.reduce(
    (sum, bay) => sum + calculateLdmMetrics(bay.vehicle, bay.items).maxOccupiedY,
    0
  );

  return (
    <div id="print-report">
      {/* --- SOLO GRAFICA (`data-print-mode="clean"`): tutti i pianali affiancati
              su UN UNICO foglio A4 — verticale con 1 o 2 mezzi, panoramico con 3
              (`data-print-landscape` su `<html>`) — a grandezza proporzionata. Le
              altre sezioni sono nascoste dalle regole `@media print`. ------------- */}
      <section className="print-page print-clean-sheet">
        <div className="print-clean-timestamp hidden text-[8pt] font-mono text-slate-400 w-full text-right pb-1">
          {generatedLabel}
        </div>
        <div className="print-drawing print-drawing-fleet">
          <svg
            viewBox={`${round(fleetExtent.minX)} ${round(fleetExtent.minY)} ${round(fleetExtent.width)} ${round(fleetExtent.estimatedHeight)}`}
            preserveAspectRatio="xMidYMid meet"
            className="h-full w-full"
          >
            {bays.map((bay, index) => {
              const bayExtent = getPianoExtent(
                bay.vehicle,
                bay.items,
                labelDensity,
                bay.notes,
                bay.plate
              );
              return (
                <PrintBayDrawing
                  key={bay.id}
                  vehicle={bay.vehicle}
                  items={bay.items}
                  notes={bay.notes}
                  plate={bay.plate}
                  labelDensity={labelDensity}
                  xOffset={offsets[index]}
                  doorLabelY={bayExtent.doorLabelY}
                />
              );
            })}
          </svg>
        </div>
      </section>

      {/* --- SCHEDA COMPLETA: una pagina per ciascun mezzo della centrale -------- */}
      {bays.map((bay, index) => (
        <PrintBayPage
          key={bay.id}
          bay={bay}
          index={index}
          totalBays={bays.length}
          labelDensity={labelDensity}
          generatedLabel={generatedLabel}
        />
      ))}

      {/* --- Ultima pagina di servizio: totale flotta (solo con più di un mezzo) -- */}
      {bays.length > 1 && (
        <section
          className="print-page print-page-second print-fleet-summary"
          style={{ breakBefore: 'page', pageBreakBefore: 'always' }}
        >
          <header className="flex items-end justify-between border-b-2 border-slate-800 pb-1.5">
            <h2 className="font-black text-[12pt] tracking-tight text-slate-900">
              CENTRALE MULTI-PIANALE — TOTALE FLOTTA
            </h2>
            <p className="text-[8pt] text-slate-500">
              {bays.length} mezzi • {generatedLabel}
            </p>
          </header>
          <table className="w-full border-collapse text-[8pt]">
            <thead>
              <tr className="bg-slate-100 text-left text-[7.5pt] uppercase tracking-wider text-slate-600">
                <th className="border border-slate-300 px-1.5 py-1">Mezzo</th>
                <th className="border border-slate-300 px-1.5 py-1">Targa</th>
                <th className="border border-slate-300 px-1.5 py-1">Veicolo</th>
                <th className="border border-slate-300 px-1.5 py-1 text-center">Colli</th>
                <th className="border border-slate-300 px-1.5 py-1 text-right">LDM (m)</th>
              </tr>
            </thead>
            <tbody>
              {bays.map((bay, index) => (
                <tr key={bay.id}>
                  <td className="border border-slate-300 px-1.5 py-1 font-semibold text-slate-800">
                    Mezzo {index + 1}
                  </td>
                  <td className="border border-slate-300 px-1.5 py-1 font-mono text-slate-700">
                    {bay.plate.trim() || '—'}
                  </td>
                  <td className="border border-slate-300 px-1.5 py-1 text-slate-700">
                    {bay.vehicle.name}
                  </td>
                  <td className="border border-slate-300 px-1.5 py-1 text-center font-mono font-bold text-slate-900">
                    {bay.items.length}
                  </td>
                  <td className="border border-slate-300 px-1.5 py-1 text-right font-mono text-slate-700">
                    {formatLdmMeters(calculateLdmMetrics(bay.vehicle, bay.items).maxOccupiedY)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-blue-50 font-bold text-slate-900">
                <td colSpan={3} className="border border-slate-300 px-1.5 py-1">
                  TOTALE FLOTTA
                </td>
                <td className="border border-slate-300 px-1.5 py-1 text-center font-mono">
                  {fleetItems}
                </td>
                <td className="border border-slate-300 px-1.5 py-1 text-right font-mono">
                  {formatLdmMeters(fleetLdm)}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}
    </div>
  );
};

/** Parametri della pagina A4 dedicata a un singolo mezzo della centrale. */
interface PrintBayPageProps {
  bay: DeckBay;
  /** Indice dello stallo nella flotta (0-based): alimenta l'etichetta `Mezzo n`. */
  index: number;
  /** Numero di mezzi della centrale: mostrato nel sottotitolo di ogni pagina. */
  totalBays: number;
  labelDensity: LabelDensity;
  /** Data e ora di generazione, già formattate. */
  generatedLabel: string;
}

/**
 * **Pagina A4 di un singolo mezzo**: intestazione formale (titolo, data, nome e
 * dimensioni del veicolo), disegno vettoriale a grandezza piena e tabella
 * riepilogativa dei clienti / lotti.
 *
 * La paginazione è dinamica come nella scheda storica a pianale singolo:
 * `rowCount <= 3` tiene tabella e disegno sullo stesso foglio, `rowCount >= 4`
 * porta la tabella completa sulla pagina successiva con salto forzato.
 */
const PrintBayPage: React.FC<PrintBayPageProps> = ({
  bay,
  index,
  totalBays,
  labelDensity,
  generatedLabel,
}) => {
  const { vehicle, items, notes, plate } = bay;

  /**
   * Inquadratura della pagina: `getPianoExtent` riceve anche la **targa**,
   * perché il testo può sforare di 50 cm per lato oltre le sponde
   * (`vehicle.width + 100` cm): nemmeno in stampa PDF la scritta può essere
   * tagliata ai bordi.
   */
  const extent = getPianoExtent(vehicle, items, labelDensity, notes, plate);
  const rows = buildSummaryRows(items);
  /** Righe di riepilogo delle note laterali (titolo, quota e testo). */
  const noteRows = buildNoteRows(notes);
  const ldm = calculateLdmMetrics(vehicle, items);

  // "Bilico frigo Fiori (2,50 × 13,28 m)" → "Bilico frigo Fiori"
  const vehicleName = vehicle.name.replace(/\s*\(.*\)\s*$/, '');
  /** Dimensioni del mezzo in metri, **larghezza per prima** (`2.50 × 13.28 m`). */
  const vehicleDimensions = `${(vehicle.width / 100).toFixed(2)} × ${(vehicle.length / 100).toFixed(2)} m`;

  const rowCount = rows.length;
  const isMultiPage = rowCount > PRINT_INLINE_TABLE_MAX_ROWS;

  return (
    <section data-print-bay-page={bay.id} className="print-page print-page-first print-bay-page">
      <header className="flex items-end justify-between border-b-2 border-slate-800 pb-1.5">
        <div>
          <h1 className="font-black text-2xl tracking-tight text-slate-900">
            PIANO DI CARICO — MEZZO {index + 1}
            {totalBays > 1 && <span className="text-slate-400"> / {totalBays}</span>}
          </h1>
          <p className="text-[8pt] text-slate-500">Truck Planner CAD — {generatedLabel}</p>
        </div>
        <div className="text-right leading-tight text-slate-700">
          <div className="text-[10pt] font-bold text-slate-900">
            {plate.trim() ? plate.trim().toUpperCase() : vehicleName}
          </div>
          <div className="font-mono text-[8pt]">{vehicleDimensions}</div>
        </div>
      </header>

      <div className="print-drawing">
        <svg
          viewBox={`${extent.minX} ${extent.minY} ${round(extent.width)} ${round(extent.estimatedHeight)}`}
          preserveAspectRatio="xMidYMid meet"
          className="h-full w-full"
        >
          <PrintBayDrawing
            vehicle={vehicle}
            items={items}
            notes={notes}
            plate={plate}
            labelDensity={labelDensity}
            xOffset={0}
            doorLabelY={extent.doorLabelY}
          />
        </svg>
      </div>

      {/* Carico compatto (`rowCount <= 3`): tabella in calce al disegno. */}
      {!isMultiPage && (
        <PrintSummaryTable rows={rows} noteRows={noteRows} totalItems={items.length} ldm={ldm} />
      )}

      {/* Carico multi-tappa articolato (`rowCount >= 4`): il disegno resta a
          grandezza piena e la tabella scatta nella pagina successiva. */}
      {isMultiPage && (
        <div
          data-print-multipage-note
          className="text-center text-[10px] text-slate-500 font-semibold py-1"
        >
          {PRINT_PAGE_TWO_HINT}
        </div>
      )}

      {/* Pagina dedicata al riepilogo dettagliato del solo carico articolato. */}
      {isMultiPage && (
        <section
          data-print-bay-table-page={bay.id}
          className="print-page print-page-second print-bay-table-page"
          style={{ breakBefore: 'page', pageBreakBefore: 'always' }}
        >
          <header className="flex items-end justify-between border-b-2 border-slate-800 pb-1.5">
            <h2 className="font-black text-[12pt] tracking-tight text-slate-900">
              MEZZO {index + 1} — RIEPILOGO DETTAGLIATO COLLI
            </h2>
            <p className="text-[8pt] text-slate-500">
              {vehicleName} • {generatedLabel}
            </p>
          </header>
          <PrintSummaryTable rows={rows} noteRows={noteRows} totalItems={items.length} ldm={ldm} />
        </section>
      )}
    </section>
  );
};
