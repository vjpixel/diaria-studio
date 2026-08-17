/**
 * compare-control-editions.ts (#5547 item 2)
 *
 * CLI do comparador antes/depois. Recebe os 2 JSONs produzidos por
 * `scripts/measure-control-edition.ts --out ...` (baseline e tratamento) e
 * emite a tabela lado a lado com o veredito explícito — qual dos 2 casos da
 * #5419 ocorreu, não só os números crus (ver
 * `scripts/lib/control-edition-compare.ts` para os critérios exatos).
 *
 * Uso:
 *   npx tsx scripts/measure-control-edition.ts --edition 260814b --out /tmp/baseline.json
 *   npx tsx scripts/measure-control-edition.ts --edition 260815t --out /tmp/tratamento.json
 *   npx tsx scripts/compare-control-editions.ts --baseline /tmp/baseline.json --treatment /tmp/tratamento.json
 *   npx tsx scripts/compare-control-editions.ts --baseline ... --treatment ... --json  # output JSON puro
 *
 * A #5419 fica reduzida exatamente a esta sequência de 3 comandos (ver
 * "Critério de pronto" da #5547).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseArgsLib, isMainModule } from "./lib/cli-args.ts";
import { compareControlEditions, formatComparisonReport } from "./lib/control-edition-compare.ts";
import type { ControlEditionMeasurementWithContamination } from "./lib/control-edition-metrics.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadMeasurement(path: string): ControlEditionMeasurementWithContamination {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as ControlEditionMeasurementWithContamination;
}

function main(): void {
  const { values, flags } = parseArgsLib(process.argv.slice(2));
  const baselinePath = values["baseline"];
  const treatmentPath = values["treatment"];
  if (!baselinePath || !treatmentPath) {
    console.error(
      "Uso: npx tsx scripts/compare-control-editions.ts --baseline <path.json> --treatment <path.json> [--out <path>] [--json]",
    );
    process.exit(2);
  }

  const baseline = loadMeasurement(resolve(ROOT, baselinePath));
  const treatment = loadMeasurement(resolve(ROOT, treatmentPath));
  const result = compareControlEditions(baseline, treatment);

  const output = flags.has("json") ? JSON.stringify(result, null, 2) : formatComparisonReport(result);

  if (values["out"]) {
    writeFileSync(resolve(ROOT, values["out"]), output, "utf8");
    console.log(`✓ comparação gravada em ${values["out"]}`);
    console.log(`  veredito: ${result.verdict ?? "indeterminado"}`);
  } else {
    console.log(output);
  }

  // Exit code não-zero quando a hipótese é invalidada COM confiabilidade
  // intacta — sinal fraco para automação (ex: CI de doc), nunca usado para
  // bloquear nada aqui (este script não é gate de nada). Contaminação NÃO
  // afeta o exit code — o aviso já está no output, forçar falha de processo
  // por cima seria redundante com o que o texto já diz.
  if (result.verdict === "hypothesis_invalidated" && !result.reliability_warning) {
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
