import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss()
  ],
  server: {
    watch: {
      /**
       * Gli editor che salvano con sostituzione atomica creano, accanto al file
       * reale, una cartella temporanea `.<nomefile>.<pid>.<uuid>.tmpdir/`.
       * Su Windows quel file temporaneo può restare bloccato (antivirus,
       * indicizzatore) proprio mentre chokidar prova a registrarlo: il watcher
       * emette `EBUSY` e il dev server termina. Escludendo le directory
       * temporanee il watcher non le vede più e la stabilità è garantita.
       */
      ignored: ['**/.*.tmpdir/**', '**/*.tmpdir/**'],
    },
  },
})