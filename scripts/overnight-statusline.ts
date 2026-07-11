#!/usr/bin/env npx tsx
/**
 * overnight-statusline.ts (#2184, #2250, #2255, #2803)
 *
 * Barra de progresso horizontal para a statusLine do Claude Code. Apesar do
 * nome (histórico — ver nota de rename abaixo), é FLUXO-NEUTRO desde #2637:
 * cobre edição, `/diaria-overnight` E `/diaria-develop`. Suporta quatro
 * fontes, com precedência definida:
 *
 *   1. Edição em curso (PRIORIDADE MÁXIMA — #2250):
 *      "{branch}  edição 260615  [██████░░░░░░] 3/7  Imagens"
 *      Encerrada: "{branch}  edição 260615  [████████████] 7/7  Agendamento"
 *      Um `stage-status.json` gravado por OUTRA MÁQUINA (sync via OneDrive
 *      junction `data/`, mesmo mecanismo do #3033 abaixo) também não sequestra
 *      a barra — ver `isForeignStageStatusDoc` (#3119: fail-open, compara
 *      `doc.machine_id` contra `getMachineId()` desta máquina, mesmo padrão
 *      de `isForeignDevelopPlan`).
 *
 *   2. Sessão /diaria-develop ativa (#2803 — abaixo da edição, acima do overnight):
 *      "{branch}  develop 260702  [████░░░░░░░░] 3/8  · desbloqueando"
 *      Mesmo critério de progresso/rótulo de `renderOvernightBar` (issues
 *      terminais em `plan.json`), só que lido de `data/develop/{AAMMDD}/`.
 *      Um `plan.json` de develop ANTIGO (sessão abandonada, dias atrás) não
 *      sequestra a barra — ver `isStaleDevelopPlan` (reusa o padrão de guard
 *      de zumbi introduzido no #2800: fail-open, threshold de tempo).
 *      Um `plan.json` de OUTRA MÁQUINA (sync via OneDrive junction `data/`)
 *      também não sequestra a barra, mesmo fresco/em progresso genuíno — ver
 *      `isForeignDevelopPlan` (#3033: fail-open, compara `plan.machine_id`
 *      contra `getMachineId()` desta máquina).
 *
 *   3. Rodada /diaria-overnight (FALLBACK quando não há edição nem develop ativos):
 *      "{branch}  [████████░░░░] 67%  (4/6)"
 *      Encerrada: "{branch}  [████████████] 100%  (N/N)"  (barra em 100%, sempre visível)
 *
 *   4. IDLE — barra presente sem edição, develop nem overnight (#2255):
 *      Sem edição alguma:  "{branch}  [████████████] Diar.ia · sem rodada ativa"
 *
 *   5. EDIÇÃO CONCLUÍDA sem develop/overnight (#2618): barra SOME — só o branch (ou "" em
 *      detached HEAD). Distinto do idle: "sem rodada ativa" é quando não há edição;
 *      "barra some" é quando a última edição terminou (todos stages terminais).
 *
 * Precedência: edição em curso > develop > overnight > idle > (edição concluída → barra some).
 * NOTA (#2618): a barra NÃO é mais sempre presente — após uma edição concluir, sem
 * develop/overnight, o output é só o branch (ou vazio). A composição vive em `renderStatusline`.
 *
 * Critério de "rodada encerrada" overnight/develop: TODAS as entradas de `issues` têm status
 * terminal (`mergeada` | `draft-ci-vermelho` | `pulada`). Quando encerrada,
 * mostra 100% e permanece visível — NÃO oculta (#2246, requisito do editor).
 *
 * Critério de "edição encerrada" (#2250): todos os stages têm status terminal
 * (`done` | `failed`). Quando encerrada, mostra N/N (7/7) e permanece visível
 * (espelhando #2246). A barra de develop/overnight volta ao display quando a edição encerra.
 *
 * Degrada graciosamente:
 *   - stage-status.json ausente/malformado → ignora (fallback develop/overnight)
 *   - rows ausente/vazio                   → ignora (fallback develop/overnight)
 *   - plan.json (overnight/develop) ausente    → idle bar (fora de rodada)
 *   - plan.json (overnight/develop) malformado → idle bar (sem throw)
 *   - total de issues = 0                      → idle bar
 *   - qualquer read failure                    → idle bar, nunca string vazia
 *
 * Rename considerado no #2803 (overnight-statusline.ts → statusline.ts) e descartado:
 * o path é referenciado por configs de statusLine já instaladas no editor
 * (`.claude/settings.json` / equivalente do usuário) — renomear quebraria
 * esses setups sem aviso. Preferido o menor-churn: só este docblock documenta
 * a natureza fluxo-neutra; o nome do arquivo fica histórico.
 *
 * Uso (Claude Code statusLine):
 *   npx tsx scripts/overnight-statusline.ts
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { StageStatusDoc, StageStatus } from "./update-stage-status.ts";
import { STAGE_LABELS, STAGES, loadDoc } from "./update-stage-status.ts";
import { sentinelExists, readSentinel } from "./lib/pipeline-state.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts"; // #2463/#3025: layout flat+nested
import { isValidEditionDir } from "./lib/edition-utils.ts"; // #3054: rejeita sentinels calendário-inválidos (ex: 260999)
import { getMachineId } from "./lib/machine-id.ts"; // #3033: filtra plan.json de develop de OUTRA máquina

// ─── tipos ────────────────────────────────────────────────────────────────────

/**
 * Todos os valores válidos de `status` em plan.json.
 * Fonte canônica: `.claude/skills/diaria-overnight/SKILL.md` (tabela de status possíveis).
 * Não-terminais: elegivel, precisa-resposta, bloqueada-externa, not-this-week, fora-do-escopo.
 * Terminais: mergeada, draft-ci-vermelho, pulada.
 */
export type IssueStatus =
  | "elegivel"
  | "precisa-resposta"
  | "bloqueada-externa"
  | "not-this-week"
  | "fora-do-escopo"
  | "mergeada"
  | "draft-ci-vermelho"
  | "pulada";

export interface PlanIssue {
  status: IssueStatus;
  /** Origem da issue no plano: initial, mid-round, finding-depth-1, finding-depth-2, etc. */
  source?: string;
  /**
   * #3131: indica se a issue de fato ENTROU no escopo de trabalho desta rodada,
   * gravado na classificação inicial da Fase 0 passo 4 (`.claude/skills/diaria-overnight/SKILL.md`).
   *
   * `true` — classificada `elegivel`/`precisa-resposta` no passo 4. Continua `true`
   * mesmo que a issue termine `pulada` DEPOIS de entrar (decido-depois no briefing,
   * ou mid-rodada na Fase 1: `sem-resposta`, `rescan-limit`, `ambigua`) — a decisão
   * de pular foi tomada trabalhando a fila, não antes dela, então é progresso real.
   *
   * `false` — excluída ANTES de entrar, já na varredura inicial do passo 4:
   * `bloqueada-externa`, `requer-sessao-local`, `not-this-week`, `fora-do-escopo`,
   * `ambígua/trade-off-real` (todas viram `pulada` sem nunca ser despachadas) — e
   * o EPIC `elegivel_especial` (#3071/#3072 — nunca despachado, fecha só quando a
   * issue-filha mergear).
   *
   * Ausente (plan.json legado, anterior a este campo) → tratar como `true`
   * (fail-open — mesmo padrão de `machine_id`/`review_1_5b_has_p2` ausentes).
   */
  in_round?: boolean;
  [key: string]: unknown;
}

