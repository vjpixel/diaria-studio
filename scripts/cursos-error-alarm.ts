#!/usr/bin/env node
/**
 * cursos-error-alarm.ts (#4320, REDESENHADO no #4382)
 *
 * Lê 4 contadores cumulativos do KV `CURSOS_SUBSCRIBERS` do worker `cursos`
 * (ver `scripts/lib/shared/cursos-alarm-counters.ts` pras chaves — o worker
 * incrementa esses contadores nos mesmos pontos onde já loga via
 * `console.error`/`console.warn`/`console.log`), calcula o delta desde a
 * última checagem, avalia contra os limiares de
 * `scripts/lib/cursos-error-alarm.ts` (erro fatal — qualquer ocorrência — e
 * taxa de `?email= não confirmado`) e, se algo disparar, envia e-mail ao
 * editor via Gmail API (mesmo transporte de `clarice-guardrail-alarm.ts`,
 * `scripts/lib/gmail-send.ts`).
 *
 * ─── #4382: por que isto NÃO consulta mais a Cloudflare GraphQL Analytics API ──
 *
 * A versão original (#4320) consultava o dataset `workersInvocationsAdaptiveGroups`
 * e fazia grep de texto nas mensagens de log retornadas. CONFIRMADO AO VIVO
 * (credenciais Cloudflare reais) que esse campo não existe no schema exposto
 * — `unknown field "workersInvocationsAdaptiveGroups"`, mesmo numa query
 * mínima sem `logs{}`. Não é permissão (mensagem seria "not authorized"/
 * "forbidden"). A API pública GraphQL Analytics parece expor só métricas
 * AGREGADAS — não o conteúdo de mensagens de log individuais. Redesign
 * completo (ver docstring de `scripts/lib/cursos-error-alarm.ts`): o worker
 * agora conta os eventos ele mesmo, direto no KV; este script só LÊ os 4
 * contadores (leitura fetch-based via `getTextFromWorkerKV`, mesmo helper já
 * usado pelo Studio pra ler outros KVs Cloudflare — `scripts/lib/cloudflare-kv-upload.ts`,
 * #4165/#4173) e faz a lógica de delta/alarme em `scripts/lib/cursos-error-alarm.ts`.
 *
 * Uso:
 *   npx tsx scripts/cursos-error-alarm.ts [--dry-run] [--to email@x.com] [--rate-threshold-pct 90] [--namespace-id X]
 *
 *   --dry-run            avalia e imprime o que faria, mas NÃO envia e-mail
 *                         nem avança o cursor (idempotência) — inspeção sem
 *                         efeito colateral.
 *   --to                 override do destinatário (default: resolveEditorEmail).
 *   --rate-threshold-pct override do limiar da taxa (default: 90).
 *   --namespace-id        override do namespace KV (default: env CURSOS_KV_NAMESPACE_ID).
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID    obrigatório.
 *   CLOUDFLARE_WORKERS_TOKEN obrigatório — token com escopo de leitura/escrita
 *                            de Workers KV (MESMO token usado por
 *                            `scripts/lib/cloudflare-kv-upload.ts` em outros
 *                            scripts — ex: `clarice-engagement-cohorts.ts`).
 *                            Diferente da versão original (que exigia
 *                            `CLOUDFLARE_API_TOKEN` com escopo "Account
 *                            Analytics Read") — não há mais chamada à
 *                            Analytics API.
 *   CURSOS_KV_NAMESPACE_ID   id do namespace `CURSOS_SUBSCRIBERS` (o mesmo
 *                            usado por `scripts/sync-cursos-subscribers-kv.ts`
 *                            — ver `workers/cursos/wrangler.toml` `[[kv_namespaces]] id`).
 *   data/.credentials.json com o scope `gmail.send` (mesmo requisito de
 *                           `clarice-guardrail-alarm.ts`).
 *
 * Estado (idempotência): `data/cursos-error-alarm-state.json` — snapshot
 * cumulativo da última checagem (`lastCounters`), não cursor de tempo (ver
 * docstring de `scripts/lib/cursos-error-alarm.ts` §Idempotência).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { getTextFromWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { CURSOS_ALARM_COUNTER_KEYS } from "./lib/shared/cursos-alarm-counters.ts";
import {
  advanceState,
  evaluateCursosCounters,
  shouldAlarm,
  buildCursosAlarmEmail,
  emptyCursosAlarmState,
  alarmFindingsFor,
  DEFAULT_NOT_CONFIRMED_RATE_THRESHOLD_PCT,
  type CursosAlarmState,
  type CursosCounterSnapshot,
} from "./lib/cursos-error-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "cursos-error-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "cursos-error-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
/** #5339: task roda a cada 2h (`docs/cursos-worker-alarm-setup.md`) — 24
 * execuções limpas consecutivas = 48h sem o achado, mesmo horizonte de
 * tempo (não de contagem) dos alarmes diários deste lote (que usam 2
 * execuções = 48h numa cadência diária). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 24;

/** Pura: converte o valor cru lido do KV (string ou `null`, miss = "0") num
 * inteiro não-negativo. Nunca lança — corpo corrompido/negativo vira 0
 * (mesma filosofia fail-soft do resto do módulo: um contador ilegível não
 * pode travar o alarme inteiro). */
