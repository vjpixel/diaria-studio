/**
 * #12421 — entrada `cancelling` do carrossel semanal (gravada pelo
 * `--reschedule` de `publish-weekly-social.ts`, #12417/#12419) era cega para o
 * conciliador e não tinha alarme.
 *
 *   1. Conciliador (`reconcileWorkerEntry`/`verifyWeeklyWorkerDispatch`): a
 *      ida da entrada `cancelling` para a DLQ do Worker vira `failed` (ou
 *      `send_unknown`), como a `scheduled`. Ausente da fila e da DLQ continua
 *      `cancelling`: pode ter disparado ou o DELETE pode ter apagado, e o
 *      Worker não guarda histórico — nunca vira `published` por inferência.
 *   2. Alarme: entrada `cancelling` com horário antigo passado, em qualquer
 *      semana de `data/weekly/`, vira achado `weekly-social-cancelling-stuck`
 *      (`retro-semanal-staleness-alarm.ts`, que já roda toda semana).
 *
 * Nenhum teste faz rede, chama `gh` ou manda e-mail.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  verifyWeeklyWorkerDispatch,
  reconcileWorkerEntry,
  type PostEntry,
  type FetchJsonFn,
} from "../scripts/lib/weekly-worker-dispatch.ts";
import {
  findStuckCancellingEntries,
  toStuckCancellingFinding,
  buildStuckCancellingEmail,
  WEEKLY_CANCELLING_STUCK_CHECK,
} from "../scripts/lib/weekly-cancelling-stuck-alarm.ts";
import { scanStuckCancellingEntries } from "../scripts/retro-semanal-staleness-alarm.ts";

const NOW = new Date("2026-11-07T15:00:00Z");
const PAST = "2026-11-07T14:00:00.000Z";
const FUTURE = "2026-11-07T18:00:00.000Z";

function entry(overrides: Partial<PostEntry> = {}): PostEntry {
  return {
    platform: "threads",
    destaque: "highlights",
    url: null,
    status: "cancelling",
    scheduled_at: PAST,
    worker_queue_key: `queue:${PAST}:uuid-1`,
    ...overrides,
  };
}

describe("conciliador: entrada cancelling (#12421 item 1)", () => {
  it("na DLQ vira failed (o DELETE não chegou e o Worker falhou o disparo)", () => {
    const e = entry();
    const r = reconcileWorkerEntry(e, new Set(), new Set([`dlq:${PAST}:uuid-1`]), NOW);
    assert.equal(r.changed, true);
    assert.equal(r.updated.status, "failed");
    assert.equal(r.updated.worker_dlq_key, `dlq:${PAST}:uuid-1`);
  });

  it("na DLQ com send_unknown vira send_unknown (pode ter saído)", () => {
    const r = reconcileWorkerEntry(
      entry({ platform: "instagram" }),
      new Set(),
      new Map([["uuid-1", { key: `dlq:${PAST}:uuid-1`, last_error: "send_unknown: timeout no media_publish" }]]),
      NOW,
    );
    assert.equal(r.updated.status, "send_unknown");
  });

  it("ausente da fila e da DLQ NÃO vira published: fica cancelling (disparou ou foi apagada, não dá pra saber)", () => {
    const r = reconcileWorkerEntry(entry(), new Set(), new Set(), NOW);
    assert.equal(r.changed, false);
    assert.equal(r.updated.status, "cancelling");
    assert.equal(r.updated.published_at, undefined);
  });

  it("ainda na fila fica cancelling", () => {
    const e = entry();
    const r = reconcileWorkerEntry(e, new Set([e.worker_queue_key as string]), new Set(), NOW);
    assert.equal(r.changed, false);
    assert.equal(r.updated.status, "cancelling");
  });

  it("scheduled ausente segue virando published (comportamento de antes intocado)", () => {
    const r = reconcileWorkerEntry(entry({ status: "scheduled" }), new Set(), new Set(), NOW);
    assert.equal(r.updated.status, "published");
  });

  it("verifyWeeklyWorkerDispatch: cancelling na DLQ é contada como mudança e o registro ganha failed", async () => {
    const published = {
      posts: [
        entry({ platform: "threads", worker_queue_key: "queue:a:k1" }), // DLQ -> failed
        entry({ platform: "instagram", worker_queue_key: "queue:a:k2" }), // ausente -> fica cancelling
      ],
    };
    const fetchJson: FetchJsonFn = async (url) => {
      if (url.endsWith("/list")) return { count: 0, items: [] };
      if (url.endsWith("/dlq")) return { count: 1, items: [{ key: "dlq:a:k1" }] };
      throw new Error(`url inesperada ${url}`);
    };
    const { updated, changes } = await verifyWeeklyWorkerDispatch(published, "https://worker.example", "tok", fetchJson, NOW, {
      maxAttempts: 1,
    });
    assert.equal(changes, 1);
    assert.equal(updated.posts[0].status, "failed");
    assert.equal(updated.posts[1].status, "cancelling");
  });
});

describe("alarme de entrada presa em cancelling (#12421 item 2)", () => {
  it("só entra cancelling com horário antigo passado (ou ilegível)", () => {
    const posts = [
      entry({ destaque: "highlights" }), // passado -> presa
      entry({ destaque: "clicked", scheduled_at: FUTURE }), // futuro -> ainda se resolve sozinha
      entry({ destaque: "d1", scheduled_at: null }), // sem horário -> avisa
      entry({ destaque: "d2", status: "scheduled" }), // não é cancelling
      entry({ platform: "facebook", page: "diaria", destaque: "d3", worker_queue_key: undefined, fb_post_id: "123_456" }),
    ];
    const stuck = findStuckCancellingEntries("261107", posts, NOW);
    assert.deepEqual(
      stuck.map((s) => `${s.platform}/${s.destaque}`),
      ["threads/highlights", "threads/d1", "facebook/d3"],
    );
    assert.equal(stuck[2].page, "diaria");
    assert.equal(stuck[2].cancelId, "123_456");
    assert.equal(stuck[0].cancelId, `queue:${PAST}:uuid-1`);
  });

  it("finding: família estado, fingerprint estável por semana+canal+página+destaque, prioridade P2", () => {
    const [e] = findStuckCancellingEntries("261107", [entry({ platform: "facebook", page: "ia", worker_queue_key: undefined })], NOW);
    const f = toStuckCancellingFinding(e);
    assert.equal(f.check, WEEKLY_CANCELLING_STUCK_CHECK);
    assert.equal(f.family, "estado");
    assert.equal(f.priority, "P2");
    assert.equal(f.fingerprint, `${WEEKLY_CANCELLING_STUCK_CHECK}:261107:facebook:ia:highlights`);
    assert.equal(toStuckCancellingFinding(e).fingerprint, f.fingerprint);
    assert.match(f.body, /data\/weekly\/261107\/06-weekly-published\.json/);
  });

  it("e-mail lista as entradas e a issue", () => {
    const stuck = findStuckCancellingEntries("261107", [entry()], NOW);
    const msg = buildStuckCancellingEmail(stuck, [{ issueNumber: 42, url: "https://x/42", action: "created" }]);
    assert.match(msg.subject, /1 entrada\(s\) presa\(s\)/);
    assert.match(msg.body, /threads\/highlights \(semana 261107\)/);
    assert.match(msg.body, /#42/);
  });

  it("scanStuckCancellingEntries varre toda semana AAMMDD de data/weekly e pula registro ilegível", () => {
    const root = mkdtempSync(join(tmpdir(), "cancelling-12421-"));
    try {
      const weekly = join(root, "data", "weekly");
      mkdirSync(join(weekly, "261031"), { recursive: true });
      writeFileSync(join(weekly, "261031", "06-weekly-published.json"), JSON.stringify({ posts: [entry()] }));
      mkdirSync(join(weekly, "261107"), { recursive: true });
      writeFileSync(join(weekly, "261107", "06-weekly-published.json"), JSON.stringify({ posts: [entry({ status: "scheduled" })] }));
      mkdirSync(join(weekly, "261024"), { recursive: true });
      writeFileSync(join(weekly, "261024", "06-weekly-published.json"), "{ quebrado");
      mkdirSync(join(weekly, "261031-highlights"), { recursive: true });
      const stuck = scanStuckCancellingEntries(root, NOW);
      assert.deepEqual(stuck.map((s) => s.week), ["261031"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem data/weekly devolve []", () => {
    const root = mkdtempSync(join(tmpdir(), "cancelling-12421-vazio-"));
    try {
      assert.deepEqual(scanStuckCancellingEntries(root, NOW), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
