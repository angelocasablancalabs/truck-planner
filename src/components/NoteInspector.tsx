import React from 'react';
import type { SideNote } from '../types';
import {
  NOTE_DEFAULT_WIDTH_CM,
  NOTE_FONT_SIZES,
  NOTE_MAX_HEIGHT_CM,
  NOTE_MAX_WIDTH_CM,
  NOTE_MIN_HEIGHT_CM,
  NOTE_MIN_WIDTH_CM,
  NOTE_PASTEL_COLORS,
  NOTE_SIZE_STEP_CM,
  noteCharsPerLine,
  noteGeometry,
  resolveNoteFontSize,
} from '../utils/sideNotes';
import { FileText, Trash2, X } from 'lucide-react';

/**
 * NOTE INSPECTOR — CRUSCOTTO DELLA NOTA LATERALE SELEZIONATA (FLOATING HUD)
 *
 * L'editing di una nota laterale non vive più nella sidebar di destra: è una
 * **card fluttuante** che `App.tsx` impila nel container HUD in alto a sinistra
 * dell'area canvas, subito **sotto** la card dei colli selezionati
 * (`ItemInspector`) quando entrambe sono attive. Aprendo o selezionando una nota
 * la colonna dei comandi di destra non si muove di un pixel: il Riepilogo Stiva
 * resta perfettamente fermo.
 *
 * Il componente è puramente presentazionale: ogni mutazione (testo, corpo,
 * misure, colore) risale ad `App.tsx` attraverso `onUpdateNote`, unica fonte di
 * verità della stiva — quindi Undo / Redo, salvataggio e snapshot PNG
 * continuano a funzionare identici.
 *
 * Scorciatoie condivise (gestite a livello globale in `App.tsx`, non qui):
 * `Canc` elimina la nota quando nessun collo è selezionato. Il pulsante
 * "Cancella Nota" chiama la stessa callback.
 *
 * `onPointerDown` con `stopPropagation`: la card galleggia sopra il canvas,
 * quindi nessun gesto di pan / lasso / drag può partire da qui.
 */

/** Etichette del selettore compatto di dimensione testo (scala 11 / 14 / 18 px). */
const NOTE_FONT_LABELS: Record<number, string> = {
  11: 'A-',
  14: 'A',
  18: 'A+',
};

/** Classi di anteprima del glifo `A` per ciascun corpo della scala. */
const NOTE_FONT_PREVIEW_CLASS: Record<number, string> = {
  11: 'text-[10px]',
  14: 'text-[12px]',
  18: 'text-[15px]',
};

interface NoteInspectorProps {
  /** Nota attualmente selezionata (mai nulla: la card esiste solo se attiva). */
  note: SideNote;
  /** Aggiornamento di testo, corpo, misure o colore della nota. */
  onUpdateNote: (id: string, updates: Partial<SideNote>) => void;
  /** Eliminazione della nota (come `Canc`). */
  onDeleteNote: (id: string) => void;
  /** Chiude la card deselezionando la nota (pulsante `X`). */
  onDeselect: () => void;
}

