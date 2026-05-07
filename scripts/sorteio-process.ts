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
 *   npx tsx scripts/sorteio-process.ts draw --month YYYY-MM [--seed N]
 *
 * Exit codes:
 *   0 = success
 *   2 = validation error (missing required flag, malformed input)
 *   3 = duplicate (thread_id já processado em add)
 */

import { resolve } from "node:path";
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

const ENTRIES_PATH = resolve(process.cwd(), "data/contest-entries.jsonl");

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
    case "draw":
      return cmdDraw(flags);
    default:
      usage();
      return cmd ? 2 : 0;
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  process.exit(main());
}
