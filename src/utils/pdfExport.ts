/* -------------------------------------------------------------------------- *
 *  PDF DIRETTO PULITO — SOLO GRAFICA DEL PIANALE
 *
 *  Genera e scarica un file `.pdf` contenente **esclusivamente il disegno del
 *  carico**: veicolo, colli, quote metriche, targa in alto e note laterali a
 *  destra. Restano fuori l'intestazione formale `PIANO DI CARICO` e la tabella
 *  dei totali: quelli appartengono alla scheda A4 completa (`PrintReport`), che
 *  si ottiene con il comando `Stampa Piano`.
 *
 *  Nessuna libreria esterna (niente jsPDF / pdf-lib): il PDF viene composto a
 *  mano, byte per byte, come PDF 1.4 minimale ma **strutturalmente valido** —
 *  cinque oggetti (catalogo, albero delle pagine, pagina A4, contenuto e
 *  XObject immagine), tavola `xref` con offset reali e trailer con `startxref`.
 *
 *  La grafica riusa lo **stesso** snapshot vettoriale di `Copia Immagine`
 *  (`buildPianoSvg`): ciò che si vede negli appunti è esattamente ciò che
 *  finisce nel PDF. Lo snapshot viene rasterizzato su canvas a **3x** (~480 DPI
 *  equivalenti su A4) in JPEG qualità 0.95 e incorporato nel PDF con il filtro
 *  nativo `/DCTDecode` — il formato immagine più compatto e universalmente
 *  supportato dai lettori PDF.
 * -------------------------------------------------------------------------- */

import type { LabelDensity, PlacedItem, SideNote, VehicleConfig } from '../types';
import { buildPianoSvg, MAX_CANVAS_AREA, type PianoSnapshot } from './export';
import { buildProjectFileName } from './fileStorage';

/** Larghezza del foglio A4 verticale in punti tipografici (1 pt = 1/72"). */
const A4_WIDTH_PT = 595.28;
/** Altezza del foglio A4 verticale in punti tipografici. */
const A4_HEIGHT_PT = 841.89;
/** Margine di sicurezza su ogni lato: 10 mm (= 28,35 pt), come la scheda A4. */
const A4_MARGIN_PT = 28.35;
/**
 * Sovracampionamento della rasterizzazione PDF: **3x** (Retina HD).
 *
 * Lo snapshot vettoriale è largo 1200 px di base, quindi il JPEG incorporato
 * nasce a 3600 px sul lato corto — l'equivalente di ~480 DPI su un A4 con
 * margini di 10 mm. Il disegno resta così nitidissimo anche con zoom spinti nel
 * lettore PDF, dove i 2x precedenti iniziavano a sgranare. È volutamente più
 * alto del `EXPORT_PIXEL_RATIO` (2x) dello snapshot PNG: il PDF è un documento
 * d'archivio, il PNG una condivisione rapida da WhatsApp o Mail.
 */
const PDF_PIXEL_RATIO = 3;
/** Qualità JPEG dell'immagine incorporata: alta, per non perdere le linee 1px. */
const JPEG_QUALITY = 0.95;

/**
 * Riga di commento binaria dell'header PDF (`%` + 4 byte > 127 + a capo):
 * segnala ai tool che trattano i file come testo che il contenuto è binario.
 */
const BINARY_COMMENT_BYTES = new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);

/** Immagine raster pronta per l'incorporamento + dimensioni in pixel. */
interface RasterizedImage {
  /** Byte del JPEG (senza wrapper, come richiesto da `/DCTDecode`). */
  bytes: Uint8Array<ArrayBuffer>;
  /** Larghezza in pixel dell'immagine rasterizzata. */
  width: number;
  /** Altezza in pixel dell'immagine rasterizzata. */
  height: number;
}

