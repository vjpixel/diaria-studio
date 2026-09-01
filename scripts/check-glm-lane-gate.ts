#!/usr/bin/env npx tsx
/**
 * check-glm-lane-gate.ts (#6930)
 *
 * CLI do gate de critérios de morte/teto do piloto GLM — ver
 * `scripts/lib/glm-lane-gate.ts` pra lógica pura. Lê `data/glm-lane/
 * units.jsonl` (uma unidade por linha, formato de
 * `scripts/record-glm-lane-unit.ts`), computa o estado agregado e decide
 * se o PRÓXIMO despacho pode acontecer.
 *
 * Uso:
 *   npx tsx scripts/check-glm-lane-gate.ts --units-log data/glm-lane/units.jsonl \
 *     --units-cap 10 [--sonnet-cost-per-issue 1.23]
 *
 * Exit codes: 0 = autorizado a despachar; 1 = recusado (teto ou critério
 * de morte); 2 = uso de CLI inválido (flag ausente/não-numérica). Arquivo
 * `units.jsonl` AUSENTE não é erro — 0 unidades despachadas é o estado
 * inicial legítimo do piloto. Uma linha do arquivo malformada/com shape
 * inválido também não é erro de CLI — é IGNORADA e contada em
 * `malformedCount` (ver `readGlmLaneUnits`), nunca vira `exit 2`.
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  computeGlmLaneState,
  evaluateGlmLaneGate,
  selectFirstThreeModelPrNumbers,
  type GlmLaneUnitRecord,
} from "./lib/glm-lane-gate.ts";

/** #6954 (review silent-failure-hunter, P2/medium-high): `execFileSync`
 *  sem timeout pode travar indefinidamente se `gh` pendurar (rede
 *  degradada, auth pendente) — o gate roda ANTES do despacho caro do
 *  GLM, então um stall aqui prende a unidade inteira sem nenhum
 *  diagnóstico. 15s é generoso pra uma chamada `gh pr view` simples. */
const GH_EXEC_TIMEOUT_MS = 15_000;

/**
 * Type guard de shape — não só "é JSON válido" (achado de review, PR
 * #6941, confirmado por 2 agentes independentes): um objeto
 * sintaticamente válido mas com campo AUSENTE (`{}`, um registro de
 * schema antigo/futuro, uma linha truncada por conflito de sync do
 * OneDrive que ainda parseia) tinha `campo === undefined`, e
 * `undefined !== null` é `true` — um `prNumber` ausente contava como "tem
 * PR" em `computeGlmLaneState`, invertendo exatamente o critério de morte
 * 2 que existe pra pegar "zero PRs". Este guard fecha isso na LEITURA,
 * antes do dado alcançar a lógica pura.
 */
function isValidUnitRecord(value: unknown): value is GlmLaneUnitRecord {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.issue === "number" &&
    typeof o.startedAt === "string" &&
    (o.endedAt === null || typeof o.endedAt === "string") &&
    (o.durationSec === null || typeof o.durationSec === "number") &&
    (o.costUsd === null || typeof o.costUsd === "number") &&
    (o.prNumber === null || typeof o.prNumber === "number") &&
    (o.reviewRounds === null || typeof o.reviewRounds === "number") &&
    (o.status === "completed" || o.status === "infra-error")
  );
}

export interface ReadGlmLaneUnitsResult {
  records: GlmLaneUnitRecord[];
  /** Linhas descartadas por JSON inválido OU shape inválido — surfaçado
   *  separado (não só um log perdido em stderr, achado de review P2):
   *  um `units.jsonl` corrompido silenciosamente subcontava
   *  `unitsDispatched`, deixando o teto de 10 unidades andar pra sempre
   *  contra um denominador errado. */
  malformedCount: number;
}

/** Lê e valida o JSONL — linha malformada (JSON inválido OU shape
 *  inválido) é IGNORADA e contada em `malformedCount`, nunca derruba a
 *  leitura das demais; arquivo ausente = lista vazia, `malformedCount=0`. */
export function readGlmLaneUnits(path: string): ReadGlmLaneUnitsResult {
  if (!existsSync(path)) return { records: [], malformedCount: 0 };
  const raw = readFileSync(path, "utf8");
  const records: GlmLaneUnitRecord[] = [];
  let malformedCount = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      console.error(`[check-glm-lane-gate] linha malformada (JSON inválido) ignorada: ${trimmed.slice(0, 200)}`);
      malformedCount++;
      continue;
    }
    if (!isValidUnitRecord(parsed)) {
      console.error(`[check-glm-lane-gate] linha com shape inválido ignorada: ${trimmed.slice(0, 200)}`);
      malformedCount++;
      continue;
    }
    records.push(parsed);
  }
  return { records, malformedCount };
}

/** Injeção de `execFileSync` — só pra testabilidade determinística, sem
 *  depender do `gh` real (mesmo racional de `SessionDiscoveryOps` em
 *  `claude-session-version-drift-alarm.ts`). */
export type GhExec = (args: string[]) => string;

const defaultGhExec: GhExec = (args) => execFileSync("gh", args, { encoding: "utf8", timeout: GH_EXEC_TIMEOUT_MS });

