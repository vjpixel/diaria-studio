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
 * ## Estado (#8055) — RE-DERIVAR, nunca confiar neste parágrafo
 *
 * A PUBLICAÇÃO do PDF no LinkedIn depende da Documents API, sob o produto
 * Community Management API. Na última medição (18/09/2026) o produto estava
 * "Review in progress" no app `264772062` e o Worker não tinha
 * `LINKEDIN_ACCESS_TOKEN` provisionado — então este script é a metade que
 * NÃO depende disso: gera e valida o artefato, e quando a aprovação sair
 * resta só a chamada de upload.
 *
 * Essas DUAS condições vivem fora do repositório (fila de review da
 * LinkedIn; segredos do Worker no Cloudflare), e nenhum teste aqui as
 * verifica — pela disciplina do #1172, quem for retomar isto re-deriva ao
 * vivo (`wrangler secret list` no `diaria-linkedin-cron`; aba Products do
 * app no Developer Portal) em vez de tomar esta data como estado atual.
 *
 * ## Uso
 *
 *   npx tsx scripts/gen-weekly-carousel-pdf.ts --key 260912-highlights
 *   npx tsx scripts/gen-weekly-carousel-pdf.ts --key 260912-highlights --out /tmp/x.pdf
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { isMainModule } from "./lib/cli-args.ts";
import { buildImagePdf, type ImagePdfPage } from "./lib/image-pdf.ts";

/** Teto da Documents API do LinkedIn — 100MB por documento. Conferido
 *  aqui pra a falha aparecer na geração, não no upload. */
const LINKEDIN_DOC_MAX_BYTES = 100 * 1024 * 1024;
/** Idem, 300 páginas. Um carrossel semanal tem 6-7, então isto é só uma
 *  rede de segurança contra chamada com a chave errada. */
const LINKEDIN_DOC_MAX_PAGES = 300;

export interface WeeklyCarouselSlides {
  /** URLs na ordem final do carrossel: capa, notícias, CTA. */
  urls: string[];
  /** De onde a ordem veio — `"manifest"` é a ordem REAL registrada na
   *  publicação; `"cache-chronological"` é reconstrução, só permitida no
   *  modo `highlights` (ver {@link resolveSlideUrlsFromCache}). */
  source: "manifest" | "cache-chronological";
}

/** `JSON.parse` com o caminho do arquivo na mensagem — mesma disciplina de
 *  `readNewsCardUrl` (`lib/weekly-carousel-news-card.ts`), que já distingue
 *  "corrompido" de "ausente" pros MESMOS arquivos. Cache lido no meio de uma
 *  escrita concorrente do `publish-weekly-social.ts` é o caso real. */
function readJsonFile<T>(path: string): T {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`gen-weekly-carousel-pdf: ${path} corrompido (${(e as Error).message}) — pode ser leitura no meio de uma escrita concorrente; re-tente.`);
  }
}

/**
 * Devolve as URLs dos slides NA ORDEM do carrossel.
 *
 * ## Por que a ordem não se reconstrói dos caches (achado do review, #8305)
 *
 * A chave do cache de notícia é `{data}-{destaque}-{fontSize}`, então
 * ordenar as chaves dá ordem CRONOLÓGICA. Isso é a ordem real **só** no
 * modo `highlights` (os 5 D1 da semana, em ordem de data). NÃO é no modo
 * `clicked`, que ranqueia por clique, nem com `--force-urls`, onde o editor
 * dá uma ordem explícita. Nesses dois casos a reconstrução produziria um
 * documento com a sequência trocada — estruturalmente perfeito, narrativa
 * errada, e ninguém pega isso revisando o PDF.
 *
 * Por isso a fonte preferida é `06-carousel-urls.json`, o manifesto que
 * `publish-weekly-social.ts` grava com a ordem exata que foi publicada. A
 * reconstrução cronológica fica como fallback e **só** para `-highlights`;
 * qualquer outro modo sem manifesto falha alto, em vez de adivinhar.
 */
