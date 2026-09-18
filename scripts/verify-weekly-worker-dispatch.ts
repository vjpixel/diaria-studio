#!/usr/bin/env node
/**
 * verify-weekly-worker-dispatch.ts (#8310)
 *
 * Reconcilia os posts sociais da retrospectiva SEMANAL contra o Worker
 * Cloudflare `diaria-linkedin-cron` — o mesmo papel que
 * `verify-social-worker-dispatch.ts` cumpre pro diário, estendido pra
 * `data/weekly/{saturday}/06-weekly-published.json`.
 *
 * ## O problema (#8310)
 *
 * `verify-social-worker-dispatch.ts` só lê `data/editions/{AAMMDD}/...` — os
 * posts DIÁRIOS. A semanal (escrita por `publish-weekly-social.ts`) nunca foi
 * reconciliada: um DLQ do Worker (token expirado, erro de API, payload recusado
 * na hora do disparo) morria em silêncio, com o store local afirmando
 * `scheduled`. A #8303 fechou a causa específica do LinkedIn sem credencial
 * (o enqueue agora é recusado no Worker e o store grava `skipped`), mas cobre
 * SÓ UMA causa — qualquer outra continua invisível.
 *
 * ## Garantia por canal — idêntica ao diário
 *
 * - Instagram/Threads: `fired` do Worker é confirmação REAL de entrega
 *   (Graph API media_publish/threads_publish já respondeu com `id`).
 * - LinkedIn: `fired` é só aceite do webhook Make (fire-and-forget) —
 *   `verification_note` de confiança mais fraca, nunca a mesma dos outros dois.
 * - DLQ: falha real, qualquer canal, vira `failed` com `failure_reason`
 *   genérico apontando pra limitação conhecida do DLQ (motivo detalhado só nos
 *   logs do Cloudflare, ver #5766).
 *
 * ## Fail-soft
 *
 * Ausência de credenciais, Worker indisponível, JSON corrompido → warning +
 * exit 0, nunca bloqueia. Mesmo padrão de `verify-social-worker-dispatch.ts`
 * (0k).
 *
 * Uso:
 *   npx tsx scripts/verify-weekly-worker-dispatch.ts --saturday 260912
 *   npx tsx scripts/verify-weekly-worker-dispatch.ts --saturday 260912 --dry-run
 *
 * Requer: DIARIA_LINKEDIN_CRON_URL + DIARIA_LINKEDIN_CRON_TOKEN no env (ou
 * `publishing.social.linkedin.cloudflare_worker_url` em platform.config.json
 * pro URL). Ausência de credenciais é fail-soft — loga warning e sai 0.
 *
 * Output: atualiza in-place `data/weekly/{saturday}/06-weekly-published.json`.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveLinkedinWorkerUrl } from "./verify-social-worker-dispatch.ts";
import { resolveWeeklyPublishedPath, verifyWeeklyWorkerDispatch } from "./lib/weekly-worker-dispatch.ts";
import { notifyWeeklyDlqAlarm, evaluateWeeklyWorkerDlqAlarm } from "./lib/weekly-worker-dlq-alarm.ts";
import { parseArgs as parseArgsLib, isMainModule } from "./lib/cli-args.ts";

loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const args = parseArgsLib(process.argv.slice(2)).values;
  const saturday = args["saturday"];
  if (!saturday) {
    console.error("Uso: verify-weekly-worker-dispatch.ts --saturday <AAMMDD do sábado>");
    process.exit(1);
  }
  if (!/^\d{6}$/.test(saturday)) {
    console.error(`--saturday deve ser AAMMDD (ex: 260912), recebido: ${saturday}`);
    process.exit(1);
  }

  const publishedPath = resolveWeeklyPublishedPath(ROOT, saturday);
  if (!existsSync(publishedPath)) {
    console.log(
      `[verify-weekly-worker] nenhum 06-weekly-published.json em data/weekly/${saturday}/ — skip.`,
    );
    return;
  }

  const workerUrl = resolveLinkedinWorkerUrl();
  const workerToken = process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
  if (!workerUrl || !workerToken) {
    console.log(
      "[verify-weekly-worker] DIARIA_LINKEDIN_CRON_URL/TOKEN ausente — pulando reconciliação " +
        "(fail-soft, não bloqueia).",
    );
    return;
  }

  try {
    const published = JSON.parse(readFileSync(publishedPath, "utf8")) as {
      posts: unknown[];
    };
    const previousFailed = (published.posts as Array<{ status?: string }>).filter(
      (p) => p.status === "failed",
    ).length;
    const { updated, changes } = await verifyWeeklyWorkerDispatch(
      published as Parameters<typeof verifyWeeklyWorkerDispatch>[0],
      workerUrl,
      workerToken,
    );
    if (changes > 0) {
      writeFileSync(publishedPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
      const currentFailed = (updated.posts as Array<{ status?: string }>).filter(
        (p) => p.status === "failed",
      ).length;
      const alarm = evaluateWeeklyWorkerDlqAlarm(currentFailed, previousFailed);
      if (alarm.verdict === "alarm-new-dlq-entry") {
        await notifyWeeklyDlqAlarm(alarm.newEntries, previousFailed);
      }
      console.log(`[verify-weekly-worker] ${changes} post(s) atualizados em data/weekly/${saturday}/06-weekly-published.json`);
    } else {
      console.log("[verify-weekly-worker] nenhuma mudança de status detectada.");
    }
  } catch (e) {
    // Fail-soft: falha de rede/Worker indisponível não deve bloquear.
    console.warn(`[verify-weekly-worker] falhou (non-fatal): ${(e as Error).message}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}