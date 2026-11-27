/**
 * test/worker-send-unknown-weekly-retro-14251-14252.test.ts (#14251, #14252)
 *
 * Follow-up da #14243 (409 `send_unknown` do Worker no enqueue idempotente):
 *
 * - #14251: `publish-weekly-social` (carrossel de Instagram/Threads) e
 *   `publish-retrospectiva-social` gravavam `failed` quando o enqueue lançava
 *   `DailyWorkerSendUnknownError` — o estado que "prova que nada saiu", com o
 *   post possivelmente no ar. Agora gravam `send_unknown` pelo mesmo helper da
 *   diária (`dailyWorkerEnqueueFailure`), e a retomada pula a entry.
 * - #14252: a retomada de `publish-instagram`/`publish-threads` (e do semanal)
 *   mandava rodar `--retry dN` para esse `send_unknown`, que devolve o mesmo
 *   409. Agora o aviso orienta a conferir o perfil e postar à mão.
 *
 * Worker falso injetado (`deps.post`) ou dispatcher mockado. Sem rede.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DailyWorkerSendUnknownError,
  WORKER_SEND_UNKNOWN_REASON_PREFIX,
  dailyWorkerEnqueueFailure,
  isWorkerSendUnknownEntry,
  workerSendUnknownManualHint,
} from "../scripts/lib/daily-worker-enqueue.ts";
import { WorkerQueueError } from "../scripts/lib/worker-queue-client.ts";
import {
  decideWeeklyChannelDispatch,
  enqueueWeeklyWorkerCarousel,
  weeklySendUnknownHint,
  weeklyWorkerEnqueueFailureEntry,
} from "../scripts/publish-weekly-social.ts";
import {
  retrospectivaSocialPublishedPath,
  runRetrospectivaSocialDispatch,
  type HistoriaImages,
  type RunRetrospectivaSocialOptions,
} from "../scripts/publish-retrospectiva-social.ts";
import { sendUnknownInstagramHint } from "../scripts/publish-instagram.ts";
import { threadsSendUnknownWarnings } from "../scripts/publish-threads.ts";
import { retrospectivaPublicCtaCurto } from "../scripts/lib/mensal/retrospectiva-social.ts";
import { resolveRetrospectivaPostScheduledAts } from "../scripts/lib/mensal/retrospectiva-schedule.ts";
import { readSocialPublished, type PostEntry } from "../scripts/lib/social-published-store.ts";

process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";

const WORKER_KEY = "queue:2030-01-05T22:00:00.000Z:instagram-weekly:w1:main";

/** Corpo literal que o Worker devolve no 409 (`idempotentConflict`, index.ts). */
function sendUnknown409(): WorkerQueueError {
  return new WorkerQueueError(
    409,
    JSON.stringify({ error: "send_unknown", message: "o disparo deste pedido terminou ambíguo", key: WORKER_KEY }),
  );
}

/** Entry `send_unknown` como o publisher a grava a partir do 409. */
function workerSendUnknownEntry(platform: "instagram" | "threads", destaque: string): PostEntry {
  const failure = dailyWorkerEnqueueFailure(new DailyWorkerSendUnknownError(`${platform}-daily:261127:${destaque}:main`, WORKER_KEY));
  return { platform, destaque, url: null, scheduled_at: null, ...failure };
}

