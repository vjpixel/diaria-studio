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
 * usado em `PostmasterSpamEntry.date`.
 *
 * MÉDIA, não último dia isolado (260730, pedido do editor): a leitura é a
 * MÉDIA de `userReportedSpamRatio` sobre os últimos `HEALTH_SAMPLE_DAYS`
 * (mesma janela usada por TODAS as outras métricas da aba Rampa — abertura,
 * bounce, unsub — ver `workers/brevo-dashboard/src/weekly-plan.ts`), não o
 * dia mais recente isolado. Um dia isolado é ruidoso; a mesma janela das
 * outras métricas mantém a leitura comparável e consistente com o resto da
 * tabela.
 *
 * `userReportedSpamRatio` AUSENTE numa resposta 200 SIGNIFICA 0%, não "dado
 * insuficiente" — achado corrigido em 260730 comparando a API contra a UI do
 * Postmaster diretamente (print do editor): dias com 0,0% na UI do Postmaster
 * (ex: 27/07/2026) batem exatamente com "200 sem o campo" na API. Isso é o
 * comportamento padrão de serialização JSON de campos `double` protobuf no
 * valor default (0) — omitidos em vez de serializados como `0`. A hipótese
 * anterior ("DKIM insuficiente, nunca tratar como 0%") estava ERRADA e foi
 * corrigida nesta versão. Um dia SEM RESPOSTA NENHUMA (404 — não publicado
 * ainda, sem linha nenhuma na UI do Postmaster) continua sendo pulado, nunca
 * contado como 0% — essa distinção (404 vs 200-sem-campo) continua real e
 * verificada contra a UI (dias ausentes da tabela do Postmaster == 404 na API).
 *
 * IMPORTANTE — erro de HTTP (401/403/429/5xx) NUNCA é tratado como "dia sem
 * publicação": são duas condições distintas e não podem cair no mesmo galho,
 * ou este script reproduz o MESMO tipo de falha que causou o #4154 original
 * (403 SERVICE_DISABLED foi lido como "sem acesso ao domínio" — achado no
 * self-review do #4342). Um erro de API precisa aparecer no log e, se TODOS
 * os dias da janela falharem assim, interrompe a run com exit != 0 em vez de
 * calcular uma média sobre dado incompleto sem avisar.
 *
 * Quando NENHUM dia da janela tem uma resposta 200 (tudo 404 — sem tráfego
 * publicado ainda em toda a janela, cenário raro), o script não escreve nada
 * no KV — a última leitura válida expira sozinha em 48h (`POSTMASTER_STALE_MS`)
 * e vira `indeterminate` (seguro, nunca "verde falso").
 *
 * Uso:
 *   npx tsx scripts/postmaster-spam-sync.ts [--window-days 10] [--dry-run]
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
import { HEALTH_SAMPLE_DAYS } from "../workers/brevo-dashboard/src/weekly-plan.ts";
import type { PostmasterSpamEntry } from "./lib/dashboard-kv-types.ts";

loadProjectEnv();

const POSTMASTER_DOMAIN = "clarice.ai";
/** Mesma janela das outras métricas da aba Rampa (HEALTH_SAMPLE_DAYS) — pedido do editor, 260730. */
const DEFAULT_WINDOW_DAYS = HEALTH_SAMPLE_DAYS;

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

/** Resultado de uma sondagem de `trafficStats.get` pra um dia: 404 (não publicado ainda), 200 (com ou sem o campo — ambos válidos, ver docstring do módulo), ou erro real de HTTP. */
export interface FetchStatsResult {
  status: number;
  body: TrafficStatsResponse | null;
  /** Corpo bruto (truncado) da resposta de erro, só quando `status` não é 200/404 — pro log distinguir a causa real. */
  errorText?: string;
}

/**
 * Pura/testável: extrai o ratio (0-1) de uma resposta 200 de `trafficStats.get`.
 * Campo AUSENTE vira `0` — não "dado insuficiente" (ver docstring do módulo,
 * achado 260730: confirmado contra a UI do Postmaster que ausência ==
 * serialização protobuf omitindo double no valor default).
 */
export function extractDayRatio(body: TrafficStatsResponse): number {
  return typeof body.userReportedSpamRatio === "number" ? body.userReportedSpamRatio : 0;
}

export interface DayReading {
  apiDate: string;
  ratio: number;
}

export interface CollectSpamReadingsResult {
  /** Uma entrada por dia com resposta 200 (com OU sem o campo — ambos contam), mais recente primeiro. */
  readings: DayReading[];
  daysChecked: number;
  /** Dias que retornaram um status de erro real (nem 200 nem 404) — NUNCA confundir com "não publicado ainda". */
  httpErrors: Array<{ apiDate: string; status: number; errorText?: string }>;
}

/**
 * Sonda `trafficStats.get` pelos últimos `windowDays` dias-calendário. Três
 * resultados por dia são tratados como coisas DIFERENTES (ver docstring do
 * módulo — misturar erro de HTTP com "sem dado" foi o bug original do
 * #4154; misturar "sem publicação" com "0% real" foi o bug corrigido em
 * 260730):
 *   - 404            → dia sem publicação ainda (esperado, silencioso, NUNCA vira 0%).
 *   - 200 (com/sem o campo) → leitura válida (campo ausente = 0%, ver extractDayRatio).
 *   - qualquer outro  → erro real (contabilizado em `httpErrors`, nunca ignorado em silêncio).
 */
export async function collectSpamReadings(
  windowDays: number,
  now: Date = new Date(),
  fetchStats: (apiDate: string) => Promise<FetchStatsResult>,
): Promise<CollectSpamReadingsResult> {
  const readings: DayReading[] = [];
  const httpErrors: CollectSpamReadingsResult["httpErrors"] = [];
  let daysChecked = 0;

  for (let offset = 0; offset < windowDays; offset++) {
    const d = new Date(now.getTime() - offset * 86_400_000);
    const apiDate = toApiDateStr(d);
    const { status, body, errorText } = await fetchStats(apiDate);
    daysChecked++;

    if (status === 404) continue;

    if (status === 200) {
      if (!body) continue; // defensivo — não deveria acontecer com status 200
      readings.push({ apiDate, ratio: extractDayRatio(body) });
      continue;
    }

    // Qualquer status que não seja 404 nem 200 é um erro real — nunca cai no
    // mesmo galho de "sem publicação ainda".
    httpErrors.push({ apiDate, status, errorText });
  }

  return { readings, daysChecked, httpErrors };
}

/**
 * Pura/testável: constrói o `PostmasterSpamEntry` a partir das leituras
 * coletadas — MÉDIA simples do ratio sobre os dias com leitura válida (não
 * ponderada por volume; a API não expõe volume por dia). `null` se não há
 * nenhuma leitura (nunca inventar uma média de zero elementos).
 *
 * NÃO assume nenhuma ordem em `readings` — acha o `apiDate` mais recente
 * explicitamente (`YYYYMMDD` ordena lexicograficamente = ordena
 * cronologicamente) em vez de confiar que `readings[0]` é o mais recente.
 * `collectSpamReadings` hoje entrega nessa ordem, mas essa função não deve
 * depender de um contrato implícito de outra função (achado convergente de
 * 2 agentes no self-review do #4345 — silent-failure-hunter e
 * type-design-analyzer): um refactor futuro que paralelize/reordene
 * `readings` corromperia `date` em silêncio (a média continuaria certa —
 * soma/contagem é comutativa — só `date` apontaria pro dia errado).
 */
export function buildAveragedEntry(readings: DayReading[], now: Date): PostmasterSpamEntry | null {
  if (readings.length === 0) return null;
  const avgRatio = readings.reduce((sum, r) => sum + r.ratio, 0) / readings.length;
  const mostRecent = readings.reduce((latest, r) => (r.apiDate > latest.apiDate ? r : latest), readings[0]);
  return {
    date: apiDateToEntryDate(mostRecent.apiDate),
    spamRatePct: avgRatio * 100,
    recordedAt: now.toISOString(),
    producedBy: "auto",
  };
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
 * Pura/testável: valida `--window-days`. Vazio usa o default
 * (HEALTH_SAMPLE_DAYS, mesma janela das outras métricas da Rampa); qualquer
 * valor não-numérico ou < 1 lança erro explícito (mesmo padrão de
 * `buildPostmasterSpamEntry` em postmaster-spam-entry.ts).
 */
export function parseWindowDaysArg(arg: string): number {
  if (arg.trim() === "") return DEFAULT_WINDOW_DAYS;
  const n = Number(arg);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`--window-days inválido: "${arg}" (esperado inteiro >= 1).`);
  }
  return n;
}

