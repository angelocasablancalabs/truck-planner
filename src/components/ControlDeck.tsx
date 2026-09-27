import React, { useState } from 'react';
import type { VehicleConfig, PlacedItem, PalletDefinition, AddItemOptions } from '../types';
import { VEHICLE_PRESETS, PALLET_CATALOG, CUSTOM_PALLET } from '../constants';
import { Truck, RotateCw, Trash2, Plus, Info, ArrowUpDown, ArrowLeftRight } from 'lucide-react';

/** Limiti fisici del collo "Formato Libero / Fuori Sagoma" (cm). */
const CUSTOM_MIN_WIDTH = 10;
const CUSTOM_MAX_WIDTH = 300;
const CUSTOM_MIN_LENGTH = 10;
const CUSTOM_MAX_LENGTH = 1500;

/**
 * Palette colori rapida per il collo selezionato: 7 pastiglie pastello
 * coordinate (fill tenue + bordo pieno alto contrasto), coerenti col catalogo.
 */
const COLOR_PALETTE = [
  { label: 'Grigio', fill: '#E2E8F0', border: '#475569' },
  { label: 'Giallo', fill: '#FEF08A', border: '#CA8A04' },
  { label: 'Arancio', fill: '#FED7AA', border: '#EA580C' },
  { label: 'Verde', fill: '#DCFCE7', border: '#16A34A' },
  { label: 'Azzurro', fill: '#BAE6FD', border: '#0284C7' },
  { label: 'Lilla', fill: '#F3E8FF', border: '#9333EA' },
  { label: 'Rosa/Corallo', fill: '#FFE4E6', border: '#E11D48' },
] as const;

interface ControlDeckProps {
  vehicle: VehicleConfig;
  onSelectVehicle: (v: VehicleConfig) => void;
  onAddItem: (pallet: PalletDefinition, options?: AddItemOptions) => void;
  onRotateSelected: () => void;
  onDeleteSelected: () => void;
  onClearAll: () => void;
  onUpdateItemProperties: (target: string | string[], updates: Partial<PlacedItem>) => void;
  selectedItems: PlacedItem[];
  items: PlacedItem[];
}

