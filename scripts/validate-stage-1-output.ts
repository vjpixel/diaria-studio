#!/usr/bin/env npx tsx
/**
 * validate-stage-1-output.ts (#581)
 *
 * CLI que roda a bateria de assertions de Stage 1 e emite JSON pra o
 * orchestrator (ou skill /diaria-1-pesquisa) decidir se apresenta gate, mostra
 * warnings ou bloqueia.
 *
 * Uso:
 *   npx tsx scripts/validate-stage-1-output.ts \
 *     --edition 260506 \
 *     --edition-dir data/editions/260506/ \
 *     [--ai-relevance-threshold 0.7]
 *
 * Output JSON em stdout: ValidationResult de scripts/lib/stage-1-validator.ts.
 *
 * Exit codes:
 *   0 — tudo OK (apresentar gate normal)
 *   1 — warnings (apresentar gate com banner; não bloqueia)
 *   2 — blockers (não apresentar gate; mostrar erros pro editor)
 *   3 — erro de uso (args inválidos, paths não existem)
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { runStage1Validation } from "./lib/stage-1-validator.ts";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readDriveSyncFlag(): boolean {
  const cfgPath = resolve(ROOT, "platform.config.json");
  if (!existsSync(cfgPath)) return true;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { drive_sync?: boolean };
    return cfg.drive_sync !== false;
  } catch {
    return true;
  }
}

function main(): void {
  const { values, flags } = parseCliArgs(process.argv.slice(2));
  const edition = values["edition"];
  const editionDirArg = values["edition-dir"];
  const thresholdArg = values["ai-relevance-threshold"];
  const noDriveSync = flags.has("no-drive-sync");

  if (!edition || !editionDirArg) {
    console.error(
      "Uso: validate-stage-1-output.ts --edition <AAMMDD> --edition-dir <path> [--ai-relevance-threshold 0.7] [--no-drive-sync]",
    );
    process.exit(3);
  }

  const editionDir = resolve(ROOT, editionDirArg);
  if (!existsSync(editionDir)) {
    console.error(`ERRO: edition-dir não existe: ${editionDir}`);
    process.exit(3);
  }

  const threshold = thresholdArg ? Number(thresholdArg) : undefined;
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    console.error(`ERRO: ai-relevance-threshold inválido: ${thresholdArg} (esperado 0..1)`);
    process.exit(3);
  }

  // Auto-detect drive_sync flag from platform.config.json se --no-drive-sync não foi passado.
  const driveCachePath =
    noDriveSync || !readDriveSyncFlag() ? null : resolve(ROOT, "data/drive-cache.json");

  const result = runStage1Validation(edition, editionDir, {
    aiRelevanceThreshold: threshold,
    driveCachePath,
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.blocking_count > 0) process.exit(2);
  if (result.warning_count > 0) process.exit(1);
  process.exit(0);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
