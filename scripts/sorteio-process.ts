#!/usr/bin/env npx tsx
/**
 * sorteio-process.ts (#597)
 *
 * CLI determinística pra operações do sorteio mensal "ache o erro,
 * ganhe um número". Invocada pela skill `/diaria-sorteio` quando o
 * editor aprova um participante via Gmail MCP, e ao final do mês pra
 * sortear o ganhador.
 *
 * Não toca Gmail aqui — esse é trabalho da skill (que tem o MCP). Esta
 * CLI lida só com `data/contest-entries.jsonl`: list/add/draw.
 *
 * Uso:
 *   npx tsx scripts/sorteio-process.ts list [--month YYYY-MM]
 *   npx tsx scripts/sorteio-process.ts add --month YYYY-MM \
 *     --email leitor@example.com --name "Nome" --edition 260504 \
 *     --error-type factual --detail "..." --thread-id 19df33...
 *   npx tsx scripts/sorteio-process.ts batch-add --decisions decisions.json [--output results.json]
 *   npx tsx scripts/sorteio-process.ts draw --month YYYY-MM [--seed N]
 *
 * Exit codes:
 *   0 = success
 *   2 = validation error (missing required flag, malformed input)
 *   3 = duplicate (thread_id já processado em add — modo single)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  loadEntries,
  appendEntry,
  nextNumber,
  findByThreadId,
  drawWinner,
  drawMonthLabel,
  formatReplyText,
  type ContestEntry,
} from "./lib/contest-entries.ts";

/**
 * Path do storage do sorteio. Default = `data/contest-entries.jsonl` no
 * cwd. Override via env var `CONTEST_ENTRIES_PATH` (usado em testes pra
 * isolar storage sem afetar dados reais). CLI flag `--entries-path` no
 * batch-add tem precedência maior que ambos pra simplificar invocação
 * pontual.
 */
const ENTRIES_PATH = resolve(
  process.cwd(),
  process.env.CONTEST_ENTRIES_PATH ?? "data/contest-entries.jsonl",
);

function parseArgs(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[a.slice(2)] = argv[i + 1];
      i++;
    } else if (a.startsWith("--")) {
      flags[a.slice(2)] = "true";
    }
  }
  return flags;
}

function isValidDrawMonth(s: string | undefined): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}$/.test(s);
}

