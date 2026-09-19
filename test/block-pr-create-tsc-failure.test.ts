import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  TSC_PR_GUARD_BYPASS_ENV,
  checkTscAvailable,
  runTypecheck,
  truncateTscOutput,
  buildTscDenyMessage,
  buildTscUnavailableDenyMessage,
  logTscGuardEvent,
} from "../.claude/hooks/block-pr-create-tsc-failure.mjs";

// #8482: guard mecânico que bloqueia `gh pr create` quando `npx tsc --noEmit`
// falha na branch — reconstitui o cenário real (#8478/#8456: 2 PRs do
// `continuo` chegaram ao CI com TS2304 que um `tsc --noEmit` local pegaria
// na hora) travando as duas direções: branch com erro de tipo recusa,
// branch limpa passa.

describe("checkTscAvailable (#8482)", () => {
  it("true quando 'npx --no-install tsc --version' resolve (status 0)", () => {
    const fakeSpawn = () => ({ status: 0, stdout: "Version 5.x\n", stderr: "", error: null });
    assert.equal(checkTscAvailable("/wt", fakeSpawn as never), true);
  });

  it("false quando npx --no-install falha (sem node_modules local nem ancestral com typescript)", () => {
    const fakeSpawn = () => ({ status: 1, stdout: "", stderr: "npm ERR! could not determine executable to run\n", error: null });
    assert.equal(checkTscAvailable("/wt", fakeSpawn as never), false);
  });

  it("false quando o spawn falha (npx ausente do PATH)", () => {
    const fakeSpawn = () => ({ error: new Error("spawnSync npx ENOENT") });
    assert.equal(checkTscAvailable("/wt", fakeSpawn as never), false);
  });

  // #8482 achado ao vivo: um worktree ANINHADO dentro do checkout principal
  // não tem node_modules PRÓPRIO, mas `npx --no-install tsc --version`
  // resolve via o node_modules ANCESTRAL — esse é o caso comum (worktree
  // recém-criado, ainda sem `npm ci`) e não pode virar deny.
  it("true simula o caso real de worktree aninhado sem node_modules local (resolução ancestral)", () => {
    const fakeSpawn = (_cmd: string, args: string[]) => {
      assert.deepEqual(args, ["--no-install", "tsc", "--version"]);
      return { status: 0, stdout: "Version 5.7.2\n", stderr: "", error: null };
    };
    assert.equal(checkTscAvailable("/repo/.claude/worktrees/agent-x", fakeSpawn as never), true);
  });
});

describe("runTypecheck (#8482)", () => {
  it("ok:true quando tsc sai com status 0 (typecheck limpo)", () => {
    const fakeSpawn = () => ({ status: 0, stdout: "", stderr: "", error: null });
    const result = runTypecheck("/wt", fakeSpawn as never);
    assert.equal(result.infra, false);
    assert.equal(result.ok, true);
  });

  it("ok:false + output com o erro quando tsc encontra erro de tipo (caso #8478/#8456)", () => {
    const tscOutput = "scripts/lib/ads-campaign-economics.ts(388,7): error TS2304: Cannot find name 'excluded'.\n";
    const fakeSpawn = () => ({ status: 2, stdout: tscOutput, stderr: "", error: null });
    const result = runTypecheck("/wt", fakeSpawn as never);
    assert.equal(result.infra, false);
    assert.equal(result.ok, false);
    assert.match(result.output, /TS2304/);
    assert.match(result.output, /excluded/);
  });

  it("infra:true quando o spawn falha (binário ausente) — nunca tratado como erro de tipo", () => {
    const fakeSpawn = () => ({ error: new Error("spawnSync npx ENOENT") });
    const result = runTypecheck("/wt", fakeSpawn as never);
    assert.equal(result.infra, true);
    assert.equal(result.ok, false);
    assert.match(result.output, /ENOENT/);
  });

  it("infra:true quando tsc não termina (status null — timeout/sinal)", () => {
    const fakeSpawn = () => ({ status: null, stdout: "", stderr: "", error: null });
    const result = runTypecheck("/wt", fakeSpawn as never);
    assert.equal(result.infra, true);
  });

  it("combina stdout+stderr no output", () => {
    const fakeSpawn = () => ({ status: 1, stdout: "linha-stdout\n", stderr: "linha-stderr\n", error: null });
    const result = runTypecheck("/wt", fakeSpawn as never);
    assert.match(result.output, /linha-stdout/);
    assert.match(result.output, /linha-stderr/);
  });
});

describe("truncateTscOutput (#8482)", () => {
  it("devolve o texto intacto quando cabe no limite", () => {
    assert.equal(truncateTscOutput("erro curto", 100), "erro curto");
  });

  it("trunca e sinaliza quanto sobrou quando excede o limite", () => {
    const big = "x".repeat(50);
    const out = truncateTscOutput(big, 10);
    assert.equal(out.startsWith("x".repeat(10)), true);
    assert.match(out, /truncado/);
  });

  it("não-string vira string vazia", () => {
    assert.equal(truncateTscOutput(undefined as never), "");
  });
});

describe("buildTscDenyMessage / buildMissingNodeModulesDenyMessage (#8482)", () => {
  it("mensagem de deny cita o erro do tsc e o escape hatch explícito", () => {
    const msg = buildTscDenyMessage("error TS2304: Cannot find name 'excluded'.");
    assert.match(msg, /#8482/);
    assert.match(msg, /TS2304/);
    assert.match(msg, new RegExp(TSC_PR_GUARD_BYPASS_ENV));
  });

  it("mensagem de tsc indisponível nunca finge ser erro de tipo — é clara sobre o bootstrap", () => {
    const msg = buildTscUnavailableDenyMessage("/wt");
    assert.match(msg, /npm ci/);
    assert.doesNotMatch(msg, /TS\d{4}/);
  });
});

describe("logTscGuardEvent (#8482) — fail-soft e nunca silencioso quando usado", () => {
  it("grava 1 linha JSONL em data/run-log.jsonl sob repoRoot", () => {
    const writes: Array<{ path: string; content: string }> = [];
    const mkdirs: string[] = [];
    logTscGuardEvent(
      "tsc_pr_guard_bypassed",
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
    assert.equal(parsed.message, "tsc_pr_guard_bypassed");
    assert.equal(parsed.agent, "pr-create-tsc-guard");
    assert.equal(parsed.details.command, "gh pr create --title x");
  });

  it("nunca lança quando appendFn falha (fail-soft, mesmo contrato dos outros hooks)", () => {
    assert.doesNotThrow(() => {
      logTscGuardEvent(
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
    logTscGuardEvent(
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
