import { useState, useEffect, useCallback, useRef } from 'react';
import type {
  VehicleConfig,
  PlacedItem,
  PalletDefinition,
  AddItemOptions,
  ItemPositionUpdate,
  LabelDensity,
  SideNote,
  HistorySnapshot,
} from './types';
import { VEHICLE_PRESETS, ITEM_BORDER_COLOR } from './constants';
import { TruckCanvas } from './components/TruckCanvas';
import { ControlDeck } from './components/ControlDeck';
import { PrintReport } from './components/PrintReport';
import {
  calculateSnapPosition,
  findSmartSpawnPosition,
  isColliding,
  toPrecision,
} from './utils/snapping';

/** Tolleranza di aggancio magnetico applicata dopo una rotazione (cm). */
const ROTATION_SNAP_THRESHOLD = 10;

/** Limiti di quantità di un lotto caricato dall'accordion multifunzione. */
const BATCH_MIN_QUANTITY = 1;
const BATCH_MAX_QUANTITY = 99;
const BATCH_DEFAULT_QUANTITY = 10;

/** Numero massimo di fotogrammi conservati nella pila `past` (FIFO). */
const HISTORY_LIMIT = 40;

/**
 * Copia profonda dello stato di stiva: uno snapshot non condivide mai alcun
 * riferimento con lo stato vivo (né tra due fotogrammi distinti).
 */
const cloneSnapshot = (items: PlacedItem[], notes: SideNote[]): HistorySnapshot => ({
  items: items.map((item) => ({ ...item })),
  notes: notes.map((note) => ({ ...note })),
});

/**
 * Accoda un fotogramma alla pila e la riporta al limite `HISTORY_LIMIT`,
 * scartando i fotogrammi più vecchi (politica FIFO): la memoria della cronologia
 * resta limitata anche sulle sessioni di carico più lunghe.
 */
const appendSnapshot = (
  stack: HistorySnapshot[],
  snapshot: HistorySnapshot
): HistorySnapshot[] => {
  const next = [...stack, snapshot];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
};

