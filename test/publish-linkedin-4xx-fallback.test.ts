/**
 * #6015 — Regression: Worker 4xx (validação de payload) NÃO deve cair no
 * fallback Make, que publica imediatamente e ignora `scheduled_at`.
 *
 * Bug real (23/08/2026): Worker devolveu HTTP 400 (`destaque must be d1...`),
 * o fallback Make publicou na hora errada na página pública. Fix (PR #6020):
 * 4xx propaga como falha dura; fallback só para 5xx/timeout/rede;
 * `allowImmediateFallback: false` bloqueia fallback até para 5xx.
 *
 * Testes in-process com globalThis.fetch mockado (mesmo padrão da suite #595
 * em publish-linkedin.test.ts).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispatchEntry, type DispatchContext, type DispatchInput } from "../scripts/publish-linkedin.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "publish-linkedin-4xx-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mkCtx(dir: string): DispatchContext {
  return {
    publishedPath: join(dir, "06-social-published.json"),
    webhookUrl: "https://hook.test/diaria",
    workerUrl: "https://worker.test",
    workerToken: "test-tok",
    useWorkerForScheduled: true,
    editionDate: "260999",
    // #3311: isola logEvent de auditoria no tmpdir do teste.
    rootDir: dir,
  };
}

function mkInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    destaque: "d1",
    subtype: "main",
    text: "Post agendado",
    imageUrl: null,
    scheduledAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // futuro → route=worker_queue
    webhookTarget: "diaria",
    action: "post",
    ...overrides,
  };
}

describe("#6015 dispatchEntry: Worker 4xx não cai no fallback Make imediato", () => {
  it("Worker 400 (validação) → entry failed, ZERO chamadas ao webhook Make", async () => {
    const savedFetch = globalThis.fetch;
    let makeCalls = 0;
    let workerCalls = 0;
    globalThis.fetch = async (u: string | URL | Request) => {
      const url = String(u);
      if (url.includes("/queue")) {
        workerCalls++;
        return new Response(JSON.stringify({ error: "destaque must be d1, d2, d3, or weekly[-mode]" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      makeCalls++;
      return new Response(JSON.stringify({ accepted: true, request_id: "should-not-happen" }), { status: 200 });
    };
    const { dir, cleanup } = tmpDir();
    try {
      const entry = await dispatchEntry(mkInput(), mkCtx(dir));
      assert.equal(entry.status, "failed", "4xx deve virar falha dura, não draft/publicado");
      assert.notEqual(entry.fallback_used, true, "não pode marcar fallback_used");
      assert.equal(makeCalls, 0, `webhook Make não pode ser chamado (recebeu ${makeCalls} chamadas)`);
      assert.equal(workerCalls, 2, "2 tentativas ao Worker (maxAttempts default), depois desiste");
      assert.match((entry.reason as string) ?? "", /HTTP 400|validação/i);
    } finally {
      cleanup();
      globalThis.fetch = savedFetch;
    }
  });

  it("Worker 500 → fallback Make AINDA acontece (comportamento legado preservado)", async () => {
    const savedFetch = globalThis.fetch;
    let makeCalls = 0;
    globalThis.fetch = async (u: string | URL | Request) => {
      const url = String(u);
      if (url.includes("/queue")) {
        return new Response("internal error", { status: 500 });
      }
      makeCalls++;
      return new Response(JSON.stringify({ accepted: true, request_id: "fallback-req" }), { status: 200 });
    };
    const { dir, cleanup } = tmpDir();
    try {
      const entry = await dispatchEntry(mkInput(), mkCtx(dir));
      assert.equal(entry.status, "draft");
      assert.equal(entry.fallback_used, true);
      assert.equal(makeCalls, 1);
      assert.match((entry.fallback_reason as string) ?? "", /HTTP 500/i);
    } finally {
      cleanup();
      globalThis.fetch = savedFetch;
    }
  });

  it("allowImmediateFallback=false + Worker 500 → falha dura, sem fallback (modo artigo especial)", async () => {
    const savedFetch = globalThis.fetch;
    let makeCalls = 0;
    globalThis.fetch = async (u: string | URL | Request) => {
      if (String(u).includes("/queue")) {
        return new Response("gateway timeout upstream", { status: 502 });
      }
      makeCalls++;
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    };
    const { dir, cleanup } = tmpDir();
    try {
      const entry = await dispatchEntry(
        mkInput({ allowImmediateFallback: false }),
        mkCtx(dir),
      );
      assert.equal(entry.status, "failed");
      assert.equal(makeCalls, 0);
      assert.match((entry.reason as string) ?? "", /fallback desativado/i);
    } finally {
      cleanup();
      globalThis.fetch = savedFetch;
    }
  });
});
