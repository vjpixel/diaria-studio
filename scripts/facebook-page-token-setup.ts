#!/usr/bin/env node
/**
 * scripts/facebook-page-token-setup.ts (#10769)
 *
 * Gera e grava o token de PÁGINA (que não expira) das páginas do Facebook em
 * `publishing.social.facebook.pages` — hoje usado pra ligar o Reels diário
 * na página VJ Pixel (`scripts/publish-shorts.ts`; MemeLab saiu da rotina no #10790).
 * O token da VJ Pixel também publica o Reels no Instagram pessoal do editor,
 * vinculado a essa página (`publishing.shorts.instagram_author_page`, #10790).
 *
 * Passo do editor (o token nunca passa pelo chat nem pelo Claude):
 *   1. Graph API Explorer (https://developers.facebook.com/tools/explorer),
 *      app da diar.ia.br, "Get User Access Token" com as permissões
 *      pages_show_list, pages_read_engagement, pages_manage_posts (as mesmas
 *      do token da página diar.ia.br) — e, para a vjpixel, também
 *      instagram_basic + instagram_content_publish (Instagram pessoal, #10790).
 *   2. No terminal: copie o token e rode
 *        npx tsx scripts/facebook-page-token-setup.ts --pages vjpixel
 *      e cole o token quando o script pedir (stdin, sem eco na tela e fora do
 *      histórico do shell).
 *
 * O script troca o token curto por um longo (FACEBOOK_APP_ID/SECRET), lista
 * as páginas que ele administra (`/me/accounts`), casa cada slug pelo
 * `page_id` conhecido (`KNOWN_PAGE_IDS`, ou `--page-id slug=ID`) e grava
 * `{page_id_env}` e `{token_env}` de cada página no `.env` local e no Doppler,
 * SEM imprimir valor (o `.env` é gravado antes; falha do Doppler sai com
 * exit 1 e o nome das vars que faltaram lá). Token de página derivado de token
 * de usuário longo não expira. A página `diaria` (produção) é recusada sem
 * `--force`, pra não sobrescrever o token do Stage 5 por engano.
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

/** IDs das páginas do editor (Meta Business Suite). Não são segredo. */
export const KNOWN_PAGE_IDS: Readonly<Record<string, string>> = Object.freeze({
  vjpixel: "937293496367847",
  memelab: "179134132104104",
});

/** Slug da página de produção — sobrescrever o token dela exige `--force`. */
export const PROTECTED_SLUGS = new Set(["diaria"]);

export interface AccountPage {
  id: string;
  name: string;
  access_token?: string;
  tasks?: string[];
}

export type PageMatch =
  | { slug: string; ok: true; page: AccountPage & { access_token: string }; config: FacebookPageConfig }
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
    const id = Object.prototype.hasOwnProperty.call(pageIds, slug) ? pageIds[slug] : undefined;
    if (!id) return { slug, ok: false, reason: `page_id de "${slug}" desconhecido — passe --page-id ${slug}=ID` };
    const page = accounts.find((a) => a.id === id);
    if (!page) return { slug, ok: false, reason: `o usuário do token não administra a página ${id} (${slug})` };
    if (!page.access_token) return { slug, ok: false, reason: `/me/accounts não devolveu token para ${slug}` };
    // Sem `tasks` na resposta não dá pra provar permissão de publicar: falha fechada.
    if (!page.tasks || !page.tasks.includes("CREATE_CONTENT")) {
      return { slug, ok: false, reason: `sem a tarefa CREATE_CONTENT na página ${slug} (ou /me/accounts não devolveu tasks)` };
    }
    return { slug, ok: true, page: { ...page, access_token: page.access_token }, config };
  });
}

/** Lê o token sem eco na tela. stdin fechado (sem TTY) rejeita em vez de sair calado. */
async function readTokenFromStdin(): Promise<string> {
  const prompt = "Cole o User Access Token do Graph API Explorer: ";
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  let muted = false;
  (rl as any)._writeToOutput = (s: string) => {
    if (!muted) process.stderr.write(s);
  };
  const token = await new Promise<string>((res, rej) => {
    let answered = false;
    rl.on("close", () => {
      if (!answered) rej(new Error("stdin fechado antes do token — rode num terminal interativo"));
    });
    rl.question(prompt, (a) => {
      answered = true;
      res(a);
    });
    muted = true;
  });
  rl.close();
  process.stderr.write("\n");
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
  const { values, flags } = parseArgs(process.argv.slice(2));
  const slugs = (values["pages"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!slugs.length) {
    console.error("uso: facebook-page-token-setup.ts --pages vjpixel[,outra] [--page-id slug=ID,...]");
    return 2;
  }
  const pageIds: Record<string, string> = { ...KNOWN_PAGE_IDS };
  for (const pair of (values["page-id"] ?? "").split(",").filter(Boolean)) {
    const [slug, id] = pair.split("=");
    if (!slug || !/^\d+$/.test(id ?? "")) {
      console.error(`--page-id inválido: ${pair}`);
      return 2;
    }
    pageIds[slug] = id;
  }
  const blocked = slugs.filter((s) => PROTECTED_SLUGS.has(s));
  if (blocked.length && !flags.has("force")) {
    console.error(`✖ ${blocked.join(", ")} é a página de produção (token do Stage 5). Use --force se for mesmo pra trocar.`);
    return 2;
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
  if (typeof long.access_token !== "string" || !long.access_token) {
    console.error("✖ A troca por token longo (fb_exchange_token) não devolveu access_token. Nada foi gravado.");
    return 1;
  }
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
    secrets[m.config.token_env] = m.page.access_token;
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
