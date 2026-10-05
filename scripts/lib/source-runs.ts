/**
 * lib/source-runs.ts
 *
 * Lógica compartilhada por `record-source-run.ts` (single) e
 * `record-source-runs.ts` (batch). Mantém escrita em disco desacoplada
 * da lógica pura, facilitando testes com fixtures.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";

// `empty` = fetch/SERP teve sucesso mas retornou zero artigos (sem novidade na
// janela, ou query/feed sem hit). NÃO é falha — distinto de `fail` (erro HTTP/
// parse) e `timeout`. Emitido por fetch-rss-batch.ts / fetch-websearch-batch.ts.
export type Outcome = "ok" | "empty" | "fail" | "timeout";

/** Falhas "duras": fetch quebrado (HTTP/parse) ou timeout. `empty`/`ok` não. */
export function isHardFailure(outcome: string): boolean {
  return outcome === "fail" || outcome === "timeout";
}

export interface OutcomeEntry {
  outcome: Outcome;
  timestamp: string;
  /**
   * #9652: edição da rodada (agrupa as várias linhas que UMA rodada grava por
   * fonte — RSS + busca `site:` + fallback de fetch). Ausente no histórico
   * anterior; aí o agrupamento cai no `timestamp` (o batch grava todas as
   * linhas da rodada com o mesmo `now`).
   */
  edition?: string;
  /** #9652: motivo da falha dura, truncado em `OUTCOME_REASON_MAX` chars. */
  reason?: string;
  /** #9652: falha por cota/limite da API de busca (402/429) — não é falha da fonte. */
  search_quota?: boolean;
}

/** #9652: teto de `recent_outcomes` por fonte. Era 10 — com 3-4 linhas por rodada,
 * 10 linhas guardavam só 2-3 rodadas, pouco pra um streak de 3 rodadas. */
export const RECENT_OUTCOMES_MAX = 30;

/** #9652: teto do `reason` guardado em `recent_outcomes` (o log por fonte guarda o inteiro). */
export const OUTCOME_REASON_MAX = 200;

/**
 * #9652: a falha veio da cota/limite da API de busca, não da fonte. Caso real
 * 27/08/2026: a cota mensal de US$ 5 da API de busca acabou e TODA fonte com
 * caminho `site:` passou a gravar `fail` — sinal de infraestrutura
 * compartilhada, não de fonte quebrada.
 *
 * Reconhece SÓ os formatos que `fetch-websearch-batch.ts` grava
 * (`${response.status}: ${error_message}`): `rate_limited: ...` (429 da busca),
 * `error: {..."status":402|429...}` (corpo JSON da API) e "Usage limit
 * exceeded". Nunca `HTTP 429`/`http_429`/`Too Many Requests` — esses vêm do
 * PRÓPRIO feed da fonte (`fetch-rss.ts`, `fetch-sitemap.ts`) e são falha real
 * dela (VentureBeat (IA), RSS em `HTTP 429` desde 04/09/2026). Usado como
 * fallback pro histórico sem `method`/`query_used`; com origem conhecida,
 * `buildOutcomeEntry` só marca cota no caminho da busca.
 */
export function isSearchQuotaFailure(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return (
    /^\s*rate_limited\s*:/i.test(reason) ||
    /usage limit exceeded/i.test(reason) ||
    /^\s*error\s*:.*"status"\s*:\s*(?:402|429)\b/is.test(reason)
  );
}

/** #9652 (review): origem da linha — `method` do batch e/ou `query_used`. */
export interface OutcomeOrigin {
  method?: string | null;
  query_used?: string | null;
}

/**
 * #9652 (review): a linha veio do caminho da API de busca? `true`/`false` quando
 * a origem é conhecida; `undefined` quando não há `method` nem `query_used`.
 * `method` vence (`websearch_*` = busca; `rss`/`sitemap`/outros = não); sem
 * `method`, `query_used` começando em `site:` é a busca e uma URL não é.
 */
export function isSearchPath(origin: OutcomeOrigin | undefined): boolean | undefined {
  const method = origin?.method?.trim();
  if (method) return /^websearch/i.test(method);
  const q = origin?.query_used?.trim();
  if (q) return /^site:/i.test(q);
  return undefined;
}

/** Forma mínima de um outcome lido do disco (campos podem faltar no histórico). */
export interface OutcomeLike {
  outcome?: string;
  timestamp?: string;
  edition?: string | null;
  reason?: string | null;
  search_quota?: boolean;
}

