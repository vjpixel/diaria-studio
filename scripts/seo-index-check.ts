/**
 * seo-index-check.ts (#4105 — 2º passo do loop de SEO #1896)
 *
 * Mede COBERTURA DE INDEXAÇÃO: pra cada URL do sitemap, pergunta ao Google (URL
 * Inspection API) se ela está no índice. É o KPI que faz sentido enquanto o
 * Search Analytics ainda não tem histórico — sem página indexada não existe
 * impressão, e sem impressão o `seo-pull.ts` não tem o que pontuar.
 *
 * Linha de base da primeira rodada (260727, logo após a verificação da
 * propriedade): das 223 edições do sitemap, 24 indexadas (10,8%), 182
 * "Detectada, mas não indexada" e 70 sem nenhuma página de referência. Causa
 * provável: /archive serve só ~5 links `/p/` no HTML (o resto é paginação por
 * JS), então quase nenhum post tem link interno rastreável. Este script
 * transforma esse achado pontual em série temporal, pra saber se as correções
 * de linkagem interna (#4105) funcionaram.
 *
 * Quota da API: 2.000 inspeções/dia e 600/min por propriedade. O default de 200
 * URLs/rodada cabe folgado e cobre o sitemap inteiro em 2 execuções.
 *
 * Uso:
 *   npx tsx scripts/seo-index-check.ts [--site sc-domain:diar.ia.br]
 *     [--sitemap https://diar.ia.br/sitemap.xml] [--limit 200] [--concurrency 4]
 *     [--only-posts] [--out data/seo/index-status-{YYYY-MM-DD}.json]
 *     [--out-md data/seo/index-status-{YYYY-MM-DD}.md] [--out-suffix nome]
 *
 * Exit: 0 ok (grava JSON + .md); 1 erro de API/rede; 2 uso.
 *
 * **`--out-md`/`--out-suffix` (#4909).** O `.md` era escrito em path FIXO
 * (`index-status-{data}.md`), não sobrescrevível — só o JSON aceitava `--out`.
 * Rodar 2 sitemaps diferentes no mesmo dia (ex: host principal + o sitemap
 * de `arquivo.diar.ia.br`, que só tem `/temas/*`, sem `--only-posts`) com
 * `--out` distintos ainda colidia no `.md`, apagando o relatório da 1ª
 * rodada. `--out-md` sobrescreve o `.md` explicitamente; sem ele, o `.md` é
 * derivado do path do JSON (`--out` explícito OU o default), então dois
 * `--out` diferentes já bastam pra não colidir. `--out-suffix` é o atalho
 * pro caso comum (2ª fonte no mesmo dia): gera
 * `index-status-{suffix}-{data}.json`/`.md` sem precisar escrever os 2 paths
 * à mão — ignorado se `--out` for passado.
 *
 * **#5618: rótulo "órfã (sem link interno)" era uma afirmação de causa que o
 * HTML servido podia refutar.** `referringUrls` mede o que o GOOGLE já sabe,
 * não o que existe na página — os dois divergem por semanas (lag de crawl).
 * O relatório rotulava toda URL com `referringUrls` vazio como órfã, mesmo
 * quando a página tinha link interno real (achado ao vivo 18/08: os 6 hubs
 * de `arquivo.diar.ia.br` estão linkados da home, mas o Google ainda não
 * tinha recrawleado). `describeReferrerNote` substitui a afirmação categórica
 * por uma nota honesta sobre a FONTE do dado; quando `main()` consegue buscar
 * a home do site (`fetchKnownInternalLinks`, fail-soft — falha de rede não
 * aborta a rodada), a nota distingue "tem link conhecido, é lag de crawl" de
 * "sem link conhecido, pode ser órfã de verdade".
 *
 * **3 defeitos corrigidos no #5118:**
 * 1. `--limit` cortava as URLs MAIS ANTIGAS (sitemap é newest-first — ver
 *    `applyLimit`) sem deixar marca no output; a cota real (2.000/dia) tinha
 *    folga de ~8× sobre o `--limit 250` usado pela task semanal. `--limit`
 *    subiu pra 2000 (`scripts/lib/scheduled-tasks.ts`) e, se um corte ainda
 *    assim acontecer, `applyLimit` agora descarta as mais NOVAS (que já
 *    indexam bem) e preserva as mais antigas (o objeto real da medição);
 *    `truncated: {dropped, limit}` fica gravado no JSON e no `.md`.
 * 2. `orphan_count` contava o sitemap como "referrer", subcontando orfandade
 *    em 2,4× (o sitemap é canal de descoberta, não link). `no_html_referrer_count`
 *    é a métrica nova (nenhum referrer que não seja o sitemap); `orphan_count`
 *    manteve a definição original (nenhum referrer, ponto) — não foi
 *    redefinido em silêncio, a série de 4 snapshots já coletada usa essa
 *    definição.
 * 3. Regressão de indexação era invisível (o relatório só agregava por
 *    estado). `computeRegressions` faz o delta URL-a-URL contra o snapshot
 *    anterior da mesma família (`findPreviousSnapshotPath`); e como duas
 *    rodadas no mesmo dia sobrescreviam o mesmo JSON (destruindo o par que
 *    permitiria medir o ruído entre rodadas), `resolveCollisionSafeJsonPath`
 *    sufixa por HHMM (UTC) quando o path do dia já existe em disco.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { parseSitemap } from "./lib/fetch-sitemap.ts";
import { fetchWithRetry } from "./lib/fetch-retry.ts";
import { GSC_DEFAULT_SITE, DEFAULT_SITEMAP_URL } from "./lib/gsc.ts";
import { gFetch } from "./google-auth.ts";

const INSPECT_ENDPOINT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
/** Quota diária da API é 2.000; 200/rodada deixa margem pra retry e uso manual. */
const DEFAULT_LIMIT = 200;
const DEFAULT_CONCURRENCY = 4;

