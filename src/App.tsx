import { useState, useEffect, useCallback } from 'react';
import type { VehicleConfig, PlacedItem, PalletDefinition } from './types';
import { VEHICLE_PRESETS } from './constants';
import { TruckCanvas } from './components/TruckCanvas';
import { ControlDeck } from './components/ControlDeck';

export default function App() {
  const [vehicle, setVehicle] = useState<VehicleConfig>(VEHICLE_PRESETS[0]); // Default CC Olandese
  const [items, setItems] = useState<PlacedItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  // Aggiungi un nuovo collo al pianale
  const handleAddItem = (pallet: PalletDefinition, customLength?: number) => {
    const width = pallet.isBulk ? vehicle.width : pallet.width;
    const length = customLength || pallet.length;

    const newItem: PlacedItem = {
      id: `${pallet.code}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      code: pallet.code,
      name: pallet.name,
      width,
      length,
      x: 0,
      y: 0, // Posizionato provvisoriamente a inizio cabina
      rotation: 0,
      color: pallet.color,
      borderColor: pallet.borderColor,
    };

    setItems((prev) => [...prev, newItem]);
    setSelectedItemId(newItem.id);
  };

  // Aggiornamento coordinate X, Y
  const handleUpdateItemPos = (id: string, x: number, y: number) => {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, x, y } : item))
    );
  };

  // Rotazione di 90 gradi
  const handleRotateSelected = useCallback(() => {
    if (!selectedItemId) return;
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== selectedItemId) return item;
        // Inverte larghezza e lunghezza
        const newWidth = item.length;
        const newLength = item.width;
        // Controlla che non sbordi dopo la rotazione
        const clampedX = Math.min(item.x, vehicle.width - newWidth);
        const clampedY = Math.min(item.y, vehicle.length - newLength);

        return {
          ...item,
          width: newWidth,
          length: newLength,
          rotation: (item.rotation + 90) % 180,
          x: Math.max(0, clampedX),
          y: Math.max(0, clampedY),
        };
      })
    );
  }, [selectedItemId, vehicle]);

  // Cancellazione dell'elemento selezionato
  const handleDeleteSelected = useCallback(() => {
    if (!selectedItemId) return;
    setItems((prev) => prev.filter((item) => item.id !== selectedItemId));
    setSelectedItemId(null);
  }, [selectedItemId]);

  // Gestione scorciatoie da tastiera (Spazio e Canc)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
        return; // Non intercettare se si sta scrivendo in un input
      }

      if (e.code === 'Space') {
        e.preventDefault();
        handleRotateSelected();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        handleDeleteSelected();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleRotateSelected, handleDeleteSelected]);

  const selectedItem = items.find((i) => i.id === selectedItemId) || null;

  return (
    <div className="flex h-screen w-screen bg-slate-100 overflow-hidden font-sans">
      {/* Sinistra: Telaio Camion */}
      <div className="flex-1 h-full">
        <TruckCanvas
          vehicle={vehicle}
          items={items}
          selectedItemId={selectedItemId}
          onSelectItem={setSelectedItemId}
          onUpdateItemPos={handleUpdateItemPos}
        />
      </div>

      {/* Destra: Plancia di Comando */}
      <div className="w-80 md:w-96 h-full flex-shrink-0">
        <ControlDeck
          vehicle={vehicle}
          onSelectVehicle={setVehicle}
          onAddItem={handleAddItem}
          onRotateSelected={handleRotateSelected}
          onDeleteSelected={handleDeleteSelected}
          onClearAll={() => {
            setItems([]);
            setSelectedItemId(null);
          }}
          selectedItem={selectedItem}
          items={items}
        />
      </div>
    </div>
  );
}