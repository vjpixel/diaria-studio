#!/usr/bin/env node
/**
 * scripts/score-pending-origin.ts (#4476 item 4)
 *
 * Formaliza em script committed a priorização por score de ORIGEM da fila
 * de entrada do canal Brevo (segmento Pending da Beehiiv) — até 260802
 * existia só como planilha manual (`data/pending-reativacao/pending-scored.csv`,
 * 627 linhas). A fórmula PURA vive em `lib/shared/pending-origin-score.ts`
 * (testada isoladamente com fixture); este script é só a orquestração I/O:
 * lê o CSV de métricas por contato, aplica a fórmula, ordena por score
 * DESCENDENTE, grava o resultado.
 *
 * ## Schema de entrada esperado (#4476 self-review — NÃO confirmado contra
 * o CSV real)
 *
 * Este worktree não tem acesso a `data/pending-reativacao/pending-scored.csv`
 * (junction OneDrive ausente — ver CLAUDE.md #2643). As colunas abaixo usam
 * os NOMES LITERAIS dos campos como descritos na issue #4476 item 4 — é a
 * melhor informação disponível, mas não foi confirmada byte-a-byte contra o
 * cabeçalho real do CSV. `email` e `origin` são identidade (não entram na
 * fórmula); as demais são as métricas de `PendingOriginMetrics`:
 *
 *   email, origin, conv_confirmacao_pct, conv_ativo_pct, abertura_origem_pct,
 *   clique_origem_pct, dias_desde_cadastro, invalido_origem_pct
 *
 * Antes do primeiro uso real, o editor deve confirmar esse cabeçalho contra
 * o CSV real (ou ajustar `parseInputRow` abaixo se os nomes divergirem) e
 * comparar a distribuição de score resultante com a planilha manual
 * original — a fórmula em si já foi confirmada pelo editor (#4476 item 4,
 * "não recalcular"), só o MAPEAMENTO de colunas é uma assunção.
 *
 * ## Uso
 *
 *   npx tsx scripts/score-pending-origin.ts
 *     [--input data/pending-reativacao/pending-scored.csv]
 *     [--output data/pending-reativacao/pending-scored-computed.csv]
 *
 * Falha ALTO (nunca produz output parcial silencioso) se o input não existe
 * ou uma linha não tem as colunas numéricas esperadas.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { getArg } from "./lib/cli-args.ts";
import { isMainModule } from "./lib/cli-args.ts";
import {
  computePendingOriginScore,
  type PendingOriginMetrics,
  type PendingOriginScoreBreakdown,
} from "./lib/shared/pending-origin-score.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_INPUT_PATH = resolve(ROOT, "data/pending-reativacao/pending-scored.csv");
export const DEFAULT_OUTPUT_PATH = resolve(ROOT, "data/pending-reativacao/pending-scored-computed.csv");

export interface PendingOriginInputRow {
  email: string;
  origin: string;
}

export interface PendingOriginScoredRow extends PendingOriginInputRow, PendingOriginScoreBreakdown {}

const NUMERIC_FIELDS: (keyof PendingOriginMetrics)[] = [
  "conv_confirmacao_pct",
  "conv_ativo_pct",
  "abertura_origem_pct",
  "clique_origem_pct",
  "dias_desde_cadastro",
  "invalido_origem_pct",
];

/**
 * Pura — converte 1 linha crua do CSV (todos os valores são string, formato
 * padrão de `Papa.parse`) numa linha tipada. Lança em campo numérico
 * ausente/não-numérico ou `email` vazio — fail-loud, nunca silencia uma
 * linha malformada como "score 0".
 */
export function parseInputRow(raw: Record<string, string>, rowIndex: number): PendingOriginInputRow & PendingOriginMetrics {
  const email = (raw.email ?? "").trim().toLowerCase();
  if (!email) {
    throw new Error(`linha ${rowIndex}: campo "email" ausente/vazio.`);
  }
  const origin = (raw.origin ?? "").trim();
  const metrics: Partial<PendingOriginMetrics> = {};
  for (const field of NUMERIC_FIELDS) {
    const raw_value = raw[field];
    const n = Number(raw_value);
    if (raw_value === undefined || raw_value === "" || Number.isNaN(n)) {
      throw new Error(`linha ${rowIndex} (${email}): campo "${field}" ausente/não-numérico ("${raw_value}").`);
    }
    metrics[field] = n;
  }
  return { email, origin, ...(metrics as PendingOriginMetrics) };
}

/** Pura — aplica a fórmula a todas as linhas parseadas, ordena por score
 * DESCENDENTE (maior prioridade primeiro — consumido por `sync-pending-to-brevo.ts`
 * pro backfill, #4476 item 5). */
export function scoreAndSortRows(rows: (PendingOriginInputRow & PendingOriginMetrics)[]): PendingOriginScoredRow[] {
  const scored = rows.map((r) => ({ email: r.email, origin: r.origin, ...computePendingOriginScore(r) }));
  return scored.sort((a, b) => b.score - a.score);
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const inputPath = getArg(argv, "input") || DEFAULT_INPUT_PATH;
  const outputPath = getArg(argv, "output") || DEFAULT_OUTPUT_PATH;
  const log = (msg: string) => process.stderr.write(`[score-pending-origin] ${msg}\n`);

  if (!existsSync(inputPath)) {
    log(`ERRO: input não encontrado em ${inputPath}.`);
    log(`Se "data/" for o junction OneDrive (CLAUDE.md #2643) e este é um clone/worktree` +
      ` sem o junction criado, rode este script numa sessão local com "data/" montada.`);
    process.exit(2);
  }

  const csvText = readFileSync(inputPath, "utf8");
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0) {
    log(`ERRO: falha ao parsear CSV: ${JSON.stringify(parsed.errors.slice(0, 3))}`);
    process.exit(2);
  }

  const inputRows = parsed.data.map((raw, i) => parseInputRow(raw, i + 2)); // +2: header + 1-index
  log(`${inputRows.length} linha(s) lida(s) de ${inputPath}.`);

  const scored = scoreAndSortRows(inputRows);
  const csvOut = Papa.unparse({
    fields: ["email", "origin", "score", "pts_confirmacao", "pts_ativo", "pts_abertura", "pts_clique", "pts_recencia", "penalidade_bounce"],
    data: scored,
  });
  writeFileSync(outputPath, csvOut + "\n", "utf8");
  log(`${scored.length} linha(s) escrita(s) em ${outputPath}, ordenadas por score descendente.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[score-pending-origin] erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
