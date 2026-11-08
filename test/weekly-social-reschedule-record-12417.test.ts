/**
 * weekly-social-reschedule-record-12417.test.ts — #12417: o `--reschedule` de
 * publish-weekly-social.ts não pode deixar o registro afirmando `scheduled`
 * para um post que ele já cancelou.
 *
 * Cenários:
 *   - regravação do registro falha DEPOIS dos DELETEs (lock ocupado > 10 s) →
 *     saída destacada com canal + chave/fb_post_id, alarme `acao`, nada de
 *     "deleted" antes da gravação, registro em `cancelling`;
 *   - queda entre o DELETE e a limpeza (estado `cancelling` no disco) → o
 *     próximo plano retoma (404 conta como cancelado);
 *   - registro antigo sem o status novo segue igual.
 *
 * Tudo com DELETE e regravação injetados: nenhuma chamada real à fila do
 * Worker nem à Graph API, nenhuma issue aberta (notify mockado).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelAndRecordReschedule,
  executeWeeklyReschedule,
  markCancellingEntries,
  planWeeklyReschedule,
  settleAbortedReschedule,
  RESCHEDULE_RECORD_CHECK,
  type RescheduleRecordAlert,
  type RescheduleRecordDeps,
  type RescheduleTarget,
} from "../scripts/lib/weekly-social-reschedule.ts";
import { rewriteSocialPosts, type PostEntry } from "../scripts/lib/social-published-store.ts";

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

/** Registro em memória + regravação que lança a partir da chamada `failFrom` (1-based). */
function memoryStore(initial: PostEntry[], failFrom = Infinity) {
  let posts = initial.map((p) => ({ ...p }));
  let calls = 0;
  return {
    get posts() {
      return posts;
    },
    get calls() {
      return calls;
    },
    rewrite(transform: (p: PostEntry[]) => PostEntry[]) {
      calls++;
      if (calls >= failFrom) throw new Error("lock timeout: 06-weekly-published.json.lock");
      posts = transform(posts);
    },
  };
}

function harness(store: ReturnType<typeof memoryStore>, over: Partial<RescheduleRecordDeps> = {}) {
  const deletes: string[] = [];
  const alerts: RescheduleRecordAlert[] = [];
  const out: string[] = [];
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
    rewrite: (t) => store.rewrite(t),
    notify: async (a) => {
      alerts.push(a);
    },
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    ...over,
  };
  return { deps, deletes, alerts, out, err };
}

function plan(posts: PostEntry[]): RescheduleTarget[] {
  const p = planWeeklyReschedule(posts, "weekly-clicked", NOW);
  assert.ok(p.ok, p.ok ? "" : p.reason);
  return p.targets;
}

describe("#12417: intenção cancelling antes do 1º DELETE", () => {
  it("markCancellingEntries marca só os alvos do modo, preservando chave/fb_post_id/scheduled_at", () => {
    const marked = markCancellingEntries(POSTS, "weekly-clicked", plan(POSTS));
    assert.deepEqual(
      marked.map((p) => p.status),
      ["cancelling", "cancelling", "cancelling", "scheduled"],
    );
    assert.equal(marked[0].worker_queue_key, "q:ig");
    assert.equal(marked[2].fb_post_id, "fb_1");
    assert.equal(marked[0].scheduled_at, AT);
  });

  it("a intenção é gravada ANTES do 1º DELETE", async () => {
    const store = memoryStore(POSTS);
    let statusAtFirstDelete: string[] = [];
    const h = harness(store, {
      deleteQueueKey: async () => {
        if (statusAtFirstDelete.length === 0) statusAtFirstDelete = store.posts.map((p) => p.status);
        return { alreadyGone: false };
      },
    });
    assert.equal(await cancelAndRecordReschedule(plan(POSTS), "weekly-clicked", ["diaria"], h.deps), true);
    assert.deepEqual(statusAtFirstDelete, ["cancelling", "cancelling", "cancelling", "scheduled"]);
  });

  it("falha ao gravar a intenção → nenhum DELETE, nenhum alarme", async () => {
    const store = memoryStore(POSTS, 1);
    const h = harness(store);
    assert.equal(await cancelAndRecordReschedule(plan(POSTS), "weekly-clicked", ["diaria"], h.deps), false);
    assert.deepEqual(h.deletes, []);
    assert.deepEqual(h.alerts, []);
    assert.match(h.err.join("\n"), /antes de cancelar qualquer coisa/);
  });

  it("caminho feliz: registro sem os alvos do modo (o redespacho regrava), outro modo intacto", async () => {
    const store = memoryStore(POSTS);
    const h = harness(store);
    assert.equal(await cancelAndRecordReschedule(plan(POSTS), "weekly-clicked", ["diaria"], h.deps), true);
    assert.deepEqual(h.deletes, ["q:ig", "q:th", "fb_1"]);
    assert.deepEqual(store.posts.map((p) => `${p.platform}/${p.destaque}/${p.status}`), ["instagram/weekly-highlights/scheduled"]);
    assert.deepEqual(h.alerts, []);
  });
});

