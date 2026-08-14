#!/usr/bin/env node
/**
 * scripts/measure-optin-confirmation-rate.ts (#5167 item 15)
 *
 * Item 15 da issue #5167 pede uma medição antes/depois da taxa de
 * confirmação do double opt-in (`pending` → `active`) — "sem baseline,
 * mudança de copy vira fé". O segmento Pending já é matéria-prima do canal
 * `brevo_diaria` (`fetchPendingBeehiivSubscriptions`, reusada aqui sem
 * duplicar paginação/retry/expand[]=custom_fields).
 *
 * ## Por que "taxa de confirmação" não é 1 número só, de 1 snapshot só
 *
 * `pending → active` é uma TRANSIÇÃO ao longo do tempo — não dá pra derivar
 * de uma foto única quantos confirmaram, só quantos ainda NÃO confirmaram
 * (quem já confirmou saiu do pool Pending faz tempo, sobrevivência
 * enviesada). Este script assume 2 papéis complementares, ambos
 * computáveis a partir de UM snapshot:
 *
 * 1. **Diagnóstico imediato (idade do backlog Pending):** usando
 *    `subscribedOn` (já trazido por `fetchPendingBeehiivSubscriptions`,
 *    #5183), classifica cada Pending em `fresh` (dentro da janela de graça,
 *    ainda pode confirmar a qualquer momento — não conta contra a taxa) ou
 *    `stale` (mais velho que `staleThresholdDays`, efetivamente "perdido" —
 *    Smart Nudge já reenviou e a pessoa não abriu). `confirmationRateEstimate
 *    = totalActive / (totalActive + stalePending)` é a melhor aproximação
 *    de 1-snapshot-só: trata todo Pending "stale" como não-confirmado
 *    definitivo, e ignora `fresh`/`unknownAge` do denominador (inconclusivos).
 * 2. **Série temporal (rodar de novo depois):** cada execução com `--push`
 *    acrescenta uma linha a `data/optin-confirmation-rate/log.jsonl`.
 *    `computeDeltaBetweenSnapshots` compara duas linhas e reporta a
 *    variação de `stalePending` — se cair (ou crescer mais devagar que
 *    `totalPending`) depois da mudança de copy/routing (#5167 itens 1-8),
 *    é sinal de melhora; se ficar igual ou pior, a mudança não funcionou.
 *
 * ## Confound documentado (NÃO ignorar ao interpretar `deltaActive`)
 *
 * Desde o #5095, formulários próprios (`workers/poll`, `workers/cursos`,
 * `workers/reativar`) mandam `double_opt_override: "off"` — cadastro entra
 * `active` DIRETO, nunca passa por `pending`. Só o formulário hospedado na
 * Beehiiv (`/subscribe`) gera `pending`. Ou seja, `deltaActive` entre dois
 * snapshots mistura confirmações reais de Pending COM cadastros novos via
 * formulário próprio (que nunca foram Pending) — não é um sinal limpo de
 * confirmação sozinho. `deltaStalePending` é o sinal mais limpo: só reflete
 * o que aconteceu (ou não) com quem já estava no funil de confirmação.
 *
 * ## Guard de publicação (overnight/develop)
 *
 * Este script só LÊ a Beehiiv (`GET /subscriptions`, nunca escreve) — mas a
 * regra do dispatch overnight/develop é "nunca tocar Beehiiv ao vivo, nem
 * em teste", sem exceção pra leitura. Nenhuma chamada real rodou nesta
 * unidade; só testado via `fetchImpl` mockado. Rodar a 1ª vez (baseline)
 * fica pro editor ou uma sessão com a credencial liberada — depois disso,
 * repetir periodicamente (ex: semanal, mesmo cron do `Diaria-Beehiiv-Backup`
 * se o editor quiser automatizar) pra alimentar a série temporal.
 *
 * ## Uso
 *
 *   npx tsx scripts/measure-optin-confirmation-rate.ts                  # dry-run, só imprime
 *   npx tsx scripts/measure-optin-confirmation-rate.ts --push           # grava no log JSONL
 *   npx tsx scripts/measure-optin-confirmation-rate.ts --push --label "pos-item-8"
 *   npx tsx scripts/measure-optin-confirmation-rate.ts --stale-days 14  # muda o limiar de "perdido"
 *
 * Env: BEEHIIV_API_KEY (leitura). Nunca escreve na Beehiiv.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBeehiivConfig, beehiivApiBase } from "./lib/beehiiv-config.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { fetchPendingBeehiivSubscriptions, type BeehiivPendingSubscription } from "./sync-pending-to-brevo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_LOG_PATH = resolve(ROOT, "data/optin-confirmation-rate/log.jsonl");

/** Limiar padrão (dias) pra classificar um Pending como "stale" (efetivamente
 * perdido) em vez de "fresh" (ainda dentro da janela de graça — Smart Nudge
 * costuma reenviar em poucos dias, então uma semana é folga suficiente pra
 * não confundir "ainda não abriu o e-mail" com "desistiu"). Sem número do
 * editor nesta unidade — valor conservador, overridável via `--stale-days`. */
