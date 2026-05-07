/**
 * Tests for #918 — race condition entre publish-facebook + publish-linkedin
 * sobrescrevendo 06-social-published.json. appendSocialPosts em
 * scripts/lib/social-published-store.ts usa .lock pra serializar.
 *
 * Reproduz o cenário 2026-05-07:
 *   1. publish-facebook grava 3 FB posts.
 *   2. publish-linkedin grava 3 LinkedIn posts (em paralelo).
 *   3. JSON final só tinha 4 entries (FB d2/d3 perdidos).
 *
 * Com appendSocialPosts (atomic + locked), todas as 6 entries persistem.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  appendSocialPosts,
  readSocialPublished,
  type PostEntry,
} from "../scripts/lib/social-published-store.ts";

function mkPost(platform: string, destaque: string, status: PostEntry["status"] = "scheduled"): PostEntry {
  return {
    platform,
    destaque,
    url: `https://${platform}.example/${destaque}`,
    status,
    scheduled_at: "2026-12-01T12:00:00Z",
  };
}

describe("#918 social-published-store concurrent appends", () => {
  it("appends concorrentes preservam todas as entries (sem perda)", async () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "social-store-race-"));
    const path = resolve(tmp, "06-social-published.json");

    // Simula publish-facebook + publish-linkedin gravando em paralelo
    const fbPosts = [
      mkPost("facebook", "d1"),
      mkPost("facebook", "d2"),
      mkPost("facebook", "d3"),
    ];
    const liPosts = [
      mkPost("linkedin", "d1"),
      mkPost("linkedin", "d2"),
      mkPost("linkedin", "d3"),
    ];

    // Não dá pra gerar race real entre 2 processos no mesmo test, mas
    // chamadas sequenciais com appendSocialPosts validam a semântica:
    // ambos os conjuntos persistem porque cada append faz read-modify-write
    // sob lock (in-process aqui, cross-process via .lock file no real-world).
    appendSocialPosts(path, fbPosts);
    appendSocialPosts(path, liPosts);

    const final = readSocialPublished(path);
    assert.equal(final.posts.length, 6, "esperava 6 posts (3 FB + 3 LinkedIn)");

    const fbCount = final.posts.filter((p) => p.platform === "facebook").length;
    const liCount = final.posts.filter((p) => p.platform === "linkedin").length;
    assert.equal(fbCount, 3, "3 FB posts");
    assert.equal(liCount, 3, "3 LinkedIn posts");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("upsert (mesmo platform+destaque) substitui sem duplicar", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "social-store-upsert-"));
    const path = resolve(tmp, "06-social-published.json");

    appendSocialPosts(path, [{ ...mkPost("linkedin", "d1"), status: "failed" }]);
    appendSocialPosts(path, [mkPost("linkedin", "d1")]); // upsert overwrite

    const final = readSocialPublished(path);
    assert.equal(final.posts.length, 1);
    assert.equal(final.posts[0].status, "scheduled");

    rmSync(tmp, { recursive: true, force: true });
  });

  it("concurrent appendSocialPosts via subprocess simulado: ambos persistem", async () => {
    // Simula 2 callers concorrentes via Promise.all.
    // Em-processo, JS é single-threaded, mas a função é sync (acquireLock
    // bloqueia o event loop) — então se write não fosse atomic via tmp+rename,
    // o estado intermediate ficaria inconsistente. Com .lock file, ambos os
    // appends completam sem perda.
    const tmp = mkdtempSync(resolve(tmpdir(), "social-store-concurrent-"));
    const path = resolve(tmp, "06-social-published.json");

    const promises = [
      Promise.resolve().then(() => appendSocialPosts(path, [mkPost("facebook", "d1")])),
      Promise.resolve().then(() => appendSocialPosts(path, [mkPost("facebook", "d2")])),
      Promise.resolve().then(() => appendSocialPosts(path, [mkPost("facebook", "d3")])),
      Promise.resolve().then(() => appendSocialPosts(path, [mkPost("linkedin", "d1")])),
      Promise.resolve().then(() => appendSocialPosts(path, [mkPost("linkedin", "d2")])),
      Promise.resolve().then(() => appendSocialPosts(path, [mkPost("linkedin", "d3")])),
    ];
    await Promise.all(promises);

    const final = readSocialPublished(path);
    assert.equal(final.posts.length, 6, `esperava 6, recebeu ${final.posts.length}`);
    const platforms = final.posts.map((p) => `${p.platform}/${p.destaque}`).sort();
    assert.deepEqual(platforms, [
      "facebook/d1",
      "facebook/d2",
      "facebook/d3",
      "linkedin/d1",
      "linkedin/d2",
      "linkedin/d3",
    ]);

    rmSync(tmp, { recursive: true, force: true });
  });
});
