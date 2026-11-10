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
 * ## Consumidor (#8055)
 *
 * `publish-weekly-social.ts` usa `buildWeeklyCarouselPdf` na hora de
 * publicar (`prepareWeeklyLinkedInDocument`): o LinkedIn semanal sai como
 * documento PDF pelo Worker `diaria-linkedin-cron` (`fireLinkedInDocument`,
 * Documents API). Este CLI segue útil pra regenerar/inspecionar o PDF de uma
 * semana já publicada.
 *
 * ## Uso
 *
 *   npx tsx scripts/gen-weekly-carousel-pdf.ts --key 260912-highlights
 *   npx tsx scripts/gen-weekly-carousel-pdf.ts --key 260912-highlights --out /tmp/x.pdf
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { buildCarouselPdf, downloadJpeg, LINKEDIN_DOC_MAX_BYTES } from "./lib/shared/carousel-pdf.ts";

// #12584 — o miolo (download + tetos + montagem) foi extraído para
// `lib/shared/carousel-pdf.ts`, onde a diária também o usa. Reexportado aqui
// pra os consumidores do semanal (`publish-weekly-social.ts`, testes) não
// mudarem de import.
export { downloadJpeg, LINKEDIN_DOC_MAX_BYTES };

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

/** Baixa os slides e monta o PDF (alias semanal de {@link buildCarouselPdf},
 *  #12584). Separado do `main` pra ser testável com um `fetchJpeg` de mentira. */
export async function buildWeeklyCarouselPdf(
  urls: readonly string[],
  fetchJpeg: (url: string) => Promise<Uint8Array> = downloadJpeg,
): Promise<Uint8Array> {
  return buildCarouselPdf(urls, fetchJpeg);
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
  // #9911: grava process.exitCode em vez de process.exit — no Windows (Node 24) o exit logo após um fetch sai 127.
  runCli(main, { onError: (e) => console.error(String(e instanceof Error ? e.message : e)) });
}
