#!/usr/bin/env npx tsx
/**
 * reschedule-worker-queue-post.ts (#6607)
 *
 * CLI de reagendamento ad-hoc de um post já enfileirado no Worker
 * `diaria-linkedin-cron` (LinkedIn/Instagram/Threads compartilham o mesmo
 * endpoint `/queue`, ver `scripts/lib/worker-queue-client.ts`).
 *
 * Substitui a técnica ad-hoc de "DELETE via curl + POST via curl" que
 * causou o incidente #6607: reagendamento de posts LinkedIn/Instagram
 * D1/D2 criou entradas DUPLICADAS na fila porque o DELETE não verificava
 * se a key original já tinha sido consumida (post já disparado — o cron
 * remove a entry do KV após postar) antes de re-enfileirar. Desta vez sem
 * impacto real (duplicatas detectadas e canceladas manualmente antes de
 * disparar), mas o risco existe pra futuras edições.
 *
 * Mecanismo (opção 2 da issue — mais simples que adicionar um endpoint
 * `GET /queue/:key` novo no Worker): chama `DELETE /queue/:key` via
 * `deleteFromWorkerQueue` e trata `404` como sinal de ABORTAR o
 * re-enqueue — não como "já deletado, segue o baile". Ver docstring de
 * `deleteFromWorkerQueue` para o detalhe do porquê 404 é ambíguo (post já
 * disparado vs. já cancelado antes) e por que isso nunca deve virar
 * silent-continue.
 *
 * Uso:
 *   npx tsx scripts/reschedule-worker-queue-post.ts \
 *     --key "queue:d1:260828" \
 *     --text "..." \
 *     --scheduled-at "2026-08-29T13:00:00Z" \
 *     --destaque d1 \
 *     --channel linkedin \
 *     [--image-url "https://..."] \
 *     [--image-urls "https://...,https://..."] \
 *     [--worker-url ...] [--token ...]
 *
 * `--worker-url`/`--token` são opcionais — default lê
 * `DIARIA_LINKEDIN_CRON_URL`/`DIARIA_LINKEDIN_CRON_TOKEN` do env (mesmo
 * par usado por `publish-linkedin.ts`/`publish-instagram.ts`/
 * `publish-threads.ts`).
 *
 * Exit codes:
 *   0 — reagendado com sucesso (delete + re-enqueue, ou key já não
 *       existia no lado antigo — impossível aqui, ver exit 3).
 *   1 — erro de uso (args faltando/inválidos), ou re-enqueue falhou APÓS o
 *       DELETE ter removido a entry antiga (#6702) — neste caso a mensagem
 *       "ATENÇÃO: a key X JÁ FOI DELETADA..." traz o payload completo pra
 *       re-enfileirar manualmente; NÃO re-rodar o script (o 2º DELETE bate
 *       404 e induz ao diagnóstico errado de "post já disparou").
 *   2 — Worker não configurado (sem URL/token).
 *   3 — DELETE retornou 404 (key já não existe na fila) — **re-enqueue
 *       ABORTADO de propósito**. Investigar se o post já disparou antes
 *       de rodar de novo (ex: checar `06-social-published.json` ou
 *       `GET /list` no Worker) — nunca re-rodar cegamente.
 */

import { deleteFromWorkerQueue, postToWorkerQueue, type WorkerQueuePayload } from "./lib/worker-queue-client.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { isMainModule } from "./lib/cli-args.ts";

loadProjectEnv();

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[name] = next;
        i++;
      } else {
        out[name] = "true";
      }
    }
  }
  return out;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);

  const key = args.key;
  const text = args.text;
  const scheduledAt = args["scheduled-at"];
  const destaque = args.destaque;
  const channel = args.channel as WorkerQueuePayload["channel"] | undefined;

  if (!key || !text || !scheduledAt || !destaque || !channel) {
    console.error(
      "Uso: reschedule-worker-queue-post.ts --key <queue:...> --text <...> " +
        "--scheduled-at <ISO> --destaque <d1|d2|d3|...> --channel <linkedin|instagram|threads> " +
        "[--image-url <url>] [--image-urls <url1,url2,...>] [--worker-url <url>] [--token <token>]",
    );
    return 1;
  }
  if (channel !== "linkedin" && channel !== "instagram" && channel !== "threads") {
    console.error(`Erro: --channel inválido: ${channel} (esperado linkedin|instagram|threads)`);
    return 1;
  }

  const workerUrl = args["worker-url"] ?? process.env.DIARIA_LINKEDIN_CRON_URL ?? "";
  const token = args.token ?? process.env.DIARIA_LINKEDIN_CRON_TOKEN ?? "";
  if (!workerUrl || !token) {
    console.error(
      "Erro: Worker não configurado. Passe --worker-url/--token ou " +
        "configure DIARIA_LINKEDIN_CRON_URL/DIARIA_LINKEDIN_CRON_TOKEN no env.",
    );
    return 2;
  }

  const del = await deleteFromWorkerQueue(workerUrl, token, key, "reschedule-worker-queue-post");
  if (del.alreadyGone) {
    console.error(
      `ABORTADO: key ${key} não existe mais na fila (404) — provavelmente já disparou. ` +
        "Re-enqueue NÃO executado para evitar entry duplicada. " +
        "Confirme o status real do post (06-social-published.json / GET /list no Worker) " +
        "antes de reagendar manualmente.",
    );
    return 3;
  }

  const payload: WorkerQueuePayload = {
    text,
    scheduled_at: scheduledAt,
    destaque,
    channel,
    image_url: args["image-url"] ?? null,
    image_urls: args["image-urls"] ? args["image-urls"].split(",").map((s) => s.trim()) : undefined,
  };

  let result;
  try {
    result = await postToWorkerQueue(workerUrl, token, payload, 2, "reschedule-worker-queue-post");
  } catch (err) {
    // #6702 — o DELETE já removeu a entry antiga: se o re-enqueue falhar e
    // morrermos com "Erro fatal: <msg do POST>" puro, a leitura natural do
    // operador é "falhou, nada mudou, rodo de novo" — e o 2º run bate 404 no
    // DELETE (exit 3, "confirme se o post já disparou"), apontando pra
    // hipótese errada enquanto o post some da fila. Relançar com o payload
    // completo transforma a perda silenciosa em perda VISÍVEL com caminho de
    // recuperação manual. (Inverter a ordem POST→DELETE foi considerado e
    // descartado: falha de DELETE após POST ok recria exatamente a duplicata
    // que o #6607 existe pra evitar, e o Worker não tem endpoint atômico.)
    const original = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ATENÇÃO: a key ${key} JÁ FOI DELETADA da fila e o re-enqueue falhou. ` +
        `Re-enfileire manualmente com este payload: ${JSON.stringify(payload)} — ` +
        `erro original: ${original}`,
    );
  }
  console.log(JSON.stringify({ deleted_old_key: key, reenqueued: result }, null, 2));
  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("Erro fatal:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