export const DEFAULT_STALE_THRESHOLD_DAYS = 7;

// ── idade do backlog Pending (pura) ─────────────────────────────────────────

export interface PendingAgeBuckets {
  /** subscribedOn conhecido E idade < staleThresholdDays — ainda inconclusivo. */
  fresh: number;
  /** subscribedOn conhecido E idade >= staleThresholdDays — efetivamente perdido. */
  stale: number;
  /** subscribedOn ausente/não reconhecido — não entra em fresh nem stale. */
  unknownAge: number;
}

/**
 * Pura — classifica cada Pending por idade relativa a `now`. `subscribedOn`
 * vazio (`""`, ver `normalizeSubscribedOn` em `sync-pending-to-brevo.ts`)
 * conta como `unknownAge`, nunca como fresh nem stale (dado ausente não deve
 * silenciosamente virar "confirmação perdida").
 */
export function bucketPendingByAge(
  pendingSubs: BeehiivPendingSubscription[],
  now: Date,
  staleThresholdDays: number = DEFAULT_STALE_THRESHOLD_DAYS,
): PendingAgeBuckets {
  const thresholdMs = staleThresholdDays * 24 * 60 * 60 * 1000;
  const buckets: PendingAgeBuckets = { fresh: 0, stale: 0, unknownAge: 0 };
  for (const sub of pendingSubs) {
    if (!sub.subscribedOn) {
      buckets.unknownAge++;
      continue;
    }
    const subscribedAt = new Date(sub.subscribedOn).getTime();
    if (Number.isNaN(subscribedAt)) {
      buckets.unknownAge++;
      continue;
    }
    const ageMs = now.getTime() - subscribedAt;
    if (ageMs >= thresholdMs) buckets.stale++;
    else buckets.fresh++;
  }
  return buckets;
}

// ── snapshot (pura) ──────────────────────────────────────────────────────────

export interface ConfirmationSnapshot {
  timestamp: string;
  label: string;
  totalActive: number;
  totalPending: number;
  freshPending: number;
  stalePending: number;
  unknownAgePending: number;
  staleThresholdDays: number;
  /** null quando totalActive + stalePending === 0 (sem dado suficiente pra estimar). */
  confirmationRateEstimate: number | null;
}

/**
 * Pura — monta o snapshot a partir de contagens já obtidas (nenhuma chamada
 * de rede aqui, ver `fetchConfirmationSnapshot` pro caminho impuro).
 * `confirmationRateEstimate` só considera `totalActive` e `stalePending` no
 * denominador (ver docstring do módulo) — `freshPending`/`unknownAgePending`
 * ficam de fora por serem inconclusivos.
 */
export function computeConfirmationSnapshot(
  totalActive: number,
  pendingSubs: BeehiivPendingSubscription[],
  now: Date = new Date(),
  label = "",
  staleThresholdDays: number = DEFAULT_STALE_THRESHOLD_DAYS,
): ConfirmationSnapshot {
  const ageBuckets = bucketPendingByAge(pendingSubs, now, staleThresholdDays);
  const denominator = totalActive + ageBuckets.stale;
  return {
    timestamp: now.toISOString(),
    label,
    totalActive,
    totalPending: pendingSubs.length,
    freshPending: ageBuckets.fresh,
    stalePending: ageBuckets.stale,
    unknownAgePending: ageBuckets.unknownAge,
    staleThresholdDays,
    confirmationRateEstimate: denominator > 0 ? totalActive / denominator : null,
  };
}

// ── delta entre 2 snapshots (pura) ──────────────────────────────────────────

export interface ConfirmationDelta {
  fromTimestamp: string;
  toTimestamp: string;
  deltaActive: number;
  deltaPending: number;
  deltaStalePending: number;
  /** Nota fixa lembrando o confound de #5095 — sempre presente, nunca deixa
   * o consumidor interpretar deltaActive como "confirmações" sem contexto. */
  note: string;
}

const DELTA_NOTE =
  "deltaActive mistura confirmações reais de Pending com cadastros novos via formulário próprio " +
  "(#5095: workers/poll, workers/cursos e workers/reativar entram direto em active, nunca passam por pending). " +
  "deltaStalePending é o sinal mais limpo de melhora/piora na confirmação.";

