/**
 * send-edition-report.ts (#1483)
 *
 * Gera report HTML + JSON summary de uma edicao completa, agregando timing
 * por stage, highlights, status de publicacao e warnings/errors do run-log.
 * Output vai pra stdout (HTML) + stderr (JSON summary) para o orchestrator
 * repassar via Gmail MCP `create_draft`.
 *
 * Uso:
 *   npx tsx scripts/send-edition-report.ts --edition 260525 --edition-dir data/editions/260525/
 *
 * Fontes de dados:
 *   1. _internal/stage-status.json — timing por stage
 *   2. _internal/01-approved.json — highlights (titulo + URL)
 *   3. _internal/05-published.json — status newsletter
 *   4. _internal/06-social-published.json — status social
 *   5. data/run-log.jsonl — warnings/errors filtrados pela edicao
 *
 * Outputs:
 *   stdout: HTML email body
 *   stderr: JSON summary { edition, total_duration_ms, stages, highlights, warnings_count, errors_count }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli-args.ts";
import { runMain } from "./lib/exit-handler.ts";
import { resolveReadPath } from "./lib/edition-paths.ts";
import { fmtTimeBrt, fmtDuration, escapeHtml } from "./lib/format.ts";
import {
  type StageStatusDoc,
  type StageRow,
  STAGE_LABELS,
  loadDoc,
} from "./update-stage-status.ts";
import { computeBraveCreditStats, type BraveCreditStats } from "./lib/brave-credits.ts"; // #1558

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StageSummary {
  stage: number;
  label: string;
  status: string;
  duration_ms: number;
  pipeline_ms?: number;
  models: string[];
}

export interface HighlightSummary {
  title: string;
  url: string;
}

export interface ReportSummary {
  edition: string;
  total_duration_ms: number;
  stages: StageSummary[];
  highlights: HighlightSummary[];
  newsletter_status: string;
  social_posts: Array<{ platform: string; destaque: string; status: string }>;
  warnings_count: number;
  errors_count: number;
  brave_credits?: BraveCreditStats; // #1558
}

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

/**
 * #1586: extrai destaques DIRETO do `02-reviewed.md` final, que reflete
 * a ordem editorial pós-Stage 4 (incluindo reorders manuais do editor).
 *
 * Regex captura blocos `**DESTAQUE N | EMOJI CATEGORIA**` + título inline
 * link na próxima linha não-vazia. Suporta os 2 formatos canônicos:
 *   - `**[Título](URL)**` (bold-wraps-link, fonte canônica do pipeline)
 *   - `[**Título**](URL)` (link-wraps-bold, pós-Drive round-trip pré-#1582)
 *
 * Retorna lista vazia se MD não tem destaques parseáveis — caller faz
 * fallback pra 01-approved.json (pre-Stage 2 ou edição abortada).
 */
export function extractHighlightsFromMd(md: string): HighlightSummary[] {
  const out: HighlightSummary[] = [];
  const blockRe =
    /^\*\*DESTAQUE\s+(\d+)\s*\|[^*\n]*\*\*\s*\n+\s*(?:\*\*)?\[(?:\*\*)?([^\]\n]+?)(?:\*\*)?\]\((https?:\/\/[^)\s]+)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(md)) !== null) {
    const title = m[2].trim();
    const url = m[3].trim();
    if (title && url) out.push({ title, url });
  }
  return out.slice(0, 3);
}

function loadHighlights(editionDir: string): HighlightSummary[] {
  // #1586: preferir 02-reviewed.md final (reflete reorder editorial mid-Stage 4).
  // Fallback pra 01-approved.json quando MD ausente (pre-Stage 2 ou edição abortada).
  const mdPath = resolve(editionDir, "02-reviewed.md");
  if (existsSync(mdPath)) {
    try {
      const md = readFileSync(mdPath, "utf8");
      const fromMd = extractHighlightsFromMd(md);
      if (fromMd.length > 0) return fromMd;
    } catch {
      // fall through
    }
  }
  const approvedPath = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(approvedPath)) return [];
  try {
    const data = JSON.parse(readFileSync(approvedPath, "utf8"));
    const highlights: HighlightSummary[] = [];
    for (const h of data.highlights ?? []) {
      // Suporta flat shape (url direto) e nested (article.url) — #229
      const url = h.url ?? h.article?.url ?? "";
      const title = h.title ?? h.article?.title ?? "(sem titulo)";
      if (url) highlights.push({ title, url });
    }
    return highlights.slice(0, 3);
  } catch {
    return [];
  }
}

