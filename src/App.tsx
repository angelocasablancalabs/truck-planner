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
  DeckBay,
} from './types';
import {
  ITEM_BORDER_COLOR,
  MAX_BAYS,
  DEFAULT_BAY_ID,
  createDefaultBay,
} from './constants';
import { resolveActiveBay } from './utils/bays';
import { TruckCanvas } from './components/TruckCanvas';
import { ControlDeck } from './components/ControlDeck';
import { ItemInspector } from './components/ItemInspector';
import { NoteInspector } from './components/NoteInspector';
import { PrintReport } from './components/PrintReport';
import { isPickerAbortError, saveProjectWithHandle } from './utils/fileStorage';
import {
  calculateDockDisplacement,
  calculateSnapPosition,
  findSmartSpawnPosition,
  isRectColliding,
  toPrecision,
} from './utils/snapping';
import type { DockDirection } from './utils/snapping';

/* -------------------------------------------------------------------------- *
 *  AUTO-FITTING MAGNETICO POST-ROTAZIONE
 *
 *  La rotazione fa perno sul baricentro, quindi i bordi del collo arretrano o
 *  avanzano di `|width − length| / 2` (20 cm per un PLT EUR, 39,25 cm per un CC):
 *  la vecchia soglia fissa di 10 cm non bastava più a riagganciare il collo al
 *  bordo del vicino (es. un EUR ruotato a Y = 100 che lasciava 20 cm di fessura).
 *  La soglia è ora **dinamica** e copre per costruzione l'inversione geometrica.
 * -------------------------------------------------------------------------- */

/** Soglia minima di aggancio post-rotazione (cm): copre i formati più piccoli. */
const ROTATION_SNAP_MIN_THRESHOLD = 45;
/** Margine di sicurezza aggiunto a metà scarto dimensionale (cm). */
const ROTATION_SNAP_SLACK = 5;

/**
 * Tolleranza di aggancio magnetico applicata dopo una rotazione (cm):
 * `max(45, |width − length| / 2 + 5)`.
 */
const rotationSnapThreshold = (item: { width: number; length: number }): number =>
  Math.max(
    ROTATION_SNAP_MIN_THRESHOLD,
    Math.abs(item.width - item.length) / 2 + ROTATION_SNAP_SLACK
  );

/** Limiti di quantità di un lotto caricato dall'accordion multifunzione. */
const BATCH_MIN_QUANTITY = 1;
const BATCH_MAX_QUANTITY = 99;
const BATCH_DEFAULT_QUANTITY = 10;

/** Numero massimo di fotogrammi conservati nella pila `past` (FIFO). */
const HISTORY_LIMIT = 40;

/** Durata (ms) del feedback verde `Salvato!` sul pulsante di salvataggio. */
const SAVE_FEEDBACK_MS = 2000;

/**
 * ID univoco di un collo stivato: prefisso di catalogo + istante di creazione +
 * suffisso casuale. Vive fuori dal componente perché l'ID nasce da un'azione
 * dell'operatore (mai durante il render): la funzione resta pura agli occhi del
 * compilatore React.
 */
