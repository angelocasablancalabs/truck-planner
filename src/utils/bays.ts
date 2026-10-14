/* -------------------------------------------------------------------------- *
 *  CENTRALE MULTI-PIANALE — GEOMETRIA E STRUTTURA DEGLI STALLI
 *
 *  La centrale ospita fino a `MAX_BAYS` mezzi affiancati nello stesso canvas:
 *  ogni stallo (`DeckBay`) vive su **coordinate locali** (0 … larghezza,
 *  0 … lunghezza) e viene semplicemente **traslato orizzontalmente** in fase di
 *  disegno. Questo modulo è l'unica fonte di verità di quella traslazione, così
 *  canvas a schermo (`components/TruckCanvas.tsx`), snapshot PNG
 *  (`utils/export.ts`) e scheda di stampa (`components/PrintReport.tsx`)
 *  affiancano i mezzi con lo stesso identico passo.
 *
 *  Il modulo è **puro**: nessuna dipendenza React, nessuno stato.
 * -------------------------------------------------------------------------- */

import type { DeckBay, VehicleConfig } from '../types';
import { MAX_BAYS } from '../constants';

/**
 * Stacco orizzontale (cm) tra due stalli affiancati.
 *
 * È lo spazio che accoglie, **senza collisioni visive**, tutto ciò che vive ai
 * lati di un pianale:
 *  - a sinistra il righello metrico e il badge LDM (`LDM_BADGE_RESERVED_LEFT`),
 *    più la didascalia della quota nominale 13,20 m;
 *  - a destra il badge LDM del lato carico asimmetrico (`LDM_BADGE_RESERVED_RIGHT`).
 *
 * 180 cm sono ampiamente sufficienti per entrambi (≈ 80 cm per lato: badge LDM
 * accostato alla sponda + margine) e lasciano respiro fra la coda delle note di
 * uno stallo e la parete sinistra del successivo.
 */
export const BAY_SPACING_CM = 180;

/**
 * Traslazione orizzontale (cm) di ciascuno stallo, nell'ordine della flotta.
 *
 * La formula è cumulativa e tiene conto della **larghezza reale** del mezzo:
 * `offset[0] = 0` e `offset[i] = offset[i-1] + larghezza[i-1] + BAY_SPACING_CM`.
 * Un bilico da 2,50 m seguito da una motrice da 2,50 m dista quindi 180 cm dal
 * precedente, indipendentemente da quanto sia lungo il suo pianale.
 */
export const bayOffsets = (bays: DeckBay[]): number[] => {
  const offsets: number[] = [];
  let cursor = 0;

  for (const bay of bays) {
    offsets.push(cursor);
    cursor += bay.vehicle.width + BAY_SPACING_CM;
  }

  return offsets;
};

/**
 * Stallo attivo risolto con fallback sicuro: se l'ID richiesto non esiste più
 * (stallo eliminato da un `Ctrl / Cmd + Z` o da un file aperto) si ricade sul
 * primo mezzo della flotta, così l'applicazione non resta mai senza bersaglio.
 */
export const resolveActiveBay = (bays: DeckBay[], activeBayId: string): DeckBay =>
  bays.find((bay) => bay.id === activeBayId) ?? bays[0];

/** Vero se la flotta può ancora accogliere un nuovo mezzo (`MAX_BAYS`). */
export const canAddBay = (bays: DeckBay[]): boolean => bays.length < MAX_BAYS;

/**
 * Vero se un mezzo può essere eliminato: la centrale deve sempre conservare
 * almeno un pianale, quindi l'ultimo stallo rimasto non è mai eliminabile.
 */
export const canDeleteBay = (bays: DeckBay[]): boolean => bays.length > 1;

/**
 * Etichetta breve del mezzo per l'intestazione dello stallo e le pillole della
 * sidebar: `MEZZO 1`, `MEZZO 2`, `MEZZO 3`, in base all'ordine di affiancamento.
 *
 * @param index Indice dello stallo nella flotta (0-based)
 */
