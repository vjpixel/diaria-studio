/**
 * #12693 — Clarice indisponível no Stage 4 sem motivo registrado.
 *
 * Edição 261111: `clarice-pending.ts resume` saiu 3 vezes com exit 3 e o único
 * rastro era "This operation was aborted" (o AbortError cru do fetch: era o
 * timeout de 60s do próprio cliente, mas nada dizia isso), o marcador ficou só
 * com `last_outcome: failed:3` e o gate mostrou "clarice não rodou
 * (clarice_unavailable)" sem dizer por quê. O MCP falhou com
 * SELF_SIGNED_CERT_IN_CHAIN na janela de reconexão do Wi-Fi.
 *
 * Cobre: o timeout do cliente vira `ClariceTimeoutError` com a duração; o
 * `fetch failed` ganha o código de `cause`; certificado TLS recusado não é
 * repetido; o `clarice-correct.ts` imprime `{"failure": ...}` e loga
 * `clarice_rest_failed`; o resume grava `last_reason` e os invariantes dos
 * Stages 4 e 5 levam o motivo ao gate.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClariceNetworkError,
  ClariceTimeoutError,
  classifyClariceError,
  correctTextViaREST,
  failureSummaryLine,
  isFatalClariceError,
  main,
  withClariceRetry,
  ClariceHttpError,
} from "../scripts/clarice-correct.ts";
import {
  failureReasonFromRun,
  lastResumeAttemptNote,
  readClaricePending,
  resumeClarice,
  skipClarice,
} from "../scripts/lib/clarice-pending.ts";
import { checkClaricePending } from "../scripts/lib/invariant-checks/stage-4.ts";
import { checkClaricePendingAtPublish } from "../scripts/lib/invariant-checks/stage-5.ts";

/** Igual ao undici: no abort o fetch rejeita com "This operation was aborted". */
const hangingFetch: typeof fetch = (_url, init) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
    );
  });

/** Igual ao undici: `TypeError: fetch failed` com o erro de socket/TLS em `cause`. */
function failingFetch(code: string, message: string, calls: { n: number }): typeof fetch {
  return async () => {
    calls.n++;
    throw new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
  };
}

function makeEditionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clarice-12693-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "texto humanizado\n");
  return dir;
}

