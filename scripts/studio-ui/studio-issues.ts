/**
 * studio-issues.ts (#3562, sub-issue da EPIC "Studio UI" #3554)
 *
 * Camada de leitura pra `GET /api/issues`: issues abertas + PRs abertos do
 * GitHub, pra a view de triagem visual (`/triagem`). Busca via `gh issue
 * list` / `gh pr list` (mesmo padrão de `scripts/bug-heatmap.ts`) — NUNCA
 * expõe token (o `gh` CLI já resolve auth localmente, o server só invoca o
 * binário) e NUNCA faz mutação (só `list`, sem `close`/`comment`/`merge`).
 *
 * Read-only por design (mesmo invariante de `studio-state.ts` /
 * `studio-edition-detail.ts`, #3555): nenhuma função aqui escreve em disco
 * nem no GitHub.
 *
 * Cache + throttle (#3562 critério de aceite "não estourar rate limit do
 * gh"): `fetchTriageData` mantém um cache em memória por `rootDir` com TTL
 * (default 60s) — chamadas repetidas de `/api/issues` dentro da janela
 * servem do cache sem invocar `gh` de novo. Se `gh` falhar (offline,
 * rate-limited, não instalado) e existir cache anterior, serve o cache
 * stale com `error` preenchido (fail-soft — nunca derruba o endpoint);
 * sem cache anterior, retorna arrays vazios + `error`.
 *
 * `run` é injetável (mesmo padrão de `PlanFileReaders` em
 * `overnight-statusline.ts`) — testes mockam `gh` sem precisar do binário
 * real nem de rede.
 *
 * Extensão (#3562, entrega 2 — triagem rica + composição de waves): além do
 * shape original (#3574), `TriageIssue` ganhou `files` (paths citados no
 * corpo, ver `studio-waves.ts::extractFilePaths` — insumo da análise de
 * cluster de conflito) e `dispatchTrack` (classificação best-effort
 * elegível/bloqueada/ambígua, `studio-waves.ts::classifyDispatchTrack`).
 * `TriagePr` ganhou `ciState` (resumo de `statusCheckRollup`) e
 * `reviewDecision` (repasse cru da API) — visão de "PRs em voo" pedida pelo
 * #3562. Isso exige incluir `body` no `gh issue list` e
 * `statusCheckRollup,reviewDecision` no `gh pr list` — mesmas 2 chamadas já
 * existentes, sem nenhuma chamada extra por item (crítico pra não estourar
 * rate limit, mesma preocupação do design original).
 *
 * `defaultGhRun` roda via `spawnGhSync` (`gh-run.ts`, compartilhado com
 * `studio-wave-fire.ts`), sempre com `timeout` (#3783 — antes chamava
 * `spawnSync` direto sem teto, o mesmo gap que o #3773 já tinha corrigido no
 * módulo irmão; ver doc-comment de `defaultGhRun` abaixo).
 */

import { extractFilePaths, classifyDispatchTrack, type DispatchTrack } from "./studio-waves.ts";
import { spawnGhSync, GH_SPAWN_TIMEOUT_MS } from "./gh-run.ts";

// ─── tipos ──────────────────────────────────────────────────────────────

/** Shape cru de `gh issue list --json number,title,url,state,labels,createdAt,updatedAt,body`. */
export interface GhIssueRaw {
  number: number;
  title: string;
  url: string;
  state: string;
  labels?: Array<{ name: string }>;
  createdAt?: string;
  updatedAt?: string;
  /** Usado só pra derivar `files`/`dispatchTrack` (#3562) — NUNCA repassado
   * cru pro cliente (ver `parseIssues`: o corpo não entra em `TriageIssue`). */
  body?: string;
}

/** Shape cru de `gh pr list --json number,title,url,state,isDraft,headRefName,labels,createdAt,updatedAt,statusCheckRollup,reviewDecision`. */
export interface GhPrRaw {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft?: boolean;
  headRefName?: string;
  labels?: Array<{ name: string }>;
  createdAt?: string;
  updatedAt?: string;
  /** Shape variável (StatusContext OU CheckRun do GraphQL da API do GitHub,
   * `gh` normaliza os 2 no mesmo array) — ver `summarizeChecks`. */
  statusCheckRollup?: unknown[];
  reviewDecision?: string | null;
}

export type TrackLabel = "overnight" | "develop" | "other";

