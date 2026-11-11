/**
 * test/run-tests-file-exit-12848.test.ts (#12848)
 *
 * Arquivo de teste cujo processo morre fora do node:test (sinal, `process.exit`)
 * aparecia no reporter `spec` só como `'test failed'` em 1:1. O `run-tests.ts`
 * passou a gravar um 2º reporter `tap` por batch e a imprimir exitCode/signal
 * desses arquivos. Aqui: o parser do TAP (puro), as flags de reporter e um run
 * REAL de `node --test` sobre fixtures que se matam, conferindo que a saída do
 * spec segue igual e que o caminho verde não ganha linha nenhuma.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTapFileExits,
  formatFileExitDiagnostics,
  fileExitReporterArgs,
  processChunkedBatches,
  FILE_EXIT_MARKER,
} from "../scripts/run-tests.ts";

// TAP real do Node 24.19 (sonda da issue): exit.test.mjs com process.exit(7),
// um teste verde, seg.test.mjs morto por SIGSEGV.
const TAP_REAL = `TAP version 13
# Subtest: /tmp/p/exit.test.mjs
not ok 1 - /tmp/p/exit.test.mjs
  ---
  duration_ms: 71.354253
  type: 'test'
  location: '/tmp/p/exit.test.mjs:1:1'
  failureType: 'testCodeFailure'
  exitCode: 7
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
# Subtest: ok
ok 2 - ok
  ---
  duration_ms: 0.827249
  type: 'test'
  ...
# Subtest: /tmp/p/seg.test.mjs
not ok 3 - /tmp/p/seg.test.mjs
  ---
  duration_ms: 1219.17189
  type: 'test'
  location: '/tmp/p/seg.test.mjs:1:1'
  failureType: 'testCodeFailure'
  exitCode: ~
  signal: 'SIGSEGV'
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..3
# fail 2
`;

describe("parseTapFileExits (#12848)", () => {
  it("extrai exitCode e signal dos arquivos mortos do TAP real", () => {
    assert.deepEqual(parseTapFileExits(TAP_REAL), [
      { file: "/tmp/p/exit.test.mjs", exitCode: 7, signal: null },
      { file: "/tmp/p/seg.test.mjs", exitCode: null, signal: "SIGSEGV" },
    ]);
  });

  it("ignora falha comum de asserção (testCodeFailure sem exitCode/signal) e subtestsFailed", () => {
    const tap = `TAP version 13
not ok 1 - soma
  ---
  duration_ms: 1.2
  location: '/r/test/a.test.ts:3:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    exitCode: 9
    signal: 'SIGKILL'
  code: 'ERR_ASSERTION'
  stack: |-
    at x
  ...
not ok 2 - /r/test/b.test.ts
  ---
  location: '/r/test/b.test.ts:1:1'
  failureType: 'subtestsFailed'
  exitCode: 1
  signal: ~
  error: '1 subtest failed'
  ...
`;
    assert.deepEqual(parseTapFileExits(tap), []);
  });

  it("lê bloco aninhado (indentação maior), CRLF e caminho com aspas escapadas", () => {
    const tap = [
      "TAP version 13",
      "    not ok 1 - x",
      "      ---",
      "      location: 'C:\\r\\it''s\\k.test.ts:1:1'",
      "      failureType: 'testCodeFailure'",
      "      exitCode: ~",
      "      signal: 'SIGKILL'",
      "      ...",
      "",
    ].join("\r\n");
    assert.deepEqual(parseTapFileExits(tap), [{ file: "C:\\r\\it's\\k.test.ts", exitCode: null, signal: "SIGKILL" }]);
  });

  it("TAP truncado (batch morto no meio) devolve o que der para ler, sem lançar", () => {
    const cut = TAP_REAL.slice(0, TAP_REAL.indexOf("# Subtest: ok"));
    assert.deepEqual(parseTapFileExits(cut), [{ file: "/tmp/p/exit.test.mjs", exitCode: 7, signal: null }]);
    assert.deepEqual(parseTapFileExits(""), []);
    assert.deepEqual(parseTapFileExits("not ok 1 - x\n  ---\n  failureType: 'testCodeFailure'\n  signal: 'SIGSEGV'"), [
      { file: "x", exitCode: null, signal: "SIGSEGV" },
    ]);
  });

  it("formatFileExitDiagnostics: marcador greppável + linha legível por arquivo", () => {
    const text = formatFileExitDiagnostics("batch 1/2", [
      { file: "/r/a.test.ts", exitCode: null, signal: "SIGSEGV" },
      { file: "/r/b.test.ts", exitCode: 7, signal: null },
    ]);
    assert.match(text, /^RUN_TESTS_FILE_EXIT batch=batch 1\/2 arquivo=\/r\/a\.test\.ts signal=SIGSEGV exitCode=null$/m);
    assert.match(text, /^RUN_TESTS_FILE_EXIT batch=batch 1\/2 arquivo=\/r\/b\.test\.ts signal=null exitCode=7$/m);
    assert.match(text, /por sinal SIGSEGV/);
    assert.match(text, /com exit code 7/);
    assert.equal(formatFileExitDiagnostics("batch 1/1", []), "");
  });
});

describe("fileExitReporterArgs (#12848)", () => {
  it("repete o reporter default no stdout (spec no Node >= 23) e acrescenta o tap no arquivo", () => {
    assert.deepEqual(fileExitReporterArgs([], "/t/x.tap", 24), [
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=tap",
      "--test-reporter-destination=/t/x.tap",
    ]);
    assert.equal(fileExitReporterArgs(["--test-name-pattern", "foo"], "/t/x.tap", 22)[0], "--test-reporter=tap");
  });

  it("quem chamou já escolheu reporter: nada é acrescentado", () => {
    assert.deepEqual(fileExitReporterArgs(["--test-reporter=dot"], "/t/x.tap", 24), []);
    assert.deepEqual(fileExitReporterArgs(["--test-reporter", "dot"], "/t/x.tap", 24), []);
    assert.deepEqual(fileExitReporterArgs(["--test-reporter-destination=out.txt"], "/t/x.tap", 24), []);
  });
});

/** Coleta stdout/stderr de `processChunkedBatches` em string. */
function sink() {
  let text = "";
  return { write: (c: string) => void (text += c), get text() { return text; } };
}

