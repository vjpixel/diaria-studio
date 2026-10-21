/**
 * state-changed-tracker.ts (#5476)
 *
 * Gate mecânico para o achado da rodada overnight 260816e: uma ação do
 * PRÓPRIO coordenador durante a rodada (aplicar label de classificação —
 * `not-this-week`, `trade-off-real`, `external-blocker`, etc. — ou
 * encerrar/remover uma claim de `session-registry`) muda a elegibilidade de
 * uma issue JÁ CONHECIDA da rodada, sem passar pelo mecanismo de
 * "re-varredura de convergência" da Fase 1 (que só cobre issues NOVAS
 * aparecendo em `gh issue list`).
 *
 * Este módulo dá ao coordenador um jeito determinístico de registrar essas
 * mudanças (`add`) e de resolvê-las depois de reavaliar dispatch (`remove`),
 * mais um checador (`checkStateChangedPending`) que a Fase 2 (compilação do
 * relatório final) roda antes de fechar a rodada: se sobrar pendência, a
 * rodada não deveria escrever o relatório ainda — precisa voltar pra Fase 1
 * e reavaliar aquela(s) issue(s) primeiro.
 *
 * **Não é gate de merge nem bloqueia o processo por si**: o "exit 1" é um
 * sinal pro humano/coordenador que lê a saída do script, não uma trava de
 * infraestrutura — mesma natureza advisory de
 * `scripts/check-overnight-token-instrumentation.ts` (ver esse arquivo como
 * referência de estilo), mas aqui o exit code É NÃO-ZERO quando há
 * pendência, porque a instrução (regra #5476 nos 3 SKILL.md) é "não escreva
 * o relatório final enquanto isso não voltar a exit 0".
 *
 * O array `state_changed_issues` vive dentro do `plan.json` da rodada
 * (`data/overnight/{AAMMDD}/plan.json` ou `data/develop/...`) — arquivo já
 * lido/escrito pelo coordenador ao longo da rodada. Ausência do campo é
 * tratada como `[]` (fail-open, compatível com `plan.json` legado de rodadas
 * anteriores ao #5476).
 *
 * Uso CLI (este arquivo é import-only — o entrypoint de linha de comando é
 * `scripts/check-state-changed-pending.ts`, ver esse arquivo pro `main()`):
 *   npx tsx scripts/check-state-changed-pending.ts --plan {path}
 *     → checa; imprime pendências (se houver) e sai 1, ou "ok" e sai 0.
 *   npx tsx scripts/check-state-changed-pending.ts --add-pending {N} --plan {path}
 *   npx tsx scripts/check-state-changed-pending.ts --remove-pending {N} --plan {path}
 *
 * @see scripts/check-overnight-token-instrumentation.ts (padrão de estilo)
 * @see .claude/skills/diaria-overnight/SKILL.md
 * @see .claude/skills/diaria-develop/SKILL.md
 * @see .claude/skills/diaria-continuo/SKILL.md
 *
 * ## Re-varredura de convergência (#5706, fundida aqui)
 *
 * O módulo cobria só pendências EXPLÍCITAS (`state_changed_issues`, acima).
 * A Fase 1 passo 6 tinha um segundo mecanismo — "antes de marcar
 * `goal.reached: true`, varrer TODAS as issues abertas via `gh issue list`
 * procurando issue nova em qualquer tier" — que existia só como prosa, sem
 * script/gate/contador forçando que rodasse. Numa sessão real (260819c) foi
 * pulada silenciosamente: 6 issues criadas durante a rodada nunca apareceram
 * na tabela/dispatch/relatório, e o coordenador só percebeu porque rodou (1)
 * — este módulo — viu "nenhuma pendência" e leu isso como se cobrisse (2),
 * quando são escopos diferentes.
 *
 * A opção 2 da issue (preferida pelo editor) funde os dois: em vez de duas
 * checagens de nome parecido convidando à confusão, um ÚNICO gate. As
 * funções abaixo (`collectKnownIssueNumbers`, `findMissingConvergenceIssues`,
 * `checkConvergenceScan`, `recordConvergenceScan`) implementam a parte
 * PURA/testável; a CLI (`scripts/check-state-changed-pending.ts`) busca as
 * issues abertas via `gh` e injeta aqui.
 *
 * Issue nova é reportada como "faltando" só quando `classifyExecTrack`
 * (fonte canônica de #5462/#5682, reusada aqui em vez de reimplementar a
 * regra) a classifica `overnight`/`develop` — issue já `agendada`,
 * `bloqueada` ou `fora-de-rodada` não é ruído: ela já foi triangulada pela
 * classificação determinística, mesmo sem estar em `target_set`/`tiers`, e
 * reportá-la de qualquer forma é exatamente o tipo de alarme permanente que
 * a issue pede pra evitar.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { classifyExecTrack, type ExecTrackInput } from "./issue-exec-track.ts";
import { normalizeIssues, type IssuesBearing } from "./plan-issues-normalize.ts";
import { isForeignPlanEntry, planEntryKey, studioNumberOfPlanEntry } from "./plan-issue-ref.ts";

export interface PlanWithStateChanged {
  state_changed_issues?: unknown;
  [key: string]: unknown;
}

export type StateChangedCheckResult =
  | { status: "ok" }
  | {
      status: "pending";
      /** Pendências do repo default (número legado). */
      issues: number[];
      /** #10618 — pendências de OUTRO repo, como `owner/repo#N`. Presente só
       * quando há alguma (shape legado intacto para planos só do studio). */
      foreign?: string[];
    };

