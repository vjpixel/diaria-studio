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
 * Extensão (#3562, entrega 2 — triagem rica): além do shape original
 * (#3574), `TriageIssue` ganhou `files` (paths citados no corpo, ver
 * `extractFilePaths` abaixo — originalmente insumo da análise de cluster de
 * conflito de `studio-waves.ts`, removida no #4004; a extração em si
 * continua, é o dado bruto que a coluna de Classificação da Triagem usa) e
 * `execTrack` (qual sessão consegue trabalhar a issue — overnight/develop/
 * agendada/bloqueada/fora-de-rodada, ver `scripts/lib/issue-exec-track.ts`;
 * sucede o `dispatchTrack` elegível/bloqueada/ambígua do #4004, aposentado
 * no #5462; `agendada` acrescentado no #5682).
 * `TriagePr` ganhou `ciState` (resumo de `statusCheckRollup`) e
 * `reviewDecision` (repasse cru da API) — visão de "PRs em voo" pedida pelo
 * #3562. Isso exige incluir `body` no `gh issue list` e
 * `statusCheckRollup,reviewDecision` no `gh pr list` — mesmas 2 chamadas já
 * existentes, sem nenhuma chamada extra por item (crítico pra não estourar
 * rate limit, mesma preocupação do design original).
 *
 * `defaultGhRun` roda via `spawnGhSync` (`gh-run.ts`), sempre com `timeout`
 * (#3783 — antes chamava `spawnSync` direto sem teto, o mesmo gap que o
 * #3773 já tinha corrigido num módulo irmão, removido desde #4004; ver
 * doc-comment de `defaultGhRun` abaixo).
 */

import { spawnGhSync, GH_SPAWN_TIMEOUT_MS } from "../lib/shared/gh-run.ts";
import { classifyExecTrackWithRule, EXEC_TRACK_UI, type ExecTrack, type ExecTrackMatch } from "../lib/issue-exec-track.ts";
import { listActiveSessions, type ActiveSessionRecord } from "../lib/session-registry.ts";
import { flattenClaims, type ClaimBearingSession } from "../lib/claim-staleness.ts";

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
  /** Usado só pra derivar `files`/`execTrack` (#3562) — NUNCA repassado
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

export type TrackLabel = "overnight" | "develop" | "continuo" | "other";

export interface TriageIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: string[];
  priority: string | null; // "P0".."P3" | null quando nenhuma label P0-P3
  createdAt: string | null;
  updatedAt: string | null;
  /** Paths de arquivo citados no título+corpo (#3562) — ver
   * `extractFilePaths` abaixo. Nunca inclui o corpo cru da issue, só os
   * paths extraídos. */
  files: string[];
  /** Qual sessão consegue trabalhar a issue (#5462) — ver
   * `scripts/lib/issue-exec-track.ts`, fonte única compartilhada com a Fase 0
   * do `/diaria-overnight`/`/diaria-develop`. Determinístico: lê labels +
   * marcador `aguardando-ate:`, nunca infere julgamento a partir de prosa. */
  execTrack: ExecTrack;
  /** Regra da cadeia de precedência que decidiu `execTrack` (#6200) —
   * permite ao painel distinguir `overnight` **verificado** (sinal positivo
   * explícito, ex.: `label:alarm-evento`) de `overnight` **por omissão**
   * (`default` — nenhuma label disse o contrário, ninguém olhou). `null` só
   * quando a classificação foi feita sem o detalhe (caller legado). */
  execTrackMatched: ExecTrackMatch | null;
  /**
   * #6436 — claim ATIVO de uma sessão coordenadora (`data/sessions/`), se
   * houver. Antes desta issue, uma issue `claimed-por-outra-sessao` (em
   * especial pela sessão `continuo`, que re-reivindica a cada 60min e por
   * isso NUNCA fica stale) aparecia no painel como "Overnight sem sinal" —
   * indistinguível de uma issue genuinamente sem dono. `null` = sem claim
   * ativo conhecido (issue livre, ou `data/sessions/` inacessível — fail-soft,
   * nunca lança). Computado em `attachClaims`, não em `parseIssues` (que é
   * puro sobre o JSON do `gh` e não tem acesso a `data/sessions/`).
   */
  claim: TriageClaimInfo | null;
}

/** Claim ativo de uma issue — ver `TriageIssue.claim`. */
export interface TriageClaimInfo {
  kind: string;
  machineTag: string;
  sessionId: string;
  /** ISO da 1ª reivindicação (`claimed_issues_at`, #6436) — `null` pra
   * sessão anterior ao campo existir (idade desconhecida). */
  claimedAt: string | null;
  /**
   * #7263 — `true` quando a sessão dona parece ociosa (`session.stale`,
   * `SOFT_STALE_MS`/90min) mas ainda retém o claim (dentro da janela de 24h
   * de `claimReleaseMsForKind`, #7227). Antes deste campo, essa combinação
   * era invisível: `fetchTriageData` excluía TODA sessão `stale` da lista
   * passada a `attachClaims`, então a issue aparecia sem claim nenhum — o
   * mesmo que "livre" pra quem olhasse o painel, mesmo com o claim real
   * ainda bloqueando outra sessão por até ~22h. `false` = claim de sessão
   * genuinamente ativa ("em andamento").
   */
  stale: boolean;
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
  /** Vocabulário de `execTrack` (valor + rótulo + explicação), na ordem de
   * precedência do classificador (#5462). Servido junto do payload pra que o
   * front RENDERIZE a partir daqui em vez de redeclarar os 4 valores — a
   * redeclaração era uma 2ª fonte de verdade que um 5º valor quebraria só do
   * lado do servidor, passando silenciosamente no cliente (achado no review
   * do PR #5463). */
  execTrackUi: typeof EXEC_TRACK_UI;
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

// ─── extração de arquivos citados + classificação de dispatch (pura) ───
//
// Relocadas de `studio-waves.ts` no #4004 (limpeza da seção "Composição de
// wave — preview" e do mecanismo wave-fire, descontinuado no #3720/#3985) —
// `studio-issues.ts` é o único consumidor real: `parseIssues` abaixo usa as
// duas pra popular `TriageIssue.files`/`TriageIssue.execTrack`, que
// alimentam a coluna de Classificação da Triagem. A análise de cluster de
// conflito/composição de onda que também vivia em `studio-waves.ts` (agora
// removida) usava esses dois como insumo, mas eram funções genéricas de
// extração/classificação, não específicas da wave — sobrevivem aqui.

/** Heurística de extração de arquivo (não é o mesmo grep-com-julgamento que
 * o coordenador de `/diaria-develop`/`/diaria-overnight` faz lendo a issue
 * inteira — aqui é regex puro sobre título+corpo): caminhos em code-span
 * (`` `scripts/foo.ts` ``) e caminhos "nus" prefixados por um diretório-raiz
 * conhecido do repo (`scripts/`, `context/`, `test/`, `seed/`, `docs/`,
 * `workers/`, `.claude/`). Sub-conta (falso-negativo) é mais seguro que
 * sobre-conta aqui: uma issue sem arquivo detectado nunca gera falso-positivo
 * de conflito/classificação. */
const CODE_SPAN_PATH_RE = /`([a-zA-Z0-9_.\-]+(?:\/[a-zA-Z0-9_.\-]+)+)`/g;
const BARE_PATH_RE =
  /\b((?:scripts|context|test|seed|docs|workers|\.claude)\/[a-zA-Z0-9_.\-]+(?:\/[a-zA-Z0-9_.\-]+)*)\b/g;

function stripTrailingPunctuation(path: string): string {
  return path.replace(/[.,;:)\]]+$/, "");
}

