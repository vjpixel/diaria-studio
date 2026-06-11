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
import { fmtTimeBrt, fmtDuration } from "./lib/format.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type StageStatus = "pending" | "running" | "done" | "failed";

export interface StageRow {
  stage: number;
  status: StageStatus;
  start?: string; // ISO
  end?: string;
  gate_at?: string; // ISO — when gate was presented to editor (#1517)
  duration_ms?: number; // total (start → end), includes gate wait
  pipeline_ms?: number; // pipeline only (start → gate_at), excludes gate wait (#1517)
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

export const STAGES = [0, 1, 2, 3, 4, 5] as const;

export const STAGE_LABELS: Record<number, string> = {
  0: "Setup + dedup",
  1: "Pesquisa",
  2: "Escrita",
  3: "Imagens",
  4: "Revisão",
  5: "Publicação",
};

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
// fmtTimeBrt, fmtDuration — imported from ./lib/format.ts

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
  gate_at?: string; // #1517
  duration_ms?: number;
  pipeline_ms?: number; // #1517
  cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  models?: string[];
}

function computePipelineMs(opts: UpdateOpts, existing: StageRow): number | undefined {
  if (opts.pipeline_ms != null) return opts.pipeline_ms;
  const gateAt = opts.gate_at ?? existing.gate_at;
  const start = opts.start ?? existing.start;
  if (gateAt && start) {
    return new Date(gateAt).getTime() - new Date(start).getTime();
  }
  return existing.pipeline_ms;
}

/**
 * #1706: duração total (start → end). Quando `--duration-ms` não é passado OU é
 * passado como 0 (o orchestrator historicamente passava `--duration-ms 0`, o que
 * fazia o report mostrar "-" em todo stage), computa de `end - start` a partir
 * dos timestamps. Trata 0 como "não medido" — stages levam minutos, nunca ~0ms.
 * Retorna `undefined` só quando não há nem duração passada (>0) nem start+end.
 */
export function computeDurationMs(opts: UpdateOpts, existing: StageRow): number | undefined {
  if (opts.duration_ms != null && opts.duration_ms > 0) return opts.duration_ms;
  const start = opts.start ?? existing.start;
  const end = opts.end ?? existing.end;
  if (start && end) {
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms > 0) return ms;
  }
  // duração passada como 0 não sobrescreve um valor já computado antes.
  return existing.duration_ms;
}

/**
 * Atualiza idempotentemente a linha de `stage` no `doc`. Campos undefined
 * em `opts` preservam valor existente. Retorna novo doc.
 */