/**
 * Pure: normaliza o campo `state_changed_issues` de um plan.json já
 * parseado. Ausente/não-array/entries não-numéricas viram `[]` — fail-open,
 * nunca lança.
 */
export function readStateChangedIssues(plan: PlanWithStateChanged): number[] {
  const raw = plan.state_changed_issues;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/**
 * #10618 (fatia 2) — pendências de OUTRO repo gravadas em
 * `state_changed_issues` como `"owner/repo#N"` (string). Nunca entram em
 * `readStateChangedIssues` (que só devolve número = diaria-studio), mas
 * também nunca são descartadas: uma pendência é pendência, de qualquer repo.
 * Strings que não sejam de outro repo (ex.: `"#21"`) ficam fora daqui — a
 * forma legada do default continua sendo o número.
 */
export function readStateChangedForeignIssues(plan: PlanWithStateChanged): string[] {
  const raw = plan.state_changed_issues;
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string" || !isForeignPlanEntry(v)) continue;
    const key = planEntryKey(v);
    if (key) out.add(key);
  }
  return [...out].sort();
}

/**
 * Pure: array com `issueNumber` adicionado, deduplicado (no-op se já
 * presente). Não muta a lista original.
 */
export function addStateChangedIssue(issues: number[], issueNumber: number): number[] {
  if (issues.includes(issueNumber)) return issues;
  return [...issues, issueNumber];
}

/**
 * Pure: array com `issueNumber` removido, idempotente (no-op se ausente).
 * Não muta a lista original.
 */
export function removeStateChangedIssue(issues: number[], issueNumber: number): number[] {
  return issues.filter((n) => n !== issueNumber);
}

/**
 * Pure: veredito de checagem a partir da lista já lida. `pending` lista as
 * issues explicitamente — nunca só "há pendências", pra a mensagem de erro
 * ser acionável.
 */
export function checkStateChangedIssues(issues: number[], foreign: string[] = []): StateChangedCheckResult {
  if (issues.length === 0 && foreign.length === 0) return { status: "ok" };
  const sorted = [...issues].sort((a, b) => a - b);
  return foreign.length > 0
    ? { status: "pending", issues: sorted, foreign: [...foreign].sort() }
    : { status: "pending", issues: sorted };
}

