#!/usr/bin/env node
/**
 * scripts/bing-add-site.ts (#5621)
 *
 * Cadastra um host novo como propriedade no Bing Webmaster Tools (BWT) —
 * `AddSite` + confirmação via `GetUserSites` (nunca tratar o `202` de
 * `AddSite` como confirmação, ver armadilha 3 de `docs/seo-notes.md` §Fato 3)
 * + `SubmitFeed` do sitemap quando o host já estiver verificado.
 *
 * **Não automatiza a verificação por DNS.** O valor exato do registro CNAME
 * que o Bing pede não tem endpoint de API estável confirmado (só aparece no
 * fluxo "Add & verify site" da UI do BWT, seção "Add CNAME record to DNS") —
 * completar manualmente: BWT UI pra pegar `name`/`value`, API da Cloudflare
 * pra criar o CNAME (`POST /zones/{zone}/dns_records`), botão "Verify" na
 * mesma UI. Este script cadastra o site (`AddSite`) e reporta o estado de
 * verificação (`GetUserSites`); se o site não estiver verificado, imprime a
 * instrução acima antes de rodar `--submit-feed`.
 *
 * **Bug ao vivo #5623 (19/ago/2026): `AddSite` NÃO é idempotente — reinvocar
 * num host JÁ verificado reseta o status pra não-verificado**, sem erro no
 * HTTP nem aviso no corpo da resposta (confirmado em `livros`/`cursos`: dois
 * hosts que a sessão tinha acabado de verificar por CNAME voltaram a
 * `verified: false` só por eu ter rodado `--host` de novo neles, sem passar
 * por `AddSite` outra vez de propósito). Corrigido aqui: o script agora
 * checa `GetUserSites` ANTES de chamar `AddSite` e pula a chamada se o host
 * já estiver `verified: true`. **Não rodar `AddSite` "só pra garantir" em
 * host já verificado** — se precisar confirmar o estado, use `--list`.
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
 * **Bug corrigido #5621 (confirmado ao vivo 260818): `AddSite`/`SubmitFeed`
 * exigem POST, não GET.** Uma tentativa real de cadastro (`--host
 * https://livros.diar.ia.br` / `https://cursos.diar.ia.br`) devolveu
 * `AddSite status=405` (Method Not Allowed) pra ambos — a API JSON do BWT só
 * aceita GET nos endpoints de LEITURA (`GetUserSites`, usado por
 * `bing-pull.ts`); endpoints que MUTAM estado exigem POST com corpo JSON.
 * Não há doc oficial acessível nesta sessão confirmando o shape exato do
 * corpo — `{siteUrl}` / `{siteUrl, feedUrl}` é a leitura mais provável (nomes
 * de campo já usados como query param antes da correção, padrão REST comum),
 * mas fica sinalizado como suposição, não certeza confirmada pela Microsoft.
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

/** Só `apikey` como query param (mutação vai no corpo POST, não em params). */
function buildUrlKeyOnly(endpoint: string, apiKey: string): string {
  const search = new URLSearchParams({ apikey: apiKey });
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

/** `true` só quando `AddSite` precisa ser chamado — host ausente OU presente
 * mas não verificado. Pura, sem I/O. #5623: reinvocar `AddSite` num host JÁ
 * verificado reseta o status pra não-verificado no BWT (confirmado ao vivo,
 * sem erro de HTTP) — este guard existe pra nunca chamar `AddSite` num host
 * que já está `verified: true`. */
export function shouldCallAddSite(sites: BingSiteRow[], hostNoSlash: string): boolean {
  const target = normalizeHostForAddSite(hostNoSlash).toLowerCase();
  const row = sites.find((s) => normalizeHostForAddSite(s.url).toLowerCase() === target);
  return !row?.verified;
}

/** Endpoints de LEITURA (`GetUserSites`, etc.) — GET puro, `params` na query. */
async function bingCall(endpoint: string, params: Record<string, string>, apiKey: string, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(buildUrl(endpoint, params, apiKey));
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bing WMT ${endpoint} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Endpoints que MUTAM estado (`AddSite`, `SubmitFeed`) — a API JSON do BWT
 * exige POST com corpo JSON pra esses; GET puro devolve `405 Method Not
 * Allowed` (confirmado ao vivo #5621, `AddSite status=405` contra
 * `https://livros.diar.ia.br` e `https://cursos.diar.ia.br`). `apikey`
 * continua como query param (auth do BWT é sempre por query param, não muda
 * entre GET/POST); o corpo carrega só os campos de negócio (`siteUrl`,
 * `feedUrl`). Shape do corpo não tem doc oficial acessível nesta sessão —
 * `{siteUrl}`/`{siteUrl, feedUrl}` é a leitura mais provável dado o padrão
 * REST comum e os nomes dos parâmetros que a API já usava via query string;
 * sinalizado como suposição no PR, não confirmação. */
async function bingMutate(endpoint: string, body: Record<string, string>, apiKey: string, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(buildUrlKeyOnly(endpoint, apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** `AddSite` — cadastra `hostNoSlash` (SEM barra final, ver armadilha da
 * docstring). Retorna o status HTTP cru: **nunca tratar como confirmação**
 * — o chamador deve confirmar via `getUserSites`/`isSiteRegistered`. */
export async function addSite(hostNoSlash: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const res = await bingMutate("AddSite", { siteUrl: hostNoSlash }, apiKey, fetchImpl);
  return res.status;
}

export async function getUserSites(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<BingSiteRow[]> {
  return parseBingUserSitesResponse(await bingCall("GetUserSites", {}, apiKey, fetchImpl));
}

/** `SubmitFeed` — **não** `SubmitSitemap` (esse método 404a com corpo HTML,
 * ver `docs/seo-notes.md` §Fato 3 armadilha 1). Campo `feedUrl`. POST com
 * corpo JSON — mesmo motivo de `addSite` (endpoint de mutação, GET dá 405). */
export async function submitFeed(
  siteUrl: string,
  feedUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await bingMutate("SubmitFeed", { siteUrl, feedUrl }, apiKey, fetchImpl);
  if (!res.ok) {
    const respBody = await res.text();
    throw new Error(`Bing WMT SubmitFeed ${res.status}: ${respBody.slice(0, 200)}`);
  }
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

  // #5623: reconferir ANTES de chamar AddSite — confirmado ao vivo em
  // 19/ago/2026 que reinvocar AddSite num host JÁ verificado reseta o
  // status pra não-verificado no lado do BWT (sem aviso, sem erro no
  // status HTTP). AddSite deixou de ser idempotente na prática; só chamar
  // quando o host ainda não está registrado OU não está verificado.
  let sites = await getUserSites(apiKey);
  if (!shouldCallAddSite(sites, host)) {
    console.log(`${LOG_PREFIX} ${host} já cadastrado e verificado — pulando AddSite (#5623: reinvocar reseta a verificação).`);
  } else {
    console.log(`${LOG_PREFIX} AddSite ${host}`);
    const addStatus = await addSite(host, apiKey);
    console.log(`${LOG_PREFIX} AddSite status=${addStatus} (202 NÃO é confirmação — reconferindo via GetUserSites)`);
    sites = await getUserSites(apiKey);
  }
  const row = sites.find((s) => normalizeHostForAddSite(s.url).toLowerCase() === host.toLowerCase());

  const registered = isSiteRegistered(sites, host);
  console.log(`${LOG_PREFIX} GetUserSites: ${registered ? "cadastrado" : "AUSENTE"} — ${sites.length} propriedade(s) na conta.`);

  if (!registered) {
    console.error(
      `${LOG_PREFIX} ${host} não apareceu em GetUserSites. Se AddSite foi chamado com barra final, essa é a causa ` +
        `conhecida (armadilha documentada em docs/seo-notes.md §Fato 3) — este script já normaliza, então investigar outra causa.`,
    );
    return 1;
  }

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