/** Extrai caminhos de arquivo citados em texto livre (título+corpo de issue).
 * Pura — nenhum I/O, nenhuma chamada a `gh`/git. Dedup via Set; ordem final
 * alfabética (determinístico pra teste e pra render estável). */
export function extractFilePaths(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const re of [CODE_SPAN_PATH_RE, BARE_PATH_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const path = stripTrailingPunctuation(m[1]);
      if (path.includes("/")) found.add(path);
    }
  }
  return [...found].sort();
}

// A classificação de issue vive em `scripts/lib/issue-exec-track.ts` desde o
// #5462 — não é mais uma heurística própria da Triagem. O `classifyDispatchTrack`
// que morava aqui classificava por regex de prosa (`AMBIGUITY_RE`) e por isso
// não conseguia separar as duas ambiguidades que o overnight, na época,
// tratava de forma oposta (trivial → briefing; trade-off-real → develop).
// Desde o #7493 as duas convergem pro mesmo destino — o briefing da Fase 0 —,
// o que torna aquela confusão menos custosa sem torná-la correta: o corpo da
// issue continua sem sinal que separe as famílias, e adivinhar aqui seguiria
// errado. Ver a docstring do módulo novo pro raciocínio completo.

// ─── funções puras (testáveis sem invocar `gh`) ────────────────────────