interface PublishedNewsletter {
  draft_url?: string;
  status?: string;
  title?: string;
  review_status?: string;
  review_completed?: boolean;
  template_used?: string;
}

function loadPublished(editionDir: string): PublishedNewsletter | null {
  const path = resolveReadPath(editionDir, "05-published.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PublishedNewsletter;
  } catch {
    return null;
  }
}

interface SocialPost {
  platform?: string;
  destaque?: string;
  status?: string;
  url?: string;
  scheduled_at?: string;
}

interface PublishedSocial {
  posts?: SocialPost[];
}

function loadSocial(editionDir: string): PublishedSocial | null {
  const path = resolveReadPath(editionDir, "06-social-published.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PublishedSocial;
  } catch {
    return null;
  }
}

/**
 * #1739: URL do social preview hospedado no draft worker, persistida por
 * `upload-html-public.ts --persist-to .../05-social-preview.json --field
 * social_preview_url` no Stage 4 (#1734). A URL completa (com hash de conteúdo)
 * vive nesse arquivo — recompor `${BASE}/${edition}-social` sem hash dá 404
 * (#1494/#1612). Retorna null se não persistida (edição sem preview social).
 */
function loadSocialPreviewUrl(editionDir: string): string | null {
  const path = resolveReadPath(editionDir, "05-social-preview.json");
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { social_preview_url?: unknown };
    return typeof j.social_preview_url === "string" ? j.social_preview_url : null;
  } catch {
    return null;
  }
}

interface LogEntry {
  timestamp?: string;
  edition?: string | null;
  level?: string;
  message?: string;
  agent?: string;
  stage?: number;
}

function loadRunLogEntries(
  edition: string,
  runStartedAt: string | undefined,
): { warnings: LogEntry[]; errors: LogEntry[] } {
  const logPath = resolve(ROOT, "data", "run-log.jsonl");
  if (!existsSync(logPath)) return { warnings: [], errors: [] };

  const sinceMs = runStartedAt ? new Date(runStartedAt).getTime() : 0;
  const warnings: LogEntry[] = [];
  const errors: LogEntry[] = [];

  try {
    const lines = readFileSync(logPath, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry: LogEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.edition !== edition) continue;
      if (
        sinceMs > 0 &&
        typeof entry.timestamp === "string"
      ) {
        const ts = new Date(entry.timestamp).getTime();
        if (Number.isFinite(ts) && ts < sinceMs) continue;
      }
      if (entry.level === "warn") warnings.push(entry);
      else if (entry.level === "error") errors.push(entry);
    }
  } catch {
    // ignore
  }
  return { warnings, errors };
}

// ---------------------------------------------------------------------------
// HTML render
// ---------------------------------------------------------------------------

// #1823: stages com gate humano (a espera não conta como trabalho do pipeline).
// Stage 0 (preflight) não tem gate → seu duration_ms já é gate-excluded.
const GATE_STAGES = new Set([1, 2, 3, 4]);

/**
 * #1823: duração SEMPRE gate-excluded (só o trabalho do pipeline, sem a espera
 * humana). Fonte primária: `pipeline_ms` (= gate_at - start). Sem ele:
 *  - stage SEM gate (0) → `duration_ms` já é gate-excluded;
 *  - stage COM gate sem gate_at carimbado → `duration_ms` inclui a espera; não
 *    dá pra excluir com certeza, então mostra com label honesto "(inclui gate)"
 *    em vez de fingir que é tempo de trabalho.
 * "(não medido)" só quando não há NENHUM timestamp.
 */
export function renderDurationCell(row: StageRow): string {
  if ((row.pipeline_ms ?? 0) > 0) {
    return escapeHtml(fmtDuration(row.pipeline_ms));
  }
  if ((row.duration_ms ?? 0) > 0) {
    const total = escapeHtml(fmtDuration(row.duration_ms));
    return GATE_STAGES.has(row.stage)
      ? `${total} <span style="color:#999;">(inclui gate)</span>`
      : total;
  }
  return `<span style="color:#999;">(não medido)</span>`;
}

