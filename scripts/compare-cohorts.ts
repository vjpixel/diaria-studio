/**
 * compare-cohorts.ts (#4451 Fase 2/3 — tooling de validação empírica)
 *
 * Compara duas `EngagementCohorts` (mesmo shape gravado no KV pelo v1 —
 * `clarice-engagement-cohorts.ts` — e pelo v2 dry-run —
 * `clarice-engagement-cohorts-v2.ts`) e reporta, campo a campo, se batem
 * dentro de uma tolerância. É o passo 2/6 explícito do plano de execução da
 * issue #4451 ("comparar output de computeCohorts() do v2 contra o v1 —
 * empírico. só trocar a task agendada depois de baterem").
 *
 * NÃO EXECUTADO AO VIVO NESTA SESSÃO: gerar os dois arquivos de input exige
 * rodar v1 (`--dry-run --all`/`--dry-run`, ainda ~horas de crawl per-contato)
 * e v2 (`--out`) contra a Brevo real com `BREVO_CLARICE_API_KEY` — fora do
 * guard desta sessão de `/diaria-develop` (sem chamada de rede à Brevo além
 * de leitura já documentada na issue). Esta tooling deixa a comparação
 * pronta pra rodar numa sessão supervisionada com credenciais reais:
 *
 *   npx tsx scripts/clarice-engagement-cohorts.ts --dry-run > /tmp/v1.json
 *   npx tsx scripts/clarice-engagement-cohorts-v2.ts --out /tmp/v2.json
 *   npx tsx scripts/compare-cohorts.ts --a /tmp/v1.json --b /tmp/v2.json
 *
 * Tolerância default 2% (arredondado pra cima, mínimo 1) por campo — os dois
 * caminhos não são bit-idênticos por design (fontes de dado diferentes: GET
 * per-contato vs export per-campanha, ver tabela de mapeamento na issue), a
 * intenção é bater "dentro de uma margem pequena", não exato.
 *
 * v1 grava o JSON de coortes em stdout (`console.log`) mesmo sem `--out`
 * explícito — redirecionar pra arquivo funciona (`> v1.json`), mas os logs de
 * progresso vão para stderr (não contaminam o arquivo).
 *
 * SINAL DEGRADADO (#4451 achado 6 do fleet review em #4479): desde que
 * `clarice-engagement-cohorts-v2.ts --out` passou a gravar cohorts+diagnostics
 * (`scripts/lib/cohorts-v2-artifact.ts`), esta comparação recusa rodar por
 * padrão (`process.exit(1)` ANTES do diff) quando o lado v2 tem
 * `adminOptOutsAvailable=false` (store administrativo indisponível na hora do
 * export, ou `--no-admin-optouts` explícito) — sem isso, os campos
 * `exits`/`exitsBreakdown.optedOut` podiam "bater" ou "divergir" contra o v1
 * pela razão errada (comparação sobre dado sabidamente incompleto de um dos
 * lados). `--allow-degraded` sobrescreve o bloqueio, mas ainda imprime o
 * aviso — o operador reconhece o risco explicitamente, não silencia.
 */

import { readFileSync } from "node:fs";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { extractCohortsArtifact, evaluateDegradedGate } from "./lib/cohorts-v2-artifact.ts";
import type { EngagementCohorts } from "./lib/dashboard-kv-types.ts";

/** Um campo comparado entre as duas coortes. Pura — sem I/O. */
export interface CohortsDiffField {
  field: string;
  a: number;
  b: number;
  absDiff: number;
  /** tolerância absoluta usada nesta comparação (derivada de `toleranceRatio`, mínimo 1). */
  tolerance: number;
  withinTolerance: boolean;
}

const FIELDS: Array<[string, (c: EngagementCohorts) => number]> = [
  ["universe", (c) => c.universe],
  ["opened2plus", (c) => c.opened2plus],
  ["opened1", (c) => c.opened1],
  ["received1_opened0", (c) => c.received1_opened0],
  ["received2_opened0", (c) => c.received2_opened0],
  ["exits", (c) => c.exits],
  ["exitsBreakdown.bounced", (c) => c.exitsBreakdown.bounced],
  ["exitsBreakdown.optedOut", (c) => c.exitsBreakdown.optedOut],
  ["maxReceived", (c) => c.maxReceived],
];