const PRIORITY_RE = /^P[0-3]$/;

/** Extrai a label de prioridade P0-P3 (a primeira que casar); `null` se nenhuma. */
export function derivePriority(labels: string[]): string | null {
  return labels.find((l) => PRIORITY_RE.test(l)) ?? null;
}

/**
 * Deriva a trilha (overnight/develop/continuo/other) do nome do branch —
 * convenção literal documentada em `context/overnight-dispatch-rules.md` §2:
 *   - `overnight/fix-{issue}-{slug}` ou `overnight/batch-{slug}` → "overnight"
 *   - `develop/fix-NNNN` ou `develop/blast-NNNN` → "develop"
 *   - `continuo/fix-NNNN-{slug}` → "continuo" (#6446 v0.5.0 — PRs do
 *     hermes-diaria-continuo; antes saíam sem prefixo e caíam em "other",
 *     invisíveis na Triagem como pedido do editor em 28/08)
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
  if (branch.startsWith("continuo/")) return "continuo";
  return "other";
}

function labelNames(raw: Array<{ name: string }> | undefined): string[] {
  return Array.isArray(raw) ? raw.map((l) => l?.name).filter((n): n is string => typeof n === "string") : [];
}

/** Normaliza o JSON cru de `gh issue list` pro shape de `TriageIssue`. Pura. */
export function parseIssues(raw: GhIssueRaw[]): TriageIssue[] {
  return raw.map((i) => {
    const labels = labelNames(i.labels);
    const files = extractFilePaths(`${i.title}
${i.body ?? ""}`);
    const result = classifyExecTrackWithRule({ labels, body: i.body, state: i.state });
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
      // #5948 — `state` precisa ser propagado mesmo quando o fetch já filtra
      // por `--state open`: `parseIssues` é uma função pura, testável com
      // qualquer input, e `classifyExecTrack` só protege contra issue
      // fechada quando `state` chega até ela.
      execTrack: result.track,
      execTrackMatched: result.matched as ExecTrackMatch,
      // Preenchido depois por `attachClaims` (precisa de `data/sessions/`,
      // I/O que `parseIssues` — puro sobre o JSON do `gh` — não faz).
      claim: null,
    };
  });
}

