#!/usr/bin/env node
/**
 * scripts/sync-apoio-especial-tag-kit.ts (#7659)
 *
 * Converge a membresia da TAG de audiência do e-mail do Artigo Especial
 * (`platform.config.json` → `kit_artigo_especial.audience_tag`) com quem tem
 * `apoio_nivel` a partir de Apoiador (R$10+) no Kit.
 *
 * CLI fino: toda a lógica está em `scripts/lib/kit-apoio-tag-sync.ts`
 * (I/O genérico) e `scripts/lib/shared/kit-apoio-tag.ts` (decisões puras) —
 * este arquivo só resolve config, credencial e flags.
 *
 * ## Uma tag SEPARADA da `apoio-mensal`, de propósito
 *
 * A tag do envio mensal (`kit_apoiadores.audience_tag`, #7633) cobre
 * Mantenedor/Patrono (R$25+); esta cobre R$10+. Os conjuntos são diferentes e
 * mudam por motivos diferentes — colapsar os dois numa tag só faria a
 * Retrospectiva do Mês (R$25) sair pra quem paga R$10, que foi exatamente o
 * vazamento que a #7658 corrigiu do lado da web.
 *
 * ## Ordem de execução (importa)
 *
 *   1. `npx tsx scripts/sync-apoio-nivel-kit.ts --push`        (apoia.se → apoio_nivel)
 *   2. `npx tsx scripts/sync-apoio-especial-tag-kit.ts --push` (apoio_nivel → tag)
 *   3. `/diaria-artigo-especial` (canal `email` cria o broadcast pra essa tag)
 *
 * Uso:
 *   npx tsx scripts/sync-apoio-especial-tag-kit.ts                       # dry-run
 *   npx tsx scripts/sync-apoio-especial-tag-kit.ts --push
 *   npx tsx scripts/sync-apoio-especial-tag-kit.ts --push --force-blast-radius
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { runKitApoioTagSync } from "./lib/kit-apoio-tag-sync.ts";
import {
  ARTIGO_ESPECIAL_EMAIL_NIVEIS,
  resolveArtigoEspecialTagName,
  type KitArtigoEspecialChannelConfig,
} from "./lib/artigo-especial-kit-channel.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[sync-apoio-especial-tag-kit]";

const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);

export async function main(rootDir: string = ROOT): Promise<void> {
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const push = hasFlag(argv, "push");
  const forceBlastRadius = hasFlag(argv, "force-blast-radius");

  const platformConfigPath = resolve(rootDir, "platform.config.json");
  const platformConfig = existsSync(platformConfigPath)
    ? (JSON.parse(readFileSync(platformConfigPath, "utf8")) as { kit_artigo_especial?: KitArtigoEspecialChannelConfig })
    : {};
  const tagNameResolution = resolveArtigoEspecialTagName(platformConfig.kit_artigo_especial);
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
    niveis: ARTIGO_ESPECIAL_EMAIL_NIVEIS,
    push,
    forceBlastRadius,
    config: kitConfigResult.config,
    log,
  });

  if (result.blastRadiusBlocked || result.failed > 0) process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG_PREFIX} erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