export function applyUpdate(doc: StageStatusDoc, opts: UpdateOpts, now?: string): StageStatusDoc {
  const newRows = doc.rows.map((r) => {
    if (r.stage !== opts.stage) return r;
    // #1783: auto-carimbo de timestamps quando o caller (playbook) não passa
    // --start/--end. Sem isso, todo stage que transita running→done sem timestamps
    // explícitos ficava sem duração no relatório. start: ao ENTRAR em running, se
    // ainda não há start. end: ao concluir (done/failed), se ainda não há end. Não
    // sobrescreve um start já existente (preserva o original em resume). `now` é
    // injetado (puro/testável); só auto-carimba quando fornecido.
    let start = opts.start ?? r.start;
    if (!start && opts.status === "running" && now) start = now;
    let end = opts.end ?? r.end;
    if (!end && (opts.status === "done" || opts.status === "failed") && now) end = now;
    // #1853: transição pra done/failed SEM start (o mark-running foi pulado —
    // regressão do #1783) deixava o stage sem duração silenciosamente no
    // relatório. Backfill: `start` = `end` do stage ANTERIOR (stages são
    // sequenciais → start ≈ quando o anterior terminou → duração aproximada
    // porém não-vazia). SÓ quando esse end é ANTERIOR ao end deste stage (senão
    // start>end daria duração negativa, que computeDurationMs rejeita → voltaria
    // ao `-` silencioso com um Início depois do Fim no relatório). Quando não há
    // um end-anterior válido, NÃO inventa start=end (daria duração 0, também
    // rejeitada) — warn honesto de que a duração fica vazia.
    if (!start && (opts.status === "done" || opts.status === "failed") && end) {
      const prevEnd = doc.rows.find((x) => x.stage === opts.stage - 1)?.end;
      if (prevEnd && new Date(prevEnd).getTime() < new Date(end).getTime()) {
        start = prevEnd;
        console.error(
          `[update-stage-status] stage_start_backfilled: stage ${opts.stage} marcado ${opts.status} sem start — ` +
            `usando o end do stage ${opts.stage - 1} (${prevEnd}) como start aproximado.`,
        );
      } else {
        console.error(
          `[update-stage-status] stage_start_unbackfillable: stage ${opts.stage} marcado ${opts.status} sem start e ` +
            `sem end de stage anterior anterior a ${end} — duração ficará vazia no relatório. Rode o mark-running (--start).`,
        );
      }
    }
    // Repassa os timestamps efetivos pro cálculo de duração/pipeline.
    const effective: UpdateOpts = { ...opts, start, end };
    return {
      ...r,
      status: opts.status,
      start,
      end,
      gate_at: opts.gate_at ?? r.gate_at,
      // #1706: auto-computa de start/end quando não passado ou passado como 0.
      duration_ms: computeDurationMs(effective, r),
      pipeline_ms: opts.pipeline_ms ?? computePipelineMs(effective, r),
      cost_usd: opts.cost_usd ?? r.cost_usd,
      tokens_in: opts.tokens_in ?? r.tokens_in,
      tokens_out: opts.tokens_out ?? r.tokens_out,
      models: opts.models ?? r.models,
    } as StageRow;
  });
  // `...doc` já preserva `run_started_at` (#1304) — não precisa repetir
  // explicitamente. Mantido só o que muda neste update.
  return { ...doc, rows: newRows, generated_at: now ?? new Date().toISOString() };
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
// Stage transition gates (#1530, #1563)
// ---------------------------------------------------------------------------

/**
 * Pre-conditions checked before marking a stage as `done`. Centralized so
 * that BOTH the CLI (`update-stage-status --status done`) and the sentinel
 * auto-update path (`pipeline-sentinel write` via #1563) enforce the same
 * gate. Returns `null` if the transition is allowed, or a string reason.
 */
export function blockReasonForMarkingStageDone(
  editionDir: string,
  stage: number,
): string | null {
  // #1530: Stage 5 done requires edition-report.html — blocks closing
  // without auto-reporter + report email.
  // (#1694: was Stage 4 before split into Revisão+Publicação)
  if (stage === 5) {
    const reportPath = resolve(editionDir, "_internal", "edition-report.html");
    if (!existsSync(reportPath)) {
      return `Stage 5 cannot be marked done without edition report (missing ${reportPath})`;
    }
    // #1577: Stage 5 done também exige review_completed=true em
    // 05-published.json. Orchestrator escapava marcando done sem rodar
    // o loop verify→fix do test email (caso 260529: review_completed=false,
    // review_status=pending mas stage marked done).
    const publishedPath = resolve(editionDir, "_internal", "05-published.json");
    if (existsSync(publishedPath)) {
      try {
        const pub = JSON.parse(readFileSync(publishedPath, "utf8")) as {
          review_completed?: boolean;
          review_status?: string;
        };
        // Aceita review_completed=true OU review_status explicito
        // ("issues_unfixable" / "inconclusive") — orchestrator declarou
        // resultado terminal. Bloqueia "pending" (loop não rodou).
        const explicitTerminal =
          pub.review_status === "issues_unfixable" ||
          pub.review_status === "inconclusive";
        if (!pub.review_completed && !explicitTerminal) {
          return (
            `Stage 5 cannot be marked done without review-test-email loop ` +
            `(05-published.json: review_completed=${pub.review_completed ?? "missing"}, ` +
            `review_status=${pub.review_status ?? "missing"}). Run Agent(review-test-email) first.`
          );
        }
      } catch {
        // Corrupted JSON — outro check pega; não bloqueia transition aqui.
      }
    }
  }
  return null;
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
    // #1530 + #1563: stage transition gates (centralized)
    if (status === "done") {
      const blockReason = blockReasonForMarkingStageDone(editionDir, stage);
      if (blockReason) {
        console.error(
          `[update-stage-status] BLOCKED: ${blockReason}\n` +
          `  Run: npx tsx scripts/send-edition-report.ts --edition {AAMMDD} --edition-dir ${editionDirRaw}/`,
        );
        process.exit(1);
      }
    }

    doc = applyUpdate(
      doc,
      {
        stage,
        status: status as StageStatus,
        start: args.start as string | undefined,
        end: args.end as string | undefined,
        gate_at: args["gate-at"] as string | undefined,
        duration_ms: args["duration-ms"] ? parseInt(args["duration-ms"] as string, 10) : undefined,
        pipeline_ms: args["pipeline-ms"] ? parseInt(args["pipeline-ms"] as string, 10) : undefined,
        cost_usd: args["cost-usd"] ? parseFloat(args["cost-usd"] as string) : undefined,
        tokens_in: args["tokens-in"] ? parseInt(args["tokens-in"] as string, 10) : undefined,
        tokens_out: args["tokens-out"] ? parseInt(args["tokens-out"] as string, 10) : undefined,
        models: args.models
          ? (args.models as string).split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
      },
      // #1783: now real pro auto-carimbo de start/end quando o playbook não passa.
      new Date().toISOString(),
    );
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
