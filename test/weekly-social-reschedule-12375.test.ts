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
  dropRescheduledEntries,
  markCancelledEntries,
  rescheduleLeadProblem,
  dropWeekendRotationLines,
  deleteFacebookScheduledPost,
  targetLabel,
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
    const all = planWeeklyReschedule(POSTS, "weekly-clicked", NOW);
    assert.ok(all.ok);
    const after = dropRescheduledEntries(POSTS, "weekly-clicked", all.targets, ["diaria"]);
    assert.deepEqual(planWeeklyReschedule(after, "weekly-clicked", NOW), { ok: true, targets: [], outOfScope: [] });
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
      now: () => NOW, // #12397: relógio fixo, senão o teste vence quando o relógio real passar de AT
    });
    assert.ok(r.ok);
    assert.deepEqual(calls, ["q:ig", "q:th", "diaria:fb_1"]);
  });

  it("404 no meio → para ali, nenhum DELETE depois", async () => {
    const calls: string[] = [];
    const r = await executeWeeklyReschedule(targets, {
      deleteQueueKey: async (k) => (calls.push(k), { alreadyGone: k === "q:th" }),
      deleteFacebookPost: async () => assert.fail("Facebook não pode ser tentado depois do 404"),
      now: () => NOW,
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
      now: () => NOW,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.cancelled.length, 0);
  });
});

