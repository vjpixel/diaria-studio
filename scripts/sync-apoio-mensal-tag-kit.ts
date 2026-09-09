#!/usr/bin/env node
/**
 * scripts/sync-apoio-mensal-tag-kit.ts (#7633, dobrado sobre o runner genérico
 * em #7681)
 *
 * Converge a membresia da TAG de audiência do envio extra mensal pros
 * apoiadores (`platform.config.json` → `kit_apoiadores.audience_tag`) com quem
 * tem `apoio_nivel` Mantenedor/Patrono no Kit.
 *
 * CLI fino: toda a lógica está em `scripts/lib/kit-apoio-tag-sync.ts` (I/O
 * genérico — paginação, verificação por releitura, abort em falha sistêmica) e
 * `scripts/lib/shared/kit-apoio-tag.ts` (decisões puras — diff, blast radius,
 * seleção). Até o #7681 este arquivo carregava a implementação inteira,
 * duplicando ~150 linhas com o irmão `sync-apoio-especial-tag-kit.ts` (#7659);
 * o que sobra aqui é o que de fato distingue o canal: os níveis-alvo e a chave
 * de config.
 *
 * ## Não é um 2º sync de apoio — é uma PROJEÇÃO do que o outro já decidiu
 *
 * `sync-apoio-nivel-kit.ts` (#6049) é quem lê o apoia.se, aplica a carência de
 * 1 mês e grava o custom field `apoio_nivel` no Kit. Este script NÃO toca o
 * apoia.se nem recalcula nível nenhum: lê o campo já gravado e projeta em
 * membresia de tag.
 *
 * ## Ordem de execução (importa)
 *
 *   1. `npx tsx scripts/sync-apoio-nivel-kit.ts --push`      (apoia.se → apoio_nivel)
 *   2. `npx tsx scripts/sync-apoio-mensal-tag-kit.ts --push` (apoio_nivel → tag)
 *   3. `/diaria-mensal-apoiadores` (Passo 2 cria o broadcast pra essa tag)
 *
 * Rodar o 2º antes do 1º numa virada de mês projeta o estado velho.
 *
 * Uso:
 *   npx tsx scripts/sync-apoio-mensal-tag-kit.ts                       # dry-run
 *   npx tsx scripts/sync-apoio-mensal-tag-kit.ts --push
 *   npx tsx scripts/sync-apoio-mensal-tag-kit.ts --push --force-blast-radius
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { runKitApoioTagSync } from "./lib/kit-apoio-tag-sync.ts";
import {
  APOIADORES_MENSAL_NIVEIS,
  resolveApoiadoresTagName,
  type KitApoiadoresChannelConfig,
} from "./lib/mensal/apoiadores-kit-channel.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[sync-apoio-mensal-tag-kit]";

const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);

export async function main(rootDir: string = ROOT): Promise<void> {
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);

  const platformConfigPath = resolve(rootDir, "platform.config.json");
  const platformConfig = existsSync(platformConfigPath)
    ? (JSON.parse(readFileSync(platformConfigPath, "utf8")) as { kit_apoiadores?: KitApoiadoresChannelConfig })
    : {};
  const tagNameResolution = resolveApoiadoresTagName(platformConfig.kit_apoiadores);
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
    niveis: APOIADORES_MENSAL_NIVEIS,
    push: hasFlag(argv, "push"),
    forceBlastRadius: hasFlag(argv, "force-blast-radius"),
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
