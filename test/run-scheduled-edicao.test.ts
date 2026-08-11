/**
 * test/run-scheduled-edicao.test.ts (#4998, reativação do #2068/#3259)
 *
 * Cobertura do guard de idempotência de
 * `scripts/overnight/run-scheduled-edicao.ts` (par Linux/systemd de
 * run-scheduled-edicao.ps1): se `data/editions/{AAMMDD}/` já existe, o
 * runner pula sem invocar `claude` — nunca dispara duas vezes pra mesma
 * edição.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as runScheduledEdicaoMain } from "../scripts/overnight/run-scheduled-edicao.ts";

const AAMMDD = "260812";

function makeRepoRoot(): string {
  const repoRootAbs = mkdtempSync(join(tmpdir(), "run-scheduled-edicao-test-"));
  mkdirSync(join(repoRootAbs, "data"), { recursive: true });
  return repoRootAbs;
}

describe("run-scheduled-edicao.ts main() — guard de idempotência (#4998)", () => {
  let repoRootAbs: string;

  after(() => {
    if (repoRootAbs) rmSync(repoRootAbs, { recursive: true, force: true });
  });

  it("data/editions/{AAMMDD}/ já existe -> SKIP, nunca chama execFn (claude), retorna 0", () => {
    repoRootAbs = makeRepoRoot();
    mkdirSync(join(repoRootAbs, "data", "editions", AAMMDD), { recursive: true });

    let execCalled = false;
    const fakeExec = (() => {
      execCalled = true;
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    const code = runScheduledEdicaoMain(repoRootAbs, fakeExec, AAMMDD);

    assert.equal(code, 0);
    assert.equal(execCalled, false, "execFn (claude) não deveria ser chamado quando a edição já existe");

    const scheduleLog = readFileSync(join(repoRootAbs, "data", "overnight-schedule.log"), "utf8");
    assert.match(scheduleLog, /SKIP\s+edition=260812 reason=already-started/);
    // run-log.jsonl (via scripts/log-event.ts subprocess) não é asserido aqui:
    // o subprocess resolve o script relativo a `repoRootAbs`, que neste teste
    // é um repo FAKE sem scripts/log-event.ts — falha esperada, engolida por
    // design (writeRunLog nunca propaga, "já temos o schedule log"). Em
    // produção repoRootAbs é o checkout real, onde o script existe.
  });

  it("data/editions/{AAMMDD}/ NÃO existe -> chama execFn (claude) com o prompt esperado", () => {
    repoRootAbs = makeRepoRoot();

    let capturedArgs: string[] | undefined;
    const fakeExec = ((_cmd: string, args: string[]) => {
      capturedArgs = args;
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    const code = runScheduledEdicaoMain(repoRootAbs, fakeExec, AAMMDD);

    assert.equal(code, 0);
    assert.ok(capturedArgs, "execFn deveria ter sido chamado");
    const prompt = capturedArgs![capturedArgs!.length - 1];
    assert.equal(prompt, "/diaria-edicao 260812 --skip newsletter,linkedin,facebook");

    const scheduleLog = readFileSync(join(repoRootAbs, "data", "overnight-schedule.log"), "utf8");
    assert.match(scheduleLog, /OK\s+edition=260812 exit=0/);
  });

  it("execFn (claude) lança (exit != 0) -> propaga o exit code e loga FAIL", () => {
    repoRootAbs = makeRepoRoot();

    const fakeExec = (() => {
      const err = new Error("claude exited") as Error & { status?: number; stdout?: string; stderr?: string };
      err.status = 3;
      err.stdout = "algum output parcial";
      throw err;
    }) as unknown as typeof import("node:child_process").execFileSync;

    const code = runScheduledEdicaoMain(repoRootAbs, fakeExec, AAMMDD);

    assert.equal(code, 3);
    const scheduleLog = readFileSync(join(repoRootAbs, "data", "overnight-schedule.log"), "utf8");
    assert.match(scheduleLog, /FAIL\s+edition=260812 exit=3/);
  });
});
