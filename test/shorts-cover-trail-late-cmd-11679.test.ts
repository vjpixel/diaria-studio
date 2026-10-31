/**
 * test/shorts-cover-trail-late-cmd-11679.test.ts (#11679)
 *
 * Achados do review consolidado da rodada 261030c sobre o publish-shorts:
 *  1. falha do upload da capa do Reel (R2) deixa `cover.ok: false` no registro,
 *     como Facebook/LinkedIn/YouTube já fazem;
 *  2. `thumbnailOffset` do X fora do vertical (sequência do Premiere que não
 *     começa em 00:00:00:00) não vai à Buffer;
 *  3. o `skip_late` da rodada do timer sugere o comando com a flag do timer
 *     (sem ela o destino cai em `skip_delegated` e não publica).
 * Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enqueueInstagramReel,
  lateNowArgs,
  planShortsPublish,
  publishInstagramReel,
  uploadCoverOrFallback,
  type GraphDeps,
} from "../scripts/publish-shorts.ts";
import { SHORT_COVER_OFFSET_FALLBACK_MAX_MS, clampBufferThumbnailOffsetMs, stillTimecodeOffsetMs } from "../scripts/lib/diaria/short-cover.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

describe("#11679 item 1: falha da capa do Reel fica no registro", () => {
  const rejectCover = () => uploadCoverOrFallback(() => Promise.reject(new Error("R2 503")), () => {});

  it("fila do Worker: uploadCover rejeitando → cover ok=false com o erro, sem cover_url no payload", async () => {
    let payload: any;
    const out = await enqueueInstagramReel(
      {
        uploadVideo: async () => "https://cdn/v.mp4",
        uploadCover: rejectCover,
        enqueue: async (p) => {
          payload = p;
          return { key: "k", scheduled_at: "2026-10-30T12:00:00Z" };
        },
        now: () => new Date("2026-10-29"),
      },
      { caption: "x", scheduledAt: "2026-10-30T12:00:00Z", igAccount: "diaria", idempotencyKey: "k" },
      [],
    );
    assert.equal(out.entry.cover?.method, "cover_url");
    assert.equal(out.entry.cover?.ok, false);
    assert.match(out.entry.cover?.error ?? "", /R2 503/);
    assert.equal(payload.cover_url, undefined, "o Reel segue com o frame automático");
    assert.equal(JSON.stringify(payload).includes("error"), false, "a falha não vai pro payload do Worker");
  });

  it("publish direto: falha da capa → cover ok=false e nenhum cover_url no container", async () => {
    const seq = [{ id: "c" }, { success: true }, { status_code: "FINISHED" }, { id: "m" }, { permalink: "p" }];
    const bodies: string[] = [];
    const deps: GraphDeps = {
      fetch: async (_url, init) => {
        if (typeof init?.body === "string") bodies.push(init.body);
        else if (init?.body instanceof URLSearchParams) bodies.push(init.body.toString());
        return Response.json(seq.shift());
      },
      sleep: async () => {},
      now: () => new Date(),
      log: () => {},
    };
    const out = await publishInstagramReel(deps, "ig", "t", "v25.0", Buffer.from("v"), "c", [], await rejectCover());
    assert.deepEqual(out.entry.cover, { method: "cover_url", ok: false, error: "capa não enviada ao R2: R2 503" });
    assert.ok(!bodies.some((b) => b.includes("cover_url")), bodies.join("\n"));
  });

  it("sem capa a enviar (undefined) segue sem campo cover", async () => {
    const out = await enqueueInstagramReel(
      { uploadVideo: async () => "https://cdn/v.mp4", uploadCover: async () => undefined, enqueue: async () => ({ key: "k", scheduled_at: "2026-10-30T12:00:00Z" }), now: () => new Date("2026-10-29") },
      { caption: "x", scheduledAt: "2026-10-30T12:00:00Z", igAccount: "diaria", idempotencyKey: "k" },
      [],
    );
    assert.equal(out.entry.cover, undefined);
  });
});

describe("#11679 item 2: offset do X limitado ao vertical", () => {
  it("sequência começando em 01:00:00:00 → offset ≥ 1 h vira null (a Buffer escolhe o frame)", () => {
    const offset = stillTimecodeOffsetMs("Diaria comentada_Instagram_V1.01_00_03_00.Still001.jpg");
    assert.equal(offset, 3_603_000);
    assert.equal(clampBufferThumbnailOffsetMs(offset, 75), null);
    assert.equal(clampBufferThumbnailOffsetMs(offset, null), null, "duração desconhecida: teto de 10 min");
  });

  it("offset dentro do vertical passa intacto; null continua null", () => {
    assert.equal(clampBufferThumbnailOffsetMs(3_000, 75), 3_000);
    assert.equal(clampBufferThumbnailOffsetMs(3_000, null), 3_000);
    assert.equal(clampBufferThumbnailOffsetMs(null, 75), null);
    assert.equal(clampBufferThumbnailOffsetMs(75_000, 75), null, "offset no fim exato do vídeo não é um frame");
    assert.equal(clampBufferThumbnailOffsetMs(SHORT_COVER_OFFSET_FALLBACK_MAX_MS, null), null);
  });
});

describe("#11679 item 3: skip_late na rodada do timer sugere o comando que publica", () => {
  it("lateNowArgs: a flag do timer só entra no destino que é dele", () => {
    assert.equal(lateNowArgs("linkedin_profile", "linkedin-timer"), "--only linkedin_profile --publish --linkedin-timer --now");
    assert.equal(lateNowArgs("linkedin_profile", "main"), "--only linkedin_profile --publish --now");
    assert.equal(lateNowArgs("linkedin_profile"), "--only linkedin_profile --publish --now");
    assert.equal(lateNowArgs("threads_profile", "threads-timer"), "--only threads_profile --publish --threads-timer --now");
    assert.equal(lateNowArgs("threads_profile", "linkedin-timer"), "--only threads_profile --publish --now");
  });

  const SCHEDULE = { rotation_times: ["12:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" };
  const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[Você já viu IA mentir. Já viu roubar?](https://alignment.openai.com/x)

Um modelo da OpenAI gastou o saldo de terceiros.

Por que isso importa: porque sim.
`;
  const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });
  const shorts = {
    facebook_pages: [],
    instagram: false,
    linkedin_profile: true,
    linkedin_profile_via_timer: true,
    linkedin_page_repost: false,
    x: false,
    threads_profile: false,
    schedule: SCHEDULE,
  };
  const input = {
    aammdd: "261022",
    reviewedMd: REVIEWED,
    config: { publishing: { shorts } },
    pages: [page("diaria")],
    instagramReady: false,
    published: { aammdd: "261022", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    editionUrl: "https://diar.ia.br/p/voce-ja-viu-ia-mentir-ja-viu-roubar",
    linkedinPersonal: { ready: true } as const,
    publicVideo: { ready: true } as const,
    now: new Date("2026-10-22T20:00:00Z"), // 17:00 BRT, 5 h depois do vertical
  };

  it("regressão: --linkedin-timer depois do teto → detail, aviso e dono citam --linkedin-timer --now", () => {
    const p = planShortsPublish({ ...input, writer: "linkedin-timer" });
    const item = p.items.find((i) => i.destination === "linkedin_profile") as any;
    assert.equal(item.action, "skip_late");
    assert.match(item.detail, /--only linkedin_profile --publish --linkedin-timer --now/);
    assert.ok(p.warnings.some((w) => w.includes("--linkedin-timer --now")), p.warnings.join("\n"));
    assert.match(p.owners.find((o) => o.destination === "linkedin_profile")?.command ?? "", /--linkedin-timer --now$/);
  });
});
