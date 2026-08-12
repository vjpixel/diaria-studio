#!/usr/bin/env tsx
/**
 * box-click-report.ts (#4354)
 *
 * Recomendação orientada por dados de qual box de divulgação
 * (`context/snippets/*.md`, atribuída aos slots 0–3 via
 * `platform.config.json` → `boxes_divulgacao`) performou melhor em cliques
 * nas últimas N edições — pra apoiar a decisão do editor no gate do Stage 4
 * (§4c, `.claude/agents/orchestrator-stage-4.md`), em vez de decidir troca de
 * slot só por memória/intuição.
 *
 * **Por que não dá pra usar `data/link-ctr-table.csv` (build-link-ctr.ts):**
 * aquele CSV filtra DELIBERADAMENTE os domínios que as boxes de divulgação
 * apontam (`clarice.ai`, `amazon.com.br/dp/`, `amzn.to` — ver `isEditorial`
 * em build-link-ctr.ts) porque é uma tabela de CTR EDITORIAL, não de
 * divulgação/afiliados. Este script lê `data/beehiiv-cache/posts/*.json`
 * DIRETO, sem esse filtro.
 *
 * **Por que não dá pra usar `platform.config.json` pra achar qual snippet
 * rodou em cada edição HISTÓRICA:** esse arquivo não é versionado por edição
 * — só reflete o estado ATUAL de `boxes_divulgacao`. Em vez disso, cada
 * edição é lida direto do seu `02-reviewed.md` já publicado — o link
 * encontrado dentro de cada box (via `extractBoxDivulgacao{0,1,2,3}`,
 * `scripts/lib/newsletter-parse.ts`) é casado contra as URLs de
 * `context/snippets/*.md` (por base-URL, ignorando query string — mesma
 * convenção de `matchClick` em `build-link-ctr.ts`) pra identificar QUAL
 * snippet foi usado naquela edição, independente do que o config diz hoje.
 *
 * **Como o post Beehiiv de cada edição é encontrado:** não há um campo
 * `post_id` gravado por edição — o join é feito por DATA: o `publish_date`
 * (unix, UTC) de cada post cacheado em `data/beehiiv-cache/posts/*.json` é
 * convertido pra AAMMDD e casado contra o AAMMDD da pasta da edição. A
 * newsletter é enviada ~06:00 BRT (~09:00 UTC), longe da virada de dia UTC —
 * a data UTC do envio coincide com o AAMMDD da edição na esmagadora maioria
 * dos casos.
 *
 * **Fora de escopo (#4354):** boxes sem link próprio (algumas boxes antigas
 * eram só texto) não têm como ser medidas — aparecem na lista de "sem dado
 * de clique", nunca no ranking. Automatizar a troca de slot está fora de
 * escopo — a saída é só uma tabela de apoio, consultada no gate do Stage 4,
 * nunca aplicada automaticamente.
 *
 * Uso:
 *   npx tsx scripts/box-click-report.ts [--last N]   (N > 0, default 20)
 *
 * Output (stdout): markdown — tabela de ranking + lista de boxes sem dado de
 * clique. Puramente informativo — nunca bloqueia o gate.
 *
 * Exit codes: 0 = sucesso (mesmo sem nenhuma edição/clique encontrado),
 * 1 = `data/editions` ausente, 2 = args inválidos.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { listEditions } from "./lib/edition-utils.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import {
  extractBoxDivulgacao0,
  extractBoxDivulgacao1,
  extractBoxDivulgacao2,
  extractBoxDivulgacao3,
} from "./lib/newsletter-parse.ts";
import { parseBoxHeaderField, stripHeaderBlock } from "./lib/shared/snippet-header.ts";
import { URL_WITH_BALANCED_PARENS_RE_PART } from "./lib/lint-checks/section-item-format.ts";
import { resolveEnrichmentState, type EnrichmentState } from "./lib/shared/enrichment-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNIPPETS_DIR = resolve(ROOT, "context/snippets");
const EDITIONS_DIR = resolve(ROOT, "data/editions");
const POSTS_DIR = resolve(ROOT, "data/beehiiv-cache/posts");

export const DEFAULT_LAST_N = 20;

// ── Pure helpers ────────────────────────────────────────────────────────

/** Extrai todas as URLs `https?://...` de um texto (balanceando parênteses,
 * mesmo padrão de `URL_WITH_BALANCED_PARENS_RE_PART` — cobre tanto URL nua
 * quanto `[texto](URL)` markdown). */