describe("#14251 — semanal: 409 send_unknown do Worker grava send_unknown, nunca failed", () => {
  it("enqueueWeeklyWorkerCarousel lança DailyWorkerSendUnknownError e a entry sai send_unknown com a key do Worker", async () => {
    for (const channel of ["instagram", "threads"] as const) {
      let posts = 0;
      const err = await enqueueWeeklyWorkerCarousel(
        "https://worker.test",
        "tok",
        {
          channel,
          carouselKey: "w1",
          text: "Os destaques da semana.",
          carouselImageUrls: ["https://cdn/w/1.jpg", "https://cdn/w/2.jpg"],
          scheduledAt: "2030-01-05T22:00:00.000Z",
          destaque: "highlights",
        },
        {
          post: async () => {
            posts++;
            throw sendUnknown409();
          },
          lookup: async () => assert.fail("409 send_unknown não consulta a fila"),
          log: () => {},
        },
      ).then(
        () => assert.fail("409 send_unknown não é sucesso"),
        (e: unknown) => e,
      );
      assert.ok(err instanceof DailyWorkerSendUnknownError, `${channel}: esperava DailyWorkerSendUnknownError, veio ${String(err)}`);
      assert.equal(posts, 1);

      const entry = weeklyWorkerEnqueueFailureEntry(channel, "highlights", err);
      assert.equal(entry.status, "send_unknown", `${channel}: 409 send_unknown virou ${entry.status}`);
      assert.equal(entry.worker_queue_key, WORKER_KEY);
      assert.match(String(entry.reason), /pode estar no ar/);

      // A retomada semanal pula a entry (não redespacha o carrossel).
      const plan = decideWeeklyChannelDispatch([entry], "highlights", [], { skipExisting: true, retryChannels: null });
      assert.equal(plan[channel].action, "skip-existing", `${channel}: a retomada redespacharia um send_unknown`);
    }
  });

  it("4xx de validação e erro comum seguem failed", () => {
    const bad = weeklyWorkerEnqueueFailureEntry("instagram", "highlights", new WorkerQueueError(400, JSON.stringify({ error: "bad" })));
    assert.equal(bad.status, "failed");
    assert.equal(weeklyWorkerEnqueueFailureEntry("threads", "highlights", new Error("timeout")).status, "failed");
  });

  it("os dois catch do enqueue semanal gravam pelo helper, sem status failed fixo", () => {
    const src = readFileSync(new URL("../scripts/publish-weekly-social.ts", import.meta.url), "utf8");
    let from = 0;
    for (const channel of ["instagram", "threads"]) {
      const start = src.indexOf("response = await enqueueWeeklyWorkerCarousel(", from);
      assert.ok(start > 0, `enqueue ${channel} não encontrado`);
      const tail = src.slice(start);
      const catchBlock = tail.slice(tail.indexOf("} catch (e: any) {"), tail.indexOf("if (response)"));
      assert.match(catchBlock, new RegExp(`weeklyWorkerEnqueueFailureEntry\\("${channel}"`), `${channel}: catch sem o helper do #14251`);
      assert.doesNotMatch(catchBlock, /status: "failed"/, `${channel}: catch ainda grava failed fixo`);
      from = start + 1;
    }
  });
});

describe("#14251 — Retrospectiva: 409 send_unknown do Worker não vira failed no store", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "retro-14251-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  const NOW = Date.parse("2030-01-05T12:00:00Z");
  const CONFIG = {
    publishing: {
      social: {
        timezone: "America/Sao_Paulo",
        fallback_schedule: { d1_time: "10:00", d2_time: "12:30", d3_time: "17:30", day_offset: 0 },
      },
    },
  };
  const SCHEDULE = resolveRetrospectivaPostScheduledAts(CONFIG, { baseDate: "2030-01-12", now: NOW });
  const P1 = "Em setembro, pesquisadores acharam mais de 15 mil edições feitas por agentes num site alemão.";
  const P2 = "Em parte das mensagens, os próprios bots combinavam como contornar as regras da empresa que os criou.";
  const P3 = "A Retrospectiva de Setembro conta o resto. Arquivo em https://diar.ia.br/p/arquivo agora.";
  const CORPO = `${P1}\n\n${P2}\n\n${P3}\n`;
  const CURTO = `Agentes fizeram 15 mil edições num site alemão. A retrospectiva conta o resto.\n\n${retrospectivaPublicCtaCurto("2609-10")}\n`;
  const cards = (h: string) => ({
    cover: `https://img/${h}-cover.jpg`,
    p1: `https://img/${h}-p1.jpg`,
    p2: `https://img/${h}-p2.jpg`,
    p3: `https://img/${h}-p3.jpg`,
    cta: `https://img/${h}-cta.jpg`,
  });

  function opts(worker: () => Promise<PostEntry>): RunRetrospectivaSocialOptions {
    return {
      cycle: "2609-10",
      cycleDir: tmp,
      posts: ["instagram:d1"],
      texts: { d1: { corpo: CORPO, curto: CURTO } },
      titles: { d1: "Agentes saem do teste e invadem governos" },
      resolveScheduledAts: () => SCHEDULE,
      prepareImages: async (hs) => Object.fromEntries(hs.map((h) => [h, { cards: cards(h), pendingUpload: false } satisfies HistoriaImages])),
      force: new Set(),
      dryRun: false,
      disabled: {},
      xChannelId: "buffer-x",
      missingCredentials: {},
      facebookPages: [],
      dispatchers: {
        linkedin: async () => { throw new Error("não usado"); },
        facebook: async () => { throw new Error("não usado"); },
        worker,
        cancelWorker: async () => ({ alreadyGone: false }),
      },
      now: NOW,
    };
  }

  it("1ª execução: store send_unknown (não failed); 2ª: pulado, sem novo enqueue", async () => {
    let calls = 0;
    const worker = async (): Promise<PostEntry> => {
      calls++;
      throw new DailyWorkerSendUnknownError("instagram-retrospectiva:2609-10:d1:main", WORKER_KEY);
    };
    const r1 = await runRetrospectivaSocialDispatch(opts(worker));
    const ig1 = r1.results.find((x) => x.channel === "instagram");
    assert.equal(ig1?.action, "failed", "sai como falha no resumo (exit != 0, o editor confere)");
    if (ig1?.action === "failed") assert.match(ig1.reason, /^send_unknown:/);
    const store = readSocialPublished(retrospectivaSocialPublishedPath(tmp, "d1"));
    const ig = store.posts.filter((p) => p.platform === "instagram");
    assert.equal(ig.map((p) => p.status).join(","), "send_unknown", "store gravaria failed com o post possivelmente no ar");
    assert.equal(ig[0]?.worker_queue_key, WORKER_KEY);
    assert.equal(calls, 1);

    const r2 = await runRetrospectivaSocialDispatch(opts(worker));
    assert.equal(r2.results.find((x) => x.channel === "instagram")?.action, "skipped", "send_unknown no store segura a reexecução");
    assert.equal(calls, 1, "nenhum 2º enqueue na reexecução");
  });

  it("controle: erro comum do Worker segue failed no store", async () => {
    const r = await runRetrospectivaSocialDispatch(opts(async () => { throw new Error("Worker queue HTTP 400: bad"); }));
    assert.equal(r.results.find((x) => x.channel === "instagram")?.action, "failed");
    const store = readSocialPublished(retrospectivaSocialPublishedPath(tmp, "d1"));
    assert.equal(store.posts.filter((p) => p.platform === "instagram").map((p) => p.status).join(","), "failed");
  });
});

