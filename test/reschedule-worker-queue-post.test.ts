/**
 * test/reschedule-worker-queue-post.test.ts (#6607)
 *
 * Regressão: reagendamento ad-hoc não pode re-enfileirar quando o DELETE
 * da entry antiga voltou 404 (post já disparou / já foi removido antes) —
 * incidente que motivou o #6607 (duplicatas na fila do Worker
 * `diaria-linkedin-cron`). `globalThis.fetch` é sempre monkeypatchado, sem
 * rede real (mesmo padrão de `test/apoia-se-probe.test.ts`).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { deleteFromWorkerQueue } from "../scripts/lib/worker-queue-client.ts";
import { main } from "../scripts/reschedule-worker-queue-post.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("deleteFromWorkerQueue", () => {
  let origFetch: typeof fetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("200 → deleted:true, alreadyGone:false", async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      assert.equal(init?.method, "DELETE");
      assert.ok(String(url).endsWith("/queue/queue:d1:260828"));
      return jsonResponse(200, { deleted: true, key: "queue:d1:260828" });
    }) as typeof fetch;

    const result = await deleteFromWorkerQueue("https://worker.example", "tok", "queue:d1:260828");
    assert.deepEqual(result, { deleted: true, alreadyGone: false, key: "queue:d1:260828" });
  });

  it("404 → deleted:false, alreadyGone:true (nunca lança)", async () => {
    globalThis.fetch = (async () => jsonResponse(404, { error: "key not found" })) as typeof fetch;

    const result = await deleteFromWorkerQueue("https://worker.example", "tok", "queue:d1:260828");
    assert.deepEqual(result, { deleted: false, alreadyGone: true, key: "queue:d1:260828" });
  });

  it("erro HTTP != 200/404 → lança", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;

    await assert.rejects(
      deleteFromWorkerQueue("https://worker.example", "tok", "queue:d1:260828"),
      /Worker queue DELETE HTTP 500/,
    );
  });
});

describe("reschedule-worker-queue-post main()", () => {
  let origFetch: typeof fetch;
  let origLog: typeof console.log;
  let origError: typeof console.error;
  let origEnv: Record<string, string | undefined>;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    logs = [];
    errors = [];
    origFetch = globalThis.fetch;
    origLog = console.log;
    origError = console.error;
    origEnv = {
      DIARIA_LINKEDIN_CRON_URL: process.env.DIARIA_LINKEDIN_CRON_URL,
      DIARIA_LINKEDIN_CRON_TOKEN: process.env.DIARIA_LINKEDIN_CRON_TOKEN,
    };
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    console.error = (...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    };
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    console.log = origLog;
    console.error = origError;
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const baseArgs = [
    "--key",
    "queue:d1:260828",
    "--text",
    "hello",
    "--scheduled-at",
    "2026-08-29T13:00:00Z",
    "--destaque",
    "d1",
    "--channel",
    "linkedin",
    "--worker-url",
    "https://worker.example",
    "--token",
    "tok",
  ];

  it("DELETE 404 → aborta o re-enqueue, exit 3, POST nunca chamado", async () => {
    let postCalled = false;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return jsonResponse(404, { error: "key not found" });
      }
      postCalled = true;
      return jsonResponse(200, { queued: true, key: "queue:d1:260828b", scheduled_at: "x", destaque: "d1" });
    }) as typeof fetch;

    const code = await main(baseArgs);
    assert.equal(code, 3);
    assert.equal(postCalled, false, "POST /queue não deveria ter sido chamado após DELETE 404");
    assert.ok(errors.some((e) => /ABORTADO/.test(e)));
  });

  it("DELETE 200 → prossegue para re-enqueue, exit 0", async () => {
    let deleteCalled = false;
    let postCalled = false;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleteCalled = true;
        return jsonResponse(200, { deleted: true, key: "queue:d1:260828" });
      }
      postCalled = true;
      return jsonResponse(200, { queued: true, key: "queue:d1:260828", scheduled_at: "2026-08-29T13:00:00Z", destaque: "d1" });
    }) as typeof fetch;

    const code = await main(baseArgs);
    assert.equal(code, 0);
    assert.ok(deleteCalled);
    assert.ok(postCalled);
    assert.ok(logs.some((l) => /reenqueued/.test(l)));
  });

  it("sem --worker-url/--token (nem env) → exit 2, sem chamar fetch", async () => {
    delete process.env.DIARIA_LINKEDIN_CRON_URL;
    delete process.env.DIARIA_LINKEDIN_CRON_TOKEN;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("não deveria ter sido chamado");
    }) as typeof fetch;

    const argsNoWorker = [
      "--key",
      "queue:d1:260828",
      "--text",
      "hello",
      "--scheduled-at",
      "2026-08-29T13:00:00Z",
      "--destaque",
      "d1",
      "--channel",
      "linkedin",
    ];
    const code = await main(argsNoWorker);
    assert.equal(code, 2);
    assert.equal(fetchCalled, false);
  });

  it("args faltando → exit 1", async () => {
    const code = await main(["--key", "queue:d1:260828"]);
    assert.equal(code, 1);
  });
});
