#!/usr/bin/env npx tsx
/**
 * build-diaria-dashboard-data.ts (#2132)
 *
 * Agrega as fontes de dados locais em um JSON unico e (opcionalmente)
 * faz push pro KV do Worker `diaria-dashboard`.
 *
 * Modos:
 *   --dry-run  (default seguro): le data/, agrega, escreve data/diaria-dashboard.json
 *              localmente. Nao toca o KV.
 *   --push     agrega + faz push pro KV. Requer CLOUDFLARE_ACCOUNT_ID +
 *              CLOUDFLARE_WORKERS_TOKEN no env e DASHBOARD_KV_NAMESPACE_ID
 *              configurado (env ou --kv-namespace-id flag).
 *
 * Fontes agregadas:
 *   1. Saude das fontes:  data/source-health.json + data/sources/*.jsonl
 *   2. CTR por categoria: data/link-ctr-table.csv
 *   3. Overnight:         data/overnight/{AAMMDD}/plan.json
 *
 * Fontes stub (placeholder -- dados nao disponiveis localmente):
 *   4. Scorer x CTR   -- data/scorer-ctr-history.jsonl (issue #1619, deferido)
 *   5. Assinantes     -- Beehiiv API live (futuro)
 *   6. É IA? / poll   -- KV do worker poll (futuro cross-worker ou push)
 *
 * Uso:
 *   npx tsx scripts/build-diaria-dashboard-data.ts [--dry-run] [--push] [--kv-namespace-id ID]
 *
 * Output (dry-run): data/diaria-dashboard.json
 * Output (push):    data/diaria-dashboard.json + KV key "dashboard"
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import https from "node:https";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import {
  loadHealth,
  computeFailureStreak,
  slugify,
} from "./lib/source-runs.ts";
import type { SourceEntry } from "./lib/source-runs.ts";
import { buildTimelineRows } from "./render-overnight-timeline.ts";
import type {
  DashboardData,
  SourceHealthEntry,
  CtrSummary,
  CtrByCategoryRow,
  OvernightRun,
  StubSection,
} from "../workers/diaria-dashboard/src/types.ts";

// ─── Paths ────────────────────────────────────────────────────────────────────

const ROOT = resolve(process.cwd());
const DATA_DIR = join(ROOT, "data");
const OUT_PATH = join(DATA_DIR, "diaria-dashboard.json");

const SCHEMA_VERSION = 1;

// ─── Stubs ────────────────────────────────────────────────────────────────────

const STUBS: StubSection[] = [
  {
    id: "scorer_vs_ctr",
    description: "Correlaçao entre score do scorer e CTR real -- mostraria se o scorer preve bem o engajamento.",
    tracking_issue: "#1619 (deferido)",
  },
  {
    id: "subscriber_growth",
    description: "Crescimento e engajamento de assinantes Beehiiv (taxa, churn, cohort).",
    tracking_issue: "futuro -- requer API Beehiiv live",
  },
  {
    id: "poll_eia",
    description: "Resultado do poll É IA? por ediçao (score medio, distribuiçao de votos).",
    tracking_issue: "futuro -- requer cross-worker KV read ou push do workers/poll",
  },
];

// ─── Fonte 1: Saude das fontes ────────────────────────────────────────────────

function buildSourceHealth(): DashboardData["source_health"] {
  const healthPath = join(DATA_DIR, "source-health.json");
  const health = loadHealth(healthPath); // gracioso se nao existir

  const entries: SourceHealthEntry[] = [];

  for (const [sourceName, entry] of Object.entries(health.sources)) {
    const e = entry as SourceEntry;
    const { consecutive_failures } = computeFailureStreak(e);
    const success_rate_pct = e.attempts > 0 ? (e.successes / e.attempts) * 100 : 0;

    let status: "verde" | "amarelo" | "vermelho";
    if (success_rate_pct >= 80 && consecutive_failures === 0) {
      status = "verde";
    } else if (success_rate_pct >= 50 || consecutive_failures <= 2) {
      status = "amarelo";
    } else {
      status = "vermelho";
    }

    entries.push({
      name: sourceName,
      slug: slugify(sourceName),
      attempts: e.attempts,
      successes: e.successes,
      failures: e.failures,
      timeouts: e.timeouts,
      success_rate_pct,
      consecutive_failures,
      last_success_iso: e.last_success_iso,
      last_failure_iso: e.last_failure_iso,
      last_duration_ms: e.last_duration_ms,
      status,
    });
  }

  const verde = entries.filter((e) => e.status === "verde").length;
  const amarelo = entries.filter((e) => e.status === "amarelo").length;
  const vermelho = entries.filter((e) => e.status === "vermelho").length;

  return {
    entries,
    total: entries.length,
    verde,
    amarelo,
    vermelho,
    generated_at: new Date().toISOString(),
  };
}

// ─── Fonte 2: CTR por categoria ───────────────────────────────────────────────

interface CsvRow {
  date: string;
  post_title: string;
  section_title: string;
  anchor: string;
  base_url: string;
  domain: string;
  unique_opens: string;
  verified_clicks: string;
  unique_verified_clicks: string;
  ctr_pct: string;
  category: string;
  origin: string;
}

/**
 * Parser CSV minimalista (sem dependencia de papaparse em runtime do script).
 * Suporta aspas duplas como escape. Suficiente para o link-ctr-table.csv.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function buildCtrSummary(): CtrSummary | null {
  const csvPath = join(DATA_DIR, "link-ctr-table.csv");
  if (!existsSync(csvPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(csvPath, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split("\n").filter(Boolean);
  if (lines.length < 2) return null;

  const header = parseCsvLine(lines[0]);
  const rows: CsvRow[] = [];

  for (const line of lines.slice(1)) {
    try {
      const cols = parseCsvLine(line);
      if (cols.length < header.length) continue;
      const row: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) {
        row[header[i]] = cols[i] ?? "";
      }
      rows.push(row as unknown as CsvRow);
    } catch {
      // linha malformada -- skip
    }
  }

  if (rows.length === 0) return null;

  const editions = new Set(rows.map((r) => r.date)).size;

  // Agrega por categoria
  const catMap = new Map<string, { count: number; clicks: number; ctrs: number[] }>();
  for (const r of rows) {
    const cat = r.category || "Outro";
    const clicks = parseInt(r.unique_verified_clicks, 10) || 0;
    const ctr = parseFloat(r.ctr_pct) || 0;
    const existing = catMap.get(cat) ?? { count: 0, clicks: 0, ctrs: [] };
    existing.count++;
    existing.clicks += clicks;
    existing.ctrs.push(ctr);
    catMap.set(cat, existing);
  }

  const top_categories: CtrByCategoryRow[] = [...catMap.entries()]
    .map(([category, v]) => ({
      category,
      link_count: v.count,
      total_clicks: v.clicks,
      avg_ctr_pct: v.ctrs.length > 0 ? v.ctrs.reduce((a, b) => a + b, 0) / v.ctrs.length : 0,
      max_ctr_pct: v.ctrs.length > 0 ? Math.max(...v.ctrs) : 0,
    }))
    .sort((a, b) => b.avg_ctr_pct - a.avg_ctr_pct);

  // Top 10 links por CTR
  const top_links = [...rows]
    .filter((r) => parseFloat(r.ctr_pct) > 0)
    .sort((a, b) => parseFloat(b.ctr_pct) - parseFloat(a.ctr_pct))
    .slice(0, 10)
    .map((r) => ({
      date: r.date,
      post_title: r.post_title,
      anchor: r.anchor,
      base_url: r.base_url,
      category: r.category || "Outro",
      ctr_pct: parseFloat(r.ctr_pct) || 0,
      unique_verified_clicks: parseInt(r.unique_verified_clicks, 10) || 0,
    }));

  return {
    total_editions: editions,
    total_links: rows.length,
    top_categories,
    top_links,
  };
}

// ─── Fonte 3: Timeline overnight ──────────────────────────────────────────────

interface PlanJson {
  started_at?: string;
  issues?: Array<{
    number: number;
    priority?: string;
    status?: string;
    batch?: string | null;
    pr?: number | null;
    timeline?: Record<string, string | undefined>;
  }>;
  [key: string]: unknown;
}

function buildOvernightSummary(): DashboardData["overnight"] {
  const overnightDir = join(DATA_DIR, "overnight");
  if (!existsSync(overnightDir)) {
    return { runs: [], total_runs: 0 };
  }

  let dirs: string[];
  try {
    dirs = readdirSync(overnightDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { runs: [], total_runs: 0 };
  }

  const runs: OvernightRun[] = [];

  for (const edition of dirs) {
    const planPath = join(overnightDir, edition, "plan.json");
    if (!existsSync(planPath)) continue;

    let plan: PlanJson;
    try {
      plan = JSON.parse(readFileSync(planPath, "utf8")) as PlanJson;
    } catch {
      // JSON malformado -- skip gracioso
      continue;
    }

    const issues = plan.issues ?? [];
    let merged = 0;
    let draft = 0;
    let pulada = 0;
    let in_progress = 0;

    for (const issue of issues) {
      const tl = issue.timeline ?? {};
      if (tl.merged) merged++;
      else if (tl.draft) draft++;
      else if (tl.pulada) pulada++;
      else if (tl.dispatch) in_progress++;
    }

    // Duraçao total: started_at → ultimo timestamp de fim
    let duration_ms: number | null = null;
    const rodadaStart = plan.started_at ? new Date(plan.started_at) : null;
    if (rodadaStart && !isNaN(rodadaStart.getTime())) {
      let latestEndMs = 0;
      for (const issue of issues) {
        const tl = issue.timeline ?? {};
        const endStr = tl.merged ?? tl.draft ?? tl.pulada;
        if (!endStr) continue;
        const d = new Date(endStr);
        if (!isNaN(d.getTime()) && d.getTime() > latestEndMs) {
          latestEndMs = d.getTime();
        }
      }
      if (latestEndMs > 0) {
        duration_ms = latestEndMs - rodadaStart.getTime();
      }
    }

    // Unidade mais lenta via buildTimelineRows (reutiliza logica existente)
    let slowest_unit: OvernightRun["slowest_unit"] = null;
    try {
      const tlRows = buildTimelineRows(plan as Parameters<typeof buildTimelineRows>[0]);
      let maxMs = 0;
      for (const row of tlRows) {
        if (row.durationMs !== null && row.durationMs > maxMs) {
          maxMs = row.durationMs;
          slowest_unit = { label: row.unidade, duration_ms: row.durationMs };
        }
      }
    } catch {
      // buildTimelineRows falhou -- skip slowest_unit
    }

    runs.push({
      edition,
      started_at: plan.started_at ?? null,
      total_issues: issues.length,
      merged,
      draft,
      pulada,
      in_progress,
      duration_ms,
      slowest_unit,
    });
  }

  return { runs, total_runs: runs.length };
}

// ─── Agrega tudo ─────────────────────────────────────────────────────────────

export function buildDashboardData(): DashboardData {
  return {
    generated_at: new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
    source_health: buildSourceHealth(),
    ctr: buildCtrSummary(),
    overnight: buildOvernightSummary(),
    stubs: STUBS,
  };
}

// ─── Push pro KV ─────────────────────────────────────────────────────────────

async function pushToKV(
  payload: string,
  accountId: string,
  token: string,
  namespaceId: string,
): Promise<void> {
  const body = Buffer.from(payload, "utf8");
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/dashboard`;

  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.cloudflare.com",
        path: `/client/v4/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/dashboard`,
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": body.length,
        },
      },
      (res) => {
        let resBody = "";
        res.on("data", (chunk: Buffer) => (resBody += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`KV PUT falhou (${res.statusCode}): ${resBody}`));
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const { values } = parseCliArgs(process.argv.slice(2));
  const isDryRun = !values["push"];
  const kvNamespaceId = (values["kv-namespace-id"] as string | undefined)
    ?? process.env["DASHBOARD_KV_NAMESPACE_ID"];

  console.log(`build-diaria-dashboard-data -- modo: ${isDryRun ? "dry-run" : "push"}`);
  console.log("Agregando fontes...");

  const data = buildDashboardData();
  const json = JSON.stringify(data, null, 2);

  // Sempre escreve local
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, json, "utf8");
  console.log(`✓ JSON local: ${OUT_PATH}`);
  console.log(`  • Fontes: ${data.source_health.total} (${data.source_health.verde}v/${data.source_health.amarelo}a/${data.source_health.vermelho}v)`);
  if (data.ctr) {
    console.log(`  • CTR: ${data.ctr.total_editions} ediçoes, ${data.ctr.total_links} links`);
  } else {
    console.log(`  • CTR: nao disponivel (data/link-ctr-table.csv ausente)`);
  }
  console.log(`  • Overnight: ${data.overnight.total_runs} rodadas`);
  console.log(`  • Stubs: ${data.stubs.length}`);

  if (isDryRun) {
    console.log("\n[dry-run] KV nao tocado. Use --push para fazer o upload.");
    return;
  }

  // Push pro KV
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const token = process.env["CLOUDFLARE_WORKERS_TOKEN"];

  if (!accountId || !token || !kvNamespaceId) {
    const missing = [
      !accountId && "CLOUDFLARE_ACCOUNT_ID",
      !token && "CLOUDFLARE_WORKERS_TOKEN",
      !kvNamespaceId && "DASHBOARD_KV_NAMESPACE_ID (env ou --kv-namespace-id)",
    ]
      .filter(Boolean)
      .join(", ");
    console.error(`Erro: variaveis ausentes para push: ${missing}`);
    process.exit(1);
  }

  console.log("\nFazendo push pro KV...");
  try {
    await pushToKV(json, accountId, token, kvNamespaceId);
    console.log("✓ Push bem-sucedido! Dashboard atualizado no Worker.");
    console.log("\nProximos passos (se for o primeiro deploy):");
    console.log("  1. Crie o KV namespace: wrangler kv:namespace create DASHBOARD_DATA");
    console.log("  2. Atualize wrangler.toml com o ID retornado");
    console.log("  3. Deploy: wrangler deploy (em workers/diaria-dashboard/)");
  } catch (err) {
    console.error(`Erro ao fazer push pro KV: ${err}`);
    process.exit(1);
  }
}

// So roda main() quando invocado diretamente (nao quando importado em testes)
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
