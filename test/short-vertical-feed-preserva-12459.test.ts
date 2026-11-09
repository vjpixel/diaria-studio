/**
 * #12459: a re-execução do `--update-scheduled` (inclusive a do timer do
 * corte) no caminho `update_youtube` substituía o objeto `cover` inteiro e um
 * `vertical_feed: "studio_web"` (capa do feed aplicada no Studio web, Passo
 * B3a) voltava a `"manual"`, reabrindo o aviso de capa vertical pendente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeScheduledUpdates } from "../scripts/publish-shorts.ts";
import { planScheduledUpdates } from "../scripts/lib/diaria/short-scheduled-update.ts";
import { keepStudioWebVerticalFeed, youtubeShortsCoverRecord } from "../scripts/lib/diaria/short-cover.ts";
import type { ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";

const AT = "2026-11-09T09:30:00.000Z";
const NOW = new Date("2026-11-09T03:00:00Z");
const D1 = { title: "Tratar IA como humano", body: "Gancho do corte. Resto." };

async function runUpdate(prior: ShortPublishedEntry["cover"]) {
  const entries: ShortPublishedEntry[] = [
    { destination: "youtube_shorts", status: "scheduled", id: "yt1", scheduled_at: AT, at: "t", ...(prior ? { cover: prior } : {}) },
  ];
  const items = planScheduledUpdates({ entries, d1: D1, now: NOW, coverPresent: true, only: ["youtube_shorts"] });
  const persisted: ShortPublishedEntry[] = [];
  const results = await executeScheduledUpdates(items, entries, Buffer.from("jpg"), {
    youtube: async () => ({ thumbnail: { attempted: true, ok: true, error: null } }),
    facebook: async () => ({ cover: null }),
    persist: (e) => persisted.push(e),
    now: () => NOW,
  });
  return { persisted, results };
}

describe("#12459 re-execução preserva vertical_feed studio_web", () => {
  it("registro com studio_web: continua studio_web e o aviso de capa vertical não reaparece", async () => {
    const { persisted, results } = await runUpdate({ method: "thumbnails_set", ok: true, vertical_feed: "studio_web" });
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0].cover, { method: "thumbnails_set", ok: true, vertical_feed: "studio_web" });
    assert.equal(results[0].ok, true);
    assert.doesNotMatch((results[0].warnings ?? []).join("\n"), /feed de Shorts não muda pela API/);
  });

  it("registro ainda manual (ou sem capa): segue manual, com o aviso", async () => {
    for (const prior of [{ method: "thumbnails_set" as const, ok: true, vertical_feed: "manual" as const }, undefined]) {
      const { persisted, results } = await runUpdate(prior);
      assert.deepEqual(persisted[0].cover, { method: "thumbnails_set", ok: true, vertical_feed: "manual" });
      assert.match((results[0].warnings ?? []).join("\n"), /feed de Shorts não muda pela API/);
    }
  });

  it("falha do thumbnails.set grava a falha mas preserva o studio_web (review do PR #12489)", () => {
    const failed = youtubeShortsCoverRecord({ attempted: true, ok: false, error: "403" });
    assert.deepEqual(keepStudioWebVerticalFeed(failed, { method: "thumbnails_set", ok: true, vertical_feed: "studio_web" }), {
      method: "thumbnails_set",
      ok: false,
      error: "403",
      vertical_feed: "studio_web",
    });
    // Sem studio_web anterior, a falha segue como veio (sem vertical_feed).
    assert.deepEqual(keepStudioWebVerticalFeed(failed, { method: "thumbnails_set", ok: true, vertical_feed: "manual" }), failed);
    assert.equal(keepStudioWebVerticalFeed(null, { method: "thumbnails_set", ok: true, vertical_feed: "studio_web" }), null);
  });
});