describe("#12417: regravação falha DEPOIS dos DELETEs (cenário da issue)", () => {
  it("sucesso nos DELETEs + lock ocupado na limpeza → false, lista destacada, alarme acao, registro em cancelling", async () => {
    const store = memoryStore(POSTS, 2); // 1ª (intenção) ok, 2ª (limpeza) lança
    const h = harness(store);
    assert.equal(await cancelAndRecordReschedule(plan(POSTS), "weekly-clicked", ["diaria"], h.deps), false);
    assert.deepEqual(h.deletes, ["q:ig", "q:th", "fb_1"]);
    // Nunca "scheduled" com id já cancelado — a rodada seguinte não pula em silêncio.
    assert.deepEqual(store.posts.map((p) => p.status), ["cancelling", "cancelling", "cancelling", "scheduled"]);
    const banner = h.err.join("\n");
    assert.match(banner, /instagram worker_queue_key=q:ig/);
    assert.match(banner, /threads worker_queue_key=q:th/);
    assert.match(banner, /facebook:diaria fb_post_id=fb_1/);
    assert.match(banner, /lock timeout/);
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0].severity, "acao");
    assert.equal(h.alerts[0].check, RESCHEDULE_RECORD_CHECK);
    assert.match(h.alerts[0].body, /fb_post_id=fb_1/);
  });

  it("abort no meio + lock ocupado → a mensagem 'deleted' NÃO sai (a gravação não aconteceu)", async () => {
    const store = memoryStore(POSTS, 2);
    const h = harness(store, {
      deleteQueueKey: async (key) => {
        h.deletes.push(key);
        return { alreadyGone: key === "q:th" };
      },
    });
    assert.equal(await cancelAndRecordReschedule(plan(POSTS), "weekly-clicked", ["diaria"], h.deps), false);
    assert.deepEqual(h.deletes, ["q:ig", "q:th"]);
    assert.doesNotMatch(h.err.join("\n"), /status "deleted"/);
    assert.match(h.err.join("\n"), /instagram worker_queue_key=q:ig/);
    assert.equal(h.alerts.length, 1);
    assert.equal(store.posts[0].status, "cancelling");
  });

  it("abort no meio com gravação ok → 'deleted' só depois de gravar; 404 e não tentados voltam a scheduled", async () => {
    const store = memoryStore(POSTS);
    const order: string[] = [];
    const h = harness(store, {
      deleteQueueKey: async (key) => ({ alreadyGone: key === "q:th" }),
      rewrite: (t) => {
        store.rewrite(t);
        order.push("rewrite");
      },
      error: (l) => order.push(l.includes('status "deleted"') ? "msg-deleted" : "err"),
    });
    assert.equal(await cancelAndRecordReschedule(plan(POSTS), "weekly-clicked", ["diaria"], h.deps), false);
    assert.ok(order.lastIndexOf("rewrite") < order.indexOf("msg-deleted"), order.join(","));
    assert.deepEqual(store.posts.map((p) => p.status), ["deleted", "scheduled", "scheduled", "scheduled"]);
    assert.deepEqual(h.alerts, []);
  });

  it("falha do próprio alarme não lança — a lista impressa segue sendo o registro", async () => {
    const store = memoryStore(POSTS, 2);
    const h = harness(store, {
      notify: async () => {
        throw new Error("gh offline");
      },
    });
    assert.equal(await cancelAndRecordReschedule(plan(POSTS), "weekly-clicked", ["diaria"], h.deps), false);
    assert.match(h.err.join("\n"), /alarme ao editor falhou \(gh offline\)/);
  });

  it("com o lock de verdade: regravação real lançando depois dos DELETEs deixa o arquivo em cancelling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resched-12417-"));
    try {
      const path = join(dir, "06-weekly-published.json");
      writeFileSync(path, JSON.stringify({ posts: POSTS }));
      let n = 0;
      const h = harness(memoryStore([]), {
        rewrite: (t) => {
          n++;
          if (n === 2) throw new Error("Timeout acquiring lock " + path + ".lock");
          rewriteSocialPosts(path, t);
        },
      });
      const targets = plan(JSON.parse(readFileSync(path, "utf8")).posts);
      assert.equal(await cancelAndRecordReschedule(targets, "weekly-clicked", ["diaria"], h.deps), false);
      const disk = JSON.parse(readFileSync(path, "utf8")).posts as PostEntry[];
      assert.deepEqual(disk.map((p) => p.status), ["cancelling", "cancelling", "cancelling", "scheduled"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12417: queda entre DELETE e marcação — a rodada seguinte retoma", () => {
  it("plano: cancelling vira alvo resumed (scheduled não)", () => {
    const crashed = markCancellingEntries(POSTS, "weekly-clicked", plan(POSTS));
    const targets = plan(crashed);
    assert.equal(targets.length, 3);
    assert.ok(targets.every((t) => t.resumed === true));
    const fresh = plan(POSTS);
    assert.ok(fresh.every((t) => t.resumed === undefined));
  });

  it("execução: 404 num alvo resumed conta como cancelado; num alvo novo continua abortando", async () => {
    const crashed = markCancellingEntries(POSTS, "weekly-clicked", plan(POSTS));
    const gone = async () => ({ alreadyGone: true });
    const resumed = await executeWeeklyReschedule(plan(crashed), { deleteQueueKey: gone, deleteFacebookPost: gone, now: () => NOW });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.cancelled.length, 3);
    const fresh = await executeWeeklyReschedule(plan(POSTS), { deleteQueueKey: gone, deleteFacebookPost: gone, now: () => NOW });
    assert.equal(fresh.ok, false);
  });

  it("ponta a ponta: 1ª rodada cai na limpeza; 2ª retoma (1º já apagado = 404, os outros 200) e limpa o registro", async () => {
    const store = memoryStore(POSTS, 2);
    const first = harness(store);
    assert.equal(await cancelAndRecordReschedule(plan(store.posts), "weekly-clicked", ["diaria"], first.deps), false);

    // Simula o caso misto: a queda foi depois do 1º DELETE só — o resto ainda existe.
    const store2 = memoryStore(store.posts);
    const second = harness(store2, {
      deleteQueueKey: async (key) => {
        second.deletes.push(key);
        return { alreadyGone: key === "q:ig" };
      },
    });
    assert.equal(await cancelAndRecordReschedule(plan(store2.posts), "weekly-clicked", ["diaria"], second.deps), true);
    assert.deepEqual(second.deletes, ["q:ig", "q:th", "fb_1"]);
    assert.deepEqual(store2.posts.map((p) => p.destaque), ["weekly-highlights"]);
  });

  it("retomada com margem vencida aborta sem DELETE (post pode ter saído)", () => {
    const crashed = markCancellingEntries(POSTS, "weekly-clicked", plan(POSTS));
    const late = planWeeklyReschedule(crashed, "weekly-clicked", new Date("2027-12-26T10:58:00Z"));
    assert.equal(late.ok, false);
  });

  it("settleAbortedReschedule: alvo resumed não cancelado fica cancelling (estado desconhecido)", () => {
    const crashed = markCancellingEntries(POSTS, "weekly-clicked", plan(POSTS));
    const targets = plan(crashed);
    const settled = settleAbortedReschedule(crashed, "weekly-clicked", targets, [targets[0]]);
    assert.deepEqual(settled.map((p) => p.status), ["deleted", "cancelling", "cancelling", "scheduled"]);
  });
});

describe("#12417: compatível com registro antigo (sem o status novo)", () => {
  it("registro só com scheduled/failed planeja e cancela como antes", async () => {
    const legacy = [...POSTS, entry({ platform: "linkedin", status: "failed", scheduled_at: null })];
    const targets = plan(legacy);
    assert.deepEqual(targets.map((t) => t.kind === "facebook" ? t.fbPostId : t.key), ["q:ig", "q:th", "fb_1"]);
    const store = memoryStore(legacy);
    const h = harness(store);
    assert.equal(await cancelAndRecordReschedule(targets, "weekly-clicked", ["diaria"], h.deps), true);
    assert.deepEqual(store.posts.map((p) => p.destaque), ["weekly-highlights"]);
  });

  it("sem alvos: nenhuma gravação de intenção, só a limpeza de failed do modo", async () => {
    const store = memoryStore([entry({ platform: "linkedin", status: "failed", scheduled_at: null })]);
    const h = harness(store);
    assert.equal(await cancelAndRecordReschedule([], "weekly-clicked", ["diaria"], h.deps), true);
    assert.equal(store.calls, 1);
    assert.deepEqual(store.posts, []);
  });
});
