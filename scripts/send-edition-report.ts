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

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli-args.ts";
import { runMain } from "./lib/exit-handler.ts";
import { resolveReadPath } from "./lib/edition-paths.ts";
import {
  type StageStatusDoc,
  type StageRow,
  STAGE_LABELS,
  loadDoc,
} from "./update-stage-status.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRAFT_WORKER_BASE = "https://draft.diaria.workers.dev";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StageSummary {
  stage: number;
  label: string;
  status: string;
  duration_ms: number;
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
}

// ---------------------------------------------------------------------------
// Data loaders
// ---------------------------------------------------------------------------

function loadStageStatus(editionDir: string, edition: string): StageStatusDoc {
  return loadDoc(editionDir, edition);
}

function loadHighlights(editionDir: string): HighlightSummary[] {
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
// Format helpers
// ---------------------------------------------------------------------------

function fmtDuration(ms: number): string {
  if (!ms || ms <= 0) return "-";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function fmtTimeBrt(iso: string | undefined): string {
  if (!iso) return "-";
  const ms = Date.parse(iso);
  if (isNaN(ms)) return "-";
  const brt = new Date(ms - 3 * 3600 * 1000);
  const hh = String(brt.getUTCHours()).padStart(2, "0");
  const mm = String(brt.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// HTML render
// ---------------------------------------------------------------------------

function renderStageRow(row: StageRow): string {
  const label = STAGE_LABELS[row.stage] ?? `Stage ${row.stage}`;
  const models = row.models?.join(", ") ?? "-";
  const duration = fmtDuration(row.duration_ms ?? 0);
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
    <td>${escapeHtml(duration)}</td>
    <td style="color:#999;">not available</td>
    <td>${escapeHtml(models)}</td>
  </tr>`;
}

export function renderHtmlReport(
  edition: string,
  stageDoc: StageStatusDoc,
  highlights: HighlightSummary[],
  published: PublishedNewsletter | null,
  social: PublishedSocial | null,
  warnings: LogEntry[],
  errors: LogEntry[],
): string {
  const totalMs = stageDoc.rows.reduce((a, r) => a + (r.duration_ms ?? 0), 0);
  const mode = stageDoc.rows.every((r) => r.status === "done")
    ? "completa"
    : "parcial";

  // Stage table rows
  const stageRows = stageDoc.rows.map(renderStageRow).join("\n");

  // Highlights
  const highlightsHtml = highlights.length > 0
    ? highlights
        .map(
          (h, i) =>
            `<li><strong>D${i + 1}:</strong> <a href="${escapeHtml(h.url)}">${escapeHtml(h.title)}</a></li>`,
        )
        .join("\n")
    : "<li>(nenhum highlight encontrado)</li>";

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

  // Preview link
  const previewUrl = `${DRAFT_WORKER_BASE}/${encodeURIComponent(edition)}`;

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
    <span class="metric"><strong>Duracao total:</strong> ${escapeHtml(fmtDuration(totalMs))}</span>
  </div>

  <h2>Tempo por stage</h2>
  <table>
    <thead>
      <tr><th>#</th><th>Stage</th><th>Status</th><th>Inicio (BRT)</th><th>Fim (BRT)</th><th>Duracao</th><th>Custo</th><th>Modelos</th></tr>
    </thead>
    <tbody>
      ${stageRows}
    </tbody>
  </table>

  <h2>Destaques</h2>
  <ol>
    ${highlightsHtml}
  </ol>

  <h2>Publicacao</h2>
  <h3 style="font-size:14px;">Newsletter</h3>
  <p>${nlStatus}</p>
  <p>Rascunho: ${draftUrl}</p>
  <p>Preview: <a href="${escapeHtml(previewUrl)}">${escapeHtml(previewUrl)}</a></p>

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
    models: r.models ?? [],
  }));
  const totalMs = stages.reduce((a, s) => a + s.duration_ms, 0);

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
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { values } = parseArgs(process.argv.slice(2));
  const edition = values["edition"];
  const editionDirRaw = values["edition-dir"];

  if (!edition || !editionDirRaw) {
    console.error(
      "Uso: send-edition-report.ts --edition AAMMDD --edition-dir data/editions/AAMMDD/",
    );
    process.exit(2);
  }

  const editionDir = resolve(ROOT, editionDirRaw);
  if (!existsSync(editionDir)) {
    console.error(`[send-edition-report] edition dir nao encontrado: ${editionDir}`);
    process.exit(1);
  }

  // Load all data
  const stageDoc = loadStageStatus(editionDir, edition);
  const highlights = loadHighlights(editionDir);
  const published = loadPublished(editionDir);
  const social = loadSocial(editionDir);
  const { warnings, errors } = loadRunLogEntries(
    edition,
    stageDoc.run_started_at,
  );

  // Render HTML to stdout
  const html = renderHtmlReport(
    edition,
    stageDoc,
    highlights,
    published,
    social,
    warnings,
    errors,
  );
  process.stdout.write(html);

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
