/**
 * scripts/lib/site-sitemap-orphans.ts (#7578)
 *
 * Miolo puro da reconciliação `workers/site/public/p/` ⊆ `sitemap.xml`.
 *
 * Vive em `lib/` porque tem DOIS consumidores em camadas diferentes: a CLI
 * `scripts/reconcile-site-sitemap.ts` (corrige) e o invariante de Stage 6
 * `scripts/lib/invariant-checks/stage-6.ts` (acusa antes do gate). O
 * invariante não pode importar da CLI — inverteria a direção da dependência
 * e arrastaria o `process.exit` do entrypoint para dentro de uma checagem.
 *
 * ## O invariante, e por que ele importa
 *
 * Uma página em `public/p/{slug}/index.html` sem `<loc>` correspondente no
 * `sitemap.xml` responde 200 em produção e mesmo assim é invisível em DUAS
 * superfícies:
 *
 *   - no buscador, que descobre o acervo pelo sitemap;
 *   - em `arquivo.diar.ia.br`, cujo acervo é DERIVADO do sitemap do apex em
 *     request-time (`fetchSitemapXml`/`parseSitemap` em
 *     `workers/arquivo/src/index.ts`) — não tem fonte de dados própria.
 *
 * Corolário que vale ter em mente ao mexer aqui: **consertar o sitemap
 * conserta o arquivo junto**, sem deploy do Worker `arquivo`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { publishDateToIso, type ArchivePost } from "./site-archive-pages.ts";

export const DEFAULT_PAGES_DIR = "workers/site/public/p";
export const DEFAULT_SITEMAP = "workers/site/public/sitemap.xml";
/** A home é derivada do sitemap + das páginas — regenerada junto (#7578). */
export const DEFAULT_HOME = "workers/site/public/index.html";
const BEEHIIV_POSTS_DIR = "data/beehiiv-cache/posts";
const EDITIONS_ROOT = "data/editions";

/**
 * Slugs presentes como diretório COM `index.html` — a definição operacional
 * de "página existe". Diretório vazio (resto de execução interrompida) não
 * conta: não serve nada, então não faz sentido declará-lo no sitemap.
 */
export function listPageSlugs(pagesDir: string): string[] {
  if (!existsSync(pagesDir)) return [];
  return readdirSync(pagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(pagesDir, d.name, "index.html")))
    .map((d) => d.name)
    .sort();
}

/**
 * Slugs já declarados no sitemap.
 *
 * Casa a tag `<loc>` INTEIRA sob `/p/`, nunca substring — é a mesma armadilha
 * que o #7280 corrigiu em `addSitemapEntry`: um slug que é PREFIXO de outro
 * (`.../p/90-das-pessoas-nao-reconhecem-videos-de-ia` vs
 * `...-ec15971b8c4f589e`) daria falso positivo, a órfã nunca seria detectada,
 * e o silêncio seria idêntico ao bug que este módulo existe para pegar.
 */
export function slugsInSitemap(xml: string): Set<string> {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<loc>\s*[^<]*?\/p\/([^<\/\s]+?)\/?\s*<\/loc>/g)) out.add(m[1]);
  return out;
}

/** Órfãs: página no disco sem `<loc>` correspondente. Ordem estável (a de `listPageSlugs`). */
export function findOrphanSlugs(pageSlugs: string[], sitemapXml: string): string[] {
  const declared = slugsInSitemap(sitemapXml);
  return pageSlugs.filter((s) => !declared.has(s));
}

/** Resultado de `buildSlugDateMap` — o mapa e os arquivos de cache ilegíveis. */
export interface SlugDateMapResult {
  /** slug → `YYYY-MM-DD`. Vazio quando `data/` não existe (CI, clone fresco). */
  map: Map<string, string>;
  /**
   * Arquivos do cache Beehiiv que não puderam ser lidos ou parseados.
   *
   * Existe porque "mapa vazio" tem DUAS causas de significado oposto: `data/`
   * ausente (esperado em CI) e `data/` presente com todo arquivo ilegível
   * (corrupção sistêmica, ou mudança de schema upstream). Sem esta lista as
   * duas colapsam na mesma saída silenciosa — a classe de falha que este
   * módulo inteiro existe para acabar. Quem chama reporta a diferença.
   */
  corrupt: string[];
}