/**
 * Compone un PDF 1.4 minimale che impagina il JPEG **centrato** su un foglio A4
 * verticale, scalato in modo da riempire l'area utile senza mai deformarlo né
 * uscire dai margini di 10 mm.
 *
 * Struttura prodotta (offset della tavola `xref` calcolati sui byte reali):
 * ```
 * 1 Catalog → 2 Pages → 3 Page (MediaBox A4) → 4 Contents → 5 Image (DCTDecode)
 * ```
 *
 * @param image Immagine raster (JPEG + dimensioni in pixel) da impaginare.
 */
const createA4PdfFromJpeg = (image: RasterizedImage): Blob => {
  const { bytes: jpegBytes, width: imageWidth, height: imageHeight } = image;

  // Area utile del foglio: A4 meno i margini su entrambi i lati.
  const maxW = A4_WIDTH_PT - A4_MARGIN_PT * 2;
  const maxH = A4_HEIGHT_PT - A4_MARGIN_PT * 2;
  // Scala unica (nessuna deformazione) e centratura ottica nel foglio.
  const scale = Math.min(maxW / imageWidth, maxH / imageHeight);
  const renderW = imageWidth * scale;
  const renderH = imageHeight * scale;
  const offsetX = (A4_WIDTH_PT - renderW) / 2;
  const offsetY = (A4_HEIGHT_PT - renderH) / 2;

  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let byteLength = 0;

  /** Accoda una parte (testo ASCII/Latin-1 oppure byte grezzi) al documento. */
  const push = (part: string | Uint8Array<ArrayBuffer>): void => {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    chunks.push(bytes);
    byteLength += bytes.length;
  };

  /** Offset (in byte) dell'inizio di ogni oggetto, per la tavola `xref`. */
  const offsets: number[] = [];

  /** Apre, riempie e chiude un oggetto **interamente testuale**. */
  const writeObject = (index: number, body: string): void => {
    offsets[index - 1] = byteLength;
    push(`${index} 0 obj\n${body}\nendobj\n`);
  };

  // Header: versione + commento binario (già terminato da a-capo).
  push('%PDF-1.4\n');
  push(BINARY_COMMENT_BYTES);

  // 1) Catalogo del documento: punta all'albero delle pagine.
  writeObject(1, '<< /Type /Catalog /Pages 2 0 R >>');

  // 2) Albero delle pagine: una sola pagina A4 verticale.
  writeObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');

  // 3) Pagina: MediaBox A4, risorse con l'immagine `Im1`, contenuto 4.
  writeObject(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_WIDTH_PT.toFixed(2)} ${A4_HEIGHT_PT.toFixed(
      2
    )}] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>`
  );

  // 4) Contenuto: matrice `cm` che posiziona e scala l'immagine, poi `/Im1 Do`.
  //    `q` / `Q` isolano la trasformazione dal resto del flusso. Il flusso NON
  //    termina con un a-capo: l'EOL prima di `endstream` non fa parte dei dati,
  //    quindi `/Length` coincide esattamente con i byte del contenuto.
  const streamContent = `q\n${renderW.toFixed(2)} 0 0 ${renderH.toFixed(2)} ${offsetX.toFixed(
    2
  )} ${offsetY.toFixed(2)} cm\n/Im1 Do\nQ`;
  offsets[3] = byteLength;
  push(`4 0 obj\n<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream\nendobj\n`);

  // 5) XObject immagine: i byte JPEG entrano nel flusso **tal quali** (binario),
  //    quindi l'oggetto viene composto a mano e non da `writeObject`.
  offsets[4] = byteLength;
  push(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imageWidth} /Height ${imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
  );
  push(jpegBytes);
  // L'a-capo prima di `endstream` non fa parte del flusso (non è in `/Length`).
  push('\nendstream\nendobj\n');

  // Tavola `xref`: una riga per oggetto, con l'offset reale in 10 cifre.
  const xrefOffset = byteLength;
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }
  push(xref);

  // Trailer: dimensione del documento, radice e puntatore alla tavola `xref`.
  push(
    `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  );

  return new Blob(chunks, { type: 'application/pdf' });
};