export interface Plan {
  issues: PlanIssue[];
  /**
   * Nível atual da cadeia de re-entrada de findings.
   * 0 = fila principal, 1 = mini-rodada 1, 2 = mini-rodada 2.
   * Ausente em plan.json legado → tratar como 0.
   */
  findings_depth?: number;
  /**
   * Estado do review consolidado do nível atual.
   * null/ausente = review não iniciado/concluído neste nível.
   * "done (depth N)" = review concluído no nível N.
   * "skipped: <motivo> (depth N)" = review pulado no nível N.
   * Legado: "done" (sem depth) → tratar como concluído no nível corrente.
   * Na prática o valor gravado costuma trazer texto explicativo ANEXADO
   * após a tag canônica (ex: "done (depth 2) - depth limit reached, ...")
   * — `cycleLabel` casa por prefixo/substring, não igualdade exata (#3071).
   */
  review?: string | null;
  /**
   * Hostname da máquina que gravou este `plan.json` (#3033 — `getMachineId()`
   * de `scripts/lib/machine-id.ts`). Só relevante pra `data/develop/{AAMMDD}/`,
   * que sincroniza entre máquinas via OneDrive; `readTodayDevelopPlan` usa este
   * campo (`isForeignDevelopPlan`) pra ignorar sessões de OUTRA máquina.
   * Ausente em plan.json legado (pré-#3033) ou de overnight (não usado lá) —
   * tratado como "identidade desconhecida", nunca filtrado (fail-open).
   */
  machine_id?: string;
  [key: string]: unknown;
}

// ─── constantes ───────────────────────────────────────────────────────────────

// Qualquer status fora deste Set é considerado não-terminal por exclusão (open-world contract).
// Fix #2246 pt1: sufixo [a-z]? (zero ou UMA letra) para casar rodadas suplementares (260613b, 260613c, …).
// Single-letter suffix garante ordenação lexicográfica correta: 260613c > 260613b > 260613 > 260611.
// Dois sufixos (260613aa) mis-ordenariam lexicograficamente — não são gerados pelo pipeline.
export const OVERNIGHT_DIR_RE = /^\d{6}[a-z]?$/;
/**
 * `data/develop/{AAMMDD}/plan.json` (#2803) — mesmo schema do overnight
 * (SKILL.md: "Reusa o schema do overnight"). Sem sufixo de letra: diferente
 * do overnight, `/diaria-develop` não documenta rodadas suplementares no
 * mesmo dia (uma sessão supervisionada por AAMMDD).
 */
export const DEVELOP_DIR_RE = /^\d{6}$/;
const TERMINAL_STATUSES = new Set<IssueStatus>(["mergeada", "draft-ci-vermelho", "pulada"]);
const BAR_WIDTH = 12;

/**
 * #3071: status ad-hoc usado pelo overnight pra EPICs deliberadamente
 * deferidos — fecham só quando a issue-filha mergear, não antes (ver campo
 * `motivo` da própria issue no plan.json, ex: "epic - fechar se #NNNN
 * mergear"). Não é trabalho pendente real, então conta como terminal só
 * para fins de contagem/exibição da barra — fora do IssueStatus canônico
 * de propósito (não é um status que a fila principal deveria atribuir).
 *
 * Documentado em `.claude/skills/diaria-overnight/SKILL.md` (tabela de
 * status) como a fonte canônica pro escritor (o coordenador LLM) — exportado
 * daqui pra evitar reimplementar/duplicar o literal em cada consumidor de
 * plan.json (`render-overnight-timeline.ts`, `build-diaria-dashboard-data.ts`
 * também tratam esse status, #3072 review).
 */
export const EPIC_DEFERRED_STATUS = "elegivel_especial";

/** Terminal para fins de barra: status canônico terminal OU EPIC deferido (#3071). */
export function isTerminalForBar(status: string): boolean {
  return TERMINAL_STATUSES.has(status as IssueStatus) || status === EPIC_DEFERRED_STATUS;
}

/**
 * Verifica se a ÚLTIMA ocorrência de "(depth N)" em `value` é exatamente
 * pro `depth` informado — não a primeira, não qualquer ocorrência (revisão
 * do #3072 ao próprio #3071). Um `includes(\`(depth ${depth})\`)` puro dá
 * falso positivo se o motivo livre do "skipped:" citar o depth de OUTRA
 * rodada entre parênteses antes da tag real (ex: "skipped: ainda usando o
 * resultado de (depth 1) revisado, sem novidade (depth 2)" reportaria depth
 * 1 como concluído). Mesmo espírito do `startsWith` do branch "done": a tag
 * canônica é ANCORADA — aqui, ancorada como a ÚLTIMA tag da string, já que
 * o texto explicativo observado na prática é sempre ANEXADO depois dela.
 */
function lastDepthTagMatches(value: string, depth: number): boolean {
  const matches = [...value.matchAll(/\(depth (\d+)\)/g)];
  const last = matches.at(-1);
  return last !== undefined && Number(last[1]) === depth;
}

/** Stage statuses considered terminal for edition progress (#2250). */
const STAGE_TERMINAL_STATUSES = new Set<StageStatus>(["done", "failed"]);

/** Total number of stages (0–6) in an edition — derived from STAGES to stay in sync. */
const TOTAL_STAGES = STAGES.length;

/**
 * Guard de staleness (#2760): limiar acima do qual um stage preso em
 * `status: "running"` é tratado como ABANDONADO em vez de "em curso" pela
 * statusline.
 *
 * Threshold: 24h. Escopo deliberadamente restrito a rows com `status ===
 * "running"` (não "qualquer row não-terminal") — investigação #2760 confirmou
 * um caso legítimo de edição não-encerrada e MUITO mais velha que 24h que NÃO
 * deve ser tratada como abandonada: uma edição pode legitimamente parar com
 * Stage 4 `done` e Stage 5 `pending` — "requer input do editor... não fica
 * travada no gate" — e ficar assim por bem mais de 24h corridas se o editor
 * demorar a voltar. Esse padrão foi originalmente observado no run agendado
 * (`docs/scheduled-edicao-setup.md` — DEPRECATED desde #3259/260711, task
 * removida do Task Scheduler), que rodava Stages 0–4 às 14h e encerrava o
 * processo naturalmente nesse ponto, mas continua ocorrendo com qualquer uso
 * MANUAL de `/diaria-edicao` em que o editor rode até o Stage 4 e não volte
 * imediatamente pro gate do Stage 5 — a lógica do guard não depende do
 * runner agendado existir. Um doc assim nunca tem row `running` — só
 * `done`/`pending` — então o guard abaixo não o penaliza.
 *
 * Já o caso relatado na issue (`data/editions/260623/_internal/stage-status.json`,
 * `{ stage: 5, status: "running", start: "...02:23:06.933Z" }` que nunca
 * transicionou) tem exatamente uma row travada em `running` — é isso que o
 * guard detecta. `orchestrator-stage-4.md` confirma que mesmo o gate humano
 * (Stage 4) marca a row `running` só ENQUANTO apresenta o gate na MESMA sessão/
 * turno de chat (linha 50→443) — se o editor precisa de uma revisão longa fora
 * do terminal, o fluxo `"editar"` explicitamente devolve o status pra `pending`
 * (não deixa `running` pendurado) — logo `running` genuinamente parado por
 * várias horas é sempre sessão morta (terminal fechado, crash), nunca gate
 * humano em curso.
 *
 * Usa o `start` da própria row (gravado por `update-stage-status.ts` ao marcar
 * `running`); se ausente (runs legadas), cai pro `generated_at` do doc como
 * aproximação — mesmo padrão de fallback usado no backfill de `applyUpdate`.
 *
 * Threshold revisado 24h → 6h (#3000): o limiar original de 24h, embora correto
 * para NUNCA marcar falso-positivo, era grande demais pra cumprir o propósito real
 * do guard durante rodadas overnight longas — a statusLine é justamente o sinal
 * rápido de progresso que o editor consulta ao vivo durante essas rodadas. Incidente
 * real (260705/260706): Stage 5 travou em `running` às 01:42Z e ainda estava
 * mascarando a barra do Overnight 13h depois (15:41Z) — abaixo do limiar de 24h,
 * então `isStaleEditionDoc` (corretamente, dado o threshold da época) ainda
 * classificava a edição como "em curso" e a barra do Overnight, que estava
 * genuinamente ativa em paralelo, nunca aparecia. O guard em si (o `if
 * (isStaleEditionDoc(...)) continue;` em `readCurrentEditionDoc`) sempre existiu
 * e funcionava — o gap era o valor do threshold, não a lógica. 6h dá margem
 * generosa acima do maior caso legítimo de `running` prolongado observado até
 * agora — o gate humano do Stage 4 (~4.4h entre `21:17` e `01:41` num run real,
 * incluindo espera do editor) — sem deixar uma edição abandonada mascarar a
 * barra do Overnight por mais de meio turno de trabalho.
 */
