/**
 * scripts/lib/stage4-adjust-derive.ts (#14115 item 3)
 *
 * Deriva a perna "pedido do editor → edição no disco" do loop "ajustar" do
 * gate 4 a partir do que já fica gravado, sem depender do orchestrator.
 *
 * ## Por que o `log-stage4-adjust-timing.ts` nunca gerou evento
 *
 * O CLI funciona (testado em `test/log-stage4-adjust-timing-cli.test.ts`), e
 * `data/run-log.jsonl` tem zero linhas com `withinTarget10s` em todas as
 * edições até 26/11/2026. O passo não roda porque depende de o modelo, no
 * meio do loop do gate, capturar `{requested_at}` com um `date -u` ao
 * receber o pedido, outro depois da `Edit`, e contar as próprias chamadas de
 * ferramenta. Cada captura é uma chamada a mais justamente no trecho cuja
 * meta é gastar 2 chamadas por ajuste, e o fast path do §4d.1 manda não
 * reler a seção onde a instrução mora (achado já registrado em
 * `serve-preview.ts`, #8123 residual). Reforçar a prosa (#7982 a tornou
 * "OBRIGATORIAMENTE") não mudou nada: instrumentação que depende de o modelo
 * lembrar não roda.
 *
 * ## O que este módulo faz
 *
 * Os três instantes já existem fora do modelo:
 * - o pedido do editor é uma mensagem `user` no transcript da sessão;
 * - a edição no disco é o `file_changed_at` do ciclo do watcher do preview
 *   (`agent: "serve-preview"` no run-log);
 * - o preview servido é o `preview_served_at` do mesmo ciclo.
 * As chamadas de ferramenta e as respostas da API entre o pedido e a edição
 * saem do transcript. `capture-stage-usage.ts --stage 4`, que o playbook já
 * roda ao fechar a Etapa 4, chama a derivação e grava um evento por ajuste
 * no mesmo formato do CLI (`withinTarget10s`, `toolCalls`, ...), que
 * `report-stage4-timing.ts` já lê.
 *
 * Nunca lê nem devolve o texto das mensagens: do pedido só interessa o
 * instante; do assistant, o id da resposta e os ids dos `tool_use`.
 *
 * Núcleo puro, sem IO.
 */

import { computeAdjustTimingMetrics, type AdjustTimingMetrics } from "./stage4-adjust-timing.ts";

export type TimelineEvent =
  | { kind: "prompt"; ts: number }
  | { kind: "assistant"; ts: number; responseKey: string; toolUseIds: string[] };

/** Mensagem `user` injetada pelo harness, não digitada pelo editor. */
const INJECTED_PREFIX_RE = /^\s*<(task-notification|command-|local-command|system-reminder)/;

function promptText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const b of content as Array<{ type?: unknown; text?: unknown }>) {
    if (b?.type === "tool_result") return null;
    if (b?.type === "text" && typeof b.text === "string") text += b.text;
  }
  return text;
}

/**
 * Linha do tempo do thread PRINCIPAL de um transcript (`{sessionId}.jsonl`):
 * pedidos do editor e respostas do assistant. Linha malformada é ignorada.
 *
 * @pure
 */