function readPlan(planPath: string): PlanWithStateChanged {
  const raw = readFileSync(planPath, "utf8");
  return JSON.parse(raw) as PlanWithStateChanged;
}

function writePlan(planPath: string, plan: PlanWithStateChanged): void {
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

/** I/O: lê o plan.json, aplica `add`, grava de volta. */
export function addPendingToPlan(planPath: string, issueNumber: number): void {
  const plan = readPlan(planPath);
  const current = readStateChangedIssues(plan);
  // #10618: preserva pendências de outro repo (`"owner/repo#N"`).
  plan.state_changed_issues = [...addStateChangedIssue(current, issueNumber), ...readStateChangedForeignIssues(plan)];
  writePlan(planPath, plan);
}

/** I/O: lê o plan.json, aplica `remove`, grava de volta.
 *
 * #10618: preserva as pendências de outro repo (`"owner/repo#N"`) — antes a
 * regravação filtrava o array pra números e apagaria essas entradas. */
export function removePendingFromPlan(planPath: string, issueNumber: number): void {
  const plan = readPlan(planPath);
  const current = readStateChangedIssues(plan);
  const foreign = readStateChangedForeignIssues(plan);
  plan.state_changed_issues = [...removeStateChangedIssue(current, issueNumber), ...foreign];
  writePlan(planPath, plan);
}

/** #10618 — `add` de pendência de OUTRO repo (`ref` já canônico
 * `owner/repo#N`). Preserva as numéricas. Idempotente. */
export function addForeignPendingToPlan(planPath: string, ref: string): void {
  const plan = readPlan(planPath);
  const foreign = readStateChangedForeignIssues(plan);
  const next = foreign.includes(ref) ? foreign : [...foreign, ref];
  plan.state_changed_issues = [...readStateChangedIssues(plan), ...next];
  writePlan(planPath, plan);
}

/** #10618 — `remove` de pendência de OUTRO repo. Preserva as numéricas. */
export function removeForeignPendingFromPlan(planPath: string, ref: string): void {
  const plan = readPlan(planPath);
  const foreign = readStateChangedForeignIssues(plan).filter((r) => r !== ref);
  plan.state_changed_issues = [...readStateChangedIssues(plan), ...foreign];
  writePlan(planPath, plan);
}

/** I/O: lê o plan.json e devolve o veredito de checagem. */
export function checkStateChangedPending(planPath: string): StateChangedCheckResult {
  const plan = readPlan(planPath);
  return checkStateChangedIssues(readStateChangedIssues(plan), readStateChangedForeignIssues(plan));
}

// ---------------------------------------------------------------------------
// Re-varredura de convergência (#5706)
// ---------------------------------------------------------------------------

/** Issue aberta, já normalizada (labels como strings, body cru) — formato
 * de entrada de `findMissingConvergenceIssues`/`checkConvergenceScan`, mesmo
 * shape que `ExecTrackInput` sem o `now` (que é passado à parte). */
export interface ConvergenceScanIssue {
  number: number;
  labels: string[];
  body?: string | null;
}

export interface PlanWithGoal {
  goal?: {
    target_set?: unknown;
    tiers?: unknown;
    [key: string]: unknown;
  };
  issues?: unknown;
  /** `--bugs` (#3375) — quando `true`, a rodada restringiu deliberadamente
   * o conjunto-alvo a issues com label `bug`; todo o resto está FORA DE
   * ESCOPO por desenho, não "pulado por bloqueio". Ver uso em
   * `filterIssuesByRoundScope`. */
  bugs_only?: unknown;
  /** `--priority` (#3499) — lista de labels de prioridade (`["P0","P1"]`)
   * às quais a rodada restringiu o conjunto-alvo, ou `null`/ausente se a
   * flag não foi usada. Mesmo tratamento de escopo do `bugs_only`. */
  priority_filter?: unknown;
  /** `--issues N,M,...` do develop (#6616-adjacente) — lista fechada de
   * números que restringiu o conjunto-alvo da rodada. Mesmo tratamento de
   * escopo do `bugs_only`/`priority_filter`: issue aberta fora desta lista
   * nunca entrou em `issues[]`/`goal.tiers` por DESENHO (a sessão pediu
   * exatamente essas issues, não o backlog inteiro) — sem este campo, toda
   * rodada `--issues` reportava o backlog inteiro fora da lista como "novo
   * não-triangulado", o mesmo ruído permanente que motivou `bugs_only`/
   * `priority_filter` (#5706/#5713), só que pra `--issues` em vez de
   * `--bugs`/`--priority`. */
  issues_filter?: unknown;
  [key: string]: unknown;
}

export type ConvergenceScanResult =
  | { status: "ok"; novas_encontradas: 0 }
  | { status: "missing"; issues: number[]; novas_encontradas: number };

/** Pure: extrai números de um valor arbitrário do `plan.json` — aceita
 * array de números, array de objetos `{ number }`, ou qualquer outra coisa
 * (ignorada, nunca lança). Serve tanto pra `goal.target_set`/`goal.tiers[*]`
 * quanto pro `issues[]` top-level legado, que pode guardar registros
 * `{ number, ... }` por issue em vez de números crus.
 *
 * Exportado (#5718) pra reuso por `develop-target-set-coverage.ts`, que
 * precisa da mesma extração pra ler `goal.target_set` isoladamente (sem os
 * outros campos que `collectKnownIssueNumbers` funde). */
export function extractIssueNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const entry of value) {
    // #10618 (fatia 2): só números do repo DEFAULT. Entrada de outro repo
    // (`"vjpixel/diaria-design#21"`, `{ ref }`, `{ number, repo }`) nunca
    // vira o número do diaria-studio — ver `scripts/lib/plan-issue-ref.ts`.
    // Número cru e `{ number }` sem `repo` seguem como sempre.
    const n = studioNumberOfPlanEntry(entry);
    if (n !== null) out.push(n);
  }
  return out;
}