export const NoteInspector: React.FC<NoteInspectorProps> = ({
  note,
  onUpdateNote,
  onDeleteNote,
  onDeselect,
}) => {
  /** Limiti fisici delle card di nota (cm): gli stessi applicati dalla maniglia. */
  const clampNoteWidth = (value: number): number => {
    const safe = Number.isFinite(value) && value > 0 ? value : NOTE_DEFAULT_WIDTH_CM;
    return Math.max(NOTE_MIN_WIDTH_CM, Math.min(NOTE_MAX_WIDTH_CM, Math.round(safe)));
  };
  const clampNoteHeight = (value: number): number => {
    const safe = Number.isFinite(value) && value > 0 ? value : NOTE_MIN_HEIGHT_CM;
    return Math.max(NOTE_MIN_HEIGHT_CM, Math.min(NOTE_MAX_HEIGHT_CM, Math.round(safe)));
  };

  /**
   * Geometria corrente della nota: fornisce l'altezza effettiva (auto-adattata al
   * testo finché l'operatore non la fissa) e il corpo del testo realmente
   * applicato nella card.
   */
  const geometry = noteGeometry(note);
  const fontSize = resolveNoteFontSize(note);
  /** Altezza mostrata nel campo H: quella esplicita, o quella misurata sul testo. */
  const height = note.height ?? geometry.height ?? NOTE_MIN_HEIGHT_CM;

  return (
    <div
      id="note-inspector"
      onPointerDown={(e) => e.stopPropagation()}
      className="note-inspector pointer-events-auto w-full bg-white/95 backdrop-blur-xs border border-slate-300 rounded-lg shadow-lg p-3.5 space-y-2.5 font-sans text-slate-800 transition-all select-none"
    >
      {/* --- Intestazione: titolo, chiusura della card e badge coordinate ------- */}
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-bold text-slate-800">
          <FileText className="h-3.5 w-3.5 shrink-0 text-slate-500" />
          <span>Nota Laterale Selezionata</span>
        </span>
        <button
          type="button"
          id="note-inspector-close"
          onClick={onDeselect}
          title="Chiudi la nota (deseleziona)"
          aria-label="Chiudi il cruscotto della nota laterale"
          className="-mt-0.5 -mr-0.5 shrink-0 rounded p-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <span className="inline-block rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[10px] font-bold tabular-nums text-slate-700">
        X {note.x.toFixed(1)} · Y {note.y.toFixed(1)} cm
      </span>

      {/* --- TESTO DELLA NOTA: unico campo libero multi-riga della card -------- */}
      <label className="block space-y-1">
        <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
          Testo della Nota
        </span>
        <textarea
          id="note-content-input"
          value={note.content}
          onChange={(e) => onUpdateNote(note.id, { content: e.target.value })}
          rows={4}
          placeholder="Scrivi avvertenze, cliente o note operative..."
          className="w-full resize-y bg-white border border-slate-300 text-slate-800 text-xs rounded p-1.5 leading-snug focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <span className="block text-[10px] text-slate-400 italic leading-snug">
          Il testo va a capo da solo, su {noteCharsPerLine(note.width, fontSize)} caratteri per
          riga con la dimensione attuale.
        </span>
      </label>

      {/* --- Dimensione del testo: i tre corpi della scala ufficiale ----------- */}
      <div className="space-y-1">
        <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
          Dimensione Testo
        </span>
        <div
          role="group"
          aria-label="Dimensione testo nota"
          className="grid grid-cols-3 gap-1 rounded bg-slate-200/70 p-1"
        >
          {NOTE_FONT_SIZES.map((size) => {
            const isActive = fontSize === size;
            return (
              <button
                key={size}
                type="button"
                data-font-size={size}
                aria-pressed={isActive}
                title={`Corpo del testo ${size} px`}
                onClick={() => onUpdateNote(note.id, { fontSize: size })}
                className={`rounded px-1 py-1 leading-none transition cursor-pointer ${
                  isActive
                    ? 'bg-white shadow-sm font-bold text-slate-800'
                    : 'text-slate-500 hover:text-slate-700 font-medium'
                }`}
              >
                <span className={NOTE_FONT_PREVIEW_CLASS[size]}>{NOTE_FONT_LABELS[size]}</span>
                <span className="ml-1 font-mono text-[9px]">({size}px)</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* --- Dimensioni della casella: larghezza e altezza in cm reali --------- */}
      <div className="flex gap-2">
        <label className="flex-1 space-y-1">
          <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
            Larghezza (W cm)
          </span>
          <input
            type="number"
            id="note-width-input"
            min={NOTE_MIN_WIDTH_CM}
            max={NOTE_MAX_WIDTH_CM}
            step={NOTE_SIZE_STEP_CM}
            value={Math.round(note.width)}
            onChange={(e) => onUpdateNote(note.id, { width: clampNoteWidth(Number(e.target.value)) })}
            className="w-full bg-white border border-slate-300 text-slate-800 text-xs rounded p-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>

        <label className="flex-1 space-y-1">
          <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
            Altezza (H cm)
          </span>
          <input
            type="number"
            id="note-height-input"
            min={NOTE_MIN_HEIGHT_CM}
            max={NOTE_MAX_HEIGHT_CM}
            step={NOTE_SIZE_STEP_CM}
            value={Math.round(height)}
            onChange={(e) =>
              onUpdateNote(note.id, { height: clampNoteHeight(Number(e.target.value)) })
            }
            className="w-full bg-white border border-slate-300 text-slate-800 text-xs rounded p-1.5 font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
      </div>

      {/* --- Palette rapida: 7 tinte pastello + bianco neutro ------------------ */}
      <div className="space-y-1">
        <span className="block text-[10px] font-bold text-slate-500 uppercase tracking-wider">
          Colore Sfondo
        </span>
        <div className="flex items-center gap-1" role="group" aria-label="Colore nota laterale">
          {NOTE_PASTEL_COLORS.map((hex) => {
            const isActive = note.color.toLowerCase() === hex.toLowerCase();
            return (
              <button
                key={hex}
                type="button"
                title={hex === '#FFFFFF' ? 'Bianco neutro' : `Sfondo ${hex}`}
                aria-label={hex === '#FFFFFF' ? 'Bianco neutro' : `Sfondo ${hex}`}
                aria-pressed={isActive}
                onClick={() => onUpdateNote(note.id, { color: hex })}
                className={`w-5 h-5 rounded-sm border border-slate-300 hover:scale-110 transition cursor-pointer ${
                  isActive ? 'ring-2 ring-blue-600' : ''
                }`}
                style={{ backgroundColor: hex }}
              />
            );
          })}
        </div>
      </div>

      {/* --- Eliminazione della nota (stessa azione del tasto `Canc`) ---------- */}
      <button
        type="button"
        id="btn-delete-note"
        onClick={() => onDeleteNote(note.id)}
        className="w-full bg-white hover:bg-red-50 border border-red-200 hover:border-red-300 text-red-800 hover:text-red-900 text-xs font-semibold py-1.5 rounded flex items-center justify-center gap-1 shadow-sm transition cursor-pointer"
        title="Elimina la nota laterale (oppure premi Canc)"
      >
        <Trash2 className="w-3.5 h-3.5 text-red-800" />
        Cancella Nota
      </button>
    </div>
  );
};
