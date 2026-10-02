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
  ProjectFile,
} from './types';
import { VEHICLE_PRESETS, ITEM_BORDER_COLOR } from './constants';
import { TruckCanvas } from './components/TruckCanvas';
import { ControlDeck } from './components/ControlDeck';
import { PrintReport } from './components/PrintReport';
import { isPickerAbortError, saveProjectWithHandle } from './utils/fileStorage';
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

/** Durata (ms) del feedback verde `Salvato!` sul pulsante di salvataggio. */
const SAVE_FEEDBACK_MS = 2000;

/**
 * Copia profonda dello stato del piano: uno snapshot non condivide mai alcun
 * riferimento con lo stato vivo (né tra due fotogrammi distinti).
 */
const cloneSnapshot = (snapshot: HistorySnapshot): HistorySnapshot => ({
  items: snapshot.items.map((item) => ({ ...item })),
  notes: snapshot.notes.map((note) => ({ ...note })),
  vehicle: { ...snapshot.vehicle },
  plate: snapshot.plate,
  labelDensity: snapshot.labelDensity,
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
   *  FILE ATTIVO — SALVATAGGIO DIRETTO IN-PLACE (STILE EXCEL / WORD)
   *
   *  `fileHandle` è l'handle del file su disco consegnato dalla File System
   *  Access API (Chrome / Edge): finché resta agganciato, `Ctrl / Cmd + S`
   *  **riscrive lo stesso file** senza passare dalla cartella Download.
   *  `activeFileName` è il nome mostrato nella sidebar come "File attivo".
   *
   *  Sui browser senza File System Access API l'handle resta `null` e il
   *  salvataggio ricade **trasparentemente** sul download classico: il nome
   *  attivo viene comunque mostrato, così l'operatore sa su quale file lavora.
   * ------------------------------------------------------------------------ */
  const [fileHandle, setFileHandle] = useState<FileSystemFileHandle | null>(null);
  const [activeFileName, setActiveFileName] = useState<string | null>(null);
  /* Feedback `Salvato!` del pulsante della sidebar: vive qui — e non dentro
     `ControlDeck` — perché il salvataggio parte da **due** strade, il click sul
     pulsante e la scorciatoia `Ctrl / Cmd + S`: entrambe devono accendere lo
     stesso feedback verde per 2 secondi. */
  const [isProjectSaved, setIsProjectSaved] = useState<boolean>(false);
  const [savedFileName, setSavedFileName] = useState<string | null>(null);
  const saveFeedbackTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (saveFeedbackTimer.current !== null) window.clearTimeout(saveFeedbackTimer.current);
    },
    []
  );

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
   * Fotografia completa dello stato logico del piano, nello stesso formato del
   * file di progetto: colli, note, mezzo, targa e densità etichette. È la base
   * di ogni fotogramma della cronologia, quindi anche l'apertura di un piano
   * salvato è annullabile in un solo `Ctrl / Cmd + Z` senza lasciare in scena
   * il mezzo o la targa del file appena letto.
   */
  const captureSnapshot = useCallback(
    (): HistorySnapshot => ({ items, notes, vehicle, plate: vehiclePlate, labelDensity }),
    [items, notes, vehicle, vehiclePlate, labelDensity]
  );

  /**
   * Registra uno stato nella pila dei passati e svuota quella dei futuri (una
   * nuova azione invalida sempre il Redo). Va invocata **prima** di ogni
   * mutazione intenzionale, con il fotogramma da conservare.
   */
  const pushSnapshot = useCallback((snapshot: HistorySnapshot) => {
    setPast((prev) => appendSnapshot(prev, cloneSnapshot(snapshot)));
    setFuture([]);
  }, []);

  /**
   * Inizio di un gesto col mouse (pointerDown su un collo o su una nota):
   * memorizza il fotogramma di partenza senza ancora convalidarlo, perché il
   * trascinamento potrebbe risolversi in un semplice click senza spostamenti.
   */
  const handleBeginHistoryGesture = useCallback(() => {
    pendingSnapshot.current = captureSnapshot();
  }, [captureSnapshot]);

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

  /** Ripristina uno snapshot completo in scena, ripulendo le selezioni orfane. */
  const restoreSnapshot = useCallback((snapshot: HistorySnapshot) => {
    const restored = cloneSnapshot(snapshot);
    setItems(restored.items);
    setNotes(restored.notes);
    setVehicle(restored.vehicle);
    setVehiclePlate(restored.plate);
    setLabelDensity(restored.labelDensity);
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
    setFuture((prev) => [...prev, cloneSnapshot(captureSnapshot())]);
    restoreSnapshot(snapshot);
  }, [past, captureSnapshot, restoreSnapshot]);

  /** Ripristina l'azione annullata: simmetrico esatto di `handleUndo`. */
  const handleRedo = useCallback(() => {
    if (future.length === 0) return;
    const snapshot = future[future.length - 1];
    setFuture((prev) => prev.slice(0, -1));
    setPast((prev) => appendSnapshot(prev, cloneSnapshot(captureSnapshot())));
    restoreSnapshot(snapshot);
  }, [future, captureSnapshot, restoreSnapshot]);

  /** Imposta l'intera lista di selezione (sostituzione, non toggle). */
  const handleSelectItems = useCallback((ids: string[]) => {
    setSelectedItemIds(ids);
  }, []);

  // Aggiungi un nuovo collo al pianale, nel primo slot libero disponibile
  const handleAddItem = (pallet: PalletDefinition, options: AddItemOptions = {}) => {
    // Fotogramma PRIMA della mutazione: l'aggiunta è un passo di Undo.
    pushSnapshot(captureSnapshot());

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
      pushSnapshot(captureSnapshot());

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
    [vehicle, pushSnapshot, captureSnapshot]
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
      pushSnapshot(captureSnapshot());

      const idSet = new Set(ids);
      setItems((prev) =>
        prev.map((item) => (idSet.has(item.id) ? { ...item, ...updates } : item))
      );
    },
    [pushSnapshot, captureSnapshot]
  );

  // Rotazione di 90 gradi ancorata al baricentro, con riallineamento magnetico.
  // Opera su tutti i colli selezionati (batch), ciascuno sul proprio baricentro.
  const handleRotateSelected = useCallback(() => {
    if (selectedItemIds.length === 0) return;
    const idSet = new Set(selectedItemIds);

    // Fotogramma PRIMA della mutazione: la rotazione (anche di gruppo) è un passo.
    pushSnapshot(captureSnapshot());

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
  }, [selectedItemIds, vehicle, pushSnapshot, captureSnapshot]);

  // Cancellazione di TUTTI i colli selezionati (batch) + svuotamento selezione.
  const handleDeleteSelected = useCallback(() => {
    if (selectedItemIds.length === 0) return;

    // Fotogramma PRIMA della mutazione: la cancellazione è un passo di Undo.
    pushSnapshot(captureSnapshot());

    const idSet = new Set(selectedItemIds);
    setItems((prev) => prev.filter((item) => !idSet.has(item.id)));
    setSelectedItemIds([]);
  }, [selectedItemIds, pushSnapshot, captureSnapshot]);

  /**
   * Svuotamento completo del pianale ("Svuota"): un solo passo di Undo.
   *
   * "Svuota" azzera il lavoro e avvia un piano nuovo: l'handle del file aperto
   * viene **staccato** (e il nome attivo azzerato), così il primo `Ctrl / Cmd + S`
   * del nuovo carico chiede un file nuovo invece di sovrascrivere il precedente.
   */
  const handleClearAll = useCallback(() => {
    pushSnapshot(captureSnapshot());
    setItems([]);
    setSelectedItemIds([]);
    setFileHandle(null);
    setActiveFileName(null);
  }, [pushSnapshot, captureSnapshot]);

  /* ------------------------------------------------------------------------ *
   *  SALVA & APRI PIANO DI CARICO (.json)
   *
   *  Backup, ripristino e condivisione dei lavori: il piano di carico viene
   *  serializzato in un file leggibile e riaperto in un secondo momento, anche
   *  su un'altra macchina. È l'unica funzione che ricostruisce **tutto** lo
   *  stato logico della stiva in un colpo solo: mezzo, targa, colli, note
   *  laterali e densità etichette.
   *
   *  Con la File System Access API il file attivo resta **agganciato**: finché
   *  l'handle è vivo, `Ctrl / Cmd + S` riscrive in-place lo stesso file (stile
   *  Excel / Word) senza creare copie nella cartella Download.
   * ------------------------------------------------------------------------ */

  /**
   * Salva il piano di carico: **sovrascrittura diretta in-place** se c'è un file
   * attivo (`Ctrl / Cmd + S` stile Excel / Word), altrimenti selettore nativo
   * "Salva con nome" e — sui browser che non supportano la File System Access API
   * o con permesso negato — download classico `.json` (fallback trasparente).
   *
   * Restituisce il nome del file salvato (per il feedback `Salvato!` della
   * sidebar) oppure `null` se l'operatore ha annullato il selettore.
   */
  const handleSaveProject = useCallback(async (): Promise<{
    fileName: string;
    isNewFile: boolean;
  } | null> => {
    const project: ProjectFile = {
      version: 1,
      app: 'truck-planner',
      timestamp: new Date().toISOString(),
      vehicle,
      plate: vehiclePlate,
      items,
      notes,
      labelDensity,
    };

    try {
      const result = await saveProjectWithHandle(project, fileHandle);
      // Il file attivo segue sempre l'esito reale del salvataggio: dopo una
      // sovrascrittura l'handle è lo stesso, dopo un "Salva con nome" è il nuovo.
      setFileHandle(result.handle);
      setActiveFileName(result.fileName);

      // Feedback verde `Salvato!` per 2 secondi, con il nome del file nel tooltip:
      // identico sia per il click sul pulsante sia per `Ctrl / Cmd + S`.
      setSavedFileName(result.fileName);
      setIsProjectSaved(true);
      if (saveFeedbackTimer.current !== null) window.clearTimeout(saveFeedbackTimer.current);
      saveFeedbackTimer.current = window.setTimeout(
        () => setIsProjectSaved(false),
        SAVE_FEEDBACK_MS
      );

      return { fileName: result.fileName, isNewFile: result.isNewFile };
    } catch (error) {
      // Annullamento volontario del selettore: nessun avviso, nessun salvataggio.
      if (isPickerAbortError(error)) return null;

      const message =
        error instanceof Error ? error.message : 'Impossibile salvare il piano di carico.';
      window.alert(`Salvataggio del piano non riuscito.\n\n${message}`);
      return null;
    }
  }, [vehicle, vehiclePlate, items, notes, labelDensity, fileHandle]);

  /**
   * Apre un piano di carico salvato in precedenza e lo mette in scena.
   *
   * Il fotogramma viene registrato **prima** del ripristino: se l'apertura è
   * involontaria, `Ctrl / Cmd + Z` riporta istantaneamente il pianale allo stato
   * precedente (colli, note e — come per ogni Undo — la selezione ripulita).
   * La lista dei colli e quella delle note vengono copiate in profondità, così
   * il file appena letto non condivide riferimenti con lo stato vivo.
   *
   * `handle` è l'handle della File System Access API (o `null` col selettore
   * classico) e `fileName` il nome mostrato come "File attivo": da qui in avanti
   * `Ctrl / Cmd + S` riscrive **quel** file.
   */
  const handleLoadProject = useCallback(
    (project: ProjectFile, handle: FileSystemFileHandle | null, fileName: string) => {
      // Fotogramma PRIMA del ripristino: l'apertura è un passo di Undo.
      pushSnapshot(captureSnapshot());

      setVehicle(project.vehicle);
      setVehiclePlate(project.plate ?? '');
      setItems(project.items.map((item) => ({ ...item })));
      setNotes((project.notes ?? []).map((note) => ({ ...note })));
      setLabelDensity(project.labelDensity ?? 'all');

      // Il file attivo diventa quello appena aperto (handle compreso).
      setFileHandle(handle);
      setActiveFileName(fileName || null);

      // Nessuna selezione orfana: le selezioni correnti vengono azzerate.
      setSelectedItemIds([]);
      setSelectedNoteId(null);
    },
    [pushSnapshot, captureSnapshot]
  );

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
      pushSnapshot(captureSnapshot());
      setNotes((prev) => [...prev, newNote]);
      setSelectedNoteId(newNote.id);
      setSelectedItemIds([]);
    },
    [pushSnapshot, captureSnapshot]
  );

  /** Aggiorna testo, colore, corpo o misure di una nota. */
  const handleUpdateNote = useCallback(
    (id: string, updates: Partial<SideNote>) => {
      // Fotogramma PRIMA della mutazione: ogni modifica è un passo di Undo.
      pushSnapshot(captureSnapshot());
      setNotes((prev) => prev.map((note) => (note.id === id ? { ...note, ...updates } : note)));
    },
    [pushSnapshot, captureSnapshot]
  );

  /** Elimina una nota: la selezione viene azzerata per non lasciare riferimenti. */
  const handleDeleteNote = useCallback(
    (id: string) => {
      // Fotogramma PRIMA della mutazione: l'eliminazione è un passo di Undo.
      pushSnapshot(captureSnapshot());
      setNotes((prev) => prev.filter((note) => note.id !== id));
      setSelectedNoteId(null);
    },
    [pushSnapshot, captureSnapshot]
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

  // Gestione scorciatoie da tastiera (Ctrl/Cmd+S, Spazio, Canc e Undo / Redo)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();

      // Salvataggio diretto — `Ctrl / Cmd + S` riscrive il file attivo in-place
      // (stile Excel / Word) e **previene sempre** il salvataggio pagina del
      // browser. È gestito prima delle guardie sui campi di scrittura perché non
      // è una scorciatoia di editing: deve funzionare anche mentre si digita.
      if ((e.ctrlKey || e.metaKey) && key === 's') {
        e.preventDefault();
        void handleSaveProject();
        return;
      }

      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
        return; // Non intercettare se si sta scrivendo in un input
      }
      // Anche la textarea della nota è un campo di scrittura: nessuna scorciatoia.
      if (e.target instanceof HTMLTextAreaElement) {
        return;
      }

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
    handleSaveProject,
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
            onSaveProject={handleSaveProject}
            onLoadProject={handleLoadProject}
            activeFileName={activeFileName}
            isProjectSaved={isProjectSaved}
            savedFileName={savedFileName}
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