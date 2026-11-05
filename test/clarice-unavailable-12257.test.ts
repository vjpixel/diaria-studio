/**
 * clarice-unavailable-12257.test.ts (#12257)
 *
 * Regressão: com a API da Clarice sem resposta por minutos, `clarice-correct.ts
 * --retry` passava de 10 min (3 chunks × 3 tentativas + fallback por-parágrafo)
 * e o harness o encerrava, deixando o Stage 2 sem `02-reviewed.md`.
 *
 * Cobre:
 *   1. `withTotalDeadline` corta uma chamada que nunca responde e limpa o timer em sucesso.
 *   2. CLI `main()` contra fetch que nunca responde → exit 6 `clarice_unavailable`
 *      dentro do `--deadline-ms`, sem gravar --out, com evento no run-log.
 *   3. `skipClarice` grava 02-reviewed.md do snapshot pré-Clarice, `[]` e o marcador;
 *      o invariante `clarice-pending` do Stage 4 acusa "clarice não rodou".
 *   4. `resumeClarice` aplica o corrigido e remove o marcador só em exit 0.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  main,
  withTotalDeadline,
  withClariceRetryChunked,
  ClariceDeadlineError,
  CLARICE_UNAVAILABLE_EXIT_CODE,
  CLARICE_TOTAL_DEADLINE_MS,
} from "../scripts/clarice-correct.ts";
import {
  skipClarice,
  resumeClarice,
  readClaricePending,
  claricePendingPath,
} from "../scripts/lib/clarice-pending.ts";
import { checkClaricePending, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";
import { checkClariceRan } from "../scripts/check-stage2-invariants.ts";

/** fetch que nunca responde, mas respeita o AbortSignal (como a rede real com timeout). */
const hangingFetch: typeof fetch = (_url, init) =>
  new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted (mock hang)")));
  });

function withMockedExit(fn: () => unknown): Promise<number> {
  return new Promise<number>((resolveP) => {
    const original = process.exit.bind(process);
    let capturedCode = -1;
    (process as NodeJS.Process & { exit: (code?: number) => never }).exit = (code?: number): never => {
      capturedCode = code ?? 0;
      process.exit = original;
      resolveP(capturedCode);
      throw Object.assign(new Error("__mock_exit__"), { __mockExit: true });
    };
    const result = fn();
    if (result instanceof Promise) {
      result
        .then(() => { process.exit = original; resolveP(capturedCode); })
        .catch(() => { process.exit = original; resolveP(capturedCode); });
    }
  });
}

describe("#12257 — teto de tempo total da Clarice", () => {
  it("default fica abaixo do teto de 10 min do Bash tool do harness", () => {
    assert.ok(CLARICE_TOTAL_DEADLINE_MS < 600_000);
  });

  it("withTotalDeadline rejeita com ClariceDeadlineError quando a API nunca responde", async () => {
    const work = withClariceRetryChunked(
      { apiKey: "k", text: "um parágrafo qualquer", fetchImpl: hangingFetch, timeoutMs: 300 },
      { maxAttempts: 3, timeoutMs: 300, baseBackoffMs: 0 },
      async () => {},
      undefined,
      undefined,
      { enabled: true, timeoutMs: 300 },
    );
    const started = Date.now();
    await assert.rejects(withTotalDeadline(work, 50), (e: unknown) => e instanceof ClariceDeadlineError);
    assert.ok(Date.now() - started < 2_000, "corta no teto, não espera os retries");
  });

  it("withTotalDeadline devolve o resultado e não segura o processo em sucesso", async () => {
    const v = await withTotalDeadline(Promise.resolve(42), 60_000);
    assert.equal(v, 42);
  });

  it("CLI: fetch sem resposta → exit 6 clarice_unavailable, sem --out, evento no run-log", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "clarice-12257-"));
    const inPath = join(tmpDir, "in.md");
    const outPath = join(tmpDir, "out.json");
    const correctedPath = join(tmpDir, "corrected.md");
    writeFileSync(inPath, "texto de teste do stage 2\n\noutro parágrafo do texto");

    const originalFetch = globalThis.fetch;
    const originalCwd = process.cwd();
    const originalArgv = process.argv;
    const originalApiKey = process.env.CLARICE_API_KEY;
    globalThis.fetch = hangingFetch;
    process.env.CLARICE_API_KEY = "test-key";
    process.chdir(tmpDir);
    process.argv = [
      "node", "clarice-correct.ts",
      "--in", inPath, "--out", outPath, "--corrected-out", correctedPath,
      "--retry", "--timeout-ms", "300", "--paragraph-timeout-ms", "300",
      "--deadline-ms", "100",
      "--edition", "999999",
    ];
    try {
      const started = Date.now();
      const code = await withMockedExit(() => main());
      assert.equal(code, CLARICE_UNAVAILABLE_EXIT_CODE);
      assert.ok(Date.now() - started < 5_000, "sai no teto total, não no fim dos retries");
      assert.equal(existsSync(outPath), false, "nada gravado em --out");
      assert.equal(existsSync(correctedPath), false, "nada gravado em --corrected-out");
      const events = readFileSync(join(tmpDir, "data", "run-log.jsonl"), "utf8")
        .trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
      const unavailable = events.filter((e) => e.message === "clarice_unavailable");
      assert.equal(unavailable.length, 1);
      assert.equal(unavailable[0].level, "error");
      assert.equal(unavailable[0].edition, "999999");
    } finally {
      globalThis.fetch = originalFetch;
      process.chdir(originalCwd);
      process.argv = originalArgv;
      if (originalApiKey === undefined) delete process.env.CLARICE_API_KEY;
      else process.env.CLARICE_API_KEY = originalApiKey;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

function makeEditionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clarice-pending-12257-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "texto humanizado\n");
  return dir;
}