/** Pura — compara dois snapshots (ordem não importa, `from`/`to` resolvidos por timestamp). */
export function computeDeltaBetweenSnapshots(a: ConfirmationSnapshot, b: ConfirmationSnapshot): ConfirmationDelta {
  const [from, to] = new Date(a.timestamp).getTime() <= new Date(b.timestamp).getTime() ? [a, b] : [b, a];
  return {
    fromTimestamp: from.timestamp,
    toTimestamp: to.timestamp,
    deltaActive: to.totalActive - from.totalActive,
    deltaPending: to.totalPending - from.totalPending,
    deltaStalePending: to.stalePending - from.stalePending,
    note: DELTA_NOTE,
  };
}

// ── log JSONL (I/O) ──────────────────────────────────────────────────────────

/** Lê o último snapshot gravado no log, `null` se o arquivo não existir/estiver
 * vazio ou se a última linha não parsear (fail-soft — nunca lança, este log
 * é auxiliar de diagnóstico, não crítico de pipeline). */
export function readLatestSnapshot(logPath: string = DEFAULT_LOG_PATH): ConfirmationSnapshot | null {
  if (!existsSync(logPath)) return null;
  const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]) as ConfirmationSnapshot;
  } catch {
    return null;
  }
}

/** Acrescenta 1 linha JSONL ao log, criando o diretório se necessário. */
export function appendSnapshotToLog(snapshot: ConfirmationSnapshot, logPath: string = DEFAULT_LOG_PATH): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(snapshot) + "\n", "utf8");
}

// ── leitura da Beehiiv (impura) ──────────────────────────────────────────────

interface CountPage {
  total_results?: number;
}

/**
 * Contagem barata de assinantes por status — `per_page=1` só pra ler
 * `total_results` da 1ª página, sem paginar a lista inteira (diferente de
 * `fetchPendingBeehiivSubscriptions`, que precisa da lista completa pro
 * `subscribedOn` de cada um). Lança se `total_results` vier ausente — sem
 * esse campo não há contagem confiável, e reportar `0` silenciosamente
 * seria pior que falhar alto.
 */
export async function fetchTotalCountByStatus(
  publicationId: string,
  apiKey: string,
  status: "active" | "pending",
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const res = await fetchImpl(
    `${beehiivApiBase()}/publications/${publicationId}/subscriptions?status=${status}&per_page=1`,
    { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
  );
  if (!res.ok) {
    throw new Error(`Beehiiv API ${res.status} em /subscriptions?status=${status}&per_page=1`);
  }
  const body = (await res.json()) as CountPage;
  if (body.total_results == null) {
    throw new Error(`/subscriptions?status=${status}&per_page=1 não retornou total_results`);
  }
  return body.total_results;
}

/** Orquestra as 2 leituras (contagem active + lista pending completa) e monta o snapshot. */
export async function fetchConfirmationSnapshot(
  publicationId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
  label = "",
  staleThresholdDays: number = DEFAULT_STALE_THRESHOLD_DAYS,
): Promise<ConfirmationSnapshot> {
  const [totalActive, pendingSubs] = await Promise.all([
    fetchTotalCountByStatus(publicationId, apiKey, "active", fetchImpl),
    fetchPendingBeehiivSubscriptions(publicationId, apiKey, fetchImpl),
  ]);
  return computeConfirmationSnapshot(totalActive, pendingSubs, now, label, staleThresholdDays);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const push = flags.has("push");
  const label = values.label ?? "";
  const staleDays = values["stale-days"] ? Number(values["stale-days"]) : DEFAULT_STALE_THRESHOLD_DAYS;
  if (!Number.isFinite(staleDays) || staleDays <= 0) {
    process.stderr.write(`[measure-optin-confirmation-rate] --stale-days inválido: ${values["stale-days"]}\n`);
    process.exit(2);
  }

  const config = loadBeehiivConfig("[measure-optin-confirmation-rate]");
  const snapshot = await fetchConfirmationSnapshot(
    config.publicationId,
    config.apiKey,
    fetch,
    new Date(),
    label,
    staleDays,
  );

  const previous = readLatestSnapshot();
  process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
  if (previous) {
    const delta = computeDeltaBetweenSnapshots(previous, snapshot);
    process.stdout.write("\n--- delta vs. snapshot anterior ---\n");
    process.stdout.write(JSON.stringify(delta, null, 2) + "\n");
  }

  if (push) {
    appendSnapshotToLog(snapshot);
    process.stdout.write(`\n[measure-optin-confirmation-rate] gravado em ${DEFAULT_LOG_PATH}\n`);
  } else {
    process.stdout.write(`\n[measure-optin-confirmation-rate] dry-run — rode com --push pra gravar no log.\n`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[measure-optin-confirmation-rate] ${(err as Error).message}\n`);
    process.exit(1);
  });
}