async function main(): Promise<void> {
  const isDryRun = hasFlag(process.argv, "dry-run");
  const windowArg = getArg(process.argv, "window-days");

  let windowDays: number;
  try {
    windowDays = parseWindowDaysArg(windowArg);
  } catch (e) {
    console.error(`[postmaster-spam-sync] ${(e as Error).message}`);
    process.exit(2);
    return;
  }

  const now = new Date();
  const { readings, daysChecked, httpErrors } = await collectSpamReadings(windowDays, now, fetchStatsFromApi);

  if (httpErrors.length > 0) {
    const detail = httpErrors.map((e) => `${e.apiDate}=${e.status}`).join(", ");
    if (httpErrors.length === daysChecked) {
      // TODOS os dias sondados falharam com erro de HTTP — não é "sem
      // publicação ainda", é uma falha real (credencial revogada, API
      // desabilitada de novo, quota, etc). Nunca disfarçar isso de "sem
      // dado" — propaga como erro (main().catch → exit 1).
      throw new Error(
        `todos os ${daysChecked} dias sondados falharam com erro HTTP (${detail}) — ` +
          `provável credencial revogada/API desabilitada/quota, NÃO "sem publicação ainda". ` +
          `Detalhe do último erro: ${httpErrors[httpErrors.length - 1].errorText ?? "(sem corpo)"}`,
      );
    }
    console.warn(
      `[postmaster-spam-sync] AVISO: ${httpErrors.length}/${daysChecked} dias sondados retornaram erro HTTP (${detail}), não 404/200. Prosseguindo com os dias restantes.`,
    );
  }

  const entry = buildAveragedEntry(readings, now);

  if (!entry) {
    // Achado do self-review do #4345 (silent-failure-hunter): esta branch
    // disparava pra 2 causas bem diferentes — janela inteira 404 (benigno,
    // "nada publicado ainda") OU uma mistura de erro HTTP + 404 sem nenhum
    // 200 (nem todos os dias erraram, então não bateu o throw acima, mas
    // também não sobrou nenhuma leitura real). A mensagem antiga dizia
    // "tudo 404" incondicionalmente, contradizendo o AVISO impresso alguns
    // segundos antes — quem lê só a última linha do log via cima do erro real.
    const cause = httpErrors.length > 0
      ? `${daysChecked - httpErrors.length} dias 404 (não publicado) + ${httpErrors.length} dias com erro HTTP — ver AVISO acima`
      : `todos os ${daysChecked} dias 404 (não publicado ainda)`;
    console.log(
      `[postmaster-spam-sync] Nenhuma leitura válida na janela (${cause}). ` +
        "NÃO escrevendo no KV — mantendo a última leitura válida (expira em 48h e vira indeterminate, nunca verde falso).",
    );
    return;
  }

  const daysDetail = readings.map((r) => `${apiDateToEntryDate(r.apiDate)}=${(r.ratio * 100).toFixed(3)}%`).join(", ");
  console.log(
    `[postmaster-spam-sync] média de ${readings.length}/${daysChecked} dias da janela: ${daysDetail}`,
  );
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
  // Achado do self-review do #4345 (silent-failure-hunter): a fração
  // readings/daysChecked e a contagem de erros HTTP também vão na linha
  // final de sucesso — não só no AVISO alguns segundos antes — porque essa é
  // a linha mais provável de ser a única lida num resumo de log/cron.
  const errorSuffix = httpErrors.length > 0 ? `, ${httpErrors.length} erros HTTP` : "";
  console.log(
    `[postmaster-spam-sync] KV atualizado: ${POSTMASTER_SPAM_KV_KEY} (spamRatePct=${entry.spamRatePct.toFixed(3)}, date=${entry.date}, média de ${readings.length}/${daysChecked} dias${errorSuffix}).`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[postmaster-spam-sync] erro:", e);
    process.exit(1);
  });
}