/**
 * slug → `YYYY-MM-DD` para o `<lastmod>`, unindo as duas fontes disponíveis.
 *
 * Precisa das duas porque as edições vêm de backends diferentes conforme a
 * data: até 03/09/2026 pela Beehiiv (cache local), de 04/09 em diante pelo
 * Kit (`backend = "kit"`, #7388), que não alimenta aquele cache. Um mapa só
 * cobriria metade do acervo.
 *
 * A data do lado Beehiiv sai de `publishDateToIso` (`site-archive-pages.ts`),
 * a MESMA função que o sitemap normal usa — e não de `displayed_date ??
 * publish_date` cru. A diferença importa nas 6 edições mais antigas, cujo
 * `publish_date` aponta para o dia do import em lote e não para o envio real
 * (`beehiiv-publish-date-overrides.json`, #4796): resolver isso à mão aqui
 * escreveria uma data errada justamente nas que já têm correção conhecida.
 *
 * As duas fontes vivem em `data/`, que é gitignored (junction do OneDrive) —
 * em CI e em clone fresco o mapa vem VAZIO, e quem chama precisa tratar
 * `undefined` como "entra sem lastmod", nunca como erro. `lastmod` é opcional
 * no protocolo de sitemap; URL indexável sem data é melhor que URL invisível.
 */
export function buildSlugDateMap(
  postsDir = BEEHIIV_POSTS_DIR,
  editionsRoot = EDITIONS_ROOT,
): SlugDateMapResult {
  const map = new Map<string, string>();
  const corrupt: string[] = [];

  if (existsSync(postsDir)) {
    for (const file of readdirSync(postsDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const post = JSON.parse(readFileSync(join(postsDir, file), "utf8")) as ArchivePost & {
          web_settings?: { slug?: string };
        };
        const slug = post.slug ?? post.web_settings?.slug;
        if (!slug) continue;
        const iso = publishDateToIso(post);
        if (iso) map.set(slug, iso);
      } catch (e) {
        // Um arquivo de cache corrompido não pode derrubar a reconciliação
        // inteira — a página segue entrando no sitemap, só que sem data. Mas
        // engolir sem deixar rastro esconderia corrupção SISTÊMICA (schema
        // mudou, diretório ilegível) atrás do mesmo silêncio de "sem cache":
        // por isso nomeia o arquivo e devolve a lista em `corrupt`.
        corrupt.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (existsSync(editionsRoot)) {
    for (const ym of readdirSync(editionsRoot)) {
      const ymDir = join(editionsRoot, ym);
      if (!existsSync(ymDir) || !statSync(ymDir).isDirectory()) continue;
      for (const ed of readdirSync(ymDir)) {
        if (!/^\d{6}$/.test(ed)) continue;
        const urlFile = join(ymDir, ed, "_internal", "05-edition-url.txt");
        if (!existsSync(urlFile)) continue;
        const slug = readFileSync(urlFile, "utf8").trim().match(/\/p\/([^\/\s?]+)/)?.[1];
        // Cache Beehiiv tem precedência: a data dele é a de publicação real,
        // enquanto AAMMDD é a data EDITORIAL da edição. Coincidem no caso
        // normal e divergem nas importadas (#4796) — ali o cache é a verdade.
        if (!slug || map.has(slug)) continue;
        // Valida MÊS e DIA, não só "são 6 dígitos": `/^\d{6}$/` aceita
        // "999999" e produziria `<lastmod>2099-99-99`, um valor inválido que
        // o crawler descarta em silêncio. Fora de faixa entra sem data.
        const iso = `20${ed.slice(0, 2)}-${ed.slice(2, 4)}-${ed.slice(4, 6)}`;
        if (!Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) map.set(slug, iso);
      }
    }
  }

  return { map, corrupt };
}
