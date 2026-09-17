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
 * Fase 2 (fora de escopo aqui): métrica `follower_count` do IG Insights
 * (bruto, 30 dias retroativos) e `page_daily_follows_unique` do FB exigem
 * `instagram_manage_insights`/`read_insights`, que o token atual NÃO tem —
 * confirmado ao vivo na issue (`(#10) Application does not have permission
 * for this action`). Gerar um token novo com esses escopos é ação manual do
 * editor (System User no Business Manager) — não implementado aqui.
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
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainModule } from "./lib/cli-args.ts";
import {
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
function hasSampleForToday(outputPath: string, platform: SocialPlatform, date: string): boolean {
  if (!existsSync(outputPath)) return false;
  try {
    const { samples } = parseSocialFollowersJsonl(readFileSync(outputPath, "utf8"));
    return samples.some((s) => s.platform === platform && s.date === date);
  } catch {
    return false;
  }
}

export interface CollectOptions {
  now?: () => Date;
  outputPath?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
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

  const targets: Array<{ platform: SocialPlatform; objectId: string | undefined; token: string | undefined; missingVars: string[] }> = [
    {
      platform: "instagram",
      objectId: env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
      token: env.INSTAGRAM_ACCESS_TOKEN,
      missingVars: ["INSTAGRAM_BUSINESS_ACCOUNT_ID", "INSTAGRAM_ACCESS_TOKEN"],
    },
    {
      platform: "facebook",
      objectId: env.FACEBOOK_PAGE_ID,
      token: env.FACEBOOK_PAGE_ACCESS_TOKEN,
      missingVars: ["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"],
    },
  ];

  const results: CollectResult[] = [];
  for (const t of targets) {
    if (!t.objectId || !t.token) {
      results.push({ platform: t.platform, followersCount: null, error: `credencial ausente (${t.missingVars.join(", ")})`, written: false });
      continue;
    }
    if (hasSampleForToday(outputPath, t.platform, date)) {
      results.push({ platform: t.platform, followersCount: null, error: null, written: false });
      continue;
    }
    const { followersCount, error } = await fetchFollowersCount(fetchImpl, t.objectId, t.token);
    if (error || followersCount === null) {
      results.push({ platform: t.platform, followersCount: null, error: error ?? "sem followers_count", written: false });
      continue;
    }
    const sample: SocialFollowerSample = { date, platform: t.platform, followersCount };
    try {
      ensureDir(outputPath);
      appendFileSync(outputPath, serializeSocialFollowerSample(sample) + "\n", "utf8");
      results.push({ platform: t.platform, followersCount, error: null, written: true });
    } catch (e) {
      results.push({ platform: t.platform, followersCount, error: `falha ao gravar: ${(e as Error).message}`, written: false });
    }
  }
  return results;
}

async function main(): Promise<void> {
  const results = await collectSocialFollowers();
  let hadError = false;
  for (const r of results) {
    if (r.error) {
      hadError = true;
      console.error(`ERRO ${r.platform}: ${r.error}`);
    } else if (r.written) {
      console.log(`OK ${r.platform}: followers_count=${r.followersCount}`);
    } else {
      console.log(`SKIP ${r.platform}: amostra de hoje já existe`);
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
