/**
 * send-plan.ts (#2775 — cutover store-driven da rampa diária)
 *
 * Fonte compartilhada do plano de envio da rampa diária (warm-up morno->frio)
 * como INPUT EXTERNO por-ciclo, em vez de hardcoded no código (era `SENDS` em
 * clarice-build-edition-sends.ts, específico do ciclo 2605-06).
 *
 *   {ciclo}/send-plan.json          plano de envio (editável pelo operador)
 *   {ciclo}/sends/sends-summary.json  output do build-edition-sends (plano +
 *                                      volumes reais + listId após import)
 *
 * `block` generaliza "semana": dias do mesmo bloco recebem a mesma composição
 * estratificada da fila de prioridade (`clarice-segment.ts`); blocos diferentes
 * drenam trechos progressivamente mais frios da fila (rampa).
 *
 * `clarice-build-edition-sends.ts` (builder) lê `send-plan.json` e ESCREVE
 * `sends-summary.json`. `clarice-import-sends.ts`, `clarice-split-cells.ts` e
 * `clarice-schedule-sends.ts` (consumidores downstream) leem só
 * `sends-summary.json` — não precisam do send-plan.json bruto, pois o summary
 * já carrega n/date/day/block/scheduledAt/volume por dia (mesmos campos do
 * plano) mais os campos derivados (file/planned/actual/comp/listId).
 *
 * Ver `scripts/send-plan.example.json` para um exemplo documentado.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** 1 linha do plano de envio (input externo, `{ciclo}/send-plan.json`). */
export interface SendPlanEntry {
  /** Número sequencial do envio (1..N), 1-indexed. */
  n: number;
  /** Data legível do envio (ex: "10jun") — usada no nome do arquivo CSV. */
  date: string;
  /** Dia da semana planejado (ex: "qua") — informacional, não recalculado. */
  day: string;
  /** Bloco da rampa (generaliza "semana"): dias do mesmo bloco = mesma composição. */
  block: number;
  /** Quantos contatos este dia recebe. */
  volume: number;
  /** ISO 8601 UTC (Z) do horário de disparo agendado. */
  scheduledAt: string;
}

/** Entry de `sends-summary.json` — SendPlanEntry + campos derivados do build. */
export interface SendsSummaryEntry extends SendPlanEntry {
  /** Nome do arquivo CSV escrito (`d{NN}-{date}.csv`). */
  file: string;
  /** Volume planejado (== `volume` do plano; mantido por clareza no summary). */
  planned: number;
  /** Volume real escrito (pode divergir de `planned` por arredondamento/apportion). */
  actual: number;
  /** Composição por TIER (contagem) — auditoria. */
  comp: Record<string, number>;
  /** Injetado por `clarice-import-sends.ts --execute` após criar a lista Brevo. */
  listId?: number;
}

