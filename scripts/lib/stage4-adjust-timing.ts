/**
 * stage4-adjust-timing.ts (#8123 Fatia 5 — instrumentação)
 *
 * A issue #8123 pede, por ajuste feito no loop "ajustar" do gate Stage 4
 * (§4d.1 de `.claude/agents/orchestrator-stage-4.md`): logar t(pedido →
 * edição no disco), t(edição → preview servido) e o nº de chamadas de
 * ferramenta até o preview refletir a mudança — alvo ~10s pedido→preview.
 *
 * Este módulo é o miolo PURO (sem I/O de arquivo/rede) que calcula essas
 * métricas a partir de 3 timestamps ISO-8601 que o orchestrator já produz
 * no curso normal do fluxo:
 *   - `requestedAt`  — instante em que o orchestrator recebeu o pedido do
 *     editor (a mensagem de chat que dispara o `ajustar`).
 *   - `editedAt`     — instante em que a `Edit` cirúrgica do passo 2 de
 *     §4d.1 terminou de escrever em disco.
 *   - `previewServedAt` — instante em que o preview local re-servido
 *     (§4d.1 passos 3/6.9, ou o fast path de §4d.1) reflete a mudança —
 *     tipicamente o `generatedAt` do carimbo de versão que
 *     `scripts/studio-ui/review-file-watch.ts#computeReviewVersion`
 *     (Fatia 1) já calcula sempre que reobserva o disco.
 *
 * O CLI fino (`scripts/log-stage4-adjust-timing.ts`) é quem grava no
 * run-log via `scripts/lib/run-log.ts#logEvent` — este módulo não grava
 * nada, só computa, para ficar testável sem I/O.
 */

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export interface AdjustTimingInput {
  /** ISO-8601: instante em que o pedido do editor chegou. */
  requestedAt: string;
  /** ISO-8601: instante em que a edição terminou de ser escrita em disco. */
  editedAt: string;
  /** ISO-8601: instante em que o preview atualizado foi servido. */
  previewServedAt: string;
  /** Nº de chamadas de ferramenta entre o pedido e o preview atualizado. */
  toolCalls: number;
}

export interface AdjustTimingMetrics {
  requestToEditMs: number;
  editToPreviewMs: number;
  requestToPreviewMs: number;
  toolCalls: number;
  /** #8123: alvo declarado na issue é ~10s pedido→preview. */
  withinTarget10s: boolean;
  /**
   * Presente só quando os 3 timestamps, embora todos parseáveis, saem fora
   * da ordem esperada (requestedAt ≤ editedAt ≤ previewServedAt) — sinal de
   * relógio divergente entre processos/máquinas, ou de o caller ter passado
   * os timestamps trocados. Não lançamos: a métrica ainda é reportável
   * (clamada em 0), só sinalizamos pra quem for ler o log não confiar cegamente
   * num delta negativo.
   */
  orderWarning?: string;
}

function parseIso(label: string, value: string): number {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}: timestamp ausente/vazio`);
  }
  if (!ISO_LIKE.test(value)) {
    throw new Error(`${label}: "${value}" não parece ISO-8601 (esperado AAAA-MM-DDTHH:MM:SS...)`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`${label}: "${value}" não é uma data válida`);
  }
  return ms;
}

/**
 * Calcula as métricas de timing de um ajuste do loop Stage 4. Lança
 * `Error` com mensagem acionável se algum timestamp for inválido/ausente,
 * ou se `toolCalls` não for um inteiro não-negativo — falha alto em vez de
 * gravar um log mentiroso (#7401-adjacent: métrica ruim é pior que ausência
 * de métrica).
 */
export function computeAdjustTimingMetrics(input: AdjustTimingInput): AdjustTimingMetrics {
  const requestedMs = parseIso("requestedAt", input.requestedAt);
  const editedMs = parseIso("editedAt", input.editedAt);
  const previewMs = parseIso("previewServedAt", input.previewServedAt);

  if (!Number.isInteger(input.toolCalls) || input.toolCalls < 0) {
    throw new Error(`toolCalls: esperado inteiro ≥ 0, recebeu ${JSON.stringify(input.toolCalls)}`);
  }

  const requestToEditMs = Math.max(0, editedMs - requestedMs);
  const editToPreviewMs = Math.max(0, previewMs - editedMs);
  const requestToPreviewMs = Math.max(0, previewMs - requestedMs);

  const out: AdjustTimingMetrics = {
    requestToEditMs,
    editToPreviewMs,
    requestToPreviewMs,
    toolCalls: input.toolCalls,
    withinTarget10s: requestToPreviewMs <= 10_000,
  };

  if (editedMs < requestedMs || previewMs < editedMs) {
    out.orderWarning =
      "timestamps fora da ordem esperada (requestedAt ≤ editedAt ≤ previewServedAt) — deltas negativos foram clamados em 0";
  }

  return out;
}
