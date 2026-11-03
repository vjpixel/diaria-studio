/**
 * test/typecheck-ratchet-tsc-abort-12058.test.ts (#12058)
 *
 * `tsc -p tsconfig.test.json --noEmit` abortando por heap (exit 134,
 * `FATAL ERROR: ... JavaScript heap out of memory`) ou morto por sinal
 * produzia saída sem diagnósticos, que o parser lia como "0 erros": o
 * ratchet dizia OK e o `--update-baseline` apagava a baseline inteira.
 *
 * Spawn FALSO em todos os casos — nunca roda o `tsc` real (pesado; foi ele
 * que abortou por heap no worktree isolado).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assessTscRun,
  runRatchet,
  runTscTest,
  saveBaseline,
  type SpawnLike,
  type SpawnResultLike,
} from "../scripts/typecheck-ratchet.ts";

const OOM_STDERR =
  "<--- Last few GCs --->\n\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n" +
  "----- Native stack trace -----\n";
const DIAG = "test/a.test.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\n";

function fakeSpawn(res: SpawnResultLike): { spawn: SpawnLike } {
  return { spawn: () => res };
}

function quiet<T>(fn: () => T): T {
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

describe("assessTscRun (#12058, pura)", () => {
  it("exit 134 com FATAL ERROR de heap -> abort, razão cita o exit e o FATAL", () => {
    const r = assessTscRun({ output: OOM_STDERR, status: 134, signal: null }, 0);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.match(r.reason, /exit 134/);
      assert.match(r.reason, /heap out of memory/);
    }
  });

  it("status null + SIGKILL -> abort, razão cita o sinal", () => {
    const r = assessTscRun({ output: "", status: null, signal: "SIGKILL" }, 0);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /SIGKILL/);
  });

  it("exit 134 mesmo com uma linha de diagnóstico sobrando -> abort (exit fora do contrato do tsc)", () => {
    const r = assessTscRun({ output: DIAG + OOM_STDERR, status: 134, signal: null }, 1);
    assert.equal(r.ok, false);
  });

  it("exit 1/2 sem nenhum diagnóstico parseável (saída vazia, erro de config) -> abort", () => {
    assert.equal(assessTscRun({ output: "\n", status: 1, signal: null }, 0).ok, false);
    assert.equal(
      assessTscRun({ output: "error TS5058: The specified path does not exist: 'x'.\n", status: 2, signal: null }, 0).ok,
      false,
    );
  });

  it("status null sem sinal -> abort", () => {
    assert.equal(assessTscRun({ output: "", status: null, signal: null }, 0).ok, false);
  });

  it("exit 1 e exit 2 COM diagnósticos -> resultado válido (fluxo normal do ratchet)", () => {
    assert.equal(assessTscRun({ output: DIAG, status: 1, signal: null }, 1).ok, true);
    assert.equal(assessTscRun({ output: DIAG, status: 2, signal: null }, 1).ok, true);
  });

  it("exit 0 limpo -> resultado válido", () => {
    assert.equal(assessTscRun({ output: "\n", status: 0, signal: null }, 0).ok, true);
  });
});

describe("runTscTest com spawn falso (#12058)", () => {
  it("propaga status/signal e concatena stdout+stderr", () => {
    const { spawn } = fakeSpawn({ status: 134, signal: null, stdout: "out", stderr: OOM_STDERR });
    const run = runTscTest("/tmp", spawn);
    assert.equal(run.status, 134);
    assert.equal(run.signal, null);
    assert.match(run.output, /out/);
    assert.match(run.output, /FATAL ERROR/);
  });

  it("erro de spawn (binário ausente) continua lançando", () => {
    const { spawn } = fakeSpawn({ status: null, signal: null, error: new Error("spawnSync npx ENOENT") });
    assert.throws(() => runTscTest("/tmp", spawn), /ENOENT/);
  });
});

describe("runRatchet ponta a ponta com spawn falso (#12058)", () => {
  let dir: string;
  let baselinePath: string;
  const BASELINE = { "test/a.test.ts::TS2322": 1, "test/b.test.ts::TS2345": 3 };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ratchet-12058-"));
    baselinePath = join(dir, "tsc-baseline.json");
    saveBaseline(BASELINE, baselinePath);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const readBaseline = () => readFileSync(baselinePath, "utf8");

  for (const [label, res] of [
    ["exit 134 + FATAL ERROR de heap", { status: 134, signal: null, stdout: "", stderr: OOM_STDERR }],
    ["status null + SIGKILL", { status: null, signal: "SIGKILL", stdout: "", stderr: "" }],
    ["exit 1 com saída vazia", { status: 1, signal: null, stdout: "", stderr: "" }],
  ] as const satisfies readonly (readonly [string, SpawnResultLike])[]) {
    it(`${label}: check sai 2 (nunca OK)`, () => {
      const before = readBaseline();
      const code = quiet(() => runRatchet([], { spawn: fakeSpawn(res).spawn, baselinePath, cwd: dir }));
      assert.equal(code, 2);
      assert.equal(readBaseline(), before);
    });

    it(`${label}: --update-baseline sai 2 e NÃO baixa a baseline`, () => {
      const before = readBaseline();
      const code = quiet(() =>
        runRatchet(["--update-baseline"], { spawn: fakeSpawn(res).spawn, baselinePath, cwd: dir }),
      );
      assert.equal(code, 2);
      assert.equal(readBaseline(), before);
    });
  }

  it("exit 2 com diagnósticos dentro da baseline -> OK (0)", () => {
    const res = { status: 2, signal: null, stdout: DIAG, stderr: "" };
    assert.equal(quiet(() => runRatchet([], { spawn: fakeSpawn(res).spawn, baselinePath, cwd: dir })), 0);
  });

  it("exit 1 com diagnóstico NOVO -> regressão (1)", () => {
    const res = {
      status: 1,
      signal: null,
      stdout: DIAG + "test/novo.test.ts(1,1): error TS2304: Cannot find name 'x'.\n",
      stderr: "",
    };
    assert.equal(quiet(() => runRatchet([], { spawn: fakeSpawn(res).spawn, baselinePath, cwd: dir })), 1);
  });

  it("exit 0 limpo -> OK (0) e --update-baseline regrava (baseline legitimamente vazia)", () => {
    const res = { status: 0, signal: null, stdout: "", stderr: "" };
    assert.equal(quiet(() => runRatchet([], { spawn: fakeSpawn(res).spawn, baselinePath, cwd: dir })), 0);
    assert.equal(
      quiet(() => runRatchet(["--update-baseline"], { spawn: fakeSpawn(res).spawn, baselinePath, cwd: dir })),
      0,
    );
    assert.equal(readBaseline(), "{}\n");
  });
});
