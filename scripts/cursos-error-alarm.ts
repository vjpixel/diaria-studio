#!/usr/bin/env node
/**
 * cursos-error-alarm.ts (#4320)
 *
 * Consulta a Cloudflare GraphQL Analytics API pelos logs do worker `cursos`
 * (dataset `workersInvocationsAdaptiveGroups`, filtrado por `scriptName` +
 * janela de tempo) desde o último cursor salvo, avalia contra os limiares de
 * `scripts/lib/cursos-error-alarm.ts` (erro fatal — qualquer ocorrência — e
 * taxa de `?email= não confirmado`) e, se algo disparar, envia e-mail ao
 * editor via Gmail API (mesmo transporte de `clarice-guardrail-alarm.ts`,
 * `scripts/lib/gmail-send.ts`).
 *
 * IMPORTANTE — schema da query não verificado ao vivo: esta sessão não tem
 * acesso a credenciais Cloudflare reais nem pode fazer chamada de rede
 * ao vivo (escopo do dispatch #4320). `CURSOS_LOGS_QUERY`/
 * `parseGraphqlLogsResponse` foram desenhados com base na documentação
 * pública da GraphQL Analytics API (dataset `workersInvocationsAdaptiveGroups`
 * + blog "Introducing Workers Observability" — invocação loga um JSON
 * estruturado com console.log() messages) mas o shape exato de `logs{}` por
 * grupo NÃO foi confirmado contra uma resposta real. Antes de confiar neste
 * alarme em produção: rodar `--dry-run` uma vez com credenciais reais e
 * conferir se `eventCount` bate com o volume esperado (não fica em 0 sempre)
 * — se a query não casar o schema real, ajustar só `CURSOS_LOGS_QUERY` +
 * `parseGraphqlLogsResponse` (a lógica de alarme em si, testada em
 * `test/cursos-error-alarm.test.ts`, não muda).
 *
 * Uso:
 *   npx tsx scripts/cursos-error-alarm.ts [--dry-run] [--to email@x.com] [--rate-threshold-pct 90]
 *
 *   --dry-run            avalia e imprime o que faria, mas NÃO envia e-mail
 *                         nem avança o cursor (idempotência) — inspeção sem
 *                         efeito colateral.
 *   --to                 override do destinatário (default: resolveEditorEmail).
 *   --rate-threshold-pct override do limiar da taxa (default: 90).
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID   obrigatório.
 *   CLOUDFLARE_API_TOKEN    obrigatório — precisa do escopo "Account
 *                           Analytics Read" (Workers Tail/Logs read), não é
 *                           necessariamente o mesmo token de
 *                           CLOUDFLARE_WORKERS_TOKEN (usado pra escrita KV
 *                           em outros scripts — permissões diferentes).
 *   data/.credentials.json com o scope `gmail.send` (mesmo requisito de
 *                           `clarice-guardrail-alarm.ts`).
 *
 * Estado (idempotência): `data/cursos-error-alarm-state.json` — cursor de
 * tempo (`lastCheckedUntil`), não lista de IDs (ver docstring de
 * `scripts/lib/cursos-error-alarm.ts` §Janela + idempotência).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  resolveWindow,
  advanceState,
  evaluateCursosLogs,
  shouldAlarm,
  buildCursosAlarmEmail,
  emptyCursosAlarmState,
  DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT,
  type CursosAlarmState,
  type CursosLogEvent,
} from "./lib/cursos-error-alarm.ts";

loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "cursos-error-alarm-state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");

export const CURSOS_SCRIPT_NAME = "cursos";
export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
/** Máximo de grupos de invocação retornados por consulta — worker de baixo tráfego, folga generosa. */
export const DEFAULT_QUERY_LIMIT = 1000;

// #4320: ver docstring do módulo — schema não verificado ao vivo. `logs {
// message level }` é o shape mais plausível pra "logs por grupo de
// invocação" descrito na doc pública da Workers Observability, mas pode
// precisar de ajuste contra uma resposta real.
export const CURSOS_LOGS_QUERY = `
query CursosWorkerLogs($accountTag: string!, $scriptName: string!, $since: Time!, $until: Time!, $limit: Int!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptiveGroups(
        limit: $limit
        filter: { scriptName: $scriptName, datetime_geq: $since, datetime_lt: $until }
        orderBy: [datetime_ASC]
      ) {
        dimensions {
          datetime
        }
        logs {
          message
          level
        }
      }
    }
  }
}`.trim();

export interface RawGraphqlLogLine {
  message?: string;
  level?: string;
}
export interface RawGraphqlInvocationGroup {
  dimensions?: { datetime?: string };
  logs?: RawGraphqlLogLine[];
}
export interface RawGraphqlLogsResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        workersInvocationsAdaptiveGroups?: RawGraphqlInvocationGroup[];
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

