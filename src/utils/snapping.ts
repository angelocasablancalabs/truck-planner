import type { VehicleConfig, PlacedItem } from '../types';
import { LDM_SYMMETRY_TOLERANCE_CM } from '../constants';

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
 * Ampiezza (cm) della **corsia di parete** (Wall Lane): la fascia di pianale a
 * ridosso di ciascuna sponda laterale entro cui un collo è considerato
 * appoggiato a quella parete.
 *
 * - Fascia parete SINISTRA: `X <= 50 cm`;
 * - Fascia parete DESTRA: `X + W >= vehicle.width - 50 cm`.
 */
export const WALL_ZONE_THRESHOLD = 50;

/**
 * Ingombro LDM (metri lineari occupati) di un pianale, calcolato con la
 * **Regola della Corsia di Parete** (Wall Lane Rule).
 *
 * Un collo impegna una corsia di parete solo se la **tocca davvero**:
 * - collo a **tutta larghezza** (larghezza ≥ 60% della larghezza utile, es.
 *   `SFUSO`) → occupa inevitabilmente entrambe le corsie;
 * - collo che appoggia alla fascia sinistra (`X <= 50`) → corsia sinistra;
 * - collo che raggiunge la fascia destra (`X + W >= width − 50`) → corsia destra;
 * - collo **puramente centrale** (nessuna delle due fasce) → viene attribuito
 *   alla metà di pianale in cui **inizia** (`X < midX` → sinistra, altrimenti
 *   destra). Attribuirlo al proprio baricentro era la causa del caso limite
 *   diagnosticato: in una fila da 4 carrelli EC (`X = 0, 61, 122, 183`) il terzo
 *   carrello, con centro a 152,5 cm > mezzeria (125 cm), risultava copertura del
 *   lato destro pur non raggiungendo la fascia di parete destra (200 cm),
 *   facendo sparire l'indicatore destro con la **4ª colonna completamente
 *   vuota**. Con il bordo sinistro il terzo carrello (X = 122 < 125) resta sul
 *   lato sinistro e la corsia destra vuota viene finalmente segnalata.
 */
export interface LdmMetrics {
  /** Ingombro (cm) del lato sinistro, misurato dalla Cabina. */
  leftY: number;
  /** Ingombro (cm) del lato destro, misurato dalla Cabina. */
  rightY: number;
  /** `true` se i due lati differiscono di almeno 1 cm (`LDM_SYMMETRY_TOLERANCE_CM`). */
  isAsymmetric: boolean;
  /** Ingombro massimo (cm) tra i due lati: riferimento del caso simmetrico. */
  maxOccupiedY: number;
}

/**
 * Calcola l'ingombro LDM dei due lati del pianale con la Regola della Corsia di
 * Parete.
 *
 * Funzione **pura** condivisa da canvas a schermo (`TruckCanvas.tsx`), export PNG
 * (`utils/export.ts`) e scheda di stampa A4 (`PrintReport.tsx`): un'unica fonte
 * di verità, nessuna discrepanza possibile tra le tre rese.
 *
 * @param vehicle Configurazione del mezzo (dimensioni utili in cm)
 * @param items   Colli stivati sul pianale
 */
