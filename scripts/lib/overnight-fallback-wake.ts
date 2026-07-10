/**
 * overnight-fallback-wake.ts (#2896, estendido pelo #2945)
 *
 * #2945 (260703, ~10h de stall na MESMA rodada em que o #2896 foi
 * mergeado): o fix do #2896 se mostrou insuficiente na prática — (a) o
 * `ScheduleWakeup` pós-dispatch/resume era um passo que o coordenador
 * "deveria lembrar" de chamar, e foi esquecido; (b) a instrução de rodar
 * `npm test` em foreground no prompt do subagente é ignorada na prática
 * (sonnet insiste em background+yield). `needsActiveRecheck` (abaixo) dá
 * ao coordenador um classificador puro para os dois sinais que evidenciam
 * "não confie numa notificação terminal aqui" — o `ScheduleWakeup` em si
 * continua sendo **mecânico e incondicional** (HARD RULE na SKILL.md), não
 * condicionado a este helper.
 *
 * Incidente 260702-r2 (#2896 original): o coordenador do overnight ficou ~8h
 * parado. Causa raiz dupla:
 *
 *   1. O guard #2768 (elapsed-vs-dispatch, ver `.claude/skills/diaria-overnight/SKILL.md`
 *      § "Stall passivo — duas camadas") é **event-driven** — só roda quando
 *      o coordenador RECEBE uma notificação de subagente ("ainda esperando",
 *      task-notification, etc). Se nenhuma notificação chegar (o gatilho do
 *      incidente: um subagente resumido que roda `npm test` em background,
 *      abre o PR, e depois some sem emitir mais nada), o guard nunca é
 *      avaliado — o coordenador fica em silêncio absoluto, sem saber que
 *      deveria checar o tempo decorrido.
 *
 *   2. O watchdog externo (#2688, `scripts/overnight-watchdog.ts`, camada
 *      (ii) do stall passivo) não estava armado nesta máquina — a segunda
 *      rede de segurança, que rodaria via Task Scheduler independente da
 *      sessão, simplesmente não existia.
 *
 * Este módulo dá ao coordenador uma **terceira sub-camada** de proteção:
 * fallback wake determinístico. Ao dispatchar OU resumir qualquer
 * subagente, o coordenador agenda um `ScheduleWakeup` (delay ~1200s / 20min)
 * que, ao acordar — MESMO sem ter recebido nenhum evento do subagente —
 * calcula `elapsed = now - timeline.dispatch` via `shouldWakeCheck` e
 * aplica o fluxo de stall do #2768 se o threshold (60 min) foi cruzado.
 * Isso cobre exatamente o buraco que (1) deixa aberto: o coordenador não
 * depende mais de um evento externo para saber que precisa checar — ele
 * mesmo se agenda para acordar e verificar.
 *
 * `classifyResumeSignal` cobre a outra metade do problema: quando o
 * coordenador resume um subagente via SendMessage, o retorno da chamada
 * distingue "queued for delivery" (o agent está vivo e vai processar a
 * mensagem no próximo round de tool-use, MAS isso não garante que ele vá
 * emitir uma notificação terminal de volta — exatamente o padrão do
 * incidente) de "resumed"/"stopped" (o agent já foi retomado e uma
 * notificação de conclusão é esperada). 'queued' é o sinal que exige o
 * re-check ativo do fallback wake; 'resumed' pode confiar no caminho
 * event-driven normal.
 *
 * Todas as funções aqui são puras — sem I/O, sem `Date.now()` implícito —
 * para serem 100% testáveis (#633) com timestamps de fixture.
 *
 * @see .claude/skills/diaria-overnight/SKILL.md § "Stall passivo — duas camadas (#2379 + #2688)"
 * @see scripts/overnight-watchdog.ts (#2688, camada (ii))
 * @see scripts/lib/check-watchdog-armed.ts (#2768, #2814)
 */

import { isMainModule } from "./cli-args.ts";

// ---------------------------------------------------------------------------
// shouldWakeCheck / computeElapsedMin
// ---------------------------------------------------------------------------

/**
 * Minutos decorridos entre `dispatchISO` e `nowISO`. Pode retornar valores
 * negativos se `nowISO` for anterior a `dispatchISO` (dado malformado ou
 * relógio incoerente) — o caller decide como tratar; esta função não
 * normaliza para 0, para não mascarar dados de entrada inconsistentes.
 *
 * Lança `Error` se qualquer um dos dois ISO strings for inválido — decisão
 * de design: um timestamp malformado em `plan.json` é um bug de gravação
 * upstream que deve ser visível (crash alto e claro), não um silencioso
 * "assume que não é stall" que reintroduziria o próprio bug que este
 * módulo existe para prevenir.
 */
