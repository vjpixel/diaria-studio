/**
 * weekly-social-reschedule-12419.test.ts — #12419 item 2: no `--reschedule`
 * de publish-weekly-social.ts, o alvo cujo DELETE LANÇOU (timeout, corte de
 * rede depois de o servidor aceitar) fica `cancelling` (estado desconhecido)
 * em vez de voltar a `scheduled` com a chave de um post talvez já apagado —
 * que a próxima rodada normal pularia sem alarme. 404 e margem vencida
 * continuam voltando a `scheduled`, como antes.
 *
 * Tudo com DELETE e regravação injetados: nenhuma chamada real à fila do
 * Worker nem à Graph API.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cancelAndRecordReschedule,
  executeWeeklyReschedule,
  planWeeklyReschedule,
  settleAbortedReschedule,
  type RescheduleRecordDeps,
  type RescheduleTarget,
} from "../scripts/lib/weekly-social-reschedule.ts";
import type { PostEntry } from "../scripts/lib/social-published-store.ts";

const NOW = new Date("2027-12-26T09:00:00Z"); // 06:00 BRT
const AT = "2027-12-26T08:00:00-03:00"; // 2h depois de NOW

function entry(p: Partial<PostEntry> & { platform: string }): PostEntry {
  return { destaque: "weekly-clicked", url: null, status: "scheduled", scheduled_at: AT, ...p } as PostEntry;
}

const POSTS: PostEntry[] = [
  entry({ platform: "instagram", worker_queue_key: "q:ig" }),
  entry({ platform: "threads", worker_queue_key: "q:th" }),
  entry({ platform: "facebook", page: "diaria", fb_post_id: "fb_1" }),
  entry({ platform: "instagram", destaque: "weekly-highlights", worker_queue_key: "q:hl" }),
];

function plan(posts: PostEntry[], now = NOW): RescheduleTarget[] {
  const p = planWeeklyReschedule(posts, "weekly-clicked", now);
  assert.ok(p.ok, p.ok ? "" : p.reason);
  return p.targets;
}

function harness(initial: PostEntry[], over: Partial<RescheduleRecordDeps> = {}) {
  let posts = initial.map((p) => ({ ...p }));
  const deletes: string[] = [];
  const err: string[] = [];
  const deps: RescheduleRecordDeps = {
    deleteQueueKey: async (key) => {
      deletes.push(key);
      return { alreadyGone: false };
    },
    deleteFacebookPost: async (_page, id) => {
      deletes.push(id);
      return { alreadyGone: false };
    },
    now: () => NOW,
    rewrite: (t) => {
      posts = t(posts);
    },
    notify: null,
    log: () => {},
    error: (l) => err.push(l),
    ...over,
  };
  return {
    deps,
    deletes,
    err,
    get posts() {
      return posts;
    },
  };
}

describe("#12419 item 2: DELETE que lançou deixa o alvo em cancelling", () => {
  it("executeWeeklyReschedule classifica a falha: threw / gone / lead", async () => {
    const targets = plan(POSTS);
    const threw = await executeWeeklyReschedule(targets, {
      deleteQueueKey: async (key) => {
        if (key === "q:th") throw new Error("socket hang up");
        return { alreadyGone: false };
      },
      deleteFacebookPost: async () => ({ alreadyGone: false }),
      now: () => NOW,
    });
    assert.ok(!threw.ok && threw.failure === "threw");

    const gone = await executeWeeklyReschedule(targets, {
      deleteQueueKey: async (key) => ({ alreadyGone: key === "q:th" }),
      deleteFacebookPost: async () => ({ alreadyGone: false }),
      now: () => NOW,
    });
    assert.ok(!gone.ok && gone.failure === "gone");

    const lead = await executeWeeklyReschedule(targets, {
      deleteQueueKey: async () => ({ alreadyGone: false }),
      deleteFacebookPost: async () => ({ alreadyGone: false }),
      now: () => new Date("2027-12-26T10:58:00Z"), // 07:58 BRT, 2 min do disparo
    });
    assert.ok(!lead.ok && lead.failure === "lead");
  });

  it("cenário da issue: 2º DELETE lança → 1º 'deleted', o que lançou fica 'cancelling' com a chave, não tentado volta a 'scheduled'", async () => {
    const h = harness(POSTS, {
      deleteQueueKey: async (key) => {
        if (key === "q:th") throw new Error("Worker queue DELETE: timeout");
        return { alreadyGone: false };
      },
    });
    assert.equal(await cancelAndRecordReschedule(plan(POSTS), "weekly-clicked", ["diaria"], h.deps), false);
    assert.deepEqual(h.posts.map((p) => p.status), ["deleted", "cancelling", "scheduled", "scheduled"]);
    assert.equal(h.posts[1].worker_queue_key, "q:th", "a chave fica para a retomada");
    assert.match(h.err.join("\n"), /threads ficou "cancelling"/);
  });

  it("DELETE do Facebook que lança (resposta perdida) fica 'cancelling' com o fb_post_id", async () => {
    const h = harness(POSTS, {
      deleteFacebookPost: async () => {
        throw new Error("fetch failed: ECONNRESET");
      },
    });
    assert.equal(await cancelAndRecordReschedule(plan(POSTS), "weekly-clicked", ["diaria"], h.deps), false);
    const fb = h.posts.find((p) => p.platform === "facebook")!;
    assert.equal(fb.status, "cancelling");
    assert.equal(fb.fb_post_id, "fb_1");
  });

  it("404 em alvo novo continua voltando a 'scheduled' (inalterado)", async () => {
    const h = harness(POSTS, { deleteQueueKey: async (key) => ({ alreadyGone: key === "q:th" }) });
    assert.equal(await cancelAndRecordReschedule(plan(POSTS), "weekly-clicked", ["diaria"], h.deps), false);
    assert.deepEqual(h.posts.map((p) => p.status), ["deleted", "scheduled", "scheduled", "scheduled"]);
  });

  it("margem vencida continua voltando a 'scheduled' (inalterado)", async () => {
    const h = harness(POSTS, { now: () => new Date("2027-12-26T10:58:00Z") });
    assert.equal(await cancelAndRecordReschedule(plan(POSTS), "weekly-clicked", ["diaria"], h.deps), false);
    assert.deepEqual(h.deletes, []);
    assert.deepEqual(h.posts.map((p) => p.status), ["scheduled", "scheduled", "scheduled", "scheduled"]);
  });

  it("ponta a ponta: a rodada seguinte retoma o alvo 'cancelling' (404 conta como cancelado) e limpa o registro", async () => {
    const first = harness(POSTS, {
      deleteQueueKey: async (key) => {
        if (key === "q:th") throw new Error("timeout depois de o servidor aceitar");
        return { alreadyGone: false };
      },
    });
    await cancelAndRecordReschedule(plan(POSTS), "weekly-clicked", ["diaria"], first.deps);

    const second = harness(first.posts, { deleteQueueKey: async (key) => ({ alreadyGone: key === "q:th" }) });
    const targets = plan(second.posts);
    const th = targets.find((t) => t.kind === "worker_queue" && t.key === "q:th");
    assert.equal(th?.resumed, true, "o alvo que lançou vira retomada");
    assert.equal(await cancelAndRecordReschedule(targets, "weekly-clicked", ["diaria"], second.deps), true);
    assert.ok(!second.posts.some((p) => p.status === "cancelling"));
  });

  it("settleAbortedReschedule sem unknownState mantém o comportamento antigo", () => {
    const targets = plan(POSTS);
    const crashed = POSTS.map((p) => (p.destaque === "weekly-clicked" ? { ...p, status: "cancelling" as const } : p));
    assert.deepEqual(
      settleAbortedReschedule(crashed, "weekly-clicked", targets, [targets[0]]).map((p) => p.status),
      ["deleted", "scheduled", "scheduled", "scheduled"],
    );
    assert.deepEqual(
      settleAbortedReschedule(crashed, "weekly-clicked", targets, [targets[0]], [targets[1]]).map((p) => p.status),
      ["deleted", "cancelling", "scheduled", "scheduled"],
    );
  });
});
