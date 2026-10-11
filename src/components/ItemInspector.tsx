import React from 'react';
import type { PlacedItem, SideNote, VehicleConfig } from '../types';
import { COLOR_FAMILIES } from '../constants';
import type { ColorFamily } from '../constants';
import {
  NOTE_BORDER_COLOR,
  NOTE_DEFAULT_FONT_SIZE,
  NOTE_DEFAULT_WIDTH_CM,
  NOTE_LANE_OFFSET_CM,
  buildNoteSeedText,
  findFreeNoteY,
} from '../utils/sideNotes';
import { AlignLeft, AlignRight, FileText, RotateCw, Trash2, X } from 'lucide-react';

/**
 * ITEM INSPECTOR — CRUSCOTTO DEI COLLI SELEZIONATI (FLOATING HUD)
 *
 * Il cruscotto di modifica dei colli selezionati non vive più dentro la sidebar
 * di destra: è una **card fluttuante** ancorata in alto a sinistra dell'area del
 * canvas (`absolute top-4 left-4 z-20`), visibile esclusivamente quando c'è
 * almeno un collo selezionato.
 *
 * Perché: il vecchio pannello azzurro in `ControlDeck` spingeva verso il basso
 * il Riepilogo Stiva a ogni selezione (layout shift continuo) e affollava la
 * colonna dei comandi. In ottica **multi-pianale** (fino a 3 camion affiancati)
 * lo spazio orizzontale è prezioso: una seconda sidebar fissa sarebbe
 * insostenibile, mentre un HUD sopra il canvas non consuma larghezza di layout.
 *
 * Il componente è puramente presentazionale: ogni mutazione risale ad `App.tsx`
 * attraverso le callback ricevute (unica fonte di verità della stiva), quindi
 * Undo / Redo, salvataggio e snapshot PNG continuano a funzionare identici.
 *
 * Scorciatoie condivise (gestite a livello globale in `App.tsx`, non qui):
 * `Spazio` ruota, `Canc` elimina, le quattro frecce spingono il blocco a
 * battuta. I pulsanti di questa card chiamano le stesse callback.
 */

/** Testo di partenza di una nota appena creata, da personalizzare. */
const DEFAULT_NOTE_CONTENT = 'Inserisci nota operativa...';

/**
 * Matrice colori stile Excel: 7 famiglie × 3 sfumature = 21 tinte.
 * Le tre righe si susseguono dalla tonalità chiara alla scura.
 */
const COLOR_SHADE_ROWS: { key: keyof ColorFamily['shades']; label: string }[] = [
  { key: 'light', label: 'chiaro' },
  { key: 'medium', label: 'medio' },
  { key: 'dark', label: 'scuro' },
];

interface ItemInspectorProps {
  /** Colli attualmente selezionati, nell'ordine di selezione (mai vuoto). */
  selectedItems: PlacedItem[];
  /** Mezzo attivo: serve per la corsia di nascita della nota laterale. */
  vehicle: VehicleConfig;
  /** Note laterali presenti: usate dall'anti-sovrapposizione allo spawn. */
  notes: SideNote[];
  /** Aggiornamento proprietà (Nome / Cliente, tinta) su uno o più colli. */
  onUpdateItemProperties: (ids: string[], updates: Partial<PlacedItem>) => void;
  /** Rotazione di 90° di tutti i colli selezionati (come la Barra Spaziatrice). */
  onRotateSelected: () => void;
  /** Spinta a battuta orizzontale del blocco (come le frecce ← / →). */
  onDockSelected: (direction: 'left' | 'right') => void;
  /** Eliminazione di tutti i colli selezionati (come `Canc`). */
  onDeleteSelected: () => void;
  /** Crea una nota laterale con eredità di quota, testo e colore. */
  onAddNote: (note: Omit<SideNote, 'id'>) => void;
  /** Chiude la card svuotando la selezione (pulsante `X`). */
  onDeselect: () => void;
}