export default function App() {
  const [vehicle, setVehicle] = useState<VehicleConfig>(VEHICLE_PRESETS[0]); // Default CC Olandese
  const [items, setItems] = useState<PlacedItem[]>([]);
  // Selezione multipla: lista ordinata di ID selezionati ([] = nessuna selezione).
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  // Densità delle etichette stampate sui colli (default: nome + quote).
  const [labelDensity, setLabelDensity] = useState<LabelDensity>('all');
  // Note laterali di carico: avvertenze posizionate a fianco dei bancali.
  const [notes, setNotes] = useState<SideNote[]>([]);
  // Nota attualmente selezionata (null = nessuna): alimenta il pannello sidebar.
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  // Targa / identificativo del mezzo: campo libero (es. "XA000BB COME ARRIVA").
  // Alimenta il badge tecnico sopra la Cabina, lo snapshot PNG e la scheda A4.
  const [vehiclePlate, setVehiclePlate] = useState<string>('');

  /* ------------------------------------------------------------------------ *
   *  MOTORE UNDO / REDO (CRONOLOGIA A SNAPSHOT)
   *
   *  `past`   → pila degli stati passati (limite 40, politica FIFO);
   *  `future` → pila degli stati futuri, alimentata dagli Undo per i Redo.
   *
   *  Ogni mutazione intenzionale della stiva registra un fotogramma **prima**
   *  di avvenire (`pushSnapshot`). I gesti con il mouse fanno eccezione: il
   *  movimento del puntatore NON produce snapshot, perché il fotogramma viene
   *  scattato al `pointerDown` e convalidato al `pointerUp` solo se il
   *  trascinamento ha davvero spostato qualcosa — l'intero drag vale così come
   *  **un singolo passo** di Undo.
   * ------------------------------------------------------------------------ */
  const [past, setPast] = useState<HistorySnapshot[]>([]);
  const [future, setFuture] = useState<HistorySnapshot[]>([]);
  /** Fotogramma "in sospeso" del gesto col mouse in corso (drag di collo / nota). */
  const pendingSnapshot = useRef<HistorySnapshot | null>(null);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  /**
   * Registra lo stato corrente nella pila dei passati e svuota quella dei
   * futuri (una nuova azione invalida sempre il Redo).
   * Va invocata **prima** di ogni mutazione intenzionale di colli o note.
   */
  const pushSnapshot = useCallback(() => {
    setPast((prev) => appendSnapshot(prev, cloneSnapshot(items, notes)));
    setFuture([]);
  }, [items, notes]);

  /**
   * Inizio di un gesto col mouse (pointerDown su un collo o su una nota):
   * memorizza il fotogramma di partenza senza ancora convalidarlo, perché il
   * trascinamento potrebbe risolversi in un semplice click senza spostamenti.
   */
  const handleBeginHistoryGesture = useCallback(() => {
    pendingSnapshot.current = cloneSnapshot(items, notes);
  }, [items, notes]);

  /**
   * Fine del gesto (pointerUp): convalida il fotogramma in sospeso **solo** se
   * il trascinamento ha realmente modificato lo stato. In caso contrario il
   * gesto è stato un click e non lascia alcuna traccia nella cronologia.
   */
  const handleCommitHistoryGesture = useCallback((changed: boolean) => {
    const snapshot = pendingSnapshot.current;
    pendingSnapshot.current = null;
    if (!changed || !snapshot) return;
    setPast((prev) => appendSnapshot(prev, snapshot));
    setFuture([]);
  }, []);

  /** Ripristina uno snapshot nella stiva, ripulendo le selezioni orfane. */
  const restoreSnapshot = useCallback((snapshot: HistorySnapshot) => {
    const restored = cloneSnapshot(snapshot.items, snapshot.notes);
    setItems(restored.items);
    setNotes(restored.notes);
    // Selezione: sopravvivono solo gli ID ancora presenti nello stato ripristinato,
    // così nessun pannello resta appeso a un collo o a una nota che non esistono più.
    setSelectedItemIds((prev) =>
      prev.filter((id) => restored.items.some((item) => item.id === id))
    );
    setSelectedNoteId((prev) =>
      prev !== null && restored.notes.some((note) => note.id === prev) ? prev : null
    );
  }, []);

  /** Annulla l'ultima azione: l'ultimo fotogramma di `past` torna in scena. */
  const handleUndo = useCallback(() => {
    if (past.length === 0) return;
    const snapshot = past[past.length - 1];
    setPast((prev) => prev.slice(0, -1));
    setFuture((prev) => [...prev, cloneSnapshot(items, notes)]);
    restoreSnapshot(snapshot);
  }, [past, items, notes, restoreSnapshot]);

  /** Ripristina l'azione annullata: simmetrico esatto di `handleUndo`. */
  const handleRedo = useCallback(() => {
    if (future.length === 0) return;
    const snapshot = future[future.length - 1];
    setFuture((prev) => prev.slice(0, -1));
    setPast((prev) => appendSnapshot(prev, cloneSnapshot(items, notes)));
    restoreSnapshot(snapshot);
  }, [future, items, notes, restoreSnapshot]);

  /** Imposta l'intera lista di selezione (sostituzione, non toggle). */
  const handleSelectItems = useCallback((ids: string[]) => {
    setSelectedItemIds(ids);
  }, []);

  // Aggiungi un nuovo collo al pianale, nel primo slot libero disponibile
  const handleAddItem = (pallet: PalletDefinition, options: AddItemOptions = {}) => {
    // Fotogramma PRIMA della mutazione: l'aggiunta è un passo di Undo.
    pushSnapshot();

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
      // Bordo RIGIDO: qualunque sia la tinta assegnata al collo, il contorno
      // resta sempre l'antracite uniforme `ITEM_BORDER_COLOR`. Il rosso è
      // riservato alle sole condizioni di allarme, il blu alla selezione.
      borderColor: ITEM_BORDER_COLOR,
    };

    setItems((prev) => [...prev, newItem]);
    setSelectedItemIds([newItem.id]);
  };

  /**
   * Motore Batch dell'Accordion Multifunzione.
   *
   * Stiva `quantity` colli dello stesso formato in un unico ciclo sincrono:
   * ogni collo viene piazzato con `findSmartSpawnPosition` sul pianale GIÀ
   * aggiornato dai colli precedenti, così il lotto si dispone progressivamente
   * dalla Cabina verso le Porte posteriori (first-fit, senza sovrapposizioni).
   * Un solo `setItems` finale: aggiornamento atomico, un solo render.
   *
   * @param pallet      Voce di catalogo (formato, colore e dimensioni di base).
   * @param quantity    Numero di colli da stivare (clampato 1–99).
   * @param orientation `piatto` → W = max, L = min; `punta` → W = min, L = max.
   * @param name        Cliente / nome lotto (default: nome del catalogo).
   * @param color       Tinta di riempimento del lotto (default: tinta di catalogo).
   */
  const handleAddBatch = useCallback(
    (
      pallet: PalletDefinition,
      quantity: number,
      orientation: 'piatto' | 'punta',
      name?: string,
      color?: string
    ) => {
      // Fotogramma PRIMA della mutazione: l'intero lotto è UN passo di Undo.
      pushSnapshot();

      const requested = Number.isFinite(quantity)
        ? Math.floor(quantity)
        : BATCH_DEFAULT_QUANTITY;
      const qty = Math.min(
        BATCH_MAX_QUANTITY,
        Math.max(BATCH_MIN_QUANTITY, requested || BATCH_DEFAULT_QUANTITY)
      );

      // Piatto: lato lungo verso Cabina/Porte (W = max, L = min).
      // Punta:  lato corto verso Cabina/Porte (W = min, L = max).
      const d1 = pallet.width;
      const d2 = pallet.length;
      const isPiatto = orientation === 'piatto';
      const width = isPiatto ? Math.max(d1, d2) : Math.min(d1, d2);
      const length = isPiatto ? Math.min(d1, d2) : Math.max(d1, d2);

      const itemName = name?.trim() || pallet.name;
      const itemColor = color || pallet.color;
      const stamp = Date.now();

      setItems((prev) => {
        // Accumulatore locale: è il pianale "corrente" su cui calcolare gli spawn.
        let current = [...prev];

        for (let i = 0; i < qty; i++) {
          const spawn = findSmartSpawnPosition(width, length, vehicle, current);

          const newItem: PlacedItem = {
            id: `${pallet.code}_${stamp}_${i}_${Math.random().toString(36).slice(2, 6)}`,
            code: pallet.code,
            name: itemName,
            width,
            length,
            x: spawn.x,
            y: spawn.y,
            rotation: isPiatto ? 90 : 0,
            color: itemColor,
            // Bordo rigido: la tinta del lotto colora solo il riempimento.
            borderColor: ITEM_BORDER_COLOR,
          };

          current = [...current, newItem];
        }

        // Aggiornamento atomico finale: un solo nuovo riferimento di stato.
        return current;
      });

      setSelectedItemIds([]);
    },
    [vehicle, pushSnapshot]
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

      // Fotogramma PRIMA della mutazione (rinnovo, rinomina o ricolorazione).
      pushSnapshot();

      const idSet = new Set(ids);
      setItems((prev) =>
        prev.map((item) => (idSet.has(item.id) ? { ...item, ...updates } : item))
      );
    },
    [pushSnapshot]
  );

  // Rotazione di 90 gradi ancorata al baricentro, con riallineamento magnetico.
  // Opera su tutti i colli selezionati (batch), ciascuno sul proprio baricentro.
  const handleRotateSelected = useCallback(() => {
    if (selectedItemIds.length === 0) return;
    const idSet = new Set(selectedItemIds);

    // Fotogramma PRIMA della mutazione: la rotazione (anche di gruppo) è un passo.
    pushSnapshot();

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
  }, [selectedItemIds, vehicle, pushSnapshot]);

  // Cancellazione di TUTTI i colli selezionati (batch) + svuotamento selezione.
  const handleDeleteSelected = useCallback(() => {
    if (selectedItemIds.length === 0) return;

    // Fotogramma PRIMA della mutazione: la cancellazione è un passo di Undo.
    pushSnapshot();

    const idSet = new Set(selectedItemIds);
    setItems((prev) => prev.filter((item) => !idSet.has(item.id)));
    setSelectedItemIds([]);
  }, [selectedItemIds, pushSnapshot]);

  /** Svuotamento completo del pianale ("Svuota"): un solo passo di Undo. */
  const handleClearAll = useCallback(() => {
    pushSnapshot();
    setItems([]);
    setSelectedItemIds([]);
  }, [pushSnapshot]);

  /* ------------------------------------------------------------------------ *
   *  NOTE LATERALI DI CARICO (SIDE ANNOTATIONS)
   *
   *  Una nota vive nella corsia a destra della parete del semirimorchio e non
   *  occupa mai il pianale utile: nessun impatto sui metri lineari. Viene
   *  ridisegnata identica sul canvas, nello snapshot PNG e sulla scheda A4.
   * ------------------------------------------------------------------------ */

  /** Una sola nota può restare selezionata: la selezione è mutuamente esclusiva
   *  con quella dei colli (o si sta lavorando sui bancali, o sulle note). */
  const handleSelectNote = useCallback((id: string | null) => {
    setSelectedNoteId(id);
    if (id !== null) setSelectedItemIds([]);
  }, []);

  /** Crea una nota laterale e la mette subito in editing nella sidebar. */
  const handleAddNote = useCallback(
    (noteData: Omit<SideNote, 'id'>) => {
      const newNote: SideNote = {
        ...noteData,
        id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      };
      // Fotogramma PRIMA della mutazione: la creazione della nota è un passo.
      pushSnapshot();
      setNotes((prev) => [...prev, newNote]);
      setSelectedNoteId(newNote.id);
      setSelectedItemIds([]);
    },
    [pushSnapshot]
  );

  /** Aggiorna testo, colore, corpo o misure di una nota. */
  const handleUpdateNote = useCallback(
    (id: string, updates: Partial<SideNote>) => {
      // Fotogramma PRIMA della mutazione: ogni modifica è un passo di Undo.
      pushSnapshot();
      setNotes((prev) => prev.map((note) => (note.id === id ? { ...note, ...updates } : note)));
    },
    [pushSnapshot]
  );

  /** Elimina una nota: la selezione viene azzerata per non lasciare riferimenti. */
  const handleDeleteNote = useCallback(
    (id: string) => {
      // Fotogramma PRIMA della mutazione: l'eliminazione è un passo di Undo.
      pushSnapshot();
      setNotes((prev) => prev.filter((note) => note.id !== id));
      setSelectedNoteId(null);
    },
    [pushSnapshot]
  );

  /**
   * Trascinamento libero in 2D di una nota: si aggiornano **sia** l'ascissa X sia
   * la quota Y (cm reali), così la card può vivere ovunque attorno al camion —
   * a destra della parete (posizione di nascita), a sinistra (`x < 0`), lungo il
   * pianale o in coda. I limiti di sicurezza sono applicati dal canvas.
   *
   * Nessuno snapshot qui: il movimento del mouse non deve generare fotogrammi.
   * Il canvas apre il gesto con `onBeginHistoryGesture` al `pointerDown` e lo
   * convalida al `pointerUp` (l'intero trascinamento = 1 passo di Undo).
   */
  const handleUpdateNotePos = useCallback((id: string, x: number, y: number) => {
    setNotes((prev) =>
      prev.map((note) =>
        note.id === id ? { ...note, x: toPrecision(x), y: toPrecision(y) } : note
      )
    );
  }, []);

  /**
   * Ridimensionamento della card di nota dalla maniglia dell'angolo
   * basso-destro: larghezza e altezza vengono clampate nei limiti consentiti
   * (70–300 cm × 40–400 cm). L'altezza diventa esplicita, quindi da quel momento
   * il box non si riadatta più da solo al testo.
   *
   * Anche qui nessuno snapshot per frame: il gesto della maniglia è aperto e
   * convalidato dal canvas (un solo passo di Undo per l'intero ridimensionamento).
   */
  const handleUpdateNoteSize = useCallback(
    (id: string, size: { width: number; height: number }) => {
      setNotes((prev) =>
        prev.map((note) =>
          note.id === id
            ? { ...note, width: toPrecision(size.width), height: toPrecision(size.height) }
            : note
        )
      );
    },
    []
  );

  // Gestione scorciatoie da tastiera (Spazio, Canc e Undo / Redo)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
        return; // Non intercettare se si sta scrivendo in un input
      }
      // Anche la textarea della nota è un campo di scrittura: nessuna scorciatoia.
      if (e.target instanceof HTMLTextAreaElement) {
        return;
      }

      const key = e.key.toLowerCase();

      // Undo / Redo — `Ctrl / Cmd + Z` annulla, `Ctrl / Cmd + Shift + Z` e
      // `Ctrl / Cmd + Y` ripristinano. Nei campi di testo il browser conserva il
      // proprio undo nativo (il listener esce prima, vedi le guardie in testa).
      if ((e.ctrlKey || e.metaKey) && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && key === 'y') {
        e.preventDefault();
        handleRedo();
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        handleRotateSelected();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        // Priorità: se è attiva una nota (e nessun collo è selezionato) il tasto
        // `Canc` elimina la nota; altrimenti elimina i colli selezionati.
        if (selectedNoteId !== null && selectedItemIds.length === 0) {
          handleDeleteNote(selectedNoteId);
        } else {
          handleDeleteSelected();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    handleRotateSelected,
    handleDeleteSelected,
    handleDeleteNote,
    handleUndo,
    handleRedo,
    selectedNoteId,
    selectedItemIds,
  ]);

  // Lista dei colli selezionati, nell'ordine di selezione.
  const selectedItems = selectedItemIds
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is PlacedItem => item !== undefined);

  return (
    <>
      {/* Interfaccia interattiva: nascosta integralmente in fase di stampa. */}
      <div
        id="screen-app"
        className="flex h-screen w-screen bg-slate-100 overflow-hidden font-sans print:hidden"
      >
        {/* Sinistra: Telaio Camion */}
        <div className="flex-1 h-full">
          <TruckCanvas
            vehicle={vehicle}
            items={items}
            notes={notes}
            plate={vehiclePlate}
            selectedItemIds={selectedItemIds}
            selectedNoteId={selectedNoteId}
            labelDensity={labelDensity}
            onChangeLabelDensity={setLabelDensity}
            onSelectItems={handleSelectItems}
            onSelectNote={handleSelectNote}
            onUpdateNotePos={handleUpdateNotePos}
            onUpdateNoteSize={handleUpdateNoteSize}
            onUpdateItemsPos={handleUpdateItemsPos}
            onBeginHistoryGesture={handleBeginHistoryGesture}
            onCommitHistoryGesture={handleCommitHistoryGesture}
          />
        </div>

        {/* Destra: Plancia di Comando */}
        <div className="w-80 md:w-96 h-full flex-shrink-0">
          <ControlDeck
            vehicle={vehicle}
            onSelectVehicle={setVehicle}
            plate={vehiclePlate}
            onUpdatePlate={setVehiclePlate}
            onAddItem={handleAddItem}
            onRotateSelected={handleRotateSelected}
            onDeleteSelected={handleDeleteSelected}
            onUpdateItemProperties={handleUpdateItemProperties}
            onAddBatch={handleAddBatch}
            onClearAll={handleClearAll}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={handleUndo}
            onRedo={handleRedo}
            notes={notes}
            selectedNoteId={selectedNoteId}
            onAddNote={handleAddNote}
            onUpdateNote={handleUpdateNote}
            onDeleteNote={handleDeleteNote}
            selectedItems={selectedItems}
            items={items}
            labelDensity={labelDensity}
          />
        </div>
      </div>

      {/* Scheda di carico A4: presente nel DOM, visibile solo su carta. */}
      <PrintReport
        vehicle={vehicle}
        items={items}
        notes={notes}
        plate={vehiclePlate}
        labelDensity={labelDensity}
      />
    </>
  );
}