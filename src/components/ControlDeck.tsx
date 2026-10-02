import React, { useEffect, useRef, useState } from 'react';
import type {
  VehicleConfig,
  PlacedItem,
  PalletDefinition,
  AddItemOptions,
  LabelDensity,
  SideNote,
  ProjectFile,
} from '../types';
import { VEHICLE_PRESETS, PALLET_CATALOG, CUSTOM_PALLET, COLOR_FAMILIES } from '../constants';
import type { ColorFamily } from '../constants';
import { copyCanvasToClipboard } from '../utils/export';
import {
  NOTE_BORDER_COLOR,
  NOTE_DEFAULT_FONT_SIZE,
  NOTE_DEFAULT_WIDTH_CM,
  NOTE_FONT_SIZES,
  NOTE_LANE_OFFSET_CM,
  NOTE_MAX_HEIGHT_CM,
  NOTE_MAX_WIDTH_CM,
  NOTE_MIN_HEIGHT_CM,
  NOTE_MIN_WIDTH_CM,
  NOTE_PASTEL_COLORS,
  NOTE_SIZE_STEP_CM,
  buildNoteSeedText,
  findFreeNoteY,
  noteCharsPerLine,
  noteGeometry,
  resolveNoteFontSize,
} from '../utils/sideNotes';
import { PLATE_INPUT_ID, PLATE_MAX_LENGTH } from '../utils/plateBadge';
import { parseProjectFile } from '../utils/fileStorage';
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
  FolderOpen,
  FileText,
  Undo2,
  Redo2,
} from 'lucide-react';

/** Esito dell'ultima esportazione immagine (feedback temporaneo sul pulsante). */
type CopyFeedback = 'idle' | 'copied' | 'downloaded';

/** Durata (ms) del feedback verde "Copiato!" sul pulsante di esportazione. */
const COPY_FEEDBACK_MS = 2500;

/** Durata (ms) del feedback verde "Salvato!" sul pulsante di salvataggio piano. */
const SAVE_FEEDBACK_MS = 2000;

/**
 * Caricamento a lotti dall'accordion multifunzione: quantità predefinita,
 * minima e massima accettate dall'input `Q.tà` del cassetto.
 */
const BATCH_DEFAULT_QUANTITY = 10;
const BATCH_MIN_QUANTITY = 1;
const BATCH_MAX_QUANTITY = 99;

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

/**
 * Versante di carico richiesto dall'operatore:
 * - `piatto`: lato lungo verso Cabina/Porte (W = max, L = min);
 * - `punta`:  lato corto verso Cabina/Porte (W = min, L = max).
 */
type LoadOrientation = 'piatto' | 'punta';

/**
 * Bozza di caricamento a lotti di un formato del catalogo: alimenta il cassetto
 * dell'accordion multifunzione (quantità, cliente/lotto e tinta del lotto).
 */
interface PalletBatchDraft {
  quantity: number;
  name: string;
  color: string;
}