export function computeElapsedMin(dispatchISO: string, nowISO: string): number {
  const dispatchMs = Date.parse(dispatchISO);
  const nowMs = Date.parse(nowISO);
  if (Number.isNaN(dispatchMs)) {
    throw new Error(`computeElapsedMin: dispatchISO inválido: "${dispatchISO}"`);
  }
  if (Number.isNaN(nowMs)) {
    throw new Error(`computeElapsedMin: nowISO inválido: "${nowISO}"`);
  }
  return (nowMs - dispatchMs) / 60_000;
}

/**
 * Fallback wake determinístico (#2896): retorna `true` se `now - dispatch`
 * excedeu `thresholdMin` (default 60, mesmo threshold do guard #2768) —
 * independente de qualquer evento ter chegado ao coordenador. É a checagem
 * que o coordenador roda ao acordar via `ScheduleWakeup`, mesmo com zero
 * notificações recebidas da unidade em andamento.
 *
 * Borda: `elapsed == thresholdMin` retorna `true` (mesma convenção de
 * `detectStall` em `scripts/overnight-watchdog.ts` — "detecta stall
 * exatamente no limiar", inclusivo em vez de estrito, para não deixar o
 * caso exato escapar por um ciclo de wake).
 *
 * ISO inválido: retorna `false` (fail-soft) em vez de lançar. Diferente de
 * `computeElapsedMin` (que lança), esta função é o ponto de decisão do
 * fluxo automático do coordenador — um dado malformado aqui NUNCA deve
 * disparar um halt banner espúrio nem travar o wake-loop; é preferível
 * "não detectar stall desta vez" (o próximo wake em ~20min tenta de novo,
 * ou o guard #2768 event-driven ainda cobre se um evento chegar) a lançar
 * uma exceção não tratada dentro do handler de `ScheduleWakeup`.
 */
export function shouldWakeCheck(
  dispatchISO: string,
  nowISO: string,
  thresholdMin = 60,
): boolean {
  const dispatchMs = Date.parse(dispatchISO);
  const nowMs = Date.parse(nowISO);
  if (Number.isNaN(dispatchMs) || Number.isNaN(nowMs)) return false;
  const elapsedMin = (nowMs - dispatchMs) / 60_000;
  return elapsedMin >= thresholdMin;
}

// ---------------------------------------------------------------------------
// classifyResumeSignal
// ---------------------------------------------------------------------------

export type ResumeSignal = "queued" | "resumed" | "unknown";

/**
 * Classifica o retorno textual de um `SendMessage` de resume/dispatch a um
 * subagente. Case-insensitive.
 *
 * - `'queued'` — contém "queued" (ex: "queued for delivery at its next tool
 *   round"). O agent está vivo mas a mensagem só será processada no próximo
 *   round de tool-use dele — **sem garantia de que uma notificação terminal
 *   volte ao coordenador** quando ele terminar (era exatamente o padrão do
 *   incidente #2896: subagent que roda teste em background e "some"). Este
 *   é o sinal que exige o re-check ativo do fallback wake.
 * - `'resumed'` — contém "resumed" ou "stopped" (ex: "agent stopped",
 *   "agent resumed"). O agent já foi de fato retomado — uma notificação de
 *   conclusão é esperada pelo caminho normal event-driven.
 * - `'unknown'` — nenhum dos padrões acima. Texto inesperado/vazio; tratar
 *   como o caso mais conservador (o coordenador não deve assumir que sabe
 *   o estado do agent).
 *
 * Checagem por ordem: 'queued' é testado primeiro porque uma mensagem pode,
 * em teoria, conter ambos os termos — o sinal mais fraco (queued, requer
 * ação) tem precedência sobre o mais forte (resumed) para nunca mascarar a
 * necessidade do fallback wake.
 */
export function classifyResumeSignal(sendMessageResult: string): ResumeSignal {
  const text = (sendMessageResult ?? "").toLowerCase();
  if (text.includes("queued")) return "queued";
  if (text.includes("resumed") || text.includes("stopped")) return "resumed";
  return "unknown";
}