export interface TriageIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: string[];
  priority: string | null; // "P0".."P3" | null quando nenhuma label P0-P3
  createdAt: string | null;
  updatedAt: string | null;
  /** Paths de arquivo citados no título+corpo (#3562, insumo da composição
   * de waves) — ver `studio-waves.ts::extractFilePaths`. Nunca inclui o
   * corpo cru da issue, só os paths extraídos. */
  files: string[];
  /** Classificação best-effort elegível/bloqueada/ambígua (#3562) — ver
   * `studio-waves.ts::classifyDispatchTrack`. Aproximação determinística,
   * não substitui a Fase 0 do `/diaria-develop`/`/diaria-overnight`. */
  dispatchTrack: DispatchTrack;
}

export interface TriagePr {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  /** Derivada do prefixo de branch (convenção #3321, ver context/overnight-dispatch-rules.md
   * §2) — sinal determinístico, não um chute do label. */
  track: TrackLabel;
  labels: string[];
  priority: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Resumo de `statusCheckRollup` (#3562) — "PRs em voo": estado agregado
   * de CI. NUNCA o gate de merge completo (#2210/#2222 também exige checar
   * threads não-resolvidas, que exigiria 1 chamada `gh api graphql` extra
   * POR PR — fora de escopo desta view read-only pra não estourar rate
   * limit; ver disclaimer na UI). */
  ciState: CiState;
  /** Repasse cru de `reviewDecision` da API (`APPROVED` | `CHANGES_REQUESTED`
   * | `REVIEW_REQUIRED` | `null`) — informacional, mesmo caveat acima. */
  reviewDecision: string | null;
}

export interface TriageData {
  generatedAt: string;
  issues: TriageIssue[];
  prs: TriagePr[];
  /** Mensagem de erro da última tentativa de fetch via `gh`, ou `null` se a
   * última tentativa (ou o dado servido do cache) foi bem-sucedida. */
  error: string | null;
  /** `true` quando os dados vieram do cache em memória (fresco OU stale
   * após falha de `gh`) em vez de um fetch novo bem-sucedido. */
  cached: boolean;
}

export interface GhRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type GhRunFn = (args: string[], cwd: string) => GhRunResult;

// ─── funções puras (testáveis sem invocar `gh`) ────────────────────────

const PRIORITY_RE = /^P[0-3]$/;

/** Extrai a label de prioridade P0-P3 (a primeira que casar); `null` se nenhuma. */
export function derivePriority(labels: string[]): string | null {
  return labels.find((l) => PRIORITY_RE.test(l)) ?? null;
}

/**
 * Deriva a trilha (overnight/develop/other) do nome do branch — convenção
 * literal documentada em `context/overnight-dispatch-rules.md` §2:
 *   - `overnight/fix-{issue}-{slug}` ou `overnight/batch-{slug}` → "overnight"
 *   - `develop/fix-NNNN` ou `develop/blast-NNNN` → "develop"
 *   - qualquer outro prefixo (branch manual do editor, dependabot, etc.) → "other"
 *
 * Determinístico — não é um chute de label, é o mesmo sinal que
 * `.claude/hooks/pr-create-review.mjs` (`resolveEffort`) já usa pra decidir
 * o effort do code-review pós-`gh pr create`.
 */
export function deriveTrackFromBranch(headRefName: string | undefined | null): TrackLabel {
  const branch = (headRefName ?? "").trim();
  if (branch.startsWith("overnight/")) return "overnight";
  if (branch.startsWith("develop/")) return "develop";
  return "other";
}

function labelNames(raw: Array<{ name: string }> | undefined): string[] {
  return Array.isArray(raw) ? raw.map((l) => l?.name).filter((n): n is string => typeof n === "string") : [];
}

/** Normaliza o JSON cru de `gh issue list` pro shape de `TriageIssue`. Pura. */
export function parseIssues(raw: GhIssueRaw[]): TriageIssue[] {
  return raw.map((i) => {
    const labels = labelNames(i.labels);
    const files = extractFilePaths(`${i.title}\n${i.body ?? ""}`);
    return {
      number: i.number,
      title: i.title,
      url: i.url,
      state: i.state,
      labels,
      priority: derivePriority(labels),
      createdAt: i.createdAt ?? null,
      updatedAt: i.updatedAt ?? null,
      files,
      dispatchTrack: classifyDispatchTrack(labels, `${i.title}\n${i.body ?? ""}`),
    };
  });
}

export type CiState = "green" | "red" | "pending" | "none";

/** Shape variável — `gh` normaliza StatusContext (`state`) e CheckRun
 * (`status`/`conclusion`) no mesmo array de `statusCheckRollup`. */
interface RawCheckRollupItem {
  state?: string; // StatusContext: SUCCESS | FAILURE | ERROR | PENDING | EXPECTED
  status?: string; // CheckRun: QUEUED | IN_PROGRESS | COMPLETED | ...
  conclusion?: string | null; // CheckRun: SUCCESS | FAILURE | CANCELLED | TIMED_OUT | ACTION_REQUIRED | NEUTRAL | SKIPPED | STALE
}

const FAILURE_STATES = new Set(["FAILURE", "ERROR"]);
const FAILURE_CONCLUSIONS = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);

