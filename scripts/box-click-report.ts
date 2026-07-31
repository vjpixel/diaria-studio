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

/** Dado o texto de um box já extraído (`extractBoxDivulgacaoN`), acha qual
 * snippet cadastrado corresponde — por base-URL da 1ª URL do box que bater
 * com alguma URL de algum snippet. `null` quando o box não tem URL, ou
 * nenhum snippet cadastrado corresponde (ex: box escrito manualmente, sem
 * vir de um snippet reaproveitável). */
export function matchSnippetForBox(
  boxText: string,
  snippets: SnippetInfo[],
): SnippetInfo | null {
  for (const url of extractUrls(boxText).map(toBaseUrl)) {
    const found = snippets.find((s) => s.urls.includes(url));
    if (found) return found;
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
  stats?: { clicks?: ClickLike[] };
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
 * usada pro lookup de clique (1ª URL do box). */
export function extractEditionBoxUsages(reviewedMd: string, snippets: SnippetInfo[]): BoxUsage[] {
  const out: BoxUsage[] = [];
  for (const [slot, extractor] of SLOT_EXTRACTORS) {
    const boxText = extractor(reviewedMd);
    if (!boxText) continue;
    const snippet = matchSnippetForBox(boxText, snippets);
    const urls = extractUrls(boxText);
    out.push({ slot, boxText, snippet, url: urls[0] ?? null });
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
}

export interface BoxClickReport {
  rows: RankingRow[];
  unmatchedBoxes: UnmatchedBox[];
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

  for (const aammdd of opts.aammddList) {
    const md = opts.readReviewedMd(aammdd);
    if (!md) continue;

    const usages = extractEditionBoxUsages(md, opts.snippets);
    if (usages.length === 0) continue;
    const post = opts.findPost(aammdd);

    for (const usage of usages) {
      if (!usage.url) {
        unmatchedBoxes.push({ aammdd, slot: usage.slot, reason: "box sem link (texto puro, não mensurável)" });
        continue;
      }
      if (!usage.snippet) {
        unmatchedBoxes.push({
          aammdd,
          slot: usage.slot,
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
      entry.editions.add(aammdd);

      if (post) {
        const sum = sumClicksForUrl(usage.url, post.stats?.clicks ?? []);
        entry.verified += sum.verified_clicks;
        entry.uniqueVerified += sum.unique_verified_clicks;
      } else {
        unmatchedBoxes.push({
          aammdd,
          slot: usage.slot,
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

  return { rows, unmatchedBoxes };
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

  const { rows, unmatchedBoxes } = buildBoxClickReport({
    aammddList,
    readReviewedMd,
    snippets,
    findPost: (aammdd) => findPostForEdition(aammdd, posts),
  });

  console.log(`# Recomendação de boxes de divulgação — últimas ${aammddList.length} edições varridas\n`);
  console.log(renderMarkdownTable(rows));

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