// ---------------------------------------------------------------------------
// needsActiveRecheck (#2945)
// ---------------------------------------------------------------------------

/**
 * Padrões de texto de yield que indicam que o subagente está esperando algo
 * em background em vez de retornar com o resultado (padrão do incidente
 * 260703 — ver `needsActiveRecheck` abaixo). Case-insensitive.
 */
const YIELD_BACKGROUND_PATTERNS: RegExp[] = [
  /\bbackground\b/i,
  /\bwaiting for\b/i,
  /\bmonitor(ing)?\b/i,
  /\bstill running\b/i,
];

/**
 * Classifica um texto de yield de subagente (a mensagem que ele retorna em
 * vez de terminar de fato) quanto a conter um dos padrões conhecidos de
 * "vou esperar isso em background" — ex: "waiting for the npm test
 * background command", "I'll monitor the CI run". Puro, sem I/O.
 */
export function classifyYieldText(yieldText: string): boolean {
  const text = yieldText ?? "";
  return YIELD_BACKGROUND_PATTERNS.some((re) => re.test(text));
}

/**
 * Input discriminado de `needsActiveRecheck`: ou um texto de yield livre do
 * subagente, ou um `ResumeSignal` já classificado (via `classifyResumeSignal`)
 * do retorno de um `SendMessage` de resume.
 */
export type RecheckInput =
  | { readonly kind: "yield_text"; readonly text: string }
  | { readonly kind: "resume_signal"; readonly signal: ResumeSignal };

/**
 * Helper puro (#2945): dado um texto de yield do subagente OU um
 * `ResumeSignal` já classificado, decide se o coordenador precisa de um
 * **re-check ativo** — isto é, não pode confiar em receber uma notificação
 * terminal e deve, ele mesmo, checar o estado da unidade (PR aberto? CI
 * rodando? elapsed vs dispatch?) em vez de esperar passivamente.
 *
 * Motivação (causa raiz do stall de ~10h em 260703, follow-up do #2896):
 * o #2896 já cobria "dispatch/resume agenda ScheduleWakeup", mas dependia
 * do coordenador **lembrar** de chamar isso — um passo esquecível que foi
 * de fato esquecido na mesma rodada em que foi introduzido (#2917). Este
 * helper não substitui o ScheduleWakeup mecânico (que deve rodar SEMPRE,
 * incondicionalmente, após todo dispatch/resume — ver HARD RULE na
 * SKILL.md) — ele existe para o coordenador **classificar o motivo** e
 * decidir se, além do wake agendado, o padrão observado (yield de
 * background, ou resume queued/unknown) já é evidência suficiente de que
 * uma notificação terminal pode nunca chegar.
 *
 * - `kind: "yield_text"` — `true` se o texto bater um dos padrões de
 *   `classifyYieldText` (background/waiting for/monitor/still running).
 *   Cobre o gatilho do incidente: "rodei `npm test` em background e vou
 *   aguardar" — a instrução de foreground no prompt do subagente É
 *   ignorada na prática (sonnet insiste em background+yield), então este
 *   helper trata a ocorrência do padrão como estruturalmente relevante,
 *   não como algo a re-instruir.
 * - `kind: "resume_signal"` — `true` para `'queued'` (agent vivo mas sem
 *   garantia de notificação terminal — exatamente o padrão do incidente:
 *   subagente resumido via `SendMessage`, retornou "queued", completou o
 *   trabalho e silenciou) **e** para `'unknown'` (texto inesperado — mesma
 *   cautela de `'queued'`, nunca assumir que o coordenador será
 *   notificado). `false` só para `'resumed'` (agent de fato retomado,
 *   notificação de conclusão esperada pelo caminho event-driven normal).
 */
export function needsActiveRecheck(input: RecheckInput): boolean {
  if (input.kind === "resume_signal") {
    return input.signal === "queued" || input.signal === "unknown";
  }
  return classifyYieldText(input.text);
}

// ---------------------------------------------------------------------------
// CLI guard: este módulo é só helpers puros — sem main(), sem side-effect
// ao ser importado. Guard mantido por convenção do repo (documentar a
// ausência de main() explicitamente) caso um `main()` de diagnóstico seja
// adicionado no futuro.
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  console.log(
    "[overnight-fallback-wake] módulo de helpers puros (#2896) — sem CLI. " +
      "Importe shouldWakeCheck / computeElapsedMin / classifyResumeSignal.",
  );
}