/**
 * Limiar de exibição — SÓ pro badge "em andamento" do painel de Triagem
 * (#6592). Deliberadamente separado de `SOFT_STALE_MS`
 * (`scripts/lib/session-registry.ts`, 90min): aquele valor também governa o
 * write-path real de claim (bloqueio de re-claim entre sessões concorrentes
 * via `claimIssueCheckAndSet`) — apertá-lo ali arriscaria colisão genuína
 * entre sessões que só estão lentas, não mortas. Achado ao vivo em 260828:
 * uma sessão overnight-helios teve o PID morto sem chamar `end`/soltar o
 * claim; `lastHeartbeat` ficou congelado, mas como `SOFT_STALE_MS` é 90min
 * o painel continuou mostrando "em andamento — overnight-helios" por até
 * 90min depois do processo já estar morto. Este módulo (consumidor único de
 * `PANEL_DISPLAY_STALE_MS`) recalcula staleness OUTRA VEZ sobre
 * `lastHeartbeat`, só pra decidir se o claim aparece no payload — não toca
 * `claim-staleness.ts`/`block-staleness.ts`, que continuam livres pra usar
 * `SOFT_STALE_MS`/`CLAIM_STALE_AGE_MS` sem mudança de comportamento.
 */
export const PANEL_DISPLAY_STALE_MS = 20 * 60 * 1000;

/**
 * Pure: heartbeat mais velho que `PANEL_DISPLAY_STALE_MS` → staleness de
 * EXIBIÇÃO, independente do que `session.stale` (calculado contra
 * `SOFT_STALE_MS`) já diga. Usa `lastHeartbeat` (fallback `startedAt`,
 * mesmo padrão de `listActiveSessions`) — nunca lança em data inválida
 * (idade desconhecida não é motivo pra esconder um claim genuinamente
 * ativo, mesmo fail-soft do resto do módulo).
 */
export function isPanelDisplayStale(
  session: Pick<ActiveSessionRecord, "lastHeartbeat" | "startedAt">,
  nowMs: number,
  maxAgeMs: number = PANEL_DISPLAY_STALE_MS,
): boolean {
  const heartbeatIso = session.lastHeartbeat ?? session.startedAt;
  const heartbeatMs = Date.parse(heartbeatIso);
  if (!Number.isFinite(heartbeatMs)) return false;
  return nowMs - heartbeatMs > maxAgeMs;
}

/**
 * #6436 — atribui `claim` (1ª sessão ativa encontrada segurando a issue,
 * via `flattenClaims`) a cada `TriageIssue`. Pura sobre `sessions` já
 * fornecido (mesmo padrão do resto do módulo — I/O fica em `fetchTriageData`,
 * que chama `listActiveSessions` e passa o resultado aqui). Issue reivindicada
 * por MAIS DE UMA sessão simultaneamente não deveria acontecer
 * (`claimIssueCheckAndSet` recusa colisão, #6236) — se acontecer mesmo assim
 * (dado stale/corrompido), a 1ª sessão da lista vence, sem lançar. **#7263:**
 * quando `sessions` mistura entradas frescas e stale-com-claim-retida (ver
 * `fetchTriageData`), a ORDEM da lista de entrada decide quem vence — o
 * chamador é responsável por colocar as frescas primeiro, pra uma claim
 * genuinamente ativa nunca perder pra uma stale no mesmo caso raro citado
 * acima.
 */
