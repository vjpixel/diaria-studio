/**
 * scripts/short-related-kv-publish.ts (#12541 item 2)
 *
 * Publica no KV da Cloudflare o registro do vínculo do vídeo relacionado do
 * Short da edição, para o alarme `Diaria-Short-Related-Missed-Alarm` (#11353)
 * no `300` ler sem depender da replicação do OneDrive. Chamado pela task LOCAL
 * `diaria-short-video-relacionado` (Neo) no fim, depois do `--record` ou do
 * `--alert` de `youtube-short-related-plan.ts`
 * (`.claude/skills/diaria-publica-video/short-related-task.md`, Passo 6).
 *
 * Fonte do valor: o próprio `_internal/06-short-related.json` da edição, que
 * o plano acabou de gravar (o arquivo continua sendo gravado, para quem lê a
 * pasta). Um formato só nos dois canais; lógica em
 * `scripts/lib/diaria/short-related-kv.ts`.
 *
 * Uso:
 *   npx tsx scripts/short-related-kv-publish.ts --edition 261111
 *   npx tsx scripts/short-related-kv-publish.ts               # edição de hoje (BRT)
 *
 * Exit: 0 = publicado e relido, ou nada a publicar (edição sem registro local:
 * a task pulou a edição); 1 = falha (registro ilegível, credencial ausente,
 * PUT ou releitura falhou); 2 = uso inválido.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as dotenvParse } from "dotenv";
import { findUnknownFlags, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { createKvRestOps } from "./lib/cloudflare-kv-rest.ts";
import { editionDir as editionDirFor, editionsRoot } from "./lib/edition-paths.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { SHORT_RELATED_FILE, brtTodayAammdd, parseShortRelatedRecord } from "./lib/diaria/youtube-short-related.ts";
import { publishShortRelatedKv, resolveOpsStateKvConfig } from "./lib/diaria/short-related-kv.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[short-related-kv-publish]";

/**
 * Variáveis do `.env` do repo vencem o ambiente: no Neo o app desktop injeta
 * o próprio ambiente na task (#8237, mesmo motivo do plano).
 */
function projectEnv(): Record<string, string | undefined> {
  let file: Record<string, string> = {};
  try {
    file = dotenvParse(readFileSync(join(ROOT, ".env"), "utf8"));
  } catch {
    /* sem .env: só o ambiente */
  }
  return { ...process.env, ...file };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const unknown = findUnknownFlags(argv, ["edition"]);
  if (unknown.length) {
    console.error(`${LOG_PREFIX} flag desconhecida: ${unknown.join(", ")} — uso: --edition AAMMDD`);
    return 2;
  }
  const aammdd = getStringArg(argv, "edition", { example: "261111" }) ?? brtTodayAammdd(new Date());
  if (!/^\d{6}$/.test(aammdd)) {
    console.error(`${LOG_PREFIX} --edition inválido: ${JSON.stringify(aammdd)} (esperado AAMMDD)`);
    return 2;
  }

  loadProjectEnv(ROOT);
  const editionsDir = resolve(ROOT, editionsRoot());
  if (!existsSync(editionsDir)) {
    console.error(`${LOG_PREFIX} ${editionsDir} não existe (data/ não montada?) — não dá para ler o registro`);
    return 1;
  }
  const path = join(resolve(ROOT, editionDirFor(aammdd)), SHORT_RELATED_FILE);
  if (!existsSync(path)) {
    console.log(`${LOG_PREFIX} ${aammdd}: sem ${SHORT_RELATED_FILE} — a task não registrou nada nesta edição; nada publicado.`);
    return 0;
  }
  const rec = parseShortRelatedRecord(readFileSync(path, "utf8"), aammdd, path);

  const cfgJson = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const cfg = resolveOpsStateKvConfig(cfgJson, projectEnv());
  if (!cfg.ok) {
    console.error(`${LOG_PREFIX} configuração do KV ausente: ${cfg.missing.join(", ")}`);
    return 1;
  }
  const key = await publishShortRelatedKv(createKvRestOps(cfg.config), rec);
  console.log(`${LOG_PREFIX} ${aammdd}: "${rec.status}" publicado e relido em ${key}${rec.alertedAt ? ` (alertedAt ${rec.alertedAt})` : ""}.`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error(`${LOG_PREFIX}`, e instanceof Error ? e.message : e) });
}