/**
 * Resume `statusCheckRollup` (array bruto, shape variável) num único
 * `CiState`. Conservador: qualquer check não reconhecido (shape inesperado)
 * conta como `pending`, nunca como `green` silencioso — melhor sub-relatar
 * confiança que afirmar "tudo verde" errado (#573 é sobre validar estado
 * externo antes de relayar; mesmo espírito aqui, read-only). Pura.
 */
export function summarizeChecks(rollup: unknown): CiState {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let sawFailure = false;
  let sawPending = false;
  for (const raw of rollup as RawCheckRollupItem[]) {
    if (!raw || typeof raw !== "object") {
      sawPending = true;
      continue;
    }
    const { state, status, conclusion } = raw;
    if ((state && FAILURE_STATES.has(state)) || (conclusion && FAILURE_CONCLUSIONS.has(conclusion))) {
      sawFailure = true;
      continue;
    }
    if (status && status !== "COMPLETED") {
      sawPending = true;
      continue;
    }
    if (state === "PENDING" || state === "EXPECTED") {
      sawPending = true;
      continue;
    }
    if (state == null && status == null && conclusion == null) {
      sawPending = true;
    }
  }
  if (sawFailure) return "red";
  if (sawPending) return "pending";
  return "green";
}

/** Normaliza o JSON cru de `gh pr list` pro shape de `TriagePr`. Pura. */
export function parsePrs(raw: GhPrRaw[]): TriagePr[] {
  return raw.map((p) => {
    const labels = labelNames(p.labels);
    return {
      number: p.number,
      title: p.title,
      url: p.url,
      state: p.state,
      isDraft: p.isDraft === true,
      headRefName: p.headRefName ?? "",
      track: deriveTrackFromBranch(p.headRefName),
      labels,
      priority: derivePriority(labels),
      createdAt: p.createdAt ?? null,
      updatedAt: p.updatedAt ?? null,
      ciState: summarizeChecks(p.statusCheckRollup),
      reviewDecision: p.reviewDecision ?? null,
    };
  });
}

// ─── invocação do `gh` CLI (I/O, injetável) ────────────────────────────

const ISSUE_FIELDS = "number,title,url,state,labels,createdAt,updatedAt,body";
const PR_FIELDS =
  "number,title,url,state,isDraft,headRefName,labels,createdAt,updatedAt,statusCheckRollup,reviewDecision";

/**
 * #3783 — antes, este `spawnSync` chamava `gh` direto SEM `timeout`, exatamente
 * o mesmo gap que o #3773 já tinha corrigido no módulo irmão
 * (`studio-wave-fire.ts::defaultGhIssueRun`) extraindo `spawnGhSync` — só que
 * nunca reusado aqui. Mais severo aqui que lá: `defaultGhRun` alimenta
 * `fetchTriageData`, chamada por `GET /api/issues`/`GET /api/waves` — rotas
 * de USO NORMAL do Studio (Triagem), não gateadas por env var. Se `gh auth`
 * expirar ou a API do GitHub degradar enquanto o editor navega o Studio,
 * `spawnSync` sem timeout travava o event loop indefinidamente (CLAUDE.md
 * #738). Corrigido reusando `spawnGhSync`/`GH_SPAWN_TIMEOUT_MS` do módulo
 * compartilhado `gh-run.ts` (extraído nesta mesma leva, #3783). `timeoutMs`/
 * `bin` são parametrizados só pra teste (produção sempre usa
 * `GH_SPAWN_TIMEOUT_MS` + `"gh"`, mesmo padrão de `spawnGhSync`) — permite
 * provar com um processo genuinamente travado que `defaultGhRun` retorna
 * rápido em vez de bloquear indefinidamente, sem precisar de `gh` instalado.
 */
