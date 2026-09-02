/**
 * scripts/lib/ads-kill-switch.ts (#5239)
 *
 * Lógica PURA do kill switch por custo das campanhas de anúncio pagas
 * (teste de 3 canais, #5524). Nenhuma função deste módulo toca disco/rede —
 * `scripts/ads-kill-switch-alarm.ts` é o único caller que faz I/O (lê o
 * histórico local, manda e-mail, registra a issue de alarme, tenta a
 * pausa). Mesmo padrão de `ads-test-watch.ts`/`cac.ts`: decisão pura +
 * shell de I/O fino.
 *
 * ## O desenho aprovado (comentário do editor, 21/08/2026, #5239)
 *
 * "O teto por assinante ativo foi revogado em 260814 — não existe mais
 * linha de corte fixa. [...] Então o kill switch não deve ser um limiar
 * absoluto herdado do teto morto: é degradação relativa (do próprio braço
 * ao longo do tempo, ou contra os outros braços da mesma rodada)."
 *
 * Duas condições, cada uma suficiente sozinha (OR, não AND — degradar
 * contra a própria história OU contra os irmãos já é sinal, não precisam
 * coincidir):
 *
 *   1. **`self-degradation`** — o custo por leitor de HOJE do braço é mais
 *      caro que `selfDegradationRatio`× a mediana da própria série
 *      histórica (excluindo a janela de assentamento inicial).
 *   2. **`cross-arm-degradation`** — o custo por leitor de HOJE do braço é
 *      mais caro que `crossArmDegradationRatio`× o MENOR custo por leitor
 *      entre os OUTROS braços elegíveis da mesma rodada, na mesma data.
 *
 * ## Guardrails obrigatórios da issue (checklist literal)
 *
 *   - [x] Só pausa — `PauseExecutor` (ver abaixo) não aceita nenhum outro
 *     parâmetro além de braço/motivo; não há como expressar lance,
 *     orçamento ou segmentação através desta interface, por construção.
 *   - [x] Nunca dispara com `n` insuficiente — `guardrails.minLeitores` é
 *     checado ANTES de qualquer cálculo de degradação (`evaluateArmKillSwitch`
 *     retorna `evaluated: false, skipReason: "insufficient-n"` sem chegar
 *     a comparar nada).
 *   - [x] Nunca dispara na primeira janela — `guardrails.minDaysSinceD0`
 *     (dias corridos desde o D0 do braço) é checado antes de qualquer
 *     outra coisa (`skipReason: "within-settle-window"`).
 *   - [x] Alarme por e-mail sempre — responsabilidade do CALLER
 *     (`ads-kill-switch-alarm.ts`): ele monta o e-mail pra toda rodada
 *     avaliada, independente de pausa ter sido tentada, decidida ou
 *     bloqueada pelo toggle. Este módulo não decide ISSO (é I/O), mas
 *     `buildKillSwitchAlarmEmail` abaixo é a função pura que constrói o
 *     corpo, chamada incondicionalmente por quem tem `evaluated/triggered`.
 *   - [x] Kill switch do próprio kill switch — `scripts/lib/ads-kill-switch-enabled.ts`
 *     (arquivo irmão, mesmo molde de `clarice-novos-enabled.ts`): default
 *     `enabled: false`, ligar exige `--set enabled` explícito.
 *   - [x] Log auditável — `PauseEvent` carrega `reasons` (com os números
 *     que motivaram: custo atual, baseline, razão) + `executionAttempted`/
 *     `executionOk`/`executionDetail`; `ads-kill-switch-alarm.ts` grava
 *     cada evento num JSONL append-only.
 *
 * ## Nunca toca API paga — por construção, não por disciplina (LIMITE DURO)
 *
 * `PauseExecutor` é uma interface injetável. O único executor exportado por
 * este módulo é `notWiredPauseExecutor`, que NUNCA faz nenhuma chamada de
 * rede — sempre devolve `{ ok: false }` explicando que pausar exige ação
 * manual (painel da plataforma) ou uma sessão Claude Code com o conector de
 * escrita apropriado sob gate humano (ex: Meta Ads MCP, `docs/meta-ads-mcp-tools.md`
 * — "qualquer tool marcada ESCRITA é proibida fora de gate humano
 * supervisionado"). Nenhum script deste repo instancia um executor
 * diferente hoje — wiring de um executor real é decisão FUTURA e
 * deliberadamente fora do escopo desta unidade (#5239: "a data bloqueia
 * RODAR/decidir a pausa, não escrever o código" — o código nasce completo
 * e seguro por construção, a decisão de plugar uma pausa real fica pra
 * quando #5524/#5236 tiverem gasto real e o editor decidir armar).
 */