/**
 * Consulta o `gh` UMA vez por PR nos `prNumbers` dados e devolve o
 * subconjunto que está `MERGED` agora (#6954 — o critério de morte 2
 * precisa saber "mergeou", não só "foi aberta", e isso só é conhecível
 * fazendo o fetch AO VIVO — o estado muda depois do momento em que a
 * unidade que abriu a PR terminou e gravou seu registro em `units.jsonl`).
 *
 * Falha do `gh` numa PR individual (rede, rate limit, PR deletada) NUNCA
 * derruba a checagem inteira — vira warning em stderr e aquela PR conta
 * como "não confirmada mergeada" (direção conservadora: um erro de
 * consulta não deve fabricar um "sim" que destrava o próximo despacho
 * silenciosamente; na pior hipótese, um falso-negativo aqui só faz o
 * critério de morte ficar 1 tick mais cedo em avaliar "zero mergeadas",
 * nunca esconde um problema real).
 */
export function fetchMergedPrNumbers(prNumbers: readonly number[], ghExec: GhExec = defaultGhExec): Set<number> {
  const merged = new Set<number>();
  for (const pr of prNumbers) {
    try {
      const state = ghExec(["pr", "view", String(pr), "--json", "state", "-q", ".state"]).trim();
      if (state === "MERGED") merged.add(pr);
    } catch (e) {
      console.error(`[check-glm-lane-gate] não deu pra consultar o estado da PR #${pr} via gh: ${(e as Error).message}`);
    }
  }
  return merged;
}

if (isMainModule(import.meta.url)) {
  const { values } = parseArgs(process.argv.slice(2));
  const unitsLogPath = values["units-log"];
  const unitsCapRaw = values["units-cap"];
  const sonnetCostRaw = values["sonnet-cost-per-issue"];

  if (!unitsLogPath || !unitsCapRaw || !Number.isFinite(Number(unitsCapRaw))) {
    console.error("[check-glm-lane-gate] uso: --units-log PATH --units-cap N [--sonnet-cost-per-issue USD]");
    process.exit(2);
  }
  // #6941 (P3): --sonnet-cost-per-issue não validado virava NaN — nunca
  // `null`, então "não configurada" (correto: critério inerte) e "valor
  // inválido" (deveria ser erro de uso) colapsavam no mesmo resultado
  // silencioso (NaN > x é sempre false, o critério nunca dispara, sem
  // aviso de que o valor passado era lixo).
  if (sonnetCostRaw !== undefined && !Number.isFinite(Number(sonnetCostRaw))) {
    console.error(`[check-glm-lane-gate] --sonnet-cost-per-issue precisa ser numérico, recebido: ${sonnetCostRaw}`);
    process.exit(2);
  }

  const { records, malformedCount } = readGlmLaneUnits(unitsLogPath);

  // #6954 — só consulta o `gh` pras PRs que de fato entram no critério 2
  // (as 3 primeiras unidades de MODELO, status !== "infra-error"), nunca
  // o histórico inteiro — mantém o custo de rede proporcional ao que a
  // decisão realmente precisa, mesmo com `units.jsonl` crescendo. Fonte
  // única com `computeGlmLaneState` via `selectFirstThreeModelPrNumbers`
  // (achado de review, 2 agentes independentes: antes cada lado reescrevia
  // esse filtro por conta própria, sem garantia de ficarem em sincronia).
  const firstThreePrNumbers = selectFirstThreeModelPrNumbers(records);
  const mergedCheckedCount = firstThreePrNumbers.length;
  const mergedPrNumbers = fetchMergedPrNumbers(firstThreePrNumbers);
  const mergedConfirmedFailures = mergedCheckedCount - mergedPrNumbers.size;

  const state = computeGlmLaneState(records, {
    unitsCap: Number(unitsCapRaw),
    sonnetLaneCostPerIssueUsd: sonnetCostRaw ? Number(sonnetCostRaw) : null,
    mergedPrNumbers,
  });
  const verdict = evaluateGlmLaneGate(state);

  const malformedNote = malformedCount > 0 ? ` malformadas=${malformedCount}` : "";
  // #6954 (achado de review, type-design-analyzer): quando o critério 2
  // reprova, o `reason` sozinho não distingue "checamos e nenhuma
  // mergeou" de "o `gh` falhou pra alguma/todas as consultas" — as duas
  // produzem `mergedPrNumbers` menor do que o esperado. Anexa a contagem
  // de não-confirmadas (que pode ser por não-merge OU por falha de
  // consulta — `fetchMergedPrNumbers` já loga qual caso é qual, por PR,
  // em stderr) pra quem ler o log do piloto não confundir os dois.
  const mergeCheckNote =
    state.firstThreeHadAnyMergedPr === false && mergedCheckedCount > 0
      ? ` (${mergedConfirmedFailures}/${mergedCheckedCount} PR(s) não confirmada(s) mergeada(s) — ver stderr acima se algum for falha de consulta ao gh, não ausência de merge)`
      : "";
  console.log(
    `[check-glm-lane-gate] unidades=${state.unitsDispatched}/${state.unitsCap}${malformedNote} allow=${verdict.allow} — ${verdict.reason}${mergeCheckNote}`,
  );
  process.exit(verdict.allow ? 0 : 1);
}