interface ControlDeckProps {
  vehicle: VehicleConfig;
  onSelectVehicle: (v: VehicleConfig) => void;
  /**
   * Targa / identificativo del mezzo: campo libero (es. `XA000BB COME ARRIVA`)
   * che alimenta il badge tecnico sopra la Cabina, lo snapshot PNG e la scheda
   * A4. Il click sul badge del canvas riporta il focus su questo input.
   */
  plate: string;
  onUpdatePlate: (value: string) => void;
  /**
   * Salva & Apri Piano (.json): il file di progetto viene costruito da `App.tsx`
   * (unica fonte dello stato) e ricaricato con la stessa callback, che registra
   * anche il passo di Undo necessario ad annullare un'apertura involontaria.
   */
  onSaveProject: () => void;
  onLoadProject: (project: ProjectFile) => void;
  onAddItem: (pallet: PalletDefinition, options?: AddItemOptions) => void;
  onRotateSelected: () => void;
  onDeleteSelected: () => void;
  onClearAll: () => void;
  onUpdateItemProperties: (target: string | string[], updates: Partial<PlacedItem>) => void;
  /**
   * Cronologia Undo / Redo: stato delle due pile e azioni esposte dal motore di
   * `App.tsx` (i micro-pulsanti dell'header e le scorciatoie le condividono).
   */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /**
   * Motore batch first-fit: stiva `quantity` colli di un solo formato, già
   * etichettati col nome cliente e col colore scelti nel cassetto.
   */
  onAddBatch: (
    pallet: PalletDefinition,
    quantity: number,
    orientation: LoadOrientation,
    name?: string,
    color?: string
  ) => void;
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

/** Etichette del selettore compatto di dimensione testo (scala 11 / 14 / 18 px). */
const NOTE_FONT_LABELS: Record<number, string> = {
  11: 'A-',
  14: 'A',
  18: 'A+',
};

/** Classi di anteprima del glifo `A` per ciascun corpo della scala. */
const NOTE_FONT_PREVIEW_CLASS: Record<number, string> = {
  11: 'text-[10px]',
  14: 'text-[12px]',
  18: 'text-[15px]',
};

export const ControlDeck: React.FC<ControlDeckProps> = ({
  vehicle,
  onSelectVehicle,
  plate,
  onUpdatePlate,
  onSaveProject,
  onLoadProject,
  onAddItem,
  onRotateSelected,
  onDeleteSelected,
  onClearAll,
  onUpdateItemProperties,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onAddBatch,
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
  // Accordion multifunzione del catalogo colli: al massimo un cassetto aperto.
  const [openPalletCode, setOpenPalletCode] = useState<string | null>(null);
  // Bozze di carico a lotti, una per formato (quantità, cliente/lotto, tinta).
  const [batchDrafts, setBatchDrafts] = useState<Record<string, PalletBatchDraft>>({});

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

  /* --- Salva & Apri Piano (.json) ----------------------------------------- */
  // Feedback verde "Salvato!" sul pulsante di salvataggio (2 secondi).
  const [isProjectSaved, setIsProjectSaved] = useState<boolean>(false);
  const saveFeedbackTimer = useRef<number | null>(null);
  // Selettore file nativo del sistema operativo: aperto dal pulsante "Apri Piano".
  const projectInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(
    () => () => {
      if (copyFeedbackTimer.current !== null) window.clearTimeout(copyFeedbackTimer.current);
      if (saveFeedbackTimer.current !== null) window.clearTimeout(saveFeedbackTimer.current);
    },
    []
  );

  /** Salva il piano di carico come file `.json` e mostra il feedback "Salvato!". */
  const handleSaveProject = () => {
    onSaveProject();
    setIsProjectSaved(true);
    if (saveFeedbackTimer.current !== null) window.clearTimeout(saveFeedbackTimer.current);
    saveFeedbackTimer.current = window.setTimeout(
      () => setIsProjectSaved(false),
      SAVE_FEEDBACK_MS
    );
  };

  /** Apre il selettore file nativo del sistema operativo. */
  const handleOpenProjectPicker = () => {
    projectInputRef.current?.click();
  };

  /**
   * Ripristina il piano di carico scelto: il file viene convalidato da
   * `parseProjectFile` e, in caso di file corrotto o di formato estraneo,
   * l'operatore riceve un avviso chiaro senza che lo stato in scena cambi.
   */
  const handleProjectFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Il campo viene svuotato subito: lo stesso file resta riselezionabile.
    event.target.value = '';
    if (!file) return;

    try {
      const project = await parseProjectFile(file);
      onLoadProject(project);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Impossibile aprire il piano di carico selezionato.';
      window.alert(`Apertura del piano non riuscita.\n\n${message}`);
    }
  };

  /**
   * Esporta il pianale in PNG: copia negli appunti di sistema e, se il browser
   * nega l'accesso, scarica automaticamente `piano-di-carico.png`.
   * Il pulsante mostra l'esito ("Copiato!" / "PNG salvato") per 2,5 secondi.
   */
  const handleCopyImage = async () => {
    if (isCopying) return;
    setIsCopying(true);

    const copied = await copyCanvasToClipboard(vehicle, items, labelDensity, notes, plate);

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
   * - `x`: `vehicle.width + NOTE_LANE_OFFSET_CM` — nasce subito a **destra della
   *   parete** del semirimorchio (poi è libera di andare ovunque in 2D);
   * - `y`: quota minima Y della selezione (la nota si allinea alla loro altezza),
   *   scorrita verso il basso solo se una card esistente occupa già quello spazio;
   * - `content`: pre-popolato col nome del primo collo (es. `"PRODIVA 3S - "`),
   *   già pronto per essere completato con l'avvertenza operativa;
   * - `color`: l'esatto pastello di riempimento del collo selezionato;
   * - `borderColor`: metadato storico `#94A3B8` (la card è senza bordo a riposo),
   *   `width`: 140 cm, `fontSize`: 14 px (taglia "Media" della scala 11/14/18).
   */
  const handleAddSideNote = () => {
    if (selectedItems.length === 0) return;

    const anchor = selectedItems[0];
    const draft: Omit<SideNote, 'id'> = {
      x: vehicle.width + NOTE_LANE_OFFSET_CM,
      y: Math.min(...selectedItems.map((item) => item.y)),
      content: buildNoteSeedText(anchor.name) || DEFAULT_NOTE_CONTENT,
      color: anchor.color,
      borderColor: NOTE_BORDER_COLOR,
      width: NOTE_DEFAULT_WIDTH_CM,
      fontSize: NOTE_DEFAULT_FONT_SIZE,
    };

    // Spawn ordinato: se un'altra nota occupa già quello spazio, la nuova card
    // scende di poco invece di sovrapporsi (le note esistenti non si muovono).
    onAddNote({
      ...draft,
      y: findFreeNoteY(notes, { x: draft.x, y: draft.y }, draft),
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

  /* ------------------------------------------------------------------------ *
   *  ACCORDION MULTIFUNZIONE DEL CATALOGO COLLI
   *
   *  Ogni riga di formato è una fisarmonica: a riposo (36 px) mostra la sola
   *  intestazione con i due micro-pulsanti di inserimento singolo, mentre il
   *  click sulla riga espande il cassetto del caricamento a lotti (quantità,
   *  cliente/lotto, tinta e i due pulsanti di stiva massiva first-fit).
   * ------------------------------------------------------------------------ */

  /** Quantità effettiva del lotto: sempre intera e dentro i limiti 1–99. */
  const clampBatchQuantity = (value: number): number => {
    const safe = Number.isFinite(value) ? Math.floor(value) : BATCH_DEFAULT_QUANTITY;
    return Math.max(BATCH_MIN_QUANTITY, Math.min(BATCH_MAX_QUANTITY, safe));
  };

  /** Bozza corrente del formato: valori di fabbrica se mai toccato. */
  const batchDraftFor = (pallet: PalletDefinition): PalletBatchDraft =>
    batchDrafts[pallet.code] ?? {
      quantity: BATCH_DEFAULT_QUANTITY,
      name: '',
      color: pallet.color,
    };

  /** Patch immutabile della bozza di un formato (quantità, cliente o tinta). */
  const updateBatchDraft = (
    pallet: PalletDefinition,
    updates: Partial<PalletBatchDraft>
  ) => {
    setBatchDrafts((prev) => ({
      ...prev,
      [pallet.code]: { ...batchDraftFor(pallet), ...updates },
    }));
  };

  /** Apre/chiude il cassetto: al massimo un formato per volta resta espanso. */
  const togglePalletDrawer = (code: string) => {
    setOpenPalletCode((prev) => (prev === code ? null : code));
  };

  /** Passa il lotto al motore batch first-fit di `App.tsx`. */
  const handleAddBatch = (pallet: PalletDefinition, orientation: LoadOrientation) => {
    const draft = batchDraftFor(pallet);
    onAddBatch(
      pallet,
      clampBatchQuantity(draft.quantity),
      orientation,
      draft.name.trim() || undefined,
      draft.color
    );
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
    <div className="control-deck print:hidden w-full h-full bg-white border-l border-slate-200 flex flex-col p-5 overflow-y-auto [scrollbar-gutter:stable] space-y-6">
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

      {/* Backup, ripristino e condivisione del lavoro: salva il piano di carico
          in un file `.json` e riapre un piano salvato in precedenza. */}
      <div className="grid grid-cols-2 gap-2 mt-2">
        <button
          type="button"
          id="btn-save-project"
          onClick={handleSaveProject}
          aria-live="polite"
          title="Salva il piano di carico in un file .json (backup, condivisione, riapertura)"
          className="bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 py-1.5 px-2 rounded flex items-center justify-center gap-1.5 transition cursor-pointer"
        >
          <Download className="w-3.5 h-3.5 shrink-0" />
          <span
            className={`text-xs font-semibold truncate ${
              isProjectSaved ? 'text-green-600' : ''
            }`}
          >
            {isProjectSaved ? 'Salvato!' : 'Salva Piano'}
          </span>
        </button>

        <button
          type="button"
          id="btn-open-project"
          onClick={handleOpenProjectPicker}
          title="Apri un piano di carico salvato in precedenza (file .json)"
          className="bg-slate-50 hover:bg-slate-100 border border-slate-200 text-slate-700 py-1.5 px-2 rounded flex items-center justify-center gap-1.5 transition cursor-pointer"
        >
          <FolderOpen className="w-3.5 h-3.5 shrink-0 text-blue-600" />
          <span className="text-xs font-semibold text-slate-800 truncate">Apri Piano</span>
        </button>

        {/* Selettore file nativo del sistema operativo, invisibile: pilotato dal
            pulsante "Apri Piano" e convalidato da `parseProjectFile`. */}
        <input
          ref={projectInputRef}
          id="project-file-input"
          type="file"
          accept=".json,application/json"
          onChange={handleProjectFileChange}
          className="hidden"
        />
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

        {/* Targa: titolo ufficiale di macro-sezione, identico nello stile a
            "Configurazione Mezzo" e "Aggiungi Colli". Il campo è pulito a riposo
            (nessun placeholder) e il valore viene riportato in maiuscolo sul
            testo sopra la Cabina, nello snapshot PNG e nell'intestazione della
            scheda di carico A4. */}
        <div className="space-y-1">
          <label
            htmlFor={PLATE_INPUT_ID}
            className="text-xs font-bold text-slate-700 uppercase tracking-wider"
          >
            Targa
          </label>
          <input
            id={PLATE_INPUT_ID}
            type="text"
            value={plate}
            onChange={(e) => onUpdatePlate(e.target.value.toUpperCase())}
            placeholder=""
            maxLength={PLATE_MAX_LENGTH}
            className="w-full bg-slate-50 border border-slate-300 text-slate-800 text-xs font-mono font-bold rounded p-1.5 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-500 uppercase tracking-wide"
          />
        </div>
      </div>

      {/* Catalogo Colli — accordion multifunzione (click singolo + lotti) */}
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
            Aggiungi Colli
          </label>
          <div className="flex items-center gap-1.5">
            {/* Pulsante Undo (Solo Icona) */}
            <button
              type="button"
              id="btn-undo"
              onClick={onUndo}
              disabled={!canUndo}
              title="Annulla (Ctrl / Cmd + Z)"
              className={`p-1 rounded transition ${
                !canUndo
                  ? 'text-slate-300 opacity-40 cursor-not-allowed'
                  : 'text-slate-600 hover:text-blue-600 hover:bg-slate-100 cursor-pointer'
              }`}
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>

            {/* Pulsante Redo (Solo Icona) */}
            <button
              type="button"
              id="btn-redo"
              onClick={onRedo}
              disabled={!canRedo}
              title="Ripristina (Ctrl / Cmd + Y)"
              className={`p-1 rounded transition ${
                !canRedo
                  ? 'text-slate-300 opacity-40 cursor-not-allowed'
                  : 'text-slate-600 hover:text-blue-600 hover:bg-slate-100 cursor-pointer'
              }`}
            >
              <Redo2 className="w-3.5 h-3.5" />
            </button>

            {/* Separatore sottile */}
            <span className="w-px h-3.5 bg-slate-200 mx-0.5" />

            {/* Pulsante Svuota esistente */}
            <button
              type="button"
              id="btn-clear-all"
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
        </div>
        <div className="space-y-1">
          {PALLET_CATALOG.filter((p) => !p.isBulk).map((pallet) => {
            // Punta = lato corto verso le porte, Piatto = lato lungo verso le porte.
            const shortSide = Math.min(pallet.width, pallet.length);
            const longSide = Math.max(pallet.width, pallet.length);
            const isOpen = openPalletCode === pallet.code;
            const draft = batchDraftFor(pallet);
            const batchQty = clampBatchQuantity(draft.quantity);

            return (
              <div
                key={pallet.code}
                className="bg-white border border-slate-200 rounded overflow-hidden hover:border-slate-300 transition-colors"
              >
                {/* Riga intestazione compatta (36 px): accordion + click singolo */}
                <div className="flex items-center justify-between gap-1 p-1.5 px-2.5 min-h-9">
                  <button
                    type="button"
                    id={`pallet-row-${pallet.code}`}
                    onClick={() => togglePalletDrawer(pallet.code)}
                    aria-expanded={isOpen}
                    aria-controls={`pallet-batch-${pallet.code}`}
                    title={
                      isOpen
                        ? `Comprimi il carico a lotti di ${pallet.name}`
                        : `Espandi il carico a lotti di ${pallet.name}`
                    }
                    className="flex flex-1 items-center gap-1.5 min-w-0 text-left rounded transition hover:opacity-80"
                  >
                    {isOpen ? (
                      <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    )}
                    <span
                      className="w-3 h-3 rounded-sm border shrink-0"
                      style={{ backgroundColor: pallet.color, borderColor: pallet.borderColor }}
                    />
                    <span className="text-xs font-bold text-slate-800 tracking-tight truncate">
                      {pallet.name}
                    </span>
                  </button>

                  {/* Comandi rapidi: 1 collo al volo, senza aprire il cassetto */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {pallet.rotatable && (
                      <button
                        type="button"
                        id={`quick-piatto-${pallet.code}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onAddItem(pallet, { width: longSide, length: shortSide, rotation: 90 });
                        }}
                        title={`Aggiungi 1 collo di Piatto (${longSide}×${shortSide} cm)`}
                        className="flex items-center gap-1 px-2 py-1 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-400 rounded transition"
                      >
                        <ArrowLeftRight className="w-3 h-3 text-slate-500" />
                        <span className="text-[10px] leading-none text-slate-700 font-semibold">
                          Piatto
                        </span>
                      </button>
                    )}

                    <button
                      type="button"
                      id={`quick-punta-${pallet.code}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddItem(pallet, { width: shortSide, length: longSide, rotation: 0 });
                      }}
                      title={`Aggiungi 1 collo di Punta (${shortSide}×${longSide} cm)`}
                      className="flex items-center gap-1 px-2 py-1 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-400 rounded transition"
                    >
                      <ArrowUpDown className="w-3 h-3 text-slate-500" />
                      <span className="text-[10px] leading-none text-slate-700 font-semibold">
                        Punta
                      </span>
                    </button>
                  </div>
                </div>

                {/* Cassetto espanso: caricamento a lotti (first-fit Cabina → Porte) */}
                {isOpen && (
                  <div
                    id={`pallet-batch-${pallet.code}`}
                    className="bg-slate-50 border border-slate-200 rounded p-2.5 space-y-2 mt-1 mx-1.5 mb-1.5"
                  >
                    {/* Riga superiore: quantità e cliente / nome lotto */}
                    <div className="flex items-end gap-2">
                      <label className="shrink-0 space-y-1">
                        <span className="block text-[10px] font-bold text-slate-500 uppercase">
                          Q.tà
                        </span>
                        <input
                          type="number"
                          id={`batch-qty-${pallet.code}`}
                          min={BATCH_MIN_QUANTITY}
                          max={BATCH_MAX_QUANTITY}
                          step={1}
                          value={draft.quantity}
                          onChange={(e) =>
                            updateBatchDraft(pallet, { quantity: Number(e.target.value) })
                          }
                          title="Numero di colli da stivare in un solo lotto"
                          className="w-16 bg-white border border-slate-300 text-xs rounded p-1 font-mono text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </label>

                      <label className="flex-1 min-w-0 space-y-1">
                        <span className="block text-[10px] font-bold text-slate-500 uppercase">
                          Cliente / Lotto
                        </span>
                        <input
                          type="text"
                          id={`batch-name-${pallet.code}`}
                          value={draft.name}
                          onChange={(e) => updateBatchDraft(pallet, { name: e.target.value })}
                          placeholder="Es. CONAD"
                          className="w-full bg-white border border-slate-300 text-xs rounded p-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                      </label>
                    </div>

                    {/* Riga intermedia: matrice colori 7 × 3 per la tinta del lotto */}
                    <div className="flex items-start gap-1.5">
                      <span className="shrink-0 text-[10px] font-bold text-slate-500 uppercase leading-4">
                        Colore
                      </span>
                      {renderColorMatrix(
                        draft.color,
                        (hex) => updateBatchDraft(pallet, { color: hex }),
                        `Colore lotto ${pallet.name}`
                      )}
                    </div>

                    {/* Riga inferiore: stiva massiva di Piatto o di Punta */}
                    <div className="flex gap-2">
                      {pallet.rotatable && (
                        <button
                          type="button"
                          id={`batch-add-piatto-${pallet.code}`}
                          onClick={() => handleAddBatch(pallet, 'piatto')}
                          title={`Stiva ${batchQty} colli di Piatto (${longSide}×${shortSide} cm) dalla Cabina verso le Porte`}
                          className="flex-1 bg-white hover:bg-blue-50 border border-slate-300 hover:border-blue-400 text-slate-800 text-xs font-semibold py-1.5 rounded flex items-center justify-center gap-1 transition shadow-sm"
                        >
                          <ArrowLeftRight className="w-3.5 h-3.5 text-slate-500" />
                          <span className="truncate">+ {batchQty} di Piatto</span>
                        </button>
                      )}

                      <button
                        type="button"
                        id={`batch-add-punta-${pallet.code}`}
                        onClick={() => handleAddBatch(pallet, 'punta')}
                        title={`Stiva ${batchQty} colli di Punta (${shortSide}×${longSide} cm) dalla Cabina verso le Porte`}
                        className="flex-1 bg-white hover:bg-blue-50 border border-slate-300 hover:border-blue-400 text-slate-800 text-xs font-semibold py-1.5 rounded flex items-center justify-center gap-1 transition shadow-sm"
                      >
                        <ArrowUpDown className="w-3.5 h-3.5 text-slate-500" />
                        <span className="truncate">+ {batchQty} di Punta</span>
                      </button>
                    </div>
                  </div>
                )}
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
              X {selectedNote.x.toFixed(1)} · Y {selectedNote.y.toFixed(1)} cm
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

          {/* Dimensione del testo: i tre corpi della scala ufficiale (11/14/18 px). */}
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
                    <span className={NOTE_FONT_PREVIEW_CLASS[size]}>
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
              <span className="text-slate-300">Annulla</span>
              <kbd className="bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-200">Ctrl / Cmd + Z</kbd>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-300">Ripristina</span>
              <kbd className="bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-200">Ctrl / Cmd + Y</kbd>
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