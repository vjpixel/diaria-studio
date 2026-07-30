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
 * `vjpixel@gmail.com` é OWNER de `clarice.ai` no Postmaster desde 10/abr/2026
 * (confirmado na UI). O erro real era outro — a Gmail Postmaster Tools API
 * nunca tinha sido HABILITADA no projeto GCP do OAuth client
 * (`500929580057`, SERVICE_DISABLED). Habilitada em 260730; a chamada
 * `domains.get`/`trafficStats.get` funciona normalmente daí em diante.
 *
 * Formato de data da API é `YYYYMMDD` (sem hífen), diferente do `YYYY-MM-DD`
 * usado em `PostmasterSpamEntry.date`. O Postmaster tem ~2 dias de lag —
 * este script tenta hoje, ontem, anteontem... até achar o dia mais recente
 * com dado disponível.
 *
 * `userReportedSpamRatio` AUSENTE na resposta não significa 0% — a doc do
 * Google não define o caso explicitamente, mas o campo é condicionado a
 * tráfego autenticado por DKIM ("This metric only pertains to emails
 * authenticated by DKIM"), o que aponta pra "dado insuficiente pra calcular",
 * não "sem spam". Gravar 0% nesse caso seria reintroduzir o MESMO risco de
 * falso-verde que motivou trocar a Brevo pelo Postmaster como fonte (#4063:
 * a Brevo subconta ~50× e o breaker nunca disparava). Por isso, quando o
 * campo está ausente em TODOS os dias tentados, o script não escreve nada —
 * o KV mantém a última leitura válida, que expira sozinha em 48h
 * (POSTMASTER_STALE_MS) e vira `indeterminate` (seguro, nunca "verde falso").
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
  };
}

/**
 * Sonda `trafficStats.get` de hoje pra trás até achar um dia com
 * `userReportedSpamRatio` presente, ou esgotar `lookbackDays`. Retorna
 * também quantos dias tinham dado (200) mas sem o campo — útil pro log
 * distinguir "sem dado nenhum" de "dado presente mas ratio ausente".
 */
export async function findLatestSpamReading(
  lookbackDays: number,
  now: Date = new Date(),
  fetchStats: (apiDate: string) => Promise<{ status: number; body: TrafficStatsResponse | null }>,
): Promise<{ entry: PostmasterSpamEntry | null; daysWithDataNoRatio: number; daysChecked: number }> {
  let daysWithDataNoRatio = 0;
  let daysChecked = 0;
  for (let offset = 0; offset < lookbackDays; offset++) {
    const d = new Date(now.getTime() - offset * 86_400_000);
    const apiDate = toApiDateStr(d);
    const { status, body } = await fetchStats(apiDate);
    daysChecked++;
    if (status === 404) continue;
    if (status !== 200 || !body) continue;
    const entry = parseTrafficStatsResponse(body, apiDate, now);
    if (entry) return { entry, daysWithDataNoRatio, daysChecked };
    daysWithDataNoRatio++;
  }
  return { entry: null, daysWithDataNoRatio, daysChecked };
}

async function fetchStatsFromApi(
  apiDate: string,
): Promise<{ status: number; body: TrafficStatsResponse | null }> {
  const res = await gFetch(
    `https://gmailpostmastertools.googleapis.com/v1/domains/${POSTMASTER_DOMAIN}/trafficStats/${apiDate}`,
  );
  if (res.status !== 200) {
    await res.arrayBuffer().catch(() => undefined);
    return { status: res.status, body: null };
  }
  const body = (await res.json()) as TrafficStatsResponse;
  return { status: 200, body };
}

async function main(): Promise<void> {
  const isDryRun = hasFlag(process.argv, "dry-run");
  const lookbackArg = getArg(process.argv, "lookback-days");
  const lookbackDays = lookbackArg ? Number(lookbackArg) : DEFAULT_LOOKBACK_DAYS;
  if (!Number.isFinite(lookbackDays) || lookbackDays < 1) {
    console.error(`[postmaster-spam-sync] --lookback-days inválido: "${lookbackArg}".`);
    process.exit(2);
    return;
  }

  const now = new Date();
  const { entry, daysWithDataNoRatio, daysChecked } = await findLatestSpamReading(
    lookbackDays,
    now,
    fetchStatsFromApi,
  );

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
