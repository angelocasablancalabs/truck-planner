import type { LabelDensity, PlacedItem, VehicleConfig } from '../types';

/* -------------------------------------------------------------------------- *
 *  SPRINT D — ESPORTAZIONE IMMAGINE
 *
 *  Modulo puro + browser API per generare uno snapshot PNG "pulito" del pianale
 *  (nessun contorno di selezione, nessun lasso, nessun HUD) e copiarlo negli
 *  appunti di sistema, con fallback automatico su download del file.
 *
 *  Tutta la geometria è espressa in CENTIMETRI REALI del pianale: il viewBox
 *  dell'SVG è in cm, mentre la rasterizzazione avviene su un <canvas> a 2x
 *  (larghezza base 1200 px) per la massima nitidezza su schermi Retina.
 * -------------------------------------------------------------------------- */

/** Larghezza base (px CSS) dell'immagine esportata sul pianale. */
export const EXPORT_BASE_WIDTH = 1200;

/** Fattore di sovracampionamento dello snapshot (2 = Retina / zoom nitido). */
export const EXPORT_PIXEL_RATIO = 2;

/**
 * Area massima (px²) concessa al canvas di lavoro: limite prudenziale che evita
 * di superare i tetti di canvas dei browser (soprattutto Safari/iOS) quando il
 * rapporto d'aspetto del mezzo è molto allungato (bilico da 13,60 m).
 */
const MAX_CANVAS_AREA = 64_000_000;

/** Margine di sicurezza aggiunto sotto l'ultimo collo, per non tagliarlo (cm). */
export const BOTTOM_MARGIN_CM = 50;

/** Padding del viewBox attorno al pianale, in centimetri reali. */
const PADDING = { left: 26, right: 6, top: 38, bottom: 8 } as const;

/** Corpi testo (cm reali), allineati al rendering del canvas a schermo. */
const FONT = {
  name: 11,
  dimensions: 9,
  meter: 10,
  caption: 15,
  quota: 11,
} as const;

/** Larghezza media di un carattere come frazione del corpo (stima per troncare). */
const AVERAGE_CHAR_WIDTH = 0.58;

/** Palette CAD dello snapshot pulito (sobria, alto contrasto in stampa). */
const COLORS = {
  background: '#FFFFFF',
  deck: '#F8FAFC',
  wall: '#0F172A',
  grid: '#E2E8F0',
  gridText: '#94A3B8',
  caption: '#334155',
  name: '#1E293B',
  dimensions: '#475569',
} as const;

/** Font di sistema: leggibili sia a schermo sia nella rasterizzazione su canvas. */
const FONT_FAMILY = 'Helvetica, Arial, sans-serif';
/** Niente virgolette interne: la stringa viene interpolata in attributi XML. */
const MONO_FONT_FAMILY = 'SFMono-Regular, Menlo, Consolas, monospace';

/** Nome del file scaricato quando gli appunti non sono disponibili. */
const FALLBACK_FILE_NAME = 'piano-di-carico.png';

/**
 * Ingombro vettoriale completo del pianale, in centimetri reali.
 * Include l'eventuale sforamento posteriore dei colli oltre le porte.
 */
export interface PianoExtent {
  /** Bordo sinistro del viewBox (negativo: spazio per le tacche metriche). */
  minX: number;
  /** Bordo superiore del viewBox (negativo: spazio per la scritta CABINA). */
  minY: number;
  /** Larghezza totale del viewBox (cm). */
  width: number;
  /** Altezza totale del viewBox (cm). */
  height: number;
  /** Y (cm) dell'ultimo collo, sforamento posteriore incluso (+50 cm di margine). */
  contentBottom: number;
  /** Y (cm) della linea tratteggiata delle porte posteriori. */
  doorLine: number;
  /** Y (cm) della didascalia "PORTE POSTERIORI". */
  doorLabelY: number;
}

/** Snapshot SVG autonomo + dimensioni in px CSS dell'immagine finale. */
export interface PianoSnapshot {
  /** Stringa SVG completa e auto-consistente (nessuna risorsa esterna). */
  svg: string;
  /** Larghezza in px CSS (prima del sovracampionamento). */
  width: number;
  /** Altezza in px CSS (prima del sovracampionamento). */
  height: number;
}