function cmdList(flags: Record<string, string>): number {
  const entries = loadEntries(ENTRIES_PATH);
  const month = flags.month;
  const filtered = month ? entries.filter((e) => e.draw_month === month) : entries;
  if (filtered.length === 0) {
    process.stdout.write(
      JSON.stringify({ entries: [], total: 0, filter: month ?? null }, null, 2) + "\n",
    );
    return 0;
  }
  process.stdout.write(
    JSON.stringify(
      {
        entries: filtered,
        total: filtered.length,
        filter: month ?? null,
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
}

function cmdAdd(flags: Record<string, string>): number {
  const required = ["month", "email", "name", "edition", "error-type", "detail", "thread-id"];
  const missing = required.filter((k) => !flags[k]);
  if (missing.length > 0) {
    process.stderr.write(
      `Erro: flags faltando: ${missing.map((m) => `--${m}`).join(", ")}\n`,
    );
    return 2;
  }
  if (!isValidDrawMonth(flags.month)) {
    process.stderr.write(`Erro: --month deve ser YYYY-MM (recebeu: ${flags.month})\n`);
    return 2;
  }

  const entries = loadEntries(ENTRIES_PATH);
  const dup = findByThreadId(entries, flags["thread-id"]);
  if (dup) {
    process.stderr.write(
      `Erro: thread ${flags["thread-id"]} já foi processada (number ${dup.number} em ${dup.draw_month})\n`,
    );
    process.stdout.write(JSON.stringify({ duplicate: true, existing: dup }, null, 2) + "\n");
    return 3;
  }

  const number = nextNumber(entries, flags.month);
  const entry: ContestEntry = {
    draw_month: flags.month,
    number,
    reader_email: flags.email,
    reader_name: flags.name,
    edition: flags.edition,
    error_type: flags["error-type"],
    detail: flags.detail,
    reply_thread_id: flags["thread-id"],
    confirmed_at: new Date().toISOString(),
  };

  appendEntry(ENTRIES_PATH, entry);

  process.stderr.write(
    `[sorteio] entry ${number} adicionada para ${entry.reader_email} (sorteio ${drawMonthLabel(flags.month)})\n`,
  );

  process.stdout.write(
    JSON.stringify(
      {
        entry,
        reply_text: formatReplyText(entry),
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
}

/**
 * Schema de decision (input do modo batch).
 *   - action="approve" → invoca lógica equivalente ao `add` single.
 *   - action="reject" / "skip" → registra resultado mas não escreve entry.
 */
interface BatchDecision {
  thread_id: string;
  action: "approve" | "reject" | "skip";
  // approve-only:
  month?: string;
  email?: string;
  name?: string;
  edition?: string;
  error_type?: string;
  detail?: string;
}

interface BatchResult {
  thread_id: string;
  status: "approved" | "rejected" | "skipped" | "duplicate" | "error";
  number?: number;
  reply_text?: string;
  reason?: string;
}

/**
 * Modo batch (#929): aplica array de decisões em lote — usado pelo Stage 0
 * do orchestrator pra processar múltiplas respostas de leitores numa única
 * passagem (em vez de gate thread-por-thread).
 *
 * Idempotente: thread_id já processado retorna `status: "duplicate"` em vez
 * de reescrever a entry.
 */
function cmdBatchAdd(flags: Record<string, string>): number {
  const decisionsPath = flags["decisions"];
  if (!decisionsPath) {
    process.stderr.write("Erro: --decisions OBRIGATÓRIO (path JSON com array)\n");
    return 2;
  }

  let decisions: BatchDecision[];
  try {
    const raw = readFileSync(resolve(process.cwd(), decisionsPath), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("decisions JSON must be an array");
    }
    decisions = parsed as BatchDecision[];
  } catch (err) {
    process.stderr.write(
      `Erro lendo --decisions: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 2;
  }

  const results: BatchResult[] = [];
  // Recarregar entries após cada approve — cheap, garante nextNumber correto
  // se múltiplos approves do mesmo mês entrarem na mesma batch.
  for (const d of decisions) {
    if (!d.thread_id) {
      results.push({ thread_id: "", status: "error", reason: "thread_id ausente" });
      continue;
    }

    if (d.action === "skip") {
      results.push({ thread_id: d.thread_id, status: "skipped" });
      continue;
    }

    if (d.action === "reject") {
      results.push({ thread_id: d.thread_id, status: "rejected" });
      continue;
    }

    if (d.action !== "approve") {
      results.push({
        thread_id: d.thread_id,
        status: "error",
        reason: `action desconhecida: ${d.action}`,
      });
      continue;
    }

    // action === "approve" — validar required + delegar pra lógica add.
    const required = ["month", "email", "name", "edition", "error_type", "detail"];
    const missing = required.filter((k) => !d[k as keyof BatchDecision]);
    if (missing.length > 0) {
      results.push({
        thread_id: d.thread_id,
        status: "error",
        reason: `flags faltando para approve: ${missing.join(", ")}`,
      });
      continue;
    }
    if (!isValidDrawMonth(d.month)) {
      results.push({
        thread_id: d.thread_id,
        status: "error",
        reason: `month inválido: ${d.month}`,
      });
      continue;
    }

    const entries = loadEntries(ENTRIES_PATH);
    const dup = findByThreadId(entries, d.thread_id);
    if (dup) {
      results.push({
        thread_id: d.thread_id,
        status: "duplicate",
        number: dup.number,
        reason: `já processado em ${dup.draw_month}`,
      });
      continue;
    }

    const number = nextNumber(entries, d.month!);
    const entry: ContestEntry = {
      draw_month: d.month!,
      number,
      reader_email: d.email!,
      reader_name: d.name!,
      edition: d.edition!,
      error_type: d.error_type!,
      detail: d.detail!,
      reply_thread_id: d.thread_id,
      confirmed_at: new Date().toISOString(),
    };
    appendEntry(ENTRIES_PATH, entry);
    results.push({
      thread_id: d.thread_id,
      status: "approved",
      number,
      reply_text: formatReplyText(entry),
    });
  }

  const summary = {
    total: decisions.length,
    approved: results.filter((r) => r.status === "approved").length,
    rejected: results.filter((r) => r.status === "rejected").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    duplicate: results.filter((r) => r.status === "duplicate").length,
    error: results.filter((r) => r.status === "error").length,
  };

  const output = { summary, results };

  if (flags.output) {
    const outPath = resolve(process.cwd(), flags.output);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n", "utf8");
  }

  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  process.stderr.write(
    `[sorteio batch] ${summary.approved} approved, ${summary.rejected} rejected, ${summary.skipped} skipped, ${summary.duplicate} duplicate, ${summary.error} error\n`,
  );
  return summary.error > 0 ? 0 : 0; // erros vão no JSON; exit 0 sempre que processou
}

function cmdDraw(flags: Record<string, string>): number {
  if (!isValidDrawMonth(flags.month)) {
    process.stderr.write(`Erro: --month obrigatório no formato YYYY-MM\n`);
    return 2;
  }
  const entries = loadEntries(ENTRIES_PATH);

  // RNG opcional com seed pra reproducibilidade (testes / verificação manual).
  let rng: () => number = Math.random;
  if (flags.seed) {
    const seed = parseInt(flags.seed, 10);
    if (!Number.isFinite(seed)) {
      process.stderr.write(`Erro: --seed deve ser inteiro\n`);
      return 2;
    }
    // Mulberry32 — pequeno PRNG determinístico
    let state = seed;
    rng = () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const winner = drawWinner(entries, flags.month, rng);
  const candidates = entries.filter((e) => e.draw_month === flags.month);

  if (!winner) {
    process.stderr.write(
      `[sorteio] nenhum participante em ${flags.month} — nada a sortear\n`,
    );
    process.stdout.write(
      JSON.stringify(
        { winner: null, candidates_count: 0, draw_month: flags.month },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  process.stderr.write(
    `[sorteio] ${candidates.length} participante(s) em ${drawMonthLabel(flags.month)} — vencedor: #${winner.number} ${winner.reader_name} (${winner.reader_email})\n`,
  );

  process.stdout.write(
    JSON.stringify(
      {
        winner,
        candidates_count: candidates.length,
        draw_month: flags.month,
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
}

function usage(): void {
  process.stderr.write(
    [
      "Uso:",
      "  sorteio-process.ts list [--month YYYY-MM]",
      "  sorteio-process.ts add --month YYYY-MM --email EMAIL --name NOME \\",
      "                          --edition AAMMDD --error-type TYPE --detail STR \\",
      "                          --thread-id GMAIL_THREAD_ID",
      "  sorteio-process.ts batch-add --decisions decisions.json [--output results.json]",
      "  sorteio-process.ts draw --month YYYY-MM [--seed N]",
      "",
      "Exit codes: 0 ok | 2 validation | 3 duplicate (add only)",
      "",
    ].join("\n"),
  );
}

function main(): number {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseArgs(argv.slice(1));
  switch (cmd) {
    case "list":
      return cmdList(flags);
    case "add":
      return cmdAdd(flags);
    case "batch-add":
      return cmdBatchAdd(flags);
    case "draw":
      return cmdDraw(flags);
    default:
      usage();
      return cmd ? 2 : 0;
  }
}

// Re-export para testes
export { cmdBatchAdd, type BatchDecision, type BatchResult };

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  process.exit(main());
}