/**
 * Veredito de uma RODADA de uma fonte (#9652):
 * - `ok`: algum caminho trouxe artigo → fonte saudável na rodada;
 * - `empty`: nenhum ok, mas algum caminho respondeu sem novidade → não é falha;
 * - `fail`: só falhas duras, e pelo menos uma NÃO é de cota da API de busca;
 * - `quota`: só falhas de cota/limite da API de busca → neutra (não conta nem zera);
 * - `unknown`: só linhas sem `outcome` (registro malformado) → neutra.
 */
export type RoundVerdict = "ok" | "empty" | "fail" | "quota" | "unknown";

export interface OutcomeRound {
  key: string;
  timestamp: string | undefined;
  verdict: RoundVerdict;
  entries: OutcomeLike[];
}

function roundKey(o: OutcomeLike, index: number): string {
  if (o.edition) return `e:${o.edition}`;
  if (o.timestamp) return `t:${o.timestamp}`;
  return `i:${index}`; // sem edição nem timestamp: rodada própria
}

function roundVerdict(entries: OutcomeLike[]): RoundVerdict {
  if (entries.some((e) => e.outcome === "ok")) return "ok";
  if (entries.some((e) => e.outcome === "empty")) return "empty";
  const hard = entries.filter((e) => e.outcome !== undefined && isHardFailure(e.outcome));
  if (hard.length === 0) return "unknown";
  const allQuota = hard.every((e) => e.search_quota === true || isSearchQuotaFailure(e.reason));
  return allQuota ? "quota" : "fail";
}

/**
 * #9652: agrupa outcomes CONSECUTIVOS da mesma rodada. Uma rodada grava várias
 * linhas por fonte (RSS e busca `site:` em paralelo, mais o fallback de
 * fetch); contar linhas transformou 1 rodada com RSS ok em "3 falhas
 * consecutivas" (OpenAI, 27/08/2026 23:14:49 → #6601 → fonte removida).
 * Chave: `edition` quando presente; senão `timestamp` (histórico antigo).
 */
export function groupOutcomesIntoRounds(outcomes: OutcomeLike[]): OutcomeRound[] {
  const rounds: OutcomeRound[] = [];
  outcomes.forEach((o, i) => {
    const key = roundKey(o, i);
    const last = rounds[rounds.length - 1];
    if (last && last.key === key) {
      last.entries.push(o);
    } else {
      rounds.push({ key, timestamp: o.timestamp, verdict: "unknown", entries: [o] });
    }
  });
  for (const r of rounds) r.verdict = roundVerdict(r.entries);
  return rounds;
}

/**
 * #9652: streak de RODADAS com falha dura, do mais recente pra trás. `ok`/`empty`
 * encerram; `quota`/`unknown` são puladas (não contam nem zeram).
 */
export function roundFailureStreak(outcomes: OutcomeLike[]): {
  consecutive_failures: number;
  failure_timestamps: string[];
} {
  const rounds = groupOutcomesIntoRounds(outcomes);
  const failure_timestamps: string[] = [];
  let count = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const v = rounds[i].verdict;
    if (v === "ok" || v === "empty") break;
    if (v !== "fail") continue;
    count++;
    if (rounds[i].timestamp) failure_timestamps.unshift(rounds[i].timestamp as string);
  }
  return { consecutive_failures: count, failure_timestamps };
}

/**
 * #9652: rodadas sem nenhum `ok`, do mais recente pra trás (pra o sinal de fonte
 * seca). `quota`/`unknown` são puladas — a cota esgotada não diz nada da fonte.
 */
export function roundDryStreak(outcomes: OutcomeLike[]): number {
  const rounds = groupOutcomesIntoRounds(outcomes);
  let count = 0;
  for (let i = rounds.length - 1; i >= 0; i--) {
    const v = rounds[i].verdict;
    if (v === "ok") break;
    if (v === "quota" || v === "unknown") continue;
    count++;
  }
  return count;
}

/** #9652: monta o item de `recent_outcomes` (edição + motivo curto + flag de cota). */
export function buildOutcomeEntry<O extends Outcome>(
  outcome: O,
  timestamp: string,
  edition?: string | null,
  reason?: string | null,
  origin?: OutcomeOrigin,
): OutcomeEntry & { outcome: O } {
  const e: OutcomeEntry & { outcome: O } = { outcome, timestamp };
  if (edition) e.edition = edition;
  if (isHardFailure(outcome) && reason) {
    e.reason = reason.slice(0, OUTCOME_REASON_MAX);
    // Origem conhecida e fora da busca (RSS/sitemap/fetch) → nunca é cota da
    // busca, mesmo que o texto pareça (#9652 review).
    if (isSearchPath(origin) !== false && isSearchQuotaFailure(reason)) e.search_quota = true;
  }
  return e;
}

