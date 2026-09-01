#!/usr/bin/env node
/**
 * openrouter-billing-leak-check.ts (#6716 escopo 3)
 *
 * Guard de VAZAMENTO PAGO lido do billing do gateway OpenRouter — não da
 * tabela local. Lógica pura em `scripts/lib/openrouter-billing-leak.ts`
 * (leia o docblock de lá: explica por que a fonte tem que ser o gateway, e
 * por que este check é D-1 e não pós-tick).
 *
 * Resumo do que ele fecha: o detector que já existia
 * (`vazamento_pago`/`_is_leak` em `hermes/scripts/hermes-model-cost-report.py`,
 * rodado diariamente pelo `watch-continuo-health.sh`) diz "custo ok (sem
 * vazamento pago em 24h)" lendo `session_model_usage` — tabela onde as
 * chamadas do vazamento do #6716 NUNCA aparecem. Medido em 01/09/2026: zero
 * linhas de `anthropic/claude-sonnet-5` em todo o histórico da tabela,
 * contra US$ 1,21 + 0,39 + 0,96 cobrados pelo gateway em 29–31/08.
 *
 * Uso:
 *   npx tsx scripts/openrouter-billing-leak-check.ts             # avalia + persiste + alarma se achado NOVO
 *   npx tsx scripts/openrouter-billing-leak-check.ts --dry-run   # avalia + imprime, não persiste nem alarma
 *   npx tsx scripts/openrouter-billing-leak-check.ts --days 7    # janela (default 3)
 *   npx tsx scripts/openrouter-billing-leak-check.ts --to email@x
 *
 * Env: `OPENROUTER_MANAGEMENT_KEY` (Doppler/.env) pro endpoint de activity;
 * `data/.credentials.json` com scope `gmail.send` só quando há alarme a
 * enviar. Estado: `data/openrouter-billing-leak/state.json`.
 *
 * Exit codes: 0 = sem vazamento (ou dry-run); 1 = erro de execução;
 * **3 = vazamento encontrado** — distinto de 1 de propósito, pra um runner
 * poder tratar "achou" diferente de "quebrou" (mesma disciplina do exit 3 de
 * `check-pr-checks-gate.ts`).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  evaluateBillingLeak,
  shouldAlarmBillingLeak,
  advanceBillingLeakAlarmState,
  emptyBillingLeakAlarmState,
  buildBillingLeakAlarmEmail,
  type BillingRow,
  type BillingLeakAlarmState,
} from "./lib/openrouter-billing-leak.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "openrouter-billing-leak", "state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[openrouter-billing-leak]";
const ACTIVITY_URL = "https://openrouter.ai/api/v1/activity";
/** Exit code dedicado pra "achou vazamento" — nunca confundir com erro. */
export const LEAK_FOUND_EXIT_CODE = 3;

export function loadState(statePath: string = STATE_PATH): BillingLeakAlarmState {
  if (!existsSync(statePath)) return emptyBillingLeakAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<BillingLeakAlarmState>;
    const fp =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint
        : null;
    const at = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    return { lastAlarmedFingerprint: fp ?? null, lastCheckedAt: at ?? null };
  } catch {
    return emptyBillingLeakAlarmState();
  }
}

export function saveState(state: BillingLeakAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Normaliza a resposta do `/api/v1/activity` em `BillingRow[]`, descartando
 * o que não dá pra interpretar.
 *
 * Linha com `usage` não-numérico é DESCARTADA, nunca coagida pra 0: um `0`
 * fabricado aqui viraria "sem vazamento" — exatamente o falso "ok" que este
 * guard existe pra não repetir. O caller conta quantas foram descartadas e
 * trata isso como indeterminado, não como limpo.
 */
export function parseActivityRows(payload: unknown): { rows: BillingRow[]; skipped: number } {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return { rows: [], skipped: 0 };
  const rows: BillingRow[] = [];
  let skipped = 0;
  for (const item of data) {
    const o = item as Record<string, unknown>;
    const date = typeof o.date === "string" ? o.date : null;
    const model = typeof o.model === "string" ? o.model : null;
    const usage = typeof o.usage === "number" ? o.usage : Number(o.usage);
    const requests = typeof o.requests === "number" ? o.requests : Number(o.requests);
    if (!date || !model || !Number.isFinite(usage)) {
      skipped++;
      continue;
    }
    rows.push({ date, model, usageUsd: usage, requests: Number.isFinite(requests) ? requests : 0 });
  }
  return { rows, skipped };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getStringArg(argv, "to");
  const daysRaw = getStringArg(argv, "days");
  const days = daysRaw ? Number(daysRaw) : 3;
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`--days precisa ser um número positivo, recebido "${daysRaw}"`);
  }

  const key = process.env.OPENROUTER_MANAGEMENT_KEY;
  if (!key) {
    // Sem chave o guard não sabe NADA — nunca imprimir "ok" nesse estado.
    console.error(
      `${LOG_PREFIX} INDETERMINADO — OPENROUTER_MANAGEMENT_KEY ausente. Sem ela este guard não consegue ler o billing e NÃO pode afirmar que não há vazamento.`,
    );
    process.exitCode = 1;
    return;
  }

  const res = await fetch(ACTIVITY_URL, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    console.error(`${LOG_PREFIX} INDETERMINADO — activity respondeu HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }

  const { rows: allRows, skipped } = parseActivityRows(await res.json());
  if (skipped > 0) {
    console.error(`${LOG_PREFIX} ${skipped} linha(s) do activity descartada(s) por shape inválido — resultado é PARCIAL.`);
  }

  // Janela: o endpoint não cobre o dia corrente (~1 dia de consolidação),
  // então "últimos N dias" aqui é sempre N dias que TERMINAM ontem.
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const rows = allRows.filter((r) => r.date.slice(0, 10) >= cutoff);

  const evaluation = evaluateBillingLeak(rows);
  console.log(
    `${LOG_PREFIX} janela=${evaluation.daysCovered.join(",") || "(vazia)"} total=US$${evaluation.totalUsd.toFixed(4)} vazado=US$${evaluation.leakedUsd.toFixed(4)} achados=${evaluation.leaks.length}`,
  );
  for (const l of evaluation.leaks) {
    console.log(`${LOG_PREFIX}   ${l.date} ${l.model} — ${l.requests} req US$${l.usageUsd.toFixed(4)}`);
  }

  if (evaluation.daysCovered.length === 0) {
    console.error(
      `${LOG_PREFIX} INDETERMINADO — nenhuma linha na janela. Pode ser gasto zero de verdade OU o endpoint não ter consolidado; este guard não distingue, e não afirma "ok".`,
    );
    process.exitCode = 1;
    return;
  }

  const state = loadState();
  if (shouldAlarmBillingLeak(state, evaluation)) {
    const { subject, body } = buildBillingLeakAlarmEmail(evaluation, new Date());
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria pra ${to}:\n--- ${subject} ---\n${body}`);
    } else {
      // Sem try/catch — se o envio falhar, o cursor abaixo não avança e a
      // próxima execução tenta de novo, em vez de marcar como "já avisado"
      // sem o editor ter recebido nada (molde dos demais alarmes).
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
    }
  } else if (evaluation.leaks.length > 0) {
    console.log(`${LOG_PREFIX} vazamento já alarmado antes (mesmo conjunto) — sem e-mail novo.`);
  }

  if (!isDryRun) saveState(advanceBillingLeakAlarmState(evaluation, new Date()));
  if (evaluation.leaks.length > 0) process.exitCode = LEAK_FOUND_EXIT_CODE;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
