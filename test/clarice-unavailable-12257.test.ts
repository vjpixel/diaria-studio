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
 *   4. `resumeClarice` aplica o corrigido e remove o marcador só em exit 0, sem
 *      sobrescrever edição feita durante a chamada nem o erro intencional plantado
 *      (review da PR #12291), e lista os guards pós-Clarice contra o texto pré-resume.
 *   5. `skipClarice` não apaga edição do gate feita depois do snapshot.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  main,
  parseCliArgs,
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
  isClaricePending,
  claricePendingPath,
  clearClaricePending,
  postResumeSteps,
  restoreRevealLines,
  PRE_RESUME_REL,
  RESUME_COOLDOWN_MS,
  RESUME_SUGGESTIONS_TMP_REL,
} from "../scripts/lib/clarice-pending.ts";
import { resumeExitCode, RESUME_POST_STEP_FAILED_EXIT } from "../scripts/clarice-pending.ts";
import { checkClaricePending, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";
import { checkClaricePendingAtPublish, STAGE_5_RULES } from "../scripts/lib/invariant-checks/stage-5.ts";
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
      "--retry", "--max-attempts", "1", "--timeout-ms", "300", "--paragraph-timeout-ms", "300",
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
      // As tentativas abandonadas (timeout de 300ms, fallback por-parágrafo)
      // terminam depois do teto: não podem logar, nem aqui nem no run-log do
      // cwd original depois do chdir de volta (o data/ real, no checkout).
      await new Promise((r) => setTimeout(r, 1_000));
      const after = readFileSync(join(tmpDir, "data", "run-log.jsonl"), "utf8").trim().split("\n");
      assert.equal(after.length, events.length, "nenhum evento depois do clarice_unavailable");
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

/** Deixa `path` com mtime à frente do snapshot pré-Clarice. */
function touchAfterSnapshot(dir: string, path: string): void {
  const now = Date.now() / 1000;
  utimesSync(join(dir, "_internal", "02-pre-clarice.md"), now - 60, now - 60);
  utimesSync(path, now, now);
}

/**
 * Runner que simula a Clarice: grava `corrected` no --corrected-out, as
 * sugestões no --out e sai 0 com o JSON de resumo do clarice-correct.ts.
 */
function clariceWrites(
  corrected: string,
  sideEffect?: () => void,
  opts: { suggestions?: unknown[]; summary?: Record<string, unknown> } = {},
) {
  return (args: string[]): { exitCode: number; stdout: string } => {
    writeFileSync(args[args.indexOf("--corrected-out") + 1], corrected);
    writeFileSync(args[args.indexOf("--out") + 1], JSON.stringify(opts.suggestions ?? []));
    sideEffect?.();
    const summary = opts.summary ?? { suggestions_count: 0, chunks: 1, chunks_used_paragraph_fallback: 0, paragraphs_failed: 0 };
    return { exitCode: 0, stdout: `log qualquer\n${JSON.stringify(summary)}\n` };
  };
}

describe("#12257 — Stage 2 segue sem a Clarice (skip retomável)", () => {
  it("skipClarice grava 02-reviewed.md do humanizado, [] e o marcador; clarice-ran passa", () => {
    const dir = makeEditionDir();
    try {
      const marker = skipClarice(dir, "clarice_unavailable", {
        now: () => new Date("2026-11-04T12:00:00Z"),
        edition: "261105",
      });
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), "texto humanizado\n");
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "utf8")), []);
      assert.equal(marker.reason, "clarice_unavailable");
      assert.equal(marker.edition, "261105");
      assert.equal("resume_command" in marker, false, "comando de retomada é derivado, não persistido");
      assert.deepEqual(readClaricePending(dir), marker);
      assert.match(checkClaricePending(dir)[0].message, /clarice-pending\.ts resume --edition-dir .* --edition 261105/);
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

  it("skipClarice recusa sobrescrever 02-reviewed.md editado depois do snapshot; force sobrescreve", () => {
    const dir = makeEditionDir();
    try {
      const reviewed = join(dir, "02-reviewed.md");
      writeFileSync(reviewed, "texto humanizado com edição do gate\n");
      touchAfterSnapshot(dir, reviewed);
      assert.throws(() => skipClarice(dir, "clarice_unavailable"), /editado depois do snapshot/);
      assert.equal(readFileSync(reviewed, "utf8"), "texto humanizado com edição do gate\n");
      assert.equal(isClaricePending(dir), false);
      skipClarice(dir, "clarice_unavailable", { force: true });
      assert.equal(readFileSync(reviewed, "utf8"), "texto humanizado\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skipClarice sobrescreve reviewed de rodada anterior (mais velho que o snapshot)", () => {
    const dir = makeEditionDir();
    try {
      const reviewed = join(dir, "02-reviewed.md");
      writeFileSync(reviewed, "reviewed de uma rodada anterior\n");
      const old = Date.now() / 1000 - 3600;
      utimesSync(reviewed, old, old);
      skipClarice(dir, "clarice_unavailable");
      assert.equal(readFileSync(reviewed, "utf8"), "texto humanizado\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marcador malformado: readClaricePending devolve null, mas a pendência continua (status e invariante)", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(claricePendingPath(dir), JSON.stringify({ foo: 1 }));
      assert.equal(readClaricePending(dir), null);
      assert.equal(isClaricePending(dir), true);
      const v = checkClaricePending(dir);
      assert.equal(v.length, 1);
      assert.match(v[0].message, /motivo ilegível/);
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
      const failed = resumeClarice(dir, (args) => { seenArgs = args; return 6; }, { edition: "261105" });
      assert.deepEqual(failed, { status: "failed", exitCode: 6 });
      assert.equal(existsSync(claricePendingPath(dir)), true);
      assert.equal(readClaricePending(dir)?.last_attempt_outcome, "failed:6");
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), "texto humanizado com edição do gate\n");
      const inPath = seenArgs[seenArgs.indexOf("--in") + 1];
      assert.equal(inPath, join(dir, PRE_RESUME_REL), "Clarice roda sobre a cópia pré-resume do reviewed atual");
      assert.equal(readFileSync(inPath, "utf8"), "texto humanizado com edição do gate\n");
      assert.ok(seenArgs.includes("--retry"));
      assert.ok(seenArgs.includes("--no-paragraph-fallback"), "resume não aceita correção parcial por parágrafo");
      assert.notEqual(seenArgs[seenArgs.indexOf("--out") + 1], join(dir, "_internal", "02-clarice-suggestions.json"));
      assert.equal(seenArgs[seenArgs.indexOf("--edition") + 1], "261105");

      const ok = resumeClarice(
        dir,
        clariceWrites("texto corrigido pela Clarice\n", undefined, { suggestions: [{ from: "a", to: "b" }] }),
        { retryNow: true },
      );
      assert.equal(ok.status, "resumed");
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), "texto corrigido pela Clarice\n");
      assert.deepEqual(
        JSON.parse(readFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "utf8")),
        [{ from: "a", to: "b" }],
        "sugestões promovidas junto com o texto",
      );
      assert.equal(existsSync(join(dir, RESUME_SUGGESTIONS_TMP_REL)), false);
      assert.equal(existsSync(claricePendingPath(dir)), false);
      assert.deepEqual(checkClaricePending(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumeClarice não sobrescreve edição do editor feita enquanto a Clarice rodava", () => {
    const dir = makeEditionDir();
    try {
      skipClarice(dir, "clarice_unavailable");
      const reviewed = join(dir, "02-reviewed.md");
      const out = resumeClarice(
        dir,
        clariceWrites("corrigido sobre o texto velho\n", () => writeFileSync(reviewed, "editor salvou pelo Studio\n")),
      );
      assert.deepEqual(out, { status: "reviewed-changed" });
      assert.equal(readFileSync(reviewed, "utf8"), "editor salvou pelo Studio\n");
      assert.equal(isClaricePending(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumeClarice não aplica quando a Clarice corrige o erro intencional; aceita com a opção explícita", () => {
    const dir = makeEditionDir();
    try {
      skipClarice(dir, "clarice_unavailable");
      const reviewed = join(dir, "02-reviewed.md");
      writeFileSync(reviewed, "A Anthropik lançou um modelo.\n");
      writeFileSync(
        join(dir, "_internal", "intentional-error.json"),
        JSON.stringify({ wrong_value: "Anthropik", correct_value: "Anthropic" }),
      );
      const fix = clariceWrites("A Anthropic lançou um modelo.\n");
      assert.deepEqual(resumeClarice(dir, fix), { status: "intentional-error-corrected", wrongValue: "Anthropik" });
      assert.equal(readFileSync(reviewed, "utf8"), "A Anthropik lançou um modelo.\n");
      assert.equal(isClaricePending(dir), true);
      assert.deepEqual(
        JSON.parse(readFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "utf8")),
        [],
        "sugestões não promovidas quando nada é aplicado",
      );

      assert.equal(resumeClarice(dir, fix, { acceptIntentionalErrorChange: true }).status, "resumed");
      assert.equal(readFileSync(reviewed, "utf8"), "A Anthropic lançou um modelo.\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumeClarice aplica quando o erro intencional sobrevive, e ignora wrong_value placeholder", () => {
    const dir = makeEditionDir();
    try {
      skipClarice(dir, "clarice_unavailable");
      writeFileSync(join(dir, "02-reviewed.md"), "A Anthropik lançou um modelo novo .\n");
      const ie = join(dir, "_internal", "intentional-error.json");
      writeFileSync(ie, JSON.stringify({ wrong_value: "Anthropik" }));
      assert.equal(resumeClarice(dir, clariceWrites("A Anthropik lançou um modelo novo.\n")).status, "resumed");

      skipClarice(dir, "clarice_unavailable", { force: true });
      writeFileSync(join(dir, "02-reviewed.md"), "A Anthropik lançou.\n");
      writeFileSync(ie, JSON.stringify({ wrong_value: "{PREENCHER}" }));
      assert.equal(resumeClarice(dir, clariceWrites("A Anthropic lançou.\n")).status, "resumed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("postResumeSteps: guards pós-Clarice do Stage 2 contra o texto pré-resume", () => {
    const dir = "/ed/261105";
    const steps = postResumeSteps(dir);
    const byName = Object.fromEntries(steps.map((s) => [s.name, s]));
    for (const name of ["strip-emdashes-reviewed", "sync-eia-block", "verify-clarice-url-stability", "verify-clarice-coupons", "clarice-diff"]) {
      assert.ok(byName[name], `falta o passo ${name}`);
      assert.ok(existsSync(byName[name].args[0]), `script ${byName[name].args[0]} existe`);
    }
    const url = byName["verify-clarice-url-stability"].args;
    assert.equal(url[url.indexOf("--pre") + 1], join(dir, PRE_RESUME_REL));
    assert.equal(byName["verify-clarice-url-stability"].reportOnly, true);
    assert.equal(byName["verify-clarice-coupons"].reportOnly, true);
    assert.equal(byName["clarice-diff"].args[1], join(dir, PRE_RESUME_REL));
    assert.equal(byName["clarice-diff"].args.length, 4, "sem 02-normalized.md, sem 4º argumento");
  });

  it("postResumeSteps: clarice-diff recebe 02-normalized.md como 4º argumento quando existe", () => {
    const dir = makeEditionDir();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "pré-humanizador\n");
      const diff = postResumeSteps(dir).find((s) => s.name === "clarice-diff")!;
      assert.equal(diff.args[4], join(dir, "_internal", "02-normalized.md"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12257 — review da PR #12440 (fail-closed do resume e do skip)", () => {
  it("skipClarice grava o marcador ANTES do texto: falha no meio deixa a pendência visível", () => {
    const dir = makeEditionDir();
    try {
      // Sugestões como diretório: a última escrita do skip falha.
      mkdirSync(join(dir, "_internal", "02-clarice-suggestions.json"));
      assert.throws(() => skipClarice(dir, "clarice_unavailable"));
      assert.equal(isClaricePending(dir), true, "marcador já gravado");
      assert.equal(checkClaricePending(dir).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resume com fallback por parágrafo ou parágrafo falho: nada aplicado, marcador reason partial", () => {
    for (const summary of [
      { chunks_used_paragraph_fallback: 1, paragraphs_failed: 0 },
      { chunks_used_paragraph_fallback: 0, paragraphs_failed: 2 },
    ]) {
      const dir = makeEditionDir();
      try {
        skipClarice(dir, "clarice_unavailable");
        const out = resumeClarice(dir, clariceWrites("corrigido pela metade\n", undefined, { summary }));
        assert.equal(out.status, "partial");
        assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), "texto humanizado\n");
        assert.equal(readClaricePending(dir)?.reason, "partial");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("resume sem resumo legível do filho (exit 0, stdout vazio) é tratado como parcial", () => {
    const dir = makeEditionDir();
    try {
      skipClarice(dir, "clarice_unavailable");
      const out = resumeClarice(dir, (args) => {
        writeFileSync(args[args.indexOf("--corrected-out") + 1], "x\n");
        writeFileSync(args[args.indexOf("--out") + 1], "[]");
        return 0;
      });
      assert.equal(out.status, "partial");
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), "texto humanizado\n");
      assert.equal(isClaricePending(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resume com fact-check já rodado: sugestão sobre o trecho corrigido é retida (#11798)", () => {
    const dir = makeEditionDir();
    try {
      skipClarice(dir, "clarice_unavailable");
      writeFileSync(join(dir, "02-reviewed.md"), "A empresa faturou 40 milhões em 2026. O texto tem um erro de concordancia.\n");
      writeFileSync(
        join(dir, "_internal", "fact-check-autofix.json"),
        JSON.stringify({ entries: [{ status: "applied", suggested_fix: "A empresa faturou 40 milhões em 2026." }] }),
      );
      const suggestions = [
        { from: "40 milhões", to: "40 bilhões" },
        { from: "concordancia", to: "concordância" },
      ];
      const out = resumeClarice(
        dir,
        clariceWrites("A empresa faturou 40 bilhões em 2026. O texto tem um erro de concordância.\n", undefined, { suggestions }),
      );
      assert.equal(out.status, "resumed");
      assert.equal(out.status === "resumed" && out.applyMode, "filtered-suggestions");
      assert.equal(out.status === "resumed" && out.protectedDropped, 1);
      assert.equal(
        readFileSync(join(dir, "02-reviewed.md"), "utf8"),
        "A empresa faturou 40 milhões em 2026. O texto tem um erro de concordância.\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resume: log de fact-check ilegível bloqueia (fail-closed), sem tocar no texto", () => {
    const dir = makeEditionDir();
    try {
      skipClarice(dir, "clarice_unavailable");
      writeFileSync(join(dir, "_internal", "fact-check-autofix.json"), "{nao json");
      const out = resumeClarice(dir, clariceWrites("corrigido\n"));
      assert.equal(out.status, "protection-unreadable");
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), "texto humanizado\n");
      assert.equal(isClaricePending(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resume restaura verbatim o reveal da edição anterior; recusa se não consegue casar", () => {
    const dir = makeEditionDir();
    try {
      skipClarice(dir, "clarice_unavailable");
      const reveal = "Na última edição, escrevi Anthropik onde o certo era Anthropic.";
      writeFileSync(join(dir, "02-reviewed.md"), `Texto com erro de concordancia.\n\n${reveal}\n`);
      const out = resumeClarice(
        dir,
        clariceWrites("Texto com erro de concordância.\n\nNa última edição, escrevi Anthropic onde o certo era Anthropic.\n"),
      );
      assert.equal(out.status, "resumed");
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), `Texto com erro de concordância.\n\n${reveal}\n`);

      skipClarice(dir, "clarice_unavailable", { force: true });
      writeFileSync(join(dir, "02-reviewed.md"), `Texto.\n\n${reveal}\n`);
      const merged = resumeClarice(dir, clariceWrites("Texto. Escrevi Anthropic onde o certo era Anthropic.\n"));
      assert.deepEqual(merged, { status: "reveal-changed" });
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), `Texto.\n\n${reveal}\n`);
      assert.equal(isClaricePending(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restoreRevealLines sem reveal devolve o texto corrigido intacto", () => {
    assert.equal(restoreRevealLines("a\nb\n", "a\nc\n"), "a\nc\n");
  });

  it("resume: 02-reviewed.md ausente vira resultado tipado, sem exceção", () => {
    const dir = makeEditionDir();
    try {
      skipClarice(dir, "clarice_unavailable");
      rmSync(join(dir, "02-reviewed.md"));
      assert.deepEqual(resumeClarice(dir, () => 0), { status: "reviewed-missing" });
      assert.equal(isClaricePending(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resume: tentativa falha há menos de RESUME_COOLDOWN_MS não chama a Clarice de novo", () => {
    const dir = makeEditionDir();
    try {
      skipClarice(dir, "clarice_unavailable");
      const t0 = new Date("2026-11-08T10:00:00Z");
      assert.equal(resumeClarice(dir, () => 6, { now: () => t0 }).status, "failed");
      let called = false;
      const soon = new Date(t0.getTime() + RESUME_COOLDOWN_MS - 1000);
      const out = resumeClarice(dir, () => { called = true; return 0; }, { now: () => soon });
      assert.equal(out.status, "recently-attempted");
      assert.equal(called, false);
      assert.equal(resumeExitCode(out), 6);
      const later = new Date(t0.getTime() + RESUME_COOLDOWN_MS + 1000);
      assert.equal(resumeClarice(dir, () => 6, { now: () => later }).status, "failed", "passado o cooldown, tenta de novo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resume avisa quando intentional-error.json é ilegível ou o wrong_value não está no texto", () => {
    const dir = makeEditionDir();
    try {
      skipClarice(dir, "clarice_unavailable");
      const ie = join(dir, "_internal", "intentional-error.json");
      writeFileSync(ie, "{quebrado");
      const warnings: string[] = [];
      assert.equal(resumeClarice(dir, clariceWrites("ok\n"), { warn: (m) => warnings.push(m) }).status, "resumed");
      assert.match(warnings.join("\n"), /ilegível/);

      skipClarice(dir, "clarice_unavailable", { force: true });
      writeFileSync(ie, JSON.stringify({ wrong_value: "Anthropik" }));
      warnings.length = 0;
      assert.equal(resumeClarice(dir, clariceWrites("ok\n"), { warn: (m) => warnings.push(m) }).status, "resumed");
      assert.match(warnings.join("\n"), /não aparece/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clearClaricePending apaga o marcador de um skip anterior (rerun com a Clarice OK)", () => {
    const dir = makeEditionDir();
    try {
      assert.equal(clearClaricePending(dir), false);
      skipClarice(dir, "clarice_unavailable");
      assert.equal(clearClaricePending(dir), true);
      assert.equal(isClaricePending(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumeExitCode: faixa própria para cada desfecho que não aplica nada", () => {
    assert.equal(resumeExitCode({ status: "nothing-pending" }), 0);
    assert.equal(resumeExitCode({ status: "failed", exitCode: 3 }), 3);
    assert.equal(resumeExitCode({ status: "reviewed-changed" }), 7);
    assert.equal(resumeExitCode({ status: "reveal-changed" }), 8);
    assert.equal(resumeExitCode({ status: "intentional-error-corrected", wrongValue: "x" }), 8);
    assert.equal(resumeExitCode({ status: "partial", summary: null }), 10);
    assert.equal(resumeExitCode({ status: "reviewed-missing" }), 11);
    assert.equal(resumeExitCode({ status: "protection-unreadable", message: "x" }), 11);
    assert.equal(RESUME_POST_STEP_FAILED_EXIT, 9);
  });

  it("invariante clarice-pending-at-publish do Stage 5: warning em qualquer fase enquanto o marcador existe", () => {
    const dir = makeEditionDir();
    try {
      assert.deepEqual(checkClaricePendingAtPublish(dir), []);
      skipClarice(dir, "clarice_unavailable");
      const v = checkClaricePendingAtPublish(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /SEM a revisão da Clarice \(clarice_unavailable\)/);
      const rule = STAGE_5_RULES.find((r) => r.id === "clarice-pending-at-publish");
      assert.ok(rule);
      assert.notEqual(rule.postDispatchOnly, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clarice-correct.ts: --deadline-ms inválido sai 1", async () => {
    for (const bad of ["0", "-5", "abc"]) {
      const code = await withMockedExit(() => parseCliArgs(["--in", "a", "--out", "b", "--deadline-ms", bad]));
      assert.equal(code, 1, `--deadline-ms ${bad}`);
    }
  });
});

describe("#12257 — CLI clarice-pending.ts (subprocesso, sem CLARICE_API_KEY)", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  function cli(args: string[], cwd: string) {
    // cwd é o diretório da edição (o run-log vai para lá): resolver o tsx pelo repo.
    const tsx = import.meta.resolve("tsx");
    return spawnSync(process.execPath, ["--import", tsx, join(ROOT, "scripts", "clarice-pending.ts"), ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CLARICE_API_KEY: "" },
    });
  }

  it("skip → status → resume sem chave: exit 2 repassado, marcador e texto intactos; args inválidos exit 1", () => {
    const dir = makeEditionDir();
    try {
      const skip = cli(["skip", "--edition-dir", dir, "--reason", "clarice_unavailable", "--edition", "999999"], dir);
      assert.equal(skip.status, 0, skip.stderr);
      assert.match(JSON.parse(skip.stdout).resume_command, /--edition 999999/);

      const status = cli(["status", "--edition-dir", dir], dir);
      assert.equal(status.status, 0, status.stderr);
      assert.equal(JSON.parse(status.stdout).pending, true);

      const resume = cli(["resume", "--edition-dir", dir, "--edition", "999999"], dir);
      assert.equal(resume.status, 2, resume.stderr);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), "texto humanizado\n");
      assert.equal(readClaricePending(dir)?.reason, "clarice_unavailable");
      const events = readFileSync(join(dir, "data", "run-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(events.some((e) => e.message === "clarice_resume"), "resume logado no run-log");

      assert.equal(cli(["resume"], dir).status, 1);
      const clear = cli(["clear", "--edition-dir", dir], dir);
      assert.equal(clear.status, 0, clear.stderr);
      assert.equal(isClaricePending(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12257 — guard de prosa dos playbooks", () => {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

  it("Stage 2: exit 6 e skip consciente vão pelo clarice-pending.ts skip, nunca cp + echo '[]'", () => {
    const s2 = read(".claude/agents/orchestrator-stage-2.md");
    assert.match(s2, /Exit 6 \(#12257\)[\s\S]{0,800}clarice-pending\.ts skip/);
    assert.match(s2, /Skip consciente \(#2320\)[^\n]*clarice-pending\.ts skip[^\n]*--reason mcp_down_rest_exit3_editor_approved/);
    assert.doesNotMatch(s2, /echo '\[\]' > \{EDITION_DIR\}\/_internal\/02-clarice-suggestions\.json/);
    assert.match(s2, /clarice-pending\.ts clear/);
    assert.match(s2, /timeout: 600000/);
    assert.doesNotMatch(s2, /clariceRest === false[^\n]{0,200}pular direto pro halt banner/);
  });

  it("Stage 4: resume no §4a (antes do 4b) e exits 7/8/9/10/11 documentados", () => {
    const s4 = read(".claude/agents/orchestrator-stage-4.md");
    const resumeAt = s4.indexOf("clarice-pending.ts resume");
    assert.ok(resumeAt > 0 && resumeAt < s4.indexOf("### 4b."), "resume antes do pré-render/fact-check");
    const para = s4.slice(resumeAt, s4.indexOf("### 4b."));
    for (const code of ["**7**", "**8**", "**9**", "**10**", "**11**", "2/3/4/5/6"]) assert.ok(para.includes(code), `exit ${code}`);
    assert.match(para, /timeout: 600000/);
  });

  it("SKILL diaria-2-escrita e Stage 5 citam timeout e o invariante de publicação", () => {
    assert.match(read(".claude/skills/diaria-2-escrita/SKILL.md"), /timeout: 600000/);
    assert.match(read(".claude/agents/orchestrator-stage-5.md"), /clarice-pending-at-publish/);
  });
});
