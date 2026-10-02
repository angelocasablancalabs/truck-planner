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
 *  scaricare e convalidare i file. Lo stato applicativo resta in `App.tsx`.
 *
 *  Regole di formato (`ProjectFile` in `types.ts`):
 *    - `version: 1` + `app: 'truck-planner'` → firma dello schema;
 *    - `timestamp` ISO 8601 del salvataggio;
 *    - nomi file leggibili e "sporco-free": la targa viene ripulita da ogni
 *      carattere non alfanumerico, così il file si apre senza sorprese su
 *      Windows, macOS e sui client di posta.
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
