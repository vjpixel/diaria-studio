/**
 * test/apoia-se-probe.test.ts (#3500)
 *
 * Regressão pro probe CLI `scripts/apoia-se-probe.ts` — SEM rede real:
 * `globalThis.fetch` é sempre monkeypatchado (o probe usa `checkBacker` sem
 * `fetchImpl` explícito, então o ponto de injeção aqui é o fetch global —
 * mesmo padrão de `test/fetch-sitemap.test.ts`). `process.exit`/`console.*`
 * são stubados pra capturar saída sem matar o test runner (mesmo padrão de
 * `test/cohort-order-dryrun.test.ts`).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../scripts/apoia-se-probe.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("apoia-se-probe main()", () => {
  let tmpDir: string;
  let origFetch: typeof fetch;
  let origLog: typeof console.log;
  let origError: typeof console.error;
  let origExit: typeof process.exit;
  let origEnv: Record<string, string | undefined>;

  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "apoia-se-probe-test-"));
    logs = [];
    errors = [];

    origFetch = globalThis.fetch;
    origLog = console.log;
    origError = console.error;
    origExit = process.exit;
    origEnv = {
      APOIA_SE_API_KEY: process.env.APOIA_SE_API_KEY,
      APOIA_SE_API_SECRET: process.env.APOIA_SE_API_SECRET,
      APOIA_SE_CAMPAIGN: process.env.APOIA_SE_CAMPAIGN,
    };

    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    console.error = (...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    };
    // @ts-expect-error — stub pra capturar sem matar o test runner
    process.exit = (code?: number) => {
      throw new Error(`exit:${code}`);
    };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    globalThis.fetch = origFetch;
    console.log = origLog;
    console.error = origError;
    process.exit = origExit;
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("sem --email → exit 1 com mensagem de uso", async () => {
    await assert.rejects(main([]), /exit:1/);
    assert.ok(errors.some((e) => /Uso: npx tsx scripts\/apoia-se-probe\.ts --email/.test(e)));
  });

  it("env vars ausentes → exit 1 com mensagem clara (sem bater na API)", async () => {
    delete process.env.APOIA_SE_API_KEY;
    delete process.env.APOIA_SE_API_SECRET;
    delete process.env.APOIA_SE_CAMPAIGN;

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("não deveria ter sido chamado");
    }) as unknown as typeof fetch;

    await assert.rejects(main(["--email", "foo@bar.com"]), /exit:1/);
    assert.equal(fetchCalled, false);
    assert.ok(errors.some((e) => /APOIA_SE_API_KEY/.test(e)));
    assert.ok(errors.some((e) => /\.env\.local/.test(e)));
  });

  it("status ok (200 pagante) → imprime o status certo e não sai com erro", async () => {
    process.env.APOIA_SE_API_KEY = "test-key";
    process.env.APOIA_SE_API_SECRET = "test-secret";
    process.env.APOIA_SE_CAMPAIGN = "diaria";

    globalThis.fetch = (async () =>
      jsonResponse(200, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 })) as unknown as typeof fetch;

    // --cache-dir aponta pro tmpDir isolado do teste — nunca toca data/apoia-se/ real.
    await main(["--email", "pagante@example.com", "--cache-dir", tmpDir]);

    assert.ok(errors.some((e) => /isBacker:\s*true/.test(e)));
    assert.ok(errors.some((e) => /isPaidThisMonth:\s*true/.test(e)));
    const jsonLine = logs.find((l) => l.includes("isBacker"));
    assert.ok(jsonLine);
    const parsed = JSON.parse(jsonLine!);
    assert.deepEqual(parsed, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 });
  });

  it("status not-found (200 sem thisMonthPaidValue) → imprime status sem o campo", async () => {
    process.env.APOIA_SE_API_KEY = "test-key";
    process.env.APOIA_SE_API_SECRET = "test-secret";
    process.env.APOIA_SE_CAMPAIGN = "diaria";

    globalThis.fetch = (async () =>
      jsonResponse(200, { isBacker: false, isPaidThisMonth: false })) as unknown as typeof fetch;

    await main(["--email", "naoexiste@example.com", "--cache-dir", tmpDir]);

    const jsonLine = logs.find((l) => l.includes("isBacker"));
    const parsed = JSON.parse(jsonLine!);
    assert.deepEqual(parsed, { isBacker: false, isPaidThisMonth: false });
    assert.ok(errors.some((e) => /não retornado/.test(e)));
  });

  it("401 → exit 1 com mensagem de auth (nunca imprime a credencial)", async () => {
    process.env.APOIA_SE_API_KEY = "super-secret-key-should-not-leak";
    process.env.APOIA_SE_API_SECRET = "super-secret-secret-should-not-leak";
    process.env.APOIA_SE_CAMPAIGN = "diaria";

    globalThis.fetch = (async () => jsonResponse(401, { message: "não autorizado" })) as unknown as typeof fetch;

    await assert.rejects(main(["--email", "bad@example.com", "--cache-dir", tmpDir]), /exit:1/);
    assert.ok(errors.some((e) => /401/.test(e)));
    const allOutput = [...logs, ...errors].join("\n");
    assert.doesNotMatch(allOutput, /super-secret-key-should-not-leak/);
    assert.doesNotMatch(allOutput, /super-secret-secret-should-not-leak/);
  });
});
