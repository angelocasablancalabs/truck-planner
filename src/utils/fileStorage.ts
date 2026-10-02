/* -------------------------------------------------------------------------- *
 *  MODULO SALVA & APRI PIANO DI CARICO (.json)
 *
 *  Backup, ripristino e condivisione dei lavori: l'intero piano di carico
 *  (mezzo, targa, colli, note laterali e densità etichette) viene serializzato
 *  in un file JSON leggibile, pulito e verificabile — esattamente come lo
 *  produrrebbe un operatore che vuole riaprire il lavoro il giorno dopo o
 *  passarlo a un collega sul piazzale.
 *
 *  Il modulo è **puro e senza dipendenze React**: si occupa solo di costruire,
 *  scrivere, scaricare e convalidare i file. Lo stato applicativo resta in
 *  `App.tsx`.
 *
 *  Regole di formato (`ProjectFile` in `types.ts`):
 *    - `version: 1` + `app: 'truck-planner'` → firma dello schema;
 *    - `timestamp` ISO 8601 del salvataggio;
 *    - nomi file leggibili e "sporco-free": la targa viene ripulita da ogni
 *      carattere non alfanumerico, così il file si apre senza sorprese su
 *      Windows, macOS e sui client di posta.
 *
 *  DUE MODALITÀ DI SALVATAGGIO (`saveProjectWithHandle`):
 *    1. **File System Access API** (Chrome / Edge su Windows e macOS): il modulo
 *       conserva l'handle del file aperto e lo **riscrive in-place** con
 *       `handle.createWritable()` — il classico `Ctrl / Cmd + S` di Excel e Word,
 *       senza passare dalla cartella Download e senza duplicati `(1)`, `(2)`.
 *    2. **Fallback trasparente**: se il browser non espone i selettori nativi, o
 *       se l'operatore nega l'accesso al file, si ricade sul download classico
 *       con tag `<a download>` (`exportProjectToJson`), esattamente come prima.
 * -------------------------------------------------------------------------- */

import type { SideNote, PlacedItem, ProjectFile } from '../types';
import { PLATE_MAX_LENGTH } from './plateBadge';

/** Prefisso del file quando la targa / identificativo del mezzo è compilata. */
const FILE_NAME_PREFIX_WITH_PLATE = 'piano';
/** Prefisso del file quando il mezzo non ha targa (nessun identificativo). */
const FILE_NAME_PREFIX_WITHOUT_PLATE = 'piano-carico';
/** Estensione ufficiale del file di progetto. */
const FILE_EXTENSION = 'json';
/** MIME del file di progetto: JSON leggibile (indentato di 2 spazi). */
const JSON_MIME_TYPE = 'application/json';
/** Indentazione del `JSON.stringify`: file ispezionabile e diffabile a mano. */
const JSON_INDENT = 2;

/* -------------------------------------------------------------------------- *
 *  FILE SYSTEM ACCESS API — TIPI E SUPPORTO NATIVO
 *
 *  I selettori nativi (`showOpenFilePicker` / `showSaveFilePicker`) non sono
 *  (ancora) dichiarati in `lib.dom.d.ts`: le interfacce minime necessarie sono
 *  quindi dichiarate qui e `window` viene letto attraverso una vista tipizzata,
 *  senza allargare il tipo globale del progetto.
 * -------------------------------------------------------------------------- */

/** Voce di `types` dei selettori: descrizione leggibile + MIME → estensioni. */
export interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

/** Opzioni comuni ai due selettori nativi. */
interface FilePickerOptions {
  types?: FilePickerAcceptType[];
  excludeAcceptAllOption?: boolean;
  id?: string;
}

/** Opzioni di `showOpenFilePicker` (selezione multipla disattivata). */
interface OpenFilePickerOptions extends FilePickerOptions {
  multiple?: boolean;
}

/** Opzioni di `showSaveFilePicker` (nome proposto per il nuovo file). */
interface SaveFilePickerOptions extends FilePickerOptions {
  suggestedName?: string;
}

/** Vista tipizzata di `window` con i due selettori della File System Access API. */
interface FileSystemAccessWindow extends Window {
  showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
}

/** Filtro ufficiale dei file di progetto, condiviso da apertura e salvataggio. */
export const PROJECT_FILE_PICKER_TYPES: FilePickerAcceptType[] = [
  {
    description: 'File Truck Planner CAD (.json)',
    accept: { [JSON_MIME_TYPE]: [`.${FILE_EXTENSION}`] },
  },
];