export function defaultGhRun(
  args: string[],
  cwd: string,
  timeoutMs: number = GH_SPAWN_TIMEOUT_MS,
  bin: string = "gh",
): GhRunResult {
  return spawnGhSync(args, cwd, timeoutMs, bin);
}

function runGhJson(run: GhRunFn, cwd: string, args: string[]): unknown[] {
  const result = run(args, cwd);
  if (result.status !== 0) {
    throw new Error(`gh ${args[0]} ${args[1]} falhou (status ${result.status}): ${result.stderr.trim()}`);
  }
  try {
    return JSON.parse(result.stdout) as unknown[];
  } catch (e) {
    throw new Error(`gh ${args[0]} ${args[1]}: resposta não é JSON válido (${(e as Error).message})`);
  }
}

/** `gh issue list --state open ...` — lança em caso de falha (caller decide fallback). */
export function fetchGhIssues(cwd: string, run: GhRunFn = defaultGhRun, limit = 200): GhIssueRaw[] {
  return runGhJson(run, cwd, [
    "issue", "list",
    "--state", "open",
    "--json", ISSUE_FIELDS,
    "--limit", String(limit),
  ]) as GhIssueRaw[];
}

/** `gh pr list --state open ...` — lança em caso de falha (caller decide fallback). */
export function fetchGhPrs(cwd: string, run: GhRunFn = defaultGhRun, limit = 100): GhPrRaw[] {
  return runGhJson(run, cwd, [
    "pr", "list",
    "--state", "open",
    "--json", PR_FIELDS,
    "--limit", String(limit),
  ]) as GhPrRaw[];
}

// ─── cache + orquestração ───────────────────────────────────────────────

interface CacheEntry {
  data: TriageData;
  expiresAt: number;
}

/** Cache em memória por `rootDir` — vive enquanto o processo do studio-server
 * viver. Módulo-level por design (mesmo espírito de outros caches simples do
 * repo): um único servidor loopback, um único rootDir na prática. */
const cacheByRoot = new Map<string, CacheEntry>();

/** Limpa o cache — usado só por testes pra isolar casos entre si. */
export function clearTriageCache(): void {
  cacheByRoot.clear();
}

export interface FetchTriageDataOptions {
  run?: GhRunFn;
  /** TTL do cache em ms (default 60s) — janela dentro da qual `/api/issues`
   * repetido NÃO dispara novas chamadas `gh` (#3562: "não estourar rate limit"). */
  cacheTtlMs?: number;
  now?: () => number;
  /** Força bypass do cache mesmo dentro da janela — não exposto via API
   * pública nesta fatia (sem botão "forçar refresh" no servidor; a UI já
   * reusa o cache barato), mas disponível pra testes. */
  forceRefresh?: boolean;
  issueLimit?: number;
  prLimit?: number;
}

/**
 * Monta o snapshot de issues + PRs abertos pra `GET /api/issues`.
 * Fail-soft: qualquer falha do `gh` (offline, não-instalado, rate limit,
 * não-autenticado) nunca lança — serve cache stale se houver, senão arrays
 * vazios com `error` preenchido. O caller HTTP sempre recebe 200.
 */
export function fetchTriageData(rootDir: string, opts: FetchTriageDataOptions = {}): TriageData {
  const run = opts.run ?? defaultGhRun;
  const cacheTtlMs = opts.cacheTtlMs ?? 60_000;
  const now = opts.now ?? (() => Date.now());
  const nowMs = now();

  if (!opts.forceRefresh) {
    const cached = cacheByRoot.get(rootDir);
    if (cached && cached.expiresAt > nowMs) {
      return { ...cached.data, cached: true };
    }
  }

  try {
    const issuesRaw = fetchGhIssues(rootDir, run, opts.issueLimit);
    const prsRaw = fetchGhPrs(rootDir, run, opts.prLimit);
    const data: TriageData = {
      generatedAt: new Date(nowMs).toISOString(),
      issues: parseIssues(issuesRaw),
      prs: parsePrs(prsRaw),
      error: null,
      cached: false,
    };
    cacheByRoot.set(rootDir, { data, expiresAt: nowMs + cacheTtlMs });
    return data;
  } catch (e) {
    const message = (e as Error).message;
    const stale = cacheByRoot.get(rootDir);
    if (stale) {
      return { ...stale.data, error: message, cached: true };
    }
    return {
      generatedAt: new Date(nowMs).toISOString(),
      issues: [],
      prs: [],
      error: message,
      cached: false,
    };
  }
}