export const EDITION_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

/**
 * Retorna true quando `doc` tem pelo menos 1 row `status: "running"` cujo
 * timestamp de início (`row.start`, ou `doc.generated_at` como fallback) é
 * mais antigo que `EDITION_STALE_THRESHOLD_MS` em relação a `now` — ou seja,
 * deve ser tratado como abandonado, não "em curso" (#2760).
 *
 * Escopo deliberado: rows `pending` (ainda não iniciadas, ex: Stage 5
 * aguardando disparo manual do editor após uma run que parou no Stage 4)
 * NUNCA contam como stale aqui, por mais velhas que sejam — só
 * `running` travado é sinal de abandono. Ver docblock de
 * `EDITION_STALE_THRESHOLD_MS` para o caso legítimo que isso evita.
 *
 * Fail-open por design: sem timestamp parseável (nem `row.start` nem
 * `doc.generated_at`) → false (nunca esconde uma edição por causa de metadado
 * malformado; degrada graciosamente como o resto do arquivo).
 */
export function isStaleEditionDoc(doc: StageStatusDoc, now: Date): boolean {
  const runningRows = doc.rows.filter((r) => r?.status === "running");
  if (runningRows.length === 0) return false;

  const docGeneratedAtMs = typeof doc.generated_at === "string" ? Date.parse(doc.generated_at) : NaN;

  // A row mais antiga travada em "running" é o sinal mais forte de stall —
  // se ela já passou do threshold, o doc inteiro é tratado como abandonado.
  let oldestRunningMs = Infinity;
  for (const row of runningRows) {
    const rowStartMs = typeof row.start === "string" ? Date.parse(row.start) : NaN;
    const effectiveMs = Number.isNaN(rowStartMs) ? docGeneratedAtMs : rowStartMs;
    if (!Number.isNaN(effectiveMs) && effectiveMs < oldestRunningMs) oldestRunningMs = effectiveMs;
  }
  if (!Number.isFinite(oldestRunningMs)) return false; // nenhum timestamp parseável — fail-open

  return now.getTime() - oldestRunningMs > EDITION_STALE_THRESHOLD_MS;
}

/**
 * IDLE bar default label — shown when there is NO active edition AND no overnight round.
 * (#2255) This is the "rescued product decision" — the editor confirmed the bar should
 * ALWAYS be present but did not specify idle content. The default below is pending
 * editor confirmation (flagged in PR body).
 *
 * To customize idle appearance: change IDLE_BAR_NO_EDITION_LABEL or renderIdleBar().
 * The bar is always full (12 × █) in idle mode — signals "nada em andamento, sistema OK".
 */
const IDLE_BAR_NO_EDITION_LABEL = "Diar.ia · sem rodada ativa";
/** Prefix for idle bar when a past edition exists: "Diar.ia · {AAMMDD} · pronto". */
const IDLE_BAR_EDITION_PREFIX = "Diar.ia";
const IDLE_BAR_EDITION_SUFFIX = "pronto";

// ─── função pura testável ─────────────────────────────────────────────────────

/**
 * Retorna o rótulo do ciclo/fase atual da rodada overnight.
 *
 * Determinístico (sem Date.now()) — derivado exclusivamente de `plan.json`.
 *
 * Lógica:
 *   1. Lê `findings_depth` (default 0 se ausente — legado).
 *   2. Filtra as issues "relevantes para o depth atual":
 *        - depth 0 → issues sem source "finding-depth-*" (initial, mid-round, ausente)
 *        - depth N → issues com source "finding-depth-N"
 *   3. Se TODAS as issues relevantes estão em status terminal E o review no depth
 *      atual ainda não foi concluído → estamos em review consolidado:
 *        depth 0 → "review 1.5", depth 1 → "review 1.5b", depth 2 → "review 1.5c"
 *   4. Caso contrário → fila ou mini-rodada:
 *        depth 0 → "fila principal", depth N ≥ 1 → "mini-rodada N"
 *
 * "Review concluído no depth N" = `plan.review` contém `"done (depth N)"`,
 * `"skipped: ... (depth N)"`, ou (legado) `"done"` (sem depth — tratado como
 * concluído no nível corrente).
 *
 * Robustez:
 *   - plan null/undefined → "fila principal" (nunca throw)
 *   - findings_depth ausente → tratar como 0 ("fila principal")
 *   - issues vazia → "fila principal" (sem issues relevantes a verificar)
 *   - issues sem campo source → contam no grupo "depth 0" (initial sem source)
 *
 * @param plan  Objeto do plan.json (ou null/undefined se ausente/malformado)
 * @returns     Rótulo do ciclo atual ("fila principal" | "mini-rodada N" | "review 1.5x")
 */
export function cycleLabel(plan: Plan | null | undefined): string {
  // Legado / ausente → fila principal
  if (!plan) return "fila principal";

  const depth = typeof plan.findings_depth === "number" ? plan.findings_depth : 0;
  const issues = Array.isArray(plan.issues) ? plan.issues : [];

  // Filtra issues relevantes para o depth atual.
  // depth 0: issues sem source "finding-depth-*" (initial, mid-round, ou sem campo source)
  // depth N: issues com source "finding-depth-N"
  const relevantIssues =
    depth === 0
      ? issues.filter((i) => {
          const src = typeof i?.source === "string" ? i.source : "";
          return !src.startsWith("finding-depth-");
        })
      : issues.filter((i) => {
          const src = typeof i?.source === "string" ? i.source : "";
          return src === `finding-depth-${depth}`;
        });

  // Verifica se o review do depth atual já foi concluído.
  // "done (depth N)" | "skipped: ... (depth N)" | legacy "done" (sem depth).
  // #3071: casamento por prefixo/substring, não igualdade exata — o valor real
  // gravado costuma trazer texto explicativo ANEXADO após a tag canônica
  // (ex: "done (depth 2) - depth limit reached, cadeia encerrada..."), o que
  // quebrava a igualdade estrita e prendia a barra em "review 1.5x" pra sempre
  // mesmo com a rodada genuinamente encerrada.
  const reviewValue = plan.review ?? null;
  const reviewDone =
    (depth === 0 && reviewValue === "done") // legado: somente depth 0
    || (typeof reviewValue === "string" && (
      reviewValue.startsWith(`done (depth ${depth})`)
      || (reviewValue.startsWith(`skipped:`) && lastDepthTagMatches(reviewValue, depth))
    ));

  // Verifica se TODAS as issues relevantes estão em status terminal.
  // issues vazia → allTerminal = false (bucket não-esgotado → permanece na fase ativa)
  const allTerminal =
    relevantIssues.length > 0
    && relevantIssues.every((i) => isTerminalForBar(String(i?.status ?? "")));

  // Se fila do depth esgotada E review ainda não concluído → estamos no review consolidado.
  if (allTerminal && !reviewDone) {
    if (depth === 0) return "review 1.5";
    if (depth === 1) return "review 1.5b";
    if (depth === 2) return "review 1.5c";
    // depth > 2 não documentado, mas retorna graciosamente
    return `review 1.5${"bcdefghijklmnopqrstuvwxyz"[depth - 1] ?? "?"}`;
  }

  // Fila ativa (não esgotada ou review já concluído).
  if (depth === 0) return "fila principal";
  return `mini-rodada ${depth}`;
}

