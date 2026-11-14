import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileVideoFile, reconcileVideoRecord } from "../scripts/reconcile-published-videos.ts";
const now = new Date("2026-11-14T20:00:00Z");
const entry = { destination: "facebook:diaria", status: "scheduled", id: "123", scheduled_at: "2026-11-13T15:00:00Z", at: "2026-11-12T00:00:00Z" };

describe("#13009 reconciliação de vídeos pós-disparo", () => {
  it("Reel publicado exige confirmação, sem inferir pelo horário vencido", () => {
    assert.equal(reconcileVideoRecord(entry, {}, now), entry);
    const result = reconcileVideoRecord(entry, { published: true, url: "https://example.com/reel/123" }, now);
    assert.equal(result.status, "published");
    assert.equal(result.url, "https://example.com/reel/123");
  });
  it("vencido não público vira send_unknown sem abrir repost", () => {
    assert.equal(reconcileVideoRecord(entry, { published: false }, now).status, "send_unknown");
    assert.equal(reconcileVideoRecord(entry, { published: false, scheduledAt: "2026-11-15T15:00:00Z" }, now), entry);
    assert.equal(reconcileVideoRecord({ ...entry, scheduled_at: "2026-11-14T19:00:00Z" }, { published: false }, now).status, "scheduled");
  });
  it("Short público guarda horário real; cancelado fica intocado", () => {
    const observation = { published: true, publishedAt: "2026-11-13T15:02:00Z" };
    assert.equal(reconcileVideoRecord({ ...entry, destination: "youtube_shorts" }, observation, now).published_at, observation.publishedAt);
    const cancelled = { ...entry, cancelled_at: now.toISOString() };
    assert.equal(reconcileVideoRecord(cancelled, observation, now), cancelled);
  });
  it("horizontal usa state e requested.publishAt, preservando metadados do upload", () => {
    const horizontal = { videoId: "abc", state: "scheduled", requested: { publishAt: entry.scheduled_at }, title: "Título" };
    assert.equal(reconcileVideoRecord(horizontal, { published: true }, now, true).state, "published");
    const result = reconcileVideoRecord(horizontal, { published: false }, now, true);
    assert.equal(result.state, "unknown");
    assert.equal(result.title, "Título");
  });
  it("erro de API preserva bytes, dry-run não grava e escrita concorrente não se perde", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "video-reconcile-")), "registry.json");
    const initial = JSON.stringify({ entries: [entry] });
    writeFileSync(path, initial);
    await reconcileVideoFile(path, async () => { throw new Error("HTTP 500"); }, now);
    assert.equal(readFileSync(path, "utf8"), initial);
    await reconcileVideoFile(path, async () => ({ published: true }), now, true);
    assert.equal(readFileSync(path, "utf8"), initial);
    const other = { ...entry, id: "456", destination: "youtube_shorts" };
    await reconcileVideoFile(path, async () => {
      writeFileSync(path, JSON.stringify({ entries: [entry, other], extra: "keep" }));
      return { published: true };
    }, now);
    const result = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(result.entries[0].status, "published");
    assert.deepEqual(result.entries[1], other);
    assert.equal(result.extra, "keep");
  });
  it("não sobrescreve cancelamento/reagendamento durante a leitura", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "video-reconcile-")), "registry.json");
    writeFileSync(path, JSON.stringify({ entries: [entry] }));
    const changed = { ...entry, cancelled_at: now.toISOString() };
    await reconcileVideoFile(path, async () => {
      writeFileSync(path, JSON.stringify({ entries: [changed] }));
      return { published: true };
    }, now);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).entries, [changed]);
  });
});
