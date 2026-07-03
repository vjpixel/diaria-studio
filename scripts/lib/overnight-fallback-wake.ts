/**
 * overnight-fallback-wake.ts (#2896)
 *
 * Incidente 260702-r2: o coordenador do overnight ficou ~8h parado. Causa
 * raiz dupla:
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

import { pathToFileURL } from "node:url";

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
// CLI guard: este módulo é só helpers puros — sem main(), sem side-effect
// ao ser importado. Guard mantido por convenção do repo (documentar a
// ausência de main() explicitamente) caso um `main()` de diagnóstico seja
// adicionado no futuro.
// ---------------------------------------------------------------------------

if (
  process.argv[1] &&
  (() => {
    try {
      return import.meta.url === pathToFileURL(process.argv[1]).href;
    } catch {
      return false;
    }
  })()
) {
  console.log(
    "[overnight-fallback-wake] módulo de helpers puros (#2896) — sem CLI. " +
      "Importe shouldWakeCheck / computeElapsedMin / classifyResumeSignal.",
  );
}
