/**
 * update-stage-status.ts (#960)
 *
 * Mantém `stage-status.md` na raiz da edição com visão unificada de tempo +
 * custo por stage, atualizado **incrementalmente** durante o pipeline. Editor
 * que abre o Drive durante runs longos (30+ min) vê o progresso ao invés de
 * só ver o resultado final.
 *
 * Substitui (eventualmente) `_internal/cost.md` (visível só pós-pipeline) +
 * `stage-timing.ts` standalone (rodado no fim).
 *
 * Uso:
 *   # Inicializar (todos stages = pending) — chamado pelo orchestrator no Stage 0:
 *   npx tsx scripts/update-stage-status.ts --edition-dir data/editions/260508 --init
 *
 *   # Atualizar uma linha — chamado pelo orchestrator ao terminar cada stage:
 *   npx tsx scripts/update-stage-status.ts --edition-dir data/editions/260508 \
 *     --stage 1 --status done \
 *     [--start "2026-05-08T08:30:00Z"] [--end "2026-05-08T08:48:00Z"] \
 *     [--duration-ms 1080000] [--cost-usd 0.45] \
 *     [--tokens-in 1200000] [--tokens-out 85000] \
 *     [--models "haiku-4-5,opus-4-7"]
 *
 * Idempotente: re-rodar com mesmo `--stage` atualiza a linha existente em vez
 * de duplicar. Falha de IO não bloqueia (best-effort, observabilidade).
 *
 * Output: JSON `{ path, stage_updated, totals }` em stdout.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type StageStatus = "pending" | "running" | "done" | "failed";

export interface StageRow {
  stage: number;
  status: StageStatus;
  start?: string; // ISO
  end?: string;
  duration_ms?: number;
  cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  models?: string[];
}

export interface StageStatusDoc {
  edition: string;
  rows: StageRow[];
  generated_at: string;
  /**
   * ISO timestamp do início da run atual (#1304). Setado em `--init` e
   * preservado em todos `applyUpdate` subsequentes. Usado por
   * `collect-edition-signals.ts` pra filtrar log entries de runs anteriores
   * da mesma edition ID (caso de teste: `/diaria-test` re-executado).
   * Opcional pra back-compat — docs pré-#1304 não tinham esse campo.
   */
  run_started_at?: string;
}

export const STAGES = [0, 1, 2, 3, 4] as const;