/** Resultado agregado de `diffCohorts` — linhas por campo + veredito geral já dobrado num único retorno. */
export interface CohortsDiff {
  rows: CohortsDiffField[];
  /** true se TODOS os campos baterem dentro da tolerância. */
  allWithinTolerance: boolean;
}

/**
 * Compara duas `EngagementCohorts` campo a campo. Pura — testável sem I/O.
 * Tolerância = `max(1, round(|a| * toleranceRatio))` — pelo menos 1 unidade,
 * pra não exigir bater exato em campos pequenos (ex: exitsBreakdown.bounced
 * de 1 dígito não deveria precisar de 0% de diferença).
 */
export function diffCohorts(
  a: EngagementCohorts,
  b: EngagementCohorts,
  toleranceRatio = 0.02,
): CohortsDiff {
  const rows = FIELDS.map(([field, get]) => {
    const av = get(a);
    const bv = get(b);
    const absDiff = Math.abs(av - bv);
    const tolerance = Math.max(1, Math.round(Math.abs(av) * toleranceRatio));
    return { field, a: av, b: bv, absDiff, tolerance, withinTolerance: absDiff <= tolerance };
  });
  return { rows, allWithinTolerance: rows.every((r) => r.withinTolerance) };
}

/** Formata a tabela de diff pra stdout/log (pura — sem console.*). */
export function formatCohortsDiff(rows: CohortsDiffField[]): string {
  const header = "campo".padEnd(24) + "v1(a)".padStart(10) + "v2(b)".padStart(10) + "diff".padStart(8) + "  status";
  const lines = rows.map((r) => {
    const status = r.withinTolerance ? "✅ OK" : "❌ FORA DA TOLERÂNCIA";
    return (
      r.field.padEnd(24) +
      String(r.a).padStart(10) +
      String(r.b).padStart(10) +
      String(r.absDiff).padStart(8) +
      `  ${status} (tol ±${r.tolerance})`
    );
  });
  return [header, ...lines].join("\n");
}

function loadArtifact(path: string): ReturnType<typeof extractCohortsArtifact> {
  return extractCohortsArtifact(JSON.parse(readFileSync(path, "utf8")));
}

// exportado (#4451) só pra permitir teste direto do gate de sinal degradado
// via arquivos temporários, sem invocar o processo CLI real.
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const aPath = getArg(argv, "a");
  const bPath = getArg(argv, "b");
  const toleranceArg = getArg(argv, "tolerance");
  const toleranceRatio = toleranceArg ? Number(toleranceArg) : 0.02;
  const allowDegraded = hasFlag(argv, "allow-degraded");

  if (!aPath || !bPath) {
    console.error(
      "Uso: npx tsx scripts/compare-cohorts.ts --a v1.json --b v2.json [--tolerance 0.02] [--allow-degraded]",
    );
    process.exit(1);
  }

  const a = loadArtifact(aPath);
  const b = loadArtifact(bPath);

  // #4451 achado 6 — recusa comparar sinal degradado por padrão (ver docstring de topo).
  const gate = evaluateDegradedGate(a, b, allowDegraded);
  for (const w of gate.warnings) console.error(`⚠️  ${w}`);
  if (gate.blocked) {
    console.error(
      "\n❌ Sinal degradado detectado num dos lados — recusando comparar (risco de 'bater' ou " +
        "'divergir' pela razão errada). Passe --allow-degraded pra prosseguir mesmo assim.",
    );
    process.exit(1);
  }

  const { rows, allWithinTolerance } = diffCohorts(a.cohorts, b.cohorts, toleranceRatio);

  console.log(`Comparando ${aPath} (v1) × ${bPath} (v2), tolerância ${toleranceRatio * 100}%:\n`);
  console.log(formatCohortsDiff(rows));

  if (allWithinTolerance) {
    console.log("\n✅ Todos os campos dentro da tolerância — v2 pode ser considerado equivalente ao v1 nesta amostra.");
  } else {
    console.log(
      "\n❌ Ao menos 1 campo fora da tolerância — NÃO trocar a task agendada ainda (#4451). " +
        "Investigar a origem da diferença antes do cutover.",
    );
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
