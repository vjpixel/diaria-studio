#!/usr/bin/env node
/**
 * scripts/score-pending-origin.ts (#4476 item 4)
 *
 * Formaliza em script committed a priorização por score de ORIGEM da fila
 * de entrada do canal Brevo (segmento Pending da Beehiiv) — até 260802
 * existia só como planilha manual (`data/pending-reativacao/pending-scored.csv`,
 * 627 linhas). Este script lê o CSV, ORDENA por score DESCENDENTE, grava o
 * resultado — não recalcula o score.
 *
 * ## Por que PASS-THROUGH e não recálculo (mudança de desenho, 260802)
 *
 * A 1ª versão deste script reimplementava a fórmula (`lib/shared/pending-origin-score.ts`)
 * a partir das métricas cruas — mas essa reimplementação nunca tinha sido
 * validada contra o CSV real (o worktree que a escreveu não tinha acesso a
 * `data/`). Rodada contra os 627 registros reais nesta sessão, a
 * reimplementação divergiu MATERIALMENTE do score já confirmado pelo editor
 * na planilha manual: `pts_abertura`/`pts_clique` saturavam no peso máximo
 * com muito mais frequência (a normalização linear-contra-benchmark não bate
 * com o método original, desconhecido), `penalidade_bounce` saiu ~10x mais
 * fraca, e a correlação de RANKING entre os dois caiu pra 0,83 — algumas
 * linhas mudavam até 514 posições na fila de 627. Isso é grave demais pra
 * confiar sem entender a causa exata, que não dá pra reconstruir sem a
 * fórmula original da planilha.
 *
 * Como o pool é ESTÁTICO (o fluxo de cadastro da Beehiiv mudou pra
 * instant-active — não gera mais contatos Pending novos, #4476 item 8), não
 * existe necessidade real de RECALCULAR o score pra origens futuras — só
 * de reproduzir, de forma auditável e versionada, o score que já foi
 * calculado e confirmado uma vez. Por isso este script agora só LÊ o
 * `score`/`pts_*` já presentes no CSV manual, valida consistência interna
 * (soma dos `pts_*` bate com o `score`, dentro de tolerância de
 * arredondamento) e ordena — mais simples e mais seguro que confiar numa
 * reimplementação nunca validada.
 *
 * `lib/shared/pending-origin-score.ts` (a fórmula reimplementada) continua
 * no repo, testada, mas NÃO é mais usada por este script nem por
 * `sync-pending-to-brevo.ts` — ver aviso no header daquele módulo antes de
 * reusar em qualquer coisa nova.
 *
 * ## Uso
 *
 *   npx tsx scripts/score-pending-origin.ts
 *     [--input data/pending-reativacao/pending-scored.csv]
 *     [--output data/pending-reativacao/pending-scored-computed.csv]
 *
 * Falha ALTO (nunca produz output parcial silencioso) se o input não existe,
 * uma linha não tem `email`/`score`/`pts_*` numéricos, ou a soma dos `pts_*`
 * diverge do `score` além da tolerância de arredondamento (±0.5 — o CSV
 * manual tem 1 casa decimal por campo, soma de 6 campos arredondados pode
 * derivar até ~0.3 do valor "verdadeiro"; ±0.5 dá margem sem mascarar erro
 * real).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { getArg, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_INPUT_PATH = resolve(ROOT, "data/pending-reativacao/pending-scored.csv");
export const DEFAULT_OUTPUT_PATH = resolve(ROOT, "data/pending-reativacao/pending-scored-computed.csv");

/** Tolerância de arredondamento entre soma dos `pts_*` e o `score` gravado —
 * ver header do módulo. */
export const SCORE_SUM_TOLERANCE = 0.5;

export interface PendingOriginScoredRow {
  email: string;
  origin: string;
  score: number;
  pts_confirmacao: number;
  pts_ativo: number;
  pts_abertura: number;
  pts_clique: number;
  pts_recencia: number;
  penalidade_bounce: number;
}

const PTS_FIELDS = [
  "pts_confirmacao",
  "pts_ativo",
  "pts_abertura",
  "pts_clique",
  "pts_recencia",
  "penalidade_bounce",
] as const;

function parseNumericField(raw: Record<string, string>, field: string, email: string, rowIndex: number): number {
  const raw_value = raw[field];
  const n = Number(raw_value);
  if (raw_value === undefined || raw_value === "" || Number.isNaN(n)) {
    throw new Error(`linha ${rowIndex} (${email}): campo "${field}" ausente/não-numérico ("${raw_value}").`);
  }
  return n;
}

/**
 * Pura — parse defensivo de 1 linha crua (todos os valores string, formato
 * `Papa.parse`) + checagem de consistência interna (soma dos `pts_*` bate
 * com `score`). Lança em qualquer campo ausente/não-numérico ou
 * inconsistência — fail-loud, nunca silencia uma linha malformada.
 */
export function parseScoredRow(raw: Record<string, string>, rowIndex: number): PendingOriginScoredRow {
  const email = (raw.email ?? "").trim().toLowerCase();
  if (!email) {
    throw new Error(`linha ${rowIndex}: campo "email" ausente/vazio.`);
  }
  const origin = (raw.origem ?? "").trim();
  if (!origin) {
    throw new Error(`linha ${rowIndex} (${email}): campo "origem" ausente/vazio.`);
  }
  const score = parseNumericField(raw, "score", email, rowIndex);
  const pts: Record<string, number> = {};
  for (const field of PTS_FIELDS) {
    pts[field] = parseNumericField(raw, field, email, rowIndex);
  }
  const sum = PTS_FIELDS.reduce((acc, f) => acc + pts[f], 0);
  if (Math.abs(sum - score) > SCORE_SUM_TOLERANCE) {
    throw new Error(
      `linha ${rowIndex} (${email}): soma dos pts_* (${sum.toFixed(2)}) diverge do score gravado ` +
        `(${score}) além da tolerância de ${SCORE_SUM_TOLERANCE} — dado inconsistente, não ordenar sem investigar.`,
    );
  }
  return {
    email,
    origin,
    score,
    pts_confirmacao: pts.pts_confirmacao,
    pts_ativo: pts.pts_ativo,
    pts_abertura: pts.pts_abertura,
    pts_clique: pts.pts_clique,
    pts_recencia: pts.pts_recencia,
    penalidade_bounce: pts.penalidade_bounce,
  };
}

/** Pura — ordena por score DESCENDENTE (maior prioridade primeiro —
 * consumido por `sync-pending-to-brevo.ts` pro backfill, #4476 item 5). */
export function sortByScoreDescending(rows: PendingOriginScoredRow[]): PendingOriginScoredRow[] {
  return [...rows].sort((a, b) => b.score - a.score);
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
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true, delimiter: "," });
  if (parsed.errors.length > 0) {
    log(`ERRO: falha ao parsear CSV: ${JSON.stringify(parsed.errors.slice(0, 3))}`);
    process.exit(2);
  }

  const rows = parsed.data.map((raw, i) => parseScoredRow(raw, i + 2)); // +2: header + 1-index
  log(`${rows.length} linha(s) lida(s) e validada(s) de ${inputPath}.`);

  const sorted = sortByScoreDescending(rows);
  const csvOut = Papa.unparse({
    fields: ["email", "origin", "score", "pts_confirmacao", "pts_ativo", "pts_abertura", "pts_clique", "pts_recencia", "penalidade_bounce"],
    data: sorted,
  });
  writeFileSync(outputPath, csvOut + "\n", "utf8");
  log(`${sorted.length} linha(s) escrita(s) em ${outputPath}, ordenadas por score descendente.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[score-pending-origin] erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