export const ItemInspector: React.FC<ItemInspectorProps> = ({
  selectedItems,
  vehicle,
  notes,
  onUpdateItemProperties,
  onRotateSelected,
  onDockSelected,
  onDeleteSelected,
  onAddNote,
  onDeselect,
}) => {
  // Selezione svuotata (es. colli appena cancellati): nessuna card a schermo.
  if (selectedItems.length === 0) return null;

  const selectedItem = selectedItems.length === 1 ? selectedItems[0] : null;
  const selectedIds = selectedItems.map((item) => item.id);
  const isMultiSelection = selectedItems.length > 1;

  /** Nome comune a tutti i colli selezionati ('' se divergenti). */
  const sharedName = selectedItems.every((item) => item.name === selectedItems[0].name)
    ? selectedItems[0].name
    : '';

  /** Colore comune a tutti i colli selezionati (null se divergenti). */
  const sharedColor = selectedItems.every(
    (item) => item.color.toLowerCase() === selectedItems[0].color.toLowerCase()
  )
    ? selectedItems[0].color.toLowerCase()
    : null;

  /**
   * Matrice colori compatta 7 colonne (famiglie) × 3 righe (sfumature):
   * riga 1 chiara, riga 2 media, riga 3 scura. Le caselle sono rettangolini
   * `w-5 h-4.5` con bordo sottile; la tinta attiva è evidenziata da un anellino
   * blu (`ring-2 ring-blue-600`).
   *
   * Cliccando una casella viene aggiornato **solo** il riempimento dei colli
   * selezionati: il contorno resta rigidamente `ITEM_BORDER_COLOR` (`#334155`).
   */
  const renderColorMatrix = (activeColor: string | null) => (
    <div role="group" aria-label="Matrice colori" className="inline-flex flex-col gap-0.5">
      {COLOR_SHADE_ROWS.map((shade) => (
        <div key={shade.key} className="flex items-center gap-1">
          {COLOR_FAMILIES.map((family) => {
            const hex = family.shades[shade.key];
            // Confronto case-insensitive: i colori possono arrivare in HEX maiuscolo.
            const isActive = activeColor?.toLowerCase() === hex.toLowerCase();
            return (
              <button
                key={`${family.id}-${shade.key}`}
                type="button"
                title={`${family.name} ${shade.label}`}
                aria-label={`Colore ${family.name} ${shade.label}`}
                aria-pressed={isActive}
                onClick={() => onUpdateItemProperties(selectedIds, { color: hex })}
                className={`w-5 h-4.5 rounded-sm border border-slate-300 hover:scale-110 transition cursor-pointer ${
                  isActive ? 'ring-2 ring-blue-600' : ''
                }`}
                style={{ backgroundColor: hex }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );

  /**
   * Crea una nota laterale a partire dai colli selezionati, con eredità
   * automatica di quota, testo e colore:
   * - `x`: `vehicle.width + NOTE_LANE_OFFSET_CM` — nasce subito a **destra della
   *   parete** del semirimorchio (poi è libera di andare ovunque in 2D);
   * - `y`: quota minima Y della selezione (la nota si allinea alla loro altezza),
   *   scorrita verso il basso solo se una card esistente occupa già quello spazio;
   * - `content`: pre-popolato col nome del primo collo (es. `"PRODIVA 3S - "`),
   *   già pronto per essere completato con l'avvertenza operativa;
   * - `color`: l'esatto pastello di riempimento del collo selezionato;
   * - `borderColor`: metadato storico `#94A3B8` (la card è senza bordo a riposo),
   *   `width`: 140 cm, `fontSize`: 14 px (taglia "Media" della scala 11/14/18).
   */
  const handleAddSideNote = () => {
    const anchor = selectedItems[0];
    const draft: Omit<SideNote, 'id'> = {
      x: vehicle.width + NOTE_LANE_OFFSET_CM,
      y: Math.min(...selectedItems.map((item) => item.y)),
      content: buildNoteSeedText(anchor.name) || DEFAULT_NOTE_CONTENT,
      color: anchor.color,
      borderColor: NOTE_BORDER_COLOR,
      width: NOTE_DEFAULT_WIDTH_CM,
      fontSize: NOTE_DEFAULT_FONT_SIZE,
    };

    // Spawn ordinato: se un'altra nota occupa già quello spazio, la nuova card
    // scende di poco invece di sovrapporsi (le note esistenti non si muovono).
    onAddNote({
      ...draft,
      y: findFreeNoteY(notes, { x: draft.x, y: draft.y }, draft),
    });
  };

  return (
    <div
      id="item-inspector"
      /* `stopPropagation` sul pointerdown: la card galleggia sopra il canvas,
         quindi nessun gesto di pan / lasso / drag può partire da qui. */
      onPointerDown={(e) => e.stopPropagation()}
      className="item-inspector absolute top-4 left-4 z-20 w-72 md:w-80 bg-white/95 backdrop-blur-xs border border-slate-300 rounded-lg shadow-lg p-3.5 space-y-3 font-sans text-slate-800 transition-all select-none"
    >
      {/* --- Intestazione: collo singolo oppure badge col conteggio del gruppo --- */}
      <div className="flex items-start justify-between gap-2">
        {selectedItem ? (
          <div className="min-w-0 text-xs font-bold leading-snug text-slate-800">
            <span className="text-slate-500">Selezionato: </span>
            <span className="break-words" title={selectedItem.name}>
              {selectedItem.name}
            </span>{' '}
            <span className="font-mono text-[11px] font-semibold text-slate-500 whitespace-nowrap">
              ({selectedItem.width}×{selectedItem.length} cm)
            </span>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-xs font-bold text-slate-800">Selezionati:</span>
            <span className="text-[11px] font-mono font-bold bg-blue-600 text-white px-2 py-0.5 rounded-full">
              {selectedItems.length} Colli
            </span>
          </div>
        )}

        <button
          type="button"
          id="item-inspector-close"
          onClick={onDeselect}
          title="Chiudi il cruscotto (deseleziona)"
          aria-label="Chiudi il cruscotto dei colli selezionati"
          className="-mt-0.5 -mr-0.5 shrink-0 rounded p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* --- Nome / Cliente: aggiornamento istantaneo su canvas e riepilogo ------ */}
      <label className="block space-y-1">
        <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
          Nome / Cliente
        </span>
        <input
          type="text"
          id="item-inspector-name"
          value={selectedItem ? selectedItem.name : sharedName}
          onChange={(e) => onUpdateItemProperties(selectedIds, { name: e.target.value })}
          placeholder={isMultiSelection ? 'Assegna nome a tutti...' : 'Es. Cliente / Macchinario'}
          className="w-full bg-white border border-slate-300 text-slate-800 text-xs rounded p-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </label>

      {/* --- Matrice colori (7 famiglie × 3 sfumature), singola o batch --------- */}
      <div className="space-y-1">
        <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
          Colore
        </span>
        {renderColorMatrix(selectedItem ? selectedItem.color : sharedColor)}
      </div>

      {/* --- Azioni rapide: rotazione e cancellazione --------------------------- */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onRotateSelected}
          className="flex-1 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 text-xs font-semibold py-1.5 rounded flex items-center justify-center gap-1 shadow-sm transition cursor-pointer"
          title="Oppure premi la Barra Spaziatrice"
        >
          <RotateCw className="w-3.5 h-3.5 text-blue-600" /> Ruota 90°
        </button>
        <button
          type="button"
          onClick={onDeleteSelected}
          className="flex-1 bg-white hover:bg-red-50 border border-red-200 hover:border-red-300 text-red-800 hover:text-red-900 text-xs font-semibold py-1.5 rounded flex items-center justify-center gap-1 shadow-sm transition cursor-pointer"
          title="Oppure premi Canc"
        >
          <Trash2 className="w-3.5 h-3.5 text-red-800" />
          {isMultiSelection ? `Cancella (${selectedItems.length})` : 'Cancella'}
        </button>
      </div>

      {/* --- Spinta a Battuta (Sweep Docking) orizzontale ----------------------- */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onDockSelected('left')}
          className="flex-1 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 text-xs font-semibold py-1.5 rounded flex items-center justify-center gap-1 shadow-sm transition cursor-pointer"
          title="Spingi a battuta a sinistra (Freccia ←)"
        >
          <AlignLeft className="w-3.5 h-3.5 text-slate-600" />
          <span>Spingi a SX</span>
        </button>
        <button
          type="button"
          onClick={() => onDockSelected('right')}
          className="flex-1 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 text-xs font-semibold py-1.5 rounded flex items-center justify-center gap-1 shadow-sm transition cursor-pointer"
          title="Spingi a battuta a destra (Freccia →)"
        >
          <AlignRight className="w-3.5 h-3.5 text-slate-600" />
          <span>Spingi a DX</span>
        </button>
      </div>

      {/* --- Nota laterale con eredità automatica dal collo -------------------- */}
      <button
        type="button"
        id="btn-add-side-note"
        onClick={handleAddSideNote}
        title={`Crea una nota laterale alla quota Y = ${Math.min(
          ...selectedItems.map((item) => item.y)
        )} cm, col colore di ${selectedItems[0].name}`}
        className="w-full bg-white hover:bg-slate-50 border border-slate-300 hover:border-slate-400 text-slate-700 text-xs font-semibold py-1.5 rounded flex items-center justify-center gap-1.5 shadow-sm transition cursor-pointer"
      >
        <FileText className="w-3.5 h-3.5 text-slate-500" />
        Aggiungi Nota Laterale
      </button>
    </div>
  );
};
