/**
 * scripts/lib/shared/carousel-pdf.ts (#12584)
 *
 * Encaderna slides JÁ PUBLICADOS (URLs de JPEG) num PDF de uma página por
 * slide: o formato "documento" que o LinkedIn mostra como visualizador
 * paginado no feed (Documents API, Worker `diaria-linkedin-cron`,
 * `fireLinkedInDocument`). Não gera arte: baixa as URLs na ordem dada.
 *
 * Nasceu em `scripts/gen-weekly-carousel-pdf.ts` (#8055, retrospectiva
 * semanal); o miolo não tinha nada de semanal e foi extraído para cá quando o
 * documento virou o formato padrão do LinkedIn também na diária (#12584,
 * `scripts/lib/linkedin-daily-document.ts`). O script semanal reexporta estes
 * nomes, então os consumidores antigos seguem funcionando.
 */

import { buildImagePdf, type ImagePdfPage } from "../image-pdf.ts";

/** Teto de bytes do documento: o do Worker que baixa o PDF no disparo
 *  (`LINKEDIN_DOCUMENT_MAX_BYTES` em `workers/linkedin-cron/src/index.ts`,
 *  20MB desde o #12372), não os 100MB da Documents API do LinkedIn (#12394).
 *  Conferido aqui pra a falha aparecer na geração, no enqueue (o publicador
 *  cai no carrossel com `pdf_failed:*`), e não no disparo. Paridade com o
 *  Worker travada em `test/gen-weekly-carousel-pdf.test.ts`. */
export const LINKEDIN_DOC_MAX_BYTES = 20 * 1024 * 1024;
/** Teto de páginas da Documents API. Um carrossel tem 5-7 slides, então isto
 *  é só rede de segurança contra uma chamada com a lista errada. */
export const LINKEDIN_DOC_MAX_PAGES = 300;

export async function downloadJpeg(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    // #9991: corpo não lido segura o socket e a saída via exitCode.
    await res.body?.cancel().catch(() => {});
    throw new Error(`carousel-pdf: GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Corpo cortado no meio da transferência chega com 200 e sem erro nenhum
  // (#8305 review). Conferir aqui nomeia a causa real ("veio menos byte do
  // que o servidor prometeu") em vez de um JPEG supostamente malformado.
  const declared = res.headers.get("content-length");
  if (declared != null && Number(declared) !== bytes.length) {
    throw new Error(
      `carousel-pdf: GET ${url} veio truncado — content-length dizia ${declared} bytes, chegaram ${bytes.length}.`,
    );
  }
  if (bytes.length === 0) throw new Error(`carousel-pdf: GET ${url} devolveu corpo vazio.`);
  return bytes;
}

/** Baixa os slides e monta o PDF, na ordem de `urls`. `fetchJpeg` é seam de
 *  teste (default: download real). */
export async function buildCarouselPdf(
  urls: readonly string[],
  fetchJpeg: (url: string) => Promise<Uint8Array> = downloadJpeg,
): Promise<Uint8Array> {
  if (urls.length === 0) throw new Error("carousel-pdf: nenhuma URL de slide — não há documento a montar.");
  if (urls.length > LINKEDIN_DOC_MAX_PAGES) {
    throw new Error(`carousel-pdf: ${urls.length} páginas excede o teto de ${LINKEDIN_DOC_MAX_PAGES} da Documents API.`);
  }
  const pages: ImagePdfPage[] = [];
  let bytesSoFar = 0;
  for (const url of urls) {
    const jpeg = await fetchJpeg(url);
    bytesSoFar += jpeg.length;
    // Aborta assim que os JPEGs já somam mais que o teto. O PDF é ~a soma dos
    // JPEGs (DCTDecode não recomprime), então esta soma é um piso honesto do
    // tamanho final; a checagem final continua depois, sobre o valor real.
    if (bytesSoFar > LINKEDIN_DOC_MAX_BYTES) {
      throw new Error(
        `carousel-pdf: os slides já somam ${(bytesSoFar / 1024 / 1024).toFixed(1)}MB, acima do teto de ` +
          `${LINKEDIN_DOC_MAX_BYTES / 1024 / 1024}MB do Worker do LinkedIn — abortado sem baixar o resto.`,
      );
    }
    pages.push({ jpeg });
  }
  const pdf = buildImagePdf(pages);
  if (pdf.length > LINKEDIN_DOC_MAX_BYTES) {
    throw new Error(
      `carousel-pdf: PDF com ${(pdf.length / 1024 / 1024).toFixed(1)}MB excede o teto de ` +
        `${LINKEDIN_DOC_MAX_BYTES / 1024 / 1024}MB do Worker do LinkedIn.`,
    );
  }
  return pdf;
}
