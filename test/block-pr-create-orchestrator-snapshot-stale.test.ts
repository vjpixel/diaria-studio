import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SNAPSHOT_PR_GUARD_BYPASS_ENV,
  runOrchestratorSnapshotCheck,
  truncateSnapshotOutput,
  buildSnapshotDenyMessage,
  logSnapshotGuardEvent,
} from "../.claude/hooks/block-pr-create-orchestrator-snapshot-stale.mjs";

// #8732: guard mecânico que bloqueia `gh pr create` quando o snapshot de
// test/orchestrator-prompt.test.ts (#634) está desatualizado — reconstitui o
// cenário real (#8723/#8703: 2 PRs seguidas editaram
// .claude/agents/orchestrator-stage-*.md sem rodar
// `NODE_TEST_SNAPSHOTS=1 npm test` e chegaram ao CI vermelhas pelo mesmo
// motivo) travando as duas direções: branch com snapshot desatualizado
// recusa, branch em dia passa.

describe("runOrchestratorSnapshotCheck (#8732)", () => {
  it("ok:true quando o teste do snapshot sai com status 0 (snapshot em dia)", () => {
    const fakeSpawn = () => ({ status: 0, stdout: "✔ snapshot hash — detecta mudanças não-intencionais\n", stderr: "", error: null });
    const result = runOrchestratorSnapshotCheck("/wt", fakeSpawn as never);
    assert.equal(result.infra, false);
    assert.equal(result.ok, true);
  });

  it("ok:false + output com os hashes quando o snapshot está desatualizado (caso #8723/#8703)", () => {
    const testOutput = "AssertionError: Orchestrator content changed (41ae257274221891 → bdde2e774d800ba8).\n";
    const fakeSpawn = () => ({ status: 1, stdout: testOutput, stderr: "", error: null });
    const result = runOrchestratorSnapshotCheck("/wt", fakeSpawn as never);
    assert.equal(result.infra, false);
    assert.equal(result.ok, false);
    assert.match(result.output, /41ae257274221891/);
    assert.match(result.output, /bdde2e774d800ba8/);
  });

  it("infra:true quando o spawn falha (tsx/npx ausente) — nunca tratado como snapshot desatualizado", () => {
    const fakeSpawn = () => ({ error: new Error("spawnSync npx ENOENT") });
    const result = runOrchestratorSnapshotCheck("/wt", fakeSpawn as never);
    assert.equal(result.infra, true);
    assert.equal(result.ok, false);
    assert.match(result.output, /ENOENT/);
  });

  it("infra:true quando o teste não termina (status null — timeout/sinal)", () => {
    const fakeSpawn = () => ({ status: null, stdout: "", stderr: "", error: null });
    const result = runOrchestratorSnapshotCheck("/wt", fakeSpawn as never);
    assert.equal(result.infra, true);
  });

  it("combina stdout+stderr no output", () => {
    const fakeSpawn = () => ({ status: 1, stdout: "linha-stdout\n", stderr: "linha-stderr\n", error: null });
    const result = runOrchestratorSnapshotCheck("/wt", fakeSpawn as never);
    assert.match(result.output, /linha-stdout/);
    assert.match(result.output, /linha-stderr/);
  });

  it("invoca npx tsx --test com o filtro correto de nome de teste", () => {
    const fakeSpawn = (cmd: string, args: string[]) => {
      assert.equal(cmd, "npx");
      assert.deepEqual(args, ["tsx", "--test", "--test-name-pattern", "snapshot hash", "test/orchestrator-prompt.test.ts"]);
      return { status: 0, stdout: "", stderr: "", error: null };
    };
    runOrchestratorSnapshotCheck("/wt", fakeSpawn as never);
  });
});

describe("truncateSnapshotOutput (#8732)", () => {
  it("devolve o texto intacto quando cabe no limite", () => {
    assert.equal(truncateSnapshotOutput("erro curto", 100), "erro curto");
  });

  it("trunca e sinaliza quanto sobrou quando excede o limite", () => {
    const big = "x".repeat(50);
    const out = truncateSnapshotOutput(big, 10);
    assert.equal(out.startsWith("x".repeat(10)), true);
    assert.match(out, /truncado/);
  });

  it("não-string vira string vazia", () => {
    assert.equal(truncateSnapshotOutput(undefined as never), "");
  });
});

describe("buildSnapshotDenyMessage (#8732)", () => {
  it("mensagem de deny cita o erro do teste, o comando de correção e o escape hatch explícito", () => {
    const msg = buildSnapshotDenyMessage("Orchestrator content changed (41ae257274221891 → bdde2e774d800ba8).");
    assert.match(msg, /#8732/);
    assert.match(msg, /41ae257274221891/);
    assert.match(msg, /NODE_TEST_SNAPSHOTS=1/);
    assert.match(msg, new RegExp(SNAPSHOT_PR_GUARD_BYPASS_ENV));
  });
});

describe("logSnapshotGuardEvent (#8732) — fail-soft e nunca silencioso quando usado", () => {
  it("grava 1 linha JSONL em data/run-log.jsonl sob repoRoot", () => {
    const writes: Array<{ path: string; content: string }> = [];
    const mkdirs: string[] = [];
    logSnapshotGuardEvent(
      "orchestrator_snapshot_pr_guard_bypassed",
      { command: "gh pr create --title x" },
      {
        repoRoot: "/wt",
        appendFn: (path: string, content: string) => writes.push({ path, content }),
        mkdirFn: (dir: string) => mkdirs.push(dir),
      } as never,
    );
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, "/wt/data/run-log.jsonl");
    const parsed = JSON.parse(writes[0].content.trim());
    assert.equal(parsed.message, "orchestrator_snapshot_pr_guard_bypassed");
    assert.equal(parsed.agent, "pr-create-orchestrator-snapshot-guard");
    assert.equal(parsed.details.command, "gh pr create --title x");
  });

  it("nunca lança quando appendFn falha (fail-soft, mesmo contrato dos outros hooks)", () => {
    assert.doesNotThrow(() => {
      logSnapshotGuardEvent(
        "x",
        {},
        {
          repoRoot: "/wt",
          appendFn: () => {
            throw new Error("disco cheio");
          },
        } as never,
      );
    });
  });

  it("repoRoot ausente/vazio não tenta escrever", () => {
    let called = false;
    logSnapshotGuardEvent(
      "x",
      {},
      {
        repoRoot: "",
        appendFn: () => {
          called = true;
        },
      } as never,
    );
    assert.equal(called, false);
  });
});