export interface SourceEntry {
  attempts: number;
  successes: number;
  failures: number;
  timeouts: number;
  last_success_iso: string | null;
  last_failure_iso: string | null;
  last_duration_ms: number | null;
  recent_outcomes: OutcomeEntry[];
  total_articles: number;
}

export interface HealthFile {
  sources: Record<string, SourceEntry>;
  notes?: string;
}

export interface RunRecord {
  source: string;
  edition?: string;
  outcome: Outcome;
  duration_ms?: number | null;
  query_used?: string | null;
  /** Caminho que gerou a linha (`rss`, `sitemap`, `websearch_brave`...), quando o batch informa. */
  method?: string | null;
  articles?: Array<{ title?: string; url?: string; published_at?: string }>;
  reason?: string | null;
}

export interface RunResult {
  source: string;
  slug: string;
  outcome: Outcome;
  attempts: number;
  consecutive_failures: number;
  failure_timestamps: string[];
  log_path: string;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function emptyEntry(): SourceEntry {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    last_success_iso: null,
    last_failure_iso: null,
    last_duration_ms: null,
    recent_outcomes: [],
    total_articles: 0,
  };
}

/**
 * Aplica um RunRecord a uma SourceEntry, retornando nova entry atualizada.
 * Pura: sem I/O.
 */
export function applyRun(
  prev: SourceEntry,
  run: RunRecord,
  now: string,
): SourceEntry {
  const entry: SourceEntry = {
    ...prev,
    recent_outcomes: [...prev.recent_outcomes],
  };
  entry.attempts += 1;
  if (run.duration_ms !== null && run.duration_ms !== undefined) {
    entry.last_duration_ms = run.duration_ms;
  }
  const articlesCount = run.articles?.length ?? 0;
  if (run.outcome === "ok") {
    entry.successes += 1;
    entry.last_success_iso = now;
    entry.total_articles += articlesCount;
  } else if (run.outcome === "fail") {
    entry.failures += 1;
    entry.last_failure_iso = now;
  } else if (run.outcome === "timeout") {
    entry.timeouts += 1;
    entry.last_failure_iso = now;
  }
  entry.recent_outcomes.push(
    buildOutcomeEntry(run.outcome, now, run.edition, run.reason, {
      method: run.method,
      query_used: run.query_used,
    }),
  );
  if (entry.recent_outcomes.length > RECENT_OUTCOMES_MAX) {
    entry.recent_outcomes.splice(0, entry.recent_outcomes.length - RECENT_OUTCOMES_MAX);
  }
  return entry;
}

/**
 * Deriva consecutive_failures + failure_timestamps do `recent_outcomes`
 * (streak de falhas DURAS — `fail`/`timeout` — a partir do mais recente).
 *
 * `empty` (fetch OK, zero artigos) e `ok` encerram o streak: nenhum dos dois é
 * falha. Antes (#1576) qualquer não-`ok` contava, o que inflava o streak de
 * blogs de baixa frequência que só retornaram `empty` por falta de novidade.
 *
 * #9652: conta RODADAS, não linhas — ver `roundFailureStreak`. Rodada com
 * qualquer `ok` é saudável; rodada só com falha de cota da API de busca
 * (402/429) não conta. `failure_timestamps` traz 1 timestamp por rodada.
 */
export function computeFailureStreak(entry: SourceEntry): {
  consecutive_failures: number;
  failure_timestamps: string[];
} {
  return roundFailureStreak(entry.recent_outcomes);
}

export type SourceStatus = "verde" | "amarelo" | "vermelho";

/**
 * Classifica o status agregado de uma fonte a partir de `success_rate_pct`
 * (0-100) + `consecutive_failures` (streak de falhas DURAS, ver
 * `computeFailureStreak`). Extraído de `build-diaria-dashboard-data.ts`
 * (#2132) pra ser reusável por `source-health-report.ts` (#5191) sem duplicar
 * o limiar — single source of truth pros 3 buckets 🟢/🟡/🔴.
 *
 * Nota (finding #3 do #2132): amarelo exige AMBAS condições (AND), não
 * qualquer uma (OR) — uma fonte com 10+ falhas consecutivas não vira
 * "amarelo" só por ter taxa histórica ≥ 50%. `.claude/skills/diaria-source-health/SKILL.md`
 * ainda descreve o limiar em prosa com "ou"; este é o comportamento real.
 */
export function classifySourceStatus(
  successRatePct: number,
  consecutiveFailures: number,
): SourceStatus {
  if (successRatePct >= 80 && consecutiveFailures === 0) return "verde";
  if (successRatePct >= 50 && consecutiveFailures <= 2) return "amarelo";
  return "vermelho";
}

// -------------------- I/O wrappers --------------------

