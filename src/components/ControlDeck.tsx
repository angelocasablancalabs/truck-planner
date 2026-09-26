import React, { useState } from 'react';
import type { VehicleConfig, PlacedItem, PalletDefinition } from '../types';
import { VEHICLE_PRESETS, PALLET_CATALOG } from '../constants';
import { Truck, RotateCw, Trash2, Plus, Info } from 'lucide-react';

interface ControlDeckProps {
  vehicle: VehicleConfig;
  onSelectVehicle: (v: VehicleConfig) => void;
  onAddItem: (pallet: PalletDefinition, customLength?: number) => void;
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
        <div className="flex gap-4 text-xs font-mono text-slate-500 bg-slate-50 p-2 rounded border border-slate-200">
          <span>L: {vehicle.length / 100} m</span>
          <span>W: {vehicle.width / 100} m</span>
        </div>
      </div>

      {/* Catalogo Rapido Inserimento */}
      <div className="space-y-3">
        <label className="text-xs font-bold text-slate-700 uppercase tracking-wider">
          Aggiungi Colli
        </label>
        <div className="grid grid-cols-2 gap-2">
          {PALLET_CATALOG.filter((p) => !p.isBulk).map((pallet) => (
            <button
              key={pallet.code}
              onClick={() => onAddItem(pallet)}
              className="flex items-center justify-between p-2.5 rounded border border-slate-200 hover:border-blue-500 hover:bg-blue-50 transition text-left text-xs font-medium text-slate-800 group"
            >
              <div>
                <div className="font-bold">{pallet.name}</div>
                <div className="text-[10px] text-slate-500 font-mono">
                  {pallet.width}×{pallet.length} cm
                </div>
              </div>
              <Plus className="w-4 h-4 text-slate-400 group-hover:text-blue-600" />
            </button>
          ))}
        </div>

        {/* Blocco Collo Sfuso */}
        <div className="p-3 bg-purple-50 border border-purple-200 rounded-md space-y-2">
          <div className="flex justify-between items-center">
            <span className="text-xs font-bold text-purple-900">Sfuso (Metri Lineari)</span>
            <span className="text-[10px] font-mono text-purple-700">W: {vehicle.width} cm</span>
          </div>
          <div className="flex gap-2">
            <input
              type="number"
              step="0.1"
              min="0.5"
              max="13.6"
              value={bulkLength}
              onChange={(e) => setBulkLength(parseFloat(e.target.value) || 1)}
              className="w-24 bg-white border border-purple-300 text-xs rounded p-1.5 font-mono"
            />
            <button
              onClick={() => {
                const bulkPallet = PALLET_CATALOG.find((p) => p.isBulk);
                if (bulkPallet) onAddItem(bulkPallet, bulkLength * 100);
              }}
              className="flex-1 bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold py-1.5 px-3 rounded flex items-center justify-center gap-1 transition"
            >
              <Plus className="w-3.5 h-3.5" /> Aggiungi Sfuso
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
              className="flex-1 bg-white hover:bg-red-50 border border-red-200 text-red-600 text-xs font-semibold py-1.5 rounded flex items-center justify-center gap-1 shadow-sm"
              title="Oppure premi Canc"
            >
              <Trash2 className="w-3.5 h-3.5" /> Cancella
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

      {/* Svuota Tutto */}
      {items.length > 0 && (
        <button
          onClick={onClearAll}
          className="w-full text-xs text-slate-400 hover:text-red-500 transition py-1 text-center"
        >
          Svuota completamente il pianale
        </button>
      )}
    </div>
  );
};