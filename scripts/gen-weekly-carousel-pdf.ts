/**
 * scripts/gen-weekly-carousel-pdf.ts (#8055)
 *
 * Encaderna os slides JÁ PUBLICADOS do carrossel semanal num PDF de uma
 * página por slide — o formato "documento" que o LinkedIn renderiza como
 * visualizador paginado no feed (Documents API). Não gera arte nova: baixa
 * exatamente as URLs que `publish-weekly-social.ts` monta e manda pro
 * Instagram/Threads (capa → notícias → CTA), na mesma ordem.
 *
 * ## Por que ler dos CACHES em vez de re-renderizar
 *
 * Os cards são gerados, subidos pro KV e só a URL fica registrada
 * (`_internal/06-flat-cards.json`, `_internal/06-news-cards.json`) — o JPEG
 * local é descartado depois do upload. Re-renderizar aqui daria um PDF com
 * arte que ninguém viu: bastaria alguém mexer no layout entre a publicação
 * e a geração do PDF pra o documento divergir do carrossel que foi ao ar.
 * Baixar as URLs publicadas garante que o PDF é o MESMO material.
 *
 * Corolário: este script só funciona DEPOIS que a semana foi publicada.
 * Sem cache, falha alto dizendo qual arquivo falta — nunca inventa slide.
 *
 * ## Estado (#8055)
 *
 * A PUBLICAÇÃO do PDF no LinkedIn segue bloqueada: exige a Documents API,
 * sob o produto Community Management API, que em 17/09/2026 continua
 * "Review in progress" no app `264772062`, e o Worker nem tem
 * `LINKEDIN_ACCESS_TOKEN` provisionado. Este script é a metade que NÃO
 * depende disso — gera e valida o artefato, pra que, quando a aprovação
 * sair, reste só a chamada de upload.
 *
 * ## Uso
 *
 *   npx tsx scripts/gen-weekly-carousel-pdf.ts --key 260912-highlights
 *   npx tsx scripts/gen-weekly-carousel-pdf.ts --key 260912-highlights --out /tmp/x.pdf
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { buildImagePdf, readJpegHeader, type ImagePdfPage } from "./lib/image-pdf.ts";

/** Teto da Documents API do LinkedIn — 100MB por documento. Conferido
 *  aqui pra a falha aparecer na geração, não no upload. */
const LINKEDIN_DOC_MAX_BYTES = 100 * 1024 * 1024;
/** Idem, 300 páginas. Um carrossel semanal tem 6-7, então isto é só uma
 *  rede de segurança contra chamada com a chave errada. */
const LINKEDIN_DOC_MAX_PAGES = 300;

export interface WeeklyCarouselSlides {
  /** URLs na ordem final do carrossel: capa, notícias, CTA. */
  urls: string[];
}

/**
 * Lê os caches da semana e devolve as URLs dos slides NA ORDEM do
 * carrossel. `newsOrder` (as chaves de `06-news-cards.json`, na ordem em
 * que o carrossel as usou) é opcional: sem ela, as chaves do cache são
 * ordenadas alfabeticamente, o que coincide com a ordem cronológica
 * porque a chave começa com a data da edição (`260908-d1-52`).
 *
 * @pure exceto pela leitura dos 2 JSONs.
 */
