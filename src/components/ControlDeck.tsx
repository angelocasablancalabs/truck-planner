import React, { useEffect, useRef, useState } from 'react';
import type {
  VehicleConfig,
  PlacedItem,
  PalletDefinition,
  AddItemOptions,
  SequenceBatchItem,
  LabelDensity,
  SideNote,
} from '../types';
import { VEHICLE_PRESETS, PALLET_CATALOG, CUSTOM_PALLET, COLOR_FAMILIES, COLOR_FAMILY_MEDIUM_SHADES } from '../constants';
import type { ColorFamily } from '../constants';
import { copyCanvasToClipboard } from '../utils/export';
import {
  NOTE_BORDER_COLOR,
  NOTE_DEFAULT_FONT_SIZE,
  NOTE_DEFAULT_WIDTH_CM,
  NOTE_FONT_SIZES,
  NOTE_MAX_HEIGHT_CM,
  NOTE_MAX_WIDTH_CM,
  NOTE_MIN_HEIGHT_CM,
  NOTE_MIN_WIDTH_CM,
  NOTE_PASTEL_COLORS,
  NOTE_SIZE_STEP_CM,
  buildNoteSeedText,
  noteCharsPerLine,
  noteGeometry,
  resolveNoteFontSize,
} from '../utils/sideNotes';
import {
  Truck,
  RotateCw,
  Trash2,
  Plus,
  Info,
  ArrowUpDown,
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Printer,
  Download,
  FileText,
} from 'lucide-react';

/** Scheda attiva nella sidebar: carico diretto (manuale) o stiva sequenziale. */
type DeckTab = 'direct' | 'sequence';

/** Esito dell'ultima esportazione immagine (feedback temporaneo sul pulsante). */
type CopyFeedback = 'idle' | 'copied' | 'downloaded';

/** Durata (ms) del feedback verde "Copiato!" sul pulsante di esportazione. */
const COPY_FEEDBACK_MS = 2500;

/** Modalità di applicazione della sequenza sul pianale. */
type SequenceMode = 'replace' | 'append';

/** Limiti di quantità per riga del generatore sequenziale. */
const SEQUENCE_MIN_QUANTITY = 1;
const SEQUENCE_MAX_QUANTITY = 99;

/**
 * Formati disponibili nel generatore sequenziale.
 * `code` è la chiave di `PALLET_CATALOG`, `label` l'etichetta mostrata all'operatore.
 */
const SEQUENCE_FORMATS: { code: string; label: string }[] = [
  { code: 'EUR', label: 'PLT EUR' },
  { code: 'INDU', label: 'PLT INDU' },
  { code: 'HALF_EUR', label: 'PLT ½ EUR' },
  { code: 'CC', label: 'CC' },
  { code: 'EC', label: 'EC' },
];

/** Formato di default di una nuova riga di spedizione. */
const DEFAULT_SEQUENCE_FORMAT = 'EUR';

/** Limiti fisici del collo "Formato Libero / Fuori Sagoma" (cm). */
const CUSTOM_MIN_WIDTH = 10;
const CUSTOM_MAX_WIDTH = 300;
const CUSTOM_MIN_LENGTH = 10;
const CUSTOM_MAX_LENGTH = 1500;

/**
 * Matrice colori stile Excel (Sprint F): 7 famiglie × 3 sfumature = 21 tinte.
 * Le tre righe si susseguono dalla tonalità chiara alla scura.
 */
const COLOR_SHADE_ROWS: { key: keyof ColorFamily['shades']; label: string }[] = [
  { key: 'light', label: 'chiaro' },
  { key: 'medium', label: 'medio' },
  { key: 'dark', label: 'scuro' },
];

interface ControlDeckProps {
  vehicle: VehicleConfig;
  onSelectVehicle: (v: VehicleConfig) => void;
  onAddItem: (pallet: PalletDefinition, options?: AddItemOptions) => void;
  onRotateSelected: () => void;
  onDeleteSelected: () => void;
  onClearAll: () => void;
  onUpdateItemProperties: (target: string | string[], updates: Partial<PlacedItem>) => void;
  /** Motore di stiva sequenziale (multi-tappa): sostituisce o accoda i lotti. */
  onExecuteSequence: (batches: SequenceBatchItem[], mode: SequenceMode) => void;
  /** Note laterali presenti sul pianale (corsia a destra della parete). */
  notes: SideNote[];
  /** Nota attualmente selezionata (null = pannello di modifica chiuso). */
  selectedNoteId: string | null;
  /** Crea una nota laterale (eredità automatica dal collo selezionato). */
  onAddNote: (noteData: Omit<SideNote, 'id'>) => void;
  onUpdateNote: (id: string, updates: Partial<SideNote>) => void;
  onDeleteNote: (id: string) => void;
  selectedItems: PlacedItem[];
  items: PlacedItem[];
  /** Densità etichette attiva: viene applicata anche allo snapshot esportato. */
  labelDensity: LabelDensity;
}

/** Testo di partenza di una nota appena creata, da personalizzare. */
const DEFAULT_NOTE_CONTENT = 'Inserisci nota operativa...';

/** Etichette del selettore compatto di dimensione testo. */
const NOTE_FONT_LABELS: Record<number, string> = {
  9: 'A-',
  11: 'A',
  14: 'A+',
};