export interface IndexStatus {
  url: string;
  /** PASS = indexada; NEUTRAL/FAIL = não. Ausente se a chamada falhou. */
  verdict?: string;
  /** Texto do Google, ex: "Enviada e indexada", "Detectada, mas não indexada no momento". */
  coverageState?: string;
  robotsTxtState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
  googleCanonical?: string;
  /** Página que linka pra esta URL. Vazio = órfã (só existe no sitemap). */
  referringUrls?: string[];
  error?: string;
}

export interface IndexSummary {
  total: number;
  indexed: number;
  not_indexed: number;
  errors: number;
  /** Percentual de cobertura, 0..100 com 1 casa. */
  coverage_pct: number;
  /** Contagem por coverageState, pra ver o MOTIVO dominante de não-indexação. */
  by_coverage_state: Record<string, number>;
  /** URLs sem NENHUM referrer (nem sitemap, nem página HTML) — definição
   * original, inalterada desde #4105 pra não quebrar a série já coletada. */
  orphan_count: number;
  /** URLs sem nenhum referrer HTML — inclui as que só têm o sitemap.xml
   * como "referrer" (#5118: a URL Inspection API lista o sitemap dentro de
   * `referringUrls`, e sitemap é canal de descoberta, não link; contá-lo
   * como referente subcontava orfandade em 2,4× — 62 vs 147/233 no
   * snapshot de 10/08). Superset de `orphan_count`. */
  no_html_referrer_count: number;
}

/** Sitemap listado como "referrer" pela URL Inspection API — não é link de
 * página, é canal de descoberta. `/sitemap...\.xml` cobre `sitemap.xml` e
 * variantes com sufixo (`sitemap-posts.xml`, etc). */