export const ControlDeck: React.FC<ControlDeckProps> = ({
  vehicle,
  onSelectVehicle,
  onAddItem,
  onRotateSelected,
  onDeleteSelected,
  onClearAll,
  onUpdateItemProperties,
  selectedItems,
  items,
}) => {
  const [bulkLength, setBulkLength] = useState<number>(2.0); // Metri per lo sfuso

  // Formato Libero / Fuori Sagoma: dimensioni e nome arbitrari
  const [customName, setCustomName] = useState<string>('Collo Custom');
  const [customWidth, setCustomWidth] = useState<number>(200);
  const [customLength, setCustomLength] = useState<number>(150);

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

  /**
   * Riga di 7 pastiglie colore: applica la tinta a TUTTI gli ID indicati
   * (singolo collo oppure gruppo, in un'unica patch di stato).
   * @param activeColor tinta comune alla selezione (null se i colli divergono).
   */
  const renderColorPalette = (ids: string[], activeColor: string | null) => (
    <div className="flex items-center gap-1.5">
      {COLOR_PALETTE.map((swatch) => {
        // Confronto case-insensitive: i colori di catalogo sono in HEX maiuscolo.
        const isActive = activeColor?.toLowerCase() === swatch.fill.toLowerCase();
        return (
          <button
            key={swatch.label}
            type="button"
            title={swatch.label}
            aria-label={`Colore ${swatch.label}`}
            onClick={() =>
              onUpdateItemProperties(ids, {
                color: swatch.fill,
                borderColor: swatch.border,
              })
            }
            className={`h-5 w-5 rounded-full border transition ${
              isActive
                ? 'ring-2 ring-blue-500 ring-offset-1'
                : 'hover:scale-110 hover:ring-1 hover:ring-slate-400'
            }`}
            style={{ backgroundColor: swatch.fill, borderColor: swatch.border }}
          />
        );
      })}
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

  // Calcolo statistiche veloci
  const countsByCode = items.reduce((acc, curr) => {
    acc[curr.name] = (acc[curr.name] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="w-full h-full bg-white border-l border-slate-200 flex flex-col p-5 overflow-y-auto space-y-6">
      {/* Header */}
      <div className="border-b border-slate-200 pb-3">
        <h1 className="text-xl font-black text-slate-800 tracking-tight flex items-center gap-2">
          <Truck className="w-6 h-6 text-blue-600" />
          TRUCK PLANNER
        </h1>
        <p className="text-xs text-slate-500 font-medium">Gestione Carico 2D Vettoriale</p>
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
      </div>

      {/* Catalogo Rapido Inserimento */}
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
            Aggiungi Colli
          </label>
          <button
            type="button"
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
        <div className="space-y-1">
          {PALLET_CATALOG.filter((p) => !p.isBulk).map((pallet) => {
            // Punta = lato corto verso le porte, Piatto = lato lungo verso le porte.
            const shortSide = Math.min(pallet.width, pallet.length);
            const longSide = Math.max(pallet.width, pallet.length);

            return (
              <div
                key={pallet.code}
                className="flex items-center justify-between p-1.5 px-2.5 rounded border border-slate-200 bg-white hover:border-slate-300 transition-colors"
              >
                {/* Identificativo collo */}
                <span className="flex items-center gap-1.5 min-w-0">
                  <span
                    className="w-3 h-3 rounded-sm border shrink-0"
                    style={{ backgroundColor: pallet.color, borderColor: pallet.borderColor }}
                  />
                  <span className="text-xs font-bold text-slate-800 tracking-tight truncate">
                    {pallet.name}
                  </span>
                </span>

                {/* Comandi rapidi: Piatto (prima scelta) / Punta */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {pallet.rotatable && (
                    <button
                      type="button"
                      onClick={() => onAddItem(pallet, { width: longSide, length: shortSide, rotation: 90 })}
                      title={`Aggiungi di Piatto (${longSide}×${shortSide} cm)`}
                      className="flex items-center gap-1 px-2 py-1 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-400 rounded transition"
                    >
                      <ArrowLeftRight className="w-3 h-3 text-slate-500" />
                      <span className="text-[10px] leading-none text-slate-700 font-semibold font-mono">
                        {longSide}×{shortSide}
                      </span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => onAddItem(pallet, { width: shortSide, length: longSide, rotation: 0 })}
                    title={`Aggiungi di Punta (${shortSide}×${longSide} cm)`}
                    className="flex items-center gap-1 px-2 py-1 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-400 rounded transition"
                  >
                    <ArrowUpDown className="w-3 h-3 text-slate-500" />
                    <span className="text-[10px] leading-none text-slate-700 font-semibold font-mono">
                      {shortSide}×{longSide}
                    </span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Blocco Collo Sfuso */}
        <div className="bg-white border border-slate-200 rounded p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 min-w-0">
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

        {/* Blocco Formato Libero / Fuori Sagoma */}
        <div className="bg-white border border-slate-200 rounded p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 min-w-0">
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
          </div>

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

          {/* Palette colori rapida (7 pastiglie): singola o batch sul gruppo */}
          <div className="space-y-1">
            <span className="block text-[10px] font-bold text-blue-900/70 uppercase tracking-wider">
              Colore
            </span>
            {renderColorPalette(selectedIds, selectedItem ? selectedItem.color : sharedColor)}
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

      {/* Scorciatoie da Tastiera */}
      <div className="mt-auto border-t border-slate-200 pt-3 text-[11px] text-slate-400 space-y-1">
        <div className="flex items-center gap-1 font-bold text-slate-500">
          <Info className="w-3.5 h-3.5" /> Scorciatoie:
        </div>
        <div>• <kbd className="bg-slate-100 px-1 rounded border">Spazio</kbd> : Ruota 90°</div>
        <div>• <kbd className="bg-slate-100 px-1 rounded border">Canc</kbd> : Elimina collo</div>
        <div>• <kbd className="bg-slate-100 px-1 rounded border">Ctrl</kbd>/<kbd className="bg-slate-100 px-1 rounded border">⌘</kbd>+<kbd className="bg-slate-100 px-1 rounded border">Click</kbd> : Selezione multipla</div>
        <div>• <kbd className="bg-slate-100 px-1 rounded border">Shift</kbd>+<kbd className="bg-slate-100 px-1 rounded border">Trascina</kbd> : Lasso di selezione</div>
        <div>• <kbd className="bg-slate-100 px-1 rounded border">Rotellina</kbd> : Pan verticale (Cabina ↔ Porte)</div>
        <div>• <kbd className="bg-slate-100 px-1 rounded border">Shift</kbd>+<kbd className="bg-slate-100 px-1 rounded border">Rotellina</kbd> : Pan orizzontale</div>
        <div>• <kbd className="bg-slate-100 px-1 rounded border">Ctrl</kbd>+<kbd className="bg-slate-100 px-1 rounded border">Rotellina</kbd> : Zoom ancorato al cursore</div>
      </div>
    </div>
  );
};