describe("#14252 — aviso da retomada não manda --retry no send_unknown do 409 do Worker", () => {
  it("o reason gravado começa pelo prefixo e é reconhecido; o send_unknown comum não", () => {
    const e = workerSendUnknownEntry("instagram", "d1");
    assert.ok(String(e.reason).startsWith(WORKER_SEND_UNKNOWN_REASON_PREFIX));
    assert.equal(isWorkerSendUnknownEntry(e), true);
    assert.equal(isWorkerSendUnknownEntry({ status: "send_unknown", reason: "media_publish timeout" }), false);
    assert.equal(isWorkerSendUnknownEntry({ status: "failed", reason: e.reason }), false);
    assert.equal(isWorkerSendUnknownEntry(null), false);
  });

  it("Instagram diário: 409 do Worker → conferir e postar à mão, sem --retry; envio ambíguo comum mantém --retry", () => {
    const hint = sendUnknownInstagramHint("d1", workerSendUnknownEntry("instagram", "d1"));
    assert.equal(hint, workerSendUnknownManualHint("instagram/d1"));
    assert.match(hint, /postar à mão/);
    assert.doesNotMatch(hint, /rodar com --retry/);
    assert.match(sendUnknownInstagramHint("d1", { status: "send_unknown", reason: "media_publish timeout" }), /rodar com --retry d1/);
    assert.match(sendUnknownInstagramHint("d1"), /rodar com --retry d1/);
  });

  it("Threads diário: aviso final separa o 409 do Worker (postar à mão) do ambíguo comum (--retry)", () => {
    const comum: PostEntry = { platform: "threads", destaque: "d2", url: null, scheduled_at: null, status: "send_unknown", reason: "timeout" };
    const lines = threadsSendUnknownWarnings([workerSendUnknownEntry("threads", "d1"), comum]);
    const retryLine = lines.find((l) => l.includes("--retry d2"));
    assert.ok(retryLine, "o ambíguo comum segue com --retry");
    assert.doesNotMatch(retryLine!, /d1/, "o 409 do Worker não entra na sugestão de --retry");
    assert.ok(lines.includes(workerSendUnknownManualHint("threads/d1")));
    assert.deepEqual(threadsSendUnknownWarnings([workerSendUnknownEntry("threads", "d1")]), [workerSendUnknownManualHint("threads/d1")]);
  });

  it("semanal (Instagram/Threads): 409 do Worker → sem --retry; o resto inalterado", () => {
    const e = workerSendUnknownEntry("instagram", "highlights");
    assert.equal(weeklySendUnknownHint("instagram", "instagram/highlights", e), workerSendUnknownManualHint("instagram/highlights"));
    assert.match(weeklySendUnknownHint("threads", "threads/highlights"), /--retry threads/);
    assert.match(weeklySendUnknownHint("linkedin", "linkedin/highlights", e), /--retry linkedin não reposta/);
  });
});
