import React, { useState } from 'react';
import type { VehicleConfig, PlacedItem, PalletDefinition, AddItemOptions } from '../types';
import { VEHICLE_PRESETS, PALLET_CATALOG } from '../constants';
import { Truck, RotateCw, Trash2, Plus, Info, ArrowUpDown, ArrowLeftRight } from 'lucide-react';

interface ControlDeckProps {
  vehicle: VehicleConfig;
  onSelectVehicle: (v: VehicleConfig) => void;
  onAddItem: (pallet: PalletDefinition, options?: AddItemOptions) => void;
  onRotateSelected: () => void;
  onDeleteSelected: () => void;
  onClearAll: () => void;
  selectedItem: PlacedItem | null;
  items: PlacedItem[];
}

export const ControlDeck: React.FC<ControlDeckProps> = ({
  vehicle,
  onSelectVehicle,
  onAddItem,
  onRotateSelected,
  onDeleteSelected,
  onClearAll,
  selectedItem,
  items,
}) => {
  const [bulkLength, setBulkLength] = useState<number>(2.0); // Metri per lo sfuso

  // Definizione di catalogo del collo sfuso (legenda colore + dimensioni)
  const bulkPallet = PALLET_CATALOG.find((p) => p.isBulk);

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
      </div>

      {/* Azioni Rapide Oggetto Selezionato */}
      {selectedItem && (
        <div className="p-3 bg-blue-50 border border-blue-200 rounded-md space-y-2">
          <div className="text-xs font-bold text-blue-900">
            Selezionato: {selectedItem.name} ({selectedItem.width}×{selectedItem.length} cm)
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
              <Trash2 className="w-3.5 h-3.5 text-red-800" /> Cancella
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
      </div>
    </div>
  );
};