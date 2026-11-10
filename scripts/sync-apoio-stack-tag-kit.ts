#!/usr/bin/env node
/**
 * scripts/sync-apoio-stack-tag-kit.ts (#12538)
 *
 * Converge a membresia da TAG de audiência do e-mail do post semanal da Stack
 * (`platform.config.json` → `kit_stack.audience_tag`, `apoio-stack`) com quem
 * tem `apoio_nivel` = Núcleo (`patrono`) no Kit — mesmo runner genérico
 * (`runKitApoioTagSync`) dos outros syncs de tag de apoio
 * (`sync-apoio-voto-tema-tag-kit.ts`, `sync-apoio-especial-tag-kit.ts`). Racional
 * (por que TAG e não segmento, por que é PROJEÇÃO e não 2ª fonte de verdade):
 * `scripts/lib/shared/kit-apoio-tag.ts`.
 *
 * Ordem de execução (importa):
 *   1. npx tsx scripts/sync-apoio-nivel-kit.ts --push      (apoia.se → apoio_nivel)
 *   2. npx tsx scripts/sync-apoio-stack-tag-kit.ts --push  (apoio_nivel → tag)
 *   3. npx tsx scripts/publish-circle-stack-email-kit.ts --publish-monday AAMMDD (dry-run)
 *
 * Uso:
 *   npx tsx scripts/sync-apoio-stack-tag-kit.ts                       # dry-run
 *   npx tsx scripts/sync-apoio-stack-tag-kit.ts --push
 *   npx tsx scripts/sync-apoio-stack-tag-kit.ts --push --force-blast-radius
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { runKitApoioTagSync } from "./lib/kit-apoio-tag-sync.ts";
import {
  STACK_EMAIL_NIVEIS,
  StackEmailGuardError,
  readPlatformConfig,
  resolveStackEmailTagName,
} from "./lib/circle-stack-email-channel.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[sync-apoio-stack-tag-kit]";

const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);

export async function main(rootDir: string = ROOT): Promise<void> {
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const forceBlastRadius = hasFlag(argv, "force-blast-radius");

  const tagNameResolution = resolveStackEmailTagName(readPlatformConfig(rootDir).kit_stack);
  if (!tagNameResolution.ok) {
    log(`ERRO: ${tagNameResolution.reason}`);
    process.exit(2);
    return;
  }

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) {
    log(`ERRO: ${kitConfigResult.reason}`);
    process.exit(1);
    return;
  }

  const result = await runKitApoioTagSync({
    tagName: tagNameResolution.tagName,
    niveis: STACK_EMAIL_NIVEIS,
    push,
    forceBlastRadius,
    config: kitConfigResult.config,
    log,
  });

  if (result.blastRadiusBlocked || result.failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    const guard = e instanceof StackEmailGuardError;
    process.stderr.write(`${LOG_PREFIX} ${guard ? "ERRO" : "erro fatal"}: ${(e as Error).message}\n`);
    process.exit(guard ? 2 : 1);
  });
}
