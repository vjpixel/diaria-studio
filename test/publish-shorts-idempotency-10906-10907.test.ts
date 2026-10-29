/**
 * #10906 — lado do cliente do enqueue idempotente do Reels: o plano gera a
 * chave por edição+conta, o payload a carrega, e o retry do `postToWorkerQueue`
 * (resposta perdida depois do commit) manda a MESMA chave — o Worker devolve a
 * entry existente (`duplicate: true`, ver
 * workers/linkedin-cron/test/instagram-reels-idempotency-10906.test.ts).
 *
 * #10907 — `linkedin_profile` em `send_unknown` bloqueia o repost da página,
 * tanto na rodada seguinte (plano) quanto na mesma rodada (runtime).
 *
 * Nenhum teste toca rede: `fetch` é falso.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  PROFILE_SEND_UNKNOWN_BLOCKER,
  blockRepostOnProfileFailure,
  enqueueInstagramReel,
  planShortsPublish,
  shortsReelsIdempotencyKey,
  type ShortsPlanInput,
} from "../scripts/publish-shorts.ts";
import { postToWorkerQueue, type WorkerQueuePayload } from "../scripts/lib/worker-queue-client.ts";
import { upsertShortEntry } from "../scripts/lib/diaria/short-video.ts";
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
const BEFORE = new Date("2026-10-22T03:00:00Z");

describe("#10906 chave idempotente do Reels", () => {
  it("o plano de enqueue leva a chave da edição e da conta", () => {
    const plan = planShortsPublish({ ...base, now: BEFORE, instagramQueue: { ready: true, account: "vjpixel" } });
    const ig = plan.items.find((i) => i.destination === "instagram")!;
    assert.equal(ig.action, "enqueue");
    assert.equal((ig as { idempotencyKey: string }).idempotencyKey, "shorts-instagram-261022-vjpixel");
    assert.equal(shortsReelsIdempotencyKey("261022", "diaria"), "shorts-instagram-261022-diaria");
  });

  it("a chave casa o formato aceito pelo Worker (IDEMPOTENCY_KEY_RE)", () => {
    assert.match(shortsReelsIdempotencyKey("261022", "vjpixel"), /^[A-Za-z0-9._:-]{1,128}$/);
  });

  it("enqueueInstagramReel manda idempotency_key no payload", async () => {
    let payload: WorkerQueuePayload | undefined;
    await enqueueInstagramReel(
      {
        uploadVideo: async () => "https://v.test/a.mp4",
        enqueue: async (p) => {
          payload = p;
          return { key: "queue:x:y", scheduled_at: p.scheduled_at };
        },
        now: () => BEFORE,
      },
      { caption: "c", scheduledAt: "2026-10-22T15:00:00.000Z", igAccount: "vjpixel", idempotencyKey: "shorts-instagram-261022-vjpixel" },
      [],
    );
    assert.equal(payload!.idempotency_key, "shorts-instagram-261022-vjpixel");
  });

  describe("retry do postToWorkerQueue depois de resposta perdida", () => {
    let originalFetch: typeof fetch;
    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });
    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("a 2ª tentativa manda a MESMA chave e aceita a resposta duplicate do Worker", async () => {
      const bodies: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (bodies.length === 1) throw new Error("The operation was aborted due to timeout"); // Worker gravou, resposta perdida
        return new Response(
          JSON.stringify({ queued: true, duplicate: true, key: "queue:2026-10-22T15:00:00.000Z:abc", scheduled_at: "2026-10-22T15:00:00.000Z", destaque: "shorts" }),
          { status: 200 },
        );
      }) as typeof fetch;
      const out = await postToWorkerQueue(
        "https://w.test",
        "tok",
        { text: "c", scheduled_at: "2026-10-22T15:00:00.000Z", destaque: "shorts", channel: "instagram", media_type: "REELS", video_url: "https://v.test/a.mp4", idempotency_key: "shorts-instagram-261022-vjpixel" },
        2,
        "teste",
      );
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0].idempotency_key, "shorts-instagram-261022-vjpixel");
      assert.equal(bodies[1].idempotency_key, bodies[0].idempotency_key, "retry com a mesma chave");
      assert.equal(out.key, "queue:2026-10-22T15:00:00.000Z:abc");
      assert.equal(out.duplicate, true);
    });
  });
});

describe("#10907 repost da página com o vídeo do perfil em send_unknown", () => {
  const plannedBase = {
    ...base,
    linkedinPersonal: { ready: true } as const,
    publicVideo: { ready: true } as const,
  };
  const by = (p: ReturnType<typeof planShortsPublish>) => Object.fromEntries(p.items.map((i) => [i.destination, i])) as Record<string, any>;

  it("rodada seguinte: perfil send_unknown → repost skip_invalid pedindo o --mark, sem horário", () => {
    const published = upsertShortEntry({ aammdd: "261022", entries: [] }, { destination: "linkedin_profile", status: "send_unknown", id: "send_unknown-x", at: "2026-10-22T15:00:00Z" });
    const p = planShortsPublish({ ...plannedBase, now: new Date("2026-10-22T16:00:00Z"), published });
    const items = by(p);
    assert.equal(items.linkedin_profile.action, "skip_done", "o vídeo do perfil segue sem re-post");
    assert.equal(items.linkedin_page_repost.action, "skip_invalid");
    assert.match(items.linkedin_page_repost.detail, /send_unknown/);
    assert.match(items.linkedin_page_repost.detail, /--mark linkedin_profile=URL/);
    assert.equal(items.linkedin_page_repost.at, undefined);
    assert.ok(!p.premises.some((x) => x.startsWith("linkedin_page_repost:")), "sem premissa de horário pro repost bloqueado");
  });

  it("perfil registrado com --mark (published + URL) → repost volta a ser guiado", () => {
    const published = upsertShortEntry({ aammdd: "261022", entries: [] }, { destination: "linkedin_profile", status: "published", id: "u", url: "https://www.linkedin.com/feed/update/u/", at: "2026-10-22T15:00:00Z" });
    const items = by(planShortsPublish({ ...plannedBase, now: new Date("2026-10-22T16:00:00Z"), published }));
    assert.equal(items.linkedin_page_repost.action, "guided");
  });

  it("mesma rodada: o --publish do perfil volta send_unknown → repost vira skip_invalid", () => {
    const items = planShortsPublish({ ...plannedBase, now: BEFORE, forceNow: true }).items;
    assert.equal(items.find((i) => i.destination === "linkedin_page_repost")!.action, "guided");
    const out = blockRepostOnProfileFailure(items, [
      { destination: "linkedin_profile", ok: true, entry: { destination: "linkedin_profile", status: "send_unknown", id: "send_unknown-x", at: "x" } },
    ]);
    const repost = out.find((i) => i.destination === "linkedin_page_repost")!;
    assert.equal(repost.action, "skip_invalid");
    assert.ok((repost as { detail: string }).detail.startsWith(PROFILE_SEND_UNKNOWN_BLOCKER));
    // published continua liberando.
    assert.strictEqual(blockRepostOnProfileFailure(items, [{ destination: "linkedin_profile", ok: true, entry: { status: "published" } }]), items);
  });
});