export function resolveSlideUrlsFromCache(dataRoot: string, carouselKey: string): WeeklyCarouselSlides {
  const dir = resolve(dataRoot, "weekly", carouselKey, "_internal");
  const manifestPath = resolve(dir, "06-carousel-urls.json");
  const flatPath = resolve(dir, "06-flat-cards.json");
  const newsPath = resolve(dir, "06-news-cards.json");

  if (existsSync(manifestPath)) {
    const manifest = readJsonFile<{ urls?: unknown }>(manifestPath);
    const urls = manifest.urls;
    if (!Array.isArray(urls) || urls.length === 0 || !urls.every((u) => typeof u === "string" && u)) {
      throw new Error(`gen-weekly-carousel-pdf: ${manifestPath} sem uma lista de urls utilizável.`);
    }
    return { urls: urls as string[], source: "manifest" };
  }

  if (!existsSync(flatPath)) {
    throw new Error(
      `gen-weekly-carousel-pdf: ${flatPath} não existe — a semana "${carouselKey}" ainda não foi publicada. ` +
        `Rode publish-weekly-social.ts primeiro; este script encaderna o que já foi ao ar, nunca gera arte nova.`,
    );
  }

  // Sem manifesto (semana publicada antes do #8055), só `-highlights` pode
  // ser reconstruída com segurança — ver docstring acima.
  if (!carouselKey.endsWith("-highlights")) {
    throw new Error(
      `gen-weekly-carousel-pdf: "${carouselKey}" não tem ${manifestPath} e não é modo "highlights" — a ordem real do ` +
        `carrossel não é recuperável dos caches (o modo "clicked" ranqueia por clique, "--force-urls" usa ordem do ` +
        `editor; a chave do cache só guarda a data). Re-publique a semana pra gerar o manifesto, ou passe as URLs à mão.`,
    );
  }

  const flat = readJsonFile<Record<string, { url?: string }>>(flatPath);
  const coverUrl = flat.cover?.url;
  const ctaUrl = flat.cta?.url;
  if (!coverUrl || !ctaUrl) {
    throw new Error(`gen-weekly-carousel-pdf: ${flatPath} sem cover/cta — cache incompleto, não dá pra montar o documento.`);
  }

  const news: Record<string, { url?: string }> = existsSync(newsPath) ? readJsonFile(newsPath) : {};
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
  return { urls: [coverUrl, ...newsUrls, ctaUrl], source: "cache-chronological" };
}

export async function downloadJpeg(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`gen-weekly-carousel-pdf: GET ${url} -> ${res.status} ${res.statusText}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Corpo cortado no meio da transferência chega com 200 e sem erro
  // nenhum (#8305 review). `readJpegHeader` pega o caso pelo EOI ausente,
  // mas conferir aqui nomeia a causa REAL — "veio menos byte do que o
  // servidor prometeu" — em vez de mandar quem depura investigar um JPEG
  // supostamente malformado na origem.
  const declared = res.headers.get("content-length");
  if (declared != null && Number(declared) !== bytes.length) {
    throw new Error(
      `gen-weekly-carousel-pdf: GET ${url} veio truncado — content-length dizia ${declared} bytes, chegaram ${bytes.length}.`,
    );
  }
  if (bytes.length === 0) throw new Error(`gen-weekly-carousel-pdf: GET ${url} devolveu corpo vazio.`);
  return bytes;
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
  let bytesSoFar = 0;
  for (const url of urls) {
    const jpeg = await fetchJpeg(url);
    bytesSoFar += jpeg.length;
    // Aborta assim que os JPEGs já somam mais que o teto, em vez de baixar o
    // resto e montar um PDF que não tem como ser aceito. O PDF é ~a soma dos
    // JPEGs (DCTDecode não recomprime), então esta soma é um piso honesto do
    // tamanho final — a checagem final continua depois, sobre o valor real.
    if (bytesSoFar > LINKEDIN_DOC_MAX_BYTES) {
      throw new Error(
        `gen-weekly-carousel-pdf: os slides já somam ${(bytesSoFar / 1024 / 1024).toFixed(1)}MB, acima do teto de ` +
          `${LINKEDIN_DOC_MAX_BYTES / 1024 / 1024}MB da Documents API — abortado sem baixar o resto.`,
      );
    }
    pages.push({ jpeg });
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
if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  });
}
