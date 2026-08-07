/**
 * test/verify-clicks-enrichment.test.ts (#4732)
 *
 * Regressão: `beehiiv-clicks-enricher` pode retornar summary alegando sucesso
 * sem de fato ter escrito `data/beehiiv-cache/posts/{post_id}.json` (agent
 * desviou do processo fetch→apply sem erro explícito no summary). Caso real
 * 260807: 22 posts alegados `ok`, mtime do cache inalterado desde o dispatch.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  verifyClicksApplied,
  extractManifestPostIds,
  type CacheMetaReader,
} from "../scripts/verify-clicks-enrichment.ts";

const DISPATCHED_AT = "2026-08-07T10:00:00.000Z";
const BEFORE_DISPATCH_MS = Date.parse(DISPATCHED_AT) - 60_000;
const AFTER_DISPATCH_MS = Date.parse(DISPATCHED_AT) + 60_000;

function fakeReader(meta: Record<string, { exists: boolean; mtimeMs: number }>): CacheMetaReader {
  return (postId) => meta[postId] ?? { exists: false, mtimeMs: 0 };
}

describe("verifyClicksApplied (#4732)", () => {
  it("caso real 260807: agent alega ok mas cache nunca foi tocado (mtime anterior ao dispatch) → mismatch", () => {
    const reader = fakeReader({
      post_a: { exists: true, mtimeMs: BEFORE_DISPATCH_MS }, // cache existe mas é STALE — não foi tocado nesta run
    });
    const result = verifyClicksApplied(
      { manifestPostIds: ["post_a"], failedPosts: [], dispatchedAt: DISPATCHED_AT },
      reader,
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, ["post_a"]);
    assert.equal(result.claimed_ok_count, 1);
    assert.equal(result.verified_ok_count, 0);
  });

  it("cache atualizado depois do dispatch → verificado, sem mismatch", () => {
    const reader = fakeReader({
      post_a: { exists: true, mtimeMs: AFTER_DISPATCH_MS },
    });
    const result = verifyClicksApplied(
      { manifestPostIds: ["post_a"], failedPosts: [], dispatchedAt: DISPATCHED_AT },
      reader,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.mismatches, []);
    assert.equal(result.verified_ok_count, 1);
  });

  it("post em failed_posts é excluído da checagem — falha já é honesta, não precisa verificação extra", () => {
    const reader = fakeReader({}); // cache nem existe — mas não importa, foi declarado failed
    const result = verifyClicksApplied(
      { manifestPostIds: ["post_a", "post_b"], failedPosts: ["post_a"], dispatchedAt: DISPATCHED_AT },
      reader,
    );
    assert.equal(result.claimed_ok_count, 1); // só post_b é "claimed ok"
    assert.equal(result.ok, false); // post_b não tem cache — mismatch
    assert.deepEqual(result.mismatches, ["post_b"]);
  });

  it("post sem clicks reais (mtime atualizado, array vazio) é resultado LEGÍTIMO — sinal é mtime, não conteúdo", () => {
    // apply-mcp-clicks.ts sempre atualiza mtime via write atômico, mesmo
    // quando o array de clicks aplicado é []. Não devemos exigir clicks
    // não-vazios — só que o arquivo tenha sido tocado de fato.
    const reader = fakeReader({
      post_a: { exists: true, mtimeMs: AFTER_DISPATCH_MS },
    });
    const result = verifyClicksApplied(
      { manifestPostIds: ["post_a"], failedPosts: [], dispatchedAt: DISPATCHED_AT },
      reader,
    );
    assert.equal(result.ok, true);
  });

  it("cache ausente por completo (nunca sincronizado) → mismatch", () => {
    const reader = fakeReader({});
    const result = verifyClicksApplied(
      { manifestPostIds: ["post_never_synced"], failedPosts: [], dispatchedAt: DISPATCHED_AT },
      reader,
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, ["post_never_synced"]);
  });

  it("manifest vazio → ok trivialmente, zero claims", () => {
    const result = verifyClicksApplied(
      { manifestPostIds: [], failedPosts: [], dispatchedAt: DISPATCHED_AT },
      fakeReader({}),
    );
    assert.equal(result.ok, true);
    assert.equal(result.claimed_ok_count, 0);
  });

  it("dispatchedAt inválido nunca aceita silenciosamente — vira mismatch visível", () => {
    const reader = fakeReader({
      post_a: { exists: true, mtimeMs: AFTER_DISPATCH_MS },
    });
    const result = verifyClicksApplied(
      { manifestPostIds: ["post_a"], failedPosts: [], dispatchedAt: "not-a-date" },
      reader,
    );
    assert.equal(result.ok, false, "timestamp inválido deve reprovar, não passar por acidente");
  });
});

describe("extractManifestPostIds (#4732)", () => {
  it("aceita shape posts_needing_clicks ({id, title, email_clicks}[])", () => {
    const ids = extractManifestPostIds([
      { id: "post_a", title: "X", email_clicks: 5 },
      { id: "post_b", title: "Y", email_clicks: 2 },
    ]);
    assert.deepEqual(ids, ["post_a", "post_b"]);
  });

  it("aceita array nu de ids (string[])", () => {
    assert.deepEqual(extractManifestPostIds(["post_a", "post_b"]), ["post_a", "post_b"]);
  });

  it("input inválido (não-array) → []", () => {
    assert.deepEqual(extractManifestPostIds({ not: "an array" }), []);
    assert.deepEqual(extractManifestPostIds(null), []);
  });

  it("ignora entries malformadas (sem id)", () => {
    assert.deepEqual(extractManifestPostIds([{ title: "sem id" }, { id: "post_a" }]), ["post_a"]);
  });
});
