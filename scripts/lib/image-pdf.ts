/**
 * scripts/lib/image-pdf.ts (#8055)
 *
 * Encadernador PURO de JPEGs numa página-por-imagem em PDF — o "documento"
 * que o LinkedIn renderiza como visualizador paginado no feed (Documents
 * API). Nenhuma arte nova é gerada aqui: as páginas são exatamente os
 * slides do carrossel semanal que `publish-weekly-social.ts` já monta e
 * publica no Instagram/Threads (capa → notícias → CTA, todos 1080×1350).
 *
 * ## Por que escrito à mão em vez de `pdf-lib`/`pdfkit`
 *
 * O PDF que precisamos é o subconjunto mais simples do formato: N páginas,
 * cada uma com UMA imagem ocupando a página inteira, sem texto, fonte,
 * transparência, anotação ou metadado. JPEG entra no PDF **sem
 * recompressão** — o filtro `DCTDecode` é literalmente "os bytes do JPEG,
 * como estão" —, então o encadernamento é concatenar objetos e montar a
 * xref. São ~80 linhas contra uma dependência nova numa árvore que hoje
 * não tem NENHUMA lib de PDF, e cujo `node_modules` é compartilhado por
 * junction entre os worktrees das sessões concorrentes.
 *
 * O preço dessa escolha é que este arquivo precisa estar certo sozinho:
 * não há uma lib testada por terceiros amortecendo erro de offset. Por
 * isso `test/image-pdf.test.ts` valida a ESTRUTURA do arquivo gerado
 * (cabeçalho, contagem de objetos, offsets da xref apontando de fato pro
 * início de cada objeto, `startxref`), não só que "não lançou".
 *
 * ## O que NÃO é suportado, e falha alto
 *
 * - **JPEG progressivo** (`SOF2`): `DCTDecode` é especificado sobre JPEG
 *   baseline, e leitor que não suporta progressivo renderiza página em
 *   branco — falha silenciosa, o pior desfecho pra um documento que vai
 *   ser publicado. `sharp` emite baseline por padrão, então na prática
 *   isto nunca dispara pelos nossos cards; dispara se alguém trocar o
 *   encoder ou passar um JPEG de fora.
 * - **Qualquer coisa que não seja JPEG.** PNG precisaria de `FlateDecode`
 *   + desentrelaçamento; não temos caso de uso (todos os slides são
 *   `.jpeg({quality:88})`).
 */

/** Uma página do PDF — 1 JPEG e suas dimensões em PIXELS. */
export interface ImagePdfPage {
  jpeg: Uint8Array;
  widthPx: number;
  heightPx: number;
  /** `3` = YCbCr/RGB (`DeviceRGB`), `1` = tons de cinza (`DeviceGray`).
   *  Default `3` — todos os cards do projeto são coloridos. */
  components?: number;
}

export interface ImagePdfOptions {
  /** Largura da página em PONTOS (1/72"). A altura sai da proporção de
   *  cada imagem, então página e imagem nunca divergem de aspecto — nada
   *  de barra branca ou corte. Default 540pt: os slides 1080×1350 viram
   *  540×675pt, ou seja 7,5"×9,375" — perto de uma página de leitura, em
   *  vez dos 15"×18,75" que sairiam se pixel virasse ponto direto. */
  pageWidthPt?: number;
}

const DEFAULT_PAGE_WIDTH_PT = 540;

/** Marcadores SOF (Start Of Frame) do JPEG. `SOF0`/`SOF1` são baseline;
 *  `SOF2` é progressivo (recusado, ver docstring do módulo). Os demais
 *  (`SOF3`, `SOF5`+) são modos raros (lossless, aritmético) que `DCTDecode`
 *  também não cobre. */
const SOF_BASELINE = new Set([0xc0, 0xc1]);
const SOF_PROGRESSIVE = 0xc2;

/**
 * Lê largura/altura/nº de componentes direto dos bytes do JPEG, varrendo
 * os segmentos até o SOF. Evita depender de `sharp` (I/O, async) no miolo
 * puro — e, de quebra, é onde o JPEG progressivo é detectado e recusado.
 *
 * @pure
 */