function renderStageRow(row: StageRow): string {
  const label = STAGE_LABELS[row.stage] ?? `Stage ${row.stage}`;
  const models = row.models?.join(", ") ?? "-";
  const durationCell = renderDurationCell(row);
  const statusEmoji =
    row.status === "done"
      ? "&#9989;"
      : row.status === "failed"
        ? "&#10060;"
        : row.status === "running"
          ? "&#9203;"
          : "&#9898;";
  return `<tr>
    <td>${row.stage}</td>
    <td>${escapeHtml(label)}</td>
    <td>${statusEmoji} ${escapeHtml(row.status)}</td>
    <td>${escapeHtml(fmtTimeBrt(row.start))}</td>
    <td>${escapeHtml(fmtTimeBrt(row.end))}</td>
    <td>${durationCell}</td>
    <td>${escapeHtml(models)}</td>
  </tr>`;
}

/**
 * Tempo de pipeline de um stage = trabalho determinístico (scripts/agents/MCP),
 * SEM o aguardo no gate humano. `pipeline_ms` (#1517) já exclui o gate; cai pra
 * `duration_ms` (= end - start, inclui gate) em edições antigas pré-#1517.
 */
function rowPipelineMs(r: { pipeline_ms?: number; duration_ms?: number }): number {
  return r.pipeline_ms ?? r.duration_ms ?? 0;
}

