/**
 * test/publish-shorts-findings-11869-11870.test.ts
 *
 * #11869: o `finish` do Facebook (`video_reels` e `/videos` resumable) sem
 * resposta definitiva (timeout de 60 s, queda de conexão, 5xx) vira registro
 * `send_unknown`, nunca falha comum — senão a próxima rodada sobe o vídeo de
 * novo e agenda um 2º Reel na página pública.
 *
 * #11870: o gate da conta re-rodado logo antes do `media_publish` (#11774) que
 * acha o Reel feito à mão leva o `matchedBy` ao chamador, para o timer reler os
 * collabs como no passo `already` (#11828).
 *
 * Fetch injetado: nada toca a Graph API.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instagramTimerBeforePublish, publishFacebookReel, type GraphDeps } from "../scripts/publish-shorts.ts";
import { isDestinationDone, type ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type Step = (url: string, init?: RequestInit) => Response | Promise<Response>;

function seq(steps: Step[]) {
  const calls: { url: string; body: Record<string, string> | null }[] = [];
  const deps: GraphDeps = {
    fetch: async (url, init) => {
      let body: Record<string, string> | null = null;
      if (init?.body instanceof URLSearchParams) body = Object.fromEntries(init.body);
      else if (init?.body instanceof FormData) body = Object.fromEntries([...init.body].filter(([, v]) => typeof v === "string")) as Record<string, string>;
      calls.push({ url, body });
      const s = steps[calls.length - 1];
      if (!s) throw new Error(`chamada inesperada: ${url}`);
      return s(url, init);
    },
    sleep: async () => {},
    now: () => new Date("2026-11-02T12:00:00Z"),
    log: () => {},
  };
  return { deps, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const timeout: Step = () => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};

const page = { slug: "diaria", enabled: true, pageId: "179", token: "tok", missing: [] as string[], utmContent: "page-diaria" };
const SCHEDULED = "2026-11-03T09:00:00.000Z";

function mp4(seconds: number): Buffer {
  const p = Buffer.alloc(100);
  p.writeUInt32BE(1000, 12);
  p.writeUInt32BE(seconds * 1000, 16);
  const mvhd = Buffer.concat([Buffer.from([0, 0, 0, 108, 0x6d, 0x76, 0x68, 0x64]), p]);
  return Buffer.concat([Buffer.from([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]), Buffer.from([0, 0, 0, 116, 0x6d, 0x6f, 0x6f, 0x76]), mvhd]);
}

describe("#11869: finish do Facebook sem resposta definitiva vira send_unknown", () => {
  const reelsStart: Step = () => json({ video_id: "v1", upload_url: "https://rupload.facebook.com/video-upload/v25.0/v1" });
  const rupload: Step = () => json({ success: true });

  it("video_reels: timeout no finish agendado → send_unknown com o video_id, sem poll nem capa", async () => {
    const { deps, calls } = seq([reelsStart, rupload, timeout]);
    const out = await publishFacebookReel(deps, page, "v25.0", mp4(60), "legenda", SCHEDULED, Buffer.from("jpeg"));
    assert.equal(calls.length, 3, "não consulta status nem sobe capa depois do finish incerto");
    assert.equal(calls[2].body?.upload_phase, "finish");
    assert.equal(out.entry.destination, "facebook:diaria");
    assert.equal(out.entry.status, "send_unknown");
    assert.equal(out.entry.id, "v1");
    assert.equal(out.entry.scheduled_at, SCHEDULED);
    assert.match(out.warnings?.[0] ?? "", /PODE estar agendado/);
    assert.match(out.warnings?.[0] ?? "", /TimeoutError|timeout/i);
  });

  it("o registro send_unknown conta como feito (a próxima rodada não sobe de novo)", async () => {
    const { deps } = seq([reelsStart, rupload, timeout]);
    const out = await publishFacebookReel(deps, page, "v25.0", mp4(60), "legenda", SCHEDULED);
    assert.equal(isDestinationDone({ aammdd: "261103", entries: [out.entry] } as never, "facebook:diaria"), true);
  });

  it("video_reels: 5xx no finish também é incerto", async () => {
    const { deps } = seq([reelsStart, rupload, () => json({ error: { message: "Service temporarily unavailable", code: 2 } }, 503)]);
    const out = await publishFacebookReel(deps, page, "v25.0", mp4(60), "legenda", null);
    assert.equal(out.entry.status, "send_unknown");
    assert.match(out.warnings?.[0] ?? "", /PODE estar no ar/);
  });

  it("video_reels: 4xx no finish é definitivo e LANÇA (falha comum)", async () => {
    const { deps } = seq([reelsStart, rupload, () => json({ error: { message: "Invalid parameter", code: 100 } }, 400)]);
    await assert.rejects(publishFacebookReel(deps, page, "v25.0", mp4(60), "legenda", SCHEDULED), /400/);
  });

  it("video_reels: 200 sem success:true LANÇA (a Graph respondeu)", async () => {
    const { deps } = seq([reelsStart, rupload, () => json({})]);
    await assert.rejects(publishFacebookReel(deps, page, "v25.0", mp4(60), "legenda", SCHEDULED), /sem success/);
  });

  it("timeout ANTES do finish (start) continua falha comum: nada foi agendado", async () => {
    const { deps } = seq([timeout]);
    await assert.rejects(publishFacebookReel(deps, page, "v25.0", mp4(60), "legenda", SCHEDULED), /timeout/i);
  });

  it("/videos resumable (>90 s): timeout no finish → send_unknown com o video_id", async () => {
    const file = mp4(120);
    const { deps, calls } = seq([
      () => json({ video_id: "v9", upload_session_id: "s1", start_offset: "0", end_offset: String(file.length) }),
      () => json({ start_offset: String(file.length), end_offset: String(file.length) }),
      timeout,
    ]);
    const out = await publishFacebookReel(deps, page, "v25.0", file, "legenda", SCHEDULED);
    assert.equal(calls[2].body?.upload_phase, "finish");
    assert.equal(out.entry.status, "send_unknown");
    assert.equal(out.entry.id, "v9");
  });
});

describe("#11870: reconferência antes do media_publish leva o matchedBy ao chamador", () => {
  const found: ShortPublishedEntry = { destination: "instagram", status: "published", id: "m1", url: "https://www.instagram.com/reel/x/", scheduled_at: null, at: "2026-11-02T12:00:00.000Z" };

  it("gate achou o Reel → onAlready recebe entry e matchedBy, e o registro volta", async () => {
    const hits: unknown[] = [];
    const before = instagramTimerBeforePublish({
      local: () => null,
      gate: async () => ({ kind: "already", entry: found, matchedBy: "marker" }),
      onAlready: (h) => hits.push(h),
    });
    assert.deepEqual(await before(), found);
    assert.deepEqual(hits, [{ entry: found, matchedBy: "marker" }]);
  });

  it("achado no registro local ou gate que libera → onAlready não é chamado", async () => {
    const hits: unknown[] = [];
    const local = instagramTimerBeforePublish({ local: () => found, gate: async () => ({ kind: "publish" }), onAlready: (h) => hits.push(h) });
    assert.deepEqual(await local(), found);
    const free = instagramTimerBeforePublish({ local: () => null, gate: async () => ({ kind: "publish" }), onAlready: (h) => hits.push(h) });
    assert.equal(await free(), null);
    assert.equal(hits.length, 0);
  });

  it("o timer em publish-shorts.ts passa o callback e confere os collabs do achado da reconferência", () => {
    const src = readFileSync(resolve(ROOT, "scripts/publish-shorts.ts"), "utf8");
    assert.match(src, /instagramTimerBeforePublish\(\{ local: localRecheck, gate: accountGate, onAlready: onRecheckAlready \}\)/);
    const i = src.indexOf("const recheck: { hit:");
    assert.ok(i > 0, "captura do achado da reconferência não encontrada");
    const block = src.slice(i, src.indexOf("continue;", i));
    assert.match(block, /publishReel\(accountGate, \(hit\) =>/);
    assert.match(block, /step\.outcome\.alreadyRegistered && recheck\.hit/);
    assert.match(block, /instagramTimerAlreadyCollabWarnings\(/);
    assert.match(block, /matchedBy: already\.matchedBy/);
  });
});
