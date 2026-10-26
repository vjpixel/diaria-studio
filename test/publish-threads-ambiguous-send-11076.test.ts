/**
 * #11076 — publish-threads: envio ambíguo no threads_publish não é refeito.
 * Usa fetch mockado (nenhuma chamada real à Meta).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { publishTextWithRetry, ThreadsAmbiguousSendError } from "../scripts/publish-threads.ts";
import { ThreadsApiError, publishThreadsContainer } from "../scripts/lib/threads-api.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const noSleep = async () => {};

describe("publishTextWithRetry (#11076)", () => {
  it("envio ambíguo (ThreadsAmbiguousSendError) NÃO é refeito: 1 chamada, send_unknown", async () => {
    let calls = 0;
    const out = await publishTextWithRetry(async () => { calls++; throw new ThreadsAmbiguousSendError("HTTP 503"); }, { multiChunk: false, sleep: noSleep });
    assert.equal(calls, 1);
    assert.equal(out.kind, "send_unknown");
  });

  it("falha definitiva segue com retry até 3 tentativas e vira failed", async () => {
    let calls = 0;
    const out = await publishTextWithRetry(async () => { calls++; throw new ThreadsApiError("HTTP 400", "http", 400); }, { multiChunk: false, sleep: noSleep });
    assert.equal(calls, 3);
    assert.equal(out.kind, "failed");
  });

  it("falha definitiva seguida de sucesso publica", async () => {
    let calls = 0;
    const out = await publishTextWithRetry(async () => { if (++calls < 2) throw new ThreadsApiError("container ERROR", "container_failed"); return "m1"; }, { multiChunk: false, sleep: noSleep });
    assert.deepEqual(out, { kind: "published", rootMediaId: "m1", attempts: 2 });
  });

  it("falha definitiva após um ambíguo não acontece: ambíguo na 2ª tentativa também para", async () => {
    let calls = 0;
    const out = await publishTextWithRetry(async () => { calls++; throw calls === 1 ? new ThreadsApiError("HTTP 400", "http", 400) : new ThreadsAmbiguousSendError("rede"); }, { multiChunk: false, sleep: noSleep });
    assert.equal(calls, 2);
    assert.equal(out.kind, "send_unknown");
  });

  it("multi-chunk nunca refaz", async () => {
    let calls = 0;
    const out = await publishTextWithRetry(async () => { calls++; throw new Error("x"); }, { multiChunk: true, sleep: noSleep });
    assert.equal(calls, 1);
    assert.equal(out.kind, "failed");
  });
});

describe("classificação no threads_publish (#11076)", () => {
  const publish = (fetchFn: (u: string, i?: RequestInit) => Promise<Response>) => publishThreadsContainer("u", "tok", "c1", "v1.0", fetchFn);
  const ambiguous = (e: unknown) => e instanceof ThreadsApiError && e.sendMayHaveSucceeded;
  const definite = (e: unknown) => e instanceof ThreadsApiError && !e.sendMayHaveSucceeded;

  it("rede/timeout é ambíguo", async () => {
    await assert.rejects(publish(async () => { throw new Error("timeout"); }), ambiguous);
  });
  it("5xx é ambíguo", async () => {
    await assert.rejects(publish(async () => new Response("boom", { status: 502 })), ambiguous);
  });
  it("200 sem id é ambíguo", async () => {
    await assert.rejects(publish(async () => new Response("{}", { status: 200 })), ambiguous);
  });
  it("200 com corpo ilegível é ambíguo", async () => {
    await assert.rejects(publish(async () => new Response("<html>", { status: 200 })), ambiguous);
  });
  it("4xx é falha definitiva (retry permitido)", async () => {
    await assert.rejects(publish(async () => new Response("{}", { status: 400 })), definite);
  });
});

describe("fiação em publish-threads.ts (#11076)", () => {
  const SRC = readFileSync(resolve(ROOT, "scripts/publish-threads.ts"), "utf8");
  it("só o passo threads_publish converte para ThreadsAmbiguousSendError", () => {
    assert.match(SRC, /publishThreadsContainer\(userId, accessToken, containerId, apiVersion\);\s*\} catch \(e\) \{[\s\S]{0,300}ThreadsAmbiguousSendError/);
  });
  it("send_unknown é gravado e pulado no resume", () => {
    assert.match(SRC, /"send_unknown" : "failed"/);
    assert.match(SRC, /p\.status === "send_unknown"/);
  });
});
