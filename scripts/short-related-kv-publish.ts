/**
 * scripts/short-related-kv-publish.ts (#12541 item 2)
 *
 * Publica no KV da Cloudflare o registro do vínculo do vídeo relacionado do
 * Short da edição, para o alarme `Diaria-Short-Related-Missed-Alarm` (#11353)
 * no `300` ler sem depender da replicação do arquivo em `data/`. Chamado pela task LOCAL
 * `diaria-short-video-relacionado` (Neo) no fim, depois do `--record` ou do
 * `--alert` de `youtube-short-related-plan.ts`
 * (`.claude/skills/diaria-publica-video/short-related-task.md`, Passo 6).
 *
 * Fonte do valor: o próprio `_internal/06-short-related.json` da edição, que
 * o plano acabou de gravar (o arquivo continua sendo gravado, para quem lê a
 * pasta). Um formato só nos dois canais; lógica em
 * `scripts/lib/diaria/short-related-kv.ts`.
 *
 * Uso (o `--edition` é obrigatório: a task sabe a edição do Passo 1, e um
 * default de data publicaria a edição errada perto da meia-noite):
 *   npx tsx scripts/short-related-kv-publish.ts --edition 261111
 *
 * Exit: 0 = publicado e relido; 1 = falha (`data/` não montada, sem
 * `_internal/06-short-related.json` na edição, registro ilegível, credencial
 * ausente, PUT ou releitura falhou); 2 = uso inválido (sem `--edition`, valor
 * inválido, flag desconhecida). O roteiro só chama este script depois de o
 * Passo 4 ou 5 gravar o registro, então arquivo ausente é falha, nunca "nada
 * a publicar".
 *
 * Ambiente: `loadProjectEnv` (o ambiente vence o `.env`, regra única do
 * projeto; divergência sai como aviso em stderr).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findUnknownFlags, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { createKvRestOps } from "./lib/cloudflare-kv-rest.ts";
import { editionDir as editionDirFor, editionsRoot } from "./lib/edition-paths.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { SHORT_RELATED_FILE, parseShortRelatedRecord } from "./lib/diaria/youtube-short-related.ts";
import { publishShortRelatedKv, resolveOpsStateKvConfig } from "./lib/diaria/short-related-kv.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[short-related-kv-publish]";

/** Pure: `--edition` obrigatório e no formato AAMMDD; erro = mensagem de uso (exit 2). */
export function resolvePublishEdition(argv: string[]): { ok: true; aammdd: string } | { ok: false; error: string } {
  const unknown = findUnknownFlags(argv, ["edition"]);
  if (unknown.length) return { ok: false, error: `flag desconhecida: ${unknown.join(", ")} — uso: --edition AAMMDD` };
  let aammdd: string | undefined;
  try {
    aammdd = getStringArg(argv, "edition", { example: "261111" });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (aammdd === undefined) return { ok: false, error: "--edition AAMMDD é obrigatório (o mesmo do Passo 1 do roteiro)" };
  if (!/^\d{6}$/.test(aammdd)) return { ok: false, error: `--edition inválido: ${JSON.stringify(aammdd)} (esperado AAMMDD)` };
  return { ok: true, aammdd };
}

async function main(): Promise<number> {
  const parsed = resolvePublishEdition(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`${LOG_PREFIX} ${parsed.error}`);
    return 2;
  }
  const { aammdd } = parsed;

  loadProjectEnv(ROOT);
  const editionsDir = resolve(ROOT, editionsRoot());
  if (!existsSync(editionsDir)) {
    console.error(`${LOG_PREFIX} ${editionsDir} não existe (data/ não montada?) — não dá para ler o registro`);
    return 1;
  }
  const path = join(resolve(ROOT, editionDirFor(aammdd)), SHORT_RELATED_FILE);
  if (!existsSync(path)) {
    console.error(`${LOG_PREFIX} ${aammdd}: sem ${SHORT_RELATED_FILE} em ${path} — o Passo 4 ou 5 deveria tê-lo gravado; nada publicado.`);
    return 1;
  }
  const rec = parseShortRelatedRecord(readFileSync(path, "utf8"), aammdd, path);

  const cfgJson = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const cfg = resolveOpsStateKvConfig(cfgJson, process.env);
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