export function isSitemapReferrer(url: string): boolean {
  return /\/sitemap[^/]*\.xml(?:[?#].*)?$/i.test(url);
}

/** Parseia a resposta do urlInspection em IndexStatus (shape achatado). */
export function parseInspection(url: string, json: unknown): IndexStatus {
  const r = (json as { inspectionResult?: { indexStatusResult?: Record<string, unknown> } })
    ?.inspectionResult?.indexStatusResult;
  if (!r) return { url, error: "resposta sem indexStatusResult" };
  const referring = r["referringUrls"];
  return {
    url,
    verdict: r["verdict"] as string | undefined,
    coverageState: r["coverageState"] as string | undefined,
    robotsTxtState: r["robotsTxtState"] as string | undefined,
    indexingState: r["indexingState"] as string | undefined,
    lastCrawlTime: r["lastCrawlTime"] as string | undefined,
    googleCanonical: r["googleCanonical"] as string | undefined,
    referringUrls: Array.isArray(referring) ? (referring as string[]) : [],
  };
}

/**
 * Agrega os status numa métrica única. `verdict === "PASS"` é o sinal
 * autoritativo de "está no índice" — `coverageState` é texto localizado
 * (pt-BR na conta do editor) e NÃO deve ser comparado por string (#573:
 * validar estado externo por campo determinístico, não pelo gloss).
 */
export function summarize(rows: IndexStatus[]): IndexSummary {
  const byState: Record<string, number> = {};
  let indexed = 0;
  let errors = 0;
  let orphans = 0;
  let noHtmlReferrer = 0;
  for (const r of rows) {
    if (r.error) {
      errors++;
      continue;
    }
    if (r.verdict === "PASS") indexed++;
    const state = r.coverageState ?? "(sem coverageState)";
    byState[state] = (byState[state] ?? 0) + 1;
    const refs = r.referringUrls ?? [];
    if (refs.length === 0) orphans++;
    if (refs.every(isSitemapReferrer)) noHtmlReferrer++;
  }
  const scored = rows.length - errors;
  return {
    total: rows.length,
    indexed,
    not_indexed: scored - indexed,
    errors,
    coverage_pct: scored === 0 ? 0 : Math.round((indexed / scored) * 1000) / 10,
    by_coverage_state: byState,
    orphan_count: orphans,
    no_html_referrer_count: noHtmlReferrer,
  };
}

/**
 * Parseia flag numérica preservando o `0` explícito. `parseInt(x) || fallback`
 * trata 0 como falsy — `--limit 0` (dry-run: lê o sitemap sem gastar quota)
 * voltava silenciosamente pras 200 URLs default (code-review PR #4106).
 */
export function parseIntFlag(raw: unknown, fallback: number): number {
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Exit code da rodada. Rodar com ZERO URLs não é sucesso: se o sitemap mudar de
 * forma (ex: slug deixar de ser `/p/…` e o `--only-posts` zerar o filtro), a
 * task semanal continuaria verde pra sempre sem medir nada — exatamente a
 * regressão que este script existe pra detectar (code-review PR #4106).
 * Exceção: `--limit 0` é um pedido explícito de não inspecionar nada.
 */
export function resolveExitCode(rows: IndexStatus[], requestedLimit: number): number {
  if (requestedLimit === 0) return 0;
  if (rows.length === 0) return 1;
  return rows.every((r) => r.error) ? 1 : 0;
}

/** Só as URLs de edição (`/p/…`) — as institucionais poluem a métrica. */
export function filterPosts(urls: string[]): string[] {
  return urls.filter((u) => /\/p\//.test(u));
}

/**
 * Aplica `--limit` a `urls` (#5118 item 1). O sitemap é ordenado newest-first
 * (confirmado medindo os 233 rows do snapshot de 10/08 contra `publish_date`:
 * 232 pares consecutivos decrescentes, 0 crescentes) — `urls.slice(0, limit)`
 * (comportamento anterior) mantém as mais NOVAS e descarta as mais ANTIGAS do
 * final do array, que são exatamente a coorte de pior indexação e o objeto
 * real desta medição. Corta do início em vez do fim: mantém as mais antigas
 * (o que queremos medir), descarta as mais novas (que já indexam bem a
 * 75–80% e não são o motivo do script existir).
 */
export function applyLimit(urls: string[], limit: number): { kept: string[]; dropped: number } {
  const dropped = Math.max(0, urls.length - limit);
  if (limit <= 0) return { kept: [], dropped };
  return { kept: dropped > 0 ? urls.slice(dropped) : urls, dropped };
}

/**
 * Path default do JSON de saída (#4909). `suffix` distingue rodadas do
 * mesmo dia sobre sitemaps diferentes (ex: `"arquivo"` pro sitemap de
 * `arquivo.diar.ia.br`) — sem ele, duas rodadas no mesmo dia escrevem no
 * MESMO `index-status-{data}.json`, a 2ª apagando a 1ª.
 */
export function defaultJsonOutPath(seoDir: string, date: string, suffix?: string): string {
  const suffixSegment = suffix ? `-${suffix}` : "";
  return resolve(seoDir, `index-status${suffixSegment}-${date}.json`);
}

/**
 * Path do `.md` (#4909). Prioridade: `explicitMdPath` (`--out-md`) > derivado
 * de `jsonPath` (troca `.json` por `.md`). Antes o `.md` era sempre
 * `index-status-{data}.md`, um path FIXO que não seguia `--out` — duas
 * rodadas no mesmo dia com `--out` diferentes (JSON não colidia) ainda
 * colidiam no `.md`, apagando o relatório da 1ª rodada.
 */
export function resolveMdPath(jsonPath: string, explicitMdPath?: string): string {
  if (explicitMdPath) return explicitMdPath;
  return jsonPath.endsWith(".json") ? `${jsonPath.slice(0, -".json".length)}.md` : `${jsonPath}.md`;
}

/**
 * Evita colisão quando duas rodadas caem no mesmo dia (#5118 item 3b — achado
 * ao vivo em 10/08: execuções às 03:01 e 07:10 UTC, resultados diferentes
 * `orphan_count` 58 vs 62, a 2ª apagou a 1ª e destruiu o par que permitiria
 * estimar o ruído entre rodadas). Só sufixa (`-HHMM` UTC, antes do `.json`)
 * quando `jsonPath` já existe em disco — a 1ª rodada do dia mantém o nome
 * limpo de sempre (`index-status-{data}.json`), preservando a série
 * histórica; só a 2ª+ rodada do mesmo dia ganha o sufixo.
 */
export function resolveCollisionSafeJsonPath(
  jsonPath: string,
  nowMs: number,
  fileExists: (p: string) => boolean = existsSync,
): string {
  if (!fileExists(jsonPath)) return jsonPath;
  const hhmm = new Date(nowMs).toISOString().slice(11, 16).replace(":", "");
  return jsonPath.endsWith(".json") ? `${jsonPath.slice(0, -".json".length)}-${hhmm}.json` : `${jsonPath}-${hhmm}`;
}

/**
 * "Família" de um path de snapshot — o prefixo antes da data, usado pra achar
 * o snapshot ANTERIOR da mesma fonte (host principal vs `--out-suffix
 * arquivo` não devem ser comparados entre si). `null` se `jsonPath` não
 * seguir a convenção `{prefixo}-{YYYY-MM-DD}[-HHMM].json` (ex: `--out`
 * arbitrário) — nesse caso não há como achar o anterior com segurança, e as
 * regressões ficam vazias em vez de comparar coisas incomparáveis.
 */
export function extractSnapshotFamily(jsonPath: string): string | null {
  const m = basename(jsonPath).match(/^(.+)-\d{4}-\d{2}-\d{2}(?:-\d{4})?\.json$/);
  return m ? m[1] : null;
}

/**
 * Acha o snapshot anterior mais recente da mesma família em `seoDir` (#5118
 * item 3a). Os nomes seguem `{prefixo}-{YYYY-MM-DD}[-HHMM].json`, que ordena
 * lexicograficamente = ordena cronologicamente — não precisa parsear datas.
 * `currentJsonPath` é excluído mesmo que já exista em disco (idempotência:
 * re-rodar sobre um snapshot já escrito não deve comparar o arquivo consigo
 * mesmo).
 */
export function findPreviousSnapshotPath(
  seoDir: string,
  currentJsonPath: string,
  listDir: (dir: string) => string[] = (d) => (existsSync(d) ? readdirSync(d) : []),
): string | null {
  const family = extractSnapshotFamily(currentJsonPath);
  if (!family) return null;
  const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}-\\d{4}-\\d{2}-\\d{2}(?:-\\d{4})?\\.json$`);
  const currentBase = basename(currentJsonPath);
  const candidates = listDir(seoDir)
    .filter((f) => re.test(f) && f !== currentBase)
    .sort();
  return candidates.length === 0 ? null : resolve(seoDir, candidates[candidates.length - 1]);
}

export interface IndexRegression {
  url: string;
  /** `coverageState` da rodada anterior (a URL estava indexada — `verdict === "PASS"`). */
  from: string;
  /** `coverageState` da rodada atual, ou `erro: ...` se a inspeção falhou desta vez. */
  to: string;
}

/**
 * Delta URL-a-URL entre o snapshot atual e o anterior (#5118 item 3a). O
 * relatório antigo só agregava por estado — uma URL que perde indexação
 * (`INDEXADA → outro estado`) nunca aparecia isolada; foi assim que 5 URLs
 * passaram de "Enviada e indexada" pra "Rastreada, mas não indexada no
 * momento" entre 05 e 10/08 sem nada alarmar. Só reporta regressão a partir
 * de indexada (`verdict === "PASS"` na rodada anterior) — não é uma métrica
 * de "todo mundo que mudou de estado", é especificamente "quem TINHA e
 * PERDEU indexação".
 */
export function computeRegressions(current: IndexStatus[], previous: IndexStatus[]): IndexRegression[] {
  const prevByUrl = new Map(previous.map((r) => [r.url, r]));
  const regressions: IndexRegression[] = [];
  for (const row of current) {
    const prev = prevByUrl.get(row.url);
    if (!prev || prev.verdict !== "PASS" || row.verdict === "PASS") continue;
    regressions.push({
      url: row.url,
      from: prev.coverageState ?? "Enviada e indexada",
      to: row.error ? `erro: ${row.error}` : row.coverageState ?? "(sem coverageState)",
    });
  }
  return regressions;
}

/**
 * Roda `worker` sobre `items` com no máximo `concurrency` em voo. Mantém a
 * ordem da entrada no resultado.
 */
export async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return out;
}

async function inspectUrl(site: string, url: string): Promise<IndexStatus> {
  try {
    const res = await gFetch(INSPECT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inspectionUrl: url, siteUrl: site, languageCode: "pt-BR" }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      if (res.status === 403) {
        return { url, error: `403 — '${site}' não verificada no GSC ou scope webmasters ausente (rode oauth-setup.ts). ${body}` };
      }
      if (res.status === 429) return { url, error: `429 — quota da URL Inspection API estourada (2.000/dia). ${body}` };
      return { url, error: `${res.status}: ${body}` };
    }
    return parseInspection(url, await res.json());
  } catch (e) {
    return { url, error: (e as Error).message };
  }
}

/** Remove barra final pra comparar URLs de forma tolerante a `/` vs sem `/`. */
export function normalizeUrlForCompare(url: string): string {
  return url.replace(/\/$/, "");
}

/**
 * Extrai links internos (mesma origem) de um HTML (#5618). Best-effort por
 * regex — não é um parser DOM completo, mas basta pra achar `href="/temas/..."`
 * e `href="https://mesmo-host/..."` numa home renderizada estaticamente, que é
 * exatamente o que o `curl | grep` manual do #5618 fez pra refutar o rótulo
 * "órfã" dos hubs.
 */
export function extractInternalLinks(html: string, origin: string): Set<string> {
  const out = new Set<string>();
  const re = /href="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    let href = m[1];
    if (href.startsWith("http")) {
      if (!href.startsWith(origin)) continue;
    } else if (href.startsWith("/")) {
      href = origin + href;
    } else {
      continue;
    }
    out.add(normalizeUrlForCompare(href.split("#")[0].split("?")[0]));
  }
  return out;
}

/**
 * Busca a home do host de `sitemapUrl` e extrai os links internos, pra
 * distinguir "órfã de verdade" de "só o Google ainda não sabe" (#5618).
 * Fail-soft: qualquer falha de rede/parse retorna `null` (não aborta a
 * rodada, só degrada de volta pro rótulo genérico sem cross-check).
 */
export async function fetchKnownInternalLinks(sitemapUrl: string): Promise<Set<string> | null> {
  try {
    const origin = new URL(sitemapUrl).origin;
    const res = await fetch(origin + "/", { headers: { "User-Agent": "DiariaBot/1.0 (+https://diar.ia.br)" } });
    if (!res.ok) return null;
    return extractInternalLinks(await res.text(), origin);
  } catch {
    return null;
  }
}

/**
 * Nota exibida ao lado de uma URL sem NENHUM referrer (#5618). Antes o
 * relatório afirmava categoricamente "órfã (sem link interno)" — uma causa
 * que o HTML servido podia refutar, porque `referringUrls` reflete o que o
 * GOOGLE já sabe, não o que existe na página. `knownLinked` (quando
 * disponível via `fetchKnownInternalLinks`) distingue lag de crawl de
 * orfandade real; `undefined` (cross-check indisponível) cai no rótulo
 * honesto genérico, sem afirmar nem uma coisa nem outra.
 */
export function describeReferrerNote(referringUrls: string[] | undefined, knownLinked?: boolean): string {
  if ((referringUrls?.length ?? 0) > 0) return "";
  if (knownLinked === true) {
    return " — Google ainda não registra referrer (a página TEM link interno conhecido; provável lag de crawl, não orfandade)";
  }
  if (knownLinked === false) {
    return " — sem link interno conhecido nem referrer no Google (órfã)";
  }
  return " — Google não registra referrer (pode ser lag de crawl; não confirma orfandade)";
}

export function renderMd(
  rows: IndexStatus[],
  sum: IndexSummary,
  site: string,
  date: string,
  truncated?: { dropped: number; limit: number },
  regressions?: IndexRegression[],
  knownInternalLinks?: Set<string>,
): string {
  const lines = [
    `# Cobertura de indexação — ${site} (${date})`,
    "",
    `**${sum.indexed}/${sum.total - sum.errors} indexadas (${sum.coverage_pct}%)** · ` +
      `${sum.orphan_count} órfãs (0 referrer) · ${sum.no_html_referrer_count} sem referrer HTML (inclui sitemap-only) · ` +
      `${sum.errors} erro(s).`,
  ];
  if (truncated && truncated.dropped > 0) {
    lines.push(
      "",
      `**Truncado:** ${truncated.dropped} URL(s) além de \`--limit ${truncated.limit}\` não foram inspecionadas ` +
        `nesta rodada — \`coverage_pct\` acima é sobre o conjunto truncado, não o sitemap inteiro.`,
    );
  }
  lines.push("", "## Por estado", "");
  for (const [state, n] of Object.entries(sum.by_coverage_state).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${n}× ${state}`);
  }
  if (regressions && regressions.length) {
    lines.push("", `## Regressões — perderam indexação desde a rodada anterior (${regressions.length})`, "");
    for (const r of regressions) lines.push(`- ${r.url} — ${r.from} → ${r.to}`);
  }
  const notIndexed = rows.filter((r) => !r.error && r.verdict !== "PASS");
  if (notIndexed.length) {
    lines.push("", `## Não indexadas (${notIndexed.length})`, "");
    for (const r of notIndexed.slice(0, 100)) {
      const knownLinked = knownInternalLinks ? knownInternalLinks.has(normalizeUrlForCompare(r.url)) : undefined;
      const note = describeReferrerNote(r.referringUrls, knownLinked);
      lines.push(`- ${r.url} — ${r.coverageState ?? r.verdict ?? "?"}${note}`);
    }
    if (notIndexed.length > 100) lines.push(`- … +${notIndexed.length - 100} (ver JSON)`);
  }
  const errored = rows.filter((r) => r.error);
  if (errored.length) {
    lines.push("", `## Erros (${errored.length})`, "");
    for (const r of errored.slice(0, 20)) lines.push(`- ${r.url} — ${r.error}`);
  }
  return lines.join("\n") + "\n";
}

async function main(nowMs: number): Promise<number> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values, flags } = parseCliArgs(process.argv.slice(2));
  const site = String(values["site"] ?? GSC_DEFAULT_SITE);
  const sitemapUrl = String(values["sitemap"] ?? DEFAULT_SITEMAP_URL);
  const limit = parseIntFlag(values["limit"] ?? DEFAULT_LIMIT, DEFAULT_LIMIT);
  const concurrency = parseIntFlag(values["concurrency"] ?? DEFAULT_CONCURRENCY, DEFAULT_CONCURRENCY);
  const date = new Date(nowMs).toISOString().slice(0, 10);

  let urls: string[];
  try {
    // #5973: retry+timeout — um blip de rede de UMA requisição não pode
    // mais derrubar a unit semanal inteira (causa raiz do #5943). Erro de
    // rede/5xx tenta de novo; 4xx (sitemap removido/renomeado) é achado
    // real e falha já na 1ª tentativa via fetchWithRetry.
    const res = await fetchWithRetry((signal) =>
      fetch(sitemapUrl, { headers: { "User-Agent": "DiariaBot/1.0 (+https://diar.ia.br)" }, signal }),
    );
    if (!res.ok) throw new Error(`sitemap ${res.status}`);
    urls = parseSitemap(await res.text()).map((e) => e.loc);
  } catch (e) {
    console.error(`[seo-index-check] falha ao ler ${sitemapUrl}: ${(e as Error).message}`);
    return 1;
  }
  if (flags.has("only-posts")) urls = filterPosts(urls);
  const { kept, dropped } = applyLimit(urls, limit);
  urls = kept;
  const truncated = { dropped, limit };
  if (dropped > 0) {
    console.error(
      `[seo-index-check] aviso: ${dropped} URL(s) além de --limit ${limit} não foram inspecionadas ` +
        `(mantidas as mais antigas — ver applyLimit, #5118)`,
    );
  }

  const rows = await mapLimit(urls, concurrency, (u) => inspectUrl(site, u));
  const sum = summarize(rows);

  const seoDir = resolve(ROOT, "data", "seo");
  if (!existsSync(seoDir)) mkdirSync(seoDir, { recursive: true });
  const outSuffix = values["out-suffix"] !== undefined ? String(values["out-suffix"]) : undefined;
  const requestedJsonPath = String(values["out"] ?? defaultJsonOutPath(seoDir, date, outSuffix));

  // Acha o snapshot anterior ANTES de decidir o path final desta rodada —
  // `extractSnapshotFamily` espera o path "limpo" (sem sufixo de colisão),
  // e a própria rodada em curso ainda não foi escrita, então nunca aparece
  // como candidata (#5118 item 3a).
  let previousRows: IndexStatus[] = [];
  const previousPath = findPreviousSnapshotPath(seoDir, requestedJsonPath);
  if (previousPath) {
    try {
      const parsed = JSON.parse(readFileSync(previousPath, "utf8")) as { rows?: IndexStatus[] };
      previousRows = Array.isArray(parsed.rows) ? parsed.rows : [];
    } catch (e) {
      console.error(`[seo-index-check] aviso: falha ao ler snapshot anterior ${previousPath}: ${(e as Error).message}`);
    }
  }
  const regressions = computeRegressions(rows, previousRows);
  if (regressions.length > 0) {
    console.error(`[seo-index-check] aviso: ${regressions.length} URL(s) perderam indexação desde a rodada anterior`);
  }

  // #5618: best-effort cross-check contra o HTML servido — distingue "lag de
  // crawl" de "órfã de verdade" no rótulo do .md. Fail-soft: `null` degrada
  // pro rótulo genérico sem cross-check, nunca aborta a rodada.
  const knownInternalLinks = (await fetchKnownInternalLinks(sitemapUrl)) ?? undefined;

  // #5118 item 3b: só sufixa se `requestedJsonPath` já existir em disco (2ª+
  // rodada do mesmo dia) — a 1ª rodada do dia mantém o nome limpo de sempre.
  const jsonPath = resolveCollisionSafeJsonPath(requestedJsonPath, nowMs);
  const mdPath = resolveMdPath(jsonPath, values["out-md"] !== undefined ? String(values["out-md"]) : undefined);
  writeFileSync(
    jsonPath,
    JSON.stringify({ site, date, sitemap: sitemapUrl, summary: sum, truncated, regressions, rows }, null, 2),
  );
  writeFileSync(mdPath, renderMd(rows, sum, site, date, truncated, regressions, knownInternalLinks));
  console.log(JSON.stringify({ site, date, ...sum, truncated, regressions: regressions.length, out: jsonPath, outMd: mdPath }, null, 2));
  if (rows.length === 0 && limit !== 0) {
    console.error(`[seo-index-check] nenhuma URL inspecionada — o sitemap ${sitemapUrl} não rendeu URL alguma após o filtro`);
  }
  return resolveExitCode(rows, limit);
}

if (isMainModule(import.meta.url)) {
  main(Date.now()).then((code) => {
    process.exitCode = code;
  });
}

export { main };
