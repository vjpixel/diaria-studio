#!/usr/bin/env node
/**
 * scripts/bing-add-site.ts (#5621)
 *
 * Cadastra um host novo como propriedade no Bing Webmaster Tools (BWT) —
 * `AddSite` + confirmação via `GetUserSites` (nunca tratar o `202` de
 * `AddSite` como confirmação, ver armadilha 3 de `docs/seo-notes.md` §Fato 3)
 * + `SubmitFeed` do sitemap quando o host já estiver verificado.
 *
 * **Não automatiza a verificação por DNS.** O #5621 pede "mesmo caminho
 * usado em 11/08 para os outros dois hosts" — mas esse caminho (CNAME criado
 * via API da Cloudflare) foi executado ad-hoc numa sessão anterior, sem
 * script commitado, e o valor exato do registro CNAME que o Bing pede é
 * obtido pela UI/fluxo de verificação do BWT (não confirmado como endpoint
 * de API estável nesta sessão — nenhuma tentativa ao vivo foi feita aqui,
 * ver PR). Este script cadastra o site (`AddSite`) e reporta o estado de
 * verificação (`GetUserSites`); se o site não estiver verificado, imprime a
 * instrução de completar a verificação por DNS manualmente (mesmo passo que
 * o editor já fez pros outros 2 hosts) antes de rodar `--submit-feed`.
 *
 * Uso:
 *   npx tsx scripts/bing-add-site.ts --host https://livros.diar.ia.br
 *   npx tsx scripts/bing-add-site.ts --host https://livros.diar.ia.br --submit-feed https://livros.diar.ia.br/sitemap.xml
 *   npx tsx scripts/bing-add-site.ts --list   # só GetUserSites, sem AddSite
 *
 * **Armadilha #5621/docs/seo-notes.md §Fato 3, item 3:** `AddSite` com barra
 * final no host devolve `202` mas o site NÃO aparece em `GetUserSites`; sem
 * barra devolve `200` e aparece. Este script normaliza `--host` removendo a
 * barra final antes de chamar `AddSite`.
 *
 * Env: BING_WEBMASTER_API_KEY (`.env`, ver `.env.example`).
 *
 * Exit: 0 ok; 1 erro de API/credencial ausente; 2 uso.
 */
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { BING_API_BASE } from "./lib/bing.ts";

loadProjectEnv();

const LOG_PREFIX = "[bing-add-site]";

/** Remove barra final — armadilha documentada: `AddSite` com barra devolve
 * `202` sem cadastrar de fato (ver docstring do arquivo). Pura. */
export function normalizeHostForAddSite(host: string): string {
  return host.replace(/\/+$/, "");
}

function buildUrl(endpoint: string, params: Record<string, string>, apiKey: string): string {
  const search = new URLSearchParams({ ...params, apikey: apiKey });
  return `${BING_API_BASE}${endpoint}?${search.toString()}`;
}

export interface BingSiteRow {
  url: string;
  /** `null` quando o shape da resposta não trouxer sinal de verificação
   * reconhecível — nunca inventa `true`/`false` sem o campo presente. */
  verified: boolean | null;
}