export const bayLabel = (index: number): string => `MEZZO ${index + 1}`;

/**
 * Nome leggibile del preset veicolo, senza le dimensioni fra parentesi:
 * `"Bilico Frigo (2,45 × 13,28 m)"` → `"Bilico Frigo"`. È la forma breve usata
 * da pillole, tooltip e intestazioni della sidebar.
 */
export const vehicleShortName = (vehicle: VehicleConfig): string =>
  vehicle.name.replace(/\s*\(.*\)\s*$/, '');

/**
 * Dimensioni del mezzo in metri, larghezza per prima: `2.50 × 13.28 m`.
 * Stessa formattazione dell'intestazione della scheda di stampa.
 */
export const vehicleDimensionsLabel = (vehicle: VehicleConfig): string =>
  `${(vehicle.width / 100).toFixed(2)} × ${(vehicle.length / 100).toFixed(2)} m`;

/* -------------------------------------------------------------------------- *
 *  HEADER DELLO STALLO (identificativo del mezzo sopra la Cabina)
 *
 *  Ogni pianale porta una **pillola a riga singola** con il solo nome del mezzo
 *  (`MEZZO 1`) e la pillola `ATTIVO`. Vive **sopra la fascia della targa**: il
 *  suo bordo inferiore (`BAY_HEADER_BOTTOM_CM = -102`) resta sopra la sommità
 *  del glifo della targa (che con una targa lunga sale fino a Y ≈ −88 cm),
 *  quindi non può mai sovrapporsi né alla targa estesa né alla didascalia
 *  `▲ CABINA ▲`. La geometria è condivisa fra canvas a schermo e scheda di
 *  stampa, così le due rese restano identiche.
 *
 *  Targa e preset **non** vengono ripetuti qui: la targa vive già nel proprio
 *  badge sopra la Cabina e il preset nel menu "Configurazione Mezzo" della
 *  sidebar. L'header non porta nemmeno più un comando di eliminazione: sul
 *  canvas resta una pillola **pulita e cliccabile**, mentre l'eliminazione del
 *  mezzo è gestita esclusivamente dal pulsante `Elimina` della sidebar.
 * -------------------------------------------------------------------------- */

/** Quota (cm) del bordo SUPERIORE dell'header dello stallo. */
export const BAY_HEADER_TOP_CM = -128;

/** Quota (cm) del bordo INFERIORE dell'header dello stallo. */
export const BAY_HEADER_BOTTOM_CM = -102;

/** Altezza (cm) dell'header: `BAY_HEADER_BOTTOM_CM − BAY_HEADER_TOP_CM`. */
export const BAY_HEADER_HEIGHT_CM = BAY_HEADER_BOTTOM_CM - BAY_HEADER_TOP_CM;

/**
 * Larghezza (cm) dell'header: **compatta e centrata** sulla larghezza del
 * pianale. Resta ben dentro lo stacco fra due stalli (`BAY_SPACING_CM = 180`),
 * così la pillola di un mezzo non può mai invadere il pianale del successivo.
 */
export const BAY_HEADER_WIDTH_CM = 140;

/** Corpo (cm) della riga `MEZZO n` nell'header dello stallo. */
export const BAY_HEADER_TITLE_FONT_CM = 13;

/** Padding interno (cm) dell'header dello stallo. */
export const BAY_HEADER_PADDING_CM = 6;

/* --- Palette dell'header (blu primario / ardesia tenue) -------------------- */
export const BAY_HEADER_BG_ACTIVE = '#EFF6FF';
export const BAY_HEADER_BORDER_ACTIVE = '#2563EB';
export const BAY_HEADER_TEXT_ACTIVE = '#1D4ED8';
export const BAY_HEADER_BG = '#F8FAFC';
export const BAY_HEADER_BORDER = '#CBD5E1';
export const BAY_HEADER_TEXT = '#334155';