export const STAGE_LABELS: Record<number, string> = {
  0: "Setup + dedup",
  1: "Pesquisa",
  2: "Escrita",
  3: "Imagens",
  4: "Publicação",
};

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function fmtTimeBrt(iso: string | undefined): string {
  if (!iso) return "-";
  // BRT (UTC-3) — usar Date.toLocaleString não funciona consistente em CI.
  // Fazer offset manual.
  const ms = Date.parse(iso);
  if (isNaN(ms)) return "-";
  const brt = new Date(ms - 3 * 3600 * 1000);
  const hh = String(brt.getUTCHours()).padStart(2, "0");
  const mm = String(brt.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function fmtDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return "-";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return remSec > 0 ? `${min}m${remSec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h${remMin}m` : `${hr}h`;
}

function fmtCost(usd: number | undefined): string {
  if (usd === undefined || usd === null || isNaN(usd)) return "-";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

function fmtTokens(n: number | undefined): string {
  if (n === undefined || n === null || isNaN(n)) return "-";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtTokensIO(inT: number | undefined, outT: number | undefined): string {
  if (inT === undefined && outT === undefined) return "-";
  return `${fmtTokens(inT)}/${fmtTokens(outT)}`;
}

function fmtModels(models: string[] | undefined): string {
  if (!models || models.length === 0) return "-";
  return models.join(", ");
}

function fmtStatus(s: StageStatus): string {
  return s;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export function renderStageStatus(doc: StageStatusDoc): string {
  const header = `# Stage Status — edição ${doc.edition}`;
  const subtitle = `_Atualizado: ${doc.generated_at} (UTC)_`;
  const lines: string[] = [
    header,
    "",
    subtitle,
    "",
    "| # | Stage | Status | Início (BRT) | Fim (BRT) | Duração | Custo | Tokens (in/out) | Modelos |",
    "|---|-------|--------|--------------|-----------|---------|-------|-----------------|---------|",
  ];
  for (const row of doc.rows) {
    const cells = [
      String(row.stage),
      STAGE_LABELS[row.stage] ?? `Stage ${row.stage}`,
      fmtStatus(row.status),
      fmtTimeBrt(row.start),
      fmtTimeBrt(row.end),
      fmtDuration(row.duration_ms),
      fmtCost(row.cost_usd),
      fmtTokensIO(row.tokens_in, row.tokens_out),
      fmtModels(row.models),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }

  // Totals
  const totalDuration = doc.rows.reduce((acc, r) => acc + (r.duration_ms ?? 0), 0);
  const totalCost = doc.rows.reduce((acc, r) => acc + (r.cost_usd ?? 0), 0);
  const totalIn = doc.rows.reduce((acc, r) => acc + (r.tokens_in ?? 0), 0);
  const totalOut = doc.rows.reduce((acc, r) => acc + (r.tokens_out ?? 0), 0);

  lines.push("");
  lines.push(
    `**Total**: ${fmtDuration(totalDuration)} | ${fmtCost(totalCost)} | ${fmtTokensIO(totalIn, totalOut)}`,
  );
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Parse (idempotência: reler doc atual, atualizar 1 row, regravar)
// ---------------------------------------------------------------------------

const ROW_RE = /^\|\s*(\d+)\s*\|/;

export function parseStageStatus(md: string): StageStatusDoc | null {
  const editionMatch = md.match(/^# Stage Status — edição (\S+)/m);
  if (!editionMatch) return null;
  const edition = editionMatch[1];
  const lines = md.split("\n");
  const rows: StageRow[] = [];
  for (const line of lines) {
    const m = line.match(ROW_RE);
    if (!m) continue;
    // | # | Stage | Status | Início | Fim | Duração | Custo | Tokens | Modelos |
    const cells = line.split("|").map((c) => c.trim());
    // cells[0]="" cells[1]=# ... cells[10]=""
    if (cells.length < 10) continue;
    const stageNum = parseInt(cells[1], 10);
    if (isNaN(stageNum)) continue;
    const status = cells[3] as StageStatus;
    rows.push({
      stage: stageNum,
      status: ["pending", "running", "done", "failed"].includes(status)
        ? status
        : "pending",
      // demais campos ficam undefined no parse — render usa "-" pra apresentar
      // mas update merge preserva valores conhecidos.
    });
  }
  return {
    edition,
    rows,
    generated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Update logic
// ---------------------------------------------------------------------------

export interface UpdateOpts {
  stage: number;
  status: StageStatus;
  start?: string;
  end?: string;
  duration_ms?: number;
  cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  models?: string[];
}

/**
 * Atualiza idempotentemente a linha de `stage` no `doc`. Campos undefined
 * em `opts` preservam valor existente. Retorna novo doc.
 */
export function applyUpdate(doc: StageStatusDoc, opts: UpdateOpts): StageStatusDoc {
  const newRows = doc.rows.map((r) => {
    if (r.stage !== opts.stage) return r;
    return {
      ...r,
      status: opts.status,
      start: opts.start ?? r.start,
      end: opts.end ?? r.end,
      duration_ms: opts.duration_ms ?? r.duration_ms,
      cost_usd: opts.cost_usd ?? r.cost_usd,
      tokens_in: opts.tokens_in ?? r.tokens_in,
      tokens_out: opts.tokens_out ?? r.tokens_out,
      models: opts.models ?? r.models,
    } as StageRow;
  });
  // `...doc` já preserva `run_started_at` (#1304) — não precisa repetir
  // explicitamente. Mantido só o que muda neste update.
  return { ...doc, rows: newRows, generated_at: new Date().toISOString() };
}

export function makeInitialDoc(edition: string, runStartedAt?: string): StageStatusDoc {
  return {
    edition,
    rows: STAGES.map((s) => ({ stage: s, status: "pending" as StageStatus })),
    generated_at: new Date().toISOString(),
    run_started_at: runStartedAt ?? new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// JSON sidecar (#1216) — canonical storage; MD is presentation only
// ---------------------------------------------------------------------------

/**
 * Load the canonical doc from `_internal/stage-status.json`. Falls back to
 * parsing legacy `stage-status.md` if JSON sidecar missing (back-compat with
 * pre-#1216 editions). Returns `makeInitialDoc` if neither exists.
 *
 * Pre-#1216, `parseStageStatus` only extracted stage+status from MD —
 * start/end/duration/cost/tokens were lost on every re-read. JSON sidecar
 * preserves all fields cleanly.
 */
export function loadDoc(editionDir: string, editionId: string): StageStatusDoc {
  const jsonPath = resolve(editionDir, "_internal", "stage-status.json");
  if (existsSync(jsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as StageStatusDoc;
      if (parsed.edition && Array.isArray(parsed.rows)) return parsed;
    } catch {
      // corrupted JSON — fall through to MD parse
    }
  }
  const mdPath = resolve(editionDir, "stage-status.md");
  if (existsSync(mdPath)) {
    const md = readFileSync(mdPath, "utf8");
    return parseStageStatus(md) ?? makeInitialDoc(editionId);
  }
  return makeInitialDoc(editionId);
}

/**
 * Save both JSON sidecar (canonical) and MD (rendered presentation).
 * JSON goes in `_internal/` (not for editor consumption); MD stays at edition
 * root (editor opens during runs).
 */
export function saveDoc(editionDir: string, doc: StageStatusDoc): void {
  const jsonPath = resolve(editionDir, "_internal", "stage-status.json");
  const mdPath = resolve(editionDir, "stage-status.md");
  mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(doc, null, 2), "utf8");
  writeFileSync(mdPath, renderStageStatus(doc), "utf8");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--init") out.init = true;
    else if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const editionDirRaw = args["edition-dir"] as string | undefined;
  if (!editionDirRaw) {
    console.error(
      "Uso:\n" +
        "  --edition-dir <path> --init                                # inicializa (todos pending)\n" +
        "  --edition-dir <path> --stage N --status pending|running|done|failed [field=val]...",
    );
    process.exit(2);
  }
  const editionDir = resolve(ROOT, editionDirRaw);
  const editionId = editionDir.replace(/\/$/, "").split(/[\\/]/).pop() ?? "";
  const statusPath = resolve(editionDir, "stage-status.md");

  let doc: StageStatusDoc;
  if (args.init) {
    doc = makeInitialDoc(editionId);
  } else {
    // #1216: load from JSON sidecar (canonical) — MD parse fallback for legacy.
    doc = loadDoc(editionDir, editionId);
    const stage = parseInt(args.stage as string, 10);
    if (isNaN(stage)) {
      console.error("--stage é obrigatório (número)");
      process.exit(2);
    }
    const status = (args.status as string) ?? "pending";
    if (!["pending", "running", "done", "failed"].includes(status)) {
      console.error(`--status inválido: ${status}`);
      process.exit(2);
    }
    doc = applyUpdate(doc, {
      stage,
      status: status as StageStatus,
      start: args.start as string | undefined,
      end: args.end as string | undefined,
      duration_ms: args["duration-ms"] ? parseInt(args["duration-ms"] as string, 10) : undefined,
      cost_usd: args["cost-usd"] ? parseFloat(args["cost-usd"] as string) : undefined,
      tokens_in: args["tokens-in"] ? parseInt(args["tokens-in"] as string, 10) : undefined,
      tokens_out: args["tokens-out"] ? parseInt(args["tokens-out"] as string, 10) : undefined,
      models: args.models
        ? (args.models as string).split(",").map((s) => s.trim()).filter(Boolean)
        : undefined,
    });
  }

  try {
    // #1216: persist canonical JSON + rendered MD together.
    saveDoc(editionDir, doc);
  } catch (err) {
    console.error(`falha ao gravar ${statusPath}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const totals = {
    duration_ms: doc.rows.reduce((a, r) => a + (r.duration_ms ?? 0), 0),
    cost_usd: doc.rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
    tokens_in: doc.rows.reduce((a, r) => a + (r.tokens_in ?? 0), 0),
    tokens_out: doc.rows.reduce((a, r) => a + (r.tokens_out ?? 0), 0),
  };

  console.log(
    JSON.stringify({
      path: statusPath,
      stage_updated: args.init ? "all (init)" : args.stage,
      totals,
    }),
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