export function renderHtmlReport(
  edition: string,
  stageDoc: StageStatusDoc,
  published: PublishedNewsletter | null,
  social: PublishedSocial | null,
  warnings: LogEntry[],
  errors: LogEntry[],
  braveCredits: BraveCreditStats | null = null, // #1558
  socialPreviewUrl: string | null = null, // #1739
): string {
  // #1609: total = soma do tempo de pipeline (sem aguardo de gate). Marca
  // visualmente quando algum stage caiu no fallback duration_ms (inclui gate).
  const totalMs = stageDoc.rows.reduce((a, r) => a + rowPipelineMs(r), 0);
  const anyGateFallback = stageDoc.rows.some(
    (r) => r.pipeline_ms == null && (r.duration_ms ?? 0) > 0,
  );
  const mode = stageDoc.rows.every((r) => r.status === "done")
    ? "completa"
    : "parcial";

  // Stage table rows
  const stageRows = stageDoc.rows.map(renderStageRow).join("\n");

  // Newsletter status
  const nlStatus = published
    ? `${escapeHtml(published.status ?? "unknown")} | Review: ${escapeHtml(published.review_status ?? "n/a")} | Template: ${escapeHtml(published.template_used ?? "n/a")}`
    : "nao disponivel";
  const draftUrl = published?.draft_url
    ? `<a href="${escapeHtml(published.draft_url)}">${escapeHtml(published.draft_url)}</a>`
    : "-";

  // Social status
  const socialRows = (social?.posts ?? [])
    .map(
      (p) =>
        `<tr>
          <td>${escapeHtml(p.platform ?? "-")}</td>
          <td>${escapeHtml(p.destaque ?? "-")}</td>
          <td>${escapeHtml(p.status ?? "-")}</td>
          <td>${p.scheduled_at ? escapeHtml(fmtTimeBrt(p.scheduled_at)) + " BRT" : "-"}</td>
        </tr>`,
    )
    .join("\n");

  // Preview link. #1739/#1612: usar SÓ o `draft_preview_url` persistido (com
  // hash de conteúdo). #1824: montar `${BASE}/${edition}` sem hash dá 404, então
  // em vez de servir um link quebrado, deixar null → o render mostra
  // "(preview indisponível)" e você sabe que faltou persistir a URL.
  const persistedPreview = (published as { draft_preview_url?: unknown } | null)
    ?.draft_preview_url;
  const previewUrl =
    typeof persistedPreview === "string" && persistedPreview.length > 0
      ? persistedPreview
      : null;

  // Warnings/errors summary
  const warningsHtml = warnings.length > 0
    ? warnings
        .slice(0, 10)
        .map(
          (w) =>
            `<li><code>${escapeHtml(w.agent ?? "?")}</code> (stage ${w.stage ?? "?"}): ${escapeHtml(w.message ?? "")}</li>`,
        )
        .join("\n") + (warnings.length > 10 ? `<li>... +${warnings.length - 10} mais</li>` : "")
    : "";
  const errorsHtml = errors.length > 0
    ? errors
        .slice(0, 10)
        .map(
          (e) =>
            `<li><code>${escapeHtml(e.agent ?? "?")}</code> (stage ${e.stage ?? "?"}): ${escapeHtml(e.message ?? "")}</li>`,
        )
        .join("\n") + (errors.length > 10 ? `<li>... +${errors.length - 10} mais</li>` : "")
    : "";

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; color: #333; }
    h1 { font-size: 20px; border-bottom: 2px solid #2563eb; padding-bottom: 8px; }
    h2 { font-size: 16px; margin-top: 24px; color: #1e40af; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13px; }
    th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
    th { background: #f1f5f9; font-weight: 600; }
    .metric { display: inline-block; background: #f1f5f9; border-radius: 6px; padding: 8px 14px; margin: 4px; font-size: 14px; }
    .metric strong { color: #1e40af; }
    a { color: #2563eb; }
    ul { padding-left: 20px; }
    .warn { color: #b45309; }
    .err { color: #dc2626; }
    .footer { margin-top: 32px; font-size: 11px; color: #999; border-top: 1px solid #eee; padding-top: 8px; }
  </style>
</head>
<body>
  <h1>Diar.ia &mdash; Report edicao ${escapeHtml(edition)}</h1>

  <div>
    <span class="metric"><strong>Edicao:</strong> ${escapeHtml(edition)}</span>
    <span class="metric"><strong>Modo:</strong> ${escapeHtml(mode)}</span>
    <span class="metric"><strong>Duracao total:</strong> ${escapeHtml(fmtDuration(totalMs))}${anyGateFallback ? ` <span style="color:#999;">(inclui aguardo gate em stages pre-#1517)</span>` : ""}</span>
  </div>

  <h2>Tempo por stage</h2>
  <table>
    <thead>
      <tr><th>#</th><th>Stage</th><th>Status</th><th>Inicio (BRT)</th><th>Fim (BRT)</th><th>Duracao</th><th>Modelos</th></tr>
    </thead>
    <tbody>
      ${stageRows}
    </tbody>
  </table>

  <h2>Publicacao</h2>
  <h3 style="font-size:14px;">Newsletter</h3>
  <p>${nlStatus}</p>
  <p>Rascunho (Beehiiv): ${draftUrl}</p>
  <p>Preview newsletter (Cloudflare): ${
    previewUrl
      ? `<a href="${escapeHtml(previewUrl)}">${escapeHtml(previewUrl)}</a>`
      : `<span style="color:#999;">(preview indisponível — draft_preview_url não persistido)</span>`
  }</p>
  <p>Preview social (Cloudflare): ${
    socialPreviewUrl
      ? `<a href="${escapeHtml(socialPreviewUrl)}">${escapeHtml(socialPreviewUrl)}</a>`
      : `<span style="color:#999;">(social preview não gerado)</span>`
  }</p>

  ${(social?.posts ?? []).length > 0 ? `
  <h3 style="font-size:14px;">Social</h3>
  <table>
    <thead><tr><th>Plataforma</th><th>Destaque</th><th>Status</th><th>Agendamento</th></tr></thead>
    <tbody>${socialRows}</tbody>
  </table>
  ` : ""}

  ${warnings.length > 0 ? `
  <h2 class="warn">Warnings (${warnings.length})</h2>
  <ul class="warn">${warningsHtml}</ul>
  ` : ""}

  ${errors.length > 0 ? `
  <h2 class="err">Errors (${errors.length})</h2>
  <ul class="err">${errorsHtml}</ul>
  ` : ""}

  ${warnings.length === 0 && errors.length === 0 ? "<p>Nenhum warning ou error registrado.</p>" : ""}

  ${braveCredits && braveCredits.queries_this_month > 0 ? `
  <h2>Brave Search API (#1558)</h2>
  <table>
    <tbody>
      <tr><td>Queries esta edicao</td><td><strong>${braveCredits.queries_this_edition}</strong></td></tr>
      <tr><td>Queries este mes</td><td><strong>${braveCredits.queries_this_month}</strong> / ${braveCredits.free_tier_limit} (${braveCredits.percent_used}%)</td></tr>
      ${braveCredits.projected_month_end !== null ? `<tr><td>Projecao fim do mes</td><td>~${braveCredits.projected_month_end}</td></tr>` : ""}
      <tr><td>Status</td><td class="${braveCredits.alert_level === "critical" ? "err" : braveCredits.alert_level === "warn" ? "warn" : ""}">${braveCredits.alert_level === "critical" ? "&#9888; Critical (&gt;95% free tier)" : braveCredits.alert_level === "warn" ? "&#9888; Warn (&gt;80% free tier)" : "&#10003; OK"}</td></tr>
    </tbody>
  </table>
  ` : ""}

  <div class="footer">
    Gerado em ${new Date().toISOString()} por send-edition-report.ts
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// JSON summary builder
// ---------------------------------------------------------------------------

export function buildSummary(
  edition: string,
  stageDoc: StageStatusDoc,
  highlights: HighlightSummary[],
  published: PublishedNewsletter | null,
  social: PublishedSocial | null,
  warningsCount: number,
  errorsCount: number,
): ReportSummary {
  const stages: StageSummary[] = stageDoc.rows.map((r) => ({
    stage: r.stage,
    label: STAGE_LABELS[r.stage] ?? `Stage ${r.stage}`,
    status: r.status,
    duration_ms: r.duration_ms ?? 0,
    ...(r.pipeline_ms ? { pipeline_ms: r.pipeline_ms } : {}),
    models: r.models ?? [],
  }));
  // #1609: total reflete tempo de pipeline (sem aguardo de gate), consistente
  // com o HTML report. Fallback pra duration_ms em edições pré-#1517.
  const totalMs = stages.reduce((a, s) => a + rowPipelineMs(s), 0);

  return {
    edition,
    total_duration_ms: totalMs,
    stages,
    highlights,
    newsletter_status: published?.status ?? "not_available",
    social_posts: (social?.posts ?? []).map((p) => ({
      platform: p.platform ?? "unknown",
      destaque: p.destaque ?? "unknown",
      status: p.status ?? "unknown",
    })),
    warnings_count: warningsCount,
    errors_count: errorsCount,
    brave_credits: computeBraveCreditStats(edition), // #1558
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs(process.argv.slice(2));
  const edition = values["edition"];
  const editionDirRaw = values["edition-dir"];
  const outPath = values["out"]; // #1579: opcional, default = stdout

  if (!edition || !editionDirRaw) {
    console.error(
      "Uso: send-edition-report.ts --edition AAMMDD --edition-dir data/editions/AAMMDD/ [--out _internal/edition-report.html]",
    );
    process.exit(2);
  }

  const editionDir = resolve(ROOT, editionDirRaw);
  if (!existsSync(editionDir)) {
    console.error(`[send-edition-report] edition dir nao encontrado: ${editionDir}`);
    process.exit(1);
  }

  // Load all data
  const stageDoc = loadDoc(editionDir, edition);
  const highlights = loadHighlights(editionDir);
  const published = loadPublished(editionDir);
  const social = loadSocial(editionDir);
  const { warnings, errors } = loadRunLogEntries(
    edition,
    stageDoc.run_started_at,
  );

  const braveCredits = computeBraveCreditStats(edition); // #1558
  const html = renderHtmlReport(
    edition,
    stageDoc,
    published,
    social,
    warnings,
    errors,
    braveCredits,
    loadSocialPreviewUrl(editionDir), // #1739
  );

  // #1579: quando --out passado, escreve arquivo + grava manifest com md5
  // pra invariant edition-report-not-rewritten poder verificar que o
  // Gmail draft criado downstream usa os mesmos bytes (caso 260529:
  // orchestrator reescreveu htmlBody com narrativa custom em vez de ler o
  // arquivo).
  if (outPath) {
    const absOut = resolve(ROOT, outPath);
    mkdirSync(dirname(absOut), { recursive: true });
    writeFileSync(absOut, html, "utf8");
    const md5 = createHash("md5").update(html).digest("hex");
    const manifestPath = resolve(editionDir, "_internal", ".edition-report-md5.txt");
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, md5 + "\n", "utf8");
    process.stderr.write(`[send-edition-report] wrote ${absOut} (md5: ${md5.slice(0, 8)})\n`);
  } else {
    process.stdout.write(html);
  }

  // JSON summary to stderr
  const summary = buildSummary(
    edition,
    stageDoc,
    highlights,
    published,
    social,
    warnings.length,
    errors.length,
  );
  process.stderr.write(JSON.stringify(summary, null, 2) + "\n");
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  runMain(main);
}