describe("registro e rotação", () => {
  it("dropRescheduledEntries tira as canceladas e as failed de canal redespachado; preserva o outro modo", () => {
    const plan = planWeeklyReschedule(POSTS, "weekly-clicked", NOW);
    assert.ok(plan.ok);
    // página "outra" está failed e é redespachada → sai; nada do modo sobra.
    const left = dropRescheduledEntries(POSTS, "weekly-clicked", plan.targets, ["diaria", "outra"]);
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

type EntryInit = Partial<PostEntry> & { platform: string } & Record<string, unknown>;

describe("#12397: --reschedule não apaga published/send_unknown/X nem cancela com a margem vencida", () => {
  it("caso da issue: IG já published (reconciliado) + FB ausente → plano ABORTA (antes saía vazio e redespachava por cima)", () => {
    const posts: PostEntry[] = [
      entry({ platform: "instagram", status: "published", worker_queue_key: "q:ig", published_at: "2027-12-26T11:00:05Z" } as EntryInit),
      entry({ platform: "threads", status: "published", worker_queue_key: "q:th" }),
    ];
    const plan = planWeeklyReschedule(posts, "weekly-clicked", NOW);
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.reason, /instagram\/weekly-clicked já está "published"/);
  });

  it("send_unknown (pode ter saído) também aborta, mesmo com outra entrada ainda scheduled", () => {
    const posts: PostEntry[] = [
      entry({ platform: "instagram", worker_queue_key: "q:ig" }),
      entry({ platform: "linkedin", status: "send_unknown", worker_queue_key: "q:li" }),
    ];
    const plan = planWeeklyReschedule(posts, "weekly-clicked", NOW);
    assert.equal(plan.ok, false);
    if (!plan.ok) assert.match(plan.reason, /send_unknown/);
  });

  it("published de OUTRO modo não bloqueia", () => {
    const posts: PostEntry[] = [
      entry({ platform: "instagram", worker_queue_key: "q:ig" }),
      entry({ platform: "instagram", destaque: "weekly-highlights", status: "published" }),
    ];
    assert.ok(planWeeklyReschedule(posts, "weekly-clicked", NOW).ok);
  });

  it("X (twitter) scheduled no registro: fora do plano, não bloqueia os outros canais, volta em outOfScope", () => {
    const posts: PostEntry[] = [
      entry({ platform: "twitter", buffer_post_id: "bf_1" } as EntryInit),
      entry({ platform: "instagram", worker_queue_key: "q:ig" }),
    ];
    const plan = planWeeklyReschedule(posts, "weekly-clicked", NOW);
    assert.ok(plan.ok);
    if (plan.ok) {
      assert.deepEqual(plan.targets.map(targetLabel), ["instagram"]);
      assert.deepEqual(plan.outOfScope, ["twitter (scheduled)"]);
    }
  });

  it("X published/failed sobrevive ao registro pós-cancelamento (o guard do prep-weekly-twitter perdia a prova)", () => {
    const posts: PostEntry[] = [
      entry({ platform: "twitter", status: "published" }),
      entry({ platform: "twitter", status: "failed", scheduled_at: null }),
      entry({ platform: "instagram", worker_queue_key: "q:ig" }),
    ];
    const plan = planWeeklyReschedule(posts, "weekly-clicked", NOW);
    assert.ok(plan.ok);
    if (!plan.ok) return;
    const left = dropRescheduledEntries(posts, "weekly-clicked", plan.targets, []);
    assert.deepEqual(
      left.map((p) => `${p.platform}:${p.status}`),
      ["twitter:published", "twitter:failed"],
      "só a entrada cancelada do Instagram sai",
    );
  });

  it("Facebook cancelado de página que NÃO volta no redespacho vira 'deleted' (não some, não fica scheduled)", () => {
    const posts: PostEntry[] = [entry({ platform: "facebook", page: "memelab", fb_post_id: "fb_m" })];
    const plan = planWeeklyReschedule(posts, "weekly-clicked", NOW);
    assert.ok(plan.ok);
    if (!plan.ok) return;
    const left = dropRescheduledEntries(posts, "weekly-clicked", plan.targets, ["diaria"]);
    assert.equal(left.length, 1);
    assert.equal(left[0].status, "deleted");
    assert.equal(left[0].reason, "reschedule_cancelled_not_redispatched");
  });

  it("failed de página do Facebook que não é redespachada fica no registro", () => {
    const posts: PostEntry[] = [entry({ platform: "facebook", page: "outra", status: "failed", scheduled_at: null })];
    assert.equal(dropRescheduledEntries(posts, "weekly-clicked", [], ["diaria"]).length, 1);
  });

  it("margem vencida ENTRE o plano e o cancelamento: nenhum DELETE (o plano passou com o relógio do início)", async () => {
    const fb = entry({ platform: "facebook", page: "diaria", fb_post_id: "fb_1" });
    const plan = planWeeklyReschedule([fb], "weekly-clicked", NOW); // 06:00 BRT, post às 08:00 → ok
    assert.ok(plan.ok);
    if (!plan.ok) return;
    // DELETE só às 07:57 BRT (imagens + upload demoraram) → dentro dos 5 min
    const r = await executeWeeklyReschedule(plan.targets, {
      deleteQueueKey: async () => assert.fail("sem fila"),
      deleteFacebookPost: async () => assert.fail("DELETE no Facebook com a margem vencida apagaria o post publicado"),
      now: () => new Date("2027-12-26T10:57:00Z"),
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.cancelled.length, 0);
      assert.match(r.reason, /margem reavaliada antes do DELETE/);
    }
  });

  it("margem vence no meio: fila cancelada, Facebook não é tentado", async () => {
    const targets: RescheduleTarget[] = [
      { kind: "worker_queue", platform: "instagram", key: "q:ig", scheduledAt: AT },
      { kind: "facebook", platform: "facebook", page: "diaria", fbPostId: "fb_1", scheduledAt: AT },
    ];
    let t = new Date("2027-12-26T10:50:00Z").getTime();
    const r = await executeWeeklyReschedule(targets, {
      deleteQueueKey: async () => {
        t += 6 * 60 * 1000; // o DELETE da fila "demora" 6 min
        return { alreadyGone: false };
      },
      deleteFacebookPost: async () => assert.fail("não pode chegar ao Facebook"),
      now: () => new Date(t),
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.deepEqual(r.cancelled.map((x) => x.platform), ["instagram"]);
      assert.equal(r.failedTarget.platform, "facebook");
    }
  });

  it("rescheduleLeadProblem: null com folga, motivo sem folga ou com horário ilegível", () => {
    assert.equal(rescheduleLeadProblem("ig", AT, NOW), null);
    assert.match(rescheduleLeadProblem("ig", AT, new Date("2027-12-26T10:56:00Z")) ?? "", /menos de 5 min/);
    assert.match(rescheduleLeadProblem("ig", "", NOW) ?? "", /sem scheduled_at legível/);
  });
});
