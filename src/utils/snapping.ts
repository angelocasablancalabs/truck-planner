import type { VehicleConfig, PlacedItem } from '../types';

/** Tolleranza di aggancio magnetico predefinita, espressa in centimetri reali. */
export const DEFAULT_SNAP_THRESHOLD = 5;

/**
 * Sforamento massimo consentito oltre la linea delle porte posteriori (cm).
 * Permette di accodare e testare l'ingombro reale anche quando le porte non
 * chiuderebbero: il collo resta visibile e segnalato in rosso d'allarme.
 */
export const REAR_OVERHANG_LIMIT = 150;

/** Restituisce il candidato più vicino al valore corrente (o il valore corrente stesso). */
const pickClosestCandidate = (
  candidates: number[],
  current: number,
  threshold: number
): number => {
  let best = current;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const distance = Math.abs(candidate - current);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  return bestDistance <= threshold ? best : current;
};

/**
 * Blocca un valore all'interno di un intervallo fisico.
 * Se il collo è più grande del pianale, viene riportato al bordo (0).
 */
const clampToRange = (value: number, max: number): number => {
  const upper = Math.max(0, max);
  return Math.max(0, Math.min(upper, value));
};

/**
 * Clamp permissivo dell'asse Y (Cabina → Porte):
 * parete Cabina rigida (y >= 0) e sforamento posteriore controllato fino a
 * `REAR_OVERHANG_LIMIT` cm oltre la linea delle porte.
 */
const clampYWithOverhang = (value: number, vehicleLength: number, itemLength: number): number => {
  const upper = vehicleLength + REAR_OVERHANG_LIMIT - itemLength;
  return Math.max(0, Math.min(upper, value));
};

/**
 * Indica se il collo esce dalla sagoma utile del rimorchio (pareti, cabina o
 * porte posteriori). È la condizione che accende l'allarme rosso sul canvas.
 */
export function isOutOfBounds(
  item: { x: number; y: number; width: number; length: number },
  vehicle: VehicleConfig
): boolean {
  return (
    item.x < 0 ||
    item.x + item.width > vehicle.width ||
    item.y < 0 ||
    item.y + item.length > vehicle.length
  );
}

/**
 * Calcola la posizione magnetica di un collo trascinato sul pianale.
 *
 * Aggancia il collo (tolleranza in cm reali, default 5) alle pareti del
 * semirimorchio e ai bordi dei colli già stivati, lavorando separatamente
 * sui due assi. Il risultato è sempre contenuto nella sagoma utile del mezzo.
 *
 * @param currentX   Coordinata X grezza derivante dal puntatore (cm, da parete sinistra)
 * @param currentY   Coordinata Y grezza derivante dal puntatore (cm, da cabina)
 * @param width      Larghezza attuale del collo trascinato (cm)
 * @param length     Lunghezza attuale del collo trascinato (cm)
 * @param vehicle    Configurazione del veicolo (dimensioni in cm)
 * @param otherItems Colli già presenti sul pianale, escluso quello trascinato
 * @param threshold  Tolleranza di aggancio in cm
 */
export const calculateSnapPosition = (
  currentX: number,
  currentY: number,
  width: number,
  length: number,
  vehicle: VehicleConfig,
  otherItems: PlacedItem[],
  threshold: number = DEFAULT_SNAP_THRESHOLD
): { x: number; y: number } => {
  // --- Candidati asse X: pareti laterali + bordi/allineamenti degli altri colli ---
  const xCandidates: number[] = [0, vehicle.width - width];

  // --- Candidati asse Y: parete cabina + porte posteriori + bordi/allineamenti ---
  const yCandidates: number[] = [0, vehicle.length - length];

  for (const other of otherItems) {
    xCandidates.push(
      other.x + other.width,          // filo: bordo sinistro contro bordo destro
      other.x - width,                // filo: bordo destro contro bordo sinistro
      other.x,                        // allineamento a sinistra
      other.x + other.width - width   // allineamento a destra
    );

    yCandidates.push(
      other.y + other.length,         // filo: bordo superiore contro bordo inferiore
      other.y - length,               // filo: bordo inferiore contro bordo superiore
      other.y,                        // allineamento in alto
      other.y + other.length - length // allineamento in basso
    );
  }

  const snappedX = pickClosestCandidate(xCandidates, currentX, threshold);
  const snappedY = pickClosestCandidate(yCandidates, currentY, threshold);

  // --- Clamping finale ---
  // X: rigido tra le pareti laterali.
  // Y: parete Cabina rigida, sforamento posteriore consentito (max 150 cm):
  // lo snap alla linea delle porte resta un candidato magnetico, ma non un muro.
  return {
    x: clampToRange(snappedX, vehicle.width - width),
    y: clampYWithOverhang(snappedY, vehicle.length, length),
  };
};