import { daysBetween, type DateOnlyString } from "./ads-test-schedule.ts";
import { median } from "./acquisition-health.ts";

// ---------------------------------------------------------------------------
// Amostra diária por braço — insumo que o caller (I/O) monta a partir do
// histórico reconciliado (ver scripts/ads-kill-switch-alarm.ts).
// ---------------------------------------------------------------------------

export interface ArmCostSample {
  braco: string;
  date: DateOnlyString;
  /** Tamanho de amostra do dia — leitores-v1 (`scripts/lib/leitor.ts`)
   *  atribuídos a este braço até esta data. Nunca `cadastros`/`cliques` —
   *  o piso de `n` da issue é explicitamente sobre LEITORES, a unidade de
   *  qualidade do projeto (CLAUDE.md, "a unidade de qualidade é LEITOR"). */
  leitores: number;
  /** Custo por leitor do braço nesta data (`gasto_acumulado / leitores`) —
   *  sempre finito e > 0 quando a amostra existe; uma amostra sem custo
   *  calculável (leitores=0/gasto=0) simplesmente não deveria virar uma
   *  `ArmCostSample` (ver `buildArmCostSamplesFromRows` abaixo). */
  custoPorLeitor: number;
}

/** Insumo mínimo (duck-typed, nunca importa `ClicksCsvRow` de
 *  `ads-test-watch.ts` diretamente — este módulo permanece agnóstico da
 *  fonte de dados) pra derivar `ArmCostSample[]`. Casa estruturalmente com
 *  `ClicksCsvRow` (que carrega `leitoresAcumulado` desde #5239) sem
 *  depender do tipo dele. */
export interface CostPerLeitorSourceRow {
  canal: string;
  data_apuracao: DateOnlyString;
  gasto_acumulado: number;
  leitoresAcumulado?: number | null;
}

/**
 * Deriva `ArmCostSample[]` a partir de linhas de `gasto_acumulado`/
 * `leitoresAcumulado` (cumulativos, mesma convenção de `clicks-2608.csv`) —
 * uma amostra por linha que TEM `leitoresAcumulado` válido (`> 0`). Linha
 * sem essa coluna preenchida (`undefined`/`null`, editor ainda não
 * reconciliou) ou com `leitoresAcumulado === 0` NUNCA vira amostra — custo
 * por leitor com denominador zero seria infinito/indefinido, e este módulo
 * nunca fabrica esse valor (mesma disciplina de `cac.ts`:
 * `custoPorLeitor: null` em vez de `Infinity`). Um braço/data sem amostra
 * aqui é indistinguível de "sem dado" pra `evaluateArmKillSwitch`
 * (`skipReason: "no-sample-for-date"`), nunca tratado como "ok".
 *
 * @pure
 */
