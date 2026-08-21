#!/usr/bin/env node
/**
 * scripts/ads-test-d0.ts (#5845)
 *
 * Pré-registro do D0 do teste de 3 canais pagos (#5524) — grava
 * `data/aquisicao/teste-2608/run-state.json` **uma vez** e imprime todas as
 * datas derivadas. Cumpre sozinho o "registrar antes de acender" exigido
 * por `data/aquisicao/campanhas-260816/00-PROTOCOLO.md` §7.1.
 *
 * Lógica pura em `scripts/lib/ads-test-schedule.ts` (derivação de datas) e
 * `scripts/lib/ads-test-run-state.ts` (imutabilidade) — este arquivo é só
 * I/O: ler/gravar o arquivo, imprimir.
 *
 * ## Imutabilidade
 *
 * Rodar de novo sem `--force` quando o arquivo já existe RECUSA (exit 1) —
 * é o que torna a data de apuração pré-registrada, não escolhida depois
 * olhando o resultado (racional completo: `ads-test-run-state.ts`).
 * Regravar exige `--force --reason "motivo"`; o estado anterior é
 * preservado por append em `run-state-history.jsonl` antes do overwrite,
 * nunca perdido silenciosamente.
 *
 * Uso:
 *   npx tsx scripts/ads-test-d0.ts --d0 2026-08-26
 *   npx tsx scripts/ads-test-d0.ts --d0 2026-08-27 --force --reason "D0 real adiado 1 dia por aprovação de conta"
 *
 * Exit codes: 0 sucesso; 1 arquivo já existe sem `--force` (ou `--force`
 * sem `--reason`), ou `--d0` ausente/malformado.
 */
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { buildAdsTestRunState, planRunStateWrite, assertValidRunState, type AdsTestRunState } from "./lib/ads-test-run-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_RUN_STATE_PATH = resolve(ROOT, "data/aquisicao/teste-2608/run-state.json");
export const DEFAULT_HISTORY_PATH = resolve(ROOT, "data/aquisicao/teste-2608/run-state-history.jsonl");
const LOG_PREFIX = "[ads-test-d0]";

function loadExisting(path: string): AdsTestRunState | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assertValidRunState(raw);
  return raw;
}

export function main(
  argv: string[] = process.argv.slice(2),
  runStatePath: string = DEFAULT_RUN_STATE_PATH,
  historyPath: string = DEFAULT_HISTORY_PATH,
  now: () => Date = () => new Date(),
): void {
  const d0 = getStringArg(argv, "d0", { example: "2026-08-26" });
  if (!d0) {
    console.error(`${LOG_PREFIX} --d0 AAAA-MM-DD é obrigatório.`);
    process.exitCode = 1;
    return;
  }

  const force = hasFlag(argv, "force");
  const reason = getStringArg(argv, "reason", { example: "motivo da regravação" }) ?? null;
  const nowIso = now().toISOString();

  let next: AdsTestRunState;
  try {
    next = buildAdsTestRunState(d0, nowIso);
  } catch (e) {
    console.error(`${LOG_PREFIX} ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  let existing: AdsTestRunState | null;
  try {
    existing = loadExisting(runStatePath);
  } catch (e) {
    console.error(`${LOG_PREFIX} run-state.json existente está corrompido/ilegível: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const plan = planRunStateWrite(existing, next, { force, reason, nowIso });

  if (plan.action === "refuse-exists-no-force") {
    console.error(
      `${LOG_PREFIX} ${runStatePath} já existe (D0 registrado: ${plan.existing.d0}). O arquivo é imutável — ` +
        `regravar exige --force --reason "motivo". Datas já registradas:`,
    );
    printSchedule(plan.existing);
    process.exitCode = 1;
    return;
  }
  if (plan.action === "refuse-force-without-reason") {
    console.error(`${LOG_PREFIX} --force sem --reason — regravar exige um motivo registrado (auditabilidade da §7.1).`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(runStatePath), { recursive: true });
  if (plan.action === "write-with-history") {
    appendFileSync(historyPath, JSON.stringify(plan.historyEntry) + "\n", "utf8");
    console.log(`${LOG_PREFIX} estado anterior preservado em ${historyPath} (motivo: "${plan.historyEntry.reason}").`);
  }
  writeFileAtomic(runStatePath, JSON.stringify(plan.state, null, 2) + "\n");
  console.log(`${LOG_PREFIX} run-state.json gravado em ${runStatePath}.`);
  printSchedule(plan.state);
}

function printSchedule(state: AdsTestRunState): void {
  console.log(`  D0 (1º dia de veiculação):        ${state.d0}`);
  console.log(`  Fim da janela (D+14):              ${state.fim_janela}`);
  console.log(`  Religar Diaria-Brevo-Diaria (D+21): ${state.religar_brevo}`);
  console.log(`  Coorte madura (D+41):               ${state.coorte_madura}`);
  console.log(`  Apuração congelada (1º dom ≥ D+42): ${state.apuracao_snapshot}`);
  console.log(`  Braços: ${state.bracos.join(", ")}`);
}

if (isMainModule(import.meta.url)) {
  main();
}