export function readJpegHeader(jpeg: Uint8Array): { widthPx: number; heightPx: number; components: number } {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error("image-pdf: não é um JPEG (falta o SOI 0xFFD8).");
  }
  let i = 2;
  while (i < jpeg.length - 1) {
    if (jpeg[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = jpeg[i + 1];
    // Preenchimento (0xFF repetido) e marcadores sem payload.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const segLen = (jpeg[i + 2] << 8) | jpeg[i + 3];
    if (marker === SOF_PROGRESSIVE) {
      throw new Error(
        "image-pdf: JPEG progressivo (SOF2) não é suportado pelo filtro DCTDecode — " +
          "reencode como baseline (sharp: `.jpeg({ progressive: false })`, que já é o default).",
      );
    }
    if (SOF_BASELINE.has(marker)) {
      const heightPx = (jpeg[i + 5] << 8) | jpeg[i + 6];
      const widthPx = (jpeg[i + 7] << 8) | jpeg[i + 8];
      const components = jpeg[i + 9];
      if (!widthPx || !heightPx) throw new Error("image-pdf: SOF com dimensão zero.");
      return { widthPx, heightPx, components };
    }
    i += 2 + segLen;
  }
  throw new Error("image-pdf: nenhum marcador SOF encontrado — arquivo truncado ou não-JPEG.");
}

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Monta o PDF: 1 página por imagem, cada imagem preenchendo a página
 * inteira. Os bytes do JPEG entram sem recompressão (`DCTDecode`), então o
 * PDF tem praticamente o tamanho da soma dos JPEGs — o que importa pro
 * teto de 100MB da Documents API do LinkedIn.
 *
 * Numeração dos objetos: `1` catálogo, `2` árvore de páginas, e depois 3
 * objetos por página (Page, XObject da imagem, stream de conteúdo).
 *
 * @pure
 */
export function buildImagePdf(pages: readonly ImagePdfPage[], opts: ImagePdfOptions = {}): Uint8Array {
  if (pages.length === 0) throw new Error("image-pdf: nenhuma página — um PDF sem página não é publicável.");
  const pageWidthPt = opts.pageWidthPt ?? DEFAULT_PAGE_WIDTH_PT;
  if (!(pageWidthPt > 0)) throw new Error(`image-pdf: pageWidthPt precisa ser > 0 (recebido ${pageWidthPt}).`);

  const chunks: Uint8Array[] = [];
  // Offset de cada objeto a partir do início do arquivo — é isto que a
  // tabela xref publica, e errar aqui produz um PDF que abre em alguns
  // leitores e falha em outros (por isso o teste confere byte a byte).
  const offsets: number[] = [];
  let cursor = 0;

  const push = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    cursor += bytes.length;
  };
  const pushText = (s: string): void => push(latin1(s));
  const beginObject = (num: number): void => {
    offsets[num] = cursor;
    pushText(`${num} 0 obj\n`);
  };

  pushText("%PDF-1.4\n");
  // Comentário binário: sinaliza a ferramentas (git, servidores, editores)
  // que o arquivo NÃO é texto — convenção da própria spec do PDF.
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const pageObjNum = (i: number): number => 3 + i * 3;

  beginObject(1);
  pushText("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  beginObject(2);
  const kids = pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(" ");
  pushText(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((page, i) => {
    const objPage = pageObjNum(i);
    const objImage = objPage + 1;
    const objContents = objPage + 2;

    if (!(page.widthPx > 0) || !(page.heightPx > 0)) {
      throw new Error(`image-pdf: página ${i + 1} com dimensão inválida (${page.widthPx}×${page.heightPx}).`);
    }
    const pageHeightPt = (pageWidthPt * page.heightPx) / page.widthPx;
    const colorSpace = (page.components ?? 3) === 1 ? "/DeviceGray" : "/DeviceRGB";

    beginObject(objPage);
    pushText(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidthPt.toFixed(2)} ${pageHeightPt.toFixed(2)}] ` +
        `/Resources << /XObject << /Im0 ${objImage} 0 R >> >> /Contents ${objContents} 0 R >>\nendobj\n`,
    );

    beginObject(objImage);
    pushText(
      `<< /Type /XObject /Subtype /Image /Width ${page.widthPx} /Height ${page.heightPx} ` +
        `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
    );
    push(page.jpeg);
    pushText("\nendstream\nendobj\n");

    // `cm` escala o espaço unitário da imagem pra página inteira; sem o
    // `q`/`Q` a matriz vazaria pra página seguinte.
    const content = `q ${pageWidthPt.toFixed(2)} 0 0 ${pageHeightPt.toFixed(2)} 0 0 cm /Im0 Do Q\n`;
    beginObject(objContents);
    pushText(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
  });

  const objectCount = 2 + pages.length * 3;
  const xrefOffset = cursor;
  pushText(`xref\n0 ${objectCount + 1}\n`);
  // Objeto 0 é sempre a cabeça da lista de livres, com geração 65535.
  pushText("0000000000 65535 f \n");
  for (let num = 1; num <= objectCount; num++) {
    const off = offsets[num];
    if (off === undefined) throw new Error(`image-pdf: objeto ${num} sem offset — bug de montagem.`);
    pushText(`${String(off).padStart(10, "0")} 00000 n \n`);
  }
  pushText(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