export function buildArmCostSamplesFromRows(rows: readonly CostPerLeitorSourceRow[]): ArmCostSample[] {
  const samples: ArmCostSample[] = [];
  for (const row of rows) {
    const leitores = row.leitoresAcumulado;
    if (leitores == null || leitores <= 0) continue;
    samples.push({
      braco: row.canal,
      date: row.data_apuracao,
      leitores,
      custoPorLeitor: row.gasto_acumulado / leitores,
    });
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Guardrails
// ---------------------------------------------------------------------------

export interface KillSwitchGuardrails {
  /** Piso de leitores na coorte do braço, na data avaliada, antes de
   *  qualquer decisão — "nunca dispara com n insuficiente" (checklist da
   *  issue, item 2). */
  minLeitores: number;
  /** Dias corridos desde o D0 do braço antes de começar a avaliar —
   *  "nunca dispara na primeira janela de um canal novo" (checklist da
   *  issue, item 3). */
  minDaysSinceD0: number;
  /** Razão mínima (custo atual ÷ mediana da própria série) pra classificar
   *  como `self-degradation`. */
  selfDegradationRatio: number;
  /** Razão mínima (custo atual ÷ menor custo entre os outros braços) pra
   *  classificar como `cross-arm-degradation`. */
  crossArmDegradationRatio: number;
  /** Nº mínimo de amostras históricas (fora da janela de assentamento)
   *  necessárias pra calcular uma baseline própria confiável — com menos
   *  que isso, `self-degradation` nunca é avaliada (não é "não degradou",
   *  é "sem baseline pra comparar" — `cross-arm-degradation` continua
   *  avaliável independentemente). */
  minBaselineSamples: number;
}

/**
 * Defaults PROVISÓRIOS — mesma disciplina de `DEFAULT_PLANNED_DAILY_BUDGET_BRL`
 * em `ads-test-watch.ts`: um valor de negócio plausível, documentado,
 * sempre overridable via CLI (`ads-kill-switch-alarm.ts --min-leitores` etc)
 * — quem decide de verdade é a medição ao vivo depois de #5524 ter gasto
 * real, não este número congelado antes de qualquer dado existir.
 *
 * `2×` (self e cross-arm) reusa a mesma magnitude já estabelecida no
 * projeto pra "sinal de problema real, não ruído de dia isolado" —
 * `evaluateSpendOverageDeathCondition` (`ads-test-watch.ts`) usa a mesma
 * razão pra gasto acumulado acima do planejado. `minDaysSinceD0 = 3` é
 * metade do período de "primeira janela avaliável" (a semana costuma ser a
 * unidade de estabilização citada no protocolo do teste 2608) e nunca
 * dispara nos 3 primeiros dias de vida de um braço, quando o custo inicial
 * é sabidamente ruim.
 */
export const DEFAULT_KILL_SWITCH_GUARDRAILS: KillSwitchGuardrails = {
  minLeitores: 10,
  minDaysSinceD0: 3,
  selfDegradationRatio: 2,
  crossArmDegradationRatio: 2,
  minBaselineSamples: 2,
};

// ---------------------------------------------------------------------------
// Avaliação — pura
// ---------------------------------------------------------------------------

export type KillSwitchSkipReason = "insufficient-n" | "within-settle-window" | "no-sample-for-date";

export type KillSwitchReasonKind = "self-degradation" | "cross-arm-degradation";

export interface KillSwitchReasonDetail {
  kind: KillSwitchReasonKind;
  /** Custo por leitor do braço na data avaliada. */
  currentCustoPorLeitor: number;
  /** Baseline contra a qual `current` foi comparado — mediana da própria
   *  série (self) ou menor custo entre os outros braços (cross-arm). */
  baselineCustoPorLeitor: number;
  /** `currentCustoPorLeitor / baselineCustoPorLeitor` — sempre > `thresholdRatio`
   *  quando este `KillSwitchReasonDetail` existe (é o que fez disparar). */
  ratio: number;
  thresholdRatio: number;
}

export interface KillSwitchEvaluation {
  braco: string;
  asOfDate: DateOnlyString;
  /** `false` = os guardrails de entrada (n, janela de assentamento, ou
   *  ausência de amostra na data) impediram QUALQUER avaliação de
   *  degradação — `reasons` sempre vazio nesse caso. */
  evaluated: boolean;
  skipReason: KillSwitchSkipReason | null;
  current: ArmCostSample | null;
  /** `true` só quando `evaluated` e pelo menos 1 razão disparou. */
  triggered: boolean;
  reasons: KillSwitchReasonDetail[];
}

/** Mediana do `custoPorLeitor` do PRÓPRIO braço, em amostras anteriores a
 *  `beforeDate` e fora da janela de assentamento (`daysBetween(d0, date) >=
 *  minDaysSinceD0`) — a baseline contra a qual `self-degradation` compara.
 *  `null` sem amostras suficientes (`< guardrails.minBaselineSamples`).
 *  @pure */
export function computeSelfBaseline(
  history: readonly ArmCostSample[],
  braco: string,
  beforeDate: DateOnlyString,
  d0: DateOnlyString,
  guardrails: KillSwitchGuardrails,
): number | null {
  const eligible = history.filter(
    (s) => s.braco === braco && s.date < beforeDate && daysBetween(d0, s.date) >= guardrails.minDaysSinceD0,
  );
  if (eligible.length < guardrails.minBaselineSamples) return null;
  return median(eligible.map((s) => s.custoPorLeitor));
}

/** Menor `custoPorLeitor` entre os OUTROS braços elegíveis na MESMA data —
 *  a baseline contra a qual `cross-arm-degradation` compara. Um braço
 *  irmão só entra se ele mesmo cruzar o piso de `n` e a janela de
 *  assentamento na data avaliada (mesma disciplina aplicada ao braço sob
 *  avaliação — nunca comparar contra um irmão que também não teria dado
 *  pra avaliar sozinho). `null` sem nenhum irmão elegível nesta data.
 *  @pure */
export function computeCrossArmFloor(
  history: readonly ArmCostSample[],
  asOfDate: DateOnlyString,
  otherBracos: readonly string[],
  d0: DateOnlyString,
  guardrails: KillSwitchGuardrails,
): number | null {
  const eligibleCosts: number[] = [];
  for (const braco of otherBracos) {
    const sample = history.find((s) => s.braco === braco && s.date === asOfDate);
    if (!sample) continue;
    if (sample.leitores < guardrails.minLeitores) continue;
    if (daysBetween(d0, asOfDate) < guardrails.minDaysSinceD0) continue;
    eligibleCosts.push(sample.custoPorLeitor);
  }
  if (eligibleCosts.length === 0) return null;
  return Math.min(...eligibleCosts);
}

/**
 * Avalia UM braço numa data — o núcleo do kill switch. Ordem de checagem
 * (guardrails de entrada ANTES de qualquer comparação, nunca depois):
 *
 *   1. Janela de assentamento (`minDaysSinceD0`) — se ainda não passou,
 *      `skipReason: "within-settle-window"` e para aí.
 *   2. Amostra existe pra esta data/braço? Sem amostra, `skipReason:
 *      "no-sample-for-date"` (histórico incompleto, não "ok").
 *   3. Piso de `n` (`minLeitores`) — se a amostra do dia não cruza,
 *      `skipReason: "insufficient-n"`.
 *   4. Só então: calcula `self-degradation` (se houver baseline própria) e
 *      `cross-arm-degradation` (se houver irmão elegível) — cada um
 *      independente, ambos podem disparar juntos, nenhum é obrigatório.
 *
 * @pure
 */
export function evaluateArmKillSwitch(
  history: readonly ArmCostSample[],
  braco: string,
  asOfDate: DateOnlyString,
  otherBracos: readonly string[],
  d0: DateOnlyString,
  guardrails: KillSwitchGuardrails = DEFAULT_KILL_SWITCH_GUARDRAILS,
): KillSwitchEvaluation {
  if (daysBetween(d0, asOfDate) < guardrails.minDaysSinceD0) {
    return { braco, asOfDate, evaluated: false, skipReason: "within-settle-window", current: null, triggered: false, reasons: [] };
  }

  const current = history.find((s) => s.braco === braco && s.date === asOfDate) ?? null;
  if (!current) {
    return { braco, asOfDate, evaluated: false, skipReason: "no-sample-for-date", current: null, triggered: false, reasons: [] };
  }

  if (current.leitores < guardrails.minLeitores) {
    return { braco, asOfDate, evaluated: false, skipReason: "insufficient-n", current, triggered: false, reasons: [] };
  }

  const reasons: KillSwitchReasonDetail[] = [];

  const selfBaseline = computeSelfBaseline(history, braco, asOfDate, d0, guardrails);
  if (selfBaseline != null && selfBaseline > 0) {
    const ratio = current.custoPorLeitor / selfBaseline;
    if (ratio > guardrails.selfDegradationRatio) {
      reasons.push({
        kind: "self-degradation",
        currentCustoPorLeitor: current.custoPorLeitor,
        baselineCustoPorLeitor: selfBaseline,
        ratio,
        thresholdRatio: guardrails.selfDegradationRatio,
      });
    }
  }

  const crossArmFloor = computeCrossArmFloor(history, asOfDate, otherBracos, d0, guardrails);
  if (crossArmFloor != null && crossArmFloor > 0) {
    const ratio = current.custoPorLeitor / crossArmFloor;
    if (ratio > guardrails.crossArmDegradationRatio) {
      reasons.push({
        kind: "cross-arm-degradation",
        currentCustoPorLeitor: current.custoPorLeitor,
        baselineCustoPorLeitor: crossArmFloor,
        ratio,
        thresholdRatio: guardrails.crossArmDegradationRatio,
      });
    }
  }

  return { braco, asOfDate, evaluated: true, skipReason: null, current, triggered: reasons.length > 0, reasons };
}

/** Avalia TODOS os `bracos` numa data — 1 `evaluateArmKillSwitch` por
 *  braço, cada um vendo os demais como "outros braços". @pure */
export function evaluateKillSwitchRound(
  history: readonly ArmCostSample[],
  bracos: readonly string[],
  asOfDate: DateOnlyString,
  d0: DateOnlyString,
  guardrails: KillSwitchGuardrails = DEFAULT_KILL_SWITCH_GUARDRAILS,
): KillSwitchEvaluation[] {
  return bracos.map((braco) =>
    evaluateArmKillSwitch(
      history,
      braco,
      asOfDate,
      bracos.filter((b) => b !== braco),
      d0,
      guardrails,
    ),
  );
}

// ---------------------------------------------------------------------------
// Pausa — evento REGISTRADO, nunca ajuste de lance (herança do fechamento
// do #5524, ver docstring do módulo) — e executor NUNCA wired a nada real.
// ---------------------------------------------------------------------------

export interface PauseExecutorResult {
  ok: boolean;
  detail: string;
}

/** Único ponto de contato possível com uma plataforma de anúncio real —
 *  deliberadamente estreito: recebe só o braço + a avaliação que motivou a
 *  pausa, devolve sucesso/detalhe. Não há como expressar NENHUMA outra
 *  mutação através desta assinatura (lance, orçamento, segmentação, criar
 *  campanha) — "só pausa" é verdade por construção do tipo, não por
 *  disciplina de quem implementa. */
export type PauseExecutor = (braco: string, evaluation: KillSwitchEvaluation) => Promise<PauseExecutorResult>;

/** Executor default — e o ÚNICO exportado por este módulo. NUNCA faz
 *  nenhuma chamada de rede; sempre devolve `ok: false` explicando que
 *  pausar exige ação manual ou uma sessão com o conector de escrita
 *  apropriado sob gate humano. Ver docstring do módulo, seção "Nunca toca
 *  API paga — por construção, não por disciplina". */
export const notWiredPauseExecutor: PauseExecutor = async (braco) => ({
  ok: false,
  detail:
    `Nenhum executor de pausa está conectado a este script (braço: "${braco}"). Pausar exige ação manual na ` +
    `plataforma (Meta Ads Manager / Google Ads / Microsoft Advertising) ou uma sessão Claude Code com o conector ` +
    `de escrita apropriado sob gate humano supervisionado (ver docs/meta-ads-mcp-tools.md — "qualquer tool marcada ` +
    `ESCRITA é proibida fora de gate humano") — nunca uma chamada automática deste script (#5239).`,
});

export interface PauseEvent {
  braco: string;
  /** Data avaliada (`KillSwitchEvaluation.asOfDate`), não a data de
   *  gravação — `recordedAt` cobre isso. */
  date: DateOnlyString;
  reasons: readonly KillSwitchReasonDetail[];
  /** ISO — quando este evento foi registrado (I/O layer). */
  recordedAt: string;
  /** `false` quando o toggle (`ads-kill-switch-enabled.ts`) ou a flag
   *  `--execute-pause` bloquearam a tentativa — o achado foi alarmado mas
   *  nenhuma tentativa de pausa aconteceu. `true` = o executor FOI chamado
   *  (mesmo que tenha falhado — ver `executionOk`). */
  executionAttempted: boolean;
  /** `null` quando `executionAttempted` é `false`. Com o executor default
   *  (`notWiredPauseExecutor`), é sempre `false` quando `executionAttempted`
   *  é `true` — nunca há um "pausado com sucesso" real neste repo hoje. */
  executionOk: boolean | null;
  executionDetail: string | null;
}

/** Constrói o `PauseEvent` a partir de uma avaliação disparada — puro,
 *  nunca chama o executor (isso é responsabilidade do I/O layer, que
 *  decide SE chama com base no toggle + flag, e passa o resultado aqui
 *  depois). Duas formas de uso: `recordSkippedPauseEvent` (toggle/flag
 *  off — nunca tenta) e `recordAttemptedPauseEvent` (tentou, com o
 *  resultado do executor). @pure */
export function recordSkippedPauseEvent(evaluation: KillSwitchEvaluation, nowIso: string): PauseEvent {
  return {
    braco: evaluation.braco,
    date: evaluation.asOfDate,
    reasons: evaluation.reasons,
    recordedAt: nowIso,
    executionAttempted: false,
    executionOk: null,
    executionDetail: null,
  };
}

/** @pure */
export function recordAttemptedPauseEvent(
  evaluation: KillSwitchEvaluation,
  nowIso: string,
  result: PauseExecutorResult,
): PauseEvent {
  return {
    braco: evaluation.braco,
    date: evaluation.asOfDate,
    reasons: evaluation.reasons,
    recordedAt: nowIso,
    executionAttempted: true,
    executionOk: result.ok,
    executionDetail: result.detail,
  };
}

// ---------------------------------------------------------------------------
// E-mail — sempre construído/enviado pelo caller quando há ao menos 1
// achado disparado nesta rodada (mesmo padrão de buildX em ads-test-watch.ts)
// ---------------------------------------------------------------------------

function formatReason(r: KillSwitchReasonDetail): string {
  const label = r.kind === "self-degradation" ? "degradação vs. própria história" : "degradação vs. outros braços";
  return (
    `${label}: R$ ${r.currentCustoPorLeitor.toFixed(2)}/leitor hoje vs. baseline R$ ${r.baselineCustoPorLeitor.toFixed(2)} ` +
    `(${r.ratio.toFixed(2)}× — limiar ${r.thresholdRatio}×)`
  );
}

/**
 * E-mail de alarme — chamado incondicionalmente pra toda rodada com pelo
 * menos 1 `evaluation.triggered`, independente de pausa ter sido
 * executada, bloqueada pelo toggle, ou nem tentada (checklist da issue,
 * "alarme por e-mail sempre, tenha pausado ou não — a ação silenciosa é o
 * que assusta"). `pauseExecutionEnabled` reflete o estado do toggle
 * (`ads-kill-switch-enabled.ts`) no momento da avaliação, só pra deixar
 * explícito no corpo se uma pausa automática SERIA tentada. @pure
 */
export function buildKillSwitchAlarmEmail(
  evaluations: readonly KillSwitchEvaluation[],
  pauseExecutionEnabled: boolean,
): { subject: string; body: string } {
  const triggered = evaluations.filter((e) => e.triggered);
  const bracosLabel = triggered.map((e) => e.braco).join(", ");
  const lines: string[] = [
    `Alarme automático do kill switch por custo (#5239).`,
    "",
    pauseExecutionEnabled
      ? "Kill switch de PAUSA está LIGADO — se `--execute-pause` for passado, a pausa será tentada (ver detalhe por braço abaixo)."
      : "Kill switch de PAUSA está DESLIGADO (default) — nenhuma pausa foi tentada; ação manual é necessária.",
    "",
  ];
  for (const ev of triggered) {
    lines.push(`Braço: ${ev.braco} (${ev.asOfDate})`);
    for (const r of ev.reasons) lines.push(`  - ${formatReason(r)}`);
    lines.push("");
  }
  lines.push(
    "Nenhuma chamada automática a nenhuma API paga (Meta/Google/Microsoft/LinkedIn) acontece a partir deste alarme " +
      "— o executor de pausa deste projeto nunca está conectado a uma plataforma real (ver scripts/lib/ads-kill-switch.ts). " +
      "Revisar no painel da plataforma e decidir manualmente.",
  );
  return {
    subject: `🚨 Kill switch de custo: degradação detectada (${bracosLabel})`,
    body: lines.join("\n"),
  };
}
