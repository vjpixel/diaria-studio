/**
 * scripts/set-latest-video-redirect.ts (#12735)
 *
 * Aponta `diar.ia.br/video` (o link fixo da bio no TikTok, Instagram e
 * Threads) para o horizontal da edição: lê `_internal/05-video-url.txt` e
 * grava o registro `video:latest-horizontal` no KV `POLL`, que o Worker do
 * apex (`workers/site`) lê a cada clique. Contrato do registro e do redirect:
 * `scripts/lib/shared/latest-video-redirect.ts`.
 *
 * Uso:
 *   npx tsx scripts/set-latest-video-redirect.ts AAMMDD            # plano (dry-run), não grava
 *   npx tsx scripts/set-latest-video-redirect.ts AAMMDD --apply    # grava no KV
 *
 * O `--publish` do `publish-shorts.ts` chama `updateLatestVideoRedirect`
 * sozinho (fail-soft), então no fluxo do `/diaria-publica` este script só
 * serve para conferir ou regravar à mão.
 *
 * A gravação só avança: edição anterior à que está no KV não sobrescreve
 * (`shouldReplaceLatestVideo`). Credenciais: `CLOUDFLARE_ACCOUNT_ID` +
 * `CLOUDFLARE_WORKERS_TOKEN` (as mesmas do upload de imagens no KV `POLL`).
 *
 * Exit: 0 gravado/sem mudança/plano; 1 falha (credencial, KV, link ausente
 * no `--apply`); 2 uso inválido.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { createKvRestOps } from "./lib/cloudflare-kv-rest.ts";
import { D1_VIDEO_URL_FILE, parseD1VideoUrlFile } from "./lib/diaria/d1-video-link.ts";
import {
  LATEST_VIDEO_KV_KEY,
  parseLatestVideoRecord,
  shouldReplaceLatestVideo,
  type LatestVideoRecord,
} from "./lib/shared/latest-video-redirect.ts";

/** Namespace `POLL` (`workers/site/wrangler.toml` e `workers/poll/wrangler.toml`). */
export const POLL_KV_NAMESPACE_ID = "72784da4ae39444481eb422ebac357c6";

/** O que o KV precisa oferecer (subconjunto de `KvOps`). */
export interface LatestVideoKv {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
}

export type LatestVideoUpdateOutcome =
  | { status: "no_link"; detail: string }
  | { status: "unchanged"; record: LatestVideoRecord }
  | { status: "older"; record: LatestVideoRecord; current: LatestVideoRecord }
  | { status: "would_write"; record: LatestVideoRecord; current: LatestVideoRecord | null }
  | { status: "written"; record: LatestVideoRecord; current: LatestVideoRecord | null };

/** Lê o link do horizontal da edição (`null` = arquivo ausente ou vazio). Lança se o conteúdo não for vídeo do YouTube. */
export function readEditionHorizontalUrl(editionDir: string): string | null {
  const path = join(editionDir, D1_VIDEO_URL_FILE);
  if (!existsSync(path)) return null;
  return parseD1VideoUrlFile(readFileSync(path, "utf8"));
}

/**
 * Grava (ou, com `apply: false`, só planeja) o registro do horizontal da
 * edição. `kv` só é lido/escrito quando há link. Lança em falha de KV: quem
 * chama decide se é fatal (este CLI) ou aviso (`publish-shorts.ts`).
 */
export async function updateLatestVideoRedirect(input: {
  editionDir: string;
  aammdd: string;
  kv: LatestVideoKv;
  apply: boolean;
  now: Date;
}): Promise<LatestVideoUpdateOutcome> {
  const url = readEditionHorizontalUrl(input.editionDir);
  if (!url) return { status: "no_link", detail: `${D1_VIDEO_URL_FILE} ausente ou vazio — o horizontal da edição ${input.aammdd} ainda não tem link` };
  const record: LatestVideoRecord = { url, aammdd: input.aammdd, updated_at: input.now.toISOString() };
  const current = parseLatestVideoRecord(await input.kv.get(LATEST_VIDEO_KV_KEY));
  if (current && current.aammdd === record.aammdd && current.url === record.url) return { status: "unchanged", record: current };
  if (!shouldReplaceLatestVideo(current, record)) return { status: "older", record, current: current! };
  if (!input.apply) return { status: "would_write", record, current };
  await input.kv.put(LATEST_VIDEO_KV_KEY, JSON.stringify(record));
  return { status: "written", record, current };
}

/** KV `POLL` pela API REST, com as credenciais do ambiente; `null` + motivo se faltar alguma. */
export function pollKvFromEnv(env: NodeJS.ProcessEnv = process.env): { kv: LatestVideoKv; reason?: undefined } | { kv: null; reason: string } {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_WORKERS_TOKEN;
  const missing = [!accountId && "CLOUDFLARE_ACCOUNT_ID", !token && "CLOUDFLARE_WORKERS_TOKEN"].filter(Boolean);
  if (missing.length) return { kv: null, reason: `faltam ${missing.join(", ")} no ambiente` };
  return { kv: createKvRestOps({ accountId: accountId!, token: token!, namespaceId: POLL_KV_NAMESPACE_ID }) };
}

/** Linha de log de um resultado (usada aqui e no `publish-shorts.ts`). */
export function describeLatestVideoOutcome(o: LatestVideoUpdateOutcome): string {
  switch (o.status) {
    case "no_link":
      return `diar.ia.br/video sem mudança: ${o.detail}`;
    case "unchanged":
      return `diar.ia.br/video já aponta para ${o.record.url} (edição ${o.record.aammdd})`;
    case "older":
      return `diar.ia.br/video mantido em ${o.current.url} (edição ${o.current.aammdd}, mais nova que ${o.record.aammdd})`;
    case "would_write":
      return `diar.ia.br/video passaria a ${o.record.url} (edição ${o.record.aammdd}; hoje ${o.current ? `${o.current.url}, ${o.current.aammdd}` : "sem registro"}) — rode com --apply`;
    case "written":
      return `diar.ia.br/video agora aponta para ${o.record.url} (edição ${o.record.aammdd})`;
  }
}

async function main(): Promise<number> {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const aammdd = positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error("uso: set-latest-video-redirect.ts AAMMDD [--apply]");
    return 2;
  }
  loadProjectEnv();
  const env = pollKvFromEnv();
  if (!env.kv) {
    console.error(`set-latest-video-redirect: ${env.reason}`);
    return 1;
  }
  const apply = flags.has("apply");
  const outcome = await updateLatestVideoRedirect({ editionDir: editionDirFor(aammdd), aammdd, kv: env.kv, apply, now: new Date() });
  console.error(describeLatestVideoOutcome(outcome));
  console.log(JSON.stringify({ dry_run: !apply, ...outcome }, null, 2));
  return outcome.status === "no_link" && apply ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("set-latest-video-redirect:", e instanceof Error ? e.message : e) });
}