export function loadHealth(healthPath: string): HealthFile {
  if (!existsSync(healthPath)) return { sources: {} };
  try {
    const parsed = JSON.parse(readFileSync(healthPath, "utf8"));
    if (!parsed.sources) parsed.sources = {};
    return parsed as HealthFile;
  } catch {
    return { sources: {} };
  }
}

export function saveHealth(healthPath: string, health: HealthFile): void {
  mkdirSync(dirname(healthPath), { recursive: true });
  // #1269: usar writeFileAtomic (com retry em EPERM no Windows + OneDrive
  // race). Antes usava renameSync direto, crashava intermitente em test runs.
  writeFileAtomic(healthPath, JSON.stringify(health, null, 2) + "\n");
}

/**
 * #1374: retry-with-backoff em appendFileSync. Windows + OneDrive Files
 * On-Demand pode retornar UNKNOWN (errno=-4094) ou EPERM/EBUSY quando o
 * sync agent tem o arquivo locked durante hidratação. Caso real 260519:
 * 22 de 49 slugs falharam no primeiro run; passaram após probe que forçou
 * download.
 *
 * Retry só em codes transientes do Windows. Outros erros (ENOENT, EACCES
 * permanente, etc) propagam imediato.
 *
 * Backoff: [0, 200, 500, 1500]ms — busy-wait sync (mesma pattern do
 * renameWithRetry em atomic-write.ts:122).
 *
 * Helper exportado pra teste de injection.
 */
export function appendFileWithRetry(
  filePath: string,
  data: string,
  attempts: number[] = [0, 200, 500, 1500],
  appendFn: (p: string, d: string, enc: "utf8") => void = (p, d, enc) =>
    appendFileSync(p, d, enc),
): void {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts.length; i++) {
    if (attempts[i] > 0) {
      const deadline = Date.now() + attempts[i];
      while (Date.now() < deadline) {
        /* spin */
      }
    }
    try {
      appendFn(filePath, data, "utf8");
      return;
    } catch (err) {
      lastErr = err;
      const e = err as NodeJS.ErrnoException;
      const code = e?.code;
      const errno = e?.errno;
      // UNKNOWN errno=-4094 (OneDrive race), EPERM, EBUSY, EACCES → retry.
      // Outros codes propagam imediato.
      const isTransient =
        code === "UNKNOWN" ||
        code === "EPERM" ||
        code === "EBUSY" ||
        code === "EACCES" ||
        errno === -4094;
      if (!isTransient) throw err;
      if (i === attempts.length - 1) throw err;
    }
  }
  throw lastErr; // unreachable mas TS feliz
}

export function appendSourceLog(
  rootDir: string,
  slug: string,
  logEntry: unknown,
): string {
  const sourceLogPath = resolve(rootDir, `data/sources/${slug}.jsonl`);
  mkdirSync(dirname(sourceLogPath), { recursive: true });
  // #1374: retry-with-backoff cobre OneDrive Files On-Demand race
  appendFileWithRetry(sourceLogPath, JSON.stringify(logEntry) + "\n");
  return sourceLogPath;
}

/**
 * Executa um RunRecord: atualiza health.json + anexa log individual.
 * Retorna resultado resumido.
 */
export function recordRun(
  rootDir: string,
  run: RunRecord,
  now: string = new Date().toISOString(),
): RunResult {
  const healthPath = resolve(rootDir, "data/source-health.json");
  const health = loadHealth(healthPath);
  const prev = health.sources[run.source] ?? emptyEntry();
  const entry = applyRun(prev, run, now);
  health.sources[run.source] = entry;
  saveHealth(healthPath, health);

  const slug = slugify(run.source);
  const logEntry = {
    timestamp: now,
    source: run.source,
    edition: run.edition ?? null,
    outcome: run.outcome,
    duration_ms: run.duration_ms ?? null,
    reason: run.reason ?? null,
    query_used: run.query_used ?? null,
    articles_count: run.articles?.length ?? 0,
    articles: (run.articles ?? []).map((a) => ({
      title: a.title ?? null,
      url: a.url ?? null,
      published_at: a.published_at ?? null,
    })),
  };
  const log_path = appendSourceLog(rootDir, slug, logEntry);

  const { consecutive_failures, failure_timestamps } = computeFailureStreak(entry);
  return {
    source: run.source,
    slug,
    outcome: run.outcome,
    attempts: entry.attempts,
    consecutive_failures,
    failure_timestamps,
    log_path,
  };
}

export function recordRunsBatch(
  rootDir: string,
  runs: RunRecord[],
  now: string = new Date().toISOString(),
): RunResult[] {
  return runs.map((run) => recordRun(rootDir, run, now));
}
