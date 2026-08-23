#!/usr/bin/env node
/**
 * stage-1-run.ts (#5415, incremento 3/3 — Stage 1, ESCOPO PARCIAL)
 *
 * Orquestrador DETERMINÍSTICO do MIOLO GLUE do Stage 1 (Pesquisa) do
 * orchestrator diar.ia.br (`.claude/agents/orchestrator-stage-1-research.md`)
 * — mesmo padrão de `scripts/stage-0-run.ts` e `scripts/stage-3-run.ts`
 * (#5415 incrementos 1/3 e 2/3).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * POR QUE MULTI-FASE (diferente de Stage 0/3 — ver §"Achado" na issue #5415)
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Stage 1 é o mais entrelaçado dos três: o playbook tem **7 pontos** de
 * dispatch `Agent()` no meio do fluxo, não 1-2 como Stage 0 (3 pings MCP,
 * agrupados numa fronteira só) ou Stage 3 (crop-reviewer, 1 fronteira).
 * Um script `spawnSync` não pode chamar `Agent` — só a sessão top-level
 * pode. Este runner cobre o GLUE determinístico entre esses pontos,
 * dividido em 5 fases que casam com as fronteiras reais onde o orchestrator
 * top-level precisa pausar pra despachar (ou decidir que não precisa).
 *
 * Os 7 pontos de Agent() do playbook, e como cada um é tratado aqui:
 *
 *   1. §1f Path B (source-researcher × N + discovery-searcher × M) —
 *      CONDICIONAL: só dispara quando BRAVE_API_KEY ausente ou
 *      WEBSEARCH_BACKEND=agents (Path A é o default desde #1560 e roda
 *      100% determinístico via fetch-websearch-batch.ts, SEM Agent).
 *      Coberto: fase `pre-research` faz a tentativa do Path A e, se cair
 *      pro Path B, faz o pre-flight determinístico (blocklist + queries
 *      how-to/negative-impact/inbox-topics) e devolve um manifest em
 *      `pendingAgentDispatch`. **Não coberto**: as ~5 PT + ~5 EN queries
 *      temáticas genéricas do Path B não têm pool determinístico no
 *      playbook (diferente de how-to #2313 e negative-impact #3916/#3918,
 *      que TÊM pool fixo via `use-melhor-curation.ts`/
 *      `negative-impact-curation.ts`) — são julgamento do orchestrator
 *      sobre o que é relevante hoje. Sinalizado em `delegatedSteps`.
 *   2. §1m-ter (discovery-searcher por launch_candidate, busca ativa de
 *      fonte primária) — **NÃO COBERTO**, delegado. Contagem variável,
 *      substituição é opcional/fail-soft (guard explícito no playbook:
 *      "nada verificado → manter como notícia"), e 1m-quater (dedup
 *      pós-promoção) já roda de qualquer forma sobre o resultado sem essa
 *      promoção (idempotente — `checked: 0` quando não há
 *      `primary_source_substituted`). Perda: menos automação de
 *      imprensa→oficial; editor ainda vê e resolve manualmente no gate
 *      via review-highlight-source.ts/review-highlight-official-swap.ts
 *      (esses SIM cobertos — são warn-only determinísticos, não Agent).
 *   3. §1m-quinquies (discovery-searcher por vídeo não-YouTube) — **NÃO
 *      COBERTO**, delegado. Mesmo racional: fail-soft explícito
 *      (`video_url_unverified: true`, editor cola manualmente no gate).
 *   4. §1q.2 (scorer-chunk × chunk_count, paralelo) — MANDATÓRIO quando
 *      chunk_count > 1. Coberto: fase `post-research-pre-score` roda o
 *      split e devolve `pendingAgentDispatch` com chunk_count e os paths
 *      canônicos esperados dos `scored-chunk-{i}.json`.
 *   5. §1q.4 (scorer-select) — MANDATÓRIO no caminho chunked. Coberto:
 *      fase `post-score` roda o merge e devolve `pendingAgentDispatch`.
 *   6. §1q-fallback (scorer, single-call) — MANDATÓRIO quando
 *      chunk_count <= 1 (pool pequeno) ou merge falhou catastroficamente.
 *      Coberto: fase `post-research-pre-score` já sinaliza esse caminho
 *      em vez do chunked; fase `post-select-render` consome o resultado.
 *   7. §1y pós-gate (discovery-searcher via resolve-primary-source.ts pra
 *      artigos secundários aprovados) — **NÃO COBERTO**, delegado.
 *      Enhancement opcional pós-gate, fail-soft ("preservando sem
 *      resultado confiável"), não afeta o conteúdo que o editor já
 *      aprovou no MD.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * AS 5 FASES
 * ═══════════════════════════════════════════════════════════════════════
 *
 *   --phase pre-research
 *     §1a (inbox-drain) → §1c (poll stats, fail-soft) → §1d (eia-compose
 *     dispatchado em background via spawn detached — SEM depender do
 *     `Bash(run_in_background)` do harness, ver "eia dispatch" abaixo) →
 *     §1e (RSS batch) → §1e-bis (prewarm cache, background) → §1e.5
 *     (inbox topics) → §1f Path A (tentativa determinística) → se Path A
 *     falhar (key ausente) ou for desligado, pre-flight de Path B
 *     (blocklist + queries determinísticas) devolvido como
 *     `pendingAgentDispatch`.
 *
 *   --phase post-research-pre-score [--agent-research-results <path>]
 *     Se Path B foi sinalizado na fase anterior, `--agent-research-results`
 *     é OBRIGATÓRIO (RunRecord[] agregado pelos dispatches Agent do
 *     orchestrator) — mergeado em researcher-results.json antes de seguir.
 *     §1g (record-source-runs) → §1g-ter (assemble pool) → §1g-bis
 *     (carry-over) → §1h (inject inbox urls + validate + marker) → §1i
 *     (verify-accessibility + anotação/remoção in-JS) → §1j (expand
 *     aggregators) → §1k (enrich inbox) → §1l (dedup) → §1m (categorize +
 *     enrich-primary-source + integrity checkpoint) → §1m-quater
 *     (check-promoted-dedup, idempotente mesmo sem 1m-ter) → §1n
 *     (topic-cluster) → §1o (filter-date-window) → §1p1
 *     (research-review-dates) → §1q.1 (split-articles-for-scoring) →
 *     devolve `pendingAgentDispatch` pro scorer-chunk (chunked) OU sinaliza
 *     `needsScorerFallback` (pool pequeno, cai pro scorer single-call).
 *
 *   --phase post-score --chunk-count N
 *     SÓ no caminho chunked (não roda quando `needsScorerFallback`). §1q.3
 *     (merge-scored-chunks, lendo os `scored-chunk-{i}.json` que o
 *     orchestrator escreveu nos paths canônicos após os dispatches
 *     scorer-chunk) → branch pelo exit code (#1669) → §1q.3-bis (integrity
 *     checkpoint) → devolve `pendingAgentDispatch` pro scorer-select.
 *
 *   --phase post-select-render [--selection-json <path> | --fallback-scored-json <path>]
 *     Exatamente um dos dois. §1q.5 (assemble-scored, caminho chunked) OU
 *     aceita o `tmp-scored.json` do scorer single-call diretamente
 *     (fallback) → §1r (promoção de runners_up até 6, in-JS) → §1s
 *     (finalize-stage1) → §1t (avisos de mínimo por seção, in-JS) → §1u
 *     (shape final + strip verifier, in-JS) → §1u-bis/§1u-ter (dedup
 *     intra-edição + evergreen) → §1v (render MD) → §1v-bis..1v-quinquies
 *     (lints warn-only) → §1w-quint (anti-skip 1f, BLOQUEIA) → §1w-bis
 *     (validate-stage-1-output, blocker vira HALT) → §1w-quat
 *     (check-invariants categorized-has-eia-section, BLOQUEIA) → §1w-ter
 *     (payload sizes) → §1w-quint-b (repeat-de-tema, fail-soft). Devolve
 *     tudo que o gate humano (§1x) precisa mostrar — a apresentação em si
 *     (texto formatado pro editor) continua do orchestrator.
 *
 *   --phase post-gate [--md <path> | --auto]
 *     §1y — aplica as edições do gate (ou `--auto`), re-renderiza MD,
 *     re-valida lançamentos, invariantes pós-apply (warn, não bloqueia),
 *     experimento D3-radar (opt-in via config), escreve sentinel, arquiva
 *     inbox, fecha stage-status + captura de custo.
 *
 * Cada sub-script é invocado por SPAWN (`process.execPath --import tsx`,
 * nunca `npx tsx` — guard #4343), nunca por import.
 *
 * "eia dispatch" (§1d): diferente do playbook em prosa (que usa
 * `Bash(run_in_background=true)` do harness e guarda o `bashId` da
 * ferramenta), este script dispatcha `eia-compose.ts` via
 * `child_process.spawn(...).unref()` — um processo filho DETACHED de
 * verdade, não amarrado à sessão do harness. Isso é seguro porque
 * `eia-dispatch-state.ts` (#5414) já documenta que `bashId` é só
 * informativo/debug — a fonte de verdade de conclusão SEMPRE foi (e
 * continua sendo) `01-eia.md` existir no disco, checado por
 * file-presence no Stage 3, não por polling de bash status. Aqui
 * `bashId` grava um marcador fixo (`"stage-1-run:detached"`) só pra
 * distinguir na leitura que o dispatch não veio de uma sessão com
 * harness.
 *
 * Exit codes:
 *   0 — sucesso (mesmo com `pendingAgentDispatch` pendente — isso não é
 *       erro do script, é trabalho que o orchestrator ainda precisa fazer)
 *   1 — erro duro (sub-script obrigatório falhou, args inválidos, merge
 *       catastrófico sem retry possível aqui)
 *   2 — HALT obrigatório (validate-stage-1-completeness/-output blocker,
 *       check-invariants gate-crítico, marker ausente — banner já
 *       renderizado, incluído em `haltRequired` no JSON de saída)
 *
 * Uso:
 *   npx tsx scripts/stage-1-run.ts --phase pre-research --edition AAMMDD
 *   npx tsx scripts/stage-1-run.ts --phase post-research-pre-score --edition AAMMDD [--agent-research-results <path>]
 *   npx tsx scripts/stage-1-run.ts --phase post-score --edition AAMMDD --chunk-count N
 *   npx tsx scripts/stage-1-run.ts --phase post-select-render --edition AAMMDD [--selection-json <path> | --fallback-scored-json <path>]
 *   npx tsx scripts/stage-1-run.ts --phase post-gate --edition AAMMDD [--md <path> | --auto]
 *
 * @see .claude/agents/orchestrator-stage-1-research.md (playbook em prosa —
 *      este script cobre o glue determinístico; NÃO editado nesta unidade —
 *      cutover do orchestrator é decisão separada, ver
 *      docs/stage-1-run-cutover-plan.md)
 * @see scripts/stage-0-run.ts (padrão de referência — 2 fases, MCP probes)
 * @see scripts/stage-3-run.ts (padrão de referência — discovery + pendingAgentDispatch)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getHowToDiscoveryQueries } from "./lib/use-melhor-curation.ts";
import { getNegativeImpactDiscoveryQueries } from "./lib/negative-impact-curation.ts";

// Mesma disciplina do #4983 — carregar .env ANTES de qualquer outro código.
loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Spawn de sub-script — mesmo helper de stage-0-run.ts/stage-3-run.ts.
// ---------------------------------------------------------------------------

export interface StepResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (scriptRelPath: string, args: string[]) => StepResult;

export function realExec(rootDir: string): ExecFn {
  return (scriptRelPath, args) => {
    const abs = resolve(rootDir, ...scriptRelPath.split("/"));
    const result = spawnSync(process.execPath, ["--import", "tsx", abs, ...args], {
      cwd: rootDir,
      encoding: "utf8",
    });
    if (result.error || result.status === null) {
      return {
        code: 1,
        stdout: result.stdout ?? "",
        stderr: (result.stderr ?? "") + `\nERRO: o passo nao executou (falha de spawn): ${result.error?.message ?? "status null"}\n`,
      };
    }
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

/** Dispatch fire-and-forget, DETACHED do processo pai — usado só por §1d
 * (eia-compose) e §1e-bis (prewarm-verify-cache). Nunca aguarda, nunca
 * bloqueia. Injetável pra teste (nenhum spawn real nos testes). */