describe("#12693 — motivo da falha no REST da Clarice", () => {
  it("timeout do cliente vira ClariceTimeoutError com a duração, não 'This operation was aborted'", async () => {
    await assert.rejects(
      correctTextViaREST({ apiKey: "k", text: "abc", fetchImpl: hangingFetch, timeoutMs: 30 }),
      (e: unknown) => {
        assert.ok(e instanceof ClariceTimeoutError);
        assert.doesNotMatch((e as Error).message, /This operation was aborted/);
        assert.match((e as Error).message, /não respondeu em 0s \(timeout do cliente, payload 3 bytes\)/);
        assert.equal(classifyClariceError(e).kind, "timeout");
        return true;
      },
    );
  });

  it("timeout continua retentável (3 tentativas)", async () => {
    const attempts: string[] = [];
    await assert.rejects(
      withClariceRetry(
        { apiKey: "k", text: "abc", fetchImpl: hangingFetch, onAttempt: (a) => attempts.push(a.outcome) },
        { maxAttempts: 3, timeoutMs: 20, baseBackoffMs: 0 },
        async () => {},
      ),
      ClariceTimeoutError,
    );
    assert.deepEqual(attempts, ["retryable_failure", "retryable_failure", "retryable_failure"]);
  });

  it("SELF_SIGNED_CERT_IN_CHAIN: código na mensagem, kind tls, e sem retry", async () => {
    const calls = { n: 0 };
    const attempts: Array<{ outcome: string; errorMessage?: string }> = [];
    await assert.rejects(
      withClariceRetry(
        {
          apiKey: "k",
          text: "abc",
          fetchImpl: failingFetch("SELF_SIGNED_CERT_IN_CHAIN", "self signed certificate in certificate chain", calls),
          onAttempt: (a) => attempts.push(a),
        },
        { maxAttempts: 3, timeoutMs: 1_000, baseBackoffMs: 0 },
        async () => {},
      ),
      (e: unknown) => {
        assert.ok(e instanceof ClariceNetworkError);
        assert.equal((e as ClariceNetworkError).tls, true);
        assert.match((e as Error).message, /certificado TLS recusado .*\(SELF_SIGNED_CERT_IN_CHAIN\)/);
        assert.deepEqual(classifyClariceError(e), {
          kind: "tls",
          code: "SELF_SIGNED_CERT_IN_CHAIN",
          message: (e as Error).message,
        });
        return true;
      },
    );
    assert.equal(calls.n, 1, "cert recusado não é repetido");
    assert.equal(attempts[0].outcome, "fatal_failure");
    assert.match(attempts[0].errorMessage ?? "", /SELF_SIGNED_CERT_IN_CHAIN/);
  });

  it("ENOTFOUND: kind network, retentável", async () => {
    const calls = { n: 0 };
    await assert.rejects(
      withClariceRetry(
        { apiKey: "k", text: "abc", fetchImpl: failingFetch("ENOTFOUND", "getaddrinfo ENOTFOUND cortex.clarice.ai", calls) },
        { maxAttempts: 3, timeoutMs: 1_000, baseBackoffMs: 0 },
        async () => {},
      ),
      (e: unknown) => classifyClariceError(e).kind === "network" && /ENOTFOUND/.test((e as Error).message),
    );
    assert.equal(calls.n, 3);
  });

  it("isFatalClariceError: 4xx e TLS sim; 5xx, timeout e rede não", () => {
    assert.equal(isFatalClariceError(new ClariceHttpError(401, "x")), true);
    assert.equal(isFatalClariceError(new ClariceHttpError(503, "x")), false);
    assert.equal(isFatalClariceError(new ClariceNetworkError("SELF_SIGNED_CERT_IN_CHAIN", "x")), true);
    assert.equal(isFatalClariceError(new ClariceNetworkError("ECONNRESET", "x")), false);
    assert.equal(isFatalClariceError(new ClariceTimeoutError(60_000, 10)), false);
  });

  it("CLI: cert recusado → exit 3, {failure} no stdout e clarice_rest_failed no run-log", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "clarice-12693-cli-"));
    const inPath = join(tmpDir, "in.md");
    writeFileSync(inPath, "um parágrafo de teste\n");
    const calls = { n: 0 };
    const originalFetch = globalThis.fetch;
    const originalCwd = process.cwd();
    const originalArgv = process.argv;
    const originalApiKey = process.env.CLARICE_API_KEY;
    const originalExit = process.exit;
    const originalLog = console.log;
    const originalError = console.error;
    const stdout: string[] = [];
    globalThis.fetch = failingFetch("SELF_SIGNED_CERT_IN_CHAIN", "self signed certificate in certificate chain", calls);
    process.env.CLARICE_API_KEY = "test-key";
    process.chdir(tmpDir);
    process.argv = [
      "node", "clarice-correct.ts",
      "--in", inPath, "--out", join(tmpDir, "out.json"),
      "--retry", "--no-paragraph-fallback", "--stage", "4", "--edition", "999999",
    ];
    let code = -1;
    console.log = (...a: unknown[]) => { stdout.push(a.join(" ")); };
    console.error = () => {};
    (process as { exit: (c?: number) => never }).exit = (c?: number): never => {
      code = c ?? 0;
      throw Object.assign(new Error("__mock_exit__"), { __mockExit: true });
    };
    try {
      await main().catch((e: { __mockExit?: boolean }) => { if (!e.__mockExit) throw e; });
      assert.equal(code, 3);
      assert.equal(calls.n, 1);
      const failure = JSON.parse(stdout[stdout.length - 1]) as { failure: { kind: string; code: string } };
      assert.equal(failure.failure.kind, "tls");
      assert.equal(failure.failure.code, "SELF_SIGNED_CERT_IN_CHAIN");
      const events = readFileSync(join(tmpDir, "data", "run-log.jsonl"), "utf8")
        .trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const failed = events.filter((e) => e.message === "clarice_rest_failed");
      assert.equal(failed.length, 1);
      assert.equal(failed[0].stage, 4);
      assert.equal((failed[0].details as { kind: string }).kind, "tls");
    } finally {
      console.log = originalLog;
      console.error = originalError;
      process.exit = originalExit;
      globalThis.fetch = originalFetch;
      process.chdir(originalCwd);
      process.argv = originalArgv;
      if (originalApiKey === undefined) delete process.env.CLARICE_API_KEY;
      else process.env.CLARICE_API_KEY = originalApiKey;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("#12693 — resume registra POR QUE a Clarice não rodou", () => {
  it("failureReasonFromRun: lê {failure} do stdout; sem ele, o significado do exit", () => {
    const line = failureSummaryLine({ kind: "timeout", message: "a Clarice não respondeu em 60s (timeout do cliente, payload 3830 bytes)" });
    assert.equal(
      failureReasonFromRun(3, `log\n${line}\n`),
      "a Clarice não respondeu em 60s (timeout do cliente, payload 3830 bytes)",
    );
    assert.equal(failureReasonFromRun(2, ""), "CLARICE_API_KEY ausente no ambiente");
    assert.match(failureReasonFromRun(3, "sem json"), /motivo não informado/);
    assert.match(failureReasonFromRun(6, ""), /teto total/);
  });

  it("cenário 261111: exit 3 por timeout → reason no desfecho, last_reason no marcador e no gate (Stages 4 e 5)", () => {
    const dir = makeEditionDir();
    try {
      skipClarice(dir, "clarice_unavailable", { edition: "261111" });
      const why = "a Clarice não respondeu em 60s (timeout do cliente, payload 3830 bytes)";
      let seenArgs: string[] = [];
      const t0 = new Date("2026-11-10T01:17:15Z");
      const out = resumeClarice(
        dir,
        (args) => {
          seenArgs = args;
          return { exitCode: 3, stdout: `${failureSummaryLine({ kind: "timeout", message: why })}\n` };
        },
        { edition: "261111", now: () => t0 },
      );
      assert.deepEqual(out, { status: "failed", exitCode: 3, reason: why });
      assert.equal(seenArgs[seenArgs.indexOf("--stage") + 1], "4", "tentativas do resume logadas como Stage 4");

      const marker = readClaricePending(dir);
      assert.equal(marker?.reason, "clarice_unavailable", "motivo original preservado");
      assert.equal(marker?.last_outcome, "failed:3");
      assert.equal(marker?.last_reason, why);

      const gate = checkClaricePending(dir)[0].message;
      assert.match(gate, /clarice não rodou \(clarice_unavailable\)/);
      assert.ok(gate.includes(`Última tentativa de retomar em 2026-11-10T01:17:15.000Z, failed:3: ${why}.`), gate);
      assert.ok(checkClaricePendingAtPublish(dir)[0].message.includes(why));

      // Dentro do cooldown: o motivo da última tentativa vem junto.
      const again = resumeClarice(dir, () => 0, { now: () => new Date(t0.getTime() + 60_000) });
      assert.equal(again.status, "recently-attempted");
      assert.equal(again.status === "recently-attempted" && again.lastReason, why);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("crash e parcial também deixam motivo", () => {
    const dir = makeEditionDir();
    try {
      skipClarice(dir, "clarice_unavailable");
      resumeClarice(dir, () => ({ exitCode: -1, stdout: "", crashed: "morto por signal SIGTERM" }));
      assert.match(readClaricePending(dir)?.last_reason ?? "", /SIGTERM/);
      resumeClarice(dir, () => ({ exitCode: 0, stdout: "" }));
      assert.match(readClaricePending(dir)?.last_reason ?? "", /correção parcial/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lastResumeAttemptNote: vazio sem tentativa (marcador do skip puro não muda o aviso)", () => {
    assert.equal(lastResumeAttemptNote(null), "");
    assert.equal(lastResumeAttemptNote({ reason: "x", skipped_at: "t", source: "s" }), "");
  });
});
