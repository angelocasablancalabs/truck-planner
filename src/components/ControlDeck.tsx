import React, { useEffect, useRef, useState } from 'react';
import type {
  VehicleConfig,
  PlacedItem,
  PalletDefinition,
  AddItemOptions,
  LabelDensity,
  ProjectFile,
  DeckBay,
} from '../types';
import {
  VEHICLE_PRESETS,
  PALLET_CATALOG,
  CUSTOM_PALLET,
  COLOR_FAMILIES,
  MAX_BAYS,
} from '../constants';
import type { ColorFamily } from '../constants';
import { calculateLdmMetrics } from '../utils/snapping';
import { canDeleteBay } from '../utils/bays';
import { copyCanvasToClipboard } from '../utils/export';
import { PLATE_INPUT_ID, PLATE_MAX_LENGTH } from '../utils/plateBadge';
import {
  isOpenPickerSupported,
  isPickerAbortError,
  openProjectWithPicker,
  parseProjectFile,
} from '../utils/fileStorage';
import {
  Truck,
  Trash2,
  Plus,
  Info,
  ArrowUpDown,
  ArrowLeftRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Check,
  Download,
  Save,
  SaveAll,
  FolderOpen,
  FilePlus,
  Undo2,
  Redo2,
} from 'lucide-react';

/** Stampante con riquadro immagine ad alto contrasto sul foglio superiore (Solo Grafica) */
const PrinterGraphicIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
    focusable="false"
  >
    {/* Foglio superiore con riquadro/foto geometrica ben visibile */}
    <polyline points="6 9 6 2 18 2 18 9" />
    <rect x="8.5" y="3.5" width="7" height="4.5" rx="0.5" fill="currentColor" stroke="none" />
    {/* Corpo stampante */}
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    {/* Vassoio inferiore pulito */}
    <rect x="6" y="14" width="12" height="8" />
  </svg>
);

/** Stampante con 3 righe orizzontali di testo sul foglio superiore (Scheda Completa) */
const PrinterReportIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
    focusable="false"
  >
    {/* Foglio superiore con 3 righe di testo evidenti */}
    <polyline points="6 9 6 2 18 2 18 9" />
    <line x1="8.5" y1="3.5" x2="15.5" y2="3.5" stroke="currentColor" strokeWidth="1.5" />
    <line x1="8.5" y1="5.5" x2="15.5" y2="5.5" stroke="currentColor" strokeWidth="1.5" />
    <line x1="8.5" y1="7.5" x2="13" y2="7.5" stroke="currentColor" strokeWidth="1.5" />
    {/* Corpo stampante */}
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    {/* Vassoio inferiore con riga di documento */}
    <rect x="6" y="14" width="12" height="8" />
    <line x1="9" y1="18" x2="15" y2="18" />
  </svg>
);

/** Esito dell'ultima esportazione immagine (feedback temporaneo sul pulsante). */
type CopyFeedback = 'idle' | 'copied' | 'downloaded';

/** Durata (ms) del feedback verde "Copiato!" sul pulsante di esportazione. */
const COPY_FEEDBACK_MS = 2500;

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
 * ID del foglio temporaneo `@page` iniettato in `<head>` durante la stampa:
 * fissa l'orientamento della carta alla modalità scelta (panoramico per la sola
 * grafica, verticale per la scheda tecnica) e viene sempre rimosso a fine stampa.
 */