/** `window` visto come contenitore dei selettori nativi (mai `null` nel browser). */
const pickerWindow = (): FileSystemAccessWindow => window as FileSystemAccessWindow;

/** Vero se il browser espone il selettore nativo di **apertura**. */
export const isOpenPickerSupported = (): boolean =>
  typeof pickerWindow().showOpenFilePicker === 'function';

/** Vero se il browser espone il selettore nativo di **salvataggio**. */
export const isSavePickerSupported = (): boolean =>
  typeof pickerWindow().showSaveFilePicker === 'function';

/**
 * Vero se il browser supporta **entrambi** i selettori della File System Access
 * API (Chrome / Edge su Windows e macOS): solo in questo caso ha senso parlare di
 * salvataggio in-place. Altrove il modulo ricade automaticamente sul download.
 */
export const isFileSystemAccessSupported = (): boolean =>
  isOpenPickerSupported() && isSavePickerSupported();

/**
 * Vero se l'errore è l'**annullamento volontario** di un selettore nativo
 * (`AbortError`): l'operatore ha chiuso la finestra di dialogo, quindi non va
 * mostrato alcun avviso e nessun download deve partire.
 */
export const isPickerAbortError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { name?: unknown }).name === 'AbortError';

/**
 * Campo obbligatorio mancante o di tipo sbagliato nel file di progetto: errore
 * esplicito, mostrato all'operatore in un `alert` amichevole dalla sidebar.
 */
export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

/** Data del giorno in formato `YYYY-MM-DD` (ISO 8601, ora locale del sistema). */
const todayStamp = (): string => new Date().toISOString().slice(0, 10);

/**
 * Nome file pulito del piano di carico:
 *  - con targa: `piano-<TARGA>_<YYYY-MM-DD>.json`, dove la targa è ripulita da
 *    ogni carattere non alfanumerico (`/`, spazi, punti, `#`… diventano `_`);
 *  - senza targa: `piano-carico-<YYYY-MM-DD>.json`.
 */
export const buildProjectFileName = (plate: string): string => {
  const cleanPlate = (plate ?? '').replace(/[^a-zA-Z0-9]/g, '_');
  const date = todayStamp();
  return cleanPlate
    ? `${FILE_NAME_PREFIX_WITH_PLATE}-${cleanPlate}-${date}.${FILE_EXTENSION}`
    : `${FILE_NAME_PREFIX_WITHOUT_PLATE}-${date}.${FILE_EXTENSION}`;
};

/**
 * Serializza il piano di carico e ne innesca il download sul computer
 * dell'operatore (cartella Download del browser).
 *
 * Il file è prodotto con `JSON.stringify(project, null, 2)` — leggibile e
 * diffabile — dentro un `Blob` di tipo `application/json`, e scaricato tramite
 * un tag `<a>` temporaneo con `URL.createObjectURL`. Nessuna richiesta di rete:
 * il salvataggio funziona anche completamente offline.
 */
