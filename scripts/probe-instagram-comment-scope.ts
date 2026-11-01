/**
 * probe-instagram-comment-scope.ts (#11750)
 *
 * Grava em `{edition}/_internal/instagram-comment-scope.json` se o token que
 * vai comentar no Instagram tem `instagram_manage_comments`, para o preview
 * do Stage 4 (`render-social-html.ts`) mostrar no 4º post (USE MELHOR) a
 * mesma linha que o publish vai usar: "Link da edição no primeiro
 * comentário." com escopo, a linha da bio sem ele.
 *
 * Só leitura: `GET /instagram/comment-scope` no Worker (default — o Stage 5
 * agenda o Instagram pelo Worker, que comenta com o PRÓPRIO token) ou
 * `GET /me/permissions` com o token do `.env` (`--source local`, para quem
 * publica sem `--schedule`). Não publica nada.
 *
 * Fail-soft: sai 0 sempre. Sem Worker configurado, sem token ou sonda com
 * falha → registro `granted: false` com `reason`, e o preview cai na linha
 * da bio (o mesmo fallback do publish).
 *
 * Uso:
 *   npx tsx scripts/probe-instagram-comment-scope.ts --edition-dir data/editions/AAMMDD/ [--source worker|local]
 */
import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { resolveEditionDirArgOrExit } from "./lib/resolve-edition-dir-arg.ts";
import {
  probeInstagramCommentPermission,
  probeWorkerInstagramCommentScope,
  resolveInstagramWorkerUrl,
  writeInstagramCommentScopeRecord,
  type InstagramCommentScopeProbe,
  type InstagramCommentScopeSource,
} from "./lib/instagram-comment-scope.ts";

const ROOT = resolve(import.meta.dirname, "..");
const INSTAGRAM_API_VERSION_DEFAULT = "v25.0";

/** Roda a sonda da origem pedida. Pure quanto a I/O de disco; rede injetável. */
export async function probeCommentScope(
  source: InstagramCommentScopeSource,
  input: { platformConfig: unknown; env: Record<string, string | undefined>; fetchImpl?: typeof fetch },
): Promise<InstagramCommentScopeProbe> {
  const fetchImpl = input.fetchImpl ?? fetch;
  if (source === "worker") {
    const workerUrl = resolveInstagramWorkerUrl(input.platformConfig, input.env);
    const workerToken = input.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
    if (!workerUrl || !workerToken) {
      return { ok: false, reason: "worker: DIARIA_LINKEDIN_CRON_URL/DIARIA_LINKEDIN_CRON_TOKEN não configurados" };
    }
    return probeWorkerInstagramCommentScope(workerUrl, workerToken, fetchImpl);
  }
  const accessToken = input.env.INSTAGRAM_ACCESS_TOKEN ?? "";
  if (!accessToken) return { ok: false, reason: "INSTAGRAM_ACCESS_TOKEN ausente no .env" };
  return probeInstagramCommentPermission(accessToken, input.env.INSTAGRAM_API_VERSION || INSTAGRAM_API_VERSION_DEFAULT, fetchImpl);
}

async function main(): Promise<number> {
  const { values } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];
  if (!editionDirArg) {
    console.error("ERRO: --edition-dir é obrigatório.");
    return 2;
  }
  const source = (values["source"] ?? "worker") as InstagramCommentScopeSource;
  if (source !== "worker" && source !== "local") {
    console.error(`ERRO: --source deve ser worker ou local (recebido: ${source}).`);
    return 2;
  }
  const editionDir = resolveEditionDirArgOrExit(editionDirArg, { root: ROOT });
  let platformConfig: unknown = null;
  try {
    platformConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  } catch (e) {
    console.warn(`[probe-instagram-comment-scope] platform.config.json ilegível: ${(e as Error).message}`);
  }
  const probe = await probeCommentScope(source, { platformConfig, env: process.env });
  const record = writeInstagramCommentScopeRecord(editionDir, probe, source);
  if (!record.granted) {
    console.warn(
      `[probe-instagram-comment-scope] #11750: sem prova de instagram_manage_comments (${source}${record.reason ? `: ${record.reason}` : ""}) — o 4º post do Instagram sai com a linha da bio.`,
    );
  }
  console.log(JSON.stringify(record));
  return 0;
}

if (isMainModule(import.meta.url)) {
  void runCli(main);
}