export type SpawnDetachedFn = (scriptRelPath: string, args: string[]) => void;

export function realSpawnDetached(rootDir: string): SpawnDetachedFn {
  return (scriptRelPath, args) => {
    const abs = resolve(rootDir, ...scriptRelPath.split("/"));
    try {
      const child = spawn(process.execPath, ["--import", "tsx", abs, ...args], {
        cwd: rootDir,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } catch {
      // fire-and-forget — falha de spawn aqui não é fatal (mesmo espírito
      // do playbook: "Skip por dispatch failure... ainda assim prosseguir").
    }
  };
}

/** Extrai o primeiro bloco JSON de stdout — mesmo helper de stage-0-run.ts/stage-3-run.ts. */
export function parseStepJson<T = unknown>(stdout: string): T | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const start = Math.min(...["{", "["].map((c) => trimmed.indexOf(c)).filter((i) => i >= 0));
  if (!Number.isFinite(start)) return undefined;
  try {
    return JSON.parse(trimmed.slice(start)) as T;
  } catch {
    return undefined;
  }
}

/**
 * Lê o JSON que um sub-script escreveu no arquivo `--out` dele (#5891,
 * validação ao vivo 260821). Vários scripts do Stage 1 (`dedup.ts`,
 * `check-source-blocklist.ts`) NÃO imprimem JSON no stdout quando recebem
 * `--out` — escrevem só o arquivo e deixam stdout vazio (a nota vai pra
 * stderr). Nesses casos `parseStepJson(result.stdout)` devolve `undefined` e
 * o consumidor seguia silenciosamente com lista vazia: bug ao vivo real —
 * dedup kept=242 → `tmp-kept.json` gravado `[]` → categorize/pool inteiros
 * zerados, sem nenhum erro. Contrato dos testes unitários mockava stdout
 * JSON e por isso não pegou. Regra: quando o passo recebe `--out`, ler o
 * ARQUIVO primeiro; stdout fica só como fallback para scripts antigos.
 */
function readOutFileJson<T>(deps: Stage1RunDeps, absolutePath: string): T | undefined {
  try {
    if (!deps.existsSync(absolutePath)) return undefined;
    return JSON.parse(deps.readFile(absolutePath)) as T;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Abort tipado.
// ---------------------------------------------------------------------------

export class Stage1Abort extends Error {
  readonly code = 1 as const;
  constructor(message: string) {
    super(message);
    this.name = "Stage1Abort";
  }
}

/** Últimas linhas de stderr — mesmo corte de stage-0-run.ts/stage-3-run.ts. */
function tailStderr(stderr: string, n = 6): string {
  return stderr.trim().split("\n").slice(-n).join(" | ") || "(sem stderr)";
}

// ---------------------------------------------------------------------------
// Datas — mesmos helpers puros de stage-0-run.ts (duplicados aqui de
// propósito, mesmo padrão: pequenas funções puras vivem localmente em cada
// runner em vez de um import cruzado entre runners de stage).
// ---------------------------------------------------------------------------

const AAMMDD_RE = /^\d{6}$/;

export function editionIsoFromAammdd(aammdd: string): string {
  if (!AAMMDD_RE.test(aammdd)) {
    throw new Stage1Abort(`edition inválido — esperado AAMMDD (6 dígitos), recebido: "${aammdd}"`);
  }
  return `20${aammdd.slice(0, 2)}-${aammdd.slice(2, 4)}-${aammdd.slice(4, 6)}`;
}

export function isoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function subtractDaysIso(anchorIso: string, days: number): string {
  const d = new Date(`${anchorIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return isoDateOnly(d);
}

export function defaultWindowDays(now: Date): number {
  const day = now.getUTCDay(); // 0=Dom..6=Sáb
  if (day === 3 || day === 4 || day === 5) return 3; // qua/qui/sex
  return 4; // seg/ter + fim de semana (fallback conservador)
}

// ---------------------------------------------------------------------------
// §1c — PREV_EDITION a partir de data/past-editions-raw.json (porta pura do
// snippet `node -e` do playbook).
// ---------------------------------------------------------------------------

export function computePrevEditionFromPastRaw(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const p = parsed[0] as { published_at?: string } | undefined;
  if (!p || !p.published_at) return null;
  const d = new Date(p.published_at);
  if (Number.isNaN(d.getTime())) return null;
  return String(d.getUTCFullYear()).slice(-2) + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
}

// ---------------------------------------------------------------------------
// §1f — merge de RunRecord[] (Path A → researcher-results.json existente).
// ---------------------------------------------------------------------------

export function mergeJsonArrays(a: unknown, b: unknown): unknown[] {
  const arrA = Array.isArray(a) ? a : [];
  const arrB = Array.isArray(b) ? b : [];
  return [...arrA, ...arrB];
}

// ---------------------------------------------------------------------------
// §1i — anotar/remover artigos a partir do link-verify-all.json (pura).
// ---------------------------------------------------------------------------

export interface LinkVerifyResult {
  url: string;
  verdict: string;
  finalUrl?: string;
  note?: string;
  resolvedFrom?: string;
}

export interface PoolArticle {
  url: string;
  source?: string;
  flag?: string;
  [key: string]: unknown;
}

export function applyLinkVerifyAnnotations(articles: PoolArticle[], verifyResults: LinkVerifyResult[]): PoolArticle[] {
  const byUrl = new Map(verifyResults.map((v) => [v.url, v]));
  const out: PoolArticle[] = [];
  for (const article of articles) {
    const v = byUrl.get(article.url);
    if (!v) {
      out.push(article);
      continue;
    }
    const isInbox = article.flag === "editor_submitted" || article.source === "inbox";
    const next: PoolArticle = { ...article, verify_verdict: v.verdict };
    if (v.note) next.verify_note = v.note;
    if (v.verdict === "anti_bot") next.access_uncertain = true;
    if (v.verdict === "uncertain") next.date_unverified = true;
    if (v.resolvedFrom) {
      next.url = v.finalUrl ?? next.url;
      next.resolvedFrom = v.resolvedFrom;
    }
    const isRemovableVerdict = v.verdict === "paywall" || v.verdict === "blocked" || (v.verdict === "aggregator" && !v.resolvedFrom);
    if (isRemovableVerdict && !isInbox) continue; // #778 — editor_submitted nunca é dropado por acessibilidade, só anotado
    out.push(next);
  }
  return out;
}

// ---------------------------------------------------------------------------
// §1r — promover runners_up até 6 highlights (pura).
// ---------------------------------------------------------------------------

export interface ScoredHighlight {
  rank?: number;
  score?: number;
  [key: string]: unknown;
}

export function promoteRunnersUpToSix(scored: { highlights?: ScoredHighlight[]; runners_up?: ScoredHighlight[] }): {
  highlights: ScoredHighlight[];
  runnersUp: ScoredHighlight[];
  promoted: number;
} {
  const highlights = [...(scored.highlights ?? [])];
  const runnersUpSorted = [...(scored.runners_up ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  let promoted = 0;
  while (highlights.length < 6 && runnersUpSorted.length > 0) {
    highlights.push(runnersUpSorted.shift() as ScoredHighlight);
    promoted++;
  }
  highlights.forEach((h, i) => {
    h.rank = i + 1;
  });
  return { highlights, runnersUp: runnersUpSorted, promoted };
}

// ---------------------------------------------------------------------------
// §1t — avisos de mínimo por seção (pura).
// ---------------------------------------------------------------------------

export interface FinalizedBuckets {
  lancamento?: unknown[];
  radar?: unknown[];
  use_melhor?: unknown[];
  video?: unknown[];
}

export function computeMinSectionWarnings(buckets: FinalizedBuckets): string[] {
  const warnings: string[] = [];
  const lancamentoLen = buckets.lancamento?.length ?? 0;
  const radarLen = buckets.radar?.length ?? 0;
  const useMelhorLen = buckets.use_melhor?.length ?? 0;
  if (lancamentoLen < 3) warnings.push(`⚠️ Apenas ${lancamentoLen} lançamento(s) — mínimo esperado: 3`);
  if (radarLen < 8) warnings.push(`⚠️ Apenas ${radarLen} item(ns) em RADAR — mínimo esperado: 8`);
  if (useMelhorLen < 3) warnings.push(`⚠️ Apenas ${useMelhorLen} tutorial(is) — mínimo esperado: 3 candidatos`);
  return warnings;
}

// ---------------------------------------------------------------------------
// §1u — shape final + strip do campo `verifier` (pura).
// ---------------------------------------------------------------------------

export interface CategorizedShape {
  highlights: unknown[];
  runners_up: unknown[];
  lancamento: unknown[];
  radar: unknown[];
  use_melhor: unknown[];
  video: unknown[];
  clusters: unknown[];
}

function stripVerifier<T extends Record<string, unknown>>(article: T): T {
  if (!("verifier" in article)) return article;
  const { verifier: _verifier, ...rest } = article;
  return rest as T;
}

export function assembleFinalCategorized(finalized: {
  highlights?: unknown[];
  runners_up?: unknown[];
  lancamento?: unknown[];
  radar?: unknown[];
  use_melhor?: unknown[];
  video?: unknown[];
  clusters?: unknown[];
}): CategorizedShape {
  const stripBucket = (arr?: unknown[]) => (arr ?? []).map((a) => (a && typeof a === "object" ? stripVerifier(a as Record<string, unknown>) : a));
  return {
    highlights: stripBucket(finalized.highlights),
    runners_up: stripBucket(finalized.runners_up),
    lancamento: stripBucket(finalized.lancamento),
    radar: stripBucket(finalized.radar),
    use_melhor: stripBucket(finalized.use_melhor),
    video: stripBucket(finalized.video),
    clusters: finalized.clusters ?? [],
  };
}

// ---------------------------------------------------------------------------
// Deps injetáveis.
// ---------------------------------------------------------------------------

export interface Stage1RunDeps {
  rootDir: string;
  now: () => Date;
  exec: ExecFn;
  spawnDetached: SpawnDetachedFn;
  existsSync: (p: string) => boolean;
  mkdirSync: (p: string) => void;
  readFile: (p: string) => string;
  writeFile: (path: string, content: string) => void;
  renameFile: (from: string, to: string) => void;
  hasEnv: (name: string) => string | undefined;
}

export function productionDeps(rootDir: string = ROOT): Stage1RunDeps {
  return {
    rootDir,
    now: () => new Date(),
    exec: realExec(rootDir),
    spawnDetached: realSpawnDetached(rootDir),
    existsSync: (p) => existsSync(p),
    mkdirSync: (p) => mkdirSync(p, { recursive: true }),
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, c) => writeFileSync(p, c, "utf8"),
    renameFile: (from, to) => renameSync(from, to),
    hasEnv: (name) => process.env[name],
  };
}

// ---------------------------------------------------------------------------
// Report — acumula texto humano-legível pra devolver no JSON final.
// ---------------------------------------------------------------------------

class ReportBuilder {
  readonly notes: string[] = [];
  note(line: string): void {
    this.notes.push(line);
    console.error(line);
  }
}

function step(
  deps: Stage1RunDeps,
  report: ReportBuilder,
  label: string,
  scriptRelPath: string,
  args: string[],
  okCodes: number[] = [0],
): { result: StepResult; json: unknown } {
  report.note(`▶ ${label}`);
  const result = deps.exec(scriptRelPath, args);
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (!okCodes.includes(result.code)) {
    throw new Stage1Abort(`❌ ${label} falhou (exit ${result.code}): ${tailStderr(result.stderr)}`);
  }
  return { result, json: parseStepJson(result.stdout) };
}

function softStep(deps: Stage1RunDeps, report: ReportBuilder, label: string, scriptRelPath: string, args: string[]): { result: StepResult; json: unknown } {
  report.note(`▶ ${label} (fail-soft)`);
  const result = deps.exec(scriptRelPath, args);
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.code !== 0) {
    report.note(`⚠️  ${label} falhou (exit ${result.code}) — fail-soft, não bloqueia Stage 1.`);
  }
  return { result, json: parseStepJson(result.stdout) };
}

function logEvent(deps: Stage1RunDeps, edition: string, level: "info" | "warn" | "error", message: string, opts: { details?: unknown; informational?: boolean } = {}): void {
  const args = ["--edition", edition, "--stage", "1", "--agent", "orchestrator", "--level", level, "--message", message];
  if (opts.details !== undefined) args.push("--details", JSON.stringify(opts.details));
  if (opts.informational) args.push("--informational");
  const result = deps.exec("scripts/log-event.ts", args);
  if (result.code !== 0) console.error(`⚠️  log-event.ts falhou (exit ${result.code}) ao registrar: ${message}`);
}

// ---------------------------------------------------------------------------
// Tipos de resultado comuns.
// ---------------------------------------------------------------------------

export type Phase = "pre-research" | "post-research-pre-score" | "post-score" | "post-select-render" | "post-gate";

export interface PendingAgentDispatch {
  step: string;
  agent: string;
  detail: string;
  manifestPath?: string;
}

export interface HaltRequired {
  stage: string;
  reason: string;
  action: string;
}

export interface Stage1RunResult {
  code: 0 | 1 | 2;
  phase: Phase;
  editionDir?: string;
  pendingAgentDispatch: PendingAgentDispatch[];
  haltRequired?: HaltRequired;
  delegatedSteps: string[];
  notes: string[];
  [extra: string]: unknown;
}

const DELEGATED_STEPS = [
  "§1f Path B — as ~5 queries PT + ~5 EN temáticas genéricas não têm pool determinístico (diferente de how-to/negative-impact, que TÊM); julgamento do orchestrator sobre o que é relevante hoje.",
  "§1m-ter — busca ativa de fonte primária (discovery-searcher por launch_candidate) — opcional/fail-soft, nunca executado por este script.",
  "§1m-quinquies — resolução de URL de vídeo pro YouTube (discovery-searcher) — opcional/fail-soft, nunca executado por este script.",
  "§1g cost-capture (record-agent-costs.ts) — precisa do bloco <usage> real dos dispatches Agent, indisponível a um script puro.",
  "§1y resolve-primary-source.ts (discovery-searcher pós-gate) — enhancement opcional fail-soft, nunca executado por este script.",
  "§1x GATE HUMANO — apresentação formatada ao editor + espera de aprovação continuam do orchestrator.",
];

function baseResult(phase: Phase, code: 0 | 1 | 2, report: ReportBuilder, extra: Partial<Stage1RunResult> = {}): Stage1RunResult {
  return {
    code,
    phase,
    pendingAgentDispatch: [],
    delegatedSteps: DELEGATED_STEPS,
    notes: report.notes,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Opções da CLI
// ---------------------------------------------------------------------------

export interface Stage1RunOptions {
  phase: Phase;
  edition: string;
  anchorIso?: string;
  cutoffIso?: string;
  windowDays?: number;
  nowIso?: string;
  agentResearchResults?: string;
  chunkCount?: number;
  selectionJson?: string;
  fallbackScoredJson?: string;
  md?: string;
  auto: boolean;
  startedAtIso?: string;
}

const VALID_PHASES: Phase[] = ["pre-research", "post-research-pre-score", "post-score", "post-select-render", "post-gate"];

export function parseStage1RunArgs(argv: string[]): Stage1RunOptions {
  const phaseRaw = getStringArg(argv, "phase", { example: "pre-research" });
  if (!phaseRaw || !(VALID_PHASES as string[]).includes(phaseRaw)) {
    throw new Stage1Abort(`--phase precisa ser um de: ${VALID_PHASES.join(", ")} — recebido: "${phaseRaw}"`);
  }
  const edition = getStringArg(argv, "edition", { example: "260423" });
  if (!edition || !AAMMDD_RE.test(edition)) {
    throw new Stage1Abort('--edition AAMMDD é obrigatório (6 dígitos, ex: "260423").');
  }

  const windowDaysRaw = getStringArg(argv, "window-days", { example: "4" });
  const windowDays = windowDaysRaw !== undefined ? Number(windowDaysRaw) : undefined;
  if (windowDays !== undefined && (!Number.isFinite(windowDays) || !Number.isInteger(windowDays) || windowDays <= 0)) {
    throw new Stage1Abort(`--window-days precisa ser um inteiro positivo — recebido: "${windowDaysRaw}"`);
  }

  const chunkCountRaw = getStringArg(argv, "chunk-count", { example: "3" });
  const chunkCount = chunkCountRaw !== undefined ? Number(chunkCountRaw) : undefined;
  if (chunkCountRaw !== undefined && (!Number.isFinite(chunkCount) || !Number.isInteger(chunkCount) || (chunkCount as number) < 2)) {
    throw new Stage1Abort(`--chunk-count precisa ser um inteiro >= 2 — recebido: "${chunkCountRaw}"`);
  }

  const opts: Stage1RunOptions = {
    phase: phaseRaw as Phase,
    edition,
    anchorIso: getStringArg(argv, "anchor-iso", { example: "2026-04-23" }),
    cutoffIso: getStringArg(argv, "cutoff-iso", { example: "2026-04-19" }),
    windowDays,
    nowIso: getStringArg(argv, "now", { example: "2026-04-23T08:00:00Z" }),
    agentResearchResults: getStringArg(argv, "agent-research-results", { example: "path.json" }),
    chunkCount,
    selectionJson: getStringArg(argv, "selection-json", { example: "path.json" }),
    fallbackScoredJson: getStringArg(argv, "fallback-scored-json", { example: "path.json" }),
    md: getStringArg(argv, "md", { example: "path.md" }),
    auto: hasFlag(argv, "auto"),
    startedAtIso: getStringArg(argv, "started-at", { example: "2026-04-23T08:00:00Z" }),
  };

  if (opts.phase === "post-score" && opts.chunkCount === undefined) {
    throw new Stage1Abort("--phase post-score exige --chunk-count N (>= 2) — pool pequeno usa o caminho fallback, que pula esta fase.");
  }
  if (opts.phase === "post-select-render") {
    if (!opts.selectionJson && !opts.fallbackScoredJson) {
      throw new Stage1Abort("--phase post-select-render exige --selection-json OU --fallback-scored-json.");
    }
    if (opts.selectionJson && opts.fallbackScoredJson) {
      throw new Stage1Abort("--phase post-select-render aceita SÓ um de --selection-json / --fallback-scored-json, não os dois.");
    }
  }
  if (opts.phase === "post-gate") {
    if (!opts.md && !opts.auto) {
      throw new Stage1Abort("--phase post-gate exige --md <path> OU --auto.");
    }
    if (opts.md && opts.auto) {
      throw new Stage1Abort("--phase post-gate aceita SÓ um de --md / --auto, não os dois.");
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Resolver EDITION_DIR (idempotente, mesma chamada de Stage 0/3).
// ---------------------------------------------------------------------------

function resolveEditionDir(deps: Stage1RunDeps, edition: string): string {
  const r = deps.exec("scripts/lib/find-current-edition.ts", ["--resolve", edition]);
  const editionDir = r.stdout.trim();
  if (r.code !== 0 || !editionDir) {
    throw new Stage1Abort(`❌ find-current-edition.ts --resolve não devolveu um path (exit ${r.code}): ${tailStderr(r.stderr)}`);
  }
  return editionDir;
}

function internalPath(editionDir: string, file: string): string {
  return `${editionDir}/_internal/${file}`;
}

// ---------------------------------------------------------------------------
// FASE 1 — pre-research
// ---------------------------------------------------------------------------

async function runPreResearch(deps: Stage1RunDeps, opts: Stage1RunOptions, report: ReportBuilder): Promise<Stage1RunResult> {
  const editionDir = resolveEditionDir(deps, opts.edition);
  deps.mkdirSync(resolve(deps.rootDir, editionDir, "_internal"));

  const now = opts.nowIso ? new Date(opts.nowIso) : deps.now();
  if (Number.isNaN(now.getTime())) throw new Stage1Abort(`❌ --now inválido: "${opts.nowIso}"`);
  const anchorIso = opts.anchorIso ?? isoDateOnly(now);
  const windowDays = opts.windowDays ?? defaultWindowDays(now);
  const cutoffIso = opts.cutoffIso ?? subtractDaysIso(anchorIso, windowDays);

  logEvent(deps, opts.edition, "info", "etapa 1 pesquisa started");

  // --- §1a inbox-drain (fail-soft — todos os `skipped` reasons só logam warn) ---
  const drain = softStep(deps, report, "inbox-drain (1a)", "scripts/inbox-drain.ts", []);
  const drainJson = drain.json as { new_entries?: number; skipped?: boolean; reason?: string; errors?: number } | undefined;
  if (drainJson?.skipped) {
    report.note(`⚠️  inbox-drain skipped: ${drainJson.reason ?? "motivo desconhecido"} — prosseguindo sem inbox fresco.`);
    logEvent(deps, opts.edition, "warn", "inbox_drain_skipped", { details: drainJson });
  } else if ((drainJson?.errors ?? 0) > 0) {
    logEvent(deps, opts.edition, "warn", "inbox_drain_partial_errors", { details: drainJson });
  }

  // --- §1c poll stats da edição anterior (fail-soft) ---
  const pastRawPath = resolve(deps.rootDir, "data", "past-editions-raw.json");
  let prevEdition: string | null = null;
  if (deps.existsSync(pastRawPath)) {
    try {
      prevEdition = computePrevEditionFromPastRaw(deps.readFile(pastRawPath));
    } catch {
      prevEdition = null;
    }
  }
  if (prevEdition) {
    softStep(deps, report, "fetch-poll-stats (1c)", "scripts/fetch-poll-stats.ts", ["--edition", prevEdition, "--out", internalPath(editionDir, "04-eia-poll-stats.json")]);
  } else {
    report.note("↷ 1c: sem edição anterior detectável — pulando fetch-poll-stats.");
  }

  // --- §1d dispatch É IA? em background (spawn detached, não Bash(run_in_background)) ---
  const eiaMdPath = resolve(deps.rootDir, editionDir, "01-eia.md");
  if (deps.existsSync(eiaMdPath)) {
    report.note("↷ 1d: 01-eia.md já existe (resume) — não redispatchando eia-compose.");
    logEvent(deps, opts.edition, "info", "eia dispatch skipped: already_exists (resume)");
  } else {
    deps.spawnDetached("scripts/eia-compose.ts", ["--edition", opts.edition, "--out-dir", `${editionDir}/`]);
    const dispatchedAt = now.toISOString();
    deps.exec("scripts/lib/eia-dispatch-state.ts", ["--edition-dir", editionDir, "--bash-id", "stage-1-run:detached", "--dispatched-at", dispatchedAt]);
    logEvent(deps, opts.edition, "info", "eia dispatched (background bash)");
    report.note("▶ 1d: eia-compose.ts dispatchado em background (detached).");
  }

  // --- §1e RSS batch ---
  step(deps, report, "list-active-sources --rss-only (1e)", "scripts/list-active-sources.ts", ["--format", "json", "--rss-only", "--out", internalPath(editionDir, "rss-batch.json")]);
  const rssBatch = step(deps, report, "fetch-rss-batch (1e)", "scripts/fetch-rss-batch.ts", [
    "--sources",
    internalPath(editionDir, "rss-batch.json"),
    "--out",
    internalPath(editionDir, "researcher-results.json"),
    "--days",
    String(windowDays),
  ]);
  report.note(`ℹ️  1e RSS batch concluído.`);
  void rssBatch;

  // --- §1e-bis prewarm cache (background, fail-soft, fire-and-forget) ---
  deps.spawnDetached("scripts/prewarm-verify-cache.ts", ["--edition-dir", `${editionDir}/`]);
  report.note("▶ 1e-bis: prewarm-verify-cache.ts dispatchado em background (detached).");

  // --- §1e.5 inbox topics ---
  step(deps, report, "extract-inbox-topics (1e.5)", "scripts/extract-inbox-topics.ts", ["--inbox-md", "data/inbox.md", "--out", internalPath(editionDir, "inbox-topics.json")]);

  // --- §1f Path A/B ---
  const pendingAgentDispatch: PendingAgentDispatch[] = [];
  let researchPathA = false;
  const websearchBackendOverride = deps.hasEnv("WEBSEARCH_BACKEND") === "agents";
  if (websearchBackendOverride) {
    logEvent(deps, opts.edition, "warn", "websearch_path: B (WEBSEARCH_BACKEND=agents)", { details: { path: "B", reason: "WEBSEARCH_BACKEND_agents" } });
    report.note("↷ 1f: WEBSEARCH_BACKEND=agents — indo direto pro Path B (override manual).");
  } else {
    step(deps, report, "list-active-sources --websearch-only (1f)", "scripts/list-active-sources.ts", [
      "--format",
      "json",
      "--websearch-only",
      "--out",
      internalPath(editionDir, "websearch-batch.json"),
    ]);
    const pathAResult = deps.exec("scripts/fetch-websearch-batch.ts", [
      "--sources",
      internalPath(editionDir, "websearch-batch.json"),
      "--discovery",
      internalPath(editionDir, "inbox-topics.json"),
      "--cutoff-iso",
      cutoffIso,
      "--window-days",
      String(windowDays),
      "--edition",
      opts.edition,
      "--out",
      internalPath(editionDir, "websearch-results.json"),
    ]);
    if (pathAResult.stderr.trim()) console.error(pathAResult.stderr.trim());
    if (pathAResult.code === 0) {
      researchPathA = true;
      logEvent(deps, opts.edition, "info", "websearch_path: A (brave_key_present)", { details: { path: "A", reason: "brave_key_present" } });
      const wsResultsPath = resolve(deps.rootDir, internalPath(editionDir, "websearch-results.json"));
      const rrPath = resolve(deps.rootDir, internalPath(editionDir, "researcher-results.json"));
      try {
        const wsResults = JSON.parse(deps.readFile(wsResultsPath));
        const existing = deps.existsSync(rrPath) ? JSON.parse(deps.readFile(rrPath)) : [];
        deps.writeFile(rrPath, JSON.stringify(mergeJsonArrays(existing, wsResults), null, 2) + "\n");
      } catch (e) {
        report.note(`⚠️  1f: falha ao mergear websearch-results.json em researcher-results.json: ${(e as Error).message}`);
      }
      report.note("✅ 1f Path A (Brave determinístico) rodou com sucesso — sem Agent dispatch necessário.");
    } else if (pathAResult.code === 3) {
      logEvent(deps, opts.edition, "warn", "websearch_path: B (brave_key_missing)", { details: { path: "B", reason: "brave_key_missing" } });
      report.note("↷ 1f: BRAVE_API_KEY ausente (exit 3) — caindo pro Path B (agents).");
    } else {
      throw new Stage1Abort(`❌ fetch-websearch-batch.ts erro inesperado (exit ${pathAResult.code}): ${tailStderr(pathAResult.stderr)}`);
    }
  }

  if (!researchPathA) {
    // Pre-flight determinístico do Path B: blocklist + queries com pool fixo.
    step(deps, report, "list-active-sources --format json (1f Path B)", "scripts/list-active-sources.ts", ["--format", "json", "--out", internalPath(editionDir, "all-sources.json")]);
    const blocklistResult = step(deps, report, "check-source-blocklist (1f Path B)", "scripts/check-source-blocklist.ts", [
      "--in",
      internalPath(editionDir, "all-sources.json"),
      "--out",
      internalPath(editionDir, "sources-kept-skipped.json"),
    ]);
    // #5891: mesmo contrato do dedup — check-source-blocklist.ts com `--out`
    // escreve só o arquivo. Ler o arquivo; stdout é fallback.
    const blocklistJson = readOutFileJson<{ kept?: unknown[]; skipped?: unknown[] }>(
      deps,
      resolve(deps.rootDir, internalPath(editionDir, "sources-kept-skipped.json")),
    ) ?? (blocklistResult.json as { kept?: unknown[]; skipped?: unknown[] } | undefined);

    let inboxTopics: string[] = [];
    try {
      const raw = deps.readFile(resolve(deps.rootDir, internalPath(editionDir, "inbox-topics.json")));
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) inboxTopics = parsed.filter((t): t is string => typeof t === "string");
    } catch {
      inboxTopics = [];
    }

    const editionNum = Number(opts.edition);
    const howToQueries = getHowToDiscoveryQueries(editionNum, 2);
    const negativeImpactQueries = getNegativeImpactDiscoveryQueries(editionNum, 1);
    const manifest = {
      sourcesKept: blocklistJson?.kept ?? [],
      sourcesSkipped: blocklistJson?.skipped ?? [],
      discoveryQueriesDeterministic: [...howToQueries, ...negativeImpactQueries, ...inboxTopics],
      note: "Além destas, o orchestrator deve compor ~5 queries PT + ~5 EN temáticas genéricas (julgamento, sem pool fixo — ver delegatedSteps).",
    };
    const manifestPath = internalPath(editionDir, "stage-1-path-b-manifest.json");
    deps.writeFile(resolve(deps.rootDir, manifestPath), JSON.stringify(manifest, null, 2) + "\n");
    pendingAgentDispatch.push({
      step: "1f-path-b",
      agent: "source-researcher + discovery-searcher",
      detail: `Path A indisponível — dispatchar 1× source-researcher por item de sourcesKept (${manifest.sourcesKept.length}) + 1× discovery-searcher por query de discoveryQueriesDeterministic (${manifest.discoveryQueriesDeterministic.length}) + as queries temáticas PT/EN que o orchestrator compuser. Agregar tudo em RunRecord[] e re-invocar --phase post-research-pre-score --agent-research-results <path>.`,
      manifestPath,
    });
  }

  return baseResult("pre-research", 0, report, {
    editionDir,
    anchorIso,
    cutoffIso,
    windowDays,
    researchPathA,
    pendingAgentDispatch,
  });
}

// ---------------------------------------------------------------------------
// FASE 2 — post-research-pre-score
// ---------------------------------------------------------------------------

async function runPostResearchPreScore(deps: Stage1RunDeps, opts: Stage1RunOptions, report: ReportBuilder): Promise<Stage1RunResult> {
  const editionDir = resolveEditionDir(deps, opts.edition);
  const editionIso = editionIsoFromAammdd(opts.edition);
  const now = opts.nowIso ? new Date(opts.nowIso) : deps.now();
  const anchorIso = opts.anchorIso ?? isoDateOnly(now);
  const windowDays = opts.windowDays ?? defaultWindowDays(now);
  const cutoffIso = opts.cutoffIso ?? subtractDaysIso(anchorIso, windowDays);

  const rrPath = resolve(deps.rootDir, internalPath(editionDir, "researcher-results.json"));

  // --- merge dos resultados de Agent dispatch (Path B), se fornecidos ---
  if (opts.agentResearchResults) {
    let agentResults: unknown;
    try {
      agentResults = JSON.parse(deps.readFile(resolve(deps.rootDir, opts.agentResearchResults)));
    } catch (e) {
      throw new Stage1Abort(`❌ --agent-research-results ilegível (${opts.agentResearchResults}): ${(e as Error).message}`);
    }
    const existing = deps.existsSync(rrPath) ? JSON.parse(deps.readFile(rrPath)) : [];
    deps.writeFile(rrPath, JSON.stringify(mergeJsonArrays(existing, agentResults), null, 2) + "\n");
    report.note(`✅ merged --agent-research-results em researcher-results.json.`);
  }

  // --- §1g record-source-runs ---
  const recordRuns = step(deps, report, "record-source-runs (1g)", "scripts/record-source-runs.ts", ["--runs", internalPath(editionDir, "researcher-results.json"), "--edition", opts.edition]);
  const recordRunsJson = recordRuns.json as { summary?: { sources_with_consecutive_failures_ge3?: unknown[] } } | undefined;

  // --- §1g-ter assemble pool ---
  step(deps, report, "assemble-research-pool (1g-ter)", "scripts/assemble-research-pool.ts", ["--runs", internalPath(editionDir, "researcher-results.json"), "--out", internalPath(editionDir, "tmp-articles-raw.json")]);

  // --- §1g-bis carry-over (fail-soft — prev:null é caminho legítimo) ---
  softStep(deps, report, "load-carry-over (1g-bis)", "scripts/load-carry-over.ts", [
    "--edition-dir",
    editionDir,
    "--pool",
    internalPath(editionDir, "tmp-articles-raw.json"),
    "--window-start",
    cutoffIso,
    "--window-end",
    anchorIso,
    "--score-min",
    "60",
  ]);

  // --- §1h inject inbox urls (mandatório, --validate-pool endurece) ---
  step(deps, report, "inject-inbox-urls (1h)", "scripts/inject-inbox-urls.ts", [
    "--inbox-md",
    "data/inbox.md",
    "--captured-articles",
    internalPath(editionDir, "captured-newsletter-articles.json"),
    "--pool",
    internalPath(editionDir, "tmp-articles-raw.json"),
    "--out",
    internalPath(editionDir, "tmp-articles-raw.json"),
    "--validate-pool",
  ]);

  // --- §1h.6 validador externo anti-skip ---
  const injValidate = deps.exec("scripts/validate-stage-1-injection.ts", ["--edition-dir", editionDir, "--inbox-md", "data/inbox.md"]);
  if (injValidate.code === 1) {
    throw new Stage1Abort(`❌ validate-stage-1-injection.ts detectou skip do §1h — re-executar antes de prosseguir: ${tailStderr(injValidate.stderr)}`);
  }
  if (injValidate.code === 2) {
    throw new Stage1Abort(`❌ validate-stage-1-injection.ts erro de leitura (exit 2): ${tailStderr(injValidate.stderr)}`);
  }

  // --- §1h.7 marker check determinístico ---
  const markerResult = deps.exec("scripts/pipeline-sentinel.ts", ["assert-marker", "--edition", opts.edition, "--name", "inject-inbox-urls"]);
  if (markerResult.code !== 0) {
    const reason = "marker inject-inbox-urls ausente — §1h foi skipado inteiro.";
    const action = "re-executar §1h (inject-inbox-urls.ts) antes de prosseguir.";
    const banner = deps.exec("scripts/render-halt-banner.ts", ["--stage", "1 — Pesquisa", "--reason", reason, "--action", action]);
    report.note(banner.stdout.trim() || `HALT: ${reason}`);
    return baseResult("post-research-pre-score", 2, report, { editionDir, haltRequired: { stage: "1 — Pesquisa", reason, action } });
  }

  // --- §1i verify-accessibility + anotação/remoção in-JS ---
  let poolArticles: PoolArticle[] = [];
  try {
    poolArticles = JSON.parse(deps.readFile(resolve(deps.rootDir, internalPath(editionDir, "tmp-articles-raw.json"))));
  } catch (e) {
    throw new Stage1Abort(`❌ tmp-articles-raw.json ilegível pós-1h: ${(e as Error).message}`);
  }
  const urlsAllPath = resolve(deps.rootDir, internalPath(editionDir, "tmp-urls-all.json"));
  deps.writeFile(urlsAllPath, JSON.stringify(Array.from(new Set(poolArticles.map((a) => a.url))), null, 2) + "\n");
  step(deps, report, "verify-accessibility (1i)", "scripts/verify-accessibility.ts", [
    internalPath(editionDir, "tmp-urls-all.json"),
    internalPath(editionDir, "link-verify-all.json"),
    "--bodies-dir",
    internalPath(editionDir, "_forensic/link-verify-bodies"),
    "--cache",
    "data/link-verify-cache.json",
    "--browser-concurrency",
    "8",
  ]);
  let verifyResults: LinkVerifyResult[] = [];
  try {
    verifyResults = JSON.parse(deps.readFile(resolve(deps.rootDir, internalPath(editionDir, "link-verify-all.json"))));
  } catch (e) {
    throw new Stage1Abort(`❌ link-verify-all.json ilegível pós-1i: ${(e as Error).message}`);
  }
  const postVerify = applyLinkVerifyAnnotations(poolArticles, verifyResults);
  deps.writeFile(resolve(deps.rootDir, internalPath(editionDir, "tmp-articles-post-verify.json")), JSON.stringify(postVerify, null, 2) + "\n");
  report.note(`✅ 1i: ${poolArticles.length} → ${postVerify.length} artigo(s) pós link-verify.`);

  // --- §1j expand aggregators do inbox ---
  step(deps, report, "expand-inbox-aggregators (1j)", "scripts/expand-inbox-aggregators.ts", [
    "--articles",
    internalPath(editionDir, "tmp-articles-post-verify.json"),
    "--verify",
    internalPath(editionDir, "link-verify-all.json"),
    "--out",
    internalPath(editionDir, "tmp-articles-expanded.json"),
  ]);

  // --- §1k enrich inbox (mutação in-place) ---
  step(deps, report, "enrich-inbox-articles (1k)", "scripts/enrich-inbox-articles.ts", [
    "--in",
    internalPath(editionDir, "tmp-articles-expanded.json"),
    "--bodies-dir",
    internalPath(editionDir, "_forensic/link-verify-bodies"),
  ]);

  // --- §1l dedup ---
  const dedupResult = step(deps, report, "dedup (1l)", "scripts/dedup.ts", [
    "--articles",
    internalPath(editionDir, "tmp-articles-expanded.json"),
    "--past-editions",
    "data/past-editions.md",
    "--window",
    String(windowDays),
    "--out",
    internalPath(editionDir, "tmp-dedup-output.json"),
  ]);
  // #5891 (validação ao vivo 260821): dedup.ts com `--out` escreve o JSON só
  // no arquivo — stdout fica vazio. Ler o arquivo; stdout é fallback.
  const dedupJson = readOutFileJson<{ kept?: unknown[]; editorSubmittedLost?: unknown[] }>(
    deps,
    resolve(deps.rootDir, internalPath(editionDir, "tmp-dedup-output.json")),
  ) ?? (dedupResult.json as { kept?: unknown[]; editorSubmittedLost?: unknown[] } | undefined);
  deps.writeFile(resolve(deps.rootDir, internalPath(editionDir, "tmp-kept.json")), JSON.stringify(dedupJson?.kept ?? [], null, 2) + "\n");
  if ((dedupJson?.editorSubmittedLost?.length ?? 0) > 0) {
    report.note(`⚠️  1l: ${dedupJson!.editorSubmittedLost!.length} submissão(ões) do editor removida(s) pelo dedup — ver editorSubmittedLost no gate.`);
  }

  // --- §1m categorize + enrich-primary-source + integrity checkpoint ---
  step(deps, report, "categorize (1m)", "scripts/categorize.ts", ["--articles", internalPath(editionDir, "tmp-kept.json"), "--out", internalPath(editionDir, "tmp-categorized.json")]);
  softStep(deps, report, "enrich-primary-source (1m)", "scripts/enrich-primary-source.ts", ["--in", internalPath(editionDir, "tmp-categorized.json")]);
  const integrity1 = deps.exec("scripts/verify-summary-integrity.ts", [
    "--raw",
    internalPath(editionDir, "tmp-articles-raw.json"),
    "--check",
    internalPath(editionDir, "tmp-categorized.json"),
    "--edition",
    opts.edition,
    "--label",
    "tmp-categorized.json",
  ]);
  if (integrity1.code === 1) {
    throw new Stage1Abort(`❌ verify-summary-integrity.ts (tmp-categorized.json) detectou regressão de pipeline (#4986/#4988): ${tailStderr(integrity1.stderr)}`);
  }

  // --- §1m-ter/§1m-quinquies SKIPPED (delegado, ver DELEGATED_STEPS) ---

  // --- §1m-quater dedup pós-promoção (idempotente — checked:0 sem 1m-ter) ---
  softStep(deps, report, "check-promoted-dedup (1m-quater)", "scripts/check-promoted-dedup.ts", [
    "--categorized",
    internalPath(editionDir, "tmp-categorized.json"),
    "--past-editions",
    "data/past-editions.md",
    "--window",
    "3",
  ]);

  // --- instrumentação silenciosa type_hint (opcional) ---
  softStep(deps, report, "measure-type-hint-divergence (instrumentação)", "scripts/measure-type-hint-divergence.ts", ["--in", internalPath(editionDir, "tmp-categorized.json"), "--edition", opts.edition]);

  // --- §1n topic-cluster ---
  step(deps, report, "topic-cluster (1n)", "scripts/topic-cluster.ts", ["--in", internalPath(editionDir, "tmp-categorized.json"), "--out", internalPath(editionDir, "tmp-clustered.json")]);

  // --- §1o filter-date-window ---
  step(deps, report, "filter-date-window (1o)", "scripts/filter-date-window.ts", [
    "--articles",
    internalPath(editionDir, "tmp-clustered.json"),
    "--anchor-date",
    anchorIso,
    "--edition-date",
    editionIso,
    "--window-days",
    String(windowDays),
    "--out",
    internalPath(editionDir, "tmp-filtered.json"),
  ]);

  // --- §1p1 research-review-dates ---
  step(deps, report, "research-review-dates (1p1)", "scripts/research-review-dates.ts", [
    "--in",
    internalPath(editionDir, "tmp-filtered.json"),
    "--out",
    internalPath(editionDir, "tmp-dates-reviewed.json"),
    "--edition-dir",
    `${editionDir}/`,
    "--anchor-iso",
    anchorIso,
    "--edition-iso",
    editionIso,
    "--window-days",
    String(windowDays),
    "--bodies-dir",
    internalPath(editionDir, "_forensic/link-verify-bodies"),
    "--verify-cache",
    "data/link-verify-cache.json",
    "--link-verify-json",
    internalPath(editionDir, "link-verify-all.json"),
  ]);

  // --- §1q.1 split-articles-for-scoring ---
  const splitResult = step(deps, report, "split-articles-for-scoring (1q.1)", "scripts/split-articles-for-scoring.ts", [
    "--categorized",
    internalPath(editionDir, "tmp-dates-reviewed.json"),
    "--out-dir",
    internalPath(editionDir, "scoring-chunks"),
    "--chunk-size",
    "30",
    "--pool-out",
    internalPath(editionDir, "tmp-scoring-pool.json"),
  ]);
  const splitJson = splitResult.json as { chunk_count?: number; chunk_files?: string[] } | undefined;
  const chunkCount = splitJson?.chunk_count ?? 0;

  const pendingAgentDispatch: PendingAgentDispatch[] = [];
  const needsScorerFallback = chunkCount <= 1;
  if (needsScorerFallback) {
    pendingAgentDispatch.push({
      step: "1q-fallback",
      agent: "scorer",
      detail: "Pool pequeno (chunk_count <= 1) — dispatchar 1× scorer (Sonnet) sobre tmp-scoring-pool.json, out_path tmp-scored.json. Re-invocar --phase post-select-render --fallback-scored-json <path>.",
      manifestPath: internalPath(editionDir, "tmp-scoring-pool.json"),
    });
  } else {
    pendingAgentDispatch.push({
      step: "1q.2",
      agent: "scorer-chunk",
      detail: `Dispatchar ${chunkCount}× scorer-chunk EM PARALELO — input scoring-chunks/scoring-chunk-{i}.json, out_path scoring-chunks/scored-chunk-{i}.json (i de 0 a ${chunkCount - 1}). Depois re-invocar --phase post-score --chunk-count ${chunkCount}.`,
      manifestPath: internalPath(editionDir, "scoring-chunks"),
    });
  }

  return baseResult("post-research-pre-score", 0, report, {
    editionDir,
    editionIso,
    anchorIso,
    cutoffIso,
    windowDays,
    chunkCount,
    needsScorerFallback,
    pendingAgentDispatch,
    sourcesWithConsecutiveFailures: recordRunsJson?.summary?.sources_with_consecutive_failures_ge3 ?? [],
  });
}

// ---------------------------------------------------------------------------
// FASE 3 — post-score (merge dos chunks + pede scorer-select)
// ---------------------------------------------------------------------------

async function runPostScore(deps: Stage1RunDeps, opts: Stage1RunOptions, report: ReportBuilder): Promise<Stage1RunResult> {
  const editionDir = resolveEditionDir(deps, opts.edition);
  const chunkCount = opts.chunkCount as number;

  const scoredChunkPaths: string[] = [];
  for (let i = 0; i < chunkCount; i++) {
    scoredChunkPaths.push(internalPath(editionDir, `scoring-chunks/scored-chunk-${i}.json`));
  }

  const mergeResult = deps.exec("scripts/merge-scored-chunks.ts", [
    "--categorized",
    internalPath(editionDir, "tmp-scoring-pool.json"),
    "--chunk-scores",
    scoredChunkPaths.join(","),
    "--allscored-out",
    internalPath(editionDir, "tmp-allscored.json"),
    "--finalists-out",
    internalPath(editionDir, "tmp-finalists.json"),
    "--top",
    "15",
  ]);
  if (mergeResult.stderr.trim()) console.error(mergeResult.stderr.trim());
  const mergeParsed = parseStepJson<{ catastrophic?: boolean; incomplete?: boolean; failed_chunks?: unknown[] }>(mergeResult.stdout);

  if (mergeResult.code === 2) {
    logEvent(deps, opts.edition, "error", "merge_scored_chunks_catastrophic", { details: mergeParsed });
    report.note(`❌ merge-scored-chunks CATASTRÓFICO (#1669) — failed_chunks: ${JSON.stringify(mergeParsed?.failed_chunks ?? [])}.`);
    report.note("   NÃO seguir com o resultado degradado. Opções: (a) retry o(s) scorer-chunk ausente(s)/inválido(s) e re-chamar esta fase; (b) cair no 1q-fallback (scorer single-call sobre tmp-scoring-pool.json).");
    return baseResult("post-score", 1, report, { editionDir, mergeCatastrophic: true, failedChunks: mergeParsed?.failed_chunks ?? [] });
  }
  if (mergeResult.code === 1) {
    throw new Stage1Abort(`❌ merge-scored-chunks.ts erro de invocação (exit 1) — HALT, não consumir tmp-finalists.json/tmp-allscored.json (podem estar stale): ${tailStderr(mergeResult.stderr)}`);
  }
  if (mergeResult.code !== 0) {
    throw new Stage1Abort(`❌ merge-scored-chunks.ts erro inesperado (exit ${mergeResult.code}): ${tailStderr(mergeResult.stderr)}`);
  }
  if (mergeParsed?.incomplete) {
    report.note("⚠️  merge-scored-chunks: incomplete=true (gap <= 2 artigos) — seguindo, artigos sem score viram 0 e são filtrados em 1s.");
    logEvent(deps, opts.edition, "warn", "merge_scored_chunks_incomplete", { details: mergeParsed });
  }

  const integrity = deps.exec("scripts/verify-summary-integrity.ts", [
    "--raw",
    internalPath(editionDir, "tmp-articles-raw.json"),
    "--check",
    internalPath(editionDir, "tmp-finalists.json"),
    "--edition",
    opts.edition,
    "--label",
    "tmp-finalists.json",
  ]);
  if (integrity.code === 1) {
    throw new Stage1Abort(`❌ verify-summary-integrity.ts (tmp-finalists.json) detectou regressão (#4986): ${tailStderr(integrity.stderr)}`);
  }

  return baseResult("post-score", 0, report, {
    editionDir,
    pendingAgentDispatch: [
      {
        step: "1q.4",
        agent: "scorer-select",
        detail: "Dispatchar 1× scorer-select — input tmp-finalists.json, out_path tmp-selection.json. Depois re-invocar --phase post-select-render --selection-json <path>.",
        manifestPath: internalPath(editionDir, "tmp-finalists.json"),
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// FASE 4 — post-select-render
// ---------------------------------------------------------------------------

async function runPostSelectRender(deps: Stage1RunDeps, opts: Stage1RunOptions, report: ReportBuilder): Promise<Stage1RunResult> {
  const editionDir = resolveEditionDir(deps, opts.edition);
  const scoredPath = internalPath(editionDir, "tmp-scored.json");

  if (opts.selectionJson) {
    step(deps, report, "assemble-scored (1q.5)", "scripts/assemble-scored.ts", [
      "--selection",
      opts.selectionJson,
      "--allscored",
      internalPath(editionDir, "tmp-allscored.json"),
      "--finalists",
      internalPath(editionDir, "tmp-finalists.json"),
      "--out",
      scoredPath,
    ]);
  } else {
    // fallback: scorer single-call já escreveu tmp-scored.json (mesmo path
    // canônico esperado, per playbook "out_path: tmp-scored.json") — se o
    // caller passou um path diferente, copiar pro canônico.
    const fallbackAbs = resolve(deps.rootDir, opts.fallbackScoredJson as string);
    const canonicalAbs = resolve(deps.rootDir, scoredPath);
    if (fallbackAbs !== canonicalAbs) {
      deps.writeFile(canonicalAbs, deps.readFile(fallbackAbs));
    }
    report.note("ℹ️  1q-fallback: usando tmp-scored.json do scorer single-call.");
  }

  // --- §1r promoção de runners_up até 6 (in-JS) ---
  let scored: { highlights?: ScoredHighlight[]; runners_up?: ScoredHighlight[] } = {};
  try {
    scored = JSON.parse(deps.readFile(resolve(deps.rootDir, scoredPath)));
  } catch (e) {
    throw new Stage1Abort(`❌ tmp-scored.json ilegível: ${(e as Error).message}`);
  }
  const promotion = promoteRunnersUpToSix(scored);
  if (promotion.promoted > 0) {
    report.note(`⚠️  1r: scorer produziu ${(scored.highlights ?? []).length} highlight(s); promovi ${promotion.promoted} runner(s)-up pra chegar a 6.`);
    logEvent(deps, opts.edition, "warn", "highlights_promoted_from_runners_up", { details: { promoted: promotion.promoted } });
    deps.writeFile(resolve(deps.rootDir, scoredPath), JSON.stringify({ ...scored, highlights: promotion.highlights, runners_up: promotion.runnersUp }, null, 2) + "\n");
  }

  // --- §1s finalize-stage1 ---
  step(deps, report, "finalize-stage1 (1s)", "scripts/finalize-stage1.ts", [
    "--scored",
    scoredPath,
    "--categorized",
    internalPath(editionDir, "tmp-dates-reviewed.json"),
    "--out",
    internalPath(editionDir, "tmp-finalized.json"),
    "--edition",
    opts.edition,
  ]);

  // --- §1t avisos de mínimo por seção (in-JS) ---
  let finalized: FinalizedBuckets & { highlights?: unknown[]; runners_up?: unknown[]; clusters?: unknown[] } = {};
  try {
    finalized = JSON.parse(deps.readFile(resolve(deps.rootDir, internalPath(editionDir, "tmp-finalized.json"))));
  } catch (e) {
    throw new Stage1Abort(`❌ tmp-finalized.json ilegível: ${(e as Error).message}`);
  }
  // #5952-bug (achado ao vivo 260824): finalize-stage1.ts só escreve os 4 buckets
  // (lancamento/radar/use_melhor/video) em tmp-finalized.json — por design, seu
  // próprio docstring diz que highlights/runners_up bypassam o join de score e o
  // domain cap, então o script nunca precisou tocá-los. Sem este merge, `finalized`
  // nunca carrega highlights/runners_up e toda edição sai com 0 destaques. `scored`
  // (lido acima, já com a promoção §1r aplicada) é a fonte de verdade — só cai pro
  // fallback `?? []` se `finalized` já vier populado (mocks/testes existentes).
  finalized.highlights = finalized.highlights ?? scored.highlights ?? [];
  finalized.runners_up = finalized.runners_up ?? scored.runners_up ?? [];
  const minSectionWarnings = computeMinSectionWarnings(finalized);

  // --- §1u shape final + strip verifier ---
  const categorizedPath = internalPath(editionDir, "01-categorized.json");
  const finalCategorized = assembleFinalCategorized(finalized);
  deps.writeFile(resolve(deps.rootDir, categorizedPath), JSON.stringify(finalCategorized, null, 2) + "\n");

  // --- §1u-bis dedup intra-edição ---
  step(deps, report, "dedup-intra-edition (1u-bis)", "scripts/dedup-intra-edition.ts", ["--in", categorizedPath, "--out", categorizedPath]);

  // --- §1u-ter dedup evergreen ---
  step(deps, report, "dedup-evergreen-buckets (1u-ter)", "scripts/dedup-evergreen-buckets.ts", ["--in", categorizedPath, "--out", categorizedPath, "--past-editions", "data/past-editions.md"]);

  // --- §1v renderizar MD ---
  const mdPath = `${editionDir}/01-categorized.md`;
  step(deps, report, "render-categorized-md (1v)", "scripts/render-categorized-md.ts", ["--in", categorizedPath, "--out", mdPath, "--edition", opts.edition, "--source-health", "data/source-health.json"]);

  // --- lints warn-only (1v-bis..1v-quinquies) ---
  const lancamentosResult = deps.exec("scripts/validate-lancamentos.ts", [mdPath]);
  const lancamentosWarnings: string[] = lancamentosResult.code !== 0 ? [`validate-lancamentos: URLs não-oficiais em LANÇAMENTOS (ver stdout/stderr do lint)`] : [];
  softStep(deps, report, "review-use-melhor (1v-ter)", "scripts/review-use-melhor.ts", ["--approved", categorizedPath]);
  softStep(deps, report, "review-highlight-source (1v-quater)", "scripts/review-highlight-source.ts", ["--approved", categorizedPath]);
  softStep(deps, report, "review-highlight-official-swap (1v-quinquies)", "scripts/review-highlight-official-swap.ts", ["--categorized", categorizedPath]);

  // --- §1w-quint anti-skip 1f (BLOQUEIA) ---
  const completeness = deps.exec("scripts/validate-stage-1-completeness.ts", ["--edition-dir", `${editionDir}/`]);
  if (completeness.code === 1) {
    const reason = "validate-stage-1-completeness.ts: §1f foi skipado silenciosamente (researcher-results.json só tem RSS, sem source-researcher/discovery).";
    const action = "re-executar §1f (fase pre-research) antes de prosseguir pro gate.";
    const banner = deps.exec("scripts/render-halt-banner.ts", ["--stage", "1 — Pesquisa", "--reason", reason, "--action", action]);
    report.note(banner.stdout.trim() || `HALT: ${reason}`);
    return baseResult("post-select-render", 2, report, { editionDir, categorizedPath, mdPath, haltRequired: { stage: "1 — Pesquisa", reason, action } });
  }

  // --- §1w-bis validate-stage-1-output ---
  const validateOutput = deps.exec("scripts/validate-stage-1-output.ts", ["--edition", opts.edition, "--edition-dir", `${editionDir}/`]);
  const validateOutputJson = parseStepJson(validateOutput.stdout);
  if (validateOutput.code === 2) {
    const reason = "validate-stage-1-output.ts: blocker(s) detectado(s) — ver assertions[].message no JSON.";
    const action = "corrigir os blockers e retentar --phase post-select-render, ou 'abort'.";
    const banner = deps.exec("scripts/render-halt-banner.ts", ["--stage", "1 — Pesquisa", "--reason", reason, "--action", action]);
    report.note(banner.stdout.trim() || `HALT: ${reason}`);
    return baseResult("post-select-render", 2, report, { editionDir, categorizedPath, mdPath, validateOutput: validateOutputJson, haltRequired: { stage: "1 — Pesquisa", reason, action } });
  }
  if (validateOutput.code === 3) {
    throw new Stage1Abort(`❌ validate-stage-1-output.ts erro de uso (exit 3): ${tailStderr(validateOutput.stderr)}`);
  }
  if (validateOutput.code === 1) {
    report.note("⚠️  validate-stage-1-output: warning(s) — apresentar banner no gate (ver validateOutput.assertions).");
  }

  // --- §1w-quat check-invariants (pre-gate, categorized-has-eia-section, BLOQUEIA) ---
  const invariants = deps.exec("scripts/check-invariants.ts", ["--stage", "1", "--rule", "categorized-has-eia-section", "--edition-dir", `${editionDir}/`]);
  if (invariants.code === 1) {
    const reason = "check-invariants --stage 1 --rule categorized-has-eia-section: 01-categorized.md sem seção '## É IA?'.";
    const action = "confirmar que §1d (eia dispatch) rodou e re-renderizar o MD antes do gate.";
    const banner = deps.exec("scripts/render-halt-banner.ts", ["--stage", "1 — Pesquisa", "--reason", reason, "--action", action]);
    report.note(banner.stdout.trim() || `HALT: ${reason}`);
    return baseResult("post-select-render", 2, report, { editionDir, categorizedPath, mdPath, haltRequired: { stage: "1 — Pesquisa", reason, action } });
  }

  // --- §1w-ter payload sizes (informativo) ---
  softStep(deps, report, "log-stage-1-payload-sizes (1w-ter)", "scripts/log-stage-1-payload-sizes.ts", ["--edition", opts.edition]);

  // --- §1w-quint-b repeat-de-tema (fail-soft, sempre exit 0) ---
  softStep(deps, report, "check-highlight-themes (1w-quint-b)", "scripts/check-highlight-themes.ts", [
    "--categorized",
    categorizedPath,
    "--past-editions",
    "data/past-editions.md",
    "--window",
    "12",
    "--editions-dir",
    "data/editions",
    "--secondary-window",
    "10",
    "--full-body-window",
    "10",
    "--current-edition",
    opts.edition,
    "--out-json",
    internalPath(editionDir, "01-highlight-theme-check.json"),
  ]);

  return baseResult("post-select-render", 0, report, {
    editionDir,
    categorizedPath,
    mdPath,
    minSectionWarnings,
    lancamentosWarnings,
    validateOutput: validateOutputJson,
  });
}

// ---------------------------------------------------------------------------
// FASE 5 — post-gate
// ---------------------------------------------------------------------------

async function runPostGate(deps: Stage1RunDeps, opts: Stage1RunOptions, report: ReportBuilder): Promise<Stage1RunResult> {
  const editionDir = resolveEditionDir(deps, opts.edition);
  const categorizedJsonPath = internalPath(editionDir, "01-categorized.json");
  const approvedPath = internalPath(editionDir, "01-approved.json");
  const mdPath = `${editionDir}/01-categorized.md`;

  if (opts.auto) {
    step(deps, report, "apply-gate-edits --auto (1y)", "scripts/apply-gate-edits.ts", ["--auto", "--json", categorizedJsonPath, "--out", approvedPath]);
    report.note("ℹ️  1y: --auto — sem edição humana, pulando re-render/validate-lancamentos (nada mudou vs 01-categorized.md).");
  } else {
    step(deps, report, "apply-gate-edits (1y)", "scripts/apply-gate-edits.ts", ["--md", opts.md as string, "--json", categorizedJsonPath, "--out", approvedPath]);
    step(deps, report, "render-categorized-md pós-gate (1y)", "scripts/render-categorized-md.ts", ["--in", approvedPath, "--out", mdPath, "--edition", opts.edition, "--source-health", "data/source-health.json"]);
    const lancamentosResult = deps.exec("scripts/validate-lancamentos.ts", [mdPath]);
    if (lancamentosResult.code !== 0) {
      report.note("⚠️  validate-lancamentos pós-gate: URLs não-oficiais OU sem sinal de produto em LANÇAMENTOS — não bloqueia automaticamente.");
    }
  }

  // --- pós-gate-apply invariants (warn, nunca bloqueia — sentinel ainda é escrito) ---
  const invariants = deps.exec("scripts/check-invariants.ts", ["--stage", "1", "--edition-dir", `${editionDir}/`]);
  if (invariants.code === 1) {
    report.note("⚠️  check-invariants --stage 1 (pós-gate) falhou — bug downstream, seguindo (sentinel ainda é escrito).");
    logEvent(deps, opts.edition, "warn", "stage1_post_gate_invariants_failed", { details: parseStepJson(invariants.stdout) });
  }

  // --- experimento D3-radar (opt-in, off por padrão) ---
  const experiment = deps.exec("scripts/experiment-d3-radar.ts", ["--edition", opts.edition, "--approved", approvedPath]);
  if (experiment.code === 1) {
    report.note("⚠️  experiment-d3-radar falhou — seguindo sem randomizar (experimento opcional, nunca bloqueia).");
  }

  // --- sentinel de conclusão do Stage 1 ---
  const sentinel = deps.exec("scripts/pipeline-sentinel.ts", ["write", "--edition", opts.edition, "--step", "1", "--outputs", "01-categorized.md,_internal/01-approved.json"]);
  if (sentinel.code !== 0) {
    logEvent(deps, opts.edition, "warn", "sentinel_write_failed");
    report.note("⚠️  sentinel_write_failed — não bloqueia a aprovação do gate.");
  }

  // --- arquivar inbox ---
  const inboxArchiveDir = resolve(deps.rootDir, "data", "inbox-archive");
  deps.mkdirSync(inboxArchiveDir);
  const inboxPath = resolve(deps.rootDir, "data", "inbox.md");
  if (deps.existsSync(inboxPath)) {
    const now = opts.nowIso ? new Date(opts.nowIso) : deps.now();
    const stamp = isoDateOnly(now);
    deps.renameFile(inboxPath, resolve(inboxArchiveDir, `${stamp}.md`));
    deps.writeFile(inboxPath, "");
    report.note(`✅ inbox arquivado em data/inbox-archive/${stamp}.md.`);
  }

  // --- stage-status + captura de custo ---
  const updateArgs = ["--edition-dir", editionDir, "--stage", "1", "--status", "done"];
  if (opts.startedAtIso) {
    const now = opts.nowIso ? new Date(opts.nowIso) : deps.now();
    const durationMs = now.getTime() - new Date(opts.startedAtIso).getTime();
    updateArgs.push("--end", now.toISOString(), "--duration-ms", String(Math.max(0, durationMs)));
  }
  deps.exec("scripts/update-stage-status.ts", updateArgs);

  const usageResult = deps.exec("scripts/capture-stage-usage.ts", ["--edition-dir", editionDir, "--stage", "1"]);
  const usageJson = parseStepJson(usageResult.stdout) as { source?: string; reason?: string } | undefined;
  if (usageJson?.source === "unavailable") {
    logEvent(deps, opts.edition, "warn", "stage_usage_capture_unavailable", { details: { reason: usageJson.reason } });
  }

  return baseResult("post-gate", 0, report, { editionDir, categorizedJsonPath, approvedPath, mdPath });
}

// ---------------------------------------------------------------------------
// Orquestração principal.
// ---------------------------------------------------------------------------

export async function runStage1(argv: string[], deps: Stage1RunDeps): Promise<Stage1RunResult> {
  const report = new ReportBuilder();
  try {
    const opts = parseStage1RunArgs(argv);
    switch (opts.phase) {
      case "pre-research":
        return await runPreResearch(deps, opts, report);
      case "post-research-pre-score":
        return await runPostResearchPreScore(deps, opts, report);
      case "post-score":
        return await runPostScore(deps, opts, report);
      case "post-select-render":
        return await runPostSelectRender(deps, opts, report);
      case "post-gate":
        return await runPostGate(deps, opts, report);
      default:
        throw new Stage1Abort(`fase desconhecida: ${opts.phase}`);
    }
  } catch (e) {
    const abort = e instanceof Stage1Abort ? e : new Stage1Abort(`erro inesperado: ${(e as Error).message}`);
    report.note(`❌ ${abort.message}`);
    const phaseGuess = (VALID_PHASES.find((p) => argv.includes(p)) as Phase) ?? "pre-research";
    return baseResult(phaseGuess, abort.code, report);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const deps = productionDeps(ROOT);
  runStage1(process.argv.slice(2), deps).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.code;
  });
}