/**
 * Verifica di sovrapposizione geometrica 2D (AABB) tra un rettangolo generico
 * `(x, y, width, length)` e un collo già presente sul pianale.
 * Il contatto a filo bordo NON è considerato collisione.
 */
export const isRectColliding = (
  x: number,
  y: number,
  width: number,
  length: number,
  item: PlacedItem
): boolean =>
  !(
    x + width <= item.x ||
    item.x + item.width <= x ||
    y + length <= item.y ||
    item.y + item.length <= y
  );

/**
 * Verifica di sovrapposizione geometrica 2D tra due colli (AABB check).
 * Il contatto a filo bordo NON è considerato collisione.
 */
export const isColliding = (itemA: PlacedItem, itemB: PlacedItem): boolean =>
  isRectColliding(itemA.x, itemA.y, itemA.width, itemA.length, itemB);

/**
 * Indica se il collo si sovrappone ad almeno un altro collo del pianale.
 */
export const hasCollision = (
  item: PlacedItem,
  items: PlacedItem[]
): boolean => items.some((other) => other.id !== item.id && isColliding(item, other));

/**
 * Ricerca del primo slot libero ("first-fit") per un nuovo collo.
 *
 * Esplora i soli punti di incastro generati dai bordi dei colli già stivati
 * (più l'origine del pianale), ordinati dalla Cabina verso le Porte e da
 * sinistra verso destra: il primo rettangolo che rientra nella sagoma utile
 * e non collide con nulla viene restituito immediatamente.
 *
 * @param width   Larghezza del nuovo collo (cm)
 * @param length  Lunghezza del nuovo collo (cm, asse Cabina → Porte)
 * @param vehicle Configurazione del veicolo (dimensioni in cm)
 * @param items   Colli già presenti sul pianale
 */
export function findSmartSpawnPosition(
  width: number,
  length: number,
  vehicle: VehicleConfig,
  items: PlacedItem[]
): { x: number; y: number } {
  // Pianale vuoto: angolo Cabina / parete sinistra.
  if (items.length === 0) return { x: 0, y: 0 };

  // Candidati Y (Cabina → Porte): 0 + bordo inferiore di ogni collo esistente.
  const yCandidates = Array.from(
    new Set([0, ...items.map((item) => item.y + item.length)])
  ).sort((a, b) => a - b);

  // Candidati X (parete sinistra → destra): 0 + bordo destro di ogni collo.
  const xCandidates = Array.from(
    new Set([0, ...items.map((item) => item.x + item.width)])
  ).sort((a, b) => a - b);

  for (const y of yCandidates) {
    for (const x of xCandidates) {
      // Deve rientrare nella sagoma utile del mezzo...
      if (x + width > vehicle.width || y + length > vehicle.length) continue;
      // ...e non sovrapporsi a nessun collo già presente.
      if (items.some((other) => isRectColliding(x, y, width, length, other))) continue;
      return { x, y };
    }
  }

  // Nessuno slot a incastro disponibile: accoda il collo a fila sotto il più
  // avanzato, anche a costo di sbordare oltre le porte posteriori
  // ("verità visiva del piazzale": nessun clamp che lo spingerebbe sopra i
  // bancali già caricati creando false collisioni interne).
  const maxY = items.reduce((max, item) => Math.max(max, item.y + item.length), 0);
  const maxX = Math.max(0, vehicle.width - width);
  return { x: Math.max(0, Math.min(maxX, 0)), y: maxY };
}


/**
 * Posizione arrotondata al decimo di centimetro, per evitare aggiornamenti
 * di stato superflui durante il trascinamento.
 */
export const toPrecision = (value: number): number => Math.round(value * 10) / 10;