/** Tira o que varia entre dois runs iguais (durações). */
function normalize(s: string): string {
  return s.replace(/\(\d+(?:\.\d+)?ms\)/g, "(Xms)").replace(/duration_ms [\d.]+/g, "duration_ms X");
}

/** Mesmo conteúdo de linhas, sem depender da ordem em que arquivos
 *  concorrentes terminaram. */
function sameLines(a: string, b: string): void {
  assert.deepEqual(normalize(a).split("\n").sort(), normalize(b).split("\n").sort());
}

function tapLeftovers(): string[] {
  return readdirSync(tmpdir()).filter((f) => f.startsWith(`run-tests-12848-${process.pid}-`));
}

describe("processChunkedBatches com node --test REAL (#12848)", () => {
  const run = (files: string[], fileExitDiagnostics?: boolean) => {
    const stdout = sink();
    const stderr = sink();
    const r = processChunkedBatches([files], {
      stdout,
      stderr,
      batchTimeoutMs: 120_000,
      bisectBudgetMs: 0,
      retryDelayMs: 0,
      ...(fileExitDiagnostics === undefined ? {} : { fileExitDiagnostics }),
    });
    return { ...r, out: stdout.text, err: stderr.text };
  };

  it("arquivo que morre por process.exit e por SIGSEGV sai com exitCode/signal no stderr; spec do stdout intacto", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "run-tests-12848-fx-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const exitFile = join(dir, "exit.test.mjs");
    const segFile = join(dir, "seg.test.mjs");
    const okFile = join(dir, "ok.test.mjs");
    writeFileSync(exitFile, `import { test } from "node:test";\ntest("sai", () => { process.exit(7); });\n`);
    writeFileSync(segFile, `import { test } from "node:test";\ntest("mata", () => { process.kill(process.pid, "SIGSEGV"); });\n`);
    writeFileSync(okFile, `import { test } from "node:test";\ntest("ok", () => {});\n`);
    const withSignal = process.platform !== "win32"; // sinal POSIX só faz sentido fora do Windows
    const files = withSignal ? [exitFile, segFile, okFile] : [exitFile, okFile];

    const on = run(files);
    assert.equal(on.exitCode, 1);
    assert.ok(on.err.includes(`${FILE_EXIT_MARKER} batch=batch 1/1 arquivo=${exitFile} signal=null exitCode=7`), on.err);
    if (withSignal) {
      assert.ok(on.err.includes(`${FILE_EXIT_MARKER} batch=batch 1/1 arquivo=${segFile} signal=SIGSEGV exitCode=null`), on.err);
    }
    assert.ok(!on.err.includes(`arquivo=${okFile}`), "arquivo verde nunca aparece no diagnóstico");
    // saída do spec no stdout: igual à do run sem o 2º reporter
    const off = run(files, false);
    assert.ok(!off.err.includes(FILE_EXIT_MARKER));
    sameLines(on.out, off.out);
    assert.match(on.out, /'test failed'/);
    assert.match(on.out, /^ℹ fail \d+$/m);
    assert.deepEqual(tapLeftovers(), [], "TAP temporário apagado ao fim do batch");
  });

  it("caminho verde: nenhuma linha extra e stdout idêntico ao de antes", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "run-tests-12848-fx-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const okFile = join(dir, "ok.test.mjs");
    writeFileSync(okFile, `import { test } from "node:test";\ntest("ok", () => {});\n`);
    const on = run([okFile]);
    const off = run([okFile], false);
    assert.equal(on.exitCode, 0);
    assert.equal(on.err, off.err);
    sameLines(on.out, off.out);
    assert.deepEqual(tapLeftovers(), []);
  });
});