export function resolveSlideUrlsFromCache(dataRoot: string, carouselKey: string): WeeklyCarouselSlides {
  const dir = resolve(dataRoot, "weekly", carouselKey, "_internal");
  const flatPath = resolve(dir, "06-flat-cards.json");
  const newsPath = resolve(dir, "06-news-cards.json");

  if (!existsSync(flatPath)) {
    throw new Error(
      `gen-weekly-carousel-pdf: ${flatPath} não existe — a semana "${carouselKey}" ainda não foi publicada. ` +
        `Rode publish-weekly-social.ts primeiro; este script encaderna o que já foi ao ar, nunca gera arte nova.`,
    );
  }
  const flat = JSON.parse(readFileSync(flatPath, "utf8")) as Record<string, { url?: string }>;
  const coverUrl = flat.cover?.url;
  const ctaUrl = flat.cta?.url;
  if (!coverUrl || !ctaUrl) {
    throw new Error(`gen-weekly-carousel-pdf: ${flatPath} sem cover/cta — cache incompleto, não dá pra montar o documento.`);
  }

  const news: Record<string, { url?: string }> = existsSync(newsPath)
    ? (JSON.parse(readFileSync(newsPath, "utf8")) as Record<string, { url?: string }>)
    : {};
  const newsUrls = Object.keys(news)
    .sort()
    .map((k) => {
      const url = news[k]?.url;
      if (!url) throw new Error(`gen-weekly-carousel-pdf: entrada "${k}" de ${newsPath} sem url.`);
      return url;
    });

  if (newsUrls.length === 0) {
    throw new Error(
      `gen-weekly-carousel-pdf: nenhum card de notícia em ${newsPath} — um documento só com capa e CTA não tem conteúdo.`,
    );
  }
  return { urls: [coverUrl, ...newsUrls, ctaUrl] };
}

async function downloadJpeg(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gen-weekly-carousel-pdf: GET ${url} -> ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Baixa os slides e monta o PDF. Separado do `main` pra ser testável com
 *  um `fetchImpl` de mentira. */
export async function buildWeeklyCarouselPdf(
  urls: readonly string[],
  fetchJpeg: (url: string) => Promise<Uint8Array> = downloadJpeg,
): Promise<Uint8Array> {
  if (urls.length > LINKEDIN_DOC_MAX_PAGES) {
    throw new Error(`gen-weekly-carousel-pdf: ${urls.length} páginas excede o teto de ${LINKEDIN_DOC_MAX_PAGES} da Documents API.`);
  }
  const pages: ImagePdfPage[] = [];
  for (const url of urls) {
    const jpeg = await fetchJpeg(url);
    const { widthPx, heightPx, components } = readJpegHeader(jpeg);
    pages.push({ jpeg, widthPx, heightPx, components });
  }
  const pdf = buildImagePdf(pages);
  if (pdf.length > LINKEDIN_DOC_MAX_BYTES) {
    throw new Error(
      `gen-weekly-carousel-pdf: PDF com ${(pdf.length / 1024 / 1024).toFixed(1)}MB excede o teto de 100MB da Documents API.`,
    );
  }
  return pdf;
}

function parseArgs(argv: readonly string[]): { key: string; out?: string; dataRoot?: string } {
  let key = "";
  let out: string | undefined;
  let dataRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--key") key = argv[++i] ?? "";
    else if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--data-root") dataRoot = argv[++i];
  }
  if (!key) {
    throw new Error(
      'gen-weekly-carousel-pdf: --key é obrigatório (ex: --key 260912-highlights). É o "{sábado}-{modo}" que nomeia a pasta em data/weekly/.',
    );
  }
  return { key, out, dataRoot };
}

async function main(): Promise<void> {
  const { key, out, dataRoot } = parseArgs(process.argv.slice(2));
  const root = dataRoot ?? resolve(process.cwd(), "data");
  const { urls } = resolveSlideUrlsFromCache(root, key);
  console.log(`gen-weekly-carousel-pdf: ${urls.length} slides em "${key}"`);
  for (const [i, u] of urls.entries()) console.log(`  ${String(i + 1).padStart(2)}. ${u}`);

  const pdf = await buildWeeklyCarouselPdf(urls);
  const outPath = out ?? resolve(root, "weekly", key, "_internal", "06-carousel.pdf");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, pdf);
  console.log(`gen-weekly-carousel-pdf: ${outPath} (${(pdf.length / 1024).toFixed(0)} KB, ${urls.length} páginas)`);
}

// CLI guard — importar este módulo (teste) nunca dispara download.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("gen-weekly-carousel-pdf.ts")) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
