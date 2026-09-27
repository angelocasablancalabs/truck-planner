import { useState, useEffect, useCallback } from 'react';
import type {
  VehicleConfig,
  PlacedItem,
  PalletDefinition,
  AddItemOptions,
  ItemPositionUpdate,
  LabelDensity,
  SequenceBatchItem,
} from './types';
import { VEHICLE_PRESETS, PALLET_CATALOG } from './constants';
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

/** Limiti di quantità per riga del modulo "Stiva Sequenza". */
const SEQUENCE_MIN_QUANTITY = 1;
const SEQUENCE_MAX_QUANTITY = 99;

export default function App() {
  const [vehicle, setVehicle] = useState<VehicleConfig>(VEHICLE_PRESETS[0]); // Default CC Olandese
  const [items, setItems] = useState<PlacedItem[]>([]);
  // Selezione multipla: lista ordinata di ID selezionati ([] = nessuna selezione).
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  // Densità delle etichette stampate sui colli (default: nome + quote).
  const [labelDensity, setLabelDensity] = useState<LabelDensity>('all');

  /** Imposta l'intera lista di selezione (sostituzione, non toggle). */
  const handleSelectItems = useCallback((ids: string[]) => {
    setSelectedItemIds(ids);
  }, []);

  // Aggiungi un nuovo collo al pianale, nel primo slot libero disponibile
  const handleAddItem = (pallet: PalletDefinition, options: AddItemOptions = {}) => {
    const width = options.width ?? (pallet.isBulk ? vehicle.width : pallet.width);
    const length = options.length ?? pallet.length;

    // Spawn intelligente first-fit: dalla Cabina verso le Porte, da sinistra a destra.
    const spawn = findSmartSpawnPosition(width, length, vehicle, items);

    const newItem: PlacedItem = {
      id: `${pallet.code}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      code: pallet.code,
      name: options.name ?? pallet.name,
      width,
      length,
      x: spawn.x,
      y: spawn.y,
      rotation: options.rotation ?? 0,
      color: pallet.color,
      borderColor: pallet.borderColor,
    };

    setItems((prev) => [...prev, newItem]);
    setSelectedItemIds([newItem.id]);
  };

  /**
   * Motore di Stiva Sequenziale (Multi-Tappa).
   *
   * Stiva i lotti nell'ordine della lista, riempiendo progressivamente il
   * pianale dalla Cabina verso le Porte posteriori: ogni collo viene piazzato
   * con `findSmartSpawnPosition` sul pianale GIÀ aggiornato dai colli
   * precedenti, così la sequenza di tappe risulta rispettata.
   *
   * @param batches Lotti da stivare, nell'ordine di consegna (tappa 1 → N).
   * @param mode    `replace` (default) azzera il carico corrente; `append` accoda.
   */
  const handleExecuteSequence = useCallback(
    (batches: SequenceBatchItem[], mode: 'replace' | 'append' = 'replace') => {
      if (batches.length === 0) return;

      setItems((prev) => {
        // Accumulatore locale: il pianale "corrente" su cui calcolare gli spawn.
        let current: PlacedItem[] = mode === 'replace' ? [] : [...prev];
        let counter = 0;

        for (const batch of batches) {
          const pallet = PALLET_CATALOG.find((p) => p.code === batch.palletCode);
          if (!pallet) continue;

          // Piatto: lato lungo verso Cabina/Porte (W = max, L = min).
          // Punta:  lato corto verso Cabina/Porte (W = min, L = max).
          const d1 = pallet.width;
          const d2 = pallet.length;
          const isPiatto = batch.orientation === 'piatto';
          const width = isPiatto ? Math.max(d1, d2) : Math.min(d1, d2);
          const length = isPiatto ? Math.min(d1, d2) : Math.max(d1, d2);

          const quantity = Math.min(
            SEQUENCE_MAX_QUANTITY,
            Math.max(SEQUENCE_MIN_QUANTITY, Math.floor(batch.quantity) || SEQUENCE_MIN_QUANTITY)
          );

          for (let i = 0; i < quantity; i++) {
            counter += 1;
            const spawn = findSmartSpawnPosition(width, length, vehicle, current);

            const newItem: PlacedItem = {
              id: `${pallet.code}_${Date.now()}_${counter}_${Math.random()
                .toString(36)
                .slice(2, 6)}`,
              code: pallet.code,
              name: batch.clientName.trim() || pallet.name,
              width,
              length,
              x: spawn.x,
              y: spawn.y,
              rotation: isPiatto ? 90 : 0,
              color: batch.color || pallet.color,
              borderColor: batch.borderColor || pallet.borderColor,
            };

            current = [...current, newItem];
          }
        }

        // Aggiornamento atomico finale: un solo nuovo riferimento di stato.
        return current;
      });

      setSelectedItemIds([]);
    },
    [vehicle]
  );

  /**
   * Aggiornamento simultaneo delle coordinate di più colli (drag singolo e di
   * gruppo): un solo setState per frame, con patch applicata per ID.
   */
  const handleUpdateItemsPos = useCallback((updates: ItemPositionUpdate[]) => {
    if (updates.length === 0) return;

    setItems((prev) => {
      const byId = new Map(updates.map((u) => [u.id, u]));
      let changed = false;

      const next = prev.map((item) => {
        const update = byId.get(item.id);
        if (!update) return item;
        if (update.x === item.x && update.y === item.y) return item;
        changed = true;
        return { ...item, x: update.x, y: update.y };
      });

      // Nessuna variazione reale: nessun nuovo riferimento, nessun render.
      return changed ? next : prev;
    });
  }, []);

  /**
   * Aggiornamento proprietà (Nome/Cliente, palette colori, ...) su uno o più
   * colli: accetta un singolo ID oppure l'array completo della selezione.
   */
  const handleUpdateItemProperties = useCallback(
    (target: string | string[], updates: Partial<PlacedItem>) => {
      const ids = Array.isArray(target) ? target : [target];
      if (ids.length === 0) return;

      const idSet = new Set(ids);
      setItems((prev) =>
        prev.map((item) => (idSet.has(item.id) ? { ...item, ...updates } : item))
      );
    },
    []
  );

  // Rotazione di 90 gradi ancorata al baricentro, con riallineamento magnetico.
  // Opera su tutti i colli selezionati (batch), ciascuno sul proprio baricentro.
  const handleRotateSelected = useCallback(() => {
    if (selectedItemIds.length === 0) return;
    const idSet = new Set(selectedItemIds);

    setItems((prev) =>
      prev.map((item) => {
        if (!idSet.has(item.id)) return item;

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
  }, [selectedItemIds, vehicle]);

  // Cancellazione di TUTTI i colli selezionati (batch) + svuotamento selezione.
  const handleDeleteSelected = useCallback(() => {
    if (selectedItemIds.length === 0) return;
    const idSet = new Set(selectedItemIds);
    setItems((prev) => prev.filter((item) => !idSet.has(item.id)));
    setSelectedItemIds([]);
  }, [selectedItemIds]);

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

  // Lista dei colli selezionati, nell'ordine di selezione.
  const selectedItems = selectedItemIds
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is PlacedItem => item !== undefined);

  return (
    <div className="flex h-screen w-screen bg-slate-100 overflow-hidden font-sans">
      {/* Sinistra: Telaio Camion */}
      <div className="flex-1 h-full">
        <TruckCanvas
          vehicle={vehicle}
          items={items}
          selectedItemIds={selectedItemIds}
          labelDensity={labelDensity}
          onChangeLabelDensity={setLabelDensity}
          onSelectItems={handleSelectItems}
          onUpdateItemsPos={handleUpdateItemsPos}
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
          onUpdateItemProperties={handleUpdateItemProperties}
          onExecuteSequence={handleExecuteSequence}
          onClearAll={() => {
            setItems([]);
            setSelectedItemIds([]);
          }}
          selectedItems={selectedItems}
          items={items}
        />
      </div>
    </div>
  );
}