const PRINT_PAGE_STYLE_ID = 'print-page-orientation';

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
  /**
   * **Flotta** della centrale multi-pianale (da 1 a `MAX_BAYS` mezzi affiancati
   * nello stesso canvas e nello stesso file JSON). La sidebar mostra il
   * selettore a pillole per passare da un mezzo all'altro e il totale di flotta;
   * tutti i comandi qui sotto agiscono sul **Mezzo Attivo**.
   */
  bays: DeckBay[];
  /** ID del Mezzo Attivo (lo stallo comandato da questa plancia). */
  activeBayId: string;
  /** Cambio del Mezzo Attivo (click su una pillola). */
  onSelectBay: (bayId: string) => void;
  /** Aggiunge un mezzo alla centrale (disabilitato al raggiungimento di `MAX_BAYS`). */
  onAddBay: () => void;
  /**
   * **Clona il mezzo attivo** ("camion gemello"): crea un nuovo stallo identico
   * a quello indicato — stessa configurazione veicolo, stessa targa con suffisso
   * ` (copia)`, copia profonda di tutti i colli e di tutte le note con ID
   * rigenerati — e lo rende subito il Mezzo Attivo (un solo passo di Undo).
   */
  onCloneBay: (bayId: string) => void;
  /**
   * **Riordino degli stalli**: scambia lo stallo indicato con quello adiacente
   * (`left` = verso l'inizio della flotta, `right` = verso la fine). Gli offset
   * del mondo si riallineano da soli (`bayOffsets`) e l'operazione vale un solo
   * passo di Undo.
   */
  onReorderBay: (bayId: string, direction: 'left' | 'right') => void;
  /** Elimina un mezzo dalla centrale (disabilitato sull'ultimo rimasto). */
  onDeleteBay: (bayId: string) => void;
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
   * (unica fonte dello stato) e ricaricato con la stessa callback.
   *
   * `onSaveProject` risolve con il nome del file salvato (per il feedback
   * `Salvato!` e il tooltip del pulsante) oppure con `null` se il salvataggio è
   * stato annullato dal selettore nativo o è fallito.
   * `onLoadProject` riceve anche l'**handle** della File System Access API (o
   * `null` col selettore classico) e il nome del file: da lì in avanti
   * `Ctrl / Cmd + S` riscrive in-place quel file.
   */
  onSaveProject: () => Promise<{ fileName: string; isNewFile: boolean } | null>;
  /**
   * **"Salva con nome"**: salva il piano su un nuovo file anche quando un file
   * attivo è già agganciato (selettore nativo `showSaveFilePicker`, o download
   * di una nuova copia sui browser che non lo supportano). Il risultato è già
   * riflesso nello stato di `App.tsx` (badge del file attivo e feedback
   * `Salvato!`), quindi la plancia non ne ha bisogno: `null` = annullato.
   */
  onSaveProjectAs: () => Promise<{ fileName: string; isNewFile: boolean } | null>;
  onLoadProject: (
    project: ProjectFile,
    handle: FileSystemFileHandle | null,
    fileName: string
  ) => void;
  /** Nome del file attivo mostrato in sidebar (`null` = nessun file agganciato). */
  activeFileName: string | null;
  /**
   * Feedback `Salvato!` (acceso per 2 s dal motore di `App.tsx`, perché il
   * salvataggio arriva sia dal pulsante sia dalla scorciatoia `Ctrl / Cmd + S`)
   * e nome dell'ultimo file salvato, mostrato nel tooltip del pulsante.
   */
  isProjectSaved: boolean;
  savedFileName: string | null;
  onAddItem: (pallet: PalletDefinition, options?: AddItemOptions) => void;
  onClearAll: () => void;
  /** Avvia un nuovo piano di carico azzerando tutto. */
  onNewProject: () => void;
  /** Indica se sono presenti modifiche non ancora salvate su disco. */
  hasUnsavedChanges?: boolean;
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
  /**
   * Colli del **Mezzo Attivo**: alimentano il riepilogo di stiva e i comandi
   * rapidi della plancia (lo snapshot PNG legge l'intera flotta da `bays`).
   */
  items: PlacedItem[];
  /** Densità etichette attiva: viene applicata anche allo snapshot esportato. */
  labelDensity: LabelDensity;
  /** ID dei colli attualmente selezionati sul pianale. */
  selectedItemIds?: string[];
  /** ID della nota laterale attualmente selezionata, se presente. */
  selectedNoteId?: string | null;
}