const makeItemId = (code: string, suffix: string | number = ''): string =>
  `${code}_${Date.now()}_${suffix}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Copia profonda della flotta: uno snapshot non condivide mai alcun riferimento
 * con lo stato vivo (né tra due fotogrammi distinti). Ogni stallo viene copiato
 * per intero — mezzo, targa, colli e note — così un `Ctrl / Cmd + Z` non può
 * essere corrotto da mutazioni successive.
 */
const cloneBays = (bays: DeckBay[]): DeckBay[] =>
  bays.map((bay) => ({
    ...bay,
    vehicle: { ...bay.vehicle },
    items: bay.items.map((item) => ({ ...item })),
    notes: bay.notes.map((note) => ({ ...note })),
  }));

/**
 * Copia profonda dello stato della centrale: flotta, mezzo attivo e densità
 * etichette. È la base di ogni fotogramma della cronologia Undo / Redo.
 */
const cloneSnapshot = (snapshot: HistorySnapshot): HistorySnapshot => ({
  bays: cloneBays(snapshot.bays),
  activeBayId: snapshot.activeBayId,
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
  /* ------------------------------------------------------------------------ *
   *  CENTRALE MULTI-PIANALE — STATO PRINCIPALE
   *
   *  `bays` è la flotta degli stalli (da 1 a `MAX_BAYS` mezzi affiancati nello
   *  stesso canvas e nello stesso file JSON): ogni stallo porta con sé il proprio
   *  mezzo, la propria targa, i propri colli e le proprie note, su **coordinate
   *  locali** al pianale. `activeBayId` indica il **Mezzo Attivo**, l'unico che
   *  sidebar (`ControlDeck`) e ispettore (`ItemInspector`) comandano: tutte le
   *  mutazioni della stiva passano da `updateActiveBay`.
   * ------------------------------------------------------------------------ */
  const [bays, setBays] = useState<DeckBay[]>([createDefaultBay(DEFAULT_BAY_ID)]);
  const [activeBayId, setActiveBayId] = useState<string>(DEFAULT_BAY_ID);
  // Selezione multipla: lista ordinata di ID selezionati ([] = nessuna selezione).
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  // Densità delle etichette stampate sui colli (default: nome + quote).
  const [labelDensity, setLabelDensity] = useState<LabelDensity>('all');
  // Nota attualmente selezionata (null = nessuna): alimenta il pannello sidebar.
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  /**
   * Mezzo attivo risolto con fallback sicuro: se l'ID non esiste più (stallo
   * eliminato da un Undo o da un file aperto) si ricade sul primo della flotta.
   */
  const activeBay = resolveActiveBay(bays, activeBayId);
  // Viste comode sul pianale attivo: sono ciò che sidebar, ispettore e stampa
  // mostrano come "il piano corrente".
  const vehicle = activeBay.vehicle;
  const items = activeBay.items;
  const notes = activeBay.notes;
  const vehiclePlate = activeBay.plate;

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

  /* ------------------------------------------------------------------------ *
   *  PROTEZIONE DALLA CHIUSURA ACCIDENTALE DELLA SCHEDA
   *
   *  `hasUnsavedChanges` tiene traccia del fatto che in scena ci sia lavoro
   *  **non ancora scritto su disco**: viene acceso a ogni mutazione del piano
   *  (colli, note, mezzo e targa) e rispettivamente spento al salvataggio andato
   *  a buon fine e all'apertura di un piano da file. Finché resta acceso il
   *  browser mostra il proprio popup nativo di conferma su `beforeunload` (F5,
   *  chiusura scheda, chiusura finestra), evitando la perdita silenziosa della
   *  stiva appena composta.
   *
   *  Nota: i browser ignorano il testo personalizzato del messaggio — il popup
   *  è di sistema — ma la conferma viene mostrata solo se `returnValue` è
   *  impostato, quindi entrambe le righe servono.
   * ------------------------------------------------------------------------ */
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState<boolean>(false);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        // Imposta returnValue per forzare il popup nativo di conferma del browser
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

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
   * Fotografia completa dello stato logico della centrale, nello stesso formato
   * del file di progetto: flotta degli stalli (mezzi, targhe, colli e note),
   * mezzo attivo e densità etichette. È la base di ogni fotogramma della
   * cronologia, quindi anche l'apertura di un piano salvato — o l'aggiunta e
   * l'eliminazione di un mezzo — è annullabile in un solo `Ctrl / Cmd + Z`.
   */
  const captureSnapshot = useCallback(
    (): HistorySnapshot => ({ bays, activeBayId, labelDensity }),
    [bays, activeBayId, labelDensity]
  );

  /**
   * Registra uno stato nella pila dei passati e svuota quella dei futuri (una
   * nuova azione invalida sempre il Redo). Va invocata **prima** di ogni
   * mutazione intenzionale, con il fotogramma da conservare.
   */
  const pushSnapshot = useCallback((snapshot: HistorySnapshot) => {
    setPast((prev) => appendSnapshot(prev, cloneSnapshot(snapshot)));
    setFuture([]);
    // Ogni fotogramma nasce da una mutazione intenzionale del piano (aggiunta,
    // spostamento, rotazione, ricolorazione, cancellazione o nota): da qui in
    // avanti il lavoro in scena non coincide più con il file su disco.
    setHasUnsavedChanges(true);
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
    // Trascinamento concluso con uno spostamento reale: stessa regola di
    // `pushSnapshot` (il fotogramma qui è solo differito al `pointerUp`).
    setHasUnsavedChanges(true);
  }, []);

  /** Ripristina uno snapshot completo in scena, ripulendo le selezioni orfane. */
  const restoreSnapshot = useCallback((snapshot: HistorySnapshot) => {
    const restored = cloneSnapshot(snapshot);
    setBays(restored.bays);
    // Il mezzo attivo è sempre valido: se lo stallo ripristinato non esiste più
    // si ricade sul primo della flotta, così l'app non resta mai senza bersaglio.
    const restoredActive = resolveActiveBay(restored.bays, restored.activeBayId);
    setActiveBayId(restoredActive.id);
    setLabelDensity(restored.labelDensity);
    // Selezione: sopravvivono solo gli ID ancora presenti nello **stallo attivo**
    // ripristinato, così nessun pannello resta appeso a un collo o a una nota che
    // non esistono più (o che vivono su un altro mezzo).
    const activeIds = new Set(restoredActive.items.map((item) => item.id));
    setSelectedItemIds((prev) => prev.filter((id) => activeIds.has(id)));
    setSelectedNoteId((prev) =>
      prev !== null && restoredActive.notes.some((note) => note.id === prev) ? prev : null
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

  /* ------------------------------------------------------------------------ *
   *  DELEGA AL MEZZO ATTIVO (CENTRALE MULTI-PIANALE)
   *
   *  Sidebar e ispettore comandano **sempre e solo** lo stallo attivo: ogni
   *  mutazione della stiva passa da `updateActiveBay`, che riscrive il solo
   *  stallo interessato lasciando intatti gli altri due. Una sola porta d'ingresso
   *  per colli, note, targa e configurazione del mezzo.
   * ------------------------------------------------------------------------ */
  const updateActiveBay = useCallback(
    (patch: Partial<DeckBay>) => {
      setBays((prev) =>
        prev.map((bay) => (bay.id === activeBayId ? { ...bay, ...patch } : bay))
      );
    },
    [activeBayId]
  );

  /**
   * Aggiornamento dei colli del **mezzo attivo**, con accesso alla lista corrente:
   * è il mattone su cui sono costruite tutte le mutazioni della stiva.
   */
  const updateActiveItems = useCallback(
    (updater: (prevItems: PlacedItem[]) => PlacedItem[]) => {
      setBays((prev) =>
        prev.map((bay) => (bay.id === activeBayId ? { ...bay, items: updater(bay.items) } : bay))
      );
    },
    [activeBayId]
  );

  /** Aggiornamento delle note laterali del **mezzo attivo**. */
  const updateActiveNotes = useCallback(
    (updater: (prevNotes: SideNote[]) => SideNote[]) => {
      setBays((prev) =>
        prev.map((bay) => (bay.id === activeBayId ? { ...bay, notes: updater(bay.notes) } : bay))
      );
    },
    [activeBayId]
  );

  /**
   * Cambio del **Mezzo Attivo** (click su una pillola della sidebar o sullo
   * stallo nel canvas): la selezione in corso viene azzerata, perché colli e note
   * appartengono al pianale precedente — nessuna selezione orfana può sopravvivere
   * al passaggio di mezzo.
   */
  const handleSelectBay = useCallback((bayId: string) => {
    setActiveBayId(bayId);
    setSelectedItemIds([]);
    setSelectedNoteId(null);
  }, []);

  /**
   * **Aggiunge un mezzo** alla centrale (massimo `MAX_BAYS`): nasce di fabbrica
   * (Bilico CC Fiori 13,28 m, targa vuota, pianale vuoto) e diventa subito il
   * Mezzo Attivo, così l'operatore può caricarlo senza un click in più. L'intera
   * operazione è **un solo passo di Undo**.
   */
  const handleAddBay = useCallback(() => {
    if (bays.length >= MAX_BAYS) return;

    // Fotogramma PRIMA della mutazione: aggiunta ed eliminazione di un mezzo
    // sono passi pieni della cronologia.
    pushSnapshot(captureSnapshot());

    const newBay = createDefaultBay(`bay-${Date.now()}`);
    setBays((prev) => (prev.length >= MAX_BAYS ? prev : [...prev, newBay]));
    setActiveBayId(newBay.id);
    setSelectedItemIds([]);
    setSelectedNoteId(null);
  }, [bays.length, pushSnapshot, captureSnapshot]);

  /**
   * **Elimina un mezzo** dalla centrale. L'ultimo stallo rimasto non è mai
   * eliminabile (la centrale deve sempre avere almeno un pianale) e, se il mezzo
   * contiene colli o note, viene chiesta una conferma antipanico prima di
   * procedere. Se lo stallo eliminato era quello attivo, la selezione passa al
   * primo mezzo rimasto. Anche questa operazione è **un solo passo di Undo**.
   */
  const handleDeleteBay = useCallback(
    (bayId: string) => {
      if (bays.length <= 1) return;

      const target = bays.find((bay) => bay.id === bayId);
      if (!target) return;

      const hasContent = target.items.length > 0 || target.notes.length > 0;
      if (
        hasContent &&
        !window.confirm(
          `Il mezzo "${target.plate || 'senza targa'}" contiene ${target.items.length} colli e ${target.notes.length} note.\nVuoi eliminare il mezzo e tutto il suo carico?`
        )
      ) {
        return;
      }

      // Fotogramma PRIMA della mutazione.
      pushSnapshot(captureSnapshot());

      const remaining = bays.filter((bay) => bay.id !== bayId);
      setBays(remaining);
      if (target.id === activeBayId) {
        setActiveBayId(remaining[0].id);
      }
      setSelectedItemIds([]);
      setSelectedNoteId(null);
    },
    [bays, activeBayId, pushSnapshot, captureSnapshot]
  );

  /**
   * Svuota integralmente la centrale riportandola al piano di fabbrica: un solo
   * stallo (`bay-1`) con il mezzo di default e nessun carico.
   */
  const resetFleet = useCallback(() => {
    const freshBay = createDefaultBay(DEFAULT_BAY_ID);
    setBays([freshBay]);
    setActiveBayId(freshBay.id);
  }, []);

  /**
   * Cambio di configurazione del **mezzo attivo** (preset di catalogo o
   * dimensioni libere del mezzo personalizzato): il veicolo fa parte del piano di
   * carico salvato su `.json`, quindi la modifica va segnalata come non salvata.
   * La stessa regola vale per la targa, che finisce nel file di progetto, nel
   * badge sopra la Cabina e nell'intestazione della scheda A4.
   */
  const handleSelectVehicle = useCallback(
    (next: VehicleConfig) => {
      updateActiveBay({ vehicle: next });
      setHasUnsavedChanges(true);
    },
    [updateActiveBay]
  );

  /** Aggiornamento della targa del mezzo attivo: modifica non salvata. */
  const handleUpdatePlate = useCallback(
    (value: string) => {
      updateActiveBay({ plate: value });
      setHasUnsavedChanges(true);
    },
    [updateActiveBay]
  );

  // Aggiungi un nuovo collo al pianale, nel primo slot libero disponibile
  const handleAddItem = (pallet: PalletDefinition, options: AddItemOptions = {}) => {
    // Fotogramma PRIMA della mutazione: l'aggiunta è un passo di Undo.
    pushSnapshot(captureSnapshot());

    const width = options.width ?? (pallet.isBulk ? vehicle.width : pallet.width);
    const length = options.length ?? pallet.length;

    // Spawn intelligente first-fit: dalla Cabina verso le Porte, da sinistra a destra.
    const spawn = findSmartSpawnPosition(width, length, vehicle, items);

    const newItem: PlacedItem = {
      id: makeItemId(pallet.code),
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

    updateActiveItems((prev) => [...prev, newItem]);
    // Nessuna auto-selezione: il collo viene solo disegnato sul pianale e
    // l'HUD resta pulito. La card fluttuante di ispezione (`ItemInspector`)
    // comparirà solo quando l'utente selezionerà esplicitamente il collo.
    setSelectedItemIds([]);
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

      updateActiveItems((prev) => {
        // Accumulatore locale: è il pianale "corrente" su cui calcolare gli spawn.
        let current = [...prev];

        for (let i = 0; i < qty; i++) {
          const spawn = findSmartSpawnPosition(width, length, vehicle, current);

          const newItem: PlacedItem = {
            id: makeItemId(pallet.code, `${i}_`),
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
    [vehicle, updateActiveItems, pushSnapshot, captureSnapshot]
  );

  /**
   * Aggiornamento simultaneo delle coordinate di più colli (drag singolo e di
   * gruppo): un solo setState per frame, con patch applicata per ID.
   */
  const handleUpdateItemsPos = useCallback(
    (updates: ItemPositionUpdate[]) => {
      if (updates.length === 0) return;

      updateActiveItems((prev) => {
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
    },
    [updateActiveItems]
  );

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
      updateActiveItems((prev) =>
        prev.map((item) => (idSet.has(item.id) ? { ...item, ...updates } : item))
      );
    },
    [updateActiveItems, pushSnapshot, captureSnapshot]
  );

  // Rotazione di 90 gradi ancorata al baricentro, con riallineamento magnetico.
  // Opera su tutti i colli selezionati (batch), ciascuno sul proprio baricentro.
  const handleRotateSelected = useCallback(() => {
    if (selectedItemIds.length === 0) return;
    const idSet = new Set(selectedItemIds);

    // Fotogramma PRIMA della mutazione: la rotazione (anche di gruppo) è un passo.
    pushSnapshot(captureSnapshot());

    updateActiveItems((prev) =>
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

        // Auto-Fitting Magnetico attivo: il collo ruotato cerca il contatto a
        // filo (pareti e colli adiacenti) con la tolleranza dinamica che copre
        // l'inversione geometrica `|W − L| / 2`.
        const others = prev.filter((other) => other.id !== item.id);
        const snapped = calculateSnapPosition(
          clampedX,
          clampedY,
          newWidth,
          newLength,
          vehicle,
          others,
          rotationSnapThreshold(item)
        );

        // L'assestamento viene adottato solo se la posizione riassestata è
        // priva di collisioni; altrimenti si ripiega sulla centratura clampata.
        const snappedCollides = others.some((other) =>
          isRectColliding(snapped.x, snapped.y, newWidth, newLength, other)
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
  }, [selectedItemIds, vehicle, updateActiveItems, pushSnapshot, captureSnapshot]);

  /**
   * Spinta a Battuta (Sweep Docking): spinge rigidamente il blocco dei colli
   * selezionati verso uno dei quattro punti cardinali finché non tocca la
   * parete, le porte o il primo ostacolo. La fisica vive nel motore puro
   * `calculateDockDisplacement` (unica fonte di verità, condivisa con i pulsanti
   * della sidebar e con le quattro frecce della tastiera).
   *
   * Il blocco conserva la geometria reciproca (stesso delta per tutti i membri)
   * e si arresta a filo esatto: zero collisioni per costruzione. Una spinta già
   * a battuta (`dx === 0 && dy === 0`) non produce né movimento né fotogramma.
   */
  const handleDockSelected = useCallback(
    (direction: DockDirection) => {
      if (selectedItemIds.length === 0) return;

      const { dx, dy } = calculateDockDisplacement(items, selectedItemIds, direction, vehicle);
      // Già a battuta: nessuno spostamento, nessun passo di cronologia.
      if (dx === 0 && dy === 0) return;

      // Fotogramma PRIMA della mutazione: l'intera spinta è UN passo di Undo.
      pushSnapshot(captureSnapshot());

      const idSet = new Set(selectedItemIds);
      updateActiveItems((prev) =>
        prev.map((item) =>
          idSet.has(item.id)
            ? { ...item, x: toPrecision(item.x + dx), y: toPrecision(item.y + dy) }
            : item
        )
      );
    },
    [items, selectedItemIds, vehicle, updateActiveItems, pushSnapshot, captureSnapshot]
  );

  // Cancellazione di TUTTI i colli selezionati (batch) + svuotamento selezione.
  const handleDeleteSelected = useCallback(() => {
    if (selectedItemIds.length === 0) return;

    // Fotogramma PRIMA della mutazione: la cancellazione è un passo di Undo.
    pushSnapshot(captureSnapshot());

    const idSet = new Set(selectedItemIds);
    updateActiveItems((prev) => prev.filter((item) => !idSet.has(item.id)));
    setSelectedItemIds([]);
  }, [selectedItemIds, updateActiveItems, pushSnapshot, captureSnapshot]);

  /**
   * Avvia un nuovo piano di carico da zero:
   * - Chiede conferma se ci sono modifiche non salvate (`hasUnsavedChanges`);
   * - Ripristina la centrale al **singolo mezzo di fabbrica** (`bay-1`, Bilico CC
   *   Fiori 13,28 m) con targa vuota, nessun collo e nessuna nota;
   * - Sgancia il file attivo e azzera le pile di Undo/Redo.
   */
  const handleNewProject = useCallback(() => {
    if (
      hasUnsavedChanges &&
      !window.confirm(
        'Ci sono modifiche non salvate sul piano corrente.\nVuoi iniziare un nuovo piano e perdere le modifiche non salvate?'
      )
    ) {
      return;
    }

    resetFleet();
    setLabelDensity('all');
    setSelectedItemIds([]);
    setSelectedNoteId(null);
    setFileHandle(null);
    setActiveFileName(null);
    setPast([]);
    setFuture([]);
    setHasUnsavedChanges(false);
  }, [hasUnsavedChanges, resetFleet]);

  /**
   * Svuotamento del pianale attivo ("Svuota"): un solo passo di Undo.
   *
   * Azzera colli **e** note laterali **del solo Mezzo Attivo** — il lavoro
   * caricato sul pianale — mentre mezzo e targa restano intatti: sono la
   * configurazione del veicolo, non il carico, quindi non vengono toccati. Gli
   * altri mezzi della flotta non vengono minimamente sfiorati. Il file attivo
   * resta agganciato: un `Ctrl / Cmd + S` successivo riscrive lo stesso file con
   * il pianale vuoto.
   */
  const handleClearAll = useCallback(() => {
    pushSnapshot(captureSnapshot());
    updateActiveBay({ items: [], notes: [] });
    setSelectedItemIds([]);
    setSelectedNoteId(null);
  }, [updateActiveBay, pushSnapshot, captureSnapshot]);

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
      version: 2,
      app: 'truck-planner',
      timestamp: new Date().toISOString(),
      bays,
      activeBayId: activeBay.id,
      labelDensity,
    };

    try {
      const result = await saveProjectWithHandle(project, fileHandle);
      // Il file attivo segue sempre l'esito reale del salvataggio: dopo una
      // sovrascrittura l'handle è lo stesso, dopo un "Salva con nome" è il nuovo.
      setFileHandle(result.handle);
      setActiveFileName(result.fileName);
      // Piano scritto su disco: il lavoro in scena torna allineato al file.
      setHasUnsavedChanges(false);

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
  }, [bays, activeBay.id, labelDensity, fileHandle]);

  /**
   * "Salva con nome": salva il piano di carico su un **nuovo file**, anche
   * quando un file attivo è già agganciato.
   *
   * Passando `null` come handle si forza sempre il selettore nativo
   * `showSaveFilePicker` (o, sui browser che non lo supportano, il download
   * classico di una nuova copia): il file precedente resta intatto e da quel
   * momento `Ctrl / Cmd + S` riscrive in-place la nuova copia.
   *
   * Restituisce nome del file e natura dell'operazione, oppure `null` se
   * l'operatore annulla il selettore o il salvataggio fallisce.
   */
  const handleSaveProjectAs = useCallback(async (): Promise<{
    fileName: string;
    isNewFile: boolean;
  } | null> => {
    const project: ProjectFile = {
      version: 2,
      app: 'truck-planner',
      timestamp: new Date().toISOString(),
      bays,
      activeBayId: activeBay.id,
      labelDensity,
    };

    try {
      // Passando `null` come handle si forza l'apertura della finestra
      // "Salva con nome", anche con un file attivo già agganciato.
      const result = await saveProjectWithHandle(project, null);
      setFileHandle(result.handle);
      setActiveFileName(result.fileName);
      // Copia scritta su un nuovo file: nessuna modifica in sospeso.
      setHasUnsavedChanges(false);

      // Stesso feedback verde `Salvato!` del salvataggio in-place.
      setSavedFileName(result.fileName);
      setIsProjectSaved(true);
      if (saveFeedbackTimer.current !== null) window.clearTimeout(saveFeedbackTimer.current);
      saveFeedbackTimer.current = window.setTimeout(
        () => setIsProjectSaved(false),
        SAVE_FEEDBACK_MS
      );

      return { fileName: result.fileName, isNewFile: result.isNewFile };
    } catch (error) {
      // Annullamento volontario del selettore: nessun avviso, nessun file.
      if (isPickerAbortError(error)) return null;

      const message =
        error instanceof Error ? error.message : 'Impossibile salvare il piano di carico.';
      window.alert(`Salvataggio del piano non riuscito.\n\n${message}`);
      return null;
    }
  }, [bays, activeBay.id, labelDensity]);

  /**
   * Apre un piano di carico salvato in precedenza e lo mette in scena.
   *
   * Il fotogramma viene registrato **prima** del ripristino: se l'apertura è
   * involontaria, `Ctrl / Cmd + Z` riporta istantaneamente la centrale allo stato
   * precedente (flotta, mezzo attivo e — come per ogni Undo — la selezione
   * ripulita). La flotta viene copiata in profondità, così il file appena letto
   * non condivide riferimenti con lo stato vivo.
   *
   * Il file può essere **v2** (centrale multi-pianale) oppure **v1** (pianale
   * singolo, migrato al volo in un unico stallo da `utils/fileStorage.ts`): in
   * entrambi i casi qui arriva già una flotta normalizzata.
   *
   * `handle` è l'handle della File System Access API (o `null` col selettore
   * classico) e `fileName` il nome mostrato come "File attivo": da qui in avanti
   * `Ctrl / Cmd + S` riscrive **quel** file.
   */
  const handleLoadProject = useCallback(
    (project: ProjectFile, handle: FileSystemFileHandle | null, fileName: string) => {
      // Fotogramma PRIMA del ripristino: l'apertura è un passo di Undo.
      pushSnapshot(captureSnapshot());

      // Flotta copiata in profondità: il file non condivide riferimenti con lo
      // stato vivo. Una flotta vuota (file anomalo) ricade sul mezzo di fabbrica.
      const loadedBays = project.bays.map((bay) => ({
        ...bay,
        vehicle: { ...bay.vehicle },
        items: bay.items.map((item) => ({ ...item })),
        notes: bay.notes.map((note) => ({ ...note })),
      }));
      setBays(loadedBays);
      setActiveBayId(resolveActiveBay(loadedBays, project.activeBayId ?? '').id);
      setLabelDensity(project.labelDensity ?? 'all');

      // Il file attivo diventa quello appena aperto (handle compreso).
      setFileHandle(handle);
      setActiveFileName(fileName || null);

      // Il piano in scena è **esattamente** il contenuto del file appena letto
      // (il fotogramma registrato sopra lo ha acceso come non salvato): nessuna
      // modifica in sospeso, quindi nessun avviso alla chiusura della scheda.
      setHasUnsavedChanges(false);

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

  /**
   * Crea una nota laterale e la mette subito in editing nel floating HUD.
   *
   * La selezione dei **colli non viene azzerata**: una nota generata con
   * "Aggiungi Nota Laterale" nasce come *appendice* sotto la card del collo
   * (`ItemInspector` + `NoteInspector` impilati nella colonna HUD di sinistra),
   * così l'operatore continua a vedere il bancale da cui la nota deriva. La
   * selezione dei colli resta invece esclusiva quando si clicca una nota sul
   * canvas (`handleSelectNote`).
   */
  const handleAddNote = useCallback(
    (noteData: Omit<SideNote, 'id'>) => {
      const newNote: SideNote = {
        ...noteData,
        id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      };
      // Fotogramma PRIMA della mutazione: la creazione della nota è un passo.
      pushSnapshot(captureSnapshot());
      updateActiveNotes((prev) => [...prev, newNote]);
      setSelectedNoteId(newNote.id);
    },
    [updateActiveNotes, pushSnapshot, captureSnapshot]
  );

  /** Aggiorna testo, colore, corpo o misure di una nota. */
  const handleUpdateNote = useCallback(
    (id: string, updates: Partial<SideNote>) => {
      // Fotogramma PRIMA della mutazione: ogni modifica è un passo di Undo.
      pushSnapshot(captureSnapshot());
      updateActiveNotes((prev) =>
        prev.map((note) => (note.id === id ? { ...note, ...updates } : note))
      );
    },
    [updateActiveNotes, pushSnapshot, captureSnapshot]
  );

  /** Elimina una nota: la selezione viene azzerata per non lasciare riferimenti. */
  const handleDeleteNote = useCallback(
    (id: string) => {
      // Fotogramma PRIMA della mutazione: l'eliminazione è un passo di Undo.
      pushSnapshot(captureSnapshot());
      updateActiveNotes((prev) => prev.filter((note) => note.id !== id));
      setSelectedNoteId(null);
    },
    [updateActiveNotes, pushSnapshot, captureSnapshot]
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
  const handleUpdateNotePos = useCallback(
    (id: string, x: number, y: number) => {
      updateActiveNotes((prev) =>
        prev.map((note) =>
          note.id === id ? { ...note, x: toPrecision(x), y: toPrecision(y) } : note
        )
      );
    },
    [updateActiveNotes]
  );

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
      updateActiveNotes((prev) =>
        prev.map((note) =>
          note.id === id
            ? { ...note, width: toPrecision(size.width), height: toPrecision(size.height) }
            : note
        )
      );
    },
    [updateActiveNotes]
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

      // Spinta a Battuta con le quattro frecce: il blocco selezionato viene
      // portato a filo della parete o del primo ostacolo in quella direzione.
      // Le guardie sui campi di scrittura sono già passate, quindi mentre si
      // digita la freccia conserva il proprio ruolo di editing del testo.
      if (selectedItemIds.length > 0) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          handleDockSelected('left');
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          handleDockSelected('right');
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          handleDockSelected('up');
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          handleDockSelected('down');
          return;
        }
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
    handleDockSelected,
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

  // Nota attualmente selezionata: alimenta la card "Nota Laterale Selezionata"
  // nel floating HUD di sinistra (null = card chiusa).
  const selectedNote = notes.find((note) => note.id === selectedNoteId) ?? null;

  return (
    <>
      {/* Interfaccia interattiva: nascosta integralmente in fase di stampa. */}
      <div
        id="screen-app"
        className="flex h-screen w-screen bg-slate-100 overflow-hidden font-sans print:hidden"
      >
        {/* Sinistra: Telaio Camion multi-pianale.
            `relative`: àncora la colonna HUD fluttuante (`ItemInspector` per i
            colli selezionati e, come appendice, `NoteInspector` per la nota in
            editing) all'area del canvas, senza consumare larghezza di layout —
            requisito indispensabile ora che fino a `MAX_BAYS` camion vivono
            affiancati nello stesso canvas. */}
        <div className="flex-1 h-full relative">
          <TruckCanvas
            bays={bays}
            activeBayId={activeBay.id}
            selectedItemIds={selectedItemIds}
            selectedNoteId={selectedNoteId}
            labelDensity={labelDensity}
            onChangeLabelDensity={setLabelDensity}
            onSelectBay={handleSelectBay}
            onSelectItems={handleSelectItems}
            onSelectNote={handleSelectNote}
            onUpdateNotePos={handleUpdateNotePos}
            onUpdateNoteSize={handleUpdateNoteSize}
            onUpdateItemsPos={handleUpdateItemsPos}
            onBeginHistoryGesture={handleBeginHistoryGesture}
            onCommitHistoryGesture={handleCommitHistoryGesture}
          />

          {/* Floating HUD: colonna di sinistra con il cruscotto dei colli
              selezionati e, come appendice subito sotto, la nota laterale in
              editing. Il container è `pointer-events-none` (i click sulle aree
              vuote arrivano comunque al canvas), mentre le card al suo interno
              sono `pointer-events-auto`. Sostituisce il vecchio pannello della
              sidebar destra, che provocava un layout shift a ogni selezione. */}
          {(selectedItems.length > 0 || selectedNote !== null) && (
            <div className="absolute top-4 left-4 z-20 flex flex-col gap-2.5 w-72 md:w-80 pointer-events-none max-h-[calc(100vh-2rem)] overflow-y-auto pr-1">
              {selectedItems.length > 0 && (
                <ItemInspector
                  selectedItems={selectedItems}
                  vehicle={vehicle}
                  notes={notes}
                  onUpdateItemProperties={handleUpdateItemProperties}
                  onRotateSelected={handleRotateSelected}
                  onDockSelected={handleDockSelected}
                  onDeleteSelected={handleDeleteSelected}
                  onAddNote={handleAddNote}
                  onDeselect={() => setSelectedItemIds([])}
                />
              )}
              {selectedNote && (
                <NoteInspector
                  note={selectedNote}
                  onUpdateNote={handleUpdateNote}
                  onDeleteNote={handleDeleteNote}
                  onDeselect={() => setSelectedNoteId(null)}
                />
              )}
            </div>
          )}
        </div>

        {/* Destra: Plancia di Comando */}
        <div className="w-80 md:w-96 h-full flex-shrink-0">
          <ControlDeck
            bays={bays}
            activeBayId={activeBay.id}
            onSelectBay={handleSelectBay}
            onAddBay={handleAddBay}
            onDeleteBay={handleDeleteBay}
            vehicle={vehicle}
            onSelectVehicle={handleSelectVehicle}
            plate={vehiclePlate}
            onUpdatePlate={handleUpdatePlate}
            onSaveProject={handleSaveProject}
            onSaveProjectAs={handleSaveProjectAs}
            onLoadProject={handleLoadProject}
            activeFileName={activeFileName}
            isProjectSaved={isProjectSaved}
            savedFileName={savedFileName}
            onAddItem={handleAddItem}
            onAddBatch={handleAddBatch}
            onClearAll={handleClearAll}
            onNewProject={handleNewProject}
            hasUnsavedChanges={hasUnsavedChanges}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={handleUndo}
            onRedo={handleRedo}
            items={items}
            labelDensity={labelDensity}
            selectedItemIds={selectedItemIds}
            selectedNoteId={selectedNoteId}
          />
        </div>
      </div>

      {/* Scheda di carico A4: presente nel DOM, visibile solo su carta.
          In "Scheda Completa" genera **una pagina per ciascun mezzo** della
          centrale; nella modalità "Solo Grafica" i pianali vengono affiancati su
          un unico foglio A4 panoramico. */}
      <PrintReport bays={bays} labelDensity={labelDensity} />
    </>
  );
}