export const ControlDeck: React.FC<ControlDeckProps> = ({
  vehicle,
  onSelectVehicle,
  onAddItem,
  onRotateSelected,
  onDeleteSelected,
  onClearAll,
  onUpdateItemProperties,
  onExecuteSequence,
  notes,
  selectedNoteId,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  selectedItems,
  items,
  labelDensity,
}) => {
  const [bulkLength, setBulkLength] = useState<number>(2.0); // Metri per lo sfuso
  // Scheda attiva: carico diretto (manuale) oppure stiva sequenziale a tappe.
  const [activeTab, setActiveTab] = useState<DeckTab>('direct');
  // Righe lotto/tappa del generatore sequenziale.
  const [sequenceRows, setSequenceRows] = useState<SequenceBatchItem[]>([]);
  // Modalità di applicazione: sostituisce l'intero carico oppure lo accoda.
  const [sequenceMode, setSequenceMode] = useState<SequenceMode>('replace');

  // Formato Libero / Fuori Sagoma: dimensioni e nome arbitrari
  const [customName, setCustomName] = useState<string>('Collo Custom');
  const [customWidth, setCustomWidth] = useState<number>(200);
  const [customLength, setCustomLength] = useState<number>(150);

  // --- Box ad accordion (risparmio verticale della sidebar) ----------------
  // Chiusi di default: mostrano solo la riga compatta cliccabile con freccina.
  const [isBulkOpen, setIsBulkOpen] = useState<boolean>(false);
  const [isCustomOpen, setIsCustomOpen] = useState<boolean>(false);

  // --- Condivisione & Output (Sprint D) -----------------------------------
  // Esito dell'ultima esportazione: alimenta il feedback temporaneo del pulsante.
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>('idle');
  const [isCopying, setIsCopying] = useState<boolean>(false);
  // Timer di reset del feedback: si spegne da solo dopo 2,5 secondi.
  const copyFeedbackTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copyFeedbackTimer.current !== null) window.clearTimeout(copyFeedbackTimer.current);
    },
    []
  );

  /**
   * Esporta il pianale in PNG: copia negli appunti di sistema e, se il browser
   * nega l'accesso, scarica automaticamente `piano-di-carico.png`.
   * Il pulsante mostra l'esito ("Copiato!" / "PNG salvato") per 2,5 secondi.
   */
  const handleCopyImage = async () => {
    if (isCopying) return;
    setIsCopying(true);

    const copied = await copyCanvasToClipboard(vehicle, items, labelDensity, notes);

    setIsCopying(false);
    setCopyFeedback(copied ? 'copied' : 'downloaded');

    if (copyFeedbackTimer.current !== null) window.clearTimeout(copyFeedbackTimer.current);
    copyFeedbackTimer.current = window.setTimeout(() => setCopyFeedback('idle'), COPY_FEEDBACK_MS);
  };

  // Selezione singola o multipla
  const selectedItem = selectedItems.length === 1 ? selectedItems[0] : null;
  const selectedIds = selectedItems.map((item) => item.id);
  const isMultiSelection = selectedItems.length > 1;

  /** Nome comune a tutti i colli selezionati ('' se divergenti). */
  const sharedName =
    selectedItems.length > 0 && selectedItems.every((item) => item.name === selectedItems[0].name)
      ? selectedItems[0].name
      : '';

  /** Colore comune a tutti i colli selezionati (null se divergenti). */
  const sharedColor =
    selectedItems.length > 0 &&
    selectedItems.every((item) => item.color.toLowerCase() === selectedItems[0].color.toLowerCase())
      ? selectedItems[0].color.toLowerCase()
      : null;

  /** Nota attualmente selezionata (pannello "Nota Laterale Selezionata"). */
  const selectedNote = notes.find((note) => note.id === selectedNoteId) ?? null;

  /** Limiti fisici delle card di nota (cm): gli stessi applicati dalla maniglia. */
  const clampNoteWidth = (value: number): number => {
    const safe = Number.isFinite(value) && value > 0 ? value : NOTE_DEFAULT_WIDTH_CM;
    return Math.max(NOTE_MIN_WIDTH_CM, Math.min(NOTE_MAX_WIDTH_CM, Math.round(safe)));
  };
  const clampNoteHeight = (value: number): number => {
    const safe = Number.isFinite(value) && value > 0 ? value : NOTE_MIN_HEIGHT_CM;
    return Math.max(NOTE_MIN_HEIGHT_CM, Math.min(NOTE_MAX_HEIGHT_CM, Math.round(safe)));
  };

  /**
   * Geometria corrente della nota selezionata: fornisce l'altezza effettiva
   * (auto-adattata al testo finché l'operatore non la fissa) e il corpo del
   * testo realmente applicato nella card.
   */
  const selectedNoteGeometry = selectedNote ? noteGeometry(selectedNote) : null;
  const noteFontSize = selectedNote ? resolveNoteFontSize(selectedNote) : NOTE_DEFAULT_FONT_SIZE;
  /** Altezza mostrata nel campo H: quella esplicita, o quella misurata sul testo. */
  const selectedNoteHeight = selectedNote
    ? selectedNote.height ?? selectedNoteGeometry?.height ?? NOTE_MIN_HEIGHT_CM
    : NOTE_MIN_HEIGHT_CM;

  /**
   * Crea una nota laterale a partire dai colli selezionati, con eredità
   * automatica di quota, testo e colore:
   * - `y`: quota minima Y della selezione (la nota si allinea alla loro altezza);
   * - `content`: pre-popolato col nome del primo collo (es. `"PRODIVA 3S - "`),
   *   già pronto per essere completato con l'avvertenza operativa;
   * - `color`: l'esatto pastello di riempimento del collo selezionato;
   * - `borderColor`: antracite tenue `#94A3B8`, `width`: 140 cm,
   *   `fontSize`: 11 px (il testo si adatta al box).
   */
  const handleAddSideNote = () => {
    if (selectedItems.length === 0) return;

    const anchor = selectedItems[0];
    onAddNote({
      y: Math.min(...selectedItems.map((item) => item.y)),
      content: buildNoteSeedText(anchor.name) || DEFAULT_NOTE_CONTENT,
      color: anchor.color,
      borderColor: NOTE_BORDER_COLOR,
      width: NOTE_DEFAULT_WIDTH_CM,
      fontSize: NOTE_DEFAULT_FONT_SIZE,
    });
  };

  /**
   * Matrice colori compatta 7 colonne (famiglie) × 3 righe (sfumature):
   * riga 1 chiara, riga 2 media, riga 3 scura. Le caselle sono rettangolini
   * `w-5 h-4.5` con bordo sottile; la tinta attiva è evidenziata da un anellino
   * blu (`ring-2 ring-blue-600`).
   *
   * Cliccando una casella viene aggiornato **solo** il riempimento dei colli
   * indicati: il contorno resta rigidamente `ITEM_BORDER_COLOR` (`#334155`).
   *
   * @param activeColor tinta comune alla selezione (null se i colli divergono).
   * @param onPick      riceve l'HEX della sfumatura cliccata.
   * @param ariaPrefix  prefisso delle etichette accessibili (singolo / tappa).
   */
  const renderColorMatrix = (
    activeColor: string | null,
    onPick: (hex: string) => void,
    ariaPrefix: string
  ) => (
    <div role="group" aria-label="Matrice colori" className="inline-flex flex-col gap-0.5">
      {COLOR_SHADE_ROWS.map((shade) => (
        <div key={shade.key} className="flex items-center gap-1">
          {COLOR_FAMILIES.map((family) => {
            const hex = family.shades[shade.key];
            // Confronto case-insensitive: i colori possono arrivare in HEX maiuscolo.
            const isActive = activeColor?.toLowerCase() === hex.toLowerCase();
            return (
              <button
                key={`${family.id}-${shade.key}`}
                type="button"
                title={`${family.name} ${shade.label}`}
                aria-label={`${ariaPrefix} ${family.name} ${shade.label}`}
                aria-pressed={isActive}
                onClick={() => onPick(hex)}
                className={`w-5 h-4.5 rounded-sm border border-slate-300 hover:scale-110 transition cursor-pointer ${
                  isActive ? 'ring-2 ring-blue-600' : ''
                }`}
                style={{ backgroundColor: hex }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );

  // Definizione di catalogo del collo sfuso (legenda colore + dimensioni)
  const bulkPallet = PALLET_CATALOG.find((p) => p.isBulk);

  /** Aggiunge il collo fuori sagoma con i valori correnti, clampati nei limiti. */
  const handleAddCustom = () => {
    const width = Math.min(CUSTOM_MAX_WIDTH, Math.max(CUSTOM_MIN_WIDTH, customWidth || 200));
    const length = Math.min(CUSTOM_MAX_LENGTH, Math.max(CUSTOM_MIN_LENGTH, customLength || 150));

    onAddItem(CUSTOM_PALLET, {
      width,
      length,
      rotation: 0,
      name: customName.trim() || 'Collo Custom',
    });
  };

  // --- Generatore "Stiva Sequenza" (Multi-Tappa) ---------------------------

  /**
   * Nuova riga lotto/tappa. La tonalità "media" della matrice ruota
   * automaticamente in base alla posizione della riga: tappe diverse restano
   * distinguibili a vista senza che l'operatore debba scegliere il colore.
   */
  const createSequenceRow = (index: number): SequenceBatchItem => ({
    id: `seq_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    quantity: 1,
    palletCode: DEFAULT_SEQUENCE_FORMAT,
    orientation: 'piatto',
    clientName: '',
    color: COLOR_FAMILY_MEDIUM_SHADES[index % COLOR_FAMILY_MEDIUM_SHADES.length],
  });

  const handleAddSequenceRow = () => {
    setSequenceRows((prev) => [...prev, createSequenceRow(prev.length)]);
  };

  const handleUpdateSequenceRow = (id: string, updates: Partial<SequenceBatchItem>) => {
    setSequenceRows((prev) =>
      prev.map((row) => (row.id === id ? { ...row, ...updates } : row))
    );
  };

  const handleRemoveSequenceRow = (id: string) => {
    setSequenceRows((prev) => prev.filter((row) => row.id !== id));
  };

  /** Passa i lotti al motore di stiva sequenziale in `App.tsx`. */
  const handleRunSequence = () => {
    if (sequenceRows.length === 0) return;
    onExecuteSequence(sequenceRows, sequenceMode);
  };

  // Calcolo statistiche veloci
  const countsByCode = items.reduce((acc, curr) => {
    acc[curr.name] = (acc[curr.name] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Etichetta, icona e stile del pulsante di esportazione immagine.
  const copyLabel =
    copyFeedback === 'copied'
      ? 'Copiato!'
      : copyFeedback === 'downloaded'
        ? 'PNG salvato'
        : 'Copia Immagine';
  const CopyIcon = copyFeedback === 'copied' ? Check : copyFeedback === 'downloaded' ? Download : Copy;
  const copyButtonClass =
    copyFeedback === 'copied'
      ? 'border-green-300 bg-green-50 text-green-700'
      : copyFeedback === 'downloaded'
        ? 'border-amber-300 bg-amber-50 text-amber-700'
        : 'border-slate-200 bg-slate-50 text-slate-700 hover:border-blue-400 hover:bg-blue-50';

  return (
    <div className="control-deck print:hidden w-full h-full bg-white border-l border-slate-200 flex flex-col p-5 overflow-y-auto space-y-6">
      {/* Header */}
      <div className="border-b border-slate-200 pb-3">
        <h1 className="text-xl font-black text-slate-800 tracking-tight flex items-center gap-2">
          <Truck className="w-6 h-6 text-blue-600" />
          TRUCK PLANNER
        </h1>
        <p className="text-xs text-slate-500 font-medium">Gestione Carico 2D Vettoriale</p>
      </div>

      {/* Barra comandi rapida: Copia Immagine (PNG) + Stampa / PDF */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          id="btn-copy-image"
          onClick={handleCopyImage}
          disabled={isCopying}
          aria-live="polite"
          title="Copia il pianale negli appunti come immagine PNG ad alta risoluzione"
          className={`flex items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-semibold transition disabled:opacity-60 disabled:cursor-wait ${copyButtonClass}`}
        >
          <CopyIcon className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{copyLabel}</span>
        </button>

        <button
          type="button"
          id="btn-print-report"
          onClick={() => window.print()}
          title="Stampa la scheda di carico A4 o salvala in PDF"
          className="flex items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11px] font-semibold text-slate-700 transition hover:border-slate-400 hover:bg-slate-100"
        >
          <Printer className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">Stampa / PDF</span>
        </button>
      </div>

      {/* Selettore a schede: Carico Diretto | Stiva Sequenza */}
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-100 p-1">
        <button
          type="button"
          onClick={() => setActiveTab('direct')}
          aria-pressed={activeTab === 'direct'}
          className={`rounded-md px-2 py-1.5 text-[11px] transition ${
            activeTab === 'direct'
              ? 'bg-white shadow-sm font-bold text-slate-800'
              : 'text-slate-500 hover:text-slate-700 font-medium'
          }`}
        >
          📦 Carico Diretto
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('sequence')}
          aria-pressed={activeTab === 'sequence'}
          className={`rounded-md px-2 py-1.5 text-[11px] transition ${
            activeTab === 'sequence'
              ? 'bg-white shadow-sm font-bold text-slate-800'
              : 'text-slate-500 hover:text-slate-700 font-medium'
          }`}
        >
          ⚡ Stiva Sequenza
        </button>
      </div>

      {/* Selettore Mezzo */}
      <div className="space-y-2">
        <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
          Configurazione Mezzo
        </label>
        <select
          value={vehicle.id}
          onChange={(e) => {
            const found = VEHICLE_PRESETS.find((v) => v.id === e.target.value);
            if (found) onSelectVehicle(found);
          }}
          className="w-full bg-slate-50 border border-slate-300 text-slate-800 text-sm rounded-md p-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
        >
          {VEHICLE_PRESETS.map((vp) => (
            <option key={vp.id} value={vp.id}>
              {vp.name}
            </option>
          ))}
        </select>

        {/* Dimensioni libere: campi visibili solo per il mezzo personalizzato */}
        {vehicle.id === 'custom' && (
          <div className="flex gap-2">
            <label className="flex-1 space-y-1">
              <span className="block text-[10px] font-bold text-slate-500 uppercase">
                Larghezza (cm)
              </span>
              <input
                type="number"
                min={100}
                max={300}
                step={1}
                value={vehicle.width}
                onChange={(e) => {
                  const width = Number(e.target.value);
                  if (Number.isFinite(width) && width > 0) {
                    onSelectVehicle({ ...vehicle, width });
                  }
                }}
                className="w-full bg-slate-50 border border-slate-300 text-slate-800 text-xs rounded p-1.5 font-mono focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </label>

            <label className="flex-1 space-y-1">
              <span className="block text-[10px] font-bold text-slate-500 uppercase">
                Lunghezza (cm)
              </span>
              <input
                type="number"
                min={200}
                max={2000}
                step={1}
                value={vehicle.length}
                onChange={(e) => {
                  const length = Number(e.target.value);
                  if (Number.isFinite(length) && length > 0) {
                    onSelectVehicle({ ...vehicle, length });
                  }
                }}
                className="w-full bg-slate-50 border border-slate-300 text-slate-800 text-xs rounded p-1.5 font-mono focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </label>
          </div>
        )}
      </div>

      {/* ---- Scheda: Carico Diretto (catalogo manuale) ---- */}
      {activeTab === 'direct' && (
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
            Aggiungi Colli
          </label>
          <button
            type="button"
            onClick={() => {
              if (items.length > 0 && window.confirm('Sei sicuro di voler svuotare completamente il pianale?')) {
                onClearAll();
              }
            }}
            disabled={items.length === 0}
            title={items.length === 0 ? 'Il pianale è già vuoto' : 'Svuota tutto il carico'}
            className={
              items.length === 0
                ? 'flex items-center gap-1 text-[11px] font-medium text-slate-300 cursor-not-allowed'
                : 'flex items-center gap-1 text-red-800 hover:text-red-900 hover:bg-red-50 border border-transparent hover:border-red-200 cursor-pointer px-1.5 py-0.5 rounded transition font-medium text-[11px]'
            }
          >
            <Trash2 className="w-3 h-3" />
            Svuota
          </button>
        </div>
        <div className="space-y-1">
          {PALLET_CATALOG.filter((p) => !p.isBulk).map((pallet) => {
            // Punta = lato corto verso le porte, Piatto = lato lungo verso le porte.
            const shortSide = Math.min(pallet.width, pallet.length);
            const longSide = Math.max(pallet.width, pallet.length);

            return (
              <div
                key={pallet.code}
                className="flex items-center justify-between p-1.5 px-2.5 rounded border border-slate-200 bg-white hover:border-slate-300 transition-colors"
              >
                {/* Identificativo collo */}
                <span className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="w-3 h-3 rounded-sm border shrink-0"
                    style={{ backgroundColor: pallet.color, borderColor: pallet.borderColor }}
                  />
                  <span className="text-xs font-bold text-slate-800 tracking-tight truncate">
                    {pallet.name}
                  </span>
                </span>

                {/* Comandi rapidi: Piatto (prima scelta) / Punta */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {pallet.rotatable && (
                    <button
                      type="button"
                      onClick={() => onAddItem(pallet, { width: longSide, length: shortSide, rotation: 90 })}
                      title={`Aggiungi di Piatto (${longSide}×${shortSide} cm)`}
                      className="flex items-center gap-1 px-2 py-1 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-400 rounded transition"
                    >
                      <ArrowLeftRight className="w-3 h-3 text-slate-500" />
                      <span className="text-[10px] leading-none text-slate-700 font-semibold font-mono">
                        {longSide}×{shortSide}
                      </span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onAddItem(pallet, { width: shortSide, length: longSide, rotation: 0 })}
                    title={`Aggiungi di Punta (${shortSide}×${longSide} cm)`}
                    className="flex items-center gap-1 px-2 py-1 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-400 rounded transition"
                  >
                    <ArrowUpDown className="w-3 h-3 text-slate-500" />
                    <span className="text-[10px] leading-none text-slate-700 font-semibold font-mono">
                      {shortSide}×{longSide}
                    </span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Blocco Collo Sfuso — box ad accordion (chiuso di default) */}
        <div className="bg-white border border-slate-200 rounded overflow-hidden">
          <button
            type="button"
            id="toggle-bulk-box"
            onClick={() => setIsBulkOpen((prev) => !prev)}
            aria-expanded={isBulkOpen}
            aria-controls="bulk-box-fields"
            title={isBulkOpen ? 'Comprimi il box Sfuso' : 'Espandi il box Sfuso'}
            className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left transition hover:bg-slate-50"
          >
            <span className="flex items-center gap-1.5 min-w-0">
              {isBulkOpen ? (
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              )}
              <span
                className="w-3 h-3 rounded-sm border shrink-0"
                style={{
                  backgroundColor: bulkPallet?.color,
                  borderColor: bulkPallet?.borderColor,
                }}
              />
              <span className="text-xs font-bold text-slate-800 truncate">
                Sfuso (Metri Lineari)
              </span>
            </span>
            <span className="text-[10px] font-mono text-slate-400 shrink-0 tabular-nums">
              {bulkLength.toFixed(1)} m
            </span>
          </button>

          {isBulkOpen && (
            <div
              id="bulk-box-fields"
              className="px-2.5 pb-2.5 pt-2 space-y-2 border-t border-slate-100"
            >
              <div className="flex items-center justify-end">
                <span className="text-[10px] font-mono text-slate-500 shrink-0">
                  W: {vehicle.width} cm
                </span>
              </div>
              <div className="flex gap-2">
                <input
                  type="number"
                  step="0.1"
                  min="0.5"
                  max="13.6"
                  value={bulkLength}
                  onChange={(e) => setBulkLength(parseFloat(e.target.value) || 1)}
                  className="w-24 bg-slate-50 border border-slate-300 text-slate-800 text-xs rounded p-1.5 font-mono focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <button
                  onClick={() => {
                    if (bulkPallet) onAddItem(bulkPallet, { length: bulkLength * 100 });
                  }}
                  className="flex-1 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-400 text-slate-700 text-xs font-semibold py-1.5 px-3 rounded flex items-center justify-center gap-1.5 transition"
                >
                  <Plus className="w-3.5 h-3.5 text-slate-500" /> Aggiungi Sfuso
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Blocco Formato Libero / Fuori Sagoma — box ad accordion (chiuso di default) */}
        <div className="bg-white border border-slate-200 rounded overflow-hidden">
          <button
            type="button"
            id="toggle-custom-box"
            onClick={() => setIsCustomOpen((prev) => !prev)}
            aria-expanded={isCustomOpen}
            aria-controls="custom-box-fields"
            title={isCustomOpen ? 'Comprimi il box Formato Libero' : 'Espandi il box Formato Libero'}
            className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left transition hover:bg-slate-50"
          >
            <span className="flex items-center gap-1.5 min-w-0">
              {isCustomOpen ? (
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              )}
              <span
                className="w-3 h-3 rounded-sm border shrink-0"
                style={{
                  backgroundColor: CUSTOM_PALLET.color,
                  borderColor: CUSTOM_PALLET.borderColor,
                }}
              />
              <span className="text-xs font-bold text-slate-800 truncate">
                Formato Libero / Fuori Sagoma
              </span>
            </span>
            <span className="text-[10px] font-mono text-slate-400 shrink-0 tabular-nums">
              {customWidth}×{customLength} cm
            </span>
          </button>

          {isCustomOpen && (
            <div
              id="custom-box-fields"
              className="px-2.5 pb-2.5 pt-2 space-y-2 border-t border-slate-100"
            >
              <label className="block space-y-1">
                <span className="block text-[10px] font-bold text-slate-500 uppercase">
                  Nome / Cliente
                </span>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="Es. Macchinario"
                  className="w-full bg-slate-50 border border-slate-300 text-slate-800 text-xs rounded p-1.5 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </label>

              <div className="flex gap-2">
                <label className="flex-1 space-y-1">
                  <span className="block text-[10px] font-bold text-slate-500 uppercase">
                    Larghezza (W cm)
                  </span>
                  <input
                    type="number"
                    min={CUSTOM_MIN_WIDTH}
                    max={CUSTOM_MAX_WIDTH}
                    step={1}
                    value={customWidth}
                    onChange={(e) => setCustomWidth(Number(e.target.value))}
                    className="w-full bg-slate-50 border border-slate-300 text-slate-800 text-xs rounded p-1.5 font-mono focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </label>

                <label className="flex-1 space-y-1">
                  <span className="block text-[10px] font-bold text-slate-500 uppercase">
                    Lunghezza (L cm)
                  </span>
                  <input
                    type="number"
                    min={CUSTOM_MIN_LENGTH}
                    max={CUSTOM_MAX_LENGTH}
                    step={1}
                    value={customLength}
                    onChange={(e) => setCustomLength(Number(e.target.value))}
                    className="w-full bg-slate-50 border border-slate-300 text-slate-800 text-xs rounded p-1.5 font-mono focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </label>
              </div>

              <button
                type="button"
                onClick={handleAddCustom}
                className="w-full bg-slate-50 border border-slate-200 hover:bg-blue-50 hover:border-blue-400 text-slate-700 text-xs font-semibold py-1.5 px-3 rounded flex items-center justify-center gap-1.5 transition"
              >
                <Plus className="w-3.5 h-3.5 text-slate-500" /> Aggiungi Fuori Sagoma
              </button>
            </div>
          )}
        </div>
      </div>
      )}

      {/* ---- Scheda: Stiva Sequenza (Multi-Tappa) ---- */}
      {activeTab === 'sequence' && (
        <div className="space-y-3">
          <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
            Lotti / Tappe di Consegna
          </label>

          {sequenceRows.length === 0 && (
            <div className="rounded border border-dashed border-slate-300 bg-slate-50 p-3 text-[11px] text-slate-500 italic">
              Nessuna tappa: aggiungi una riga e indica formato, quantità e cliente.
              La stiva parte dalla Cabina e procede verso le Porte.
            </div>
          )}

          {/* Lista righe lotto / tappa */}
          <div className="space-y-1.5">
            {sequenceRows.map((row, index) => {
              const isPiatto = row.orientation === 'piatto';

              return (
                <div
                  key={row.id}
                  className="rounded border border-slate-200 bg-white p-2 space-y-1.5"
                >
                  {/* Riga 1: tappa, quantità, formato, orientamento */}
                  <div className="flex items-center gap-1.5">
                    <span className="w-4 shrink-0 text-center text-[10px] font-mono font-bold text-slate-400">
                      {index + 1}
                    </span>

                    <label className="flex items-center gap-1 shrink-0">
                      <span className="text-[10px] font-bold text-slate-500 uppercase">
                        Qtà
                      </span>
                      <input
                        type="number"
                        min={SEQUENCE_MIN_QUANTITY}
                        max={SEQUENCE_MAX_QUANTITY}
                        step={1}
                        value={row.quantity}
                        onChange={(e) =>
                          handleUpdateSequenceRow(row.id, {
                            quantity: Number(e.target.value) || SEQUENCE_MIN_QUANTITY,
                          })
                        }
                        title="Quantità di colli per questa tappa"
                        className="w-12 bg-slate-50 border border-slate-300 text-slate-800 text-xs rounded px-1 py-1 font-mono text-center focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                    </label>

                    <select
                      value={row.palletCode}
                      onChange={(e) =>
                        handleUpdateSequenceRow(row.id, { palletCode: e.target.value })
                      }
                      title="Formato collo"
                      className="flex-1 min-w-0 bg-slate-50 border border-slate-300 text-slate-800 text-xs rounded p-1 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                    >
                      {SEQUENCE_FORMATS.map((format) => (
                        <option key={format.code} value={format.code}>
                          {format.label}
                        </option>
                      ))}
                    </select>

                    <button
                      type="button"
                      onClick={() =>
                        handleUpdateSequenceRow(row.id, {
                          orientation: isPiatto ? 'punta' : 'piatto',
                        })
                      }
                      title={isPiatto ? 'Piatto: lato lungo verso Cabina/Porte' : 'Punta: lato corto verso Cabina/Porte'}
                      className="shrink-0 flex items-center gap-1 px-1.5 py-1 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-400 rounded transition text-[10px] leading-none font-semibold text-slate-700 whitespace-nowrap"
                    >
                      <span className="text-[11px] leading-none">
                        {isPiatto ? '↔' : '↕'}
                      </span>
                      {isPiatto ? 'Piatto' : 'Punta'}
                    </button>
                  </div>

                  {/* Riga 2: cliente e rimozione */}
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={row.clientName}
                      onChange={(e) =>
                        handleUpdateSequenceRow(row.id, { clientName: e.target.value })
                      }
                      placeholder="Es. COOP"
                      className="flex-1 min-w-0 bg-slate-50 border border-slate-300 text-slate-800 text-xs rounded px-1.5 py-1 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />

                    <button
                      type="button"
                      onClick={() => handleRemoveSequenceRow(row.id)}
                      title="Rimuovi riga"
                      aria-label="Rimuovi riga spedizione"
                      className="shrink-0 p-1 rounded text-slate-400 hover:text-red-800 hover:bg-red-50 transition"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Riga 3: matrice colori della tappa (7 famiglie × 3 sfumature) */}
                  <div className="flex items-start gap-1.5">
                    <span className="shrink-0 text-[10px] font-bold text-slate-500 uppercase leading-4">
                      Colore
                    </span>
                    {renderColorMatrix(
                      row.color,
                      (hex) => handleUpdateSequenceRow(row.id, { color: hex }),
                      'Colore tappa'
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Aggiungi riga in coda */}
          <button
            type="button"
            onClick={handleAddSequenceRow}
            className="w-full bg-slate-50 border border-slate-200 hover:bg-blue-50 hover:border-blue-400 text-slate-700 text-xs font-semibold py-1.5 px-3 rounded flex items-center justify-center gap-1.5 transition"
          >
            <Plus className="w-3.5 h-3.5 text-slate-500" /> Aggiungi Riga Spedizione
          </button>

          {/* Modalità di applicazione sul pianale */}
          <div className="space-y-1">
            <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
              Applicazione
            </span>
            <div className="grid grid-cols-2 gap-1 rounded bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => setSequenceMode('replace')}
                aria-pressed={sequenceMode === 'replace'}
                title="Azzera il pianale e stiva solo la sequenza"
                className={`rounded px-2 py-1 text-[10px] transition ${
                  sequenceMode === 'replace'
                    ? 'bg-white shadow-sm font-bold text-slate-800'
                    : 'text-slate-500 hover:text-slate-700 font-medium'
                }`}
              >
                Sostituisci
              </button>
              <button
                type="button"
                onClick={() => setSequenceMode('append')}
                aria-pressed={sequenceMode === 'append'}
                title="Mantieni il carico attuale e accoda la sequenza"
                className={`rounded px-2 py-1 text-[10px] transition ${
                  sequenceMode === 'append'
                    ? 'bg-white shadow-sm font-bold text-slate-800'
                    : 'text-slate-500 hover:text-slate-700 font-medium'
                }`}
              >
                Accoda
              </button>
            </div>
          </div>

          {/* Azione primaria: esegue la stiva progressiva Cabina → Porte */}
          <button
            type="button"
            onClick={handleRunSequence}
            disabled={sequenceRows.length === 0}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 rounded shadow transition disabled:bg-slate-300 disabled:shadow-none disabled:cursor-not-allowed text-xs flex items-center justify-center gap-1.5"
          >
            ⚡ Esegui Stiva Sequenziale
          </button>
        </div>
      )}

      {/* Azioni Rapide Oggetto Selezionato (singolo o gruppo) */}
      {selectedItems.length > 0 && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-md space-y-2.5">
          {/* Intestazione: singolo collo oppure badge con il conteggio del gruppo */}
          {selectedItem ? (
            <div className="text-xs font-bold text-blue-900">
              Selezionato: {selectedItem.name} ({selectedItem.width}×{selectedItem.length} cm)
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-blue-900">Selezionati:</span>
              <span className="text-[11px] font-mono font-bold bg-blue-600 text-white px-2 py-0.5 rounded-full">
                {selectedItems.length} Colli
              </span>
            </div>
          )}

          {/* Modifica Nome / Cliente: aggiornamento istantaneo su canvas e riepilogo */}
          <label className="block space-y-1">
            <span className="block text-[10px] font-bold text-blue-900/70 uppercase tracking-wider">
              Nome / Cliente
            </span>
            <input
              type="text"
              value={selectedItem ? selectedItem.name : sharedName}
              onChange={(e) =>
                onUpdateItemProperties(selectedIds, { name: e.target.value })
              }
              placeholder={
                isMultiSelection ? 'Assegna nome a tutti...' : 'Es. Cliente / Macchinario'
              }
              className="w-full bg-white border border-slate-300 text-slate-800 text-xs rounded p-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </label>

          {/* Matrice colori (7 famiglie × 3 sfumature): singola o batch sul gruppo.
              Aggiorna SOLO il riempimento: il bordo resta `#334155`. */}
          <div className="space-y-1">
            <span className="block text-[10px] font-bold text-blue-900/70 uppercase tracking-wider">
              Colore
            </span>
            {renderColorMatrix(
              selectedItem ? selectedItem.color : sharedColor,
              (hex) => onUpdateItemProperties(selectedIds, { color: hex }),
              'Colore'
            )}
          </div>

          <div className="flex gap-2">
            <button
              onClick={onRotateSelected}
              className="flex-1 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 text-xs font-semibold py-1.5 rounded flex items-center justify-center gap-1 shadow-sm"
              title="Oppure premi la Barra Spaziatrice"
            >
              <RotateCw className="w-3.5 h-3.5 text-blue-600" /> Ruota 90°
            </button>
            <button
              onClick={onDeleteSelected}
              className="flex-1 bg-white hover:bg-red-50 border border-red-200 hover:border-red-300 text-red-800 hover:text-red-900 text-xs font-semibold py-1.5 rounded flex items-center justify-center gap-1 shadow-sm transition"
              title="Oppure premi Canc"
            >
              <Trash2 className="w-3.5 h-3.5 text-red-800" />
              {isMultiSelection ? `Cancella (${selectedItems.length})` : 'Cancella'}
            </button>
          </div>

          {/* Nota laterale con eredità automatica: quota, titolo e colore del
              collo selezionato vengono copiati nella nuova annotazione. */}
          <button
            type="button"
            id="btn-add-side-note"
            onClick={handleAddSideNote}
            title={`Crea una nota laterale alla quota Y = ${Math.min(
              ...selectedItems.map((item) => item.y)
            )} cm, col colore di ${selectedItems[0].name}`}
            className="w-full bg-white hover:bg-slate-50 border border-slate-300 hover:border-slate-400 text-slate-700 text-xs font-semibold py-1.5 rounded flex items-center justify-center gap-1.5 shadow-sm transition"
          >
            <FileText className="w-3.5 h-3.5 text-slate-500" />
            Aggiungi Nota Laterale
          </button>
        </div>
      )}

      {/* Pannello "Nota Laterale Selezionata": modifica titolo, testo e colore */}
      {selectedNote && (
        <div className="p-3 bg-slate-50 border border-slate-300 rounded-md space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
              <FileText className="w-3.5 h-3.5 text-slate-500" />
              Nota Laterale Selezionata
            </span>
            <span className="text-[10px] font-mono font-bold bg-slate-200 text-slate-700 px-1.5 py-0.5 rounded tabular-nums">
              Y {selectedNote.y.toFixed(1)} cm
            </span>
          </div>

          {/* TESTO DELLA NOTA: unico campo libero multi-riga della card. */}
          <label className="block space-y-1">
            <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
              Testo della Nota
            </span>
            <textarea
              id="note-content-input"
              value={selectedNote.content}
              onChange={(e) => onUpdateNote(selectedNote.id, { content: e.target.value })}
              rows={5}
              placeholder="Scrivi avvertenze, cliente o note operative..."
              className="w-full resize-y bg-white border border-slate-300 text-slate-800 text-xs rounded p-1.5 leading-snug focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <span className="block text-[10px] text-slate-400 italic leading-snug">
              Il testo va a capo da solo, su {noteCharsPerLine(selectedNote.width, noteFontSize)}{' '}
              caratteri per riga con la dimensione attuale.
            </span>
          </label>

          {/* Dimensione del testo: tre corpi ammessi (9 / 11 / 14 px). */}
          <div className="space-y-1">
            <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
              Dimensione Testo
            </span>
            <div
              role="group"
              aria-label="Dimensione testo nota"
              className="grid grid-cols-3 gap-1 rounded bg-slate-200/70 p-1"
            >
              {NOTE_FONT_SIZES.map((size) => {
                const isActive = noteFontSize === size;
                return (
                  <button
                    key={size}
                    type="button"
                    data-font-size={size}
                    aria-pressed={isActive}
                    title={`Corpo del testo ${size} px`}
                    onClick={() => onUpdateNote(selectedNote.id, { fontSize: size })}
                    className={`rounded px-1 py-1 leading-none transition ${
                      isActive
                        ? 'bg-white shadow-sm font-bold text-slate-800'
                        : 'text-slate-500 hover:text-slate-700 font-medium'
                    }`}
                  >
                    <span className={size === 9 ? 'text-[10px]' : size === 11 ? 'text-[12px]' : 'text-[14px]'}>
                      {NOTE_FONT_LABELS[size]}
                    </span>
                    <span className="ml-1 text-[9px] font-mono">({size}px)</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Dimensioni della casella: larghezza e altezza in cm reali. */}
          <div className="flex gap-2">
            <label className="flex-1 space-y-1">
              <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                Larghezza (W cm)
              </span>
              <input
                type="number"
                id="note-width-input"
                min={NOTE_MIN_WIDTH_CM}
                max={NOTE_MAX_WIDTH_CM}
                step={NOTE_SIZE_STEP_CM}
                value={Math.round(selectedNote.width)}
                onChange={(e) =>
                  onUpdateNote(selectedNote.id, {
                    width: clampNoteWidth(Number(e.target.value)),
                  })
                }
                className="w-full bg-white border border-slate-300 text-slate-800 text-xs rounded p-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </label>

            <label className="flex-1 space-y-1">
              <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                Altezza (H cm)
              </span>
              <input
                type="number"
                id="note-height-input"
                min={NOTE_MIN_HEIGHT_CM}
                max={NOTE_MAX_HEIGHT_CM}
                step={NOTE_SIZE_STEP_CM}
                value={Math.round(selectedNoteHeight)}
                onChange={(e) =>
                  onUpdateNote(selectedNote.id, {
                    height: clampNoteHeight(Number(e.target.value)),
                  })
                }
                className="w-full bg-white border border-slate-300 text-slate-800 text-xs rounded p-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </label>
          </div>

          {/* Palette rapida: 7 tinte pastello + bianco neutro */}
          <div className="space-y-1">
            <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
              Colore Sfondo
            </span>
            <div className="flex items-center gap-1" role="group" aria-label="Colore nota laterale">
              {NOTE_PASTEL_COLORS.map((hex) => {
                const isActive = selectedNote.color.toLowerCase() === hex.toLowerCase();
                return (
                  <button
                    key={hex}
                    type="button"
                    title={hex === '#FFFFFF' ? 'Bianco neutro' : `Sfondo ${hex}`}
                    aria-label={hex === '#FFFFFF' ? 'Bianco neutro' : `Sfondo ${hex}`}
                    aria-pressed={isActive}
                    onClick={() => onUpdateNote(selectedNote.id, { color: hex })}
                    className={`w-5 h-5 rounded-sm border border-slate-300 hover:scale-110 transition cursor-pointer ${
                      isActive ? 'ring-2 ring-blue-600' : ''
                    }`}
                    style={{ backgroundColor: hex }}
                  />
                );
              })}
            </div>
          </div>

          <button
            type="button"
            id="btn-delete-note"
            onClick={() => onDeleteNote(selectedNote.id)}
            className="w-full bg-white hover:bg-red-50 border border-red-200 hover:border-red-300 text-red-800 hover:text-red-900 text-xs font-semibold py-1.5 rounded flex items-center justify-center gap-1 shadow-sm transition"
            title="Elimina la nota laterale (oppure premi Canc)"
          >
            <Trash2 className="w-3.5 h-3.5 text-red-800" />
            Cancella Nota
          </button>
        </div>
      )}

      {/* Statistiche del Carico */}
      <div className="space-y-2 border-t border-slate-200 pt-4">
        <div className="flex justify-between items-center">
          <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
            Riepilogo Stiva
          </label>
          <span className="text-xs font-mono font-bold bg-slate-100 text-slate-800 px-2 py-0.5 rounded">
            {items.length} Colli Totali
          </span>
        </div>
        <div className="bg-slate-50 rounded border border-slate-200 p-2.5 text-xs space-y-1">
          {Object.keys(countsByCode).length === 0 ? (
            <div className="text-slate-400 italic">Nessun bancale sul pianale</div>
          ) : (
            Object.entries(countsByCode).map(([name, count]) => (
              <div key={name} className="flex justify-between font-mono text-slate-700">
                <span>{name}:</span>
                <span className="font-bold">{count}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Scorciatoie da Tastiera — trigger compatto + popover fluttuante su hover */}
      <div className="mt-auto border-t border-slate-200 pt-3 flex justify-between items-center relative">
        <div className="relative group">
          <button
            type="button"
            className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400 hover:text-slate-700 transition cursor-pointer select-none"
          >
            <Info className="w-3.5 h-3.5 text-slate-400 group-hover:text-blue-600 transition" />
            <span>Scorciatoie da tastiera</span>
          </button>

          {/* Popover fluttuante verso l'alto su hover */}
          <div className="absolute bottom-full left-0 mb-2 w-72 bg-slate-900 text-slate-100 text-[11px] p-3 rounded-lg shadow-xl opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-all duration-200 z-50 border border-slate-800 space-y-1.5">
            <div className="font-bold text-white border-b border-slate-700 pb-1 mb-1.5 flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-blue-400" />
              <span>Guida Rapida Scorciatoie</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-300">Ruota 90°</span>
              <kbd className="bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-200">Spazio</kbd>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-300">Elimina collo / nota</span>
              <kbd className="bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-200">Canc</kbd>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-300">Selezione multipla</span>
              <kbd className="bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-200">Ctrl / Cmd + Click</kbd>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-300">Lasso di selezione</span>
              <kbd className="bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-200">Shift + Trascina</kbd>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-300">Pan verticale (Cabina ↔ Porte)</span>
              <span className="text-slate-400 font-mono text-[10px]">Rotellina</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-300">Pan orizzontale</span>
              <kbd className="bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-200">Shift + Rotellina</kbd>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-300">Zoom al cursore</span>
              <kbd className="bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-200">Ctrl / Cmd + Rotellina</kbd>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};