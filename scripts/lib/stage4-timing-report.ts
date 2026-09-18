/**
 * scripts/lib/stage4-timing-report.ts (#8123 residual)
 *
 * Miolo PURO do relatório de tempo do loop "ajustar" do Stage 4 — agrega as
 * medições já gravadas no run-log e devolve a tabela que o critério de
 * aceite da issue pede ("antes/depois medido numa edição real").
 *
 * ## Por que existe
 *
 * A issue mede o caminho em duas pernas:
 *
 *   pedido do editor ──(modelo)──> edição no disco ──(máquina)──> preview
 *
 * A Fatia 5 cobriu as duas com `log-stage4-adjust-timing.ts`, que depende do
 * orchestrator lembrar de capturar 3 timestamps e chamar o CLI. Em produção
 * isso não aconteceu: a revisão de Stage 4 da edição 260918 teve ajustes e o
 * run-log saiu com zero medições.
 *
 * A perna da MÁQUINA agora é medida sozinha pelo watcher do preview
 * (`serve-preview.ts`), que sabe quando o arquivo mudou e quando empurrou o
 * reload — sem nada pra lembrar. Este módulo junta as duas fontes:
 *
 * - `agent: "serve-preview"` → perna edição→preview (automática, sempre existe
 *   quando o preview está no ar com `--watch`);
 * - `agent: "orchestrator"` com métricas de ajuste → perna pedido→edição
 *   (depende do CLI da Fatia 5; quando ausente, a linha sai só com a perna
 *   automática, em vez de sumir da tabela).
 *
 * É essa degradação que faz a medição deixar de ser tudo-ou-nada: mesmo numa
 * edição em que ninguém chamou o CLI, a métrica que a meta de ~10s descreve
 * (edição→preview) está lá.
 *
 * @see scripts/report-stage4-timing.ts — CLI/I-O em volta deste miolo.
 */

/** Uma linha do run-log, já parseada. Só os campos que interessam aqui. */
export interface RunLogEntry {
  timestamp?: string;
  edition?: string | null;
  stage?: number | null;
  agent?: string | null;
  message?: string | null;
  details?: Record<string, unknown> | null;
}

/** Uma medição da perna automática (watcher do preview). */
export interface PreviewCycleSample {
  at: string;
  editToPreviewMs: number;
  withinTarget10s: boolean;
  clientsNotified: number;
}

/** Uma medição da perna do modelo (CLI da Fatia 5), quando existe. */
export interface AdjustSample {
  at: string;
  description: string | null;
  requestToEditMs: number | null;
  editToPreviewMs: number | null;
  requestToPreviewMs: number | null;
  toolCalls: number | null;
}

