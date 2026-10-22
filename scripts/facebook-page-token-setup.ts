#!/usr/bin/env node
/**
 * scripts/facebook-page-token-setup.ts (#10769)
 *
 * Gera e grava o token de PÁGINA (que não expira) das páginas do Facebook em
 * `publishing.social.facebook.pages` — hoje usado pra ligar o Reels diário
 * nas páginas VJ Pixel e MemeLab (`scripts/publish-shorts.ts`).
 *
 * Passo do editor (o token nunca passa pelo chat nem pelo Claude):
 *   1. Graph API Explorer (https://developers.facebook.com/tools/explorer),
 *      app da diar.ia.br, "Get User Access Token" com as permissões
 *      pages_show_list, pages_read_engagement, pages_manage_posts (as mesmas
 *      do token da página diar.ia.br, que já publica Reels — conferido via
 *      debug_token em 22/10/2026).
 *   2. No terminal: copie o token e rode
 *        npx tsx scripts/facebook-page-token-setup.ts --pages vjpixel,memelab
 *      e cole o token quando o script pedir (stdin — fica fora do histórico do shell).
 *
 * O script troca o token curto por um longo (FACEBOOK_APP_ID/SECRET), lista
 * as páginas que ele administra (`/me/accounts`), casa cada slug pelo
 * `page_id` conhecido (`KNOWN_PAGE_IDS`, ou `--page-id slug=ID`) e grava
 * `{page_id_env}` e `{token_env}` de cada página no Doppler e no `.env`
 * local, SEM imprimir valor. Token de página derivado de token de usuário
 * longo não expira.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { defaultDopplerSet, persistSecrets } from "./linkedin-personal-oauth.ts";
import { loadFacebookPagesConfig, resolveFacebookApiVersion, type FacebookPageConfig } from "./lib/facebook-pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** IDs das páginas do editor (Meta Business Suite, conferidos em 22/10/2026). Não são segredo. */
export const KNOWN_PAGE_IDS: Record<string, string> = {
  vjpixel: "937293496367847",
  memelab: "179134132104104",
};

export interface AccountPage {
  id: string;
  name: string;
  access_token?: string;
  tasks?: string[];
}

export type PageMatch =
  | { slug: string; ok: true; page: AccountPage; config: FacebookPageConfig }
  | { slug: string; ok: false; reason: string };

/** Pure: casa cada slug pedido com uma página de `/me/accounts`. */
export function matchPages(
  slugs: string[],
  configPages: FacebookPageConfig[],
  accounts: AccountPage[],
  pageIds: Record<string, string>,
): PageMatch[] {
  return slugs.map((slug) => {
    const config = configPages.find((p) => p.slug === slug);
    if (!config) return { slug, ok: false, reason: `slug "${slug}" não existe em publishing.social.facebook.pages` };
    const id = pageIds[slug];
    if (!id) return { slug, ok: false, reason: `page_id de "${slug}" desconhecido — passe --page-id ${slug}=ID` };
    const page = accounts.find((a) => a.id === id);
    if (!page) return { slug, ok: false, reason: `o usuário do token não administra a página ${id} (${slug})` };
    if (!page.access_token) return { slug, ok: false, reason: `/me/accounts não devolveu token para ${slug}` };
    if (page.tasks && !page.tasks.includes("CREATE_CONTENT")) {
      return { slug, ok: false, reason: `o usuário não tem a tarefa CREATE_CONTENT na página ${slug}` };
    }
    return { slug, ok: true, page, config };
  });
}

async function readTokenFromStdin(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const token = await new Promise<string>((res) => rl.question("Cole o User Access Token do Graph API Explorer: ", res));
  rl.close();
  return token.trim();
}

async function graph(path: string, params: Record<string, string>, apiVersion: string): Promise<any> {
  const res = await fetch(`https://graph.facebook.com/${apiVersion}/${path}?${new URLSearchParams(params)}`);
  const json = await res.json().catch(() => ({}));
  // Nunca ecoar a URL (tem token) — só o erro da API.
  if (!res.ok || json.error) throw new Error(`${path}: ${res.status} ${json.error?.message ?? "erro"}`);
  return json;
}

async function main(): Promise<number> {
  const { values } = parseArgs(process.argv.slice(2));
  const slugs = (values["pages"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!slugs.length) {
    console.error("uso: facebook-page-token-setup.ts --pages vjpixel,memelab [--page-id slug=ID,...]");
    return 2;
  }
  const pageIds = { ...KNOWN_PAGE_IDS };
  for (const pair of (values["page-id"] ?? "").split(",").filter(Boolean)) {
    const [slug, id] = pair.split("=");
    if (!slug || !/^\d+$/.test(id ?? "")) {
      console.error(`--page-id inválido: ${pair}`);
      return 2;
    }
    pageIds[slug] = id;
  }
  const appId = (process.env.FACEBOOK_APP_ID ?? "").trim();
  const appSecret = (process.env.FACEBOOK_APP_SECRET ?? "").trim();
  if (!appId || !appSecret) {
    console.error("✖ Faltam FACEBOOK_APP_ID/FACEBOOK_APP_SECRET no ambiente (Doppler → `npm run sync-env`).");
    return 1;
  }
  const config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const configPages = loadFacebookPagesConfig(config);
  const apiVersion = resolveFacebookApiVersion(process.env);

  const shortToken = await readTokenFromStdin();
  if (!shortToken) {
    console.error("✖ Token vazio. Nada foi gravado.");
    return 1;
  }
  const long = await graph(
    "oauth/access_token",
    { grant_type: "fb_exchange_token", client_id: appId, client_secret: appSecret, fb_exchange_token: shortToken },
    apiVersion,
  );
  const accounts: AccountPage[] = [];
  let next: Record<string, string> | null = { fields: "id,name,access_token,tasks", limit: "100", access_token: long.access_token };
  while (next) {
    const page = await graph("me/accounts", next, apiVersion);
    accounts.push(...(page.data ?? []));
    const after = page.paging?.cursors?.after;
    next = page.paging?.next && after ? { ...next, after } : null;
  }

  const matches = matchPages(slugs, configPages, accounts, pageIds);
  const secrets: Record<string, string> = {};
  for (const m of matches) {
    if (!m.ok) {
      console.error(`✖ ${m.slug}: ${m.reason}`);
      continue;
    }
    secrets[m.config.page_id_env] = m.page.id;
    secrets[m.config.token_env] = m.page.access_token!;
    console.log(`✔ ${m.slug}: ${m.page.name} (${m.page.id}) — token de página obtido (valor nunca impresso).`);
  }
  if (!Object.keys(secrets).length) {
    console.error("✖ Nenhuma página resolvida. Nada foi gravado.");
    return 1;
  }
  const r = persistSecrets({
    secrets,
    dopplerSet: defaultDopplerSet,
    envPath: resolve(ROOT, ".env"),
    readEnv: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    writeEnv: (p, c) => writeFileAtomic(p, c),
  });
  console.log(`✔ .env local: ${Object.keys(secrets).join(", ")}.`);
  if (r.dopplerFailed.length) {
    console.error(`✖ Doppler NÃO recebeu: ${r.dopplerFailed.join(", ")}. Doppler disse: ${r.dopplerErrors.join(" | ") || "sem stderr"}`);
    return 1;
  }
  console.log(`✔ Doppler: ${r.doppler.join(", ")}. No 300: \`npm run sync-env\`.`);
  return matches.every((m) => m.ok) ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("facebook-page-token-setup:", e instanceof Error ? e.message : e) });
}