export function calculateLdmMetrics(vehicle: VehicleConfig, items: PlacedItem[]): LdmMetrics {
  const midX = vehicle.width / 2;
  const wideThreshold = vehicle.width * 0.6; // colli a tutta larghezza (es. Sfuso)
  const wallZone = WALL_ZONE_THRESHOLD; // cm dalla parete

  let leftY = 0;
  let rightY = 0;

  for (const item of items) {
    const bottom = item.y + item.length;
    const rightEdge = item.x + item.width;
    const isWide = item.width >= wideThreshold;

    if (isWide) {
      // Collo a tutta larghezza (es. Sfuso): impegna entrambe le corsie.
      if (bottom > leftY) leftY = bottom;
      if (bottom > rightY) rightY = bottom;
      continue;
    }

    // Corsia di parete: il collo deve TOCCARE la fascia per impegnare quel lato.
    const touchesLeftWallZone = item.x <= wallZone;
    const touchesRightWallZone = rightEdge >= vehicle.width - wallZone;

    if (touchesLeftWallZone && bottom > leftY) {
      leftY = bottom;
    }
    if (touchesRightWallZone && bottom > rightY) {
      rightY = bottom;
    }

    // Fallback per i colli puramente centrali che non toccano nessuna delle due
    // fasce di parete: il lato è deciso dal **bordo sinistro** (dove il collo
    // inizia), non dal baricentro, così una fila da 4 che si ferma alla 3ª
    // colonna non può far sembrare coperta la corsia di parete destra rimasta
    // vuota.
    if (!touchesLeftWallZone && !touchesRightWallZone) {
      if (item.x < midX && bottom > leftY) {
        leftY = bottom;
      } else if (item.x >= midX && bottom > rightY) {
        rightY = bottom;
      }
    }
  }

  const isAsymmetric =
    items.length > 0 && Math.abs(leftY - rightY) >= LDM_SYMMETRY_TOLERANCE_CM;
  const maxOccupiedY = Math.max(leftY, rightY);
  return { leftY, rightY, isAsymmetric, maxOccupiedY };
}

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
 * Il vincolo di lunghezza NON è più un muro alla linea delle porte: la ricerca
 * prosegue identica nella zona di sforamento posteriore fino a
 * `vehicle.length + REAR_OVERHANG_LIMIT`, così i colli in eccesso continuano a
 * disporsi a file ordinate affiancate da sinistra a destra (e non più tutti
 * impilati in un'unica colonna a X = 0). Il vincolo laterale resta invece
 * RIGIDO: nessun collo può sbordare dalle pareti del mezzo.
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

  /** Fondo massimo consentito nella zona di sforamento posteriore (cm). */
  const maxBottomY = vehicle.length + REAR_OVERHANG_LIMIT;

  /** Un candidato è valido se non sborda dalle pareti né collide con altri colli. */
  const fitsSagomaLaterale = (x: number): boolean => x + width <= vehicle.width;
  const isFree = (x: number, y: number): boolean =>
    !items.some((other) => isRectColliding(x, y, width, length, other));

  // 1ª passata: first-fit dentro la sagoma utile, estesa alla zona di sforamento
  // posteriore consentita (Y + lunghezza ≤ vehicle.length + REAR_OVERHANG_LIMIT).
  for (const y of yCandidates) {
    for (const x of xCandidates) {
      // Pareti laterali RIGIDE: i colli non devono mai sbordare a destra...
      if (!fitsSagomaLaterale(x)) continue;
      // ...sforamento posteriore ammesso solo entro il buffer di 150 cm...
      if (y + length > maxBottomY) continue;
      // ...e nessuna sovrapposizione con i colli già presenti.
      if (!isFree(x, y)) continue;
      return { x, y };
    }
  }

  // 2ª passata: il first-fit CONTINUA a file ordinate anche oltre il buffer di
  // sforamento, mantenendo il solo blocco laterale. Serve a far affiancare i
  // colli in eccesso (X = 0, X = 120, …) alla stessa quota, invece di impilarli
  // in un'unica colonna sinistra; l'allarme rosso `isOutOfBounds` li segnala.
  for (const y of yCandidates) {
    for (const x of xCandidates) {
      if (!fitsSagomaLaterale(x)) continue;
      if (!isFree(x, y)) continue;
      return { x, y };
    }
  }

  // Ultima rete di sicurezza (es. collo più largo del pianale, nessun candidato
  // utilizzabile): accoda il collo a fila sotto il più avanzato, anche a costo
  // di sbordare oltre le porte posteriori ("verità visiva del piazzale": nessun
  // clamp che lo spingerebbe sopra i bancali già caricati creando false
  // collisioni interne).
  const maxY = items.reduce((max, item) => Math.max(max, item.y + item.length), 0);
  return { x: 0, y: maxY };
}


/**
 * Posizione arrotondata al decimo di centimetro, per evitare aggiornamenti
 * di stato superflui durante il trascinamento.
 */
export const toPrecision = (value: number): number => Math.round(value * 10) / 10;