export const exportProjectToJson = (project: ProjectFile): void => {
  const fileName = buildProjectFileName(project.plate ?? '');
  const blob = new Blob([JSON.stringify(project, null, JSON_INDENT)], {
    type: JSON_MIME_TYPE,
  });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  // Il link deve essere nel documento perché il click programmatico sia
  // affidabile su tutti i browser; viene rimosso subito dopo.
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  // L'URL oggetto viene rilasciato al giro di eventi successivo: revocarlo
  // subito potrebbe annullare il download appena avviato.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

/** Vero se il valore è un oggetto non-nullo e non un array. */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Convalida della configurazione mezzo: id, nome e dimensioni positive. */
const isValidVehicle = (value: unknown): boolean => {
  if (!isPlainObject(value)) return false;
  const { width, length } = value as { width?: unknown; length?: unknown };
  return (
    typeof width === 'number' &&
    Number.isFinite(width) &&
    width > 0 &&
    typeof length === 'number' &&
    Number.isFinite(length) &&
    length > 0
  );
};

/** Convalida minimale di un collo: identità, nome, quote e coordinate. */
const isValidItem = (value: unknown): boolean => {
  if (!isPlainObject(value)) return false;
  const item = value as Partial<PlacedItem>;
  return (
    typeof item.id === 'string' &&
    typeof item.name === 'string' &&
    typeof item.width === 'number' &&
    Number.isFinite(item.width) &&
    typeof item.length === 'number' &&
    Number.isFinite(item.length) &&
    typeof item.x === 'number' &&
    Number.isFinite(item.x) &&
    typeof item.y === 'number' &&
    Number.isFinite(item.y)
  );
};

/** Convalida minimale di una nota laterale: identità, posizione 2D e testo. */
const isValidNote = (value: unknown): boolean => {
  if (!isPlainObject(value)) return false;
  const note = value as Partial<SideNote>;
  return (
    typeof note.id === 'string' &&
    typeof note.x === 'number' &&
    Number.isFinite(note.x) &&
    typeof note.y === 'number' &&
    Number.isFinite(note.y) &&
    typeof note.content === 'string'
  );
};

/**
 * Convalida il contenuto del file e lo restituisce tipizzato come `ProjectFile`.
 * Il messaggio di errore è già pronto per l'`alert` mostrato all'operatore.
 */
const validateProject = (parsed: unknown): ProjectFile => {
  if (!isPlainObject(parsed)) {
    throw new ProjectFileError(
      'Il file non contiene un piano di carico valido: atteso un oggetto JSON.'
    );
  }

  if (!isValidVehicle(parsed.vehicle)) {
    throw new ProjectFileError(
      'File non valido: manca la configurazione del mezzo o le sue dimensioni sono errate.'
    );
  }

  if (!Array.isArray(parsed.items)) {
    throw new ProjectFileError('File non valido: l\'elenco dei colli è mancante o danneggiato.');
  }
  const invalidItem = (parsed.items as unknown[]).findIndex((item) => !isValidItem(item));
  if (invalidItem >= 0) {
    throw new ProjectFileError(
      `File non valido: il collo in posizione ${invalidItem + 1} è incompleto o danneggiato.`
    );
  }

  if (!Array.isArray(parsed.notes)) {
    throw new ProjectFileError('File non valido: l\'elenco delle note laterali è danneggiato.');
  }
  const invalidNote = (parsed.notes as unknown[]).findIndex((note) => !isValidNote(note));
  if (invalidNote >= 0) {
    throw new ProjectFileError(
      `File non valido: la nota laterale in posizione ${invalidNote + 1} è incompleta o danneggiata.`
    );
  }

  // Campi di contorno: se assenti o incoerenti si ricade su valori sicuri,
  // perché il piano resta comunque riapribile (colli e note sono già validati).
  const plate = typeof parsed.plate === 'string' ? parsed.plate.slice(0, PLATE_MAX_LENGTH) : '';
  const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString();
  const labelDensity: ProjectFile['labelDensity'] =
    parsed.labelDensity === 'all' ||
    parsed.labelDensity === 'client' ||
    parsed.labelDensity === 'dimensions' ||
    parsed.labelDensity === 'minimal'
      ? parsed.labelDensity
      : 'all';

  return {
    version: 1,
    app: 'truck-planner',
    timestamp,
    vehicle: parsed.vehicle as ProjectFile['vehicle'],
    plate,
    items: parsed.items as PlacedItem[],
    notes: parsed.notes as SideNote[],
    labelDensity,
  };
};

/**
 * Legge e convalida un file di progetto scelto dall'operatore.
 *
 * @throws {ProjectFileError} se il file non è un JSON leggibile o se mancano i
 *         campi minimi indispensabili (`vehicle`, `items`, `notes`).
 */
export const parseProjectFile = async (file: File): Promise<ProjectFile> => {
  const raw = await file.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProjectFileError(
      'Il file selezionato non è un piano di carico valido: il contenuto JSON è danneggiato o illeggibile.'
    );
  }

  return validateProject(parsed);
};

/* -------------------------------------------------------------------------- *
 *  SALVATAGGIO DIRETTO IN-PLACE (STILE EXCEL) & APERTURA CON HANDLE
 * -------------------------------------------------------------------------- */

/** Esito di un salvataggio: handle attivo, nome del file e natura dell'operazione. */
export interface SaveProjectResult {
  /** Handle del file su disco (`null` quando si è passati dal download classico). */
  handle: FileSystemFileHandle | null;
  /** Nome del file salvato (`piano-<TARGA>_<YYYY-MM-DD>.json`). */
  fileName: string;
  /** `true` se il file è stato creato ora, `false` se è stata una sovrascrittura. */
  isNewFile: boolean;
}

