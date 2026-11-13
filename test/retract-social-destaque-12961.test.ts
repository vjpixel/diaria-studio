/**
 * #12961 — cancelar os posts agendados de UM destaque depois do dispatch, para
 * corrigir o texto e re-despachar só ele, sem o risco do script avulso de
 * 261113: limpar o registro com cancelamento não confirmado (404 ambíguo,
 * Worker sem o modo condicional) deixava sair duplicata.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyConditionalCancel, cancelWorkerQueueEntryConditional } from "../scripts/lib/worker-queue-client.ts";
import {
  executeRetraction,
  planRetraction,
  removeCancelledEntries,
  retractFacebookScheduledPost,
  FB_MIN_LEAD_SEC,
} from "../scripts/retract-social-destaque.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

const POSTS: PostEntry[] = [
  { platform: "facebook", page: "diaria", destaque: "d3", url: "u", status: "scheduled", scheduled_at: "x", fb_post_id: "fb-d3" },
  { platform: "facebook", page: "diaria", destaque: "d1", url: "u", status: "scheduled", scheduled_at: "x", fb_post_id: "fb-d1" },
  { platform: "linkedin", destaque: "d3", subtype: "main", url: null, status: "scheduled", scheduled_at: "x", route: "worker_queue", worker_queue_key: "queue:li-d3" },
  { platform: "instagram", destaque: "d3", url: null, status: "scheduled", scheduled_at: "x", worker_queue_key: "queue:ig-d3" },
  { platform: "threads", destaque: "d3", url: null, status: "published", scheduled_at: "x", worker_queue_key: "queue:th-d3" },
  { platform: "twitter", destaque: "d3", url: null, status: "scheduled", scheduled_at: "x", buffer_post_id: "buf-d3" },
];

describe("classifyConditionalCancel (#12961)", () => {
  const ok = JSON.stringify({ deleted: true, conditional: true, do_alarm_cancelled: true, kv_deleted: true, tombstoned: false });
  it("só 200 com a confirmação condicional completa vira cancelled", () => {
    assert.equal(classifyConditionalCancel("k", 200, ok).outcome, "cancelled");
    assert.equal(
      classifyConditionalCancel("k", 200, JSON.stringify({ deleted: true, conditional: true, do_alarm_cancelled: true, kv_deleted: false, tombstoned: true })).outcome,
      "cancelled",
    );
  });
  it("Worker antigo (200 do DELETE incondicional, sem `conditional`) é unconfirmed", () => {
    const legacy = JSON.stringify({ deleted: true, key: "k", do_alarm_cancelled: false, kv_deleted: true });
    assert.equal(classifyConditionalCancel("k", 200, legacy).outcome, "unconfirmed");
  });
  it("404 é not_found (ambíguo), 409 é refused com o motivo, 5xx é error", () => {
    assert.equal(classifyConditionalCancel("k", 404, "{}").outcome, "not_found");
    const r = classifyConditionalCancel("k", 409, JSON.stringify({ reason: "already_fired" }));
    assert.deepEqual(r, { outcome: "refused", key: "k", reason: "already_fired" });
    assert.equal(classifyConditionalCancel("k", 502, "boom").outcome, "error");
  });
  it("cliente usa POST /queue-cancel/ (nunca o DELETE, que um Worker antigo faria incondicional) e não lança em erro de rede", async () => {
    let seen = "";
    let method = "";
    const r = await cancelWorkerQueueEntryConditional("https://w.test/", "t", "queue:a:b", (async (u: string, init?: RequestInit) => {
      seen = u;
      method = init?.method ?? "";
      return new Response(JSON.stringify({ deleted: true, conditional: true, do_alarm_cancelled: true, kv_deleted: true }), { status: 200 });
    }) as unknown as typeof fetch);
    assert.equal(r.outcome, "cancelled");
    assert.equal(seen, "https://w.test/queue-cancel/queue:a:b");
    assert.equal(method, "POST");
    const e = await cancelWorkerQueueEntryConditional("https://w.test", "t", "k", (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch);
    assert.equal(e.outcome, "error");
  });
});

describe("planRetraction (#12961)", () => {
  it("só o destaque pedido; publicado é skip; X é manual; Worker e Facebook canceláveis", () => {
    const plan = planRetraction(POSTS, "d3", ["facebook", "linkedin", "instagram", "threads", "twitter"]);
    const byPlatform = Object.fromEntries(plan.map((t) => [t.entry.platform, t.action]));
    assert.deepEqual(byPlatform, { facebook: "facebook", linkedin: "worker", instagram: "worker", threads: "skip", twitter: "manual" });
    assert.ok(plan.every((t) => t.entry.destaque === "d3"));
  });
  it("--channels filtra", () => {
    assert.deepEqual(planRetraction(POSTS, "d3", ["instagram"]).map((t) => t.identifier), ["queue:ig-d3"]);
  });
});

describe("executeRetraction (#12961)", () => {
  it("sem --confirm não chama rede nenhuma", async () => {
    const plan = planRetraction(POSTS, "d3", ["facebook", "linkedin", "instagram"]);
    const results = await executeRetraction(plan, false, {
      cancelWorker: async () => assert.fail("rede no dry-run"),
      retractFacebook: async () => assert.fail("rede no dry-run"),
    });
    assert.deepEqual(results.map((r) => r.status), ["dry_run", "dry_run", "dry_run"]);
  });
  it("com --confirm: cada alvo leva o resultado do seu canal", async () => {
    const plan = planRetraction(POSTS, "d3", ["facebook", "linkedin", "instagram"]);
    const results = await executeRetraction(plan, true, {
      cancelWorker: async (key) =>
        key === "queue:li-d3" ? { outcome: "cancelled", key, kvDeleted: true, tombstoned: false } : { outcome: "refused", key, reason: "already_fired" },
      retractFacebook: async () => ({ outcome: "not_found" }),
    });
    const by = Object.fromEntries(results.map((r) => [r.platform, r.status]));
    assert.deepEqual(by, { facebook: "not_found", linkedin: "cancelled", instagram: "refused" });
  });
});

describe("removeCancelledEntries (#12961)", () => {
  it("tira só a entrada confirmada, pela chave + identificador", () => {
    const li = POSTS[2];
    const { posts, removed } = removeCancelledEntries([...POSTS], [{ entry: li, identifier: "queue:li-d3" }]);
    assert.deepEqual(removed.map((p) => p.worker_queue_key), ["queue:li-d3"]);
    assert.equal(posts.length, POSTS.length - 1);
  });
  it("entrada regravada com outra key no meio do caminho fica", () => {
    const regravada = { ...POSTS[2], worker_queue_key: "queue:li-d3-novo" };
    const { removed } = removeCancelledEntries([regravada], [{ entry: POSTS[2], identifier: "queue:li-d3" }]);
    assert.equal(removed.length, 0);
  });
});

describe("retractFacebookScheduledPost (#12961)", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const nowSec = now.getTime() / 1000;
  function fake(info: unknown, getStatus = 200, delStatus = 200, delBody = "{}") {
    const calls: string[] = [];
    const impl = (async (_u: string, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if ((init?.method ?? "GET") === "GET") return new Response(JSON.stringify(info), { status: getStatus });
      return new Response(delBody, { status: delStatus });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }
  it("agendado com folga: apaga", async () => {
    const f = fake({ is_published: false, scheduled_publish_time: nowSec + 3600 });
    assert.deepEqual(await retractFacebookScheduledPost("p", "t", "v25.0", now, f.impl), { outcome: "cancelled" });
    assert.deepEqual(f.calls, ["GET", "DELETE"]);
  });
  it("já publicado: recusa sem DELETE", async () => {
    const f = fake({ is_published: true });
    assert.equal((await retractFacebookScheduledPost("p", "t", "v25.0", now, f.impl)).outcome, "refused");
    assert.deepEqual(f.calls, ["GET"]);
  });
  it("sai em menos que a folga: recusa", async () => {
    const f = fake({ is_published: false, scheduled_publish_time: nowSec + FB_MIN_LEAD_SEC - 1 });
    assert.equal((await retractFacebookScheduledPost("p", "t", "v25.0", now, f.impl)).outcome, "refused");
  });
  it("objeto inexistente (código 100) é not_found, nunca cancelled", async () => {
    const f = fake({ error: { code: 100 } }, 400);
    assert.equal((await retractFacebookScheduledPost("p", "t", "v25.0", now, f.impl)).outcome, "not_found");
  });
});
