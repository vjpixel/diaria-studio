/**
 * beehiiv-engagement-manifest.test.ts (#6465)
 *
 * Cobre os helpers puros do manifest de cobertura da extração de
 * per-subscriber engagement: bootstrap, merge não-destrutivo (retomada),
 * upsert de resultado, sumário de cobertura, e a tolerância de shape do
 * parser de arquivo de post.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildInitialManifest,
  mergeManifestPosts,
  upsertEntry,
  pendingEntries,
  coverageSummary,
  extractPostRefFromBackupFile,
  isNeverSentPost,
  NEVER_SENT_REASON,
  type EngagementManifest,
} from "../scripts/lib/beehiiv-engagement-manifest.ts";

describe("buildInitialManifest", () => {
  it("todo post nasce pending", () => {
    const m = buildInitialManifest([{ id: "post_1", title: "A" }, { id: "post_2" }], "2026-08-28T00:00:00.000Z");
    assert.equal(m.posts.length, 2);
    assert.ok(m.posts.every((p) => p.status === "pending"));
    assert.equal(m.posts[0].title, "A");
    assert.equal(m.posts[1].title, undefined);
  });
});

describe("mergeManifestPosts — retomada sem regressão de status", () => {
  it("preserva status ok de posts já processados ao re-descobrir", () => {
    const existing: EngagementManifest = {
      generated_at: "2026-08-27T00:00:00.000Z",
      posts: [
        { post_id: "post_1", title: "A", status: "ok", count: 42 },
        { post_id: "post_2", title: "B", status: "partial", count: 5, pages_fetched: 1, total_pages: 3 },
      ],
    };
    const merged = mergeManifestPosts(existing, [{ id: "post_1", title: "A" }, { id: "post_2", title: "B" }], "2026-08-28T00:00:00.000Z");
    const p1 = merged.posts.find((p) => p.post_id === "post_1")!;
    const p2 = merged.posts.find((p) => p.post_id === "post_2")!;
    assert.equal(p1.status, "ok", "merge nunca rebaixa um post já confirmado");
    assert.equal(p1.count, 42);
    assert.equal(p2.status, "partial", "merge preserva partial — retomada depende disso");
  });

  it("adiciona posts novos descobertos como pending", () => {
    const existing = buildInitialManifest([{ id: "post_1" }], "2026-08-27T00:00:00.000Z");
    const merged = mergeManifestPosts(existing, [{ id: "post_1" }, { id: "post_2", title: "Novo" }], "2026-08-28T00:00:00.000Z");
    assert.equal(merged.posts.length, 2);
    const novo = merged.posts.find((p) => p.post_id === "post_2")!;
    assert.equal(novo.status, "pending");
    assert.equal(novo.title, "Novo");
  });

  it("preenche title que faltava sem tocar o resto da entry", () => {
    const existing: EngagementManifest = {
      generated_at: "x",
      posts: [{ post_id: "post_1", status: "pending" }],
    };
    const merged = mergeManifestPosts(existing, [{ id: "post_1", title: "Título chegou depois" }], "2026-08-28T00:00:00.000Z");
    assert.equal(merged.posts[0].title, "Título chegou depois");
    assert.equal(merged.posts[0].status, "pending");
  });
});

describe("upsertEntry", () => {
  it("substitui a entry existente pelo mesmo post_id", () => {
    const m = buildInitialManifest([{ id: "post_1" }], "x");
    const updated = upsertEntry(m, { post_id: "post_1", status: "ok", count: 10, fetched_at: "2026-08-28T00:00:00.000Z" });
    assert.equal(updated.posts.length, 1);
    assert.equal(updated.posts[0].status, "ok");
    assert.equal(updated.posts[0].count, 10);
  });

  it("adiciona quando o post_id não existia ainda", () => {
    const m = buildInitialManifest([], "x");
    const updated = upsertEntry(m, { post_id: "post_new", status: "ok", count: 1 });
    assert.equal(updated.posts.length, 1);
  });
});

describe("pendingEntries — nunca reoferece ok", () => {
  it("pending/partial/error aparecem; ok não", () => {
    const m: EngagementManifest = {
      generated_at: "x",
      posts: [
        { post_id: "p1", status: "ok" },
        { post_id: "p2", status: "pending" },
        { post_id: "p3", status: "partial" },
        { post_id: "p4", status: "error" },
      ],
    };
    const pending = pendingEntries(m).map((p) => p.post_id);
    assert.deepEqual(pending.sort(), ["p2", "p3", "p4"]);
  });
});

describe("coverageSummary", () => {
  it("closed=true só quando 100% ok", () => {
    const allOk: EngagementManifest = { generated_at: "x", posts: [{ post_id: "p1", status: "ok" }, { post_id: "p2", status: "ok" }] };
    assert.equal(coverageSummary(allOk).closed, true);

    const oneMissing: EngagementManifest = { generated_at: "x", posts: [{ post_id: "p1", status: "ok" }, { post_id: "p2", status: "pending" }] };
    assert.equal(coverageSummary(oneMissing).closed, false);
  });

  it("manifest vazio nunca reporta closed=true (nada processado != gap fechado)", () => {
    const empty: EngagementManifest = { generated_at: "x", posts: [] };
    const summary = coverageSummary(empty);
    assert.equal(summary.total, 0);
    assert.equal(summary.closed, false);
  });

  it("conta cada status corretamente", () => {
    const m: EngagementManifest = {
      generated_at: "x",
      posts: [
        { post_id: "p1", status: "ok" },
        { post_id: "p2", status: "ok" },
        { post_id: "p3", status: "partial" },
        { post_id: "p4", status: "error" },
        { post_id: "p5", status: "pending" },
      ],
    };
    const s = coverageSummary(m);
    assert.deepEqual(s, { total: 5, ok: 2, partial: 1, error: 1, pending: 1, not_applicable: 0, closed: false });
  });
});

describe("extractPostRefFromBackupFile — tolerância de shape", () => {
  it("shape plano (data/beehiiv-cache/posts/*.json)", () => {
    const ref = extractPostRefFromBackupFile({ id: "post_1", title: "T", stats: {} });
    assert.deepEqual(ref, { id: "post_1", title: "T" });
  });

  it("shape aninhado (data/beehiiv-backup/{date}/posts/*.json — resposta REST crua)", () => {
    const ref = extractPostRefFromBackupFile({ data: { id: "post_2", title: "T2" } });
    assert.deepEqual(ref, { id: "post_2", title: "T2" });
  });

  it("shape plano sem title — ok, title fica undefined", () => {
    const ref = extractPostRefFromBackupFile({ id: "post_3" });
    assert.deepEqual(ref, { id: "post_3", title: undefined });
  });

  it("sem id reconhecível em nenhum dos 2 shapes → null", () => {
    assert.equal(extractPostRefFromBackupFile({ foo: "bar" }), null);
    assert.equal(extractPostRefFromBackupFile({ data: { foo: "bar" } }), null);
  });

  it("input não-objeto → null", () => {
    assert.equal(extractPostRefFromBackupFile(null), null);
    assert.equal(extractPostRefFromBackupFile(undefined), null);
    assert.equal(extractPostRefFromBackupFile("string"), null);
    assert.equal(extractPostRefFromBackupFile(42), null);
  });
});

describe("not_applicable — post nunca enviado (#6465)", () => {
  it("isNeverSentPost: draft e publish_date nulo (nos 2 shapes) → true", () => {
    assert.equal(isNeverSentPost({ data: { id: "p", status: "draft", publish_date: null } }), true);
    assert.equal(isNeverSentPost({ id: "p", status: "draft" }), true);
    assert.equal(isNeverSentPost({ id: "p", status: "confirmed", publish_date: null }), true);
  });

  it("isNeverSentPost: post publicado → false; shape sem o campo → false", () => {
    assert.equal(isNeverSentPost({ data: { id: "p", status: "confirmed", publish_date: 1787944034 } }), false);
    assert.equal(isNeverSentPost({ id: "p", title: "T" }), false);
    assert.equal(isNeverSentPost(null), false);
  });

  it("extractPostRefFromBackupFile marca neverSent só quando verdadeiro", () => {
    assert.deepEqual(extractPostRefFromBackupFile({ id: "p1", title: "T", status: "draft" }), {
      id: "p1",
      title: "T",
      neverSent: true,
    });
    assert.deepEqual(extractPostRefFromBackupFile({ id: "p2", title: "T" }), { id: "p2", title: "T" });
  });

  it("mergeManifestPosts: post nunca enviado entra not_applicable e sai de pendingEntries", () => {
    const m = mergeManifestPosts(
      { generated_at: "t0", posts: [] },
      [{ id: "draft1", title: "Rascunho", neverSent: true }, { id: "sent1", title: "Enviado" }],
      "t1",
    );
    const draft = m.posts.find((p) => p.post_id === "draft1");
    assert.equal(draft?.status, "not_applicable");
    assert.equal(draft?.error, NEVER_SENT_REASON);
    assert.deepEqual(pendingEntries(m).map((p) => p.post_id), ["sent1"]);
  });

  it("mergeManifestPosts: rebaixa pending→not_applicable, mas NUNCA rebaixa ok", () => {
    const before: EngagementManifest = {
      generated_at: "t0",
      posts: [
        { post_id: "a", status: "pending" },
        { post_id: "b", status: "ok", count: 10 },
      ],
    };
    const after = mergeManifestPosts(before, [{ id: "a", neverSent: true }, { id: "b", neverSent: true }], "t1");
    assert.equal(after.posts.find((p) => p.post_id === "a")?.status, "not_applicable");
    assert.equal(after.posts.find((p) => p.post_id === "b")?.status, "ok");
  });

  it("coverageSummary: ok + not_applicable == total fecha o gap", () => {
    const s = coverageSummary({
      generated_at: "t",
      posts: [
        { post_id: "a", status: "ok" },
        { post_id: "b", status: "not_applicable" },
      ],
    });
    assert.equal(s.not_applicable, 1);
    assert.equal(s.closed, true);
  });

  it("coverageSummary: not_applicable NÃO mascara partial/error pendente", () => {
    const s = coverageSummary({
      generated_at: "t",
      posts: [
        { post_id: "a", status: "ok" },
        { post_id: "b", status: "not_applicable" },
        { post_id: "c", status: "partial" },
      ],
    });
    assert.equal(s.closed, false);
  });
});
