/**
 * test/reels-hardening-11774.test.ts
 *
 * #11774: sobras do fleet review da PR #11767 na rota `video_url` do Reels.
 * Timeouts de rede (Graph, R2, filho do timer), publish com timeout e container
 * FINISHED, poll que perdia o `status` e tratava token revogado como transitório,
 * poda de retenção que apagava a capa reaproveitada, gate da conta só antes do
 * upload e `fits-api` na conta com teto. Nada toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GRAPH_REQUEST_TIMEOUT_MS,
  GraphResponseError,
  InstagramTimerGateError,
  instagramTimerBeforePublish,
  isGraphAuthError,
  mediaPublishFailureIsDefinitive,
  publishInstagramReel,
  type GraphDeps,
} from "../scripts/publish-shorts.ts";
import { R2_PUT_TIMEOUT_MS, R2_REQUEST_TIMEOUT_MS, r2ObjectHasBody, uploadToR2, type R2UploadConfig } from "../scripts/lib/r2-object-upload.ts";
import { INSTAGRAM_TIMER_CHILD_TIMEOUT_MS } from "../scripts/shorts-instagram-timer.ts";
import { SHORTS_TIMER_LOCK_STALE_MS } from "../scripts/lib/diaria/vertical-download-guard.ts";
import { guidedFallbackReason } from "../scripts/prepare-instagram-guided.ts";
import type { ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";

const source = { videoUrl: "https://r2.example/shorts/v.mp4" };

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Graph falsa por rota; guarda URL e init de cada chamada. */
function graph(route: Route) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const logs: string[] = [];
  const deps: GraphDeps = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return route(url, init);
    },
    sleep: async () => {},
    now: () => new Date("2026-11-02T15:05:00Z"),
    log: (m) => logs.push(m),
  };
  return { deps, calls, logs };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Container c1 pronto; `publish` decide o que o media_publish faz. */
function finishedThen(publish: Route, containerCode = "FINISHED") {
  return graph((url, init) => {
    if (url.includes("/media_publish")) return publish(url, init);
    if (url.endsWith("/ig/media")) return json({ id: "c1" });
    if (url.includes("/c1?")) return json({ status_code: containerCode, status: "Finished: Media has been uploaded" });
    return json({});
  });
}

describe("#11774 timeouts de rede", () => {
  it("toda chamada à Graph do Reels leva AbortSignal (graphPost e graphGet)", async () => {
    const { deps, calls } = graph((url) => {
      if (url.includes("/media_publish")) return json({ id: "m1" });
      if (url.endsWith("/ig/media")) return json({ id: "c1" });
      if (url.includes("/c1?")) return json({ status_code: "FINISHED" });
      if (url.includes("/m1?")) return json({ permalink: "https://instagram.com/reel/m1" });
      return json({});
    });
    await publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda");
    assert.ok(calls.length >= 4);
    for (const c of calls) assert.ok(c.init?.signal instanceof AbortSignal, `sem signal: ${c.url}`);
    assert.ok(GRAPH_REQUEST_TIMEOUT_MS > 0 && GRAPH_REQUEST_TIMEOUT_MS <= 120_000);
  });

  const cfg: R2UploadConfig = { accountId: "acc", accessKeyId: "k", secretAccessKey: "s", bucket: "b", publicBase: "https://v.test" };

  it("PUT, HEAD, LIST e DELETE do R2 levam AbortSignal", async () => {
    const body = Buffer.from("video");
    const seen: { method: string; signal: unknown }[] = [];
    await uploadToR2(
      {
        now: () => new Date("2026-11-02T12:00:00Z"),
        warn: () => {},
        fetch: async (_u, init) => {
          const method = init?.method ?? "GET";
          seen.push({ method, signal: init?.signal });
          if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(body.length) } });
          if (method === "GET") return new Response(`<ListBucketResult><Contents><Key>shorts/velho.mp4</Key><LastModified>2026-10-01T00:00:00Z</LastModified></Contents></ListBucketResult>`, { status: 200 });
          return new Response(null, { status: method === "DELETE" ? 204 : 200 });
        },
      },
      cfg,
      "shorts/261102-short.mp4",
      body,
      "video/mp4",
    );
    assert.deepEqual(seen.map((s) => s.method), ["PUT", "HEAD", "GET", "DELETE"]);
    for (const s of seen) assert.ok(s.signal instanceof AbortSignal, `sem signal: ${s.method}`);
    let headSignal: unknown;
    await r2ObjectHasBody({ now: () => new Date(), fetch: async (_u, init) => ((headSignal = init?.signal), new Response(null, { status: 404 })) }, cfg, "shorts/x.mp4", body);
    assert.ok(headSignal instanceof AbortSignal);
    assert.ok(R2_PUT_TIMEOUT_MS > R2_REQUEST_TIMEOUT_MS);
  });

  it("o filho do timer morre antes de o lock ficar velho (nenhuma outra rodada publica junto)", () => {
    assert.ok(INSTAGRAM_TIMER_CHILD_TIMEOUT_MS < SHORTS_TIMER_LOCK_STALE_MS);
    // Folga para o upload (15 min de PUT) e o poll de 10 min caberem com sobra.
    assert.ok(INSTAGRAM_TIMER_CHILD_TIMEOUT_MS >= R2_PUT_TIMEOUT_MS + 10 * 60_000);
  });
});