export interface SendsSummary {
  cycle: string;
  total: number;
  sends: SendsSummaryEntry[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Caminho do plano de envio, input externo (`{cycleDir}/send-plan.json`). */
export function sendPlanPath(cycleDir: string): string {
  return resolve(cycleDir, "send-plan.json");
}

/** Caminho do summary gerado pelo builder (`{cycleDir}/sends/sends-summary.json`). */
export function sendsSummaryPath(cycleDir: string): string {
  return resolve(cycleDir, "sends", "sends-summary.json");
}

// ---------------------------------------------------------------------------
// Validação (pura — mensagens de erro claras > falha silenciosa a jusante)
// ---------------------------------------------------------------------------

function assertPlanEntryShape(e: unknown, i: number, path: string): asserts e is SendPlanEntry {
  if (typeof e !== "object" || e === null) {
    throw new Error(`${path}: entrada [${i}] não é um objeto`);
  }
  const r = e as Record<string, unknown>;
  if (!Number.isInteger(r.n) || (r.n as number) < 1) {
    throw new Error(`${path}: entrada [${i}].n deve ser inteiro >= 1 (recebido: ${JSON.stringify(r.n)})`);
  }
  if (typeof r.date !== "string" || !r.date) {
    throw new Error(`${path}: entrada [${i}].date ausente/inválido`);
  }
  if (typeof r.day !== "string" || !r.day) {
    throw new Error(`${path}: entrada [${i}].day ausente/inválido`);
  }
  if (!Number.isInteger(r.block) || (r.block as number) < 1) {
    throw new Error(`${path}: entrada [${i}].block deve ser inteiro >= 1 (recebido: ${JSON.stringify(r.block)})`);
  }
  if (!Number.isFinite(r.volume) || (r.volume as number) <= 0) {
    throw new Error(`${path}: entrada [${i}].volume deve ser número > 0 (recebido: ${JSON.stringify(r.volume)})`);
  }
  if (typeof r.scheduledAt !== "string" || Number.isNaN(new Date(r.scheduledAt).getTime())) {
    throw new Error(`${path}: entrada [${i}].scheduledAt não é ISO 8601 válido (recebido: ${JSON.stringify(r.scheduledAt)})`);
  }
}

/**
 * Valida um array de `SendPlanEntry` já parseado (pura — sem I/O). Exportada
 * pra testabilidade e reuso (ex: validar um plano montado em memória em teste).
 *
 * Checa: shape de cada entrada, `n` únicos e cobrindo 1..N sem gaps (sequencial),
 * ordenado por `n` ascendente no retorno (defensivo — não assume ordem do arquivo).
 */
export function validateSendPlan(raw: unknown, path = "(plano)"): SendPlanEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${path}: esperado array de entradas, recebido ${typeof raw}`);
  }
  if (raw.length === 0) {
    throw new Error(`${path}: plano vazio`);
  }
  raw.forEach((e, i) => assertPlanEntryShape(e, i, path));
  const entries = (raw as SendPlanEntry[]).slice().sort((a, b) => a.n - b.n);

  const seen = new Set<number>();
  for (const e of entries) {
    if (seen.has(e.n)) throw new Error(`${path}: n=${e.n} duplicado`);
    seen.add(e.n);
  }
  for (let i = 0; i < entries.length; i++) {
    const expected = i + 1;
    if (entries[i].n !== expected) {
      throw new Error(`${path}: n deve ser sequencial 1..${entries.length} sem gaps — esperado n=${expected}, encontrado n=${entries[i].n}`);
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Loaders (I/O)
// ---------------------------------------------------------------------------

/**
 * Lê + valida `{cycleDir}/send-plan.json`. Lança com mensagem clara se ausente
 * ou malformado — o plano é input do OPERADOR (editável entre ciclos), então
 * um typo aqui não deve virar erro obscuro a jusante.
 */
export function loadSendPlan(cycleDir: string): SendPlanEntry[] {
  const path = sendPlanPath(cycleDir);
  if (!existsSync(path)) {
    throw new Error(
      `send-plan.json não existe: ${path}\n` +
        `Crie um plano de envio para o ciclo (ver scripts/send-plan.example.json).`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`send-plan.json corrompido (JSON inválido): ${path}\n${String(e)}`);
  }
  return validateSendPlan(raw, path);
}

/**
 * Lê `{cycleDir}/sends/sends-summary.json` (output do builder). Consumido
 * pelos 3 scripts downstream (import-sends, split-cells, schedule-sends) —
 * substitui o import estático de `SENDS` (#2775).
 */
export function loadSendsSummary(cycleDir: string): SendsSummary {
  const path = sendsSummaryPath(cycleDir);
  if (!existsSync(path)) {
    throw new Error(
      `sends-summary.json não existe: ${path}\n` +
        `Rode clarice-build-edition-sends.ts --cycle {ciclo} antes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`sends-summary.json corrompido (JSON inválido): ${path}\n${String(e)}`);
  }
  const summary = parsed as SendsSummary;
  if (!summary || !Array.isArray(summary.sends)) {
    throw new Error(`sends-summary.json shape inesperado (sem array 'sends'): ${path}`);
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Helpers puros
// ---------------------------------------------------------------------------

/** Blocos únicos presentes no plano, ordenados ascendente. Generaliza `ALL_WEEKS`. */
export function allBlocks(plan: SendPlanEntry[]): number[] {
  return [...new Set(plan.map((s) => s.block))].sort((a, b) => a - b);
}

/** Agrupa o plano por bloco (ordenado por `n` dentro do bloco), com o total do bloco. */
export function planByBlock(
  plan: SendPlanEntry[],
): { block: number; sends: SendPlanEntry[]; total: number }[] {
  const blocks = allBlocks(plan);
  return blocks.map((block) => {
    const sends = plan.filter((s) => s.block === block).sort((a, b) => a.n - b.n);
    const total = sends.reduce((a, s) => a + s.volume, 0);
    return { block, sends, total };
  });
}

/**
 * Parseia `--blocks 1,2,3` (ou `--weeks` como alias retrocompat — #2775).
 *
 * @param validBlocks blocos existentes no plano (usados pra filtrar valores parseados)
 * @param fallback    blocos assumidos quando a flag está ausente (default:
 *                     `validBlocks` inteiro — cada caller decide o default certo:
 *                     o builder assume TODOS os blocos do plano; o schedule-sends
 *                     assume só `[1]`, já que S2+/blocos posteriores exigem `--subject`).
 */
export function parseBlocksArg(argv: string[], validBlocks: number[], fallback?: number[]): number[] {
  const idx = (() => {
    const b = argv.indexOf("--blocks");
    if (b !== -1) return b;
    return argv.indexOf("--weeks");
  })();
  if (idx === -1) return fallback ? [...fallback] : [...validBlocks];
  const flagName = argv[idx];
  const val = argv[idx + 1];
  if (!val || val.startsWith("-")) {
    throw new Error(`${flagName} requer um valor (ex: ${flagName} 1 ou ${flagName} 2,3). Recebido: ${val ?? "(nada)"}`);
  }
  const parsed = val.split(",").map((x) => Number(x.trim())).filter((x) => validBlocks.includes(x));
  if (parsed.length === 0) {
    throw new Error(`${flagName} "${val}" não contém blocos válidos (use ${validBlocks.join(", ")}).`);
  }
  return parsed;
}
