/**
 * #10823 — `publish-shorts.ts` passa a ENFILEIRAR o Reels do Instagram com
 * horário futuro na fila do Worker `diaria-linkedin-cron` (em vez de deixar
 * `pending_schedule` à espera de uma 2ª rodada no horário). Nenhum teste toca
 * rede: upload e enqueue são injetados.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enqueueInstagramReel,
  planShortsPublish,
  resolveInstagramQueueReadiness,
  type ShortsPlanInput,
} from "../scripts/publish-shorts.ts";
import { WorkerQueueError, type WorkerQueuePayload } from "../scripts/lib/worker-queue-client.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[Você já viu IA mentir. Já viu roubar?](https://alignment.openai.com/x)

Um modelo gastou o saldo de uma carteira de terceiros.

Por que isso importa: porque sim.
`;

function page(slug: string): ResolvedFacebookPage {
  return { slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: `page-${slug}` };
}

const base: Omit<ShortsPlanInput, "now"> = {
  aammdd: "261022",
  reviewedMd: REVIEWED,
  config: { publishing: { shorts: { facebook_pages: ["diaria", "vjpixel"], instagram: true, instagram_backend: "worker-r2", instagram_collaborators: ["vjpixel"] } } },
  pages: [page("diaria"), page("vjpixel")],
  instagramReady: true,
  published: { aammdd: "261022", entries: [] },
  video: { path: "v.mp4", exists: true, sizeBytes: 10 },
  editionUrl: "https://diar.ia.br/p/x",
};
const BEFORE = new Date("2026-10-22T03:00:00Z"); // antes das 12:00 BRT do vertical

describe("#10823 plano: Instagram com horário futuro vai pra fila do Worker", () => {
  it("fila pronta → action enqueue com a conta e o horário do vertical", () => {
    const plan = planShortsPublish({ ...base, now: BEFORE, instagramQueue: { ready: true, account: "vjpixel" } });
    const ig = plan.items.find((i) => i.destination === "instagram")!;
    assert.equal(ig.action, "enqueue");
    assert.equal((ig as { igAccount: string }).igAccount, "vjpixel");
    assert.equal((ig as { scheduledAt: string }).scheduledAt, "2026-10-22T15:00:00.000Z");
    assert.ok(plan.premises.some((p) => p.startsWith("instagram: fila do Worker para 2026-10-22T15:00:00.000Z")));
  });

  it("fila indisponível → pending_schedule de antes, com o motivo no detalhe e aviso", () => {
    const plan = planShortsPublish({ ...base, now: BEFORE, instagramQueue: { ready: false, reason: "falta SHORTS_R2_BUCKET" } });
    const ig = plan.items.find((i) => i.destination === "instagram")!;
    assert.equal(ig.action, "pending_schedule");
    assert.match((ig as { detail: string }).detail, /falta SHORTS_R2_BUCKET/);
    assert.ok(plan.warnings.some((w) => w.includes("sem fila do Worker")));
  });

  it("sem informação de fila (caller antigo) → pending_schedule, sem aviso novo", () => {
    const plan = planShortsPublish({ ...base, now: BEFORE });
    assert.equal(plan.items.find((i) => i.destination === "instagram")!.action, "pending_schedule");
    assert.ok(!plan.warnings.some((w) => w.includes("fila do Worker")));
  });

  it("--now publica na hora mesmo com fila pronta (nada a agendar)", () => {
    const plan = planShortsPublish({ ...base, now: BEFORE, forceNow: true, instagramQueue: { ready: true, account: "diaria" } });
    assert.equal(plan.items.find((i) => i.destination === "instagram")!.action, "publish");
  });

  it("horário já passou → publish direto, não enqueue", () => {
    const plan = planShortsPublish({ ...base, now: new Date("2026-10-22T20:00:00Z"), instagramQueue: { ready: true, account: "diaria" } });
    assert.equal(plan.items.find((i) => i.destination === "instagram")!.action, "publish");
  });
});

describe("#10823 resolveInstagramQueueReadiness", () => {
  const ok = { workerUrl: "https://w.test", workerToken: "t", r2Missing: [] as string[] };
  it("autora null → conta diaria; vjpixel → vjpixel", () => {
    assert.deepEqual(resolveInstagramQueueReadiness({ ...ok, authorPage: null }), { ready: true, account: "diaria" });
    assert.deepEqual(resolveInstagramQueueReadiness({ ...ok, authorPage: "vjpixel" }), { ready: true, account: "vjpixel" });
  });
  it("página que o Worker não conhece → não pronto", () => {
    const r = resolveInstagramQueueReadiness({ ...ok, authorPage: "memelab" });
    assert.equal(r.ready, false);
    assert.match((r as { reason: string }).reason, /memelab/);
  });
  it("lista Worker e R2 que faltam", () => {
    const r = resolveInstagramQueueReadiness({ authorPage: "vjpixel", workerUrl: "", workerToken: "", r2Missing: ["SHORTS_R2_BUCKET"] });
    assert.deepEqual(r, { ready: false, reason: "falta DIARIA_LINKEDIN_CRON_URL, DIARIA_LINKEDIN_CRON_TOKEN, SHORTS_R2_BUCKET" });
  });
});

describe("#10823 enqueueInstagramReel", () => {
  const now = () => new Date("2026-10-22T03:00:00Z");
  const item = { caption: "legenda", scheduledAt: "2026-10-22T15:00:00.000Z", igAccount: "vjpixel" as const, idempotencyKey: "shorts-instagram-261022-vjpixel" };

  it("sobe o vídeo, enfileira REELS com video_url/conta/collabs e registra scheduled com a key", async () => {
    let payload: WorkerQueuePayload | undefined;
    const out = await enqueueInstagramReel(
      {
        uploadVideo: async () => "https://v.test/shorts/diaria-comentada-261022-short.mp4",
        enqueue: async (p) => {
          payload = p;
          return { key: "queue:1792681200000:abc", scheduled_at: p.scheduled_at };
        },
        now,
      },
      item,
      ["diar.ia.br"],
    );
    assert.deepEqual(payload, {
      text: "legenda",
      image_url: null,
      scheduled_at: "2026-10-22T15:00:00.000Z",
      destaque: "shorts",
      channel: "instagram",
      media_type: "REELS",
      video_url: "https://v.test/shorts/diaria-comentada-261022-short.mp4",
      collaborators: ["diar.ia.br"],
      ig_account: "vjpixel",
      idempotency_key: "shorts-instagram-261022-vjpixel",
    });
    assert.equal(out.entry.status, "scheduled", "202 da fila nunca vira published (#573)");
    assert.equal(out.entry.id, "queue:1792681200000:abc");
    assert.equal(out.entry.scheduled_at, "2026-10-22T15:00:00.000Z");
    assert.equal(out.warnings, undefined);
  });

  it("upload falhou → não enfileira nada", async () => {
    let called = false;
    await assert.rejects(
      enqueueInstagramReel(
        {
          uploadVideo: async () => {
            throw new Error("R2 PUT: HTTP 403");
          },
          enqueue: async () => {
            called = true;
            return { key: "k", scheduled_at: item.scheduledAt };
          },
          now,
        },
        item,
        [],
      ),
      /R2 PUT/,
    );
    assert.equal(called, false);
  });

  it("Worker sem os secrets da vjpixel → erro que nomeia os secrets", async () => {
    await assert.rejects(
      enqueueInstagramReel(
        {
          uploadVideo: async () => "https://v.test/a.mp4",
          enqueue: async () => {
            throw new WorkerQueueError(400, '{"code":"instagram_account_creds_missing"}', "instagram_account_creds_missing");
          },
          now,
        },
        item,
        [],
      ),
      /INSTAGRAM_VJPIXEL_ACCOUNT_ID\/INSTAGRAM_VJPIXEL_ACCESS_TOKEN/,
    );
  });

  it("scheduled_at devolvido já no passado → registra, mas avisa (estado unknown)", async () => {
    const out = await enqueueInstagramReel(
      { uploadVideo: async () => "https://v.test/a.mp4", enqueue: async () => ({ key: "k", scheduled_at: "2026-10-21T00:00:00.000Z" }), now },
      item,
      [],
    );
    assert.equal(out.entry.status, "scheduled");
    assert.match(out.warnings![0], /estado unknown/);
  });
});
