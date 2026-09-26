import { useState, useEffect, useCallback } from 'react';
import type { VehicleConfig, PlacedItem, PalletDefinition, AddItemOptions } from './types';
import { VEHICLE_PRESETS } from './constants';
import { TruckCanvas } from './components/TruckCanvas';
import { ControlDeck } from './components/ControlDeck';
import {
  calculateSnapPosition,
  findSmartSpawnPosition,
  isColliding,
  toPrecision,
} from './utils/snapping';

/** Tolleranza di aggancio magnetico applicata dopo una rotazione (cm). */
const ROTATION_SNAP_THRESHOLD = 10;

export default function App() {
  const [vehicle, setVehicle] = useState<VehicleConfig>(VEHICLE_PRESETS[0]); // Default CC Olandese
  const [items, setItems] = useState<PlacedItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  // Aggiungi un nuovo collo al pianale, nel primo slot libero disponibile
  const handleAddItem = (pallet: PalletDefinition, options: AddItemOptions = {}) => {
    const width = options.width ?? (pallet.isBulk ? vehicle.width : pallet.width);
    const length = options.length ?? pallet.length;

    // Spawn intelligente first-fit: dalla Cabina verso le Porte, da sinistra a destra.
    const spawn = findSmartSpawnPosition(width, length, vehicle, items);

    const newItem: PlacedItem = {
      id: `${pallet.code}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      code: pallet.code,
      name: pallet.name,
      width,
      length,
      x: spawn.x,
      y: spawn.y,
      rotation: options.rotation ?? 0,
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

  // Rotazione di 90 gradi ancorata al baricentro, con riallineamento magnetico
  const handleRotateSelected = useCallback(() => {
    if (!selectedItemId) return;
    setItems((prev) =>
      prev.map((item) => {
        if (item.id !== selectedItemId) return item;

        // Il collo fa perno sul proprio centro geometrico: inverte i lati
        // mantenendo il baricentro, poi rientra nelle pareti del mezzo.
        const newWidth = item.length;
        const newLength = item.width;
        const centerX = item.x + item.width / 2;
        const centerY = item.y + item.length / 2;
        const rawX = centerX - newWidth / 2;
        const rawY = centerY - newLength / 2;

        const clampedX = Math.max(0, Math.min(vehicle.width - newWidth, rawX));
        const clampedY = Math.max(0, Math.min(vehicle.length - newLength, rawY));

        // Riallineamento magnetico al bordo/parete più vicina (tolleranza 10 cm).
        const others = prev.filter((other) => other.id !== item.id);
        const snapped = calculateSnapPosition(
          clampedX,
          clampedY,
          newWidth,
          newLength,
          vehicle,
          others,
          ROTATION_SNAP_THRESHOLD
        );

        // Adotta l'assestamento solo se non introduce sovrapposizioni.
        const snappedCollides = others.some((other) =>
          isColliding(
            { ...item, width: newWidth, length: newLength, x: snapped.x, y: snapped.y },
            other
          )
        );

        return {
          ...item,
          width: newWidth,
          length: newLength,
          rotation: (item.rotation + 90) % 180,
          x: toPrecision(snappedCollides ? clampedX : snapped.x),
          y: toPrecision(snappedCollides ? clampedY : snapped.y),
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