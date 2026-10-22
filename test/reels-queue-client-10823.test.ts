/**
 * reels-queue-client-10823.test.ts (#10823)
 *
 * Lado do cliente do Reels agendado pela fila do Worker: o payload que o
 * `POST /queue` recebe (`buildReelsQueuePayload`) e o estado normalizado da
 * entry enfileirada (`resolveWorkerQueueState`, #573 — "agendado" nunca vira
 * "publicado" só porque o enqueue respondeu 202).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildReelsQueuePayload } from "../scripts/lib/worker-queue-client.ts";
import { resolveWorkerQueueState } from "../scripts/lib/publish-state.ts";

describe("#10823 buildReelsQueuePayload", () => {
  it("monta REELS na conta vjpixel com collab e destaque shorts, sem imagem", () => {
    const p = buildReelsQueuePayload({
      caption: "legenda",
      videoUrl: "https://eia.diar.ia.br/video/261022.mp4",
      scheduledAt: "2026-10-22T10:00:00.000Z",
      account: "vjpixel",
      collaborators: ["diar.ia.br"],
    });
    assert.deepEqual(p, {
      text: "legenda",
      image_url: null,
      scheduled_at: "2026-10-22T10:00:00.000Z",
      destaque: "shorts",
      channel: "instagram",
      media_type: "REELS",
      video_url: "https://eia.diar.ia.br/video/261022.mp4",
      collaborators: ["diar.ia.br"],
      ig_account: "vjpixel",
    });
  });

  it("omite collaborators vazio e ig_account ausente (conta default do Worker)", () => {
    const p = buildReelsQueuePayload({ caption: "c", videoUrl: "https://x.test/v.mp4", scheduledAt: "2026-10-22T10:00:00Z", collaborators: [] });
    assert.equal("collaborators" in p, false);
    assert.equal("ig_account" in p, false);
  });

  it("destaque `shorts` é aceito pelo regex do Worker (contrato cliente × servidor)", () => {
    const src = readFileSync(new URL("../workers/linkedin-cron/src/index.ts", import.meta.url), "utf8");
    const m = src.match(/export const QUEUE_DESTAQUE_RE = \/(.+)\/;/);
    assert.ok(m, "QUEUE_DESTAQUE_RE não encontrado");
    assert.ok(new RegExp(m![1]).test(buildReelsQueuePayload({ caption: "c", videoUrl: "https://x", scheduledAt: "x" }).destaque));
  });
});

describe("#10823 resolveWorkerQueueState", () => {
  const now = new Date("2026-10-22T09:00:00Z");
  it("enfileirado com horário futuro → scheduled", () => {
    assert.equal(resolveWorkerQueueState({ key: "queue:x:y", scheduled_at: "2026-10-22T10:00:00Z" }, now), "scheduled");
  });
  it("horário passado sem confirmação → unknown, NUNCA published (#573)", () => {
    assert.equal(resolveWorkerQueueState({ key: "queue:x:y", scheduled_at: "2026-10-22T08:00:00Z" }, now), "unknown");
  });
  it("media_id confirmado → published", () => {
    assert.equal(resolveWorkerQueueState({ key: "queue:x:y", scheduled_at: "2026-10-22T08:00:00Z", media_id: "123" }, now), "published");
  });
  it("sem key → draft; scheduled_at inválido → unknown", () => {
    assert.equal(resolveWorkerQueueState({}, now), "draft");
    assert.equal(resolveWorkerQueueState({ key: "k", scheduled_at: "ontem" }, now), "unknown");
  });
});