/**
 * Pura/testável: achata a resposta GraphQL em `CursosLogEvent[]`. Isola o
 * "schema não verificado" (ver docstring do módulo) numa única função — se o
 * shape real divergir, só esta função (e `CURSOS_LOGS_QUERY` acima)
 * precisam mudar; a lógica de alarme não depende do shape bruto da API.
 */
export function parseGraphqlLogsResponse(body: RawGraphqlLogsResponse): CursosLogEvent[] {
  const groups = body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptiveGroups ?? [];
  const events: CursosLogEvent[] = [];
  for (const g of groups) {
    const ts = g.dimensions?.datetime ?? new Date(0).toISOString();
    for (const log of g.logs ?? []) {
      if (typeof log.message === "string" && log.message.length > 0) {
        events.push({ timestamp: ts, message: log.message });
      }
    }
  }
  return events;
}

/** Único ponto de I/O de rede do script — injetável (`fetchImpl`) pra teste sem rede real. */
export async function fetchCursosLogEvents(
  accountId: string,
  apiToken: string,
  since: Date,
  until: Date,
  fetchImpl: typeof fetch = fetch,
  limit: number = DEFAULT_QUERY_LIMIT,
): Promise<CursosLogEvent[]> {
  const res = await fetchImpl(GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: CURSOS_LOGS_QUERY,
      variables: {
        accountTag: accountId,
        scriptName: CURSOS_SCRIPT_NAME,
        since: since.toISOString(),
        until: until.toISOString(),
        limit,
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Cloudflare GraphQL Analytics API falhou (${res.status}): ${text.slice(0, 500)}`);
  }
  const body = (await res.json()) as RawGraphqlLogsResponse;
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Cloudflare GraphQL retornou erro(s): ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return parseGraphqlLogsResponse(body);
}

function loadState(): CursosAlarmState {
  if (!existsSync(STATE_PATH)) return emptyCursosAlarmState();
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (typeof raw?.lastCheckedUntil === "string" || raw?.lastCheckedUntil === null) {
      return { lastCheckedUntil: raw.lastCheckedUntil };
    }
    return emptyCursosAlarmState();
  } catch {
    return emptyCursosAlarmState();
  }
}

function saveState(state: CursosAlarmState): void {
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

async function main(): Promise<void> {
  const isDryRun = hasFlag(process.argv, "dry-run");
  const toOverride = getArg(process.argv, "to");
  const thresholdArg = getArg(process.argv, "rate-threshold-pct");
  const rateThresholdPct = thresholdArg ? Number(thresholdArg) : DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT;
  if (!Number.isFinite(rateThresholdPct) || rateThresholdPct <= 0 || rateThresholdPct > 100) {
    console.error(`[cursos-error-alarm] --rate-threshold-pct inválido: "${thresholdArg}" (esperado 0 < x <= 100).`);
    process.exit(2);
    return;
  }

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) {
    console.error("[cursos-error-alarm] CLOUDFLARE_ACCOUNT_ID e/ou CLOUDFLARE_API_TOKEN não definidos.");
    process.exit(1);
    return;
  }

  const now = new Date();
  const state = loadState();
  const window = resolveWindow(state, now);

  let events: CursosLogEvent[];
  try {
    events = await fetchCursosLogEvents(accountId, apiToken, window.since, window.until);
  } catch (e) {
    console.error(
      `[cursos-error-alarm] erro ao consultar Cloudflare GraphQL Analytics API — cursor NÃO avança, próxima execução reprocessa esta janela: ${(e as Error).message}`,
    );
    process.exit(1);
    return;
  }

  const evaluation = evaluateCursosLogs(events, window, { rateThresholdPct });
  console.log(
    `[cursos-error-alarm] janela ${evaluation.since} → ${evaluation.until}: ${evaluation.eventCount} eventos de log, ` +
      `${evaluation.fatalMatches.length} match(es) fatal(is), taxa não-confirmado=${
        evaluation.rate.ratePct !== null ? evaluation.rate.ratePct.toFixed(1) + "%" : "n/a (amostra insuficiente)"
      } (${evaluation.rate.notConfirmed}/${evaluation.rate.total}).`,
  );

  if (shouldAlarm(evaluation)) {
    const { subject, body } = buildCursosAlarmEmail(evaluation);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`[cursos-error-alarm] --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      await sendGmailMessage(to, subject, body);
      console.log(`[cursos-error-alarm] e-mail de alarme enviado pra ${to}.`);
    }
  } else {
    console.log("[cursos-error-alarm] nenhuma condição de alarme disparou nesta janela.");
  }

  if (!isDryRun) {
    saveState(advanceState(window.until));
  } else {
    console.log("[cursos-error-alarm] --dry-run: cursor NÃO avançado.");
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[cursos-error-alarm] erro:", e);
    process.exit(1);
  });
}