describe("#11774 media_publish com container FINISHED", () => {
  it("regressão: timeout no media_publish com o container FINISHED vira send_unknown, não relança", async () => {
    const { deps } = finishedThen(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda");
    assert.equal(out.entry.status, "send_unknown");
    assert.match(out.warnings?.[0] ?? "", /PODE estar no ar/);
  });

  it("5xx no media_publish com o container FINISHED também é send_unknown", async () => {
    const { deps } = finishedThen(() => json({ error: { message: "Service temporarily unavailable", code: 2 } }, 503));
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda");
    assert.equal(out.entry.status, "send_unknown");
  });

  it("4xx no media_publish com o container FINISHED relança (a Meta recusou)", async () => {
    const { deps } = finishedThen(() => json({ error: { message: "Invalid parameter", code: 100 } }, 400));
    await assert.rejects(publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda"), /POST ig\/media_publish: 400/);
  });

  it("timeout com o container ERROR relança: o container prova que não saiu", async () => {
    let polls = 0;
    const { deps } = graph((url) => {
      if (url.includes("/media_publish")) throw new DOMException("timeout", "TimeoutError");
      if (url.endsWith("/ig/media")) return json({ id: "c1" });
      if (url.includes("/c1?")) return json({ status_code: polls++ === 0 ? "FINISHED" : "ERROR" });
      return json({});
    });
    await assert.rejects(publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda"), /timeout/);
  });

  it("classificação: só resposta da Graph abaixo de 500 é definitiva (4xx, 200 sem id)", () => {
    assert.equal(mediaPublishFailureIsDefinitive(new GraphResponseError("x", 400, 100)), true);
    assert.equal(mediaPublishFailureIsDefinitive(new GraphResponseError("sem id", 200, null)), true);
    assert.equal(mediaPublishFailureIsDefinitive(new GraphResponseError("x", 500, 1)), false);
    assert.equal(mediaPublishFailureIsDefinitive(new DOMException("t", "TimeoutError")), false);
    assert.equal(mediaPublishFailureIsDefinitive(new TypeError("fetch failed")), false);
  });
});

describe("#11774 poll do container", () => {
  it("regressão: tempo esgotado leva o status_code e o status da Meta na mensagem", async () => {
    const { deps } = graph((url) => {
      if (url.endsWith("/ig/media")) return json({ id: "c1" });
      if (url.includes("/c1?")) return json({ status_code: "IN_PROGRESS", status: "In Progress: Media is still being processed" });
      return json({});
    });
    await assert.rejects(publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda"), /10 min \(último: IN_PROGRESS In Progress: Media is still being processed\)/);
  });

  it("regressão: token revogado (190) falha na hora, sem 10 min de poll nem media_publish", async () => {
    const { deps, calls } = graph((url) => {
      if (url.endsWith("/ig/media")) return json({ id: "c1" });
      if (url.includes("/c1?")) return json({ error: { message: "Error validating access token", type: "OAuthException", code: 190 } }, 400);
      return json({});
    });
    await assert.rejects(publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda"), /token do Instagram recusado/);
    assert.equal(calls.filter((c) => c.url.includes("/c1?")).length, 1);
    assert.ok(!calls.some((c) => c.url.includes("/media_publish")));
    assert.equal(isGraphAuthError(new GraphResponseError("x", 400, 190)), true);
    assert.equal(isGraphAuthError(new GraphResponseError("x", 400, 100)), false);
  });

  it("falha de rede no poll continua transitória (tenta de novo)", async () => {
    let n = 0;
    const { deps } = graph((url) => {
      if (url.includes("/media_publish")) return json({ id: "m1" });
      if (url.endsWith("/ig/media")) return json({ id: "c1" });
      if (url.includes("/c1?")) {
        if (n++ === 0) throw new TypeError("fetch failed");
        return json({ status_code: "FINISHED" });
      }
      return json({});
    });
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda");
    assert.equal(out.entry.id, "m1");
  });
});

describe("#11774 poda de retenção e capa reaproveitada", () => {
  const cfg: R2UploadConfig = { accountId: "acc", accessKeyId: "k", secretAccessKey: "s", bucket: "b", publicBase: "https://v.test" };

  it("regressão: o upload do vertical não apaga a capa velha que a mesma rodada reaproveitou (keep)", async () => {
    const body = Buffer.from("video");
    const deleted: string[] = [];
    const list = `<ListBucketResult>` +
      ["shorts/261020-cover.jpg", "shorts/261019-short.mp4"].map((k) => `<Contents><Key>${k}</Key><LastModified>2026-10-20T00:00:00Z</LastModified></Contents>`).join("") +
      `</ListBucketResult>`;
    await uploadToR2(
      {
        now: () => new Date("2026-11-02T12:00:00Z"),
        warn: () => {},
        fetch: async (u, init) => {
          const method = init?.method ?? "GET";
          if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(body.length) } });
          if (method === "GET") return new Response(list, { status: 200 });
          if (method === "DELETE") deleted.push(u);
          return new Response(null, { status: method === "DELETE" ? 204 : 200 });
        },
      },
      cfg,
      "shorts/diaria-comentada-261020-short.mp4",
      body,
      "video/mp4",
      { keep: ["shorts/261020-cover.jpg"] },
    );
    assert.deepEqual(deleted, ["https://acc.r2.cloudflarestorage.com/b/shorts/261019-short.mp4"]);
  });
});

describe("#11774 gate da conta logo antes do media_publish", () => {
  const found: ShortPublishedEntry = { destination: "instagram", status: "published", id: "m-fora", url: "https://instagram.com/reel/fora", scheduled_at: null, at: "2026-11-02T15:06:00Z" };

  it("regressão: Share feito por fora durante o processamento → não publica", async () => {
    let gateCalls = 0;
    const beforePublish = instagramTimerBeforePublish({
      local: () => null,
      gate: async () => (gateCalls++, { kind: "already", entry: found, matchedBy: "marker" }),
    });
    const { deps, calls } = finishedThen(() => json({ id: "m1" }));
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda", [], undefined, { beforePublish });
    assert.equal(out.alreadyRegistered, true);
    assert.equal(out.entry.id, "m-fora");
    assert.equal(gateCalls, 1);
    assert.ok(!calls.some((c) => c.url.includes("/media_publish")));
  });

  it("registro local já tem o Reels → nem consulta a conta", async () => {
    let gateCalls = 0;
    const beforePublish = instagramTimerBeforePublish({ local: () => found, gate: async () => (gateCalls++, { kind: "publish" }) });
    assert.equal(await beforePublish(), found);
    assert.equal(gateCalls, 0);
  });

  it("gate que lança (leitura falhou) → não publica e o erro segue como do gate", async () => {
    const beforePublish = instagramTimerBeforePublish({
      local: () => null,
      gate: async () => {
        throw new InstagramTimerGateError("a leitura da conta do Instagram falhou", "read-failed");
      },
    });
    const { deps, calls } = finishedThen(() => json({ id: "m1" }));
    await assert.rejects(publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda", [], undefined, { beforePublish }), InstagramTimerGateError);
    assert.ok(!calls.some((c) => c.url.includes("/media_publish")));
  });

  it("conta sem o Reels → publica", async () => {
    const beforePublish = instagramTimerBeforePublish({ local: () => null, gate: async () => ({ kind: "publish" }) });
    const { deps } = finishedThen(() => json({ id: "m1" }));
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda", [], undefined, { beforePublish });
    assert.equal(out.entry.id, "m1");
  });
});

describe("#11774 plano B do passo guiado", () => {
  it("regressão: conta com teto e vertical abaixo dele tem plano B (antes: fits-api)", () => {
    assert.match(guidedFallbackReason(40, 30) ?? "", /plano B.*cabe no teto/);
    assert.match(guidedFallbackReason(40, 40) ?? "", /plano B/);
  });

  it("acima do teto não precisa de fallback (o plano já dá guided); sem teto, plano B de sempre", () => {
    assert.equal(guidedFallbackReason(40, 75), null);
    assert.match(guidedFallbackReason(null, 20) ?? "", /não tem teto/);
  });
});