export function parseCounterValue(raw: string | null): number {
  if (raw === null) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Único ponto de I/O de rede do script — lê os 4 contadores via
 * `getTextFromWorkerKV` (fetch injetável, nunca rede real em teste). Cada
 * `getTextFromWorkerKV` já é fail-soft-por-status (404 → null), mas propaga
 * exceção em falha de rede/auth real — o caller (main) decide a política
 * (não avançar o cursor, reprocessar na próxima run).
 */
export async function fetchCurrentCounters(
  namespaceId: string,
  cfg: { accountId?: string; token?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<CursosCounterSnapshot> {
  const [fatalCookie, fatalBeehiiv, confirmed, notConfirmed] = await Promise.all([
    getTextFromWorkerKV(CURSOS_ALARM_COUNTER_KEYS.fatalCookieHmacSecretAusente, { kvNamespaceId: namespaceId, ...cfg }, fetchImpl),
    getTextFromWorkerKV(CURSOS_ALARM_COUNTER_KEYS.fatalCadastroBeehiivFalhou, { kvNamespaceId: namespaceId, ...cfg }, fetchImpl),
    getTextFromWorkerKV(CURSOS_ALARM_COUNTER_KEYS.emailGateConfirmed, { kvNamespaceId: namespaceId, ...cfg }, fetchImpl),
    getTextFromWorkerKV(CURSOS_ALARM_COUNTER_KEYS.emailGateNotConfirmed, { kvNamespaceId: namespaceId, ...cfg }, fetchImpl),
  ]);
  return {
    fatalCookieHmacSecretAusente: parseCounterValue(fatalCookie),
    fatalCadastroBeehiivFalhou: parseCounterValue(fatalBeehiiv),
    emailGateConfirmed: parseCounterValue(confirmed),
    emailGateNotConfirmed: parseCounterValue(notConfirmed),
  };
}

function loadState(): CursosAlarmState {
  if (!existsSync(STATE_PATH)) return emptyCursosAlarmState();
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    const lastCheckedAt = typeof raw?.lastCheckedAt === "string" || raw?.lastCheckedAt === null ? raw.lastCheckedAt : null;
    const lc = raw?.lastCounters;
    const isValidSnapshot =
      lc &&
      typeof lc.fatalCookieHmacSecretAusente === "number" &&
      typeof lc.fatalCadastroBeehiivFalhou === "number" &&
      typeof lc.emailGateConfirmed === "number" &&
      typeof lc.emailGateNotConfirmed === "number";
    return { lastCounters: isValidSnapshot ? (lc as CursosCounterSnapshot) : null, lastCheckedAt };
  } catch {
    return emptyCursosAlarmState();
  }
}

function saveState(state: CursosAlarmState): void {
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// ─── Estado (dedup/reconciliação de ISSUE por achado, #5339) ──────────────
// Arquivo separado de STATE_PATH de propósito — mesmo racional dos demais
// alarmes deste lote: idempotência do E-MAIL (acima) e tracking de ISSUE
// por achado são preocupações independentes.

function loadAlarmIssuesState(): AlarmIssuesState {
  if (!existsSync(ALARM_ISSUES_STATE_PATH)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(ALARM_ISSUES_STATE_PATH, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch {
    return emptyAlarmIssuesState();
  }
}

function saveAlarmIssuesState(state: AlarmIssuesState): void {
  writeFileAtomic(ALARM_ISSUES_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
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
  const workersToken = process.env.CLOUDFLARE_WORKERS_TOKEN ?? "";
  const namespaceId = getArg(process.argv, "namespace-id") || process.env.CURSOS_KV_NAMESPACE_ID || "";
  if (!accountId || !workersToken || !namespaceId) {
    console.error(
      "[cursos-error-alarm] CLOUDFLARE_ACCOUNT_ID e/ou CLOUDFLARE_WORKERS_TOKEN e/ou CURSOS_KV_NAMESPACE_ID (env ou --namespace-id) não definidos.",
    );
    process.exit(1);
    return;
  }

  const now = new Date();
  const state = loadState();

  let current: CursosCounterSnapshot;
  try {
    current = await fetchCurrentCounters(namespaceId, { accountId, token: workersToken });
  } catch (e) {
    console.error(
      `[cursos-error-alarm] erro ao ler contadores do KV Cloudflare — cursor NÃO avança, próxima execução recalcula o delta desde o último snapshot bem-sucedido: ${(e as Error).message}`,
    );
    process.exit(1);
    return;
  }

  const evaluation = evaluateCursosCounters(state, current, now, { rateThresholdPct });
  console.log(
    `[cursos-error-alarm] delta desde ${evaluation.since ?? "(1ª checagem, sem baseline)"}: ` +
      `${evaluation.fatalMatches.length} tipo(s) de erro fatal, taxa não-confirmado=${
        evaluation.rate.ratePct !== null ? evaluation.rate.ratePct.toFixed(1) + "%" : "n/a (amostra insuficiente)"
      } (${evaluation.rate.notConfirmed}/${evaluation.rate.total}). Contadores atuais: ${JSON.stringify(current)}.`,
  );

  // #5339 — reconcilia uma issue por achado (padrão fatal / taxa de
  // não-confirmado) ANTES de montar o e-mail, mesmo padrão de
  // hub-drift-check.ts/apoios-diff-alarm.ts. Roda toda execução não-dry-run,
  // independente de um e-mail novo disparar nesta rodada.
  const alarmFindings = alarmFindingsFor(evaluation);
  const alarmState = loadAlarmIssuesState();
  let issueRefs: Map<string, { issueNumber: number | null; url: string | null; action: string; error?: string }> | undefined;

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `[cursos-error-alarm] --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
  } else {
    const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    saveAlarmIssuesState(nextState);
    issueRefs = new Map(
      findingOutcomes.map((o) => [
        o.fingerprint,
        { issueNumber: o.issueNumber, url: o.url, action: o.action, error: o.error },
      ]),
    );
    for (const o of findingOutcomes) {
      if (o.action === "failed") {
        console.error(`[cursos-error-alarm] [${o.fingerprint}] issue não criada/reusada: ${o.error}`);
      } else {
        console.log(`[cursos-error-alarm] [${o.fingerprint}] issue #${o.issueNumber} (${o.action}): ${o.url}`);
      }
    }
  }

  if (shouldAlarm(evaluation)) {
    const { subject, body } = buildCursosAlarmEmail(evaluation, issueRefs);
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
    saveState(advanceState(current, now));
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