describe("#12257 — Stage 2 segue sem a Clarice (skip retomável)", () => {
  it("skipClarice grava 02-reviewed.md do humanizado, [] e o marcador; clarice-ran passa", () => {
    const dir = makeEditionDir();
    try {
      const marker = skipClarice(dir, "clarice_unavailable", () => new Date("2026-11-04T12:00:00Z"));
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), "texto humanizado\n");
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "utf8")), []);
      assert.equal(marker.reason, "clarice_unavailable");
      assert.match(marker.resume_command, /clarice-pending\.ts resume --edition-dir/);
      assert.deepEqual(readClaricePending(dir), marker);
      assert.equal(checkClariceRan(dir).ok, true, "sentinela do Stage 2 não trava");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skipClarice sem snapshot pré-Clarice lança e não grava nada", () => {
    const dir = mkdtempSync(join(tmpdir(), "clarice-pending-12257-"));
    try {
      assert.throws(() => skipClarice(dir, "clarice_unavailable"), /snapshot pré-Clarice ausente/);
      assert.equal(existsSync(join(dir, "02-reviewed.md")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invariante clarice-pending: warning 'clarice não rodou' com o comando de retomada; registrado no Stage 4", () => {
    const dir = makeEditionDir();
    try {
      assert.deepEqual(checkClaricePending(dir), []);
      skipClarice(dir, "clarice_unavailable");
      const v = checkClaricePending(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /clarice não rodou/);
      assert.match(v[0].message, /clarice-pending\.ts resume/);
      assert.ok(STAGE_4_RULES.some((r) => r.id === "clarice-pending"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumeClarice: falha mantém marcador e reviewed; sucesso aplica o corrigido e remove o marcador", () => {
    const dir = makeEditionDir();
    try {
      assert.deepEqual(resumeClarice(dir, () => 0), { status: "nothing-pending" });
      skipClarice(dir, "clarice_unavailable");
      writeFileSync(join(dir, "02-reviewed.md"), "texto humanizado com edição do gate\n");

      let seenArgs: string[] = [];
      const failed = resumeClarice(dir, (args) => { seenArgs = args; return 6; }, "261105");
      assert.deepEqual(failed, { status: "failed", exitCode: 6 });
      assert.equal(existsSync(claricePendingPath(dir)), true);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), "texto humanizado com edição do gate\n");
      assert.equal(seenArgs[seenArgs.indexOf("--in") + 1], join(dir, "02-reviewed.md"), "Clarice roda sobre o reviewed atual");
      assert.ok(seenArgs.includes("--retry"));
      assert.equal(seenArgs[seenArgs.indexOf("--edition") + 1], "261105");

      const ok = resumeClarice(dir, (args) => {
        writeFileSync(args[args.indexOf("--corrected-out") + 1], "texto corrigido pela Clarice\n");
        return 0;
      });
      assert.deepEqual(ok, { status: "resumed" });
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), "texto corrigido pela Clarice\n");
      assert.equal(existsSync(claricePendingPath(dir)), false);
      assert.deepEqual(checkClaricePending(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
