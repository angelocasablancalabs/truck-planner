import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  /**
   * GitHub Pages serve il sito da una sottocartella (project page) e non dalla
   * radice del dominio: senza `base` tutti gli asset verrebbero richiesti a
   * `/assets/...` e la pagina pubblicata risulterebbe bianca (404 su JS e CSS).
   * Il valore deve restare allineato al nome del repository.
   */
  base: '/truck-planner/',
  plugins: [
    react(),
    tailwindcss()
  ],
  server: {
    watch: {
      /**
       * Su Windows chokidar muore con `EBUSY` se prova a registrare un file
       * permanentemente bloccato da un altro processo: l'errore viene emesso
       * sull'evento e Vite termina. Le due sorgenti osservate finora:
       *
       *  1. gli editor che salvano con sostituzione atomica creano accanto al
       *     file reale una cartella `.<nomefile>.<pid>.<uuid>.tmpdir/`;
       *  2. gli script di verifica headless creano profili Chrome completi
       *     (`tmp/<nome>-profile/Default/Network/Cookies`, `History`, …), che
       *     sono database SQLite tenuti aperti dal browser.
       *
       * Escludendo queste directory il watcher non le vede più, mentre `src/`
       * continua a essere sorvegliato normalmente.
       */
      ignored: [
        '**/.*.tmpdir/**',
        '**/*.tmpdir/**',
        '**/tmp/**',
        '**/*-profile/**',
        '**/*.tmp/**',
      ],
    },
  },
})