/**
 * Calcola l'ingombro del pianale da esportare.
 *
 * L'altezza include anche gli eventuali colli che sforano dalle porte
 * posteriori, così nessun bancale viene tagliato nell'immagine:
 * `maxY = max(vehicle.length, ...items.map(i => i.y + i.length)) + 50`.
 *
 * @param vehicle Configurazione del mezzo (dimensioni utili in cm)
 * @param items   Colli stivati sul pianale
 */
export const getPianoExtent = (vehicle: VehicleConfig, items: PlacedItem[]): PianoExtent => {
  const maxY =
    Math.max(vehicle.length, ...items.map((item) => item.y + item.length)) + BOTTOM_MARGIN_CM;

  // Didascalia delle porte: sotto il pianale, oppure sotto l'eventuale sforamento.
  const hasOverhang = items.some((item) => item.y + item.length > vehicle.length);
  const doorLabelY = hasOverhang ? Math.max(...items.map((item) => item.y + item.length)) + 18 : vehicle.length + 24;

  return {
    minX: -PADDING.left,
    minY: -PADDING.top,
    width: vehicle.width + PADDING.left + PADDING.right,
    height: PADDING.top + maxY + PADDING.bottom,
    contentBottom: maxY,
    doorLine: vehicle.length,
    doorLabelY,
  };
};

/** Escape XML: i nomi cliente sono testo libero digitato dall'operatore. */
const escapeXml = (value: string): string =>
  value.replace(
    /[<>&"']/g,
    (char) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        '"': '&quot;',
        "'": '&apos;',
      })[char] ?? char
  );

/**
 * Tronca una stringa perché non esca dal rettangolo del collo.
 * La stima è volutamente conservativa (larghezza media dei glifi).
 */
const truncateToWidth = (text: string, maxWidthCm: number, fontSizeCm: number): string => {
  const maxChars = Math.max(1, Math.floor(maxWidthCm / (fontSizeCm * AVERAGE_CHAR_WIDTH)));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
};

/** Arrotonda a due decimali: stringhe SVG compatte e prive di rumore numerico. */
const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Etichette interne di un collo, secondo la densità scelta dall'operatore.
 * Lo snapshot esportato non contiene MAI i contorni blu di selezione o lasso.
 *
 * @param item         Collo da etichettare
 * @param labelDensity Densità etichette (`all` | `client` | `dimensions` | `minimal`)
 */
const renderItemLabels = (item: PlacedItem, labelDensity: LabelDensity): string => {
  if (labelDensity === 'minimal') return '';

  const centerX = item.width / 2;
  const centerY = item.length / 2;

  // Corpi mai più grandi del collo stesso: nessuna scritta che sborda.
  const nameFont = Math.min(FONT.name, item.width * 0.2, item.length * 0.28);
  const dimFont = Math.min(FONT.dimensions, item.width * 0.16, item.length * 0.22);
  const textMaxWidth = Math.max(4, item.width - 6);

  if (labelDensity === 'client') {
    const label = escapeXml(truncateToWidth(item.name, textMaxWidth, nameFont));
    return `<text x="${round(centerX)}" y="${round(centerY + nameFont * 0.35)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${round(nameFont)}" font-weight="bold" fill="${COLORS.name}">${label}</text>`;
  }

  if (labelDensity === 'dimensions') {
    const label = `${item.width}×${item.length}`;
    return `<text x="${round(centerX)}" y="${round(centerY + nameFont * 0.35)}" text-anchor="middle" font-family="${MONO_FONT_FAMILY}" font-size="${round(nameFont)}" font-weight="bold" fill="${COLORS.dimensions}">${label}</text>`;
  }

  // Densità `all`: nome cliente sopra, quote sotto (come a schermo).
  const name = escapeXml(truncateToWidth(item.name, textMaxWidth, nameFont));
  const dimensions = `${item.width}×${item.length}`;

  return [
    `<text x="${round(centerX)}" y="${round(centerY - dimFont * 0.6 + nameFont * 0.35)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${round(nameFont)}" font-weight="bold" fill="${COLORS.name}">${name}</text>`,
    `<text x="${round(centerX)}" y="${round(centerY + nameFont * 0.6 + dimFont * 0.35)}" text-anchor="middle" font-family="${MONO_FONT_FAMILY}" font-size="${round(dimFont)}" fill="${COLORS.dimensions}">${dimensions}</text>`,
  ].join('');
};

/** Rettangolo colorato del collo (fill pastello + bordo di catalogo). */
const renderItem = (item: PlacedItem, labelDensity: LabelDensity): string =>
  [
    `<g transform="translate(${round(item.x)}, ${round(item.y)})">`,
    `<rect width="${round(item.width)}" height="${round(item.length)}" rx="2" fill="${item.color}" stroke="${item.borderColor}" stroke-width="1.5"/>`,
    renderItemLabels(item, labelDensity),
    `</g>`,
  ].join('');

/**
 * Costruisce lo snapshot SVG autonomo e pulito del pianale.
 *
 * Contenuto (in cm reali, Y = 0 in alto verso la Cabina):
 * sfondo bianco, piano di carico, tacche metriche ogni metro, tutti i colli
 * con colore/bordo/etichette, sponde laterali, parete Cabina, linea tratteggiata
 * delle porte posteriori e quote principali. Nessun elemento di interfaccia.
 *
 * @param vehicle      Configurazione del mezzo
 * @param items        Colli stivati
 * @param labelDensity Densità delle etichette (`all` | `client` | `dimensions` | `minimal`)
 */
export const buildPianoSvg = (
  vehicle: VehicleConfig,
  items: PlacedItem[],
  labelDensity: LabelDensity
): PianoSnapshot => {
  const extent = getPianoExtent(vehicle, items);
  const pxPerCm = EXPORT_BASE_WIDTH / extent.width;
  const height = Math.max(1, Math.round(extent.height * pxPerCm));

  const parts: string[] = [];

  // Sfondo bianco pieno (lo snapshot deve restare leggibile su qualsiasi chat).
  parts.push(
    `<rect x="${extent.minX}" y="${extent.minY}" width="${round(extent.width)}" height="${round(
      extent.height
    )}" fill="${COLORS.background}"/>`
  );

  // Piano di carico utile (leggera campitura, silhouette leggibile).
  parts.push(
    `<rect x="0" y="0" width="${vehicle.width}" height="${vehicle.length}" rx="2" fill="${COLORS.deck}"/>`
  );

  // Tacche metriche: linea ogni metro + quota a sinistra del pianale.
  for (let y = 100; y < vehicle.length; y += 100) {
    parts.push(
      `<line x1="0" y1="${y}" x2="${vehicle.width}" y2="${y}" stroke="${COLORS.grid}" stroke-width="1" stroke-dasharray="4 4"/>`,
      `<text x="-4" y="${round(y + FONT.meter * 0.35)}" text-anchor="end" font-family="${MONO_FONT_FAMILY}" font-size="${FONT.meter}" fill="${COLORS.gridText}">${y / 100}m</text>`
    );
  }

  // Colli stivati: colore, bordo e testo formattato secondo la densità.
  for (const item of items) parts.push(renderItem(item, labelDensity));

  // Sponde laterali e parete Cabina.
  parts.push(
    `<line x1="0" y1="0" x2="${vehicle.width}" y2="0" stroke="${COLORS.wall}" stroke-width="4"/>`,
    `<line x1="0" y1="0" x2="0" y2="${vehicle.length}" stroke="${COLORS.wall}" stroke-width="3"/>`,
    `<line x1="${vehicle.width}" y1="0" x2="${vehicle.width}" y2="${vehicle.length}" stroke="${COLORS.wall}" stroke-width="3"/>`
  );

  // Porte posteriori: linea tratteggiata alla fine del pianale utile.
  parts.push(
    `<line x1="0" y1="${vehicle.length}" x2="${vehicle.width}" y2="${vehicle.length}" stroke="${COLORS.wall}" stroke-width="3" stroke-dasharray="16 8"/>`
  );

  // Intestazioni e quote.
  parts.push(
    `<text x="${vehicle.width / 2}" y="${round(extent.minY + FONT.caption * 1.05)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${FONT.caption}" font-weight="bold" fill="${COLORS.caption}">▲ [ CABINA ] ▲</text>`,
    `<text x="${vehicle.width / 2}" y="${round(-FONT.quota * 0.4)}" text-anchor="middle" font-family="${MONO_FONT_FAMILY}" font-size="${FONT.quota}" fill="${COLORS.gridText}">${vehicle.width} cm</text>`,
    `<text x="${vehicle.width / 2}" y="${round(extent.doorLabelY)}" text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${FONT.caption * 0.93}" font-weight="bold" fill="${COLORS.caption}">▼ [ PORTE POSTERIORI ] ▼</text>`
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${EXPORT_BASE_WIDTH}" height="${height}" viewBox="${extent.minX} ${extent.minY} ${round(
    extent.width
  )} ${round(extent.height)}"><title>Piano di carico ${escapeXml(vehicle.name)}</title>${parts.join(
    ''
  )}</svg>`;

  return { svg, width: EXPORT_BASE_WIDTH, height };
};

/**
 * Rasterizza una stringa SVG in un blob PNG tramite canvas HTML5 offscreen.
 *
 * Il canvas lavora a `EXPORT_PIXEL_RATIO`x (2x) per garantire nitidezza su
 * schermi Retina e in zoom; il fattore viene ridotto automaticamente solo se
 * l'area risultante supererebbe i limiti di canvas del browser.
 *
 * @param snapshot SVG autonomo + dimensioni logiche in px CSS
 */
export const rasterizeSnapshotToPng = (snapshot: PianoSnapshot): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const { svg, width, height } = snapshot;

    const maxRatio = Math.sqrt(MAX_CANVAS_AREA / Math.max(1, width * height));
    const ratio = Math.max(1, Math.min(EXPORT_PIXEL_RATIO, maxRatio));

    const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const objectUrl = URL.createObjectURL(svgBlob);
    const image = new Image();

    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Contesto canvas 2D non disponibile');

        // Sfondo esplicito: il PNG non deve avere trasparenze inattese.
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(objectUrl);
            if (blob) resolve(blob);
            else reject(new Error('Conversione PNG fallita'));
          },
          'image/png'
        );
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        reject(error);
      }
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Rendering SVG fallito'));
    };

    image.src = objectUrl;
  });

/** Scarica un blob come file, con il nome indicato. */
const downloadBlob = (blob: Blob, fileName: string): void => {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoca differita: Safari ha bisogno che il click sia già stato processato.
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
};

/**
 * Copia negli appunti di sistema lo snapshot PNG ad alta risoluzione del
 * pianale (per WhatsApp / Mail). Se l'API Clipboard non è disponibile o viene
 * negata (permessi, contesto non sicuro, browser non compatibile), scarica
 * automaticamente il file `piano-di-carico.png`.
 *
 * Non lancia mai: restituisce sempre un esito booleano.
 *
 * @param vehicle      Configurazione del mezzo
 * @param items        Colli stivati
 * @param labelDensity Densità delle etichette applicata allo snapshot
 * @returns `true` se l'immagine è finita negli appunti, `false` se è stata scaricata
 */
export const copyCanvasToClipboard = async (
  vehicle: VehicleConfig,
  items: PlacedItem[],
  labelDensity: LabelDensity
): Promise<boolean> => {
  let pngBlob: Blob;

  try {
    pngBlob = await rasterizeSnapshotToPng(buildPianoSvg(vehicle, items, labelDensity));
  } catch (error) {
    console.error('[export] Generazione dello snapshot PNG non riuscita:', error);
    return false;
  }

  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
      throw new Error('Clipboard API non disponibile');
    }

    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    return true;
  } catch (error) {
    // Fallback silenzioso: permessi limitati o API assente → download del PNG.
    console.warn('[export] Copia negli appunti non disponibile, scarico il file:', error);
    downloadBlob(pngBlob, FALLBACK_FILE_NAME);
    return false;
  }
};