export interface Stage4TimingReport {
  edition: string | null;
  /** Medições automáticas do watcher. */
  previewCycles: PreviewCycleSample[];
  /** Medições do CLI da Fatia 5 — vazio quando o orchestrator não chamou. */
  adjusts: AdjustSample[];
  /** Mediana de `editToPreviewMs` das medições automáticas. Mediana e não
   *  média: uma rajada de writes (cascata de imagem, por exemplo) produz
   *  outlier alto, e a média deixaria de descrever o caso típico — que é o
   *  que a meta de ~10s fala sobre. `null` sem amostra. */
  medianEditToPreviewMs: number | null;
  /** Pior caso observado — o que decide se a meta foi batida SEMPRE ou só
   *  na mediana. */
  maxEditToPreviewMs: number | null;
  /** Quantas medições automáticas ficaram dentro dos 10s. */
  withinTargetCount: number;
  /** `true` quando há ao menos 1 medição automática E todas bateram a meta. */
  allWithinTarget: boolean;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Agrega as entradas do run-log num relatório. `edition` filtra; `null`
 * agrega tudo.
 *
 * Entrada malformada (sem `details`, com campo de tipo errado) é IGNORADA em
 * silêncio de propósito: o run-log é append-only e compartilhado por dezenas
 * de produtores, então uma linha estranha nunca pode derrubar um relatório
 * de leitura. O que NÃO é silencioso é a ausência total de amostra — aí
 * `medianEditToPreviewMs` sai `null` e o CLI diz que não há o que medir.
 *
 * @pure
 */
export function buildStage4TimingReport(entries: readonly RunLogEntry[], edition: string | null = null): Stage4TimingReport {
  const previewCycles: PreviewCycleSample[] = [];
  const adjusts: AdjustSample[] = [];

  for (const e of entries) {
    if (edition != null && e.edition !== edition) continue;
    const d = e.details;
    if (!d || typeof d !== "object") continue;

    if (e.agent === "serve-preview") {
      const ms = num(d.edit_to_preview_ms);
      if (ms == null) continue;
      previewCycles.push({
        at: e.timestamp ?? "",
        editToPreviewMs: ms,
        withinTarget10s: d.within_target_10s === true,
        clientsNotified: num(d.clients_notified) ?? 0,
      });
      continue;
    }

    // Fatia 5: o CLI grava as métricas de `computeAdjustTimingMetrics` no
    // `details`. Detectado pela presença dos campos, não pelo texto da
    // mensagem — mensagem é prosa e muda.
    const requestToEdit = num(d.requestToEditMs) ?? num(d.request_to_edit_ms);
    const editToPreview = num(d.editToPreviewMs) ?? num(d.edit_to_preview_ms);
    const requestToPreview = num(d.requestToPreviewMs) ?? num(d.request_to_preview_ms);
    if (requestToEdit == null && requestToPreview == null) continue;
    adjusts.push({
      at: e.timestamp ?? "",
      description: typeof d.description === "string" ? d.description : null,
      requestToEditMs: requestToEdit,
      editToPreviewMs: editToPreview,
      requestToPreviewMs: requestToPreview,
      toolCalls: num(d.toolCalls) ?? num(d.tool_calls),
    });
  }

  const cycleMs = previewCycles.map((c) => c.editToPreviewMs);
  const withinTargetCount = previewCycles.filter((c) => c.withinTarget10s).length;

  return {
    edition,
    previewCycles,
    adjusts,
    medianEditToPreviewMs: median(cycleMs),
    maxEditToPreviewMs: cycleMs.length > 0 ? Math.max(...cycleMs) : null,
    withinTargetCount,
    allWithinTarget: previewCycles.length > 0 && withinTargetCount === previewCycles.length,
  };
}

function fmtMs(ms: number | null): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Renderiza o relatório como markdown — mesma forma da tabela do corpo da
 * issue, pra o "antes/depois" poder ser colado direto.
 *
 * @pure
 */
export function renderStage4TimingReport(report: Stage4TimingReport): string {
  const lines: string[] = [];
  const escopo = report.edition ? `edição ${report.edition}` : "todas as edições";
  lines.push(`# Stage 4 — tempo do loop "ajustar" (${escopo})`);
  lines.push("");

  if (report.previewCycles.length === 0 && report.adjusts.length === 0) {
    lines.push("Nenhuma medição no run-log para este escopo.");
    lines.push("");
    lines.push(
      "A perna automática (edição→preview) só é gravada quando o preview local roda com `--watch` " +
        "(`serve-preview.ts`). Se a revisão usou outra superfície, não há o que medir aqui.",
    );
    return lines.join("\n");
  }

  lines.push(`## Edição no disco → preview na tela (automático, ${report.previewCycles.length} medições)`);
  lines.push("");
  lines.push(`- Mediana: **${fmtMs(report.medianEditToPreviewMs)}**`);
  lines.push(`- Pior caso: **${fmtMs(report.maxEditToPreviewMs)}**`);
  lines.push(`- Dentro da meta de 10 s: **${report.withinTargetCount}/${report.previewCycles.length}**`);
  lines.push("");

  if (report.adjusts.length === 0) {
    lines.push("## Pedido → edição no disco");
    lines.push("");
    lines.push(
      "Sem medição. Essa perna depende de `log-stage4-adjust-timing.ts`, chamado pelo orchestrator " +
        "no loop `ajustar` — quando ele não é chamado, só a perna automática acima fica registrada.",
    );
    return lines.join("\n");
  }

  lines.push("## Por ajuste (pedido → preview)");
  lines.push("");
  lines.push("| Quando | Pedido | Pedido→edição | Edição→preview | Total | Chamadas |");
  lines.push("|---|---|---|---|---|---|");
  for (const a of report.adjusts) {
    lines.push(
      `| ${a.at.slice(11, 19) || "—"} | ${a.description ?? "—"} | ${fmtMs(a.requestToEditMs)} | ` +
        `${fmtMs(a.editToPreviewMs)} | ${fmtMs(a.requestToPreviewMs)} | ${a.toolCalls ?? "—"} |`,
    );
  }
  return lines.join("\n");
}
