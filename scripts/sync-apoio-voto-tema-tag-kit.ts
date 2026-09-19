#!/usr/bin/env node
/**
 * scripts/sync-apoio-voto-tema-tag-kit.ts (#8371)
 *
 * Converge a membresia da TAG de audiência da votação de tema
 * (`platform.config.json` → `kit_votacao.audience_tag`, `apoio-voto-tema`)
 * com quem tem `apoio_nivel` em Mantenedor/Patrono (R$25+) no Kit — mesmo
 * runner genérico (`runKitApoioTagSync`) que `sync-apoio-especial-tag-kit.ts`
 * e `sync-apoio-mensal-tag-kit.ts` já usam, mudando só o nome da tag e os
 * níveis-alvo (ver `scripts/lib/shared/kit-apoio-tag.ts` pro racional
 * completo — por que TAG e não segmento, por que isto é PROJEÇÃO e não uma
 * 2ª fonte de verdade).
 *
 * TAG SEPARADA de `kit_apoiadores.audience_tag` (`apoio-retrospectiva`) de
 * propósito, mesmo eleitorado nominal hoje — ver nota em
 * `platform.config.json` → `kit_votacao.audience_tag_note`.
 *
 * Ordem de execução (importa):
 *   1. npx tsx scripts/sync-apoio-nivel-kit.ts --push        (apoia.se → apoio_nivel)
 *   2. npx tsx scripts/sync-apoio-voto-tema-tag-kit.ts --push (apoio_nivel → tag)
 *   3. npx tsx scripts/voto-tema-open.ts --ciclo AAMM --dry-run
 *
 * Uso:
 *   npx tsx scripts/sync-apoio-voto-tema-tag-kit.ts                       # dry-run
 *   npx tsx scripts/sync-apoio-voto-tema-tag-kit.ts --push
 *   npx tsx scripts/sync-apoio-voto-tema-tag-kit.ts --push --force-blast-radius
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { runKitApoioTagSync } from "./lib/kit-apoio-tag-sync.ts";
import {
  VOTO_TEMA_NIVEIS,
  VotoTemaGuardError,
  readPlatformConfig,
  resolveVotoTemaTagName,
} from "./lib/voto-tema-channel.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[sync-apoio-voto-tema-tag-kit]";

const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);

export async function main(rootDir: string = ROOT): Promise<void> {
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const forceBlastRadius = hasFlag(argv, "force-blast-radius");

  const platformConfig = readPlatformConfig(rootDir);
  const tagNameResolution = resolveVotoTemaTagName(platformConfig.kit_votacao);
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
    niveis: VOTO_TEMA_NIVEIS,
    push,
    forceBlastRadius,
    config: kitConfigResult.config,
    log,
  });

  if (result.blastRadiusBlocked || result.failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    const guard = e instanceof VotoTemaGuardError;
    process.stderr.write(`${LOG_PREFIX} ${guard ? "ERRO" : "erro fatal"}: ${(e as Error).message}\n`);
    process.exit(guard ? 2 : 1);
  });
}
