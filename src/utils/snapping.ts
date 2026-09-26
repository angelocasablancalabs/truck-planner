import type { VehicleConfig, PlacedItem } from '../types';

/** Tolleranza di aggancio magnetico predefinita, espressa in centimetri reali. */
export const DEFAULT_SNAP_THRESHOLD = 5;

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

  // --- Clamping finale nella sagoma utile del pianale ---
  return {
    x: clampToRange(snappedX, vehicle.width - width),
    y: clampToRange(snappedY, vehicle.length - length),
  };
};

/**
 * Verifica di sovrapposizione geometrica 2D tra due colli (AABB check).
 * Il contatto a filo bordo NON è considerato collisione.
 */
export const isColliding = (itemA: PlacedItem, itemB: PlacedItem): boolean =>
  !(
    itemA.x + itemA.width <= itemB.x ||
    itemB.x + itemB.width <= itemA.x ||
    itemA.y + itemA.length <= itemB.y ||
    itemB.y + itemB.length <= itemA.y
  );

/**
 * Indica se il collo si sovrappone ad almeno un altro collo del pianale.
 */
export const hasCollision = (
  item: PlacedItem,
  items: PlacedItem[]
): boolean => items.some((other) => other.id !== item.id && isColliding(item, other));

/**
 * Posizione arrotondata al decimo di centimetro, per evitare aggiornamenti
 * di stato superflui durante il trascinamento.
 */
export const toPrecision = (value: number): number => Math.round(value * 10) / 10;
