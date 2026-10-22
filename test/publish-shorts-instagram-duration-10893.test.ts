/**
 * test/publish-shorts-instagram-duration-10893.test.ts
 *
 * #10893: o Instagram recusa Reels acima de ~40 s pela Content Publishing API
 * (rupload 400 ProcessingFailedError / container 2207076, medido em 22/10/2026
 * com o vertical de 113,9 s da edição 261022). Antes deste fix o
 * `publish-shorts.ts` subia o arquivo inteiro e só descobria no rupload; agora
 * o plano lê a duração e, acima do teto, transforma o Instagram em passo
 * GUIADO (postar no app + `--mark instagram=URL`). Nenhum teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INSTAGRAM_REELS_API_MAX_SECONDS,
  instagramReelsApiFit,
  loadInstagramApiMaxSeconds,
} from "../scripts/lib/diaria/short-video.ts";
import { parseMarkArg, planShortsPublish, publishInstagramReel, type GraphDeps } from "../scripts/publish-shorts.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const reviewed = "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo do destaque. Segunda frase.\n";
const pages: ResolvedFacebookPage[] = [
  { slug: "diaria", enabled: true, pageId: "1", token: "t1", missing: [], utmContent: null },
  { slug: "vjpixel", enabled: false, pageId: "937", token: "tok", missing: [], utmContent: "page-vjpixel" },
];

function plan(extra: Partial<Parameters<typeof planShortsPublish>[0]> = {}) {
  return planShortsPublish({
    aammdd: "261022",
    reviewedMd: reviewed,
    // 261022 06:00 BRT: o horário do vertical (12:00) ainda está à frente.
    now: new Date("2026-10-22T09:00:00Z"),
    config: {},
    pages,
    instagramReady: true,
    instagramQueue: { ready: true, account: "vjpixel" },
    published: { aammdd: "261022", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 55_900_000 },
    editionUrl: "https://diar.ia.br/p/x",
    ...extra,
  });
}

describe("#10893 teto de duração do Reels pela API do Instagram", () => {
  it("o teto default é o medido (40 s) e é configurável; null desliga; lixo lança", () => {
    assert.equal(INSTAGRAM_REELS_API_MAX_SECONDS, 40);
    assert.equal(loadInstagramApiMaxSeconds({}), 40);
    assert.equal(loadInstagramApiMaxSeconds({ publishing: { shorts: { instagram_api_max_seconds: 90 } } }), 90);
    assert.equal(loadInstagramApiMaxSeconds({ publishing: { shorts: { instagram_api_max_seconds: null } } }), null);
    for (const bad of [0, -1, "40", Number.NaN]) {
      assert.throws(() => loadInstagramApiMaxSeconds({ publishing: { shorts: { instagram_api_max_seconds: bad } } }), /instagram_api_max_seconds/);
    }
  });

  it("instagramReelsApiFit: grade medida na issue (35/40 cabem, 42/45/60/113,9 não)", () => {
    for (const s of [35, 40]) assert.deepEqual(instagramReelsApiFit(s, 40), { fits: true, unknown: false });
    for (const s of [42, 45, 60, 113.9]) {
      const r = instagramReelsApiFit(s, 40);
      assert.equal(r.fits, false);
      assert.match((r as { reason: string }).reason, /ProcessingFailedError/);
    }
    assert.deepEqual(instagramReelsApiFit(null, 40), { fits: true, unknown: true });
    assert.deepEqual(instagramReelsApiFit(113.9, null), { fits: true, unknown: false });
  });

  it("regressão 261022: vertical de 113,9 s NÃO vai pro rupload/fila — Instagram vira passo guiado com legenda e --mark", () => {
    const p = plan({ videoDurationSeconds: 113.9 });
    const ig = p.items.find((i) => i.destination === "instagram")!;
    assert.equal(ig.action, "guided");
    assert.equal(ig.mode, "guided");
    const g = ig as { caption?: string; detail: string };
    assert.match(g.detail, /113\.9 s/);
    assert.match(g.detail, /--mark instagram=URL/);
    assert.match(g.detail, /@diar\.ia\.br em collab/);
    assert.match(g.caption ?? "", /link da bio/);
    // Fora da grade: só os destinos que saem pela API disputam horário.
    assert.ok(!p.slots.some((s) => s.destination === "instagram"));
    assert.ok(p.warnings.some((w) => w.startsWith("instagram:") && /#10893/.test(w)));
    // O Facebook não é afetado pelo teto do Instagram.
    assert.equal(p.items.find((i) => i.destination === "facebook:diaria")!.action, "publish");
  });

  it("vale também sem credencial do Instagram (o caminho certo é o app, não 'falta token')", () => {
    const p = plan({ videoDurationSeconds: 113.9, instagramReady: false, instagramNotReadyReason: "sem token" });
    assert.equal(p.items.find((i) => i.destination === "instagram")!.action, "guided");
  });

  it("vertical de até 40 s segue pela API (fila do Worker com horário futuro)", () => {
    const p = plan({ videoDurationSeconds: 38 });
    assert.equal(p.items.find((i) => i.destination === "instagram")!.action, "enqueue");
    assert.ok(p.slots.some((s) => s.destination === "instagram"));
  });

  it("teto desligado no config (null): 113,9 s volta a ir pela API", () => {
    const p = plan({ videoDurationSeconds: 113.9, config: { publishing: { shorts: { ...shortsCfg(), instagram_api_max_seconds: null } } } });
    assert.equal(p.items.find((i) => i.destination === "instagram")!.action, "enqueue");
  });

  it("duração medida mas ilegível (null): segue pela API com aviso; não medida (ausente): sem aviso", () => {
    const unread = plan({ videoDurationSeconds: null });
    assert.equal(unread.items.find((i) => i.destination === "instagram")!.action, "enqueue");
    assert.ok(unread.warnings.some((w) => /duração do vertical não lida/.test(w)));
    const unmeasured = plan();
    assert.ok(!unmeasured.warnings.some((w) => /duração do vertical não lida/.test(w)));
  });

  it("--mark aceita instagram (registro do post feito à mão no app)", () => {
    assert.deepEqual(parseMarkArg("instagram=https://www.instagram.com/reel/abc/"), {
      destination: "instagram",
      url: "https://www.instagram.com/reel/abc/",
    });
  });

  it("rupload ProcessingFailedError ganha a dica do teto e do passo manual", async () => {
    const responses = [
      () => ({ id: "c1", uri: "https://rupload.facebook.com/ig-api-upload/v25.0/c1" }),
      () => ({ __http: 400, debug_info: { retriable: false, type: "ProcessingFailedError", message: "Request processing failed" } }),
    ];
    let i = 0;
    const deps: GraphDeps = {
      fetch: async () => {
        const r = responses[i++];
        if (!r) throw new Error("chamada inesperada");
        const { __http, ...json } = r() as { __http?: number };
        return new Response(JSON.stringify(json), { status: __http ?? 200 });
      },
      sleep: async () => {},
      now: () => new Date("2026-10-22T15:22:00Z"),
      log: () => {},
    };
    await assert.rejects(publishInstagramReel(deps, "ig", "tok", "v25.0", Buffer.from([0]), "legenda"), (e: Error) => {
      assert.match(e.message, /ProcessingFailedError/);
      assert.match(e.message, /#10893/);
      assert.match(e.message, /--mark instagram=URL/);
      return true;
    });
  });
});

function shortsCfg() {
  return { facebook_pages: ["diaria", "vjpixel"], instagram: true, instagram_author_page: "vjpixel", instagram_collaborators: ["diar.ia.br"] };
}