/**
 * Rasterizza lo snapshot vettoriale in JPEG a risoluzione ultra-nitida (3x,
 * ~480 DPI equivalenti su A4) con qualità JPEG 0.95: niente sgranature nemmeno
 * con zoom spinti nel lettore PDF.
 *
 * Il fattore viene ridotto **automaticamente** solo se l'area risultante
 * supererebbe i limiti di canvas dei browser: il caso limite è il mezzo
 * personalizzato più lungo consentito, dove 3x porterebbe il canvas oltre i
 * 64 megapixel. Sui mezzi di catalogo il 3x è sempre applicato per intero.
 *
 * @param snapshot SVG autonomo + dimensioni logiche in px CSS.
 */
const rasterizeSnapshotToJpeg = async (snapshot: PianoSnapshot): Promise<RasterizedImage> => {
  const { svg, width, height } = snapshot;

  const maxRatio = Math.sqrt(MAX_CANVAS_AREA / Math.max(1, width * height));
  const pxRatio = Math.max(1, Math.min(PDF_PIXEL_RATIO, maxRatio));
  const widthPx = Math.round(width * pxRatio);
  const heightPx = Math.round(height * pxRatio);

  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Contesto canvas 2D non disponibile');

  // Sfondo bianco esplicito: il PDF non deve mostrare trasparenze inattese.
  context.fillStyle = '#FFFFFF';
  context.fillRect(0, 0, widthPx, heightPx);

  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const objectUrl = URL.createObjectURL(svgBlob);

  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Rendering SVG fallito'));
      image.src = objectUrl;
    });
    context.drawImage(image, 0, 0, widthPx, heightPx);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }

  const jpegBlob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', JPEG_QUALITY)
  );
  if (!jpegBlob) throw new Error('Rasterizzazione JPEG fallita');

  return {
    bytes: new Uint8Array(await jpegBlob.arrayBuffer()),
    width: widthPx,
    height: heightPx,
  };
};

/**
 * Esporta lo snapshot del pianale — **identico** a quello di `Copia Immagine`:
 * veicolo, colli, quote metriche, targa in alto e note laterali a destra — in un
 * file PDF scaricato direttamente nella cartella Download.
 *
 * Il nome del file segue la stessa convenzione del progetto JSON:
 * `piano-<TARGA>-<YYYY-MM-DD>.pdf`, oppure `piano-carico-<YYYY-MM-DD>.pdf`
 * quando la targa è vuota.
 *
 * @param vehicle      Configurazione del mezzo (dimensioni utili in cm)
 * @param items        Colli stivati sul pianale
 * @param labelDensity Densità etichette applicata al disegno esportato
 * @param notes        Note laterali di carico da riportare nel disegno
 * @param plate        Targa / identificativo del mezzo (vuota = nessun badge)
 * @throws se il canvas 2D non è disponibile o la rasterizzazione fallisce.
 */
export const exportCleanPianoToPdf = async (
  vehicle: VehicleConfig,
  items: PlacedItem[],
  labelDensity: LabelDensity,
  notes: SideNote[] = [],
  plate: string = ''
): Promise<void> => {
  const snapshot = buildPianoSvg(vehicle, items, labelDensity, notes, plate);
  const image = await rasterizeSnapshotToJpeg(snapshot);
  const pdfBlob = createA4PdfFromJpeg(image);

  // Nome file coerente con il salvataggio `.json`: `piano-<TARGA>-<data>.pdf`.
  const baseName = buildProjectFileName(plate).replace(/\.json$/i, '');
  const fileName = `${baseName}.pdf`;

  const downloadUrl = URL.createObjectURL(pdfBlob);
  const anchor = document.createElement('a');
  anchor.href = downloadUrl;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoca differita: il download deve essere già stato avviato dal browser.
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
};
