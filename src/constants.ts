import type { VehicleConfig, PalletDefinition } from './types';

// Preset dei camion della vostra flotta
export const VEHICLE_PRESETS: VehicleConfig[] = [
  { id: 'bilico_cc', name: 'Bilico frigo Fiori (2,50 × 13,28 m)', width: 250, length: 1328 },
  { id: 'bilico_std', name: 'Bilico frigo Standard (2,45 × 13,28 m)', width: 245, length: 1328 },
  { id: 'motrice_3a', name: 'Motrice 3 Assi (2,50 × 7,60 m)', width: 250, length: 760 },
  { id: 'custom', name: 'Personalizzato...', width: 250, length: 1360 },
];

/**
 * Bordo unico dei colli di catalogo: grigio antracite scuro.
 * Il rosso `ALERT_COLOR` resta così riservato alle sole condizioni di allarme
 * (collisione o fuori sagoma) e non può essere confuso con un bordo normale.
 */
export const ITEM_BORDER_COLOR = '#334155';

// Il catalogo con i formati ufficiali concordati
export const PALLET_CATALOG: PalletDefinition[] = [
  {
    code: 'INDU',
    name: 'PLT INDU',
    width: 100,
    length: 120,
    color: '#E2E8F0', // Grigio sobrio
    borderColor: ITEM_BORDER_COLOR,
    rotatable: true,
  },
  {
    code: 'EUR',
    name: 'PLT EUR',
    width: 80,
    length: 120,
    color: '#FEF08A', // Giallo tenue
    borderColor: ITEM_BORDER_COLOR,
    rotatable: true,
  },
  {
    code: 'HALF_EUR',
    name: 'PLT ½ EUR',
    width: 80,
    length: 60,
    color: '#FED7AA', // Arancio pastello
    borderColor: ITEM_BORDER_COLOR,
    rotatable: true,
  },
  {
    code: 'CC',
    name: 'CC',
    width: 56.5,
    length: 135,
    color: '#DCFCE7', // Verde menta
    borderColor: ITEM_BORDER_COLOR,
    rotatable: true,
  },
  {
    code: 'EC',
    name: 'EC',
    width: 61,
    length: 81,
    color: '#BAE6FD', // Azzurro tenue
    borderColor: ITEM_BORDER_COLOR,
    rotatable: true,
  },
  {
    code: 'SFUSO',
    name: 'Sfuso (Metri)',
    width: 250, // Adattato dinamicamente alla larghezza camion
    length: 200, // 2 metri default
    color: '#F3E8FF', // Lilla pastello
    borderColor: ITEM_BORDER_COLOR,
    rotatable: false,
    isBulk: true,
  },
];

/**
 * Collo `CUSTOM` — Formato Libero / Fuori Sagoma.
 * Non compare nel catalogo a righe dense: viene istanziato dal pannello
 * dedicato con dimensioni arbitrarie (W × L) e nome/cliente personalizzato.
 */
export const CUSTOM_PALLET: PalletDefinition = {
  code: 'CUSTOM',
  name: 'Collo Custom',
  width: 200,
  length: 150,
  color: '#CBD5E1', // Grigio neutro di base
  borderColor: '#475569',
  rotatable: true,
};

/* -------------------------------------------------------------------------- *
 *  QUOTE E CONTATORI DEL PIANALE (condivisi tra canvas a schermo ed export PNG)
 * -------------------------------------------------------------------------- */

/** Colore riservato alle SOLE condizioni di allarme (collisione / fuori sagoma). */
export const ALERT_COLOR = '#EF4444';

/** Quota nominale del pianale standard: 13,20 m (cm reali). */
export const NOMINAL_QUOTA_CM = 1320;

/** Colore della linea di quota nominale (grigio ardesia tenue). */
export const NOMINAL_QUOTA_COLOR = '#94A3B8';

/** Colore della linea guida del contatore dinamico LDM (metri lineari occupati). */
export const LDM_GUIDE_COLOR = '#2563EB';

/** Colore di fondo del badge LDM (slate scuro ad alto contrasto). */
export const LDM_BADGE_COLOR = '#1E293B';

/**
 * Geometria del badge LDM, in centimetri reali (= unità del mondo vettoriale),
 * così che canvas a schermo ed export PNG restino perfettamente coerenti.
 */
export const LDM_BADGE = {
  /** Larghezza del rettangolo (cm). */
  width: 64,
  /** Altezza del rettangolo (cm). */
  height: 22,
  /** Distanza tra la parete sinistra del pianale e il bordo destro del badge. */
  rightGap: 50,
} as const;

/** Coordinata X del bordo sinistro del badge LDM (a sinistra del pianale). */
export const LDM_BADGE_LEFT_X = -(LDM_BADGE.rightGap + LDM_BADGE.width);

/** Coordinata X del centro del testo del badge LDM. */
export const LDM_BADGE_CENTER_X = -(LDM_BADGE.rightGap + LDM_BADGE.width / 2);

/** Spazio minimo (cm) da riservare a sinistra per il badge LDM. */
export const LDM_BADGE_RESERVED_LEFT = LDM_BADGE.rightGap + LDM_BADGE.width + 4;