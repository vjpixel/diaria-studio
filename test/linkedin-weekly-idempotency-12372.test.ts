/**
 * test/linkedin-weekly-idempotency-12372.test.ts (#12372 item 3)
 *
 * O post semanal do LinkedIn (documento PDF → carrossel → capa única, #8055/
 * #10103) ia pra fila do Worker sem `idempotency_key`. O `postToWorkerQueue`
 * tenta de novo em 5xx/timeout, e a resposta perdida depois de o Worker gravar
 * criava uma 2ª entry: dois posts públicos do mesmo ciclo.
 *
 * O Worker falso modela o que o real faz com a chave (#10906/#10917/#10992):
 * mesma chave + mesmo conteúdo = duplicata (200, mesma entry); mesma chave +
 * conteúdo diferente = substitui a entry; sem chave = entry nova a cada POST;
 * chave cujo post já saiu = 409 `already_fired`. Contamos as entries no fim:
 * é o número de posts que sairiam.
 */
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

import { enqueueWeeklyLinkedIn, linkedInWeeklyIdempotencyKey } from "../scripts/publish-weekly-social.ts";
import { idempotentConflictKey, WorkerQueueError } from "../scripts/lib/worker-queue-client.ts";

const CAROUSEL = ["https://cdn.test/cover-4x5.jpg", "https://cdn.test/n1.jpg", "https://cdn.test/cta-4x5.jpg"];
const DOC = { url: "https://eia.test/img/img-unknown-weekly-271225-clicked-carousel-abcd1234.pdf", title: "Título (20–24 dez)" };
const KEY = linkedInWeeklyIdempotencyKey("271225-clicked");

interface FakeWorkerOpts {
  /** A 1ª requisição grava a entry e devolve este status (resposta "perdida"). */
  firstStatus?: number;
  /** Responde 409 com este `error` pra qualquer POST com chave. */
  conflict?: "already_fired" | "fire_in_progress" | "send_unknown";
  /** Recusa (4xx) o POST que tiver `document_url`. */
  rejectDocument?: boolean;
}

function fakeWorker(agent: MockAgent, o: FakeWorkerOpts = {}) {
  const entries = new Map<string, string>();
  const bodies: any[] = [];
  let n = 0;
  agent
    .get("https://worker.test")
    .intercept({ path: "/queue", method: "POST" })
    .reply((opts) => {
      const body = JSON.parse(opts.body as string);
      bodies.push(body);
      n++;
      const content = JSON.stringify({ ...body, idempotency_key: undefined });
      const key = body.idempotency_key ? `queue:${body.idempotency_key}` : `queue:${n}`;
      if (o.conflict && body.idempotency_key) {
        return { statusCode: 409, data: JSON.stringify({ error: o.conflict, message: "x".repeat(400), key }) };
      }
      if (o.rejectDocument && body.document_url) {
        return { statusCode: 400, data: JSON.stringify({ error: "document_title exceeds 400 chars" }) };
      }
      const duplicate = entries.get(key) === content;
      entries.set(key, content);
      if (n === 1 && o.firstStatus) return { statusCode: o.firstStatus, data: "upstream timeout" };
      return {
        statusCode: duplicate ? 200 : 202,
        data: JSON.stringify({ queued: true, key, scheduled_at: body.scheduled_at, destaque: body.destaque, ...(duplicate && { duplicate: true }) }),
      };
    })
    .persist();
  return { entries, bodies };
}

const base = {
  text: "legenda",
  carouselImageUrls: CAROUSEL,
  scheduledAt: "2027-12-26T11:00:00-03:00",
  destaque: "weekly-clicked",
};

describe("#12372 item 3 — idempotency_key do LinkedIn semanal", () => {
  let agent: MockAgent;
  let original: ReturnType<typeof getGlobalDispatcher>;
  before(() => {
    original = getGlobalDispatcher();
  });
  after(() => setGlobalDispatcher(original));
  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    await agent.close();
  });

  it("chave fixa por ciclo e modo, no formato aceito pelo Worker", () => {
    assert.equal(KEY, "linkedin-weekly:271225-clicked:main");
    assert.match(KEY, /^[A-Za-z0-9._:-]{1,128}$/);
    assert.throws(() => linkedInWeeklyIdempotencyKey("271225 clicked"), /idempotency_key inválida/);
  });

  it("resposta perdida depois de o Worker gravar o documento: o retry cai na mesma entry (1 post, não 2)", async () => {
    const w = fakeWorker(agent, { firstStatus: 503 });
    const res = await enqueueWeeklyLinkedIn("https://worker.test", "tok", { ...base, idempotencyKey: KEY, prepareDocument: async () => DOC });
    assert.equal(w.bodies.length, 2, "1ª tentativa + retry do cliente");
    assert.ok(w.bodies.every((b) => b.idempotency_key === KEY));
    assert.equal(w.entries.size, 1, "um post só");
    assert.equal(res.format, "document");
  });

  it("controle: sem a chave o mesmo cenário deixa 2 entries (o bug)", async () => {
    const w = fakeWorker(agent, { firstStatus: 503 });
    await enqueueWeeklyLinkedIn("https://worker.test", "tok", { ...base, prepareDocument: async () => DOC });
    assert.equal(w.entries.size, 2);
    assert.equal(w.bodies[0].idempotency_key, undefined, "sem chave, payload como antes");
  });

  it("documento recusado (4xx): o carrossel vai com a MESMA chave", async () => {
    const w = fakeWorker(agent, { rejectDocument: true });
    const res = await enqueueWeeklyLinkedIn("https://worker.test", "tok", { ...base, idempotencyKey: KEY, prepareDocument: async () => DOC });
    assert.equal(w.bodies.length, 2);
    assert.equal(w.bodies[1].document_url, undefined);
    assert.equal(w.bodies[1].idempotency_key, KEY);
    assert.equal(res.format, "carousel");
    assert.equal(res.document_fallback_reason, "document_rejected:400");
  });

  it("capa única (linkedin_creds_missing no carrossel) também leva a chave", async () => {
    const bodies: any[] = [];
    agent
      .get("https://worker.test")
      .intercept({ path: "/queue", method: "POST" })
      .reply((opts) => {
        const body = JSON.parse(opts.body as string);
        bodies.push(body);
        if (body.image_urls) return { statusCode: 400, data: JSON.stringify({ error: "sem credencial", code: "linkedin_creds_missing" }) };
        return { statusCode: 202, data: JSON.stringify({ queued: true, key: "queue:cover", scheduled_at: body.scheduled_at, destaque: body.destaque }) };
      })
      .persist();
    const res = await enqueueWeeklyLinkedIn("https://worker.test", "tok", { ...base, idempotencyKey: KEY });
    assert.equal(res.format, "cover_only");
    assert.deepEqual(
      bodies.map((b) => b.idempotency_key),
      [KEY, KEY],
    );
  });

  for (const conflict of ["already_fired", "fire_in_progress"] as const) {
    it(`409 ${conflict}: sucesso com a key da entry, sem descer pro carrossel`, async () => {
      const w = fakeWorker(agent, { conflict });
      const res = await enqueueWeeklyLinkedIn("https://worker.test", "tok", { ...base, idempotencyKey: KEY, prepareDocument: async () => DOC });
      assert.equal(w.bodies.length, 1, "nenhum degrau por cima");
      assert.deepEqual(res, { key: `queue:${KEY}`, format: "document", document_url: DOC.url });
    });
  }

  it("409 send_unknown propaga (ambíguo): nem carrossel nem capa por cima", async () => {
    const w = fakeWorker(agent, { conflict: "send_unknown" });
    await assert.rejects(
      enqueueWeeklyLinkedIn("https://worker.test", "tok", { ...base, idempotencyKey: KEY, prepareDocument: async () => DOC }),
      (e: unknown) => e instanceof WorkerQueueError && e.status === 409,
    );
    assert.equal(w.bodies.length, 1);
  });

  it("idempotentConflictKey lê o key do corpo inteiro (além dos 300 chars da message)", () => {
    const body = JSON.stringify({ error: "already_fired", message: "x".repeat(400), key: "queue:abc" });
    assert.equal(idempotentConflictKey(new WorkerQueueError(409, body)), "queue:abc");
    assert.equal(idempotentConflictKey(new WorkerQueueError(409, "não é json")), null);
    assert.equal(idempotentConflictKey(new WorkerQueueError(400, body)), null);
    assert.equal(idempotentConflictKey(new Error("x")), null);
  });
});
