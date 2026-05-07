#!/usr/bin/env npx tsx
/**
 * log-stage-1-payload-sizes.ts (#891)
 *
 * Reporta tamanho de cada JSON intermediário em `_internal/` da edição,
 * em bytes brutos e em estimativa de tokens (1 token ≈ 4 bytes — heurística
 * conservadora pra texto JSON estruturado).
 *
 * Output:
 *   - `data/editions/{AAMMDD}/_internal/01-payload-sizes.json` — JSON com
 *     `{ edition, generated_at, files: [{ path, bytes, est_tokens }], totals }`.
 *   - 1 evento `info` em `data/run-log.jsonl` com `level: info`,
 *     `message: "stage1_payload_sizes"`, `details: { totals, top_3 }`.
 *
 * Não fixa o context overflow ainda — só dá visibilidade pra próximo PR
 * atacar com dados concretos. Hipóteses no #891 (subagent payloads,
 * MCP responses, run-log loop, subagent retornando arquivo inteiro).
 *
 * Uso:
 *   npx tsx scripts/log-stage-1-payload-sizes.ts \
 *     --edition 260507 \
 *     [--edition-dir data/editions/260507]   # default: data/editions/{edition}
 *
 * Exit codes:
 *   0 — sucesso (sempre, mesmo se _internal/ vazio — não bloqueia gate)
 *   2 — argumentos inválidos
 *
 * Nunca falha por arquivo ausente — observabilidade é best-effort.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, relative } from "node:path";

interface FileSize {
  path: string;          // relative to repo root
  bytes: number;
  est_tokens: number;
}

interface PayloadSizesReport {
  edition: string;
  generated_at: string;
  files: FileSize[];
  totals: {
    file_count: number;
    bytes: number;
    est_tokens: number;
  };
  top_3: Array<Pick<FileSize, "path" | "bytes" | "est_tokens">>;
}

const TOKENS_PER_BYTE = 0.25; // 1 token ≈ 4 bytes (heurística JSON-conservadora)

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = val;
      i++;
    }
  }
  return out;
}

/**
 * Lista recursivamente arquivos `.json` em `_internal/`. Ignora subdiretórios
 * de bodies cacheados (potencialmente milhares de HTMLs raw — não são payloads
 * de subagent) e arquivos de backup (`.bak`, `.pre-*`).
 */
export function listInternalJsonFiles(internalDir: string): string[] {
  if (!existsSync(internalDir)) return [];
  const out: string[] = [];
  const stack: string[] = [internalDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = resolve(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // skip body caches — não são payloads de orchestrator/subagent
        if (name === "link-verify-bodies" || name.startsWith("_test-backup")) continue;
        stack.push(full);
        continue;
      }
      // só JSON, e ignorar backups
      if (!name.endsWith(".json")) continue;
      if (name.includes(".bak") || name.endsWith(".pre-refinement.bak")) continue;
      out.push(full);
    }
  }
  return out.sort();
}

export function buildReport(opts: {
  edition: string;
  internalDir: string;
  repoRoot: string;
  now?: Date;
}): PayloadSizesReport {
  const now = opts.now ?? new Date();
  const files = listInternalJsonFiles(opts.internalDir);
  const sized: FileSize[] = files.map((full) => {
    const bytes = statSync(full).size;
    return {
      path: relative(opts.repoRoot, full).replace(/\\/g, "/"),
      bytes,
      est_tokens: Math.round(bytes * TOKENS_PER_BYTE),
    };
  });
  const totals = sized.reduce(
    (acc, f) => {
      acc.bytes += f.bytes;
      acc.est_tokens += f.est_tokens;
      return acc;
    },
    { file_count: sized.length, bytes: 0, est_tokens: 0 }
  );
  const top_3 = [...sized]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((f) => ({ path: f.path, bytes: f.bytes, est_tokens: f.est_tokens }));
  return {
    edition: opts.edition,
    generated_at: now.toISOString(),
    files: sized,
    totals,
    top_3,
  };
}

/**
 * #891 P3: thresholds pra detectar regressão de payload size pós-cap.
 *
 * - 200KB warn: baseline saudável é ~150KB pós-cap (243K em 260507 com 67 sources).
 *   Sinaliza que alguma fonte explodiu, cap não cobriu, ou subagent retornou
 *   payload extra-grande no return string.
 * - 500KB error: território perigoso. Risco real de context overflow no
 *   orchestrator (~3M tokens estimados, 309% do limite, era o sintoma de #891).
 *
 * Não bloqueia gate — só dispara warn/error level no run-log pra auto-reporter
 * pegar e criar issue automática se passar.
 */
export const PAYLOAD_WARN_BYTES = 200 * 1024;
export const PAYLOAD_ERROR_BYTES = 500 * 1024;

export function payloadLevel(bytes: number): "info" | "warn" | "error" {
  if (bytes >= PAYLOAD_ERROR_BYTES) return "error";
  if (bytes >= PAYLOAD_WARN_BYTES) return "warn";
  return "info";
}

function appendRunLog(opts: {
  logPath: string;
  edition: string;
  totals: PayloadSizesReport["totals"];
  top_3: PayloadSizesReport["top_3"];
  now: Date;
}): void {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const level = payloadLevel(opts.totals.bytes);
  const event = {
    timestamp: opts.now.toISOString(),
    edition: opts.edition,
    stage: 1,
    agent: "log-stage-1-payload-sizes",
    level,
    message: "stage1_payload_sizes",
    details: {
      totals: opts.totals,
      top_3: opts.top_3,
      threshold: { warn_bytes: PAYLOAD_WARN_BYTES, error_bytes: PAYLOAD_ERROR_BYTES },
    },
  };
  appendFileSync(opts.logPath, JSON.stringify(event) + "\n", "utf8");
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

function fmtTokens(t: number): string {
  if (t < 1000) return `${t}t`;
  return `${(t / 1000).toFixed(1)}k`;
}

// Allow import without side effects (for tests)
const isCli =
  typeof process !== "undefined" &&
  process.argv[1] &&
  /log-stage-1-payload-sizes\.ts$/.test(process.argv[1].replace(/\\/g, "/"));

if (isCli) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.edition) {
    console.error("--edition AAMMDD é obrigatório");
    process.exit(2);
  }
  const repoRoot = process.cwd();
  const editionDir = args["edition-dir"]
    ? resolve(repoRoot, args["edition-dir"])
    : resolve(repoRoot, "data/editions", args.edition);
  const internalDir = resolve(editionDir, "_internal");
  const logPath = resolve(repoRoot, "data/run-log.jsonl");
  const outPath = resolve(internalDir, "01-payload-sizes.json");

  const now = new Date();
  const report = buildReport({
    edition: args.edition,
    internalDir,
    repoRoot,
    now,
  });

  // Sempre tenta gravar — se _internal/ não existir, cria.
  mkdirSync(internalDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  appendRunLog({
    logPath,
    edition: args.edition,
    totals: report.totals,
    top_3: report.top_3,
    now,
  });

  console.log(
    `[stage1-payload-sizes] ${report.totals.file_count} files, ${fmtBytes(report.totals.bytes)} (~${fmtTokens(report.totals.est_tokens)} tokens)`
  );
  if (report.top_3.length > 0) {
    console.log("  top 3:");
    for (const f of report.top_3) {
      console.log(`    ${f.path}  ${fmtBytes(f.bytes)} (~${fmtTokens(f.est_tokens)} tokens)`);
    }
  }
  console.log(`[stage1-payload-sizes] report → ${relative(repoRoot, outPath).replace(/\\/g, "/")}`);
}