/**
 * #10618 (fatia 2) — como `extractIssueNumbers`, mas devolve a identidade
 * canônica `owner/repo#N` de TODA entrada (repo default e outros). Usado por
 * gates que precisam cobrir issue de outro repo sem confundi-la com o número
 * do diaria-studio (ex.: `develop-target-set-coverage.ts`).
 */
export function extractIssueKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const key = planEntryKey(entry);
    if (key) out.push(key);
  }
  return out;
}

/**
 * Pure: conjunto de todo número de issue já conhecido pelo plano — a união
 * de `goal.target_set`, todos os arrays de `goal.tiers` (1a/1b/2/3, ou
 * qualquer chave presente — nunca hardcoda os nomes de tier, pra não
 * quebrar se a partição mudar) e o `issues[]` top-level. Issue aberta fora
 * desse conjunto é candidata a "nova" — ainda passa por `classifyExecTrack`
 * antes de virar ruído (ver `findMissingConvergenceIssues`).
 *
 * `plan.issues` passa por `normalizeIssues` (`./plan-issues-normalize.ts`,
 * #4817/#4860) em vez de `extractIssueNumbers` puro — achado no self-review
 * do #5706: `/diaria-develop` grava `issues` como DICT chaveado por número
 * (`{ "4800": {...} }`), não array, e é a ÚNICA fonte de "conhecido" que
 * sobra quando `policy: "table_only"` (`goal.target_set`/`goal.tiers` ficam
 * vazios a sessão inteira nessa política — ver develop/SKILL.md). Sem essa
 * normalização, todo plano `table_only` do develop leria `known` como vazio
 * e reportaria toda issue aberta como "nova" — exatamente a classe de falso
 * positivo que este gate existe pra evitar.
 */
export function collectKnownIssueNumbers(plan: PlanWithGoal): Set<number> {
  const known = new Set<number>();
  const goal = plan.goal;
  if (goal && typeof goal === "object") {
    for (const n of extractIssueNumbers(goal.target_set)) known.add(n);
    const tiers = goal.tiers;
    if (tiers && typeof tiers === "object" && !Array.isArray(tiers)) {
      for (const tierIssues of Object.values(tiers as Record<string, unknown>)) {
        for (const n of extractIssueNumbers(tierIssues)) known.add(n);
      }
    }
  }
  // Cast seguro: `PlanWithGoal.issues` é `unknown` de propósito (o plano
  // pode ter qualquer shape) — `normalizeIssues` já faz toda a checagem em
  // runtime (`Array.isArray`/`typeof === "object"`), então o cast só
  // silencia a checagem estrutural do TS, não pula validação real.
  for (const issue of normalizeIssues<{ number: number }>(
    plan as IssuesBearing<{ number: number }>,
  )) {
    // #10618: entrada de outro repo não torna "conhecido" o número do studio.
    const n = studioNumberOfPlanEntry(issue);
    if (n !== null) known.add(n);
  }
  return known;
}

/**
 * Pure: normaliza `plan.bugs_only`/`plan.priority_filter`/`plan.issues_filter`
 * (#3375/#3499/#6616-adjacente) — mesmo fail-open documentado nos três
 * campos: ausente/shape errado vira "sem filtro" (`bugsOnly: false`,
 * `priorityFilter: null`, `issuesFilter: null`), nunca lança.
 */
export function readRoundScopeFilters(plan: PlanWithGoal): {
  bugsOnly: boolean;
  priorityFilter: string[] | null;
  issuesFilter: number[] | null;
} {
  const bugsOnly = plan.bugs_only === true;
  const rawPriority = plan.priority_filter;
  const priorityFilter =
    Array.isArray(rawPriority) && rawPriority.every((p) => typeof p === "string")
      ? (rawPriority as string[])
      : null;
  const rawIssues = plan.issues_filter;
  const issuesFilter =
    Array.isArray(rawIssues) && rawIssues.every((n) => typeof n === "number")
      ? (rawIssues as number[])
      : null;
  return { bugsOnly, priorityFilter, issuesFilter };
}

/**
 * Pure: filtra `openIssues` pelos mesmos critérios `--bugs`/`--priority`/
 * `--issues` que restringiram o conjunto-alvo da rodada
 * (#3375/#3499/#6616-adjacente) — issue fora do filtro nunca entrou em
 * `issues[]`/`goal.tiers` por DESENHO (fora de escopo do modo, não "pulada
 * por bloqueio"; ver `.claude/skills/diaria-develop/SKILL.md`
 * e `.claude/skills/diaria-overnight/SKILL.md`, passo 3/Fase 0 passo 3).
 * Sem este filtro, `findMissingConvergenceIssues` reportava toda issue
 * elegível fora do filtro como "nova não-triangulada" em TODA rodada
 * `--bugs`/`--priority`/`--issues` — ruído permanente que ensina a ignorar
 * o gate (achado de review do #5706/#5713, mesma classe encontrada de novo
 * pra `--issues` numa sessão real que só tinha 3 issues em escopo e viu o
 * gate listar o backlog aberto inteiro como "novo").
 */
export function filterIssuesByRoundScope(
  openIssues: ConvergenceScanIssue[],
  plan: PlanWithGoal,
): ConvergenceScanIssue[] {
  const { bugsOnly, priorityFilter, issuesFilter } = readRoundScopeFilters(plan);
  if (!bugsOnly && !priorityFilter && !issuesFilter) return openIssues;
  return openIssues.filter((issue) => {
    if (bugsOnly && !issue.labels.includes("bug")) return false;
    if (priorityFilter && !issue.labels.some((l) => priorityFilter.includes(l))) return false;
    if (issuesFilter && !issuesFilter.includes(issue.number)) return false;
    return true;
  });
}