export const ControlDeck: React.FC<ControlDeckProps> = ({
  bays,
  activeBayId,
  onSelectBay,
  onAddBay,
  onCloneBay,
  onReorderBay,
  onDeleteBay,
  vehicle,
  onSelectVehicle,
  plate,
  onUpdatePlate,
  onSaveProject,
  onSaveProjectAs,
  onLoadProject,
  activeFileName,
  isProjectSaved,
  savedFileName,
  onAddItem,
  onClearAll,
  onNewProject,
  hasUnsavedChanges,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onAddBatch,
  items,
  labelDensity,
  selectedItemIds,
  selectedNoteId,
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

  // Chiude automaticamente qualsiasi cassetto aperto nel catalogo non appena
  // l'utente seleziona uno o più colli o una nota sul pianale, evitando la
  // duplicazione visiva della palette colori tra sidebar e floating HUD.
  useEffect(() => {
    const hasSelection = (selectedItemIds && selectedItemIds.length > 0) || Boolean(selectedNoteId);
    if (hasSelection) {
      setOpenPalletCode(null);
      setIsBulkOpen(false);
      setIsCustomOpen(false);
    }
  }, [selectedItemIds, selectedNoteId]);

  // --- Condivisione & Output (Sprint D) -----------------------------------
  // Esito dell'ultima esportazione: alimenta il feedback temporaneo del pulsante.
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>('idle');
  const [isCopying, setIsCopying] = useState<boolean>(false);
  // Timer di reset del feedback: si spegne da solo dopo 2,5 secondi.
  const copyFeedbackTimer = useRef<number | null>(null);

  /* --- Salva & Apri Piano (.json) ----------------------------------------- */
  // Selettore file classico (fallback sui browser senza File System Access API):
  // aperto dal pulsante "Apri Piano".
  const projectInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(
    () => () => {
      if (copyFeedbackTimer.current !== null) window.clearTimeout(copyFeedbackTimer.current);
    },
    []
  );

  /** Salva il piano di carico: il feedback `Salvato!` è acceso da `App.tsx`. */
  const handleSaveProject = () => {
    void onSaveProject();
  };

  /**
   * Protezione antipanico: prima di **sostituire** il piano in scena (nuovo
   * piano o apertura di un file) verifica che non ci siano modifiche non ancora
   * scritte su disco. Restituisce `true` quando l'operazione può procedere —
   * nessuna modifica in sospeso oppure conferma esplicita dell'operatore.
   */
  const confirmDiscardUnsaved = (): boolean => {
    if (!hasUnsavedChanges) return true;
    return window.confirm(
      'Ci sono modifiche non salvate sul piano corrente.\nVuoi aprire un altro file e perdere le modifiche non salvate?'
    );
  };

  /**
   * Apre un piano di carico.
   *
   * Con la File System Access API (Chrome / Edge) si usa il selettore nativo
   * `showOpenFilePicker`, che restituisce anche l'**handle** del file: è ciò che
   * abilita il salvataggio in-place successivo. Sui browser che non la supportano
   * si ricade **trasparentemente** sul selettore file classico (`<input type="file">`).
   * Se l'operatore annulla la finestra nativa (`AbortError`) non succede nulla.
   */
  const handleOpenProjectPicker = async () => {
    // Antipanico: nessun file viene aperto (e nessuna finestra di sistema si
    // apre) se l'operatore rinuncia a perdere le modifiche non salvate.
    if (!confirmDiscardUnsaved()) return;

    if (!isOpenPickerSupported()) {
      // Fallback trasparente: selettore file classico del sistema operativo.
      projectInputRef.current?.click();
      return;
    }

    try {
      const opened = await openProjectWithPicker();
      onLoadProject(opened.project, opened.handle, opened.fileName);
    } catch (error) {
      // Annullamento volontario del selettore: esce silenziosamente.
      if (isPickerAbortError(error)) return;

      const message =
        error instanceof Error ? error.message : 'Impossibile aprire il piano di carico selezionato.';
      window.alert(`Apertura del piano non riuscita.\n\n${message}`);
    }
  };

  /**
   * Ripristina il piano di carico scelto dal **selettore classico** (browser
   * senza File System Access API): il file viene convalidato da `parseProjectFile`
   * e, in caso di file corrotto o di formato estraneo, l'operatore riceve un
   * avviso chiaro senza che lo stato in scena cambi. Senza handle nativo il
   * salvataggio successivo resta quello del download classico.
   */
  const handleProjectFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Il campo viene svuotato subito: lo stesso file resta riselezionabile.
    event.target.value = '';
    if (!file) return;

    // Antipanico: la lettura del file — e quindi la sostituzione del piano in
    // scena — parte solo dopo la conferma dell'operatore.
    if (!confirmDiscardUnsaved()) return;

    try {
      const project = await parseProjectFile(file);
      onLoadProject(project, null, file.name);
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

    const copied = await copyCanvasToClipboard(bays, labelDensity);

    setIsCopying(false);
    setCopyFeedback(copied ? 'copied' : 'downloaded');

    if (copyFeedbackTimer.current !== null) window.clearTimeout(copyFeedbackTimer.current);
    copyFeedbackTimer.current = window.setTimeout(() => setCopyFeedback('idle'), COPY_FEEDBACK_MS);
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

  // Calcolo statistiche veloci del **Mezzo Attivo**
  const countsByCode = items.reduce((acc, curr) => {
    acc[curr.name] = (acc[curr.name] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  /* --- Totale Flotta (centrale multi-pianale) ------------------------------ */
  /**
   * Riepilogo complessivo della centrale: colli e metri lineari di **tutti** i
   * mezzi, calcolati con la stessa funzione pura che alimenta canvas, snapshot
   * PNG e scheda di stampa (`calculateLdmMetrics`, Regola della Corsia di
   * Parete). Il totale vive in fondo al "Riepilogo Stiva" e compare solo quando
   * in centrale c'è più di un mezzo.
   */
  const totalFleetItems = bays.reduce((sum, bay) => sum + bay.items.length, 0);
  const totalFleetLdm = bays.reduce(
    (sum, bay) => sum + calculateLdmMetrics(bay.vehicle, bay.items).maxOccupiedY,
    0
  );

  /**
   * Etichetta accessibile (`sr-only`), icona e stile del pulsante "Copia
   * Immagine": la toolbar è a sole icone, quindi l'esito dell'esportazione
   * resta leggibile da screen reader e dai tooltip.
   */
  const copyLabel =
    copyFeedback === 'copied'
      ? 'Copiato!'
      : copyFeedback === 'downloaded'
        ? 'PNG salvato'
        : 'Copia Immagine';
  const CopyIcon = copyFeedback === 'copied' ? Check : copyFeedback === 'downloaded' ? Download : Copy;
  const copyTooltip =
    copyFeedback === 'copied'
      ? 'Immagine copiata negli appunti!'
      : copyFeedback === 'downloaded'
        ? 'Appunti non disponibili: immagine PNG scaricata nella cartella Download'
        : 'Copia immagine negli appunti (PNG per WhatsApp o Mail)';
  /**
   * Contenitore del pulsante "Copia Immagine": identico agli altri cinque della
   * toolbar (`bg-white hover:bg-slate-50 border-slate-200`), con l'accento
   * **solo** negli esiti dinamici — verde quando l'immagine è negli appunti,
   * ambra quando il browser ha negato l'accesso e il PNG è stato scaricato.
   */
  const clipboardButtonClass =
    copyFeedback === 'copied'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
      : copyFeedback === 'downloaded'
        ? 'border-amber-300 bg-amber-50 text-amber-700'
        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900';
  /**
   * Tinta dell'icona di "Copia Immagine": a riposo è l'**ardesia istituzionale**
   * condivisa dalle altre cinque icone della toolbar (`text-slate-600`, hover
   * `hover:text-slate-900`); solo gli esiti dinamici accendono un accento —
   * verde quando l'immagine è negli appunti, ambra quando è stato necessario
   * scaricare il PNG perché il browser ha negato l'accesso agli appunti.
   */
  const clipboardIconClass =
    copyFeedback === 'copied'
      ? 'text-emerald-600'
      : copyFeedback === 'downloaded'
        ? 'text-amber-600'
        : 'text-slate-600 hover:text-slate-900';

  /**
   * **Stampa nativa del browser pilotata da modalità** (nessun raster JPEG, nessuna
   * libreria PDF esterna).
   *
   * L'attributo `data-print-mode` posto su `<html>` seleziona il sottoinsieme di
   * regole `@media print` di `src/index.css` e quindi il contenuto del foglio:
   *   - `'clean'` → **solo la grafica** della centrale (tutti i pianali affiancati
   *     su un unico foglio A4): il dialogo di stampa del browser può essere
   *     salvato come PDF **vettoriale puro da 20–40 KB**, nitido al 100% a
   *     qualunque zoom, oppure inviato a una stampante fisica;
   *   - `'full'`  → la **scheda tecnica A4 completa** (`PrintReport`), con una
   *     pagina per ciascun mezzo: intestazione formale, targa e riepilogo colli.
   *
   * L'**orientamento del foglio** segue il contenuto reale: **verticale** per la
   * scheda tecnica e per la sola grafica di **1 o 2 mezzi** (basta l'altezza del
   * foglio), **panoramico** solo con **3 mezzi** in centrale, dove i pianali
   * affiancati hanno bisogno della larghezza. Non potendo esprimere questa
   * differenza con un selettore CSS (nelle regole `@page` è ammessa la sola
   * pseudo-classe `:root`), la regola viene iniettata in `<head>` per la durata
   * della stampa e rimossa all'evento `afterprint` insieme agli attributi
   * `data-print-mode` e `data-print-landscape`.
   *
   * Il documento è identico a prima della stampa: l'attributo e il foglio
   * temporaneo vengono rimossi alla chiusura del dialogo (annullamento compreso),
   * così lo schermo non resta mai in stato "di stampa".
   */
  const triggerPrint = (mode: 'clean' | 'full') => {
    const originalTitle = document.title;
    // Assegna un titolo parlante per la stampa: driver PDF e "Salva come PDF"
    // lo useranno come nome file di default al posto del dominio del sito.
    const cleanPlate = (bays[0]?.plate || '').trim().replace(/[^a-zA-Z0-9]/g, '_');
    document.title = cleanPlate ? `piano-${cleanPlate}` : 'piano-di-carico';

    /**
     * Foglio temporaneo della stampa: **A4 verticale** per la scheda tecnica
     * (una pagina per mezzo) e per la sola grafica di **1 o 2 mezzi**; **A4
     * panoramico** quando la centrale schiera **3 mezzi**, l'unico caso in cui il
     * disegno affiancato ha bisogno della larghezza del foglio. L'ID è unico e il
     * tag viene sempre rimosso a fine stampa.
     */
    const isLandscape = mode === 'clean' && bays.length >= 3;
    const pageStyle = document.createElement('style');
    pageStyle.id = PRINT_PAGE_STYLE_ID;
    pageStyle.textContent = `@page { size: A4 ${isLandscape ? 'landscape' : 'portrait'}; margin: 0; }`;
    document.getElementById(PRINT_PAGE_STYLE_ID)?.remove();
    document.head.appendChild(pageStyle);

    document.documentElement.setAttribute('data-print-mode', mode);
    if (isLandscape) {
      document.documentElement.setAttribute('data-print-landscape', 'true');
    }
    window.print();
    window.addEventListener(
      'afterprint',
      () => {
        document.title = originalTitle;
        document.documentElement.removeAttribute('data-print-mode');
        document.documentElement.removeAttribute('data-print-landscape');
        document.getElementById(PRINT_PAGE_STYLE_ID)?.remove();
      },
      { once: true }
    );
  };

  return (
    <div className="control-deck print:hidden w-full h-full bg-white border-l border-slate-200 flex flex-col p-4 overflow-y-auto [scrollbar-gutter:stable] space-y-3.5">
      {/* Header con Titolo (col-span-2) e Pulsante "Nuovo" (col-span-1, allineato al pixel) */}
      <div className="grid grid-cols-3 gap-1.5 items-center border-b border-slate-200 pb-2">
        <div className="col-span-2 min-w-0 pr-1">
          <h1 className="text-lg font-black text-slate-800 tracking-tight flex items-center gap-1.5 truncate">
            <Truck className="w-5 h-5 text-blue-600 shrink-0" />
            <span className="truncate">TRUCK PLANNER</span>
          </h1>
          <p className="text-[11px] text-slate-500 font-medium truncate">
            Gestione Carico CAD Vettoriale
          </p>
        </div>

        <button
          type="button"
          id="btn-new-project"
          onClick={onNewProject}
          title="Nuovo Piano (azzera tutto e ripristina mezzo di default)"
          className="col-span-1 h-9 flex items-center justify-center gap-1.5 rounded border bg-white hover:bg-slate-50 border-slate-200 text-slate-700 hover:text-slate-900 transition cursor-pointer shadow-xs font-semibold text-xs"
        >
          <FilePlus className="w-4 h-4 text-slate-600 shrink-0" />
          <span className="truncate">Nuovo</span>
        </button>
      </div>

      {/* --- Toolbar Comandi: 2 righe × 3 colonne a sole icone --------------- *
       *  Riga 1 · Gestione File `.json`: salvataggio in-place (`Ctrl / Cmd + S`),
       *  "Salva con nome" su una nuova copia e apertura di un piano `.json`.
       *  Riga 2 · Output & Condivisione: copia dell'immagine negli appunti (PNG
       *  per WhatsApp / Mail), stampa nativa della **sola grafica** (PDF
       *  vettoriale leggero, senza intestazione né totali) e stampa della
       *  **scheda tecnica A4 completa**.
       *  Ogni pulsante è una sola icona da 16 px: il testo descrittivo vive nel
       *  `title` (tooltip esaustivo) e in uno `span.sr-only` per gli screen
       *  reader — nessuna etichetta visibile, larghezza uniforme su 3 colonne.
       *  **Colori uniformi**: tutte e sei le icone condividono l'ardesia
       *  istituzionale `text-slate-600` con hover `hover:text-slate-900`;
       *  l'unico accento cromatico ammesso è il **feedback dinamico** — verde
       *  `text-emerald-600` su `Copia Immagine` (immagine copiata) e su `Salva`
       *  (piano scritto su disco). I due comandi di stampa si distinguono dalla
       *  **sola forma dell'icona** — foglio con simbolo grafico
       *  (`PrinterGraphicIcon`) contro foglio con righe di testo
       *  (`PrinterReportIcon`) — non da un colore diverso. */}
      <div className="space-y-1.5">
        {/* Riga 1: Gestione File .json (Salva, Salva con nome, Apri) */}
        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            id="btn-save-project"
            onClick={handleSaveProject}
            aria-live="polite"
            title={
              isProjectSaved && savedFileName
                ? `Salvato su ${savedFileName}!`
                : activeFileName
                  ? `Salva modifiche su ${activeFileName} (Ctrl / Cmd + S)`
                  : 'Salva piano di carico (Ctrl / Cmd + S)'
            }
            className={`h-9 flex items-center justify-center rounded border transition cursor-pointer shadow-xs ${
              isProjectSaved
                ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-700 hover:text-slate-900'
            }`}
          >
            <Save
              className={`w-4 h-4 ${
                isProjectSaved ? 'text-emerald-600' : 'text-slate-600 hover:text-slate-900'
              }`}
            />
            <span className="sr-only">{isProjectSaved ? 'Salvato!' : 'Salva'}</span>
          </button>

          <button
            type="button"
            id="btn-save-as-project"
            onClick={() => void onSaveProjectAs()}
            title="Salva con nome (crea una nuova copia del file JSON)"
            className="h-9 flex items-center justify-center rounded border bg-white hover:bg-slate-50 border-slate-200 text-slate-700 hover:text-slate-900 transition cursor-pointer shadow-xs"
          >
            <SaveAll className="w-4 h-4 text-slate-600 hover:text-slate-900" />
            <span className="sr-only">Salva con nome</span>
          </button>

          <button
            type="button"
            id="btn-open-project"
            onClick={handleOpenProjectPicker}
            title="Apri Piano (carica un piano di carico `.json` salvato in precedenza)"
            className="h-9 flex items-center justify-center rounded border bg-white hover:bg-slate-50 border-slate-200 text-slate-700 hover:text-slate-900 transition cursor-pointer shadow-xs"
          >
            <FolderOpen className="w-4 h-4 text-slate-600 hover:text-slate-900" />
            <span className="sr-only">Apri Piano</span>
          </button>

          {/* Selettore file classico, invisibile: usato come **fallback trasparente**
              sui browser che non supportano la File System Access API, convalidato
              da `parseProjectFile`. */}
          <input
            ref={projectInputRef}
            id="project-file-input"
            type="file"
            accept=".json,application/json"
            onChange={handleProjectFileChange}
            className="hidden"
          />
        </div>

        {/* Riga 2: Output & Condivisione (Copia Immagine PNG, Stampa Solo
            Grafica, Stampa Scheda Completa) */}
        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            id="btn-copy-image"
            onClick={handleCopyImage}
            disabled={isCopying}
            aria-live="polite"
            title={copyTooltip}
            className={`h-9 flex items-center justify-center rounded border transition cursor-pointer shadow-xs disabled:opacity-60 disabled:cursor-wait ${clipboardButtonClass}`}
          >
            <CopyIcon className={`w-4 h-4 ${clipboardIconClass}`} />
            <span className="sr-only">{copyLabel}</span>
          </button>

          {/* Stampa Solo Grafica: `triggerPrint('clean')` → il dialogo nativo di
              stampa impagina il solo disegno del pianale a piena pagina, quindi
              si può salvare un PDF **vettoriale** leggerissimo (20–40 KB) o
              stamparlo su carta con qualità nitida al 100%. */}
          <button
            type="button"
            id="btn-print-clean"
            onClick={() => triggerPrint('clean')}
            title="Stampa solo grafica (disegno del pianale pulito con targa e note, salvabile anche in PDF leggero)"
            className="h-9 flex items-center justify-center rounded border bg-white hover:bg-slate-50 border-slate-200 text-slate-600 hover:text-slate-900 transition cursor-pointer shadow-xs"
          >
            <PrinterGraphicIcon className="w-4 h-4" />
            <span className="sr-only">Stampa Solo Grafica</span>
          </button>

          {/* Stampa Scheda Tecnica Completa: `triggerPrint('full')` → scheda A4
              formale con intestazione, disegno e riepilogo colli. */}
          <button
            type="button"
            id="btn-print-report"
            onClick={() => triggerPrint('full')}
            title="Stampa scheda tecnica (scheda A4 completa di intestazione, targa e riepilogo colli)"
            className="h-9 flex items-center justify-center rounded border bg-white hover:bg-slate-50 border-slate-200 text-slate-600 hover:text-slate-900 transition cursor-pointer shadow-xs"
          >
            <PrinterReportIcon className="w-4 h-4" />
            <span className="sr-only">Stampa Scheda Completa</span>
          </button>
        </div>

        {/* File attivo: badge compatto e ben visibile subito sotto l'ultima
            riga della toolbar. Viene acceso sia all'apertura di un piano, sia
            dopo il primo salvataggio — anche nel fallback di download classico,
            dove `App.tsx` riporta il nome generato (`piano-<TARGA>-<data>.json`). */}
        {activeFileName !== null && (
          <div
            id="active-file-badge"
            className="flex items-center gap-1.5 px-2 py-1 bg-slate-50 border border-slate-200 rounded text-[11px] font-mono text-slate-700 truncate"
            title={`File attualmente aperto: ${activeFileName}`}
          >
            <span className="text-blue-600 flex-shrink-0">📄</span>
            <span className="truncate font-semibold text-slate-800">{activeFileName}</span>
          </div>
        )}
      </div>

      {/* --- Selettore Mezzo a Pillole (centrale multi-pianale) --------------- *
       *  Una fila di pillole compatte per passare da un camion all'altro con un
       *  solo click: `[ 🚛 Mezzo 1 (TARGA) ]`. La pillola attiva porta lo stile
       *  blu primario, le altre restano su fondo bianco/ardesia. L'ultima pillola
       *  è il comando `+` che aggiunge un mezzo (fino a `MAX_BAYS`), mentre il
       *  cestino elimina quello attivo (mai l'ultimo rimasto).
       *  Tutta la plancia qui sotto — configurazione mezzo, targa, catalogo colli
       *  e riepilogo stiva — comanda **il mezzo attivo**. */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
            Centrale ({bays.length}/{MAX_BAYS} Mezzi)
          </label>
          <div className="flex items-center gap-1.5">
            {/* Frecce di riordino stalli: visibili con più di 1 mezzo. Scambiano
                il mezzo attivo con il vicino (`◀` = verso il primo posto,
                `▶` = verso l'ultimo): gli offset del mondo e le intestazioni
                `MEZZO n` si riallineano all'istante, con UN passo di Undo. */}
            {bays.length > 1 && (
              <div className="flex items-center border border-slate-200 rounded overflow-hidden bg-white shadow-2xs">
                <button
                  type="button"
                  id="btn-reorder-bay-left"
                  onClick={() => onReorderBay(activeBayId, 'left')}
                  disabled={bays.findIndex((b) => b.id === activeBayId) <= 0}
                  title="Sposta questo mezzo verso sinistra"
                  className="p-1 hover:bg-slate-100 disabled:opacity-25 disabled:cursor-not-allowed text-slate-600 transition cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span className="sr-only">Sposta a sinistra</span>
                </button>
                <div className="w-[1px] h-3.5 bg-slate-200" />
                <button
                  type="button"
                  id="btn-reorder-bay-right"
                  onClick={() => onReorderBay(activeBayId, 'right')}
                  disabled={
                    bays.findIndex((b) => b.id === activeBayId) >= bays.length - 1
                  }
                  title="Sposta questo mezzo verso destra"
                  className="p-1 hover:bg-slate-100 disabled:opacity-25 disabled:cursor-not-allowed text-slate-600 transition cursor-pointer"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                  <span className="sr-only">Sposta a destra</span>
                </button>
              </div>
            )}

            <button
              type="button"
              id="btn-delete-bay"
              onClick={() => onDeleteBay(activeBayId)}
              disabled={!canDeleteBay(bays)}
              title={
                canDeleteBay(bays)
                  ? 'Elimina il mezzo attivo dalla centrale'
                  : 'La centrale deve conservare almeno un mezzo'
              }
              className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition ${
                canDeleteBay(bays)
                  ? 'text-red-800 hover:text-red-900 hover:bg-red-50 border border-transparent hover:border-red-200 cursor-pointer'
                  : 'text-slate-300 cursor-not-allowed border border-transparent'
              }`}
            >
              <Trash2 className="w-3 h-3" />
              Elimina
            </button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1">
          {bays.map((bay, index) => {
            const isActive = bay.id === activeBayId;
            const compactPlate = bay.plate.trim().slice(0, 8);
            return (
              <button
                key={bay.id}
                type="button"
                id={`bay-pill-${bay.id}`}
                onClick={() => onSelectBay(bay.id)}
                title={`${bay.vehicle.name}${bay.plate.trim() ? ` — ${bay.plate.trim()}` : ''}`}
                aria-pressed={isActive}
                className={`flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] leading-none transition cursor-pointer ${
                  isActive
                    ? 'bg-blue-50 border-blue-500 text-blue-700 font-bold'
                    : 'bg-white border-slate-300 text-slate-600 font-medium hover:border-slate-400 hover:text-slate-800'
                }`}
              >
                <Truck className="w-3 h-3 shrink-0" />
                <span className="truncate">
                  Mezzo {index + 1}
                  {compactPlate ? ` (${compactPlate})` : ''}
                </span>
              </button>
            );
          })}

          {/* Aggiungi mezzo: presente finché la centrale non è al completo. */}
          {bays.length < MAX_BAYS && (
            <button
              type="button"
              id="btn-add-bay"
              onClick={onAddBay}
              title={`Aggiungi un mezzo alla centrale (max ${MAX_BAYS})`}
              className="flex items-center gap-1 rounded-full border border-dashed border-slate-400 px-2 py-1 text-[11px] leading-none font-semibold text-slate-600 transition cursor-pointer hover:border-blue-500 hover:text-blue-700 hover:bg-blue-50"
            >
              <Plus className="w-3 h-3 shrink-0" />
              <span>Mezzo</span>
            </button>
          )}

          {/* Clona mezzo attivo ("camion gemello"): presente finché la centrale
              non è al completo. Lo stallo nasce identico a quello attivo — mezzo,
              targa `(copia)`, colli e note con ID rigenerati — e diventa subito
              il Mezzo Attivo, in UN solo passo di Undo. */}
          {bays.length < MAX_BAYS && (
            <button
              type="button"
              id="btn-clone-bay"
              onClick={() => onCloneBay(activeBayId)}
              title={`Clona il mezzo attivo (crea una copia identica con lo stesso carico, max ${MAX_BAYS})`}
              className="flex items-center gap-1 rounded-full border border-dashed border-slate-400 px-2 py-1 text-[11px] leading-none font-semibold text-slate-600 transition cursor-pointer hover:border-emerald-500 hover:text-emerald-700 hover:bg-emerald-50"
            >
              <Copy className="w-3 h-3 shrink-0 text-emerald-600" />
              <span>Clona</span>
            </button>
          )}
        </div>
      </div>

      {/* Configurazione Mezzo / Targa: blocco unico e compatto (space-y-1 fra
          etichetta e input) per massimizzare la densità verticale. */}
      <div className="space-y-1">
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
                    {pallet.sizeLabel && (
                      <span className="text-[10px] font-normal text-slate-400 tracking-tight tabular-nums shrink-0">
                        {pallet.sizeLabel}
                      </span>
                    )}
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
                          Etichetta
                        </span>
                        <input
                          type="text"
                          id={`batch-name-${pallet.code}`}
                          value={draft.name}
                          onChange={(e) => updateBatchDraft(pallet, { name: e.target.value })}
                          placeholder="esempio [nome_destinatario]"
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
                  Etichetta
                </span>
                <input
                  type="text"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="esempio [nome_destinatario]"
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

      {/* Statistiche del Carico del **Mezzo Attivo**, con il totale di flotta */}
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

          {/* Totale Flotta: compare solo con più di un mezzo in centrale */}
          {bays.length > 1 && (
            <div className="pt-2 mt-2 border-t border-slate-200 flex justify-between items-center text-[11px] font-bold text-slate-600 uppercase tracking-tight">
              <span>Totale Flotta ({bays.length} Mezzi):</span>
              <span className="font-mono text-slate-800">
                {totalFleetItems} Colli · {(totalFleetLdm / 100).toFixed(2)} m
              </span>
            </div>
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
              <span className="text-slate-300">Salva Piano (in-place)</span>
              <kbd className="bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-200">Ctrl / Cmd + S</kbd>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-300">Elimina collo / nota</span>
              <kbd className="bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-200">Canc</kbd>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-300">Spingi a battuta (pareti / ostacoli)</span>
              <kbd className="bg-slate-800 border border-slate-700 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-200">Frecce ← ↑ → ↓</kbd>
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