/**
 * test/worker-retry-already-fired-14300.test.ts (#14300)
 *
 * Com a `idempotency_key` fixa por edição/canal/destaque no Instagram e no
 * Threads (#14010, #14242), o `--retry dN` sobre um post que o Worker já
 * disparou recebe 409 `already_fired`. `enqueueDailyWorkerPost` trata esse 409
 * como sucesso (`recovered: "already_fired"`), e os publishers gravavam
 * `status: "scheduled"` com `scheduled_at` no passado: nenhum post saía e o
 * store dizia que ia sair.
 *
 * 1. No `--retry`, o 409 `already_fired` vira `send_unknown` com a instrução
 *    de postar à mão (diária e carrossel semanal, Instagram e Threads).
 * 2. `isWorkerSendUnknownEntry` reconhece também o `send_unknown` gravado com
 *    `failure_reason` (DLQ do Worker e reconciliação de feed), para o aviso
 *    não mandar `--retry` de novo.
 *
 * Worker falso via `globalThis.fetch` (sem rede).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  WORKER_ALREADY_FIRED_REASON_PREFIX,
  dailyWorkerQueueIdempotencyKey,
  enqueueDailyWorkerPost,
  isRetryOverFiredKey,
  isWorkerSendUnknownEntry,
  workerRetryAlreadyFiredFailure,
} from "../scripts/lib/daily-worker-enqueue.ts";
import { decideResumeOrRetry } from "../scripts/lib/social-retry.ts";
import { decideThreadsDispatch, threadsSendUnknownWarnings } from "../scripts/publish-threads.ts";
import { sendUnknownInstagramHint } from "../scripts/publish-instagram.ts";
import { weeklySendUnknownHint, weeklyWorkerRetryAlreadyFiredEntry } from "../scripts/publish-weekly-social.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

const WORKER_KEY = "queue:2026-11-27T15:00:00.000Z:instagram-daily:261127:d2:main";

/** Worker falso: todo `POST /queue` responde 409 com `error` (corpo de `idempotentConflict`). */
function fakeWorker409(error: string) {
  let listCalls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request) => {
    const url = String(u);
    if (url.endsWith("/list")) {
      listCalls++;
      return new Response(JSON.stringify({ count: 0, items: [] }), { status: 200 });
    }
    if (url.endsWith("/queue")) {
      return new Response(JSON.stringify({ error, message: "já disparado", key: WORKER_KEY }), { status: 409 });
    }
    throw new Error(`fetch inesperado: ${url}`);
  }) as typeof fetch;
  return { listCalls: () => listCalls, restore: () => (globalThis.fetch = saved) };
}

/** Entry como a reconciliação de feed a grava (#13009): disparada pelo Worker, ausente do feed. */
function absentFromFeedEntry(platform: "instagram" | "threads", withWorkerKey = true): PostEntry {
  return {
    platform,
    destaque: "d2",
    url: null,
    status: "send_unknown",
    scheduled_at: "2026-11-27T15:00:00.000Z",
    previous_status: "published",
    failure_reason: "absent_from_feed: nenhum post do feed casa com o texto",
    ...(withWorkerKey && { worker_queue_key: WORKER_KEY }),
  };
}

describe("#14300 — --retry sobre chave já disparada não grava scheduled", () => {
  it("cenário da issue: send_unknown ausente do feed → --retry d2 → 409 already_fired → send_unknown com instrução manual", async () => {
    for (const platform of ["instagram", "threads"] as const) {
      for (const error of ["already_fired", "fire_in_progress"]) {
        const previous = absentFromFeedEntry(platform);
        // O --retry aceita refazer a entry (send_unknown é retryable).
        assert.equal(decideResumeOrRetry("d2", [previous], { skipExisting: true, retryIds: new Set(["d2"]) }).action, "dispatch");
        assert.equal(decideThreadsDispatch("d2", previous, { skipExisting: true, retryIds: new Set(["d2"]) }).action, "dispatch");

        const w = fakeWorker409(error);
        try {
          const ikey = dailyWorkerQueueIdempotencyKey(platform, "261127", "d2");
          const response = await enqueueDailyWorkerPost(
            "https://worker.test",
            "tok",
            { idempotency_key: ikey, text: "Legenda", image_url: null, scheduled_at: "2026-11-27T15:00:00.000Z", destaque: "d2", channel: platform },
            { logPrefix: "test", log: () => {} },
          );
          assert.equal(response.recovered, "already_fired");
          assert.equal(isRetryOverFiredKey(response, true), true, `${platform}/${error}: o --retry gravaria scheduled`);

          const entry: PostEntry = { platform, destaque: "d2", url: null, scheduled_at: null, ...workerRetryAlreadyFiredFailure(ikey, response.key) };
          assert.equal(entry.status, "send_unknown");
          assert.notEqual(entry.status, "scheduled");
          assert.equal(entry.scheduled_at, null);
          assert.equal(entry.worker_queue_key, WORKER_KEY);
          assert.ok(String(entry.reason).startsWith(WORKER_ALREADY_FIRED_REASON_PREFIX));
          assert.match(String(entry.reason), /postar à mão/);

          // A retomada pula a entry e o aviso não manda --retry de novo.
          assert.equal(decideResumeOrRetry("d2", [entry], { skipExisting: true, retryIds: null }).action, "skip-existing");
          assert.equal(isWorkerSendUnknownEntry(entry), true);
        } finally {
          w.restore();
        }
      }
    }
  });

  it("fora do --retry o 409 already_fired segue sucesso (re-run da Etapa 5 com a entry agendada)", () => {
    assert.equal(isRetryOverFiredKey({ key: WORKER_KEY, recovered: "already_fired" }, false), false);
    assert.equal(isRetryOverFiredKey({ key: WORKER_KEY }, true), false, "2xx no --retry enfileirou de verdade");
    assert.equal(isRetryOverFiredKey({ key: WORKER_KEY, recovered: "queue_lookup" }, true), false);
  });

  it("carrossel semanal: --retry instagram|threads sobre chave disparada grava send_unknown", () => {
    for (const platform of ["instagram", "threads"] as const) {
      const entry = weeklyWorkerRetryAlreadyFiredEntry(platform, "weekly-highlights", "26w48-highlights", WORKER_KEY);
      assert.equal(entry.status, "send_unknown");
      assert.equal(entry.scheduled_at, null);
      assert.match(String(entry.reason), new RegExp(`${platform}-weekly:26w48-highlights:main`));
      assert.match(weeklySendUnknownHint(platform, `${platform}/weekly-highlights`, entry), /postar à mão/);
      assert.doesNotMatch(weeklySendUnknownHint(platform, `${platform}/weekly-highlights`, entry), /rodar com --schedule --retry/);
    }
  });

  it("os quatro enqueues checam o --retry antes de gravar scheduled", () => {
    const daily = [
      ["../scripts/publish-instagram.ts", "await enqueueDailyWorkerPost(workerUrl, workerToken, {"],
      ["../scripts/publish-threads.ts", "await enqueueDailyWorkerPost(workerUrl, workerToken, {"],
    ] as const;
    for (const [file, anchor] of daily) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      const start = src.indexOf(anchor);
      assert.ok(start > 0, `${file}: enqueue não encontrado`);
      const tail = src.slice(start);
      const beforeScheduled = tail.slice(0, tail.indexOf('status: "scheduled"'));
      assert.match(beforeScheduled, /isRetryOverFiredKey\(response, retryIds\?\.has\(d\) \?\? false\)/, `${file}: sem a checagem do #14300`);
      assert.match(beforeScheduled, /workerRetryAlreadyFiredFailure\(idempotencyKey, response\.key\)/);
    }
    const weekly = readFileSync(new URL("../scripts/publish-weekly-social.ts", import.meta.url), "utf8");
    let from = 0;
    for (const channel of ["instagram", "threads"]) {
      const start = weekly.indexOf("response = await enqueueWeeklyWorkerCarousel(", from);
      assert.ok(start > 0, `semanal ${channel}: enqueue não encontrado`);
      const tail = weekly.slice(start);
      const beforeScheduled = tail.slice(0, tail.indexOf('status: "scheduled"'));
      assert.match(beforeScheduled, new RegExp(`isRetryOverFiredKey\\(response, retryChannels\\?\\.has\\("${channel}"\\)`), `semanal ${channel}: sem a checagem do #14300`);
      from = start + 1;
    }
  });
});

describe("#14300 — isWorkerSendUnknownEntry lê também failure_reason", () => {
  it("send_unknown ausente do feed (entry do Worker): aviso manual, sem --retry", () => {
    const ig = absentFromFeedEntry("instagram");
    assert.equal(isWorkerSendUnknownEntry(ig), true);
    assert.match(sendUnknownInstagramHint("d2", ig), /postar à mão/);
    assert.doesNotMatch(sendUnknownInstagramHint("d2", ig), /rodar com --retry/);

    const th = absentFromFeedEntry("threads");
    const warnings = threadsSendUnknownWarnings([th]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /postar à mão/);
    assert.doesNotMatch(warnings[0], /se refaz com --retry/);
  });

  it("send_unknown da DLQ do Worker (verify-social-worker-dispatch, failure_reason send_unknown:)", () => {
    const dlq: PostEntry = {
      platform: "instagram",
      destaque: "d1",
      url: null,
      status: "send_unknown",
      scheduled_at: "2026-11-27T21:00:00.000Z",
      worker_queue_key: WORKER_KEY,
      failure_reason: "send_unknown: timeout no media_publish",
    };
    assert.equal(isWorkerSendUnknownEntry(dlq), true);
  });

  it("sem worker_queue_key (publicação imediata) o --retry resolve: aviso segue mandando --retry", () => {
    const immediate = absentFromFeedEntry("instagram", false);
    assert.equal(isWorkerSendUnknownEntry(immediate), false);
    assert.match(sendUnknownInstagramHint("d2", immediate), /rodar com --retry d2/);
  });

  it("send_unknown comum (envio ambíguo sem marcador do Worker) e outros status não casam", () => {
    assert.equal(isWorkerSendUnknownEntry({ status: "send_unknown", reason: "timeout no threads_publish" }), false);
    assert.equal(isWorkerSendUnknownEntry({ ...absentFromFeedEntry("instagram"), status: "failed" }), false);
    assert.equal(isWorkerSendUnknownEntry(null), false);
  });
});