/**
 * Pure: entre as issues abertas passadas, devolve os números das que NÃO
 * estão em `known` E que `classifyExecTrack` classifica como `overnight`/
 * `develop` (isto é: trabalho real pendente de triagem). Uma issue ausente
 * de `known` mas já `agendada`/`bloqueada`/`fora-de-rodada` não entra —
 * ela já foi triangulada pela classificação determinística, mesmo nunca
 * tendo passado pelo `target_set`/`tiers` desta sessão (ex: criada e
 * imediatamente marcada `on-hold` por outra sessão concorrente).
 */
export function findMissingConvergenceIssues(
  openIssues: ConvergenceScanIssue[],
  known: Set<number>,
  now?: Date,
): number[] {
  const missing: number[] = [];
  for (const issue of openIssues) {
    if (known.has(issue.number)) continue;
    const input: ExecTrackInput = { labels: issue.labels, body: issue.body, now };
    const track = classifyExecTrack(input);
    if (track === "overnight" || track === "develop") {
      missing.push(issue.number);
    }
  }
  return missing.sort((a, b) => a - b);
}

/** Pure: veredito de convergência a partir do plano já parseado + issues
 * abertas já buscadas (I/O de busca fica no chamador — CLI ou teste).
 * Aplica `filterIssuesByRoundScope` antes de comparar contra `known`
 * (#3375/#3499 — ver esse helper para o motivo). */
export function checkConvergenceScan(
  plan: PlanWithGoal,
  openIssues: ConvergenceScanIssue[],
  now?: Date,
): ConvergenceScanResult {
  const known = collectKnownIssueNumbers(plan);
  const scoped = filterIssuesByRoundScope(openIssues, plan);
  const missing = findMissingConvergenceIssues(scoped, known, now);
  if (missing.length === 0) return { status: "ok", novas_encontradas: 0 };
  return { status: "missing", issues: missing, novas_encontradas: missing.length };
}

/**
 * I/O: grava `goal.last_convergence_scan = { at, novas_encontradas }` no
 * `plan.json` (item 3 da issue #5706) — registro de QUANDO a última
 * varredura completa rodou e quantas issues novas ela achou, análogo ao
 * contador puro `rescans_done` mas com timestamp explícito. Cria `goal` como
 * objeto vazio se ainda não existir (plano legado/parcial) em vez de lançar.
 */
export function recordConvergenceScan(
  planPath: string,
  novasEncontradas: number,
  at: string = new Date().toISOString(),
): void {
  const plan = readPlan(planPath) as PlanWithGoal;
  const goal = (plan.goal && typeof plan.goal === "object" ? plan.goal : {}) as Record<
    string,
    unknown
  >;
  goal.last_convergence_scan = { at, novas_encontradas: novasEncontradas };
  plan.goal = goal;
  writePlan(planPath, plan);
}

// ---------------------------------------------------------------------------
// Re-classificação de issue JÁ no plano, não trabalhada por esta sessão (#10407)
// ---------------------------------------------------------------------------

/**
 * Motivos terminais de "não trabalhada por esta sessão" sujeitos à
 * re-classificação (#10407). `deixado-para-o-300` (e o alias legado
 * `deixado-para-o-helios`, #7682) é exclusivo do develop: a sessão deixou a
 * issue pro `300` porque ela era `overnight` NAQUELE momento.
 * `claimed-por-outra-sessao` só entra quando o chamador pede
 * (`includeClaimed`) — numa rodada overnight/continuo, issue re-roteada pra
 * develop/bloqueada não é trabalho da rodada, e acusá-la seria ruído
 * permanente.
 */
export const UNWORKED_300_MOTIVOS: ReadonlySet<string> = new Set([
  "deixado-para-o-300",
  "deixado-para-o-helios",
]);
export const UNWORKED_CLAIMED_MOTIVO = "claimed-por-outra-sessao";

/** Tracks que o `300` nunca pega sozinho — re-roteamento pra um deles deixa a
 * issue num buraco se a sessão já a marcou como "não minha". */
const RETRACK_HOLE_TRACKS: ReadonlySet<string> = new Set(["develop", "bloqueada"]);

