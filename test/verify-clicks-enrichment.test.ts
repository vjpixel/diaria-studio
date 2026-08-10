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
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  verifyClicksApplied,
  extractManifestPostIds,
  findInvariantViolations,
  makeFsCacheStatsReader,
  type CacheMetaReader,
  type CacheStatsReader,
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

function fakeStatsReader(meta: Record<string, { emailAggregate: number; clicksLength: number } | null>): CacheStatsReader {
  return (postId) => (postId in meta ? meta[postId] : null);
}

describe("findInvariantViolations (#4836)", () => {
  it("caso real do incidente: unique_verified_clicks entre 6-28 mas stats.clicks vazio → violação", () => {
    const reader = fakeStatsReader({
      post_a: { emailAggregate: 22, clicksLength: 0 },
    });
    assert.deepEqual(findInvariantViolations(["post_a"], reader), ["post_a"]);
  });

  it("post genuinamente sem clicks (agregado 0, array vazio) NÃO é violação", () => {
    const reader = fakeStatsReader({
      post_a: { emailAggregate: 0, clicksLength: 0 },
    });
    assert.deepEqual(findInvariantViolations(["post_a"], reader), []);
  });

  it("post saudável (agregado > 0, array populado) não é violação", () => {
    const reader = fakeStatsReader({
      post_a: { emailAggregate: 22, clicksLength: 8 },
    });
    assert.deepEqual(findInvariantViolations(["post_a"], reader), []);
  });

  it("cache ilegível/ausente (null) não é tratado como violação — mtime check já cobre isso", () => {
    const reader = fakeStatsReader({ post_a: null });
    assert.deepEqual(findInvariantViolations(["post_a"], reader), []);
  });

  it("mistura de posts: só o que viola entra na lista", () => {
    const reader = fakeStatsReader({
      post_ok: { emailAggregate: 10, clicksLength: 5 },
      post_bad: { emailAggregate: 15, clicksLength: 0 },
      post_zero: { emailAggregate: 0, clicksLength: 0 },
    });
    assert.deepEqual(findInvariantViolations(["post_ok", "post_bad", "post_zero"], reader), ["post_bad"]);
  });
});

describe("makeFsCacheStatsReader — cadeia de fallback do agregado (#4836)", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "verify-clicks-stats-"));
    const postsDir = resolve(dir, "posts");
    mkdirSync(postsDir, { recursive: true });
    return postsDir;
  }

  it("prefere verified_clicks quando presente", () => {
    const postsDir = setup();
    writeFileSync(resolve(postsDir, "post_a.json"), JSON.stringify({
      stats: { email: { verified_clicks: 30, unique_verified_clicks: 20, clicks: 50 }, clicks: [] },
    }));
    const reader = makeFsCacheStatsReader(postsDir);
    assert.deepEqual(reader("post_a"), { emailAggregate: 30, clicksLength: 0 });
  });

  it("cai pra unique_verified_clicks quando verified_clicks ausente", () => {
    const postsDir = setup();
    writeFileSync(resolve(postsDir, "post_a.json"), JSON.stringify({
      stats: { email: { unique_verified_clicks: 20, clicks: 50 }, clicks: [] },
    }));
    const reader = makeFsCacheStatsReader(postsDir);
    assert.deepEqual(reader("post_a"), { emailAggregate: 20, clicksLength: 0 });
  });

  it("cai pro agregado bruto email.clicks quando nem verified nem unique_verified existem — mesma cadeia de identifyPostsNeedingClicks em beehiiv-sync.ts", () => {
    const postsDir = setup();
    writeFileSync(resolve(postsDir, "post_a.json"), JSON.stringify({
      stats: { email: { clicks: 50 }, clicks: [] },
    }));
    const reader = makeFsCacheStatsReader(postsDir);
    assert.deepEqual(reader("post_a"), { emailAggregate: 50, clicksLength: 0 });
  });

  it("cache sem nenhum campo de email → agregado 0, não violação", () => {
    const postsDir = setup();
    writeFileSync(resolve(postsDir, "post_a.json"), JSON.stringify({ stats: { clicks: [] } }));
    const reader = makeFsCacheStatsReader(postsDir);
    assert.deepEqual(reader("post_a"), { emailAggregate: 0, clicksLength: 0 });
  });

  it("post ausente do disco → null", () => {
    const postsDir = setup();
    const reader = makeFsCacheStatsReader(postsDir);
    assert.equal(reader("post_never_synced"), null);
  });

  it("JSON corrompido → null, não lança", () => {
    const postsDir = setup();
    writeFileSync(resolve(postsDir, "post_a.json"), "{ not valid json");
    const reader = makeFsCacheStatsReader(postsDir);
    assert.equal(reader("post_a"), null);
  });
});

describe("verifyClicksApplied — integração do invariante de conteúdo (#4836)", () => {
  it("mtime ok mas invariante violado → ok=false, aparece em invariant_violations, não em mismatches", () => {
    const metaReader = fakeReader({
      post_a: { exists: true, mtimeMs: AFTER_DISPATCH_MS },
    });
    const statsReader = fakeStatsReader({
      post_a: { emailAggregate: 20, clicksLength: 0 },
    });
    const result = verifyClicksApplied(
      { manifestPostIds: ["post_a"], failedPosts: [], dispatchedAt: DISPATCHED_AT },
      metaReader,
      statsReader,
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, []);
    assert.deepEqual(result.invariant_violations, ["post_a"]);
    assert.equal(result.verified_ok_count, 0);
  });

  it("mtime ok e invariante ok → ok=true", () => {
    const metaReader = fakeReader({
      post_a: { exists: true, mtimeMs: AFTER_DISPATCH_MS },
    });
    const statsReader = fakeStatsReader({
      post_a: { emailAggregate: 20, clicksLength: 8 },
    });
    const result = verifyClicksApplied(
      { manifestPostIds: ["post_a"], failedPosts: [], dispatchedAt: DISPATCHED_AT },
      metaReader,
      statsReader,
    );
    assert.equal(result.ok, true);
    assert.equal(result.verified_ok_count, 1);
  });

  it("sem readCacheStats (chamada antiga, 2 argumentos) — invariant_violations sempre [], comportamento pré-#4836 preservado", () => {
    const metaReader = fakeReader({
      post_a: { exists: true, mtimeMs: AFTER_DISPATCH_MS },
    });
    const result = verifyClicksApplied(
      { manifestPostIds: ["post_a"], failedPosts: [], dispatchedAt: DISPATCHED_AT },
      metaReader,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.invariant_violations, []);
  });

  it("post em ambos mismatches e invariant_violations não é contado 2x em verified_ok_count", () => {
    const metaReader = fakeReader({
      post_a: { exists: true, mtimeMs: BEFORE_DISPATCH_MS }, // mtime mismatch
    });
    const statsReader = fakeStatsReader({
      post_a: { emailAggregate: 20, clicksLength: 0 }, // também viola invariante
    });
    const result = verifyClicksApplied(
      { manifestPostIds: ["post_a"], failedPosts: [], dispatchedAt: DISPATCHED_AT },
      metaReader,
      statsReader,
    );
    assert.equal(result.claimed_ok_count, 1);
    assert.equal(result.verified_ok_count, 0);
    assert.deepEqual(result.mismatches, ["post_a"]);
    assert.deepEqual(result.invariant_violations, ["post_a"]);
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
