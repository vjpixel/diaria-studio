#!/usr/bin/env node
/**
 * scripts/sync-apoio-claude-semanal-tag-kit.ts (#14329)
 *
 * Converge a membresia da TAG de audiência do e-mail semanal "Claude na
 * semana" (`platform.config.json` → `kit_claude_semanal.audience_tag`) com
 * quem tem `apoio_nivel` nos níveis de `kit_claude_semanal.audience_niveis`
 * (fase de teste: só Núcleo, `patrono`). Mesmo runner genérico
 * (`runKitApoioTagSync`) dos outros syncs de tag de apoio; racional (por que
 * TAG e não segmento, por que é PROJEÇÃO) em `scripts/lib/shared/kit-apoio-tag.ts`.
 *
 * Diferente dos irmãos, os níveis vêm do CONFIG e não de uma constante: o
 * público definitivo deste e-mail ainda não foi decidido (#14329), e trocá-lo
 * tem de ser mudança de config.
 *
 * Ordem de execução (importa):
 *   1. npx tsx scripts/sync-apoio-nivel-kit.ts --push                (apoia.se → apoio_nivel)
 *   2. npx tsx scripts/sync-apoio-claude-semanal-tag-kit.ts --push   (apoio_nivel → tag)
 *   3. npx tsx scripts/publish-claude-semanal-kit.ts --week AAMMDD   (dry-run)
 *
 * Uso:
 *   npx tsx scripts/sync-apoio-claude-semanal-tag-kit.ts                       # dry-run
 *   npx tsx scripts/sync-apoio-claude-semanal-tag-kit.ts --push
 *   npx tsx scripts/sync-apoio-claude-semanal-tag-kit.ts --push --force-blast-radius
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { runKitApoioTagSync } from "./lib/kit-apoio-tag-sync.ts";
import { ClaudeSemanalGuardError } from "./lib/claude-semanal.ts";
import { loadClaudeSemanalConfig } from "./lib/claude-semanal-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[sync-apoio-claude-semanal-tag-kit]";

const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);

export async function main(rootDir: string = ROOT): Promise<void> {
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const { config } = loadClaudeSemanalConfig(rootDir);

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) {
    log(`ERRO: ${kitConfigResult.reason}`);
    process.exit(1);
    return;
  }

  log(`tag "${config.audienceTag}" ← apoio_nivel ${config.audienceNiveis.join("/")}`);
  const result = await runKitApoioTagSync({
    tagName: config.audienceTag,
    niveis: config.audienceNiveis,
    push: hasFlag(argv, "push"),
    forceBlastRadius: hasFlag(argv, "force-blast-radius"),
    config: kitConfigResult.config,
    log,
  });

  if (result.blastRadiusBlocked || result.failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    const guard = e instanceof ClaudeSemanalGuardError;
    process.stderr.write(`${LOG_PREFIX} ${guard ? "ERRO" : "erro fatal"}: ${(e as Error).message}\n`);
    process.exit(guard ? 2 : 1);
  });
}