/** Esito di un'apertura: piano convalidato, handle del file e nome. */
export interface OpenProjectResult {
  /** Piano di carico convalidato e pronto per essere messo in scena. */
  project: ProjectFile;
  /** Handle del file (`null` quando si è passati dal selettore classico). */
  handle: FileSystemFileHandle | null;
  /** Nome del file aperto (mostrato come "File attivo" nella sidebar). */
  fileName: string;
}

/**
 * Scrive il JSON del piano dentro un handle della File System Access API.
 * Un solo punto di scrittura condiviso da sovrascrittura e "Salva con nome".
 */
const writeProjectToHandle = async (
  handle: FileSystemFileHandle,
  json: string
): Promise<void> => {
  const writable = await handle.createWritable();
  await writable.write(json);
  await writable.close();
};

/**
 * Salva il piano di carico con salvataggio **diretto in-place** stile Excel/Word.
 *
 *  - **`existingHandle` presente** → il file già aperto viene **riscritto** con
 *    `handle.createWritable()`: nessun download, nessun duplicato nella cartella
 *    Download, nome del file invariato. È il percorso di `Ctrl / Cmd + S`.
 *  - **`existingHandle` assente (file nuovo)** → se il browser supporta la File
 *    System Access API si apre il selettore nativo `showSaveFilePicker`
 *    (nome proposto: `piano-<TARGA>_<YYYY-MM-DD>.json`) e si scrive lì.
 *  - **Fallback trasparente** → browser senza selettori nativi o permesso negato:
 *    si scarica il file con il tag `<a download>` (`exportProjectToJson`).
 *
 * @throws l'`AbortError` del selettore quando l'operatore annulla la finestra:
 *         il chiamante lo riconosce con `isPickerAbortError` e tace.
 */
export const saveProjectWithHandle = async (
  project: ProjectFile,
  existingHandle?: FileSystemFileHandle | null
): Promise<SaveProjectResult> => {
  const json = JSON.stringify(project, null, JSON_INDENT);
  const defaultName = buildProjectFileName(project.plate ?? '');

  // 1) SOVRASCRITTURA IN-PLACE: il file già aperto viene riscritto sul posto.
  if (existingHandle) {
    await writeProjectToHandle(existingHandle, json);
    return { handle: existingHandle, fileName: existingHandle.name, isNewFile: false };
  }

  // 2) FILE NUOVO: selettore nativo "Salva con nome", quando disponibile.
  const savePicker = pickerWindow().showSaveFilePicker;
  if (typeof savePicker === 'function') {
    try {
      const handle = await savePicker.call(pickerWindow(), {
        suggestedName: defaultName,
        types: PROJECT_FILE_PICKER_TYPES,
      });
      await writeProjectToHandle(handle, json);
      return { handle, fileName: handle.name, isNewFile: true };
    } catch (error) {
      // Annullamento volontario: nessun file e nessun download, esce silenziosamente.
      if (isPickerAbortError(error)) throw error;
      // Permesso negato o selettore non utilizzabile in questo contesto:
      // si prosegue con il fallback trasparente qui sotto.
    }
  }

  // 3) FALLBACK TRASPARENTE: download classico nella cartella Download.
  exportProjectToJson(project);
  return { handle: null, fileName: defaultName, isNewFile: true };
};

/**
 * Apre un piano di carico con il selettore nativo della File System Access API e
 * ne restituisce anche l'**handle**, che da quel momento abilita il salvataggio
 * in-place. Se l'operatore annulla la finestra l'`AbortError` risale al
 * chiamante, che esce in silenzio (`isPickerAbortError`).
 *
 * Da invocare solo quando `isOpenPickerSupported()` è vero: altrove il chiamante
 * usa il selettore file classico (`<input type="file">`).
 *
 * @throws {ProjectFileError} se il file scelto non è un piano di carico valido.
 */
export const openProjectWithPicker = async (): Promise<OpenProjectResult> => {
  const openPicker = pickerWindow().showOpenFilePicker;
  if (typeof openPicker !== 'function') {
    throw new ProjectFileError(
      'Questo browser non supporta l\'apertura diretta dei file: usa il selettore classico.'
    );
  }

  const [handle] = await openPicker.call(pickerWindow(), {
    types: PROJECT_FILE_PICKER_TYPES,
    multiple: false,
  });

  if (!handle) {
    throw new ProjectFileError('Nessun file selezionato.');
  }

  const file = await handle.getFile();
  const project = await parseProjectFile(file);

  return { project, handle, fileName: handle.name };
};
