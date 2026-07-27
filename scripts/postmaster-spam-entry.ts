#!/usr/bin/env node
/**
 * postmaster-spam-entry.ts (#4063)
 *
 * Registra a leitura MANUAL do `spamRate` diário do Google Postmaster Tools
 * (domínio `clarice.ai`, do parceiro) no KV do worker `clarice-dashboard` sob
 * a chave `postmaster:spam`. O worker consome esse valor com PRECEDÊNCIA
 * sobre `globalStats.complaints` da Brevo (que subconta o spam real em ~50×
 * — só enxerga feedback loops, e 73% da base é Gmail, cujo "marcar como
 * spam" não passa por FBL) — ver `resolveSpamSignal` em
 * `workers/brevo-dashboard/src/thresholds.ts`.
 *
 * Decisão do editor (#4063, sessão 260727): **sem acesso à API do Postmaster**
 * (o domínio é do parceiro, sem credencial disponível hoje) — esta é a
 * mitigação imediata: ~1min de checagem manual do painel antes de CADA envio.
 * A integração com `gmailpostmastertools.googleapis.com` fica pra uma issue
 * separada, bloqueada por credencial.
 *
 * Uso:
 *   npx tsx scripts/postmaster-spam-entry.ts --rate 1.02 [--date 2026-07-27] [--dry-run]
 *
 *   --rate PCT     obrigatório. spamRate (%) lido no painel do Postmaster
 *                  (Google Search Console → "Postmaster Tools" → clarice.ai →
 *                  Reclamações de spam). Ex: 1.02 para 1,02%.
 *   --date YYYY-MM-DD  opcional. Dia a que a leitura se refere (default: hoje,
 *                  data local). Informativo — quem decide a validade da
 *                  leitura é `recordedAt` (sempre "agora"), via
 *                  `POSTMASTER_STALE_MS` em thresholds.ts (48h).
 *   --dry-run      computa e imprime o JSON, mas NÃO grava no KV.
 *
 * Env:
 *   CLOUDFLARE_ACCOUNT_ID     obrigatório p/ upload KV
 *   CLOUDFLARE_WORKERS_TOKEN  obrigatório p/ upload KV (permissão Workers KV)
 */

import { uploadTextToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { DASHBOARD_KV_NAMESPACE_ID } from "./lib/dashboard-kv.ts";
import type { PostmasterSpamEntry } from "./lib/dashboard-kv-types.ts";
export type { PostmasterSpamEntry };

loadProjectEnv();

export { DASHBOARD_KV_NAMESPACE_ID };
export const POSTMASTER_SPAM_KV_KEY = "postmaster:spam";

/** YYYY-MM-DD local (não UTC) — o editor lê o painel "hoje", no fuso dele. */
function todayLocalDate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Monta o payload a partir dos args CLI já parseados. Pura/testável — separa
 * validação de negócio (rate obrigatório, numérico, faixa 0-100) do parsing
 * bruto de argv.
 */
export function buildPostmasterSpamEntry(
  rateArg: string,
  dateArg: string,
  now: Date = new Date(),
): PostmasterSpamEntry {
  const rate = Number(rateArg);
  if (rateArg.trim() === "" || !Number.isFinite(rate)) {
    throw new Error(`--rate inválido: "${rateArg}" não é um número.`);
  }
  if (rate < 0 || rate > 100) {
    throw new Error(`--rate fora da faixa esperada (0-100): ${rate}.`);
  }
  return {
    date: dateArg.trim() || todayLocalDate(now),
    spamRatePct: rate,
    recordedAt: now.toISOString(),
  };
}

async function main(): Promise<void> {
  const isDryRun = hasFlag(process.argv, "dry-run");
  const rateArg = getArg(process.argv, "rate");
  const dateArg = getArg(process.argv, "date");

  if (!rateArg) {
    console.error(
      "Uso: postmaster-spam-entry.ts --rate PCT [--date YYYY-MM-DD] [--dry-run]\n" +
        "Ex:  npx tsx scripts/postmaster-spam-entry.ts --rate 1.02",
    );
    process.exit(2);
  }

  let entry: PostmasterSpamEntry;
  try {
    entry = buildPostmasterSpamEntry(rateArg, dateArg);
  } catch (e) {
    console.error(`[postmaster-spam-entry] ${(e as Error).message}`);
    process.exit(1);
    return;
  }

  const json = JSON.stringify(entry, null, 2);
  console.log(`[postmaster-spam-entry] entrada: ${json}`);

  if (isDryRun) {
    console.log("[postmaster-spam-entry] --dry-run: não gravou no KV.");
    return;
  }

  await uploadTextToWorkerKV(json, POSTMASTER_SPAM_KV_KEY, {
    kvNamespaceId: DASHBOARD_KV_NAMESPACE_ID,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_WORKERS_TOKEN ?? "",
  });
  console.log(
    `[postmaster-spam-entry] KV atualizado: ${POSTMASTER_SPAM_KV_KEY} (spamRatePct=${entry.spamRatePct}, date=${entry.date}).`,
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[postmaster-spam-entry] erro:", e);
    process.exit(1);
  });
}