/**
 * Renderiza a barra de progresso da rodada /diaria-overnight.
 *
 * @param plan  Objeto do plan.json (ou null/undefined se ausente/malformado)
 * @returns     String da barra, ou "" quando barra deve ser ocultada.
 *
 * Retorna "" quando:
 *   - plan é null/undefined
 *   - plan.issues é ausente ou não-array
 *   - issues.length === 0 (após filtrar por `in_round !== false`, #3131 — ver abaixo)
 *
 * Fix #2246 pt3: quando done >= total (rodada encerrada), mostra 100% e permanece
 * visível — NÃO retorna "" (requisito do editor: barra fica em 100% ao encerrar).
 *
 * #3131: o denominador (`total`) só considera issues que de fato ENTRARAM na
 * rodada — `issue.in_round !== false` (fail-open: campo ausente conta como
 * entrada, mesmo padrão dos demais campos opcionais de plan.json legado).
 * Issues excluídas já na Fase 0 passo 4 (`bloqueada-externa`, `requer-sessao-local`,
 * `not-this-week`, `fora-do-escopo`, `ambígua/trade-off-real`) e o EPIC deferido
 * `elegivel_especial` nunca foram trabalho real desta rodada — sem este filtro,
 * elas inflam o denominador (e, por serem `pulada`/terminal, também o numerador
 * em igual medida), distorcendo o sinal de progresso mostrado ao editor.
 */
export function renderOvernightBar(plan: Plan | null | undefined): string {
  // Degrada graciosamente: plan ausente ou malformado
  if (!plan) return "";
  if (!Array.isArray(plan.issues)) return "";
  const issues = plan.issues.filter((i) => i?.in_round !== false);
  if (issues.length === 0) return "";

  const total = issues.length;
  const done = issues.filter((i) => isTerminalForBar(String(i?.status ?? ""))).length;

  // Rótulo do ciclo/fase atual (#2298) — determinístico, sem relógio.
  const label = cycleLabel(plan);

  // Rodada encerrada: todas terminais → barra cheia 100% visível (#2246 pt3)
  if (done >= total) {
    const bar = "█".repeat(BAR_WIDTH);
    // #3071: com tudo terminal, "fila principal"/"mini-rodada N" (fallback de
    // fila ativa) nunca é um estado real — nada está rodando. Só "review
    // 1.5x" continua sendo sinal útil aqui (fila esgotada mas o review
    // consolidado do depth ainda não rodou) — preservado como está.
    const displayLabel = label.startsWith("review 1.5") ? label : "concluída";
    return `[${bar}] 100%  (${done}/${total})  · ${displayLabel}`;
  }

  // Fix #3: use Math.floor instead of Math.round to avoid showing 100% when not all done
  const pct = Math.floor((done / total) * 100);
  const filled = Math.floor((done / total) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;

  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `[${bar}] ${pct}%  (${done}/${total})  · ${label}`;
}

// ─── helpers internos ─────────────────────────────────────────────────────────

/** Funções de leitura injetáveis pra teste de `readPlanFromDir` (#3264). */
export interface PlanFileReaders {
  existsSync: typeof existsSync;
  readFileSync: typeof readFileSync;
}

const defaultPlanFileReaders: PlanFileReaders = { existsSync, readFileSync };

/**
 * Lê e parseia o plan.json de um diretório de rodada. Retorna null em qualquer erro.
 *
 * #3264: distingue dois cenários que o `catch` original tratava de forma idêntica:
 *   1. Arquivo genuinamente ausente → `null` IMEDIATO, sem retry (nenhuma rodada).
 *   2. Arquivo EXISTE mas `JSON.parse` falha (JSON truncado/inconsistente) — sinal de
 *      escrita não-atômica em progresso no exato momento da leitura. A statusline poll
 *      a cada 30s (`refreshInterval` em `.claude/settings.json`); qualquer poll que caia
 *      no meio de uma escrita de `plan.json` lia o arquivo parcial e mostrava "sem rodada
 *      ativa" por até 30s — falso negativo justo quando o editor mais precisa da barra.
 *      Nesse caso, tenta 1 retry síncrono IMEDIATO (sem sleep) antes de desistir — a
 *      janela de escrita de um JSON pequeno é tipicamente sub-ms a poucos ms, então um
 *      único re-read cobre a esmagadora maioria dos casos sem adicionar latência
 *      perceptível no caminho comum (arquivo estável).
 *
 * Risco residual (documentado por não ser 100% testável sem simular concorrência real
 * de processo): se a janela de escrita for mais longa que o intervalo entre as duas
 * leituras síncronas consecutivas (extremamente raro para um JSON de poucos KB), o
 * retry também falha e o comportamento cai de volta ao fallback idle por até um ciclo
 * de poll — mesmo pior caso do bug original, porém com probabilidade drasticamente
 * menor. Não escalamos para retry com delay (setTimeout) sem evidência concreta de que
 * o retry síncrono não é suficiente na prática — manter a versão mais simples per o
 * pedido da issue.
 */
export function readPlanFromDir(planPath: string, readers: PlanFileReaders = defaultPlanFileReaders): Plan | null {
  try {
    if (!readers.existsSync(planPath)) return null;
  } catch {
    return null;
  }

  // Arquivo existe: tenta ler+parsear, com 1 retry síncrono imediato se falhar.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = readers.readFileSync(planPath, "utf8");
      return JSON.parse(raw) as Plan;
    } catch {
      // attempt 0: tenta mais uma vez. attempt 1: cai pro `return null` abaixo.
    }
  }
  return null;
}

/**
 * Encontra a rodada corrente escaneando data/overnight/{AAMMDD[a-z]*}/plan.json.
 *
 * Fix #2246 pt2: retorna o plan do dir MAIS RECENTE que casa OVERNIGHT_DIR_RE e
 * tem issues.length > 0 — independentemente de a rodada estar em progresso ou
 * encerrada. O conceito anterior de "primeiro com não-terminal" causava o bug:
 * um plan antigo (260611) com status legado não-terminal sequestrava o bar
 * durante/após rodadas suplementares (260613b, 260613c) que a regex não casava.
 *
 * Novo contrato:
 *   - Mais-recente por nome de dir (sort lexicográfico desc, cobre sufixos a–z)
 *   - Deve ter issues.length > 0 (plan vazio é ignorado — não é rodada real)
 *   - Não importa se a rodada está em progresso ou encerrada; renderOvernightBar
 *     decide como exibir (100% quando encerrada, % parcial quando em progresso)
 *
 * Isso é determinístico e não depende do relógio — corrige #2184/Finding 1 e
 * o bug de sequestro por plan antigo (#2246).
 */