function strOr(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function extractRows(json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json;
  const wrapped = (json as { d?: unknown })?.d;
  if (Array.isArray(wrapped)) return wrapped;
  return null;
}

/** Parseia `GetUserSites` — `{d: [{Url, IsVerified}, ...]}` (mesma convenção
 * `.svc/json` do resto do BWT, ver `bing-pull.ts`). Tolerante a shape
 * inesperado; nunca lança. */
export function parseBingUserSitesResponse(json: unknown): BingSiteRow[] {
  const rows = extractRows(json);
  if (!rows) return [];
  return rows.map((r) => {
    const row = (r ?? {}) as Record<string, unknown>;
    const url = strOr(row.Url ?? row.url);
    const rawVerified = row.IsVerified ?? row.isVerified;
    const verified = typeof rawVerified === "boolean" ? rawVerified : null;
    return { url, verified };
  });
}

/** `true` se `hostNoSlash` (sem barra final) aparece em `sites` — comparação
 * tolerante a barra final do lado dos dados retornados pela API. Pura —
 * é o jeito CORRETO de confirmar `AddSite` (nunca o `202` cru, armadilha
 * documentada). */
export function isSiteRegistered(sites: BingSiteRow[], hostNoSlash: string): boolean {
  const target = normalizeHostForAddSite(hostNoSlash).toLowerCase();
  return sites.some((s) => normalizeHostForAddSite(s.url).toLowerCase() === target);
}

async function bingCall(endpoint: string, params: Record<string, string>, apiKey: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(buildUrl(endpoint, params, apiKey));
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bing WMT ${endpoint} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** `AddSite` — cadastra `hostNoSlash` (SEM barra final, ver armadilha da
 * docstring). Retorna o status HTTP cru: **nunca tratar como confirmação**
 * — o chamador deve confirmar via `getUserSites`/`isSiteRegistered`. */
export async function addSite(hostNoSlash: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await fetchImpl(buildUrl("AddSite", { siteUrl: hostNoSlash }, apiKey));
  return res.status;
}

export async function getUserSites(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<BingSiteRow[]> {
  return parseBingUserSitesResponse(await bingCall("GetUserSites", {}, apiKey, fetchImpl));
}

/** `SubmitFeed` — **não** `SubmitSitemap` (esse método 404a com corpo HTML,
 * ver `docs/seo-notes.md` §Fato 3 armadilha 1). Campo `feedUrl`. */
export async function submitFeed(
  siteUrl: string,
  feedUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await bingCall("SubmitFeed", { siteUrl, feedUrl }, apiKey, fetchImpl);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const { values, flags } = parseCliArgs(argv);
  const apiKey = process.env.BING_WEBMASTER_API_KEY;
  if (!apiKey) {
    console.error(`${LOG_PREFIX} BING_WEBMASTER_API_KEY não definida (.env, ver .env.example).`);
    return 1;
  }

  if (flags.has("list")) {
    const sites = await getUserSites(apiKey);
    console.log(JSON.stringify({ total: sites.length, sites }, null, 2));
    return 0;
  }

  const hostRaw = values["host"] !== undefined ? String(values["host"]) : "";
  if (!hostRaw) {
    console.error(`${LOG_PREFIX} uso: --host https://exemplo.com [--submit-feed https://exemplo.com/sitemap.xml] | --list`);
    return 2;
  }
  const host = normalizeHostForAddSite(hostRaw);

  console.log(`${LOG_PREFIX} AddSite ${host}`);
  const addStatus = await addSite(host, apiKey);
  console.log(`${LOG_PREFIX} AddSite status=${addStatus} (202 NÃO é confirmação — reconferindo via GetUserSites)`);

  const sites = await getUserSites(apiKey);
  const registered = isSiteRegistered(sites, host);
  console.log(`${LOG_PREFIX} GetUserSites: ${registered ? "cadastrado" : "AUSENTE"} — ${sites.length} propriedade(s) na conta.`);

  if (!registered) {
    console.error(
      `${LOG_PREFIX} ${host} não apareceu em GetUserSites. Se AddSite foi chamado com barra final, essa é a causa ` +
        `conhecida (armadilha documentada em docs/seo-notes.md §Fato 3) — este script já normaliza, então investigar outra causa.`,
    );
    return 1;
  }

  const row = sites.find((s) => normalizeHostForAddSite(s.url).toLowerCase() === host.toLowerCase());
  if (!row?.verified) {
    console.log(
      `${LOG_PREFIX} ${host} cadastrado mas AINDA NÃO VERIFICADO. A API do BWT não expõe (nesta sessão, sem ` +
        `confirmação ao vivo) um endpoint estável para obter o registro DNS de verificação — completar manualmente ` +
        `via BWT UI (mesmo caminho usado em 11/ago/2026 para os outros 2 hosts: CNAME via API da Cloudflare, ver ` +
        `docs/seo-notes.md §Fato 3) antes de rodar --submit-feed.`,
    );
    return 0;
  }

  const feedUrl = values["submit-feed"] !== undefined ? String(values["submit-feed"]) : undefined;
  if (feedUrl) {
    console.log(`${LOG_PREFIX} SubmitFeed ${feedUrl} para ${host}`);
    await submitFeed(host, feedUrl, apiKey);
    console.log(`${LOG_PREFIX} SubmitFeed ok.`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(`${LOG_PREFIX} erro:`, e);
      process.exitCode = 1;
    });
}