export function extractUrls(text: string): string[] {
  const re = new RegExp(URL_WITH_BALANCED_PARENS_RE_PART, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

/** Remove query string + hash + trailing slash de uma URL — mesma convenção
 * de `baseUrl()`/`matchClick()` em `build-link-ctr.ts`: um clique com
 * variante de query (subscriber id, utm, `?via=diaria`) precisa colapsar pra
 * identidade do link de destino, não pra rows distintas. Entrada inválida
 * (não parseável como URL) devolve como está — defensivo, nunca lança. */
export function toBaseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}

export interface SnippetInfo {
  /** Nome do arquivo (ex: `clarice-divulgacao.md`) — chave estável de
   * agregação (o link é mais confiável que o texto, mas o arquivo é mais
   * estável ainda — sobrevive a edição de link também, desde que o editor
   * não troque de arquivo). */
  file: string;
  /** `nome:` do header — rótulo humano pro ranking. */
  nome: string;
  /** URLs (já em base-url) encontradas no CORPO do snippet (header
   * de comentário excluído — `stripHeaderBlock`). */
  urls: string[];
}

export function parseSnippetContent(file: string, content: string): SnippetInfo {
  const nome = parseBoxHeaderField(content, "nome") ?? file.replace(/\.md$/, "");
  const body = stripHeaderBlock(content);
  const urls = [...new Set(extractUrls(body).map(toBaseUrl))];
  return { file, nome, urls };
}

/** Carrega + parseia todos os snippets de `context/snippets/*.md` (exclui
 * `README.md` e a subpasta `_arquivo/`). Nunca lança — arquivo ilegível é
 * pulado silenciosamente (não deveria ocorrer em produção). */
export function loadSnippets(snippetsDir: string = SNIPPETS_DIR): SnippetInfo[] {
  if (!existsSync(snippetsDir)) return [];
  return readdirSync(snippetsDir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => {
      try {
        return parseSnippetContent(f, readFileSync(join(snippetsDir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((s): s is SnippetInfo => s !== null);
}

export interface SnippetMatch {
  snippet: SnippetInfo;
  /** A URL (bruta, não normalizada) do BOX que efetivamente bateu com o
   * snippet — não necessariamente a 1ª URL do box (#4354 self-review finding
   * 1: um box com >1 link pode ter o link de afiliado/tracked em 2º lugar;
   * usar cegamente `urls[0]` faria o lookup de clique mirar na URL errada,
   * mesmo com o snippet corretamente identificado). Caller usa ESTA URL, não
   * `extractUrls(boxText)[0]`, pro lookup de clique. */
  url: string;
}

/** Dado o texto de um box já extraído (`extractBoxDivulgacaoN`), acha qual
 * snippet cadastrado corresponde E qual URL do box foi a que bateu — por
 * base-URL, testando cada URL do box em ordem até achar uma que exista em
 * algum snippet cadastrado. `null` quando o box não tem URL, ou nenhuma URL
 * do box corresponde a nenhum snippet (ex: box escrito manualmente, sem vir
 * de um snippet reaproveitável). */
export function matchSnippetForBox(
  boxText: string,
  snippets: SnippetInfo[],
): SnippetMatch | null {
  for (const rawUrl of extractUrls(boxText)) {
    const baseUrl = toBaseUrl(rawUrl);
    const found = snippets.find((s) => s.urls.includes(baseUrl));
    if (found) return { snippet: found, url: rawUrl };
  }
  return null;
}

export interface ClickLike {
  url?: string;
  base_url?: string;
  email?: {
    verified_clicks?: number;
    unique_verified_clicks?: number;
  };
}

export interface ClickSum {
  verified_clicks: number;
  unique_verified_clicks: number;
}

/** Soma cliques de TODAS as rows do post cujo base-URL bate com `url` — um
 * link pode ter várias rows no cache (uma por variante de query/subscriber,
 * mesma situação que `matchClick` em `build-link-ctr.ts` já trata). */
export function sumClicksForUrl(url: string, clicks: ClickLike[]): ClickSum {
  const target = toBaseUrl(url);
  let verified = 0;
  let uniqueVerified = 0;
  for (const c of clicks) {
    const candidate = c.base_url ?? c.url;
    if (!candidate) continue;
    if (toBaseUrl(candidate) !== target) continue;
    verified += c.email?.verified_clicks ?? 0;
    uniqueVerified += c.email?.unique_verified_clicks ?? 0;
  }
  return { verified_clicks: verified, unique_verified_clicks: uniqueVerified };
}

export interface PostCacheLike {
  id?: string;
  publish_date?: number | null;
  stats?: { clicks?: ClickLike[]; enrichment_state?: EnrichmentState };
}

/**
 * #5153: `true` quando o post ainda não teve NENHUMA tentativa de buscar
 * cliques por link — normalmente porque a edição está fora da janela de
 * `MIN_AGE_DAYS_FOR_CLICKS` dias (7, `scripts/lib/shared/ctr-config.ts`) e o
 * gate diário de enrichment (`scripts/beehiiv-sync.ts`) ainda não rodou pra
 * ela. `stats.clicks` vem `[]` nesse caso — mas isso é dado AUSENTE, não
 * cliques confirmados como zero (ver `enriched_zero`, o estado que SIM
 * confirma zero). Callers que agregam `stats.clicks` por link precisam
 * checar isto ANTES de somar — nunca tratar `never_enriched` como 0
 * silenciosamente (achado ao vivo #5153, 260812: uma consulta de cliques
 * misturou edições medidas e não-medidas na mesma tabela sem aviso).
 */
export function isPostNeverEnriched(post: PostCacheLike): boolean {
  const clicks = post.stats?.clicks ?? [];
  return resolveEnrichmentState(post.stats?.enrichment_state, clicks.length) === "never_enriched";
}

/** `publish_date` (unix seconds, UTC) → AAMMDD. Ver docstring do módulo pra
 * o porquê de UTC não divergir do AAMMDD da pasta na prática. */
export function editionAammddFromPublishDate(unixSeconds: number): string {
  const iso = new Date(unixSeconds * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
  const [yyyy, mm, dd] = iso.split("-");
  return `${yyyy.slice(2)}${mm}${dd}`;
}

/** Acha o post Beehiiv cujo `publish_date` cai no AAMMDD da edição. Quando
 * >1 (não deveria ocorrer — 1 edição = 1 post), prefere o `publish_date`
 * mais recente. `null` quando nenhum post cacheado bate com a data. */
export function findPostForEdition(
  aammdd: string,
  posts: PostCacheLike[],
): PostCacheLike | null {
  const matches = posts.filter(
    (p) => typeof p.publish_date === "number" && editionAammddFromPublishDate(p.publish_date) === aammdd,
  );
  if (matches.length === 0) return null;
  matches.sort((a, b) => (b.publish_date ?? 0) - (a.publish_date ?? 0));
  return matches[0];
}

export type BoxSlot = 0 | 1 | 2 | 3;

const SLOT_EXTRACTORS: Array<[BoxSlot, (text: string) => string | null]> = [
  [0, extractBoxDivulgacao0],
  [1, extractBoxDivulgacao1],
  [2, extractBoxDivulgacao2],
  [3, extractBoxDivulgacao3],
];

export interface BoxUsage {
  slot: BoxSlot;
  boxText: string;
  snippet: SnippetInfo | null;
  url: string | null;
}

/** Varre os 4 slots de um `02-reviewed.md` já publicado e devolve, por slot
 * presente, o box de texto + snippet correspondente (se achado) + a URL
 * usada pro lookup de clique.
 *
 * #4354 self-review finding 1: quando um snippet É identificado, `url` é a
 * URL que de fato bateu com o snippet (`SnippetMatch.url`), NUNCA
 * `extractUrls(boxText)[0]` cego — um box com >1 link poderia ter o link
 * rastreado/afiliado em 2º lugar, e usar a 1ª URL indiscriminadamente faria o
 * lookup de clique mirar na URL errada mesmo com o snippet certo. Quando
 * NENHUM snippet bate, cai no fallback `urls[0] ?? null` só pra fins de
 * diagnóstico (`buildBoxClickReport` já ignora clique nesse caso — snippet
 * `null` nunca soma clique). */
export function extractEditionBoxUsages(reviewedMd: string, snippets: SnippetInfo[]): BoxUsage[] {
  const out: BoxUsage[] = [];
  for (const [slot, extractor] of SLOT_EXTRACTORS) {
    const boxText = extractor(reviewedMd);
    if (!boxText) continue;
    const match = matchSnippetForBox(boxText, snippets);
    if (match) {
      out.push({ slot, boxText, snippet: match.snippet, url: match.url });
    } else {
      const urls = extractUrls(boxText);
      out.push({ slot, boxText, snippet: null, url: urls[0] ?? null });
    }
  }
  return out;
}

export interface RankingRow {
  snippet: string;
  nome: string;
  editions_appeared: number;
  editions: string[];
  total_verified_clicks: number;
  total_unique_verified_clicks: number;
  avg_unique_verified_clicks: number;
}

export interface UnmatchedBox {
  aammdd: string;
  slot: BoxSlot;
  reason: string;
  /** #5153 (achado silent-failure-hunter): arquivo do snippet, quando
   * conhecido — sem isto não dava pra cruzar uma entrada desta lista com a
   * linha do ranking que ela afeta (ex: qual box tem uma edição não-medida
   * no meio do histórico). `null` só nos 2 casos em que o snippet nunca foi
   * identificado (sem link mensurável, ou link que não bate com nenhum
   * snippet cadastrado). */
  snippet: string | null;
}

export interface BoxClickReport {
  rows: RankingRow[];
  unmatchedBoxes: UnmatchedBox[];
  /** #5153: aparições do box num post `never_enriched` (fora da janela de 7
   * dias, cliques ainda não medidos) — rastreado À PARTE de `unmatchedBoxes`
   * porque a causa é temporária (resolve sozinha em alguns dias, quando o
   * post completa 7 dias e o gate diário de `beehiiv-sync.ts` o enriquece),
   * diferente de "nunca vai ter dado" (sem post cacheado, sem link
   * mensurável). NUNCA entra em `total_verified_clicks`/
   * `total_unique_verified_clicks` — dado ausente, não zero.
   *
   * Mesmo shape de `UnmatchedBox` (achado type-design-analyzer, review desta
   * PR — considerado, mas não implementado: TypeScript é estrutural, então
   * um alias/interface nominal aqui NÃO impediria `[...unmatchedBoxes,
   * ...neverEnrichedBoxes]` de type-checkar — só uma marca discriminante de
   * verdade faria isso, custo desproporcional pro único call site real de
   * hoje). A proteção prática contra misturar as duas listas é o `reason`
   * (sempre nomeia "never_enriched"/"7 dias" explicitamente, ver
   * `renderNeverEnrichedNote`) e o fato de `main()` renderizar as duas
   * seções separadas, nunca concatenadas. */
  neverEnrichedBoxes: UnmatchedBox[];
}

export interface BuildReportOpts {
  /** Lista de AAMMDD a varrer, na ordem desejada (já limitada a N). */
  aammddList: string[];
  /** Lê o `02-reviewed.md` de uma edição — `null` se ausente/ilegível.
   * Abstraído pra permitir teste com fixtures em memória, sem tocar disco. */
  readReviewedMd: (aammdd: string) => string | null;
  snippets: SnippetInfo[];
  /** Acha o post Beehiiv cacheado correspondente a uma edição — `null` se
   * não encontrado. Abstraído pelo mesmo motivo de `readReviewedMd`. */
  findPost: (aammdd: string) => PostCacheLike | null;
}

/**
 * Constrói o ranking snippet × cliques nas últimas N edições em que apareceu.
 * Pure/testável — toda leitura de disco é injetada via `opts` (fixtures no
 * teste, disco real no CLI `main()` abaixo).
 */
export function buildBoxClickReport(opts: BuildReportOpts): BoxClickReport {
  const acc = new Map<
    string,
    { nome: string; editions: Set<string>; verified: number; uniqueVerified: number }
  >();
  const unmatchedBoxes: UnmatchedBox[] = [];
  const neverEnrichedBoxes: UnmatchedBox[] = []; // #5153

  for (const aammdd of opts.aammddList) {
    const md = opts.readReviewedMd(aammdd);
    if (!md) continue;

    const usages = extractEditionBoxUsages(md, opts.snippets);
    if (usages.length === 0) continue;
    const post = opts.findPost(aammdd);

    for (const usage of usages) {
      if (!usage.url) {
        unmatchedBoxes.push({ aammdd, slot: usage.slot, snippet: null, reason: "box sem link (texto puro, não mensurável)" });
        continue;
      }
      if (!usage.snippet) {
        unmatchedBoxes.push({
          aammdd,
          slot: usage.slot,
          snippet: null,
          reason: "sem snippet correspondente em context/snippets/ (link não bate com nenhum snippet cadastrado)",
        });
        continue;
      }

      const key = usage.snippet.file;
      const entry = acc.get(key) ?? {
        nome: usage.snippet.nome,
        editions: new Set<string>(),
        verified: 0,
        uniqueVerified: 0,
      };

      if (post) {
        // #5153: post `never_enriched` (fora da janela de 7 dias) não soma
        // como zero — o dado real é DESCONHECIDO, não confirmado-zero.
        // **Achado silent-failure-hunter (review desta mesma PR):** não
        // basta excluir do NUMERADOR (verified/uniqueVerified) — precisa
        // excluir do DENOMINADOR também (`entry.editions`, usado por
        // `avg_unique_verified_clicks` abaixo). Sem isso, uma edição
        // never_enriched ainda inflava `editions.size` sem contribuir
        // clique nenhum, diluindo a média pra baixo silenciosamente — o
        // mesmo bug de raiz, um passo adiante. Diferente do caso "sem post
        // cacheado" (branch `else` abaixo), que MANTÉM a semântica
        // pré-#5153 de contar como aparição (comportamento já coberto por
        // teste dedicado — "apareceu, mesmo sem dado de clique").
        if (isPostNeverEnriched(post)) {
          neverEnrichedBoxes.push({
            aammdd,
            slot: usage.slot,
            snippet: key,
            reason: `edição fora da janela de 7 dias (enrichment_state: never_enriched) — cliques ainda não medidos, NÃO conta como zero`,
          });
        } else {
          entry.editions.add(aammdd);
          const sum = sumClicksForUrl(usage.url, post.stats?.clicks ?? []);
          entry.verified += sum.verified_clicks;
          entry.uniqueVerified += sum.unique_verified_clicks;
        }
      } else {
        entry.editions.add(aammdd);
        unmatchedBoxes.push({
          aammdd,
          slot: usage.slot,
          snippet: key,
          reason: `snippet '${usage.snippet.file}' usado, mas nenhum post Beehiiv cacheado bate com a data ${aammdd} (cache incompleto ou edição ainda não sincronizada)`,
        });
      }

      acc.set(key, entry);
    }
  }

  const rows: RankingRow[] = [...acc.entries()].map(([file, e]) => ({
    snippet: file,
    nome: e.nome,
    editions_appeared: e.editions.size,
    editions: [...e.editions].sort(),
    total_verified_clicks: e.verified,
    total_unique_verified_clicks: e.uniqueVerified,
    avg_unique_verified_clicks: e.editions.size > 0 ? e.uniqueVerified / e.editions.size : 0,
  }));
  rows.sort((a, b) => b.total_unique_verified_clicks - a.total_unique_verified_clicks);

  return { rows, unmatchedBoxes, neverEnrichedBoxes };
}

/**
 * #5153: nomeia a janela de 7 dias explicitamente — nunca deixa a diferença
 * "não medido" vs "medido, zero" implícita num número solto. `""` quando não
 * há nenhuma edição never_enriched na varredura (nada a dizer).
 */
export function renderNeverEnrichedNote(neverEnrichedCount: number, measuredEditionsCount: number): string {
  if (neverEnrichedCount === 0) return "";
  return `_${neverEnrichedCount} edição(ões) fora da janela de 7 dias (cliques ainda não medidos — não conta como zero), ${measuredEditionsCount} edição(ões) medida(s)._`;
}

/** Renderiza o ranking como tabela markdown — usada pelo CLI e pelo gate do
 * Stage 4 (`orchestrator-stage-4.md` §4c.7). Pure — testável sem I/O. */
export function renderMarkdownTable(rows: RankingRow[]): string {
  if (rows.length === 0) {
    return "(nenhum box de divulgação com link mensurável encontrado nas edições varridas)";
  }
  const header =
    "| Box (snippet) | Edições | Cliques únicos verificados (total) | Média/edição | Cliques verificados (total) |\n" +
    "|---|---|---|---|---|";
  const body = rows
    .map(
      (r) =>
        `| ${r.nome} (\`${r.snippet}\`) | ${r.editions_appeared} | ${r.total_unique_verified_clicks} | ${r.avg_unique_verified_clicks.toFixed(1)} | ${r.total_verified_clicks} |`,
    )
    .join("\n");
  return `${header}\n${body}`;
}

// ── CLI ─────────────────────────────────────────────────────────────────

function loadPostsCache(postsDir: string = POSTS_DIR): PostCacheLike[] {
  if (!existsSync(postsDir)) return [];
  return readdirSync(postsDir)
    .filter((f) => f.endsWith(".json") && f !== "index.json")
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(postsDir, f), "utf8")) as PostCacheLike;
      } catch {
        return null;
      }
    })
    .filter((p): p is PostCacheLike => p !== null);
}

function main(): void {
  const argv = process.argv.slice(2);
  const lastIdx = argv.indexOf("--last");
  const lastN = lastIdx !== -1 && argv[lastIdx + 1] ? Number(argv[lastIdx + 1]) : DEFAULT_LAST_N;
  if (!Number.isFinite(lastN) || lastN <= 0) {
    console.error("uso: box-click-report.ts [--last N]  (N > 0, default " + DEFAULT_LAST_N + ")");
    process.exit(2);
  }

  if (!existsSync(EDITIONS_DIR)) {
    console.error(
      `[box-click-report] ${EDITIONS_DIR} não encontrado — data/ ausente (junction OneDrive não criada nesta máquina?)`,
    );
    process.exit(1);
  }

  const dirsByAammdd = enumerateEditionDirs(EDITIONS_DIR);
  const aammddList = listEditions(EDITIONS_DIR).slice(0, lastN);
  const snippets = loadSnippets();
  const posts = loadPostsCache();

  const readReviewedMd = (aammdd: string): string | null => {
    const dir = dirsByAammdd.get(aammdd);
    if (!dir) return null;
    const path = join(dir, "02-reviewed.md");
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };

  const { rows, unmatchedBoxes, neverEnrichedBoxes } = buildBoxClickReport({
    aammddList,
    readReviewedMd,
    snippets,
    findPost: (aammdd) => findPostForEdition(aammdd, posts),
  });

  console.log(`# Recomendação de boxes de divulgação — últimas ${aammddList.length} edições varridas\n`);
  console.log(renderMarkdownTable(rows));

  // #5153: nomeia a janela de 7 dias explicitamente, ANTES da lista de
  // unmatched genérica — quem lê precisa saber que parte do "sem dado" é só
  // temporário (resolve sozinho), não confundir com box que nunca vai medir.
  if (neverEnrichedBoxes.length > 0) {
    const neverEnrichedEditions = new Set(neverEnrichedBoxes.map((b) => b.aammdd));
    const measuredEditions = new Set(rows.flatMap((r) => r.editions));
    console.log(`\n${renderNeverEnrichedNote(neverEnrichedEditions.size, measuredEditions.size)}`);
    for (const u of neverEnrichedBoxes.slice(0, 20)) {
      console.log(`  - ${u.aammdd} slot ${u.slot}: ${u.reason}`);
    }
    if (neverEnrichedBoxes.length > 20) {
      console.log(`  ... e mais ${neverEnrichedBoxes.length - 20}`);
    }
  }

  if (unmatchedBoxes.length > 0) {
    console.log(`\n_${unmatchedBoxes.length} box(es) sem dado de clique mensurável (não entram no ranking acima):_`);
    for (const u of unmatchedBoxes.slice(0, 20)) {
      console.log(`  - ${u.aammdd} slot ${u.slot}: ${u.reason}`);
    }
    if (unmatchedBoxes.length > 20) {
      console.log(`  ... e mais ${unmatchedBoxes.length - 20}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
