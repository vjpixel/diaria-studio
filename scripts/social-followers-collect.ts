#!/usr/bin/env node
/**
 * scripts/social-followers-collect.ts (#8260 Fase 1)
 *
 * Task diária que grava `followers_count` do Instagram (@diar.ia.br) e do
 * Facebook num arquivo append-only, `data/metrics/social-followers.jsonl` —
 * 1 linha por plataforma por dia. `scripts/lib/social-followers.ts` (núcleo
 * puro) transforma essa série em saldo diário (delta contra a amostra
 * anterior); este script só COLETA e GRAVA, nenhum cálculo aqui.
 *
 * ## Fase 1 vs. Fase 2 (ver corpo da issue #8260)
 *
 * Fase 1 (este script): `followers_count` é um TOTAL — o saldo é derivado
 * depois (delta entre dias), nunca um "ganho bruto" do dia. Só exige os
 * escopos que o token atual já tem (`instagram_basic`, `pages_read_engagement`).
 *
 * Fase 2, só Instagram (#12348): `collectInstagramGrossFollows` lê a métrica
 * `follower_count` do IG Insights (novos seguidores BRUTOS por dia, 30 dias
 * para trás) e anexa os dias completos em `data/metrics/instagram-follows-daily.jsonl`
 * (núcleo puro em `lib/instagram-follower-insights.ts`). Exige
 * `instagram_manage_insights`/`read_insights` no `INSTAGRAM_ACCESS_TOKEN`
 * (instalado em 07/11/2026, probe 200 em 10/11). Sem o escopo, a API volta
 * `(#10)` e o script imprime o diagnóstico; a coleta de `followers_count`
 * (o saldo líquido, fallback) roda igual, independente dela. O Facebook
 * (`page_daily_follows_unique`) segue fora: as métricas voltaram `data: []`
 * na v25.0 (#8260).
 *
 * ## Guard de publicação/plataforma (#8260, dispatch overnight)
 *
 * Este script bate na Graph API do Meta — write-free (só GET), mas ainda
 * assim uma chamada "ao vivo" contra uma conta de terceiro. Nenhuma sessão
 * de subagente overnight/develop pode EXECUTAR este script — só editar. O
 * 1º fetch real fica pra quando o editor rodar manualmente ou armar a task
 * (`enabled: false` em `scripts/lib/scheduled-tasks.ts` até lá).
 *
 * ## Fail-soft por plataforma, nunca aborta as duas por causa de 1
 *
 * IG e FB são independentes — token/permissão faltando ou erro de rede numa
 * plataforma não impede gravar a outra. Dia sem gravação nenhuma (as 2
 * falharam) simplesmente não produz linha nova — `computeDailyBalances` já
 * trata isso como "dia faltando" (ver docstring de `social-followers.ts`),
 * nunca como saldo 0.
 *
 * Credenciais: `INSTAGRAM_BUSINESS_ACCOUNT_ID`/`INSTAGRAM_ACCESS_TOKEN` e
 * `FACEBOOK_PAGE_ID`/`FACEBOOK_PAGE_ACCESS_TOKEN` (mesmas vars já usadas por
 * `publish-instagram.ts`/`publish-facebook.ts` — nenhuma credencial nova).
 *
 * #10458: o Facebook é coletado POR PÁGINA habilitada em
 * `publishing.social.facebook.pages` (helper `lib/facebook-pages.ts`, só env
 * var), cada uma na sua série (`page` na linha; a `diaria` omite o campo, então
 * a série histórica continua igual). Página sem credencial falha só ela.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainModule } from "./lib/cli-args.ts";
import { DEFAULT_FACEBOOK_PAGE_SLUG, loadFacebookPagesConfig, resolveFacebookPages } from "./lib/facebook-pages.ts"; // #10458
import {
  daysToAppend,
  diagnoseInsightsError,
  IG_FOLLOWS_DAILY_PATH,
  pacificDate,
  parseFollowerCountInsights,
  parseInstagramFollowsJsonl,
  serializeInstagramFollowsDay,
  type InsightsError,
} from "./lib/instagram-follower-insights.ts"; // #12348
import {
  followerSamplePage,
  parseSocialFollowersJsonl,
  serializeSocialFollowerSample,
  type SocialFollowerSample,
  type SocialPlatform,
} from "./lib/social-followers.ts";

const GRAPH_API_BASE = "https://graph.facebook.com";
const GRAPH_API_VERSION = "v25.0"; // mesma versão de publish-instagram.ts/publish-facebook.ts

export const DEFAULT_OUTPUT_PATH = "data/metrics/social-followers.jsonl";

export interface CollectResult {
  platform: SocialPlatform;
  /** #10458 — página do Facebook (só `platform: "facebook"`). */
  page?: string;
  followersCount: number | null;
  error: string | null;
  written: boolean;
}

/** GET `{id}?fields=followers_count` — mesma chamada pros dois (IG Business
 *  Account e FB Page usam o mesmo shape de resposta). Nunca lança: erro de
 *  rede/HTTP/parsing vira `{ followersCount: null, error }`. */
async function fetchFollowersCount(
  fetchImpl: typeof fetch,
  objectId: string,
  accessToken: string,
): Promise<{ followersCount: number | null; error: string | null }> {
  // Token vai no header Authorization, nunca na query string (#7779, mesma
  // disciplina de `fetchPermalink` em publish-instagram.ts) — a query
  // string vaza o segredo pro log sem ninguém logar a URL de propósito.
  const url = `${GRAPH_API_BASE}/${GRAPH_API_VERSION}/${objectId}?fields=followers_count`;
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = (await res.json().catch(() => null)) as { followers_count?: number; error?: { message?: string } } | null;
    if (!res.ok || !body) {
      const msg = body?.error?.message ?? `HTTP ${res.status}`;
      return { followersCount: null, error: msg };
    }
    if (typeof body.followers_count !== "number") {
      return { followersCount: null, error: "resposta sem followers_count" };
    }
    return { followersCount: body.followers_count, error: null };
  } catch (e) {
    return { followersCount: null, error: (e as Error).message };
  }
}

function ensureDir(fullPath: string): void {
  const dir = dirname(fullPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Já existe amostra desta plataforma NESTE dia? Evita linha duplicada se a
 *  task rodar 2× no mesmo dia (retry manual, cron sobreposto). Fail-soft:
 *  arquivo ausente/ilegível conta como "não existe ainda". */
function hasSampleForToday(outputPath: string, platform: SocialPlatform, date: string, page?: string): boolean {
  if (!existsSync(outputPath)) return false;
  try {
    const { samples } = parseSocialFollowersJsonl(readFileSync(outputPath, "utf8"));
    // #10458: idempotência por (plataforma, página, dia).
    const want = followerSamplePage({ page });
    return samples.some((s) => s.platform === platform && s.date === date && followerSamplePage(s) === want);
  } catch {
    return false;
  }
}

export interface CollectOptions {
  now?: () => Date;
  outputPath?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** #10458 — `platform.config.json` (default: lido do cwd; ausente/ilegível → só a `diaria`). */
  config?: unknown;
}

function readCwdPlatformConfig(): unknown {
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), "platform.config.json"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Coleta `followers_count` do IG e do FB e grava em `outputPath` (append).
 * Cada plataforma é independente (fail-soft) — credencial ausente vira
 * `error` sem abortar a outra. Nunca sobrescreve uma amostra já gravada
 * hoje (idempotente por dia).
 */
export async function collectSocialFollowers(opts: CollectOptions = {}): Promise<CollectResult[]> {
  const now = opts.now ?? (() => new Date());
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const outputPath = resolve(process.cwd(), opts.outputPath ?? DEFAULT_OUTPUT_PATH);
  const date = now().toISOString().slice(0, 10);

  type Target = { platform: SocialPlatform; page?: string; objectId: string | undefined; token: string | undefined; missingVars: string[] };
  const targets: Target[] = [
    {
      platform: "instagram",
      objectId: env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
      token: env.INSTAGRAM_ACCESS_TOKEN,
      missingVars: ["INSTAGRAM_BUSINESS_ACCOUNT_ID", "INSTAGRAM_ACCESS_TOKEN"],
    },
  ];
  const results: CollectResult[] = [];
  // #10458: uma série por página do Facebook HABILITADA (só env var, como antes).
  try {
    const pages = resolveFacebookPages(loadFacebookPagesConfig(opts.config ?? readCwdPlatformConfig()), env);
    for (const pg of pages.filter((p) => p.enabled)) {
      targets.push({
        platform: "facebook",
        page: pg.slug,
        objectId: pg.pageId || undefined,
        token: pg.token || undefined,
        missingVars: pg.missing,
      });
    }
  } catch (e) {
    results.push({ platform: "facebook", followersCount: null, error: `config de páginas inválido: ${(e as Error).message}`, written: false });
  }

  for (const t of targets) {
    const base = { platform: t.platform, ...(t.page ? { page: t.page } : {}) };
    if (!t.objectId || !t.token) {
      results.push({ ...base, followersCount: null, error: `credencial ausente (${t.missingVars.join(", ")})`, written: false });
      continue;
    }
    if (hasSampleForToday(outputPath, t.platform, date, t.page)) {
      results.push({ ...base, followersCount: null, error: null, written: false });
      continue;
    }
    const { followersCount, error } = await fetchFollowersCount(fetchImpl, t.objectId, t.token);
    if (error || followersCount === null) {
      results.push({ ...base, followersCount: null, error: error ?? "sem followers_count", written: false });
      continue;
    }
    // A `diaria` omite `page` — a linha sai igual à de antes da lista de páginas.
    const sample: SocialFollowerSample = {
      date,
      platform: t.platform,
      followersCount,
      ...(t.page && t.page !== DEFAULT_FACEBOOK_PAGE_SLUG ? { page: t.page } : {}),
    };
    try {
      ensureDir(outputPath);
      appendFileSync(outputPath, serializeSocialFollowerSample(sample) + "\n", "utf8");
      results.push({ ...base, followersCount, error: null, written: true });
    } catch (e) {
      results.push({ ...base, followersCount, error: `falha ao gravar: ${(e as Error).message}`, written: false });
    }
  }
  return results;
}

export interface GrossFollowsResult {
  /** Dias anexados nesta execução (novos ou revisados pela Meta). */
  appended: number;
  /** Dias completos que a API devolveu. */
  fetchedDays: number;
  error: InsightsError | null;
}

export interface GrossFollowsOptions {
  now?: () => Date;
  outputPath?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/** Janela pedida à API: a Meta só guarda `follower_count` dos últimos 30 dias. */
const INSIGHTS_WINDOW_DAYS = 29;

/**
 * #12348 — série bruta de novos seguidores do IG via Insights
 * (`metric=follower_count&period=day`). Uma chamada por execução cobre os
 * últimos ~30 dias: a 1ª execução faz o backfill e as seguintes anexam só os
 * dias novos ou revisados. Nunca lança; falha volta em `error` com o
 * diagnóstico (`kind: "permission"` para o `(#10)` de escopo faltando).
 */
export async function collectInstagramGrossFollows(opts: GrossFollowsOptions = {}): Promise<GrossFollowsResult> {
  const now = (opts.now ?? (() => new Date()))();
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const outputPath = resolve(process.cwd(), opts.outputPath ?? IG_FOLLOWS_DAILY_PATH);
  const igId = env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  const token = env.INSTAGRAM_ACCESS_TOKEN;
  if (!igId || !token) {
    return {
      appended: 0,
      fetchedDays: 0,
      error: { kind: "missing", message: "credencial ausente (INSTAGRAM_BUSINESS_ACCOUNT_ID, INSTAGRAM_ACCESS_TOKEN)" },
    };
  }
  const until = Math.floor(now.getTime() / 1000);
  const since = until - INSIGHTS_WINDOW_DAYS * 86400;
  // Token no header, nunca na query string (#7779).
  const url = `${GRAPH_API_BASE}/${GRAPH_API_VERSION}/${igId}/insights?metric=follower_count&period=day&since=${since}&until=${until}`;
  let body: unknown;
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
    body = await res.json().catch(() => null);
    if (!res.ok) return { appended: 0, fetchedDays: 0, error: diagnoseInsightsError(res.status, body) };
  } catch (e) {
    return { appended: 0, fetchedDays: 0, error: { kind: "http", message: `falha de rede: ${(e as Error).message}` } };
  }
  const parsed = parseFollowerCountInsights(body, pacificDate(now));
  if ("error" in parsed) return { appended: 0, fetchedDays: 0, error: parsed.error };

  let existing: ReturnType<typeof parseInstagramFollowsJsonl>["days"] = [];
  if (existsSync(outputPath)) {
    try {
      existing = parseInstagramFollowsJsonl(readFileSync(outputPath, "utf8")).days;
    } catch (e) {
      return { appended: 0, fetchedDays: parsed.days.length, error: { kind: "shape", message: `falha ao ler a série: ${(e as Error).message}` } };
    }
  }
  const toAppend = daysToAppend(existing, parsed.days);
  if (toAppend.length > 0) {
    try {
      ensureDir(outputPath);
      const collectedAt = now.toISOString();
      appendFileSync(outputPath, toAppend.map((d) => serializeInstagramFollowsDay(d, collectedAt) + "\n").join(""), "utf8");
    } catch (e) {
      return { appended: 0, fetchedDays: parsed.days.length, error: { kind: "shape", message: `falha ao gravar: ${(e as Error).message}` } };
    }
  }
  return { appended: toAppend.length, fetchedDays: parsed.days.length, error: null };
}

const label = (r: CollectResult): string =>
  r.page && r.page !== DEFAULT_FACEBOOK_PAGE_SLUG ? `${r.platform}[${r.page}]` : r.platform;

async function main(): Promise<void> {
  const results = await collectSocialFollowers();
  let hadError = false;
  // #12348: bruto do IG, independente do saldo líquido acima (que é o fallback).
  const gross = await collectInstagramGrossFollows();
  if (gross.error) {
    hadError = true;
    console.error(`ERRO instagram[insights ${gross.error.kind}]: ${gross.error.message}`);
  } else {
    console.log(`OK instagram[insights]: ${gross.fetchedDays} dias completos lidos, ${gross.appended} anexados em ${IG_FOLLOWS_DAILY_PATH}`);
  }
  for (const r of results) {
    if (r.error) {
      hadError = true;
      console.error(`ERRO ${label(r)}: ${r.error}`);
    } else if (r.written) {
      console.log(`OK ${label(r)}: followers_count=${r.followersCount}`);
    } else {
      console.log(`SKIP ${label(r)}: amostra de hoje já existe`);
    }
  }
  // Falha de 1 plataforma não é fatal (fail-soft) — mas sinaliza pro
  // task-runner/systemd via exit != 0, pra aparecer no log sem quebrar o
  // horário da outra plataforma no dia seguinte.
  if (hadError) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main();
}