export function parseMainThreadTimeline(content: string): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  let anon = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.isSidechain === true) continue;
    const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    if (!Number.isFinite(ts)) continue;
    const message = (obj.message ?? {}) as { id?: unknown; content?: unknown };
    if (obj.type === "user") {
      if (obj.isMeta === true || obj.toolUseResult !== undefined) continue;
      const text = promptText(message.content);
      if (!text || !text.trim() || INJECTED_PREFIX_RE.test(text)) continue;
      out.push({ kind: "prompt", ts });
    } else if (obj.type === "assistant") {
      const responseKey = typeof message.id === "string" && message.id ? message.id : `anon-${anon++}`;
      const toolUseIds: string[] = [];
      if (Array.isArray(message.content)) {
        for (const b of message.content as Array<{ type?: unknown; id?: unknown }>) {
          if (b?.type === "tool_use") toolUseIds.push(typeof b.id === "string" ? b.id : `${responseKey}:${toolUseIds.length}`);
        }
      }
      out.push({ kind: "assistant", ts, responseKey, toolUseIds });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Um ciclo do watcher do preview (`serve-preview.ts`). */
export interface WatcherCycle {
  fileChangedAt: number;
  servedAt: number;
}

/**
 * Ciclos do watcher de uma edição, a partir das linhas do run-log. Aceita
 * também `edition: null` (o watcher grava null quando não reconhece a edição
 * pelo caminho); o pareamento com os pedidos da sessão, dentro da janela do
 * gate, é o que filtra.
 *
 * @pure
 */
export function watcherCyclesFromRunLog(
  entries: ReadonlyArray<{ agent?: unknown; edition?: unknown; details?: unknown }>,
  edition: string,
): WatcherCycle[] {
  const out: WatcherCycle[] = [];
  for (const e of entries) {
    if (e.agent !== "serve-preview") continue;
    if (e.edition !== edition && e.edition !== null) continue;
    const d = (e.details ?? {}) as Record<string, unknown>;
    const changed = typeof d.file_changed_at === "string" ? Date.parse(d.file_changed_at) : NaN;
    const served = typeof d.preview_served_at === "string" ? Date.parse(d.preview_served_at) : NaN;
    if (Number.isFinite(changed) && Number.isFinite(served)) out.push({ fileChangedAt: changed, servedAt: served });
  }
  return out.sort((a, b) => a.fileChangedAt - b.fileChangedAt);
}

export interface DerivedAdjust extends AdjustTimingMetrics {
  source: "derived-transcript";
  requestedAt: string;
  editedAt: string;
  previewServedAt: string;
  /** Respostas da API entre o pedido e a 1ª edição no disco. */
  apiCalls: number;
  /** Respostas da API e chamadas de ferramenta até o próximo pedido (o pedido inteiro, não só até a 1ª edição). */
  apiCallsTotal: number;
  toolCallsTotal: number;
  /** Ciclos do watcher até o próximo pedido (cascata de escrita conta mais de um). */
  editsInInterval: number;
}

function countBetween(timeline: readonly TimelineEvent[], fromMs: number, toMs: number): { api: number; tools: number } {
  const responses = new Set<string>();
  const tools = new Set<string>();
  for (const ev of timeline) {
    if (ev.kind !== "assistant" || ev.ts < fromMs || ev.ts > toMs) continue;
    responses.add(ev.responseKey);
    for (const id of ev.toolUseIds) tools.add(id);
  }
  return { api: responses.size, tools: tools.size };
}

/**
 * Um `DerivedAdjust` por pedido do editor, dentro de `[windowStartMs,
 * windowEndMs]`, que foi seguido de pelo menos um ciclo do watcher antes do
 * próximo pedido. Pedido sem edição no disco (aprovação, pergunta) não é
 * ajuste e fica de fora.
 *
 * @pure
 */
export function deriveAdjustTimings(input: {
  timeline: readonly TimelineEvent[];
  cycles: readonly WatcherCycle[];
  windowStartMs: number;
  windowEndMs: number;
}): DerivedAdjust[] {
  const { timeline, cycles, windowStartMs, windowEndMs } = input;
  if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs)) return [];
  const prompts = timeline
    .filter((e) => e.kind === "prompt" && e.ts >= windowStartMs && e.ts <= windowEndMs)
    .map((e) => e.ts);
  const out: DerivedAdjust[] = [];
  for (let i = 0; i < prompts.length; i++) {
    const from = prompts[i];
    const until = i + 1 < prompts.length ? prompts[i + 1] : windowEndMs;
    const inInterval = cycles.filter((c) => c.fileChangedAt >= from && c.fileChangedAt < until);
    if (inInterval.length === 0) continue;
    const first = inInterval[0];
    const toEdit = countBetween(timeline, from, first.fileChangedAt);
    const total = countBetween(timeline, from, until);
    const requestedAt = new Date(from).toISOString();
    const editedAt = new Date(first.fileChangedAt).toISOString();
    const previewServedAt = new Date(first.servedAt).toISOString();
    const metrics = computeAdjustTimingMetrics({ requestedAt, editedAt, previewServedAt, toolCalls: toEdit.tools });
    out.push({
      source: "derived-transcript",
      requestedAt,
      editedAt,
      previewServedAt,
      ...metrics,
      apiCalls: toEdit.api,
      apiCallsTotal: total.api,
      toolCallsTotal: total.tools,
      editsInInterval: inInterval.length,
    });
  }
  return out;
}

/**
 * Tira os ajustes já gravados no run-log (mesmo `requestedAt` na mesma
 * edição): re-rodar `capture-stage-usage --stage 4` não duplica eventos.
 *
 * @pure
 */
export function dropAlreadyLogged(
  derived: readonly DerivedAdjust[],
  entries: ReadonlyArray<{ edition?: unknown; details?: unknown }>,
  edition: string,
): DerivedAdjust[] {
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.edition !== edition) continue;
    const r = (e.details as Record<string, unknown> | undefined)?.requestedAt;
    if (typeof r === "string") seen.add(r);
  }
  return derived.filter((d) => !seen.has(d.requestedAt));
}