export interface RetrackedUnworkedIssue {
  number: number;
  /** Motivo terminal gravado no plano (`deixado-para-o-300`, ...). */
  motivo: string;
  /** `exec_track_painel` gravado no plano, ou `null` se ausente. */
  track_gravado: string | null;
  /** Track atual por `classifyExecTrack` sobre as labels/body de agora. */
  track_atual: string;
}

interface PlanIssueEntryLike {
  number?: unknown;
  status?: unknown;
  motivo?: unknown;
  exec_track_painel?: unknown;
}

/** Pure: motivo terminal "não trabalhada" de uma entrada, ou `null`. Aceita
 * as duas formas vistas em `plan.json`: `status: "pulada"` + `motivo`
 * (develop 261018) e o motivo gravado direto em `status` (forma que
 * `findDeixadoPara300Buraco` também aceita). */
function unworkedMotivo(entry: PlanIssueEntryLike, includeClaimed: boolean): string | null {
  const candidates: unknown[] = [entry.status === "pulada" ? entry.motivo : undefined, entry.status];
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    if (UNWORKED_300_MOTIVOS.has(c)) return c;
    if (includeClaimed && c === UNWORKED_CLAIMED_MOTIVO) return c;
  }
  return null;
}

/**
 * Pure (#10407): entradas de `plan.issues` com status terminal "não
 * trabalhada por esta sessão" cujo track ATUAL (`classifyExecTrack` sobre as
 * labels de agora) virou `develop`/`bloqueada` e difere do
 * `exec_track_painel` gravado. Caso real (develop 261018): #10385/#10387/
 * #10393 gravadas `pulada`/`deixado-para-o-300`/`overnight`, re-roteadas pra
 * `develop` pelo overnight do `300` no meio da sessão — o gate de
 * convergência só olhava issue NOVA e deu "ok", a sessão fechou com
 * `Goal: atingido` e 3 issues develop abertas. Mesmo princípio do #5586:
 * herança não dispensa reverificação.
 *
 * Issue fechada (ausente de `openIssues`) não entra — saiu do backlog.
 * Track gravado já igual ao atual não entra — a sessão já sabia (e
 * `deixado-para-o-300` em track develop gravado é coberto por
 * `validate-develop-plan-motivo.ts`, #5907 b).
 */
export function findRetrackedUnworkedIssues(
  plan: PlanWithGoal,
  openIssues: ConvergenceScanIssue[],
  opts: { now?: Date; includeClaimed?: boolean } = {},
): RetrackedUnworkedIssue[] {
  const byNumber = new Map<number, ConvergenceScanIssue>();
  for (const issue of openIssues) byNumber.set(issue.number, issue);
  const out: RetrackedUnworkedIssue[] = [];
  const seen = new Set<number>();
  for (const entry of normalizeIssues<PlanIssueEntryLike>(
    plan as IssuesBearing<PlanIssueEntryLike>,
  )) {
    if (!entry || typeof entry.number !== "number" || !Number.isFinite(entry.number)) continue;
    // #10618: `openIssues` vem do repo default; entrada de outro repo com o
    // mesmo número nunca casa com ela.
    if (studioNumberOfPlanEntry(entry) === null) continue;
    if (seen.has(entry.number)) continue;
    const motivo = unworkedMotivo(entry, opts.includeClaimed === true);
    if (!motivo) continue;
    const open = byNumber.get(entry.number);
    if (!open) continue;
    const trackAtual = classifyExecTrack({ labels: open.labels, body: open.body, now: opts.now });
    if (!RETRACK_HOLE_TRACKS.has(trackAtual)) continue;
    const trackGravado =
      typeof entry.exec_track_painel === "string" ? entry.exec_track_painel : null;
    if (trackGravado === trackAtual) continue;
    seen.add(entry.number);
    out.push({ number: entry.number, motivo, track_gravado: trackGravado, track_atual: trackAtual });
  }
  return out.sort((a, b) => a.number - b.number);
}