export function attachClaims(
  issues: readonly TriageIssue[],
  sessions: readonly ClaimBearingSession[],
): TriageIssue[] {
  const byIssue = new Map<number, TriageClaimInfo>();
  for (const entry of flattenClaims(sessions)) {
    if (byIssue.has(entry.issueNumber)) continue;
    byIssue.set(entry.issueNumber, {
      kind: entry.kind,
      machineTag: entry.machineTag,
      sessionId: entry.sessionId,
      claimedAt: entry.claimedAt,
      stale: entry.stale,
    });
  }
  return issues.map((issue) => ({ ...issue, claim: byIssue.get(issue.number) ?? null }));
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
 * o mesmo gap que o #3773 já tinha corrigido num módulo irmão (removido
 * desde, #4004) extraindo `spawnGhSync` — só que nunca reusado aqui. Mais
 * severo aqui: `defaultGhRun` alimenta `fetchTriageData`, chamada por
 * `GET /api/issues` — rota de USO NORMAL do Studio (Triagem), não gateada
 * por env var. Se `gh auth` expirar ou a API do GitHub degradar enquanto o
 * editor navega o Studio, `spawnSync` sem timeout travava o event loop
 * indefinidamente (CLAUDE.md #738). Corrigido reusando
 * `spawnGhSync`/`GH_SPAWN_TIMEOUT_MS` do módulo compartilhado `gh-run.ts`
 * (extraído nesta mesma leva, #3783). `timeoutMs`/`bin` são parametrizados só
 * pra teste (produção sempre usa `GH_SPAWN_TIMEOUT_MS` + `"gh"`, mesmo padrão
 * de `spawnGhSync`) — permite provar com um processo genuinamente travado que
 * `defaultGhRun` retorna rápido em vez de bloquear indefinidamente, sem
 * precisar de `gh` instalado.
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
    // #6436 — `listActiveSessions` é fail-soft (nunca lança; `data/sessions/`
    // ausente ou ilegível vira array vazio), então nunca degrada este `try`
    // pro caminho de erro do `gh`. Filtra `stale` ANTES de repassar pra
    // `attachClaims` — mesmo critério de `isIssueClaimedByOther` (#5474): uma
    // sessão stale (heartbeat morto além de `SOFT_STALE_MS`) não deveria
    // aparecer como "em andamento" pro editor, mesmo ainda listada por
    // `listActiveSessions` (que preserva sessões stale de propósito, pra
    // outros consumidores como o watchdog). Achado do self-review — sem
    // este filtro, uma claim ABANDONADA continuaria mostrando "em
    // andamento" no painel indefinidamente (até `MAX_SESSION_AGE_MS`, 24h).
    // #6592 — 2ª passada, com o limiar mais apertado de EXIBIÇÃO
    // (`PANEL_DISPLAY_STALE_MS`, 20min): `!s.stale` sozinho ainda deixava
    // passar até 90min (`SOFT_STALE_MS`) de heartbeat morto, que é o valor
    // certo pro write-path de claim mas exagerado pro badge do painel.
    const allSessions = listActiveSessions(rootDir);
    const freshSessions = allSessions.filter((s) => !s.stale && !isPanelDisplayStale(s, nowMs));
    // #7263 — 2ª fatia, DELIBERADAMENTE separada do filtro acima: sessão
    // `stale: true` (>90min sem heartbeat, "provavelmente ociosa") que AINDA
    // retém claim (`claimed_issues_effective` não-vazio — dentro da janela
    // de retenção de 24h, `claimReleaseMsForKind`/#7227) era simplesmente
    // excluída daqui antes, então a issue aparecia como livre no painel
    // mesmo com o claim real ainda bloqueando outra sessão por até ~22h
    // (janela 90min-24h, achado da issue: "invisível em qualquer lugar").
    // Passada em SEGUIDO de `freshSessions` pra `attachClaims` — que já
    // documenta a ordem como o desempate — pra uma claim genuinamente ativa
    // nunca perder pra uma stale (não deveria colidir de qualquer forma,
    // `claimIssueCheckAndSet` recusa 2 sessões na mesma issue, #6236).
    const staleRetainedSessions = allSessions.filter(
      (s) => s.stale && s.claimed_issues_effective.length > 0,
    );
    const sessions = [...freshSessions, ...staleRetainedSessions];
    const data: TriageData = {
      generatedAt: new Date(nowMs).toISOString(),
      issues: attachClaims(parseIssues(issuesRaw), sessions),
      prs: parsePrs(prsRaw),
      execTrackUi: EXEC_TRACK_UI,
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
      // Servido mesmo no caminho de falha: é vocabulário estático, não
      // depende do `gh`. Sem isso o front perderia rótulo/tooltip justamente
      // quando já está degradado.
      execTrackUi: EXEC_TRACK_UI,
      error: message,
      cached: false,
    };
  }
}
