/**
 * weekly-social-reschedule-12375.test.ts — miolo do `--reschedule` de
 * publish-weekly-social.ts (#12375). Tudo com DELETE injetado/fetch falso:
 * nenhuma chamada real à fila do Worker nem à Graph API.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planWeeklyReschedule,
  executeWeeklyReschedule,
  dropModeEntries,
  markCancelledEntries,
  dropWeekendRotationLines,
  deleteFacebookScheduledPost,
  type RescheduleTarget,
} from "../scripts/lib/weekly-social-reschedule.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

const NOW = new Date("2027-12-26T09:00:00Z"); // 06:00 BRT
const AT = "2027-12-26T08:00:00-03:00"; // 2h depois de NOW

function entry(p: Partial<PostEntry> & { platform: string }): PostEntry {
  return { destaque: "weekly-clicked", url: null, status: "scheduled", scheduled_at: AT, ...p } as PostEntry;
}

const POSTS: PostEntry[] = [
  entry({ platform: "facebook", page: "diaria", fb_post_id: "fb_1" }),
  entry({ platform: "instagram", worker_queue_key: "q:ig" }),
  entry({ platform: "threads", worker_queue_key: "q:th" }),
  entry({ platform: "linkedin", worker_queue_key: "q:li" }),
  entry({ platform: "instagram", destaque: "weekly-highlights", worker_queue_key: "q:hl" }),
  entry({ platform: "facebook", page: "outra", status: "failed", scheduled_at: null }),
];

describe("planWeeklyReschedule", () => {
  it("só entradas scheduled do modo; fila do Worker antes do Facebook", () => {
    const plan = planWeeklyReschedule(POSTS, "weekly-clicked", NOW);
    assert.ok(plan.ok);
    assert.deepEqual(
      plan.targets.map((t) => (t.kind === "facebook" ? `fb:${t.page}:${t.fbPostId}` : `${t.platform}:${t.key}`)),
      ["instagram:q:ig", "threads:q:th", "linkedin:q:li", "fb:diaria:fb_1"],
    );
  });

  it("idempotência: sem nada agendado no modo → plano vazio (segue como agendamento normal)", () => {
    const plan = planWeeklyReschedule(dropModeEntries(POSTS, "weekly-clicked"), "weekly-clicked", NOW);
    assert.deepEqual(plan, { ok: true, targets: [] });
  });

  it("horário antigo já passou → aborta (nenhum alvo)", () => {
    const plan = planWeeklyReschedule(POSTS, "weekly-clicked", new Date("2027-12-26T12:00:00Z"));
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.reason, /já passou/);
  });

  it("dispara em menos de 5 min → aborta", () => {
    const plan = planWeeklyReschedule(POSTS, "weekly-clicked", new Date("2027-12-26T10:57:00Z"));
    assert.equal(plan.ok, false);
  });

  it("scheduled sem worker_queue_key / fb_post_id → aborta", () => {
    assert.equal(planWeeklyReschedule([entry({ platform: "instagram" })], "weekly-clicked", NOW).ok, false);
    assert.equal(planWeeklyReschedule([entry({ platform: "facebook" })], "weekly-clicked", NOW).ok, false);
  });
});

describe("executeWeeklyReschedule", () => {
  const targets: RescheduleTarget[] = [
    { kind: "worker_queue", platform: "instagram", key: "q:ig", scheduledAt: AT },
    { kind: "worker_queue", platform: "threads", key: "q:th", scheduledAt: AT },
    { kind: "facebook", platform: "facebook", page: "diaria", fbPostId: "fb_1", scheduledAt: AT },
  ];

  it("cancela tudo em sequência, na ordem do plano", async () => {
    const calls: string[] = [];
    const r = await executeWeeklyReschedule(targets, {
      deleteQueueKey: async (k) => (calls.push(k), { alreadyGone: false }),
      deleteFacebookPost: async (pg, id) => (calls.push(`${pg}:${id}`), { alreadyGone: false }),
    });
    assert.ok(r.ok);
    assert.deepEqual(calls, ["q:ig", "q:th", "diaria:fb_1"]);
  });

  it("404 no meio → para ali, nenhum DELETE depois", async () => {
    const calls: string[] = [];
    const r = await executeWeeklyReschedule(targets, {
      deleteQueueKey: async (k) => (calls.push(k), { alreadyGone: k === "q:th" }),
      deleteFacebookPost: async () => assert.fail("Facebook não pode ser tentado depois do 404"),
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.deepEqual(r.cancelled.map((t) => t.platform), ["instagram"]);
      assert.equal(r.failedTarget.platform, "threads");
      assert.match(r.reason, /404/);
    }
    assert.deepEqual(calls, ["q:ig", "q:th"]);
  });

  it("erro de rede no 1º DELETE → aborta com nada cancelado", async () => {
    const r = await executeWeeklyReschedule(targets, {
      deleteQueueKey: async () => {
        throw new Error("HTTP 500");
      },
      deleteFacebookPost: async () => assert.fail("não deveria chegar aqui"),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.cancelled.length, 0);
  });
});

describe("registro e rotação", () => {
  it("dropModeEntries tira todas as entradas do modo (scheduled, failed…) e preserva o outro modo", () => {
    const left = dropModeEntries(POSTS, "weekly-clicked");
    assert.deepEqual(left.map((p) => p.destaque), ["weekly-highlights"]);
  });

  it("markCancelledEntries marca só as canceladas como deleted, sem remover nada", () => {
    const cancelled: RescheduleTarget[] = [{ kind: "worker_queue", platform: "instagram", key: "q:ig", scheduledAt: AT }];
    const out = markCancelledEntries(POSTS, "weekly-clicked", cancelled);
    assert.equal(out.length, POSTS.length);
    assert.equal(out[1].status, "deleted");
    assert.equal(out[2].status, "scheduled");
    assert.equal(out[4].status, "scheduled", "mesma plataforma, outro modo: intacta");
  });

  it("dropWeekendRotationLines remove só a linha weekend da data e preserva linha corrompida", () => {
    const content = [
      JSON.stringify({ date: "2027-12-26", kind: "weekend", day: "domingo", time: "08:00" }),
      JSON.stringify({ date: "2027-12-25", kind: "weekend", day: "sabado", time: "11:00" }),
      JSON.stringify({ date: "2027-12-26", kind: "linkedin_article", time: "09:00" }),
      "{lixo",
      "",
    ].join("\n");
    const { content: out, removed } = dropWeekendRotationLines(content, "2027-12-26");
    assert.equal(removed, 1);
    assert.doesNotMatch(out, /"domingo"/);
    assert.match(out, /sabado/);
    assert.match(out, /linkedin_article/);
    assert.match(out, /\{lixo/);
    assert.ok(out.endsWith("\n"), "newline final preservado");
  });
});

describe("deleteFacebookScheduledPost (fetch falso)", () => {
  const fakeFetch = (status: number, body: string) =>
    (async (url: string, init: RequestInit) => {
      assert.equal(init.method, "DELETE");
      assert.doesNotMatch(String(url), /access_token/, "token nunca na query string");
      return new Response(body, { status });
    }) as unknown as typeof fetch;

  it("200 → cancelado", async () => {
    assert.deepEqual(await deleteFacebookScheduledPost("1_2", "tok", "v25.0", fakeFetch(200, '{"success":true}')), { alreadyGone: false });
  });
  it("404 e 400 code 100 → alreadyGone", async () => {
    assert.deepEqual(await deleteFacebookScheduledPost("1_2", "tok", "v25.0", fakeFetch(404, "")), { alreadyGone: true });
    assert.deepEqual(
      await deleteFacebookScheduledPost("1_2", "tok", "v25.0", fakeFetch(400, '{"error":{"code":100,"message":"does not exist"}}')),
      { alreadyGone: true },
    );
  });
  it("outro erro → lança", async () => {
    await assert.rejects(() => deleteFacebookScheduledPost("1_2", "tok", "v25.0", fakeFetch(500, "boom")), /HTTP 500/);
  });
});
