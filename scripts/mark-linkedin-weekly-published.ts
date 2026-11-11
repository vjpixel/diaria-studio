#!/usr/bin/env tsx
/**
 * scripts/mark-linkedin-weekly-published.ts (#12745)
 *
 * Registra que o ciclo `{cycle}` da newsletter semanal do LinkedIn foi
 * publicado À MÃO, fora do `/diaria-linkedin-semanal`. Grava (ou completa)
 * `data/weekly/{cycle}/ln-{cycle}.json` com `published_manually: true`, a
 * URL do artigo e o instante do registro, para o
 * `linkedin-weekly-staleness-alarm.ts` (que só checa a existência desse
 * arquivo) parar de alarmar o ciclo. A issue de alarme aberta fecha sozinha
 * depois de 2 execuções limpas, como em qualquer ciclo produzido pela skill.
 *
 * Não publica nada nem chama o LinkedIn: a API não lista artigos de
 * newsletter (ver `scripts/lib/linkedin-weekly-manual-publish.ts`), então o
 * registro é a palavra do editor, com a URL como prova.
 *
 * Uso:
 *   npx tsx scripts/mark-linkedin-weekly-published.ts --cycle 26w45 --url https://www.linkedin.com/pulse/...
 *   npx tsx scripts/mark-linkedin-weekly-published.ts --cycle 26w45 --url ... --dry-run   # mostra, não grava
 *   npx tsx scripts/mark-linkedin-weekly-published.ts --cycle 26w45 --url ... --force     # troca URL já registrada
 *
 * Saída: 0 gravado ou já registrado com a mesma URL; 1 argumento inválido
 * ou conflito com o arquivo existente.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCliAction, type CliSpec, getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { isValidWeeklyCycle, weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import { planManualPublicationRecord, validateLinkedinPublishedUrl } from "./lib/linkedin-weekly-manual-publish.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[mark-linkedin-weekly-published]";

export const CLI_SPEC: CliSpec = {
  script: "scripts/mark-linkedin-weekly-published.ts",
  booleans: ["dry-run", "force"],
  values: ["cycle", "url"],
  usage:
    "Uso: npx tsx scripts/mark-linkedin-weekly-published.ts --cycle {YY}w{WW} --url https://www.linkedin.com/... [--dry-run] [--force] [--help | -h]",
};

export interface MainDeps {
  rootDir?: string;
  now?: Date;
  log?: (s: string) => void;
  err?: (s: string) => void;
}

/** Retorna o exit code (testável sem `process.exit`). */
export function main(argv: readonly string[], deps: MainDeps = {}): number {
  const log = deps.log ?? ((s: string) => console.log(s));
  const err = deps.err ?? ((s: string) => console.error(s));
  const cliExit = applyCliAction(argv, CLI_SPEC, { out: log, err });
  if (cliExit !== null) return cliExit;

  const args = [...argv];
  const cycle = getArg(args, "cycle").trim().toLowerCase();
  if (!isValidWeeklyCycle(cycle)) {
    err(`${LOG_PREFIX} --cycle inválido ou ausente (esperado {YY}w{WW}, ex. 26w45)`);
    return 1;
  }
  const urlCheck = validateLinkedinPublishedUrl(getArg(args, "url"));
  if (!urlCheck.ok) {
    err(`${LOG_PREFIX} --url: ${urlCheck.reason}`);
    return 1;
  }

  const rootDir = deps.rootDir ?? ROOT;
  const outDir = join(rootDir, weeklyLinkedinRelDir(cycle));
  const jsonPath = join(outDir, `ln-${cycle}.json`);
  const existingRaw = existsSync(jsonPath) ? readFileSync(jsonPath, "utf8") : null;
  const plan = planManualPublicationRecord(existingRaw, {
    cycle,
    url: urlCheck.url,
    now: deps.now ?? new Date(),
    force: hasFlag(args, "force"),
  });

  if (plan.action === "conflict") {
    err(`${LOG_PREFIX} ${plan.reason}`);
    return 1;
  }
  if (plan.action === "noop") {
    log(`${LOG_PREFIX} ciclo ${cycle} já registrado como publicado em ${urlCheck.url} — nada a fazer.`);
    return 0;
  }
  const body = JSON.stringify(plan.record, null, 2);
  if (hasFlag(args, "dry-run")) {
    log(`${LOG_PREFIX} --dry-run: ${plan.action} ${jsonPath} (não gravado):\n${body}`);
    return 0;
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(jsonPath, body + "\n", "utf8");
  log(`${LOG_PREFIX} ${plan.action === "create" ? "criado" : "completado"}: ${jsonPath} (published_manually, ${urlCheck.url})`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