export function readTodayPlan(cwd: string): Plan | null {
  try {
    const overnightDir = join(cwd, "data", "overnight");
    if (!existsSync(overnightDir)) return null;

    const entries = readdirSync(overnightDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && OVERNIGHT_DIR_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse(); // most recent first (lexicographic: 260613c > 260613b > 260613 > 260611)

    if (entries.length === 0) return null;

    // Fix #2246 pt2: return the most-recent dir with a parseable plan that has issues.
    // Do NOT skip to older dirs just because the most-recent run is already terminal.
    for (const dirName of entries) {
      const planPath = join(overnightDir, dirName, "plan.json");
      const plan = readPlanFromDir(planPath);
      if (!plan) continue;
      if (!Array.isArray(plan.issues) || plan.issues.length === 0) continue;
      // First entry that passes → this is the current/latest run
      return plan;
    }

    return null;
  } catch {
    return null;
  }
}

// ─── /diaria-develop (#2803) ──────────────────────────────────────────────────

/** Plan de develop + o AAMMDD do diretório de onde foi lido (necessário pro rótulo da barra). */
export interface DevelopPlanEntry {
  id: string;
  plan: Plan;
}

/**
 * Guard de zumbi (#2800/#2803): um `plan.json` de `/diaria-develop` ANTIGO
 * (sessão abandonada dias atrás, nunca chegou a todos-terminal) não deve
 * sequestrar a barra pra sempre. Reusa o mesmo threshold + fail-open de
 * `isStaleEditionDoc` (#2800/#2760) — "mesma classe de zumbi", agora aplicada
 * a `plan.json` em vez de `stage-status.json`.
 *
 * Diferente de `isStaleEditionDoc` (que usa timestamps DENTRO do doc — `row.start`
 * / `generated_at`), aqui usamos o mtime do próprio arquivo em disco: `plan.json`
 * de develop é reescrito a cada iteração da sessão (SKILL.md: "Atualizar
 * plan.json" a cada onda) — mtime recente é prova direta de sessão viva, mesmo
 * quando a sessão atravessa a meia-noite (SKILL.md: "a sessão pode cruzar meia-
 * noite" — por isso NÃO filtramos por "dir é hoje", só por idade do arquivo).
 *
 * Fail-open: `statSync` falhar (arquivo sumiu entre o `existsSync` do caller e
 * aqui, permissão, etc.) → false (nunca esconde um plan por erro de leitura).
 */
export function isStaleDevelopPlan(
  planPath: string,
  now: Date,
  thresholdMs: number = EDITION_STALE_THRESHOLD_MS,
): boolean {
  try {
    const stat = statSync(planPath);
    return now.getTime() - stat.mtimeMs > thresholdMs;
  } catch {
    return false;
  }
}

/**
 * Guard cross-machine (#3033): um `plan.json` de `/diaria-develop` gravado por
 * OUTRA máquina (sincronizado via OneDrive junction `data/`, ver CLAUDE.md §
 * Setup) não deve sequestrar a barra desta máquina — mesmo quando está fresco
 * e em progresso genuíno, só que em OUTRA sessão. Complementar a
 * `isStaleDevelopPlan` (idade) — este guard é sobre IDENTIDADE, não idade: um
 * plan.json de outra máquina pode estar sendo reescrito ATIVAMENTE (mtime
 * recente a cada iteração da sessão remota) e ainda assim ser irrelevante
 * pra esta máquina.
 *
 * Contrato:
 *   - `plan.machine_id` ausente/vazio → identidade desconhecida (plan.json
 *     legado, gravado antes do #3033, ou hostname ilegível na origem) →
 *     fail-open, NUNCA filtra. Evita esconder uma sessão local legítima só
 *     porque foi criada antes do rollout deste campo.
 *   - `localMachineId` vazio (hostname ilegível nesta máquina) → não dá pra
 *     provar "é de outra máquina" → fail-open, NUNCA filtra.
 *   - Ambos presentes e diferentes → `true` (estrangeiro, deve ser ignorado).
 *   - Ambos presentes e iguais → `false` (é a própria sessão desta máquina).
 *
 * @param plan             Plan.json já parseado.
 * @param localMachineId   Hostname desta máquina (`getMachineId()`).
 * @returns                `true` quando o plan é de outra máquina e deve ser pulado.
 */
export function isForeignDevelopPlan(plan: Plan, localMachineId: string): boolean {
  const tag = typeof plan.machine_id === "string" ? plan.machine_id.trim() : "";
  if (tag === "") return false; // plan.json legado ou sem hostname na origem — fail-open
  const local = localMachineId.trim();
  if (local === "") return false; // não dá pra provar identidade local — fail-open
  return tag !== local;
}

/**
 * Guard cross-machine (#3119) — réplica exata de `isForeignDevelopPlan` (#3033),
 * só que para `StageStatusDoc` (edição em curso) em vez de `Plan` (develop).
 * `data/editions/{AAMMDD}/_internal/stage-status.json` sincroniza entre
 * máquinas via a mesma OneDrive junction `data/` — sem este guard, uma edição
 * rodando em OUTRA máquina sequestra a barra de "edição em curso" (prioridade
 * MÁXIMA, ver docblock do arquivo) desta máquina.
 *
 * Contrato (idêntico ao de `isForeignDevelopPlan`):
 *   - `doc.machine_id` ausente/vazio → identidade desconhecida (doc legado,
 *     gravado antes do #3119, ou hostname ilegível na origem) → fail-open,
 *     NUNCA filtra.
 *   - `localMachineId` vazio (hostname ilegível nesta máquina) → não dá pra
 *     provar "é de outra máquina" → fail-open, NUNCA filtra.
 *   - Ambos presentes e diferentes → `true` (estrangeiro, deve ser ignorado).
 *   - Ambos presentes e iguais → `false` (é a própria sessão desta máquina).
 *
 * @param doc              StageStatusDoc já parseado.
 * @param localMachineId   Hostname desta máquina (`getMachineId()`).
 * @returns                `true` quando o doc é de outra máquina e deve ser pulado.
 */
export function isForeignStageStatusDoc(doc: StageStatusDoc, localMachineId: string): boolean {
  const tag = typeof doc.machine_id === "string" ? doc.machine_id.trim() : "";
  if (tag === "") return false; // doc legado ou sem hostname na origem — fail-open
  const local = localMachineId.trim();
  if (local === "") return false; // não dá pra provar identidade local — fail-open
  return tag !== local;
}

/**
 * Encontra a sessão `/diaria-develop` corrente escaneando
 * `data/develop/{AAMMDD}/plan.json` (análogo a `readTodayPlan`, #2246 pt2).
 *
 * Contrato:
 *   - Sort lexicográfico desc (mais recente primeiro).
 *   - Deve ter `issues.length > 0` (plan vazio é ignorado — sessão não iniciou de fato).
 *   - `plan.json` mais velho que o threshold de staleness (`isStaleDevelopPlan`)
 *     é PULADO — não sequestra a barra; continua procurando em dirs mais antigos
 *     (mesmo comportamento de "cair pro próximo candidato" de `readCurrentEditionDoc`).
 *   - `plan.json` de OUTRA máquina (`isForeignDevelopPlan`, #3033) é PULADO pelo
 *     mesmo motivo — `data/` é um junction do OneDrive sincronizado entre
 *     máquinas; um plan.json fresco e em progresso genuíno, só que de outra
 *     sessão/computador, não deve aparecer como se fosse desta máquina.
 *   - Não importa se a sessão está em progresso ou encerrada (100% terminal) —
 *     `renderOvernightBar` decide como exibir; mesmo espírito de #2246 pt2.
 *   - Retorna `null` se não houver `data/develop/`, nenhum dir válido, ou todos
 *     os candidatos forem vazios/stale/estrangeiros.
 *
 * `now` é injetável (default `new Date()`) — mantém a função determinística e
 * testável sem relógio real, mesmo com o guard de staleness dependente de tempo.
 * `localMachineId` é injetável (default `getMachineId()`) pelo mesmo motivo —
 * testável sem depender do hostname real da máquina que roda os testes.
 */
export function readTodayDevelopPlan(
  cwd: string,
  now: Date = new Date(),
  localMachineId: string = getMachineId(),
): DevelopPlanEntry | null {
  try {
    const developDir = join(cwd, "data", "develop");
    if (!existsSync(developDir)) return null;

    const entries = readdirSync(developDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && DEVELOP_DIR_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse(); // most recent first (lexicographic desc)

    if (entries.length === 0) return null;

    for (const dirName of entries) {
      const planPath = join(developDir, dirName, "plan.json");
      const plan = readPlanFromDir(planPath);
      if (!plan) continue;
      if (!Array.isArray(plan.issues) || plan.issues.length === 0) continue;
      if (isStaleDevelopPlan(planPath, now)) continue; // #2800/#2803: zumbi — não sequestra a barra
      if (isForeignDevelopPlan(plan, localMachineId)) continue; // #3033: sessão de OUTRA máquina
      return { id: dirName, plan };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Renderiza a barra de progresso de uma sessão `/diaria-develop` ativa (#2803).
 *
 * Reusa `renderOvernightBar` (mesmo schema de `plan.json`, mesma lógica de
 * progresso/rótulo — fluxo-neutro desde #2637) e só prefixa `develop {AAMMDD}`
 * pra distinguir visualmente da barra de overnight (que não tem prefixo de id).
 *
 * @param entry  Doc + id do dir (ou null se nenhuma sessão develop ativa).
 * @returns      String da barra, ou "" quando deve ser ocultada (mesmas regras
 *               de `renderOvernightBar`: plan vazio/malformado → "").
 */
export function renderDevelopBar(entry: DevelopPlanEntry | null): string {
  if (!entry) return "";
  const inner = renderOvernightBar(entry.plan);
  if (!inner) return "";
  return `develop ${entry.id}  ${inner}`;
}

/**
 * Retorna o branch git atual (ex: "master"), ou "" em caso de erro ou detached HEAD.
 *
 * Edge cases:
 *   - detached HEAD → git rev-parse retorna "HEAD" → normalizado para "".
 *   - repo sem commits (zero-commit) → git rev-parse exits 128 → catch retorna "".
 *     (Comportamento intencional: statusline sem prefixo de branch, sem crash.)
 *   - sem repo git / erro de timeout → catch retorna "".
 */
function currentBranch(cwd: string): string {
  try {
    // git rev-parse retorna "HEAD" em detached HEAD, nome do branch em caso normal.
    // Em repo sem commits, exits 128 → catch retorna "" (ver JSDoc acima).
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    // "HEAD" → detached; "" → sem git; ambos → sem prefixo na barra.
    if (branch === "HEAD" || branch === "") return "";
    return branch;
  } catch {
    return "";
  }
}

// ─── edição em curso (#2250) ──────────────────────────────────────────────────

/**
 * Renderiza a barra de progresso de uma edição em curso (#2250).
 *
 * @param doc  Documento stage-status.json (ou null/undefined se ausente/malformado)
 * @returns    String da barra, ou "" quando deve ser ocultada.
 *
 * Retorna "" quando:
 *   - doc é null/undefined
 *   - doc.rows é ausente ou não-array
 *   - rows.length === 0
 *
 * Quando todos os stages são terminais (done/failed), mostra N/N e permanece
 * visível (espelhando #2246: barra encerrada é visível, não oculta).
 *
 * Formato: "edição AAMMDD  [██████░░░░░░] 3/7  Imagens"
 * Encerrada: "edição AAMMDD  [████████████] 7/7  Agendamento"
 */
export function renderEditionBar(doc: StageStatusDoc | null | undefined): string {
  if (!doc) return "";
  if (!Array.isArray(doc.rows)) return "";
  if (doc.rows.length === 0) return "";

  const rows = doc.rows;
  const total = TOTAL_STAGES; // always STAGES.length (stages 0–6)
  const done = rows.filter((r) => STAGE_TERMINAL_STATUSES.has(r?.status as StageStatus)).length;

  const editionId = doc.edition ?? "?";

  // All stages terminal → show N/N (encerrada, visível — mirrors #2246)
  // Guard placed early so label logic below only runs for in-progress editions.
  if (done >= total) {
    const bar = "█".repeat(BAR_WIDTH);
    // Pick the label by highest stage number (not array position) to handle out-of-order rows.
    const lastStageRow = rows.reduce(
      (max, r) => (r.stage > (max?.stage ?? -1) ? r : max),
      rows[0],
    );
    const lastLabel = STAGE_LABELS[lastStageRow?.stage ?? (TOTAL_STAGES - 1)] ?? "Agendamento";
    return `edição ${editionId}  [${bar}] ${total}/${total}  ${lastLabel}`;
  }

  // Find the current running stage for label display (in-progress path only).
  //
  // #2525: use HIGHEST-index running stage (not first) so that when Stage 5 is
  // still `running` AND Stage 6 has been marked `running` (gate presentation),
  // the bar shows "6/7 Agendamento" instead of "5/7 Publicação".
  // Also handles orphaned `running` stages from interrupted runs — the highest
  // running stage is always the most meaningful label to surface.
  //
  // Priority order:
  //   1. Highest-index stage with status "running"
  //   2. First stage with status "pending" (next stage to run — e.g. "6:pending"
  //      after Stage 5 done shows "Agendamento" not "Publicação")
  //   3. Last stage with status "done/failed" (fallback: last completed)
  //   4. rows[0] (absolute fallback)
  let highestRunningRow: typeof rows[0] | undefined;
  let firstPendingRow: typeof rows[0] | undefined;
  let lastDoneRow: typeof rows[0] | undefined;

  for (const row of rows) {
    if (row?.status === "running") {
      // Track highest-stage running row (rows may be out-of-order; compare by .stage)
      if (!highestRunningRow || row.stage > highestRunningRow.stage) {
        highestRunningRow = row;
      }
    } else if (row?.status === "pending") {
      // Track first pending row (stage order — rows are typically ordered 0→6)
      if (!firstPendingRow || row.stage < firstPendingRow.stage) {
        firstPendingRow = row;
      }
    } else if (STAGE_TERMINAL_STATUSES.has(row?.status as StageStatus)) {
      // Track last done/failed row by stage number
      if (!lastDoneRow || row.stage > lastDoneRow.stage) {
        lastDoneRow = row;
      }
    }
  }

  const displayRow = highestRunningRow ?? firstPendingRow ?? lastDoneRow ?? rows[0];
  const stageLabel = STAGE_LABELS[displayRow?.stage ?? 0] ?? `Stage ${displayRow?.stage ?? 0}`;

  const filled = Math.floor((done / total) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);

  return `edição ${editionId}  [${bar}] ${done}/${total}  ${stageLabel}`;
}

/**
 * Reconcilia rows presas em `status: "running"` cujo sentinel de conclusão do
 * stage (`.step-{N}-done.json`) já foi escrito (#2800).
 *
 * Root cause do #2800: `blockReasonForMarkingStageDone` (stage 6) exige
 * `edition-report.html`, gerado só DEPOIS do antigo ponto onde o orchestrator
 * chamava `update-stage-status --stage 6 --status done` — a chamada sempre
 * falhava (exit 1, doc não gravado), e a falha era tratada como "logar warn,
 * não bloquear". A row ficava `running` para sempre, mesmo com o sentinel do
 * stage já escrito (prova de que o trabalho terminou). A ordem foi corrigida
 * em `.claude/agents/orchestrator-stage-6.md` (§6b-7), mas isso só previne
 * NOVAS ocorrências — edições já afetadas (ex: 260702) ficam com o artefato
 * em disco desatualizado.
 *
 * Este guard é **read-only** (não persiste em disco — nunca escreve em
 * `data/`): sempre que um leitor (statusline, `send-edition-report.ts`, etc.)
 * carrega o doc, qualquer row `running` cujo sentinel do MESMO stage já exista
 * é tratada como `done` só para fins de EXIBIÇÃO. Autocura a barra sem exigir
 * reprocessar a edição nem editar o artefato manualmente.
 *
 * Escopo deliberado: só rows `running` (nunca `pending`/`failed`) — mesmo
 * critério de "trabalho em andamento que na verdade terminou" usado por
 * `autoUpdateStageStatusOnSentinel` (`scripts/pipeline-sentinel.ts`, #1563/#2374
 * também cobre `pending`, mas aqui o objetivo é só consertar a EXIBIÇÃO de um
 * caso já observado — `running` é o sintoma relatado no #2800).
 *
 * Fail-open: qualquer erro ao checar/ler o sentinel deixa a row como estava
 * (nunca lança, nunca esconde o doc original).
 */
export function reconcileZombieRunningRows(doc: StageStatusDoc, editionDir: string): StageStatusDoc {
  let changed = false;
  const newRows = doc.rows.map((r) => {
    if (r?.status !== "running") return r;
    let hasSentinel: boolean;
    try {
      hasSentinel = sentinelExists(editionDir, r.stage);
    } catch {
      return r;
    }
    if (!hasSentinel) return r;

    const sentinel = readSentinel(editionDir, r.stage);
    const end = r.end ?? sentinel?.completed_at ?? doc.generated_at;
    const startMs = r.start ? Date.parse(r.start) : NaN;
    const endMs = typeof end === "string" ? Date.parse(end) : NaN;
    const duration_ms =
      !Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs > startMs
        ? endMs - startMs
        : r.duration_ms;

    changed = true;
    return { ...r, status: "done" as StageStatus, end, duration_ms };
  });
  return changed ? { ...doc, rows: newRows } : doc;
}

/**
 * Lê e parseia stage-status.json de um diretório de edição.
 * Falls back to the legacy stage-status.md via loadDoc() for pre-#1216 editions.
 * Retorna null em qualquer erro ou se o formato for inválido.
 *
 * #2800: aplica `reconcileZombieRunningRows` antes de retornar — rows `running`
 * com sentinel de stage já escrito são exibidas como `done` (read-only, ver
 * docblock da função).
 */
function readStageStatusFromDir(editionDir: string): StageStatusDoc | null {
  try {
    const jsonPath = join(editionDir, "_internal", "stage-status.json");
    const editionId = editionDir.split(/[/\\]/).pop() ?? "";

    // Fast path: JSON sidecar exists — parse directly.
    if (existsSync(jsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as StageStatusDoc;
        // Finding #9: use typeof instead of falsy check so edition:'' is not rejected.
        if (typeof parsed.edition !== "string" || !Array.isArray(parsed.rows)) return null;
        return reconcileZombieRunningRows(parsed, editionDir);
      } catch {
        // corrupted JSON — fall through to loadDoc MD fallback
      }
    }

    // Finding #4: MD fallback for pre-#1216 editions (no stage-status.json).
    // loadDoc never throws and returns makeInitialDoc if neither JSON nor MD exist.
    const legacyMdPath = join(editionDir, "stage-status.md");
    if (!existsSync(legacyMdPath)) return null; // neither JSON nor MD — truly absent
    const doc = loadDoc(editionDir, editionId);
    // loadDoc returns makeInitialDoc (all-pending) when MD is unreadable — treat as null.
    if (typeof doc.edition !== "string" || !Array.isArray(doc.rows) || doc.rows.length === 0) {
      return null;
    }
    return reconcileZombieRunningRows(doc, editionDir);
  } catch {
    return null;
  }
}

/**
 * Detecta a edição EM CURSO mais recente escaneando data/editions/{AAMMDD}/_internal/stage-status.json.
 *
 * Contrato determinístico (espelha readTodayPlan):
 *   - Sort lexicográfico desc (mais recente primeiro — AAMMDD: 260615 > 260614)
 *   - "Em curso" = tem ao menos 1 stage `running` ou `done/failed` mas NÃO todos terminais.
 *     Uma edição onde todos stages são `done/failed` é ENCERRADA e retorna null — isso
 *     faz a overnight bar retomar o display (contrato docblock ln 27: "A barra de overnight
 *     volta ao display quando a edição encerra"). (Fix Finding #1.)
 *   - Edição all-pending (--init mas não rodando) também é ignorada — não é "em curso".
 *   - #2760: edição com row `running` travada há mais de `EDITION_STALE_THRESHOLD_MS`
 *     (ver `isStaleEditionDoc`) é tratada como ABANDONADA — pulada como se estivesse
 *     encerrada, para a overnight/idle bar assumir o display em vez da statusline
 *     continuar reportando uma run morta como "em curso".
 *   - Retorna null se não houver edição alguma em curso (ou só houver abandonadas).
 *
 * `now` é injetável (default `new Date()`) — mantém a função 100% testável e
 * determinística mesmo com o guard de staleness dependente de relógio (#2760;
 * mesmo padrão de `openProbability(m, now)` em
 * `scripts/merge-clarice-subscribers.ts`).
 * Chamadas sem passar `now` explicitamente continuam funcionando como antes.
 *
 * @param cwd  Raiz do projeto (cwd)
 * @param now  Instante de referência para o guard de staleness (default: `new Date()`)
 * @returns    StageStatusDoc da edição mais recente EM CURSO (não encerrada, não all-pending,
 *             não abandonada), ou null.
 */
/**
 * Varre data/editions/{AAMMDD}/ (desc) e retorna todos os docs com rows não-vazios.
 * Helper compartilhado entre readCurrentEditionDoc e readMostRecentEditionDoc —
 * elimina a duplicação do scan de diretório (Finding #2, #2624).
 */
function scanEditionDocs(cwd: string): StageStatusDoc[] {
  try {
    const editionsDir = join(cwd, "data", "editions");
    // #2463/#3025: enumera AMBOS os layouts (flat legado + nested novo) —
    // antes um `readdirSync(editionsDir)` direto perdia edições no layout
    // nested pós-#3023.
    const editionDirsByAammdd = enumerateEditionDirs(editionsDir);
    // #3066: filtra por isValidEditionDir ANTES de ordenar — mesmo guard já
    // usado por findMostRecentEditionId (#3054). enumerateEditionDirs só
    // valida estruturalmente (/^\d{6}$/), então um sentinel calendário-inválido
    // como "260999" (dia 99) ordenaria lexicograficamente acima de qualquer
    // data real de 2026 e, se tivesse um stage-status.json (mesmo all-pending),
    // "venceria" aqui — o caminho PRIMÁRIO usado por readCurrentEditionDoc e
    // readMostRecentEditionDoc, que #3054 não cobriu (só corrigiu o fallback).
    const entries = [...editionDirsByAammdd.keys()]
      .filter((name) => isValidEditionDir(name))
      .sort()
      .reverse(); // most recent first (lexicographic desc: 260615 > 260614 > ...)

    const docs: StageStatusDoc[] = [];
    for (const dirName of entries) {
      const editionDir = editionDirsByAammdd.get(dirName)!;
      const doc = readStageStatusFromDir(editionDir);
      if (!doc) continue;
      if (!Array.isArray(doc.rows) || doc.rows.length === 0) continue;
      docs.push(doc);
    }
    return docs;
  } catch {
    return [];
  }
}

export function readCurrentEditionDoc(
  cwd: string,
  now: Date = new Date(),
  localMachineId: string = getMachineId(),
): StageStatusDoc | null {
  for (const doc of scanEditionDocs(cwd)) {
    // Skip all-pending editions (--init'd but not yet running).
    const hasStarted = doc.rows.some((r) => r.status !== "pending");
    if (!hasStarted) continue;
    // Finding #1: skip fully-encerrada editions — overnight bar must resume when edition ends.
    const isEncerrada = doc.rows.every((r) => STAGE_TERMINAL_STATUSES.has(r.status));
    if (isEncerrada) continue;
    // #2760: skip editions with a "running" row stuck past the staleness threshold —
    // treated as abandoned, same as encerrada, so the bar doesn't lie about "em curso".
    if (isStaleEditionDoc(doc, now)) continue;
    // #3119: skip stage-status.json written by ANOTHER machine (synced via the
    // OneDrive `data/` junction) — same guard as `isForeignDevelopPlan` (#3033),
    // falls through to the next candidate (mirrors readTodayDevelopPlan).
    if (isForeignStageStatusDoc(doc, localMachineId)) continue;
    // First in-progress edition → return it.
    return doc;
  }
  return null;
}

// ─── idle bar (#2255) ────────────────────────────────────────────────────────

/**
 * Renderiza a barra IDLE — mostrada quando não há edição ativa nem rodada overnight.
 * (#2255) Barra SEMPRE visível: nunca retorna string vazia.
 *
 * @param mostRecentEditionId  AAMMDD da edição mais recente no disco, ou null se nenhuma existe.
 * @returns  String da barra idle (nunca vazia).
 *
 * Formato com edição passada:  "[████████████] Diar.ia · 260617 · pronto"
 * Formato sem edição alguma:   "[████████████] Diar.ia · sem rodada ativa"
 *
 * A barra é sempre 100% cheia em modo idle — sinaliza "sistema OK, nada em andamento".
 * O label é um único bloco claramente comentado (constantes IDLE_BAR_*) — trivialmente
 * alterável pelo editor sem tocar na lógica.
 */
export function renderIdleBar(mostRecentEditionId: string | null): string {
  const fullBar = "█".repeat(BAR_WIDTH);
  const label = mostRecentEditionId
    ? `${IDLE_BAR_EDITION_PREFIX} · ${mostRecentEditionId} · ${IDLE_BAR_EDITION_SUFFIX}`
    : IDLE_BAR_NO_EDITION_LABEL;
  return `[${fullBar}] ${label}`;
}

/**
 * Encontra o AAMMDD da edição mais recente em data/editions/, independentemente de
 * estar em curso ou encerrada. Usado exclusivamente para o rótulo idle.
 *
 * Retorna null se o dir data/editions/ não existe ou não contém dirs AAMMDD válidos.
 * Nunca lança exceção.
 */
export function findMostRecentEditionId(cwd: string): string | null {
  try {
    const editionsDir = join(cwd, "data", "editions");
    // #2463/#3025: enumera AMBOS os layouts (flat legado + nested novo).
    // #3054: filtra por isValidEditionDir ANTES de ordenar — enumerateEditionDirs só
    // valida estruturalmente (/^\d{6}$/), então um sentinel calendário-inválido como
    // "260999" (dia 99) ordena lexicograficamente acima de qualquer data real de 2026.
    const entries = [...enumerateEditionDirs(editionsDir).keys()]
      .filter((name) => isValidEditionDir(name))
      .sort()
      .reverse(); // most recent first (lexicographic desc)

    return entries[0] ?? null;
  } catch {
    return null;
  }
}

// ─── função pura de composição (#2618) ───────────────────────────────────────

/**
 * Compõe a string de output da statusline a partir do estado pré-carregado.
 *
 * Função pura testável — não lê disco, não chama git. Toda I/O fica no CLI entrypoint.
 *
 * Precedência (#2255, atualizado #2618, #2803):
 *   1. Edição EM CURSO (started, não encerrada) → renderEditionBar
 *   2. Sessão /diaria-develop ativa → renderDevelopBar (#2803, só quando sem edição em curso)
 *   3. Rodada overnight ativa/encerrada → renderOvernightBar (só quando sem edição nem develop)
 *   4. Edição CONCLUÍDA (todas terminais) + sem develop/overnight → string vazia (#2618: barra some)
 *   5. Idle sem edição → renderIdleBar (fallback padrão)
 *
 * #2618: quando a edição mais recente está concluída (todos stages terminais) e não há
 * develop/overnight ativa, a barra desaparece (retorna ""). A intenção é sinalizar "turno
 * encerrado sem atividade" — diferente de "sem edição" (que mostra idle com "sem rodada ativa").
 *
 * @param editionDoc       doc da edição EM CURSO (null quando nenhuma ou encerrada)
 * @param plan             plan.json overnight (null quando sem rodada)
 * @param mostRecentEditionId  AAMMDD da edição mais recente em disco (ou null)
 * @param mostRecentDoc    doc da edição mais recente em disco (encerrada ou em curso; null se nenhuma).
 *                         Quando `editionDoc` é não-null, passar o mesmo doc (ou qualquer valor —
 *                         o encerrada-check usa `editionDoc === null` por construção, eliminando
 *                         o estado contraditório editionDoc≠null + encerrada=true (#2624 Finding 1)).
 * @param branch           branch git atual (ou "" em detached/sem repo)
 * @param developEntry     sessão /diaria-develop ativa (null quando nenhuma) — #2803, parâmetro
 *                         opcional no fim pra não quebrar call sites posicionais existentes.
 * @returns                string da statusline (pode ser "" quando edição concluída sem develop/overnight)
 */
export function renderStatusline(
  editionDoc: StageStatusDoc | null,
  plan: Plan | null,
  mostRecentEditionId: string | null,
  mostRecentDoc: StageStatusDoc | null,
  branch: string,
  developEntry: DevelopPlanEntry | null = null,
): string {
  // #2624 Finding 1: derivar encerrada internamente garante consistência por construção.
  // Quando editionDoc é não-null, a edição está em curso — encerrada é sempre false.
  // Quando editionDoc é null, verificamos o mostRecentDoc para saber se está encerrada.
  const mostRecentEditionEncerrada =
    editionDoc === null &&
    mostRecentDoc !== null &&
    Array.isArray(mostRecentDoc.rows) &&
    mostRecentDoc.rows.length > 0 &&
    mostRecentDoc.rows.every((r) => STAGE_TERMINAL_STATUSES.has(r.status as StageStatus));

  // Source 1: Edição em curso (não encerrada).
  const editionBar = renderEditionBar(editionDoc);

  // Source 2 (#2803): sessão /diaria-develop ativa — só quando sem edição em curso.
  const developBar = editionBar ? "" : renderDevelopBar(developEntry);

  // Source 3: Rodada overnight — só quando sem edição em curso nem develop ativo.
  const overnightBar = editionBar || developBar ? "" : renderOvernightBar(plan);

  // Source 4: fallback — só entra quando não há editionBar, developBar nem overnightBar.
  // #2618: se a edição mais recente está concluída → barra some (""); senão idle bar (#2255).
  // (A primeira condição é redundante via short-circuit do `||` abaixo, mas torná-la
  //  explícita evita computar renderIdleBar quando já há bar.)
  const fallback = mostRecentEditionEncerrada ? "" : renderIdleBar(mostRecentEditionId);

  const bar = editionBar || developBar || overnightBar || fallback;

  // Sem nenhuma barra → retornar só o branch (se houver), sem espaços extras.
  if (!bar) return branch;

  return branch ? `${branch}  ${bar}` : bar;
}

/**
 * Lê a edição mais recente do disco (encerrada ou em curso) e retorna seu doc,
 * independentemente do estado. Usado para checar se está encerrada (#2618).
 *
 * Difere de readCurrentEditionDoc: não filtra edições encerradas.
 * Retorna null se não houver nenhuma edição no disco.
 */
export function readMostRecentEditionDoc(cwd: string): StageStatusDoc | null {
  // Reusa scanEditionDocs — o predicado aqui é "qualquer edição com rows",
  // que é exatamente o que o scan já filtra. Retorna o mais recente (índice 0).
  return scanEditionDocs(cwd)[0] ?? null;
}

// ─── CLI (entrypoint) ─────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
  const cwd = process.cwd();
  const branch = currentBranch(cwd);

  // Load state — all I/O here, renderStatusline is pure.
  const editionDoc = readCurrentEditionDoc(cwd);
  const plan = readTodayPlan(cwd);
  const developEntry = readTodayDevelopPlan(cwd); // #2803

  // #2618: when editionDoc is non-null the edition is in-progress (readCurrentEditionDoc
  // skips encerrada), so it can't be encerrada; only scan for the most-recent doc otherwise.
  const mostRecentDoc = editionDoc ?? readMostRecentEditionDoc(cwd);

  // Derive the most-recent edition id from the SAME doc used for the encerrada check.
  // (Previously a separate findMostRecentEditionId scan could disagree — e.g. a freshly
  //  --init'd edition dir without a stage-status.json — producing an id from one edition
  //  and an encerrada verdict from another. Deriving from mostRecentDoc keeps them in sync.)
  const mostRecentEditionId = mostRecentDoc?.edition ?? findMostRecentEditionId(cwd);

  // #2624 Finding 1: encerrada-check agora é derivado internamente em renderStatusline.
  // Passamos mostRecentDoc diretamente — a função garante consistência por construção.
  const output = renderStatusline(editionDoc, plan, mostRecentEditionId, mostRecentDoc, branch, developEntry);
  process.stdout.write(output + "\n");
}
