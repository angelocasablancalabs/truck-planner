import type { VehicleConfig, PalletDefinition } from './types';

// Preset dei camion della vostra flotta
export const VEHICLE_PRESETS: VehicleConfig[] = [
  { id: 'bilico_cc', name: 'Bilico frigo Fiori (2,50 × 13,28 m)', width: 250, length: 1328 },
  { id: 'bilico_std', name: 'Bilico frigo Standard (2,46 × 13,60 m)', width: 246, length: 1360 },
  { id: 'motrice_3a', name: 'Motrice 3 Assi (2,50 × 7,60 m)', width: 250, length: 760 },
  { id: 'custom', name: 'Personalizzato...', width: 250, length: 1360 },
];

// Il catalogo con i formati ufficiali concordati
export const PALLET_CATALOG: PalletDefinition[] = [
  {
    code: 'INDU',
    name: 'PLT INDU',
    width: 100,
    length: 120,
    color: '#E2E8F0', // Grigio sobrio
    borderColor: '#475569',
    rotatable: true,
  },
  {
    code: 'EUR',
    name: 'PLT EUR',
    width: 80,
    length: 120,
    color: '#FEF08A', // Giallo tenue
    borderColor: '#CA8A04',
    rotatable: true,
  },
  {
    code: 'HALF_EUR',
    name: 'PLT ½ EUR',
    width: 80,
    length: 60,
    color: '#FED7AA', // Arancio pastello
    borderColor: '#EA580C',
    rotatable: true,
  },
  {
    code: 'CC',
    name: 'CC',
    width: 56.5,
    length: 135,
    color: '#DCFCE7', // Verde menta
    borderColor: '#16A34A',
    rotatable: true,
  },
  {
    code: 'EC',
    name: 'EC',
    width: 61,
    length: 81,
    color: '#BAE6FD', // Azzurro tenue
    borderColor: '#0284C7',
    rotatable: true,
  },
  {
    code: 'SFUSO',
    name: 'Sfuso (Metri)',
    width: 250, // Adattato dinamicamente alla larghezza camion
    length: 200, // 2 metri default
    color: '#F3E8FF', // Lilla pastello
    borderColor: '#9333EA',
    rotatable: false,
    isBulk: true,
  },
];