#!/usr/bin/env node
/**
 * postmaster-spam-sync.ts (#4154)
 *
 * Substitui a leitura MANUAL do `spamRate` diário do Google Postmaster Tools
 * (domínio `clarice.ai`, do parceiro) por uma chamada direta à
 * `gmailpostmastertools.googleapis.com` — grava no mesmo KV
 * (`postmaster:spam`) que `scripts/postmaster-spam-entry.ts` já grava, com o
 * mesmo formato (`PostmasterSpamEntry`), então o consumidor
 * (`resolveSpamSignal` em `workers/brevo-dashboard/src/thresholds.ts`) não
 * muda nada.
 *
 * Histórico (#4154): a issue foi fechada em 260727 como "bloqueada por
 * acesso de terceiro" — a hipótese era que a conta do editor não era dona do
 * domínio `clarice.ai` no Postmaster. Reaberta e investigada em 260730:
 * `vjpixel@gmail.com` tem permissão OWNER em `clarice.ai` no Postmaster
 * (confirmado ao vivo via UI e via `domains.get`). O erro real era outro — a
 * Gmail Postmaster Tools API nunca tinha sido HABILITADA no projeto GCP do
 * OAuth client (403 SERVICE_DISABLED); a investigação de 260727 não chegou a
 * testar o endpoint de fato e inferiu "não é dono" de um sintoma diferente.
 * Habilitada a API via console em 260730; `domains.get`/`trafficStats.get`
 * funcionam normalmente daí em diante.
 *
 * Formato de data da API é `YYYYMMDD` (sem hífen), diferente do `YYYY-MM-DD`
 * usado em `PostmasterSpamEntry.date`. O Postmaster tem ~2 dias de lag
 * observados empiricamente (não documentado como garantia pela Google) —
 * este script sonda hoje, ontem, anteontem... até achar o dia mais recente
 * com dado disponível, ou esgotar `--lookback-days`.
 *
 * `userReportedSpamRatio` AUSENTE (dia com `trafficStats` 200 mas sem o
 * campo) não significa 0% — a doc do Google não define o caso
 * explicitamente, mas o campo é condicionado a tráfego autenticado por DKIM
 * ("This metric only pertains to emails authenticated by DKIM"), o que
 * aponta pra "dado insuficiente pra calcular", não "sem spam". Gravar 0%
 * nesse caso seria reintroduzir o MESMO risco de falso-verde que motivou
 * trocar a Brevo pelo Postmaster como fonte (#4063: a Brevo subconta ~50× e
 * o breaker nunca disparava).
 *
 * IMPORTANTE — erro de HTTP (401/403/429/5xx) NUNCA é tratado como "dado
 * ausente": são duas condições distintas e não podem cair no mesmo galho, ou
 * este script reproduz o MESMO tipo de falha que causou o #4154 original
 * (403 SERVICE_DISABLED foi lido como "sem acesso ao domínio" — achado no
 * self-review deste PR, #4342). Um dia sem publicação ainda (404) ou com
 * volume insuficiente (200 sem o campo) é esperado e silencioso; um erro de
 * API é uma condição real que precisa aparecer no log e, se TODOS os dias
 * sondados falharem assim, interrompe a run com exit != 0 em vez de concluir
 * "sem tráfego DKIM".
 *
 * Quando nenhum dia produz uma leitura utilizável (por dado insuficiente, não
 * por erro), o script não escreve nada no KV — a última leitura válida
 * expira sozinha em 48h (`POSTMASTER_STALE_MS`) e vira `indeterminate`
 * (seguro, nunca "verde falso").
 *
 * Uso:
 *   npx tsx scripts/postmaster-spam-sync.ts [--lookback-days 7] [--dry-run]
 *
 * Env:
 *   data/.credentials.json  com o scope `postmaster.readonly` (ver
 *                            scripts/oauth-setup.ts) — mesmo refresh token
 *                            usado por Drive/Gmail.
 *   CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_WORKERS_TOKEN  p/ upload no KV.
 */

import { gFetch } from "./google-auth.ts";
import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { DASHBOARD_KV_NAMESPACE_ID } from "./lib/dashboard-kv.ts";
import { POSTMASTER_SPAM_KV_KEY } from "./postmaster-spam-entry.ts";
import type { PostmasterSpamEntry } from "./lib/dashboard-kv-types.ts";

loadProjectEnv();

const POSTMASTER_DOMAIN = "clarice.ai";
const DEFAULT_LOOKBACK_DAYS = 7;

/** `Date` → `YYYYMMDD` (formato do resource name da API, sem hífen). */
export function toApiDateStr(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** `YYYYMMDD` → `YYYY-MM-DD` (formato de `PostmasterSpamEntry.date`). */
export function apiDateToEntryDate(apiDate: string): string {
  return `${apiDate.slice(0, 4)}-${apiDate.slice(4, 6)}-${apiDate.slice(6, 8)}`;
}

export interface TrafficStatsResponse {
  userReportedSpamRatio?: number;
  [key: string]: unknown;
}

/** Resultado de uma sondagem de `trafficStats.get` pra um dia: 404 (não publicado ainda), 200 (com ou sem o campo), ou erro real de HTTP. */
export interface FetchStatsResult {
  status: number;
  body: TrafficStatsResponse | null;
  /** Corpo bruto (truncado) da resposta de erro, só quando `status` não é 200/404 — pro log distinguir a causa real. */
  errorText?: string;
}

/**
 * Pura/testável: extrai o `PostmasterSpamEntry` de uma resposta de
 * `trafficStats.get`, ou `null` se `userReportedSpamRatio` não veio (dado
 * insuficiente — nunca tratar como 0%, ver docstring do módulo).
 */
export function parseTrafficStatsResponse(
  body: TrafficStatsResponse,
  apiDate: string,
  now: Date,
): PostmasterSpamEntry | null {
  if (typeof body.userReportedSpamRatio !== "number") return null;
  return {
    date: apiDateToEntryDate(apiDate),
    spamRatePct: body.userReportedSpamRatio * 100,
    recordedAt: now.toISOString(),
    producedBy: "auto",
  };
}

export interface FindLatestSpamReadingResult {
  entry: PostmasterSpamEntry | null;
  /** Dias com `trafficStats` 200 mas sem `userReportedSpamRatio` (dado insuficiente, não erro). */
  daysWithDataNoRatio: number;
  daysChecked: number;
  /** Dias que retornaram um status de erro real (nem 200 nem 404) — NUNCA confundir com "sem dado ainda". */
  httpErrors: Array<{ apiDate: string; status: number; errorText?: string }>;
}

/**
 * Sonda `trafficStats.get` de hoje pra trás até achar um dia com
 * `userReportedSpamRatio` presente, ou esgotar `lookbackDays`. Três
 * resultados por dia são tratados como coisas DIFERENTES (ver docstring do
 * módulo — misturar erro de HTTP com "sem dado" foi o bug original do
 * #4154):
 *   - 404            → dia ainda não publicado (esperado, silencioso).
 *   - 200 sem o campo → dado insuficiente (esperado, contabilizado em `daysWithDataNoRatio`).
 *   - qualquer outro  → erro real (contabilizado em `httpErrors`, nunca ignorado em silêncio).
 */
export async function findLatestSpamReading(
  lookbackDays: number,
  now: Date = new Date(),
  fetchStats: (apiDate: string) => Promise<FetchStatsResult>,
): Promise<FindLatestSpamReadingResult> {
  let daysWithDataNoRatio = 0;
  let daysChecked = 0;
  const httpErrors: FindLatestSpamReadingResult["httpErrors"] = [];

  for (let offset = 0; offset < lookbackDays; offset++) {
    const d = new Date(now.getTime() - offset * 86_400_000);
    const apiDate = toApiDateStr(d);
    const { status, body, errorText } = await fetchStats(apiDate);
    daysChecked++;

    if (status === 404) continue;

    if (status === 200) {
      if (!body) continue; // defensivo — não deveria acontecer com status 200
      const entry = parseTrafficStatsResponse(body, apiDate, now);
      if (entry) return { entry, daysWithDataNoRatio, daysChecked, httpErrors };
      daysWithDataNoRatio++;
      continue;
    }

    // Qualquer status que não seja 404 nem 200 é um erro real — nunca cai no
    // mesmo galho de "sem dado ainda".
    httpErrors.push({ apiDate, status, errorText });
  }

  return { entry: null, daysWithDataNoRatio, daysChecked, httpErrors };
}

async function fetchStatsFromApi(apiDate: string): Promise<FetchStatsResult> {
  const res = await gFetch(
    `https://gmailpostmastertools.googleapis.com/v1/domains/${POSTMASTER_DOMAIN}/trafficStats/${apiDate}`,
  );
  if (res.status === 404) {
    await res.arrayBuffer().catch(() => undefined);
    return { status: 404, body: null };
  }
  if (res.status !== 200) {
    const errorText = await res.text().catch(() => "");
    return { status: res.status, body: null, errorText: errorText.slice(0, 500) };
  }
  const body = (await res.json()) as TrafficStatsResponse;
  return { status: 200, body };
}

/**
 * Pura/testável: valida `--lookback-days`. Vazio usa o default; qualquer
 * valor não-numérico ou < 1 lança erro explícito (mesmo padrão de
 * `buildPostmasterSpamEntry` em postmaster-spam-entry.ts).
 */
export function parseLookbackDaysArg(arg: string): number {
  if (arg.trim() === "") return DEFAULT_LOOKBACK_DAYS;
  const n = Number(arg);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--lookback-days inválido: "${arg}" (esperado inteiro >= 1).`);
  }
  return n;
}

async function main(): Promise<void> {
  const isDryRun = hasFlag(process.argv, "dry-run");
  const lookbackArg = getArg(process.argv, "lookback-days");

  let lookbackDays: number;
  try {
    lookbackDays = parseLookbackDaysArg(lookbackArg);
  } catch (e) {
    console.error(`[postmaster-spam-sync] ${(e as Error).message}`);
    process.exit(2);
    return;
  }

  const now = new Date();
  const { entry, daysWithDataNoRatio, daysChecked, httpErrors } = await findLatestSpamReading(
    lookbackDays,
    now,
    fetchStatsFromApi,
  );

  if (httpErrors.length > 0) {
    const detail = httpErrors.map((e) => `${e.apiDate}=${e.status}`).join(", ");
    if (httpErrors.length === daysChecked) {
      // TODOS os dias sondados falharam com erro de HTTP — não é "sem dado
      // ainda", é uma falha real (credencial revogada, API desabilitada de
      // novo, quota, etc). Nunca disfarçar isso de "tráfego DKIM
      // insuficiente" — propaga como erro (main().catch → exit 1).
      throw new Error(
        `todos os ${daysChecked} dias sondados falharam com erro HTTP (${detail}) — ` +
          `provável credencial revogada/API desabilitada/quota, NÃO "sem dado ainda". ` +
          `Detalhe do último erro: ${httpErrors[httpErrors.length - 1].errorText ?? "(sem corpo)"}`,
      );
    }
    console.warn(
      `[postmaster-spam-sync] AVISO: ${httpErrors.length}/${daysChecked} dias sondados retornaram erro HTTP (${detail}), não 404/200. Prosseguindo com os dias restantes.`,
    );
  }

  if (!entry) {
    console.log(
      `[postmaster-spam-sync] Sem userReportedSpamRatio disponível nos últimos ${daysChecked} dias ` +
        `(${daysWithDataNoRatio} com trafficStats mas sem o campo — provável tráfego DKIM insuficiente). ` +
        "NÃO escrevendo no KV — mantendo a última leitura válida (expira em 48h e vira indeterminate, nunca verde falso).",
    );
    return;
  }

  const json = JSON.stringify(entry, null, 2);
  console.log(`[postmaster-spam-sync] leitura: ${json}`);

  if (isDryRun) {
    console.log("[postmaster-spam-sync] --dry-run: não gravou no KV.");
    return;
  }

  await uploadTextToWorkerKV(json, POSTMASTER_SPAM_KV_KEY, {
    kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_WORKERS_TOKEN ?? "",
  });
  console.log(
    `[postmaster-spam-sync] KV atualizado: ${POSTMASTER_SPAM_KV_KEY} (spamRatePct=${entry.spamRatePct.toFixed(3)}, date=${entry.date}).`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[postmaster-spam-sync] erro:", e);
    process.exit(1);
  });
}
