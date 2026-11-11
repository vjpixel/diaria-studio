/**
 * test/linkedin-daily-idempotency-12661.test.ts (#12661)
 *
 * O post do LinkedIn da diária (documento PDF → carrossel → imagem única,
 * #12584) ia pra fila do Worker sem `idempotency_key`. O `postToWorkerQueue`
 * tenta de novo em 5xx/timeout, e a resposta perdida depois de o Worker gravar
 * criava uma 2ª entry: dois posts públicos do mesmo destaque.
 *
 * O Worker falso aqui modela o que o real faz com a chave (#10906/#10917):
 * mesma chave + mesmo conteúdo = duplicata (200, mesma entry); mesma chave +
 * conteúdo diferente = substitui a entry; sem chave = entry nova a cada POST.
 * Contamos as entries da fila no fim: é o número de posts que sairiam.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchEntry, type DispatchContext, type DispatchInput, type LinkedInDocumentPlan } from "../scripts/publish-linkedin.ts";
import { linkedInDailyIdempotencyKey } from "../scripts/lib/linkedin-daily-document.ts";

const SLIDES = ["cover", "p1", "p2", "p3", "cta"].map((s) => `https://img.test/d1_${s}.jpg`);
const DOC = { url: "https://img.test/img-260999-linkedin-d1-carousel-abcd1234.pdf", title: "Título do D1" };

function plan(): LinkedInDocumentPlan {
  return { status: "ready", carouselImageUrls: SLIDES, prepareDocument: async () => DOC };
}

function input(): DispatchInput {
  return {
    destaque: "d1",
    subtype: "main",
    text: "Post agendado",
    imageUrl: "https://img.test/d1_4x5.jpg",
    scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    webhookTarget: "diaria",
    action: "post",
    linkedInDocument: plan(),
  };
}

function ctx(dir: string, over: Partial<DispatchContext> = {}): DispatchContext {
  return {
    publishedPath: join(dir, "06-social-published.json"),
    webhookUrl: "https://hook.test/diaria",
    workerUrl: "https://worker.test",
    workerToken: "test-tok",
    useWorkerForScheduled: true,
    editionDate: "260999",
    rootDir: dir,
    ...over,
  };
}

/** O que o Worker faz com o POST: gravar e responder, gravar e perder a
 *  resposta, ou recusar antes de gravar. */
type Behavior = "ok" | "write_then_timeout" | { status: number; body: Record<string, unknown> };

/** Worker falso com a semântica de `idempotency_key` do real. */
function fakeWorker(behaviors: Behavior[]) {
  const entries = new Map<string, Record<string, unknown>>();
  const bodies: Record<string, unknown>[] = [];
  let makeCalls = 0;
  let seq = 0;
  const content = (b: Record<string, unknown>) =>
    JSON.stringify([b.text, b.image_url, b.image_urls ?? null, b.document_url ?? null, b.scheduled_at]);
  const saved = globalThis.fetch;
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    if (!String(u).includes("/queue")) {
      makeCalls++;
      return new Response(JSON.stringify({ accepted: true, request_id: "make-req" }), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const behavior = behaviors[Math.min(bodies.length - 1, behaviors.length - 1)];
    if (typeof behavior === "object") {
      return new Response(JSON.stringify(behavior.body), { status: behavior.status, headers: { "Content-Type": "application/json" } });
    }
    const idem = typeof body.idempotency_key === "string" ? body.idempotency_key : null;
    const key = idem !== null ? `queue:${idem}` : `queue:random-${++seq}`;
    const existing = entries.get(key);
    const duplicate = existing !== undefined && content(existing) === content(body);
    entries.set(key, body); // conteúdo diferente na mesma chave: substitui (#10917)
    if (behavior === "write_then_timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return new Response(
      JSON.stringify({ queued: true, key, scheduled_at: body.scheduled_at, destaque: body.destaque, ...(duplicate && { duplicate: true }) }),
      { status: duplicate ? 200 : 202 },
    );
  }) as typeof fetch;
  return { entries, bodies, makeCalls: () => makeCalls, restore: () => (globalThis.fetch = saved) };
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "linkedin-idem-12661-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#12661 idempotency_key do post do LinkedIn da diária", () => {
  it("chave fixa por edição e destaque, com prefixo próprio em --test", () => {
    assert.equal(linkedInDailyIdempotencyKey("261110", "d2"), "linkedin-daily:261110:d2:main");
    assert.equal(linkedInDailyIdempotencyKey("261110", "d2", { isTest: true }), "linkedin-daily-test:261110:d2:main");
  });

  it("retry após timeout (Worker gravou, resposta perdida) não cria 2ª entry", async () => {
    const w = fakeWorker(["write_then_timeout", "ok"]);
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(input(), ctx(dir));
        assert.equal(w.bodies.length, 2, "o cliente reenviou o documento");
        assert.equal(w.bodies[0].idempotency_key, "linkedin-daily:260999:d1:main");
        assert.equal(w.bodies[1].idempotency_key, w.bodies[0].idempotency_key, "o retry leva a mesma chave");
        assert.equal(w.entries.size, 1, "um post só na fila");
        assert.equal(entry.status, "scheduled");
        assert.equal(entry.format, "document");
      });
    } finally {
      w.restore();
    }
  });

  it("documento gravado sem resposta + 429 na 2ª tentativa: o carrossel SUBSTITUI a entry, nunca soma", async () => {
    const w = fakeWorker(["write_then_timeout", { status: 429, body: { error: "rate_limited" } }, "ok"]);
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(input(), ctx(dir));
        assert.equal(w.bodies.length, 3, "documento (2 tentativas) e carrossel");
        assert.equal(w.bodies[2].document_url, undefined);
        assert.equal(w.bodies[2].idempotency_key, w.bodies[0].idempotency_key, "o degrau do carrossel usa a mesma chave");
        assert.equal(w.entries.size, 1, "documento + carrossel saíam como 2 posts");
        assert.equal(entry.format, "carousel");
        assert.equal(w.makeCalls(), 0);
      });
    } finally {
      w.restore();
    }
  });

  it("re-rodar a Etapa 5 (entry failed no store) cai na mesma entry do Worker", async () => {
    const w = fakeWorker(["ok"]);
    try {
      await withDir(async (dir) => {
        await dispatchEntry(input(), ctx(dir));
        await dispatchEntry(input(), ctx(dir));
        assert.equal(w.entries.size, 1);
      });
    } finally {
      w.restore();
    }
  });

  it("409 already_fired no documento: o post já saiu, sucesso sem descer pro carrossel", async () => {
    const message = "este pedido (idempotency_key) já foi disparado — nada novo foi agendado. ".repeat(4);
    const w = fakeWorker([{ status: 409, body: { error: "already_fired", message, key: "queue:2026-11-10T12:00:00.000Z:abc" } }]);
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(input(), ctx(dir));
        assert.equal(w.bodies.length, 1, "nenhum outro degrau por cima");
        assert.equal(entry.status, "scheduled");
        assert.equal(entry.worker_queue_key, "queue:2026-11-10T12:00:00.000Z:abc", "a key vem do corpo, mesmo depois de uma message longa");
        assert.equal(w.makeCalls(), 0);
      });
    } finally {
      w.restore();
    }
  });

  it("409 send_unknown no documento: ambíguo, failed sem carrossel nem imagem única por cima", async () => {
    const w = fakeWorker([{ status: 409, body: { error: "send_unknown", message: "ambíguo", key: "queue:x" } }]);
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(input(), ctx(dir));
        assert.equal(w.bodies.length, 1);
        assert.equal(entry.status, "failed");
        assert.equal(w.makeCalls(), 0);
      });
    } finally {
      w.restore();
    }
  });

  it("degrau 3 (imagem única na fila) leva a mesma chave", async () => {
    const reject = { status: 400, body: { error: "recusado", code: "linkedin_creds_missing" } };
    const w = fakeWorker([reject, reject, "ok"]);
    try {
      await withDir(async (dir) => {
        const entry = await dispatchEntry(input(), ctx(dir));
        assert.equal(entry.format, "single_image");
        assert.equal(w.bodies[2].idempotency_key, "linkedin-daily:260999:d1:main");
      });
    } finally {
      w.restore();
    }
  });

  it("--test usa chave própria e nunca cai na entry de produção", async () => {
    const w = fakeWorker(["ok"]);
    try {
      await withDir(async (dir) => {
        await dispatchEntry(input(), ctx(dir));
        await dispatchEntry(input(), ctx(dir, { isTest: true, publishedPath: join(dir, "test-published.json") }));
        assert.equal(w.entries.size, 2);
      });
    } finally {
      w.restore();
    }
  });
});
