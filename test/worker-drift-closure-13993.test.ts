/**
 * test/worker-drift-closure-13993.test.ts (#13993)
 *
 * Regressão: o alarme de drift de Worker comparava o deploy só contra o
 * último commit em `workers/{dir}/`. Um commit só num módulo de
 * `scripts/lib/**` importado pelo worker (que dispara o redeploy, #10637)
 * ficava fora da comparação, e um deploy FALHO dessa mudança passava sem
 * alarme. Agora `getLastCommitAt` recebe o fecho de imports
 * (`getWorkerTrackedPaths` → `computeWorkerExternalImports`).
 *
 * Sem rede e sem git real: o `git log` é um fake injetado que responde a
 * partir de uma lista fixa de commits (data + arquivos tocados), e o fecho
 * é calculado sobre uma árvore de fixture num diretório temporário.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getLastCommitAt, getWorkerTrackedPaths, type GitRunner } from "../scripts/worker-drift-check.ts";
import { evaluateWorkerDrift } from "../scripts/lib/worker-drift-check.ts";

interface FakeCommit {
  at: string;
  files: string[];
}

/** Fake de `git log -1 --format=%aI <ref> -- <paths...>`: commit mais recente que toca algum path. */
function fakeGitLog(commits: FakeCommit[], calls: string[][] = []): GitRunner {
  return (args) => {
    calls.push(args);
    const sep = args.indexOf("--");
    assert.ok(sep >= 0, "git log sem `--` antes dos paths");
    const paths = args.slice(sep + 1).map((p) => p.split("\\").join("/"));
    const touches = (f: string) => paths.some((p) => f === p || f.startsWith(p.endsWith("/") ? p : `${p}/`));
    const hit = commits
      .filter((c) => c.files.some(touches))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    return { status: 0, stdout: hit ? `${hit.at}\n` : "" };
  };
}

describe("worker-drift-check — fecho de imports em scripts/lib (#13993)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "worker-drift-13993-"));
    mkdirSync(join(root, "workers", "site", "src"), { recursive: true });
    mkdirSync(join(root, "scripts", "lib", "shared"), { recursive: true });
    writeFileSync(join(root, "workers", "site", "wrangler.toml"), 'name = "diaria-site"\nmain = "src/index.ts"\n');
    writeFileSync(
      join(root, "workers", "site", "src", "index.ts"),
      'import { tokens } from "../../../scripts/lib/shared/design-tokens.ts";\nexport default { fetch() { return tokens; } };\n',
    );
    writeFileSync(
      join(root, "scripts", "lib", "shared", "design-tokens.ts"),
      'import { base } from "./base.ts";\nexport const tokens = base;\n',
    );
    writeFileSync(join(root, "scripts", "lib", "shared", "base.ts"), "export const base = 1;\n");
    writeFileSync(join(root, "scripts", "lib", "nao-importado.ts"), "export const x = 2;\n");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("getWorkerTrackedPaths devolve o fecho transitivo fora de workers/{dir}, sem módulo não importado", () => {
    assert.deepEqual(getWorkerTrackedPaths("site", root), [
      "scripts/lib/shared/base.ts",
      "scripts/lib/shared/design-tokens.ts",
    ]);
  });

  it("getWorkerTrackedPaths é fail-soft: fecho que lança vira lista vazia", () => {
    const paths = getWorkerTrackedPaths("site", root, () => {
      throw new Error("boom");
    });
    assert.deepEqual(paths, []);
  });

  it("getLastCommitAt passa workers/{dir} e o fecho ao git log, depois de `--`", () => {
    const calls: string[][] = [];
    getLastCommitAt("site", root, "origin/master", ["scripts/lib/shared/base.ts"], fakeGitLog([], calls));
    assert.equal(calls.length, 1);
    const args = calls[0];
    assert.deepEqual(args.slice(0, 4), ["log", "-1", "--format=%aI", "origin/master"]);
    const paths = args.slice(args.indexOf("--") + 1).map((p) => p.split("\\").join("/"));
    assert.deepEqual(paths, ["workers/site", "scripts/lib/shared/base.ts"]);
  });

  it("cenário da issue: commit só em scripts/lib/shared depois do deploy acusa drift", () => {
    const commits: FakeCommit[] = [
      { at: "2026-11-20T10:00:00-03:00", files: ["workers/site/src/index.ts"] },
      // A mudança que disparou o redeploy (que falhou): só no módulo compartilhado.
      { at: "2026-11-24T10:00:00-03:00", files: ["scripts/lib/shared/base.ts"] },
      // Ruído: módulo de scripts/lib que o worker NÃO importa.
      { at: "2026-11-25T10:00:00-03:00", files: ["scripts/lib/nao-importado.ts"] },
    ];
    const git = fakeGitLog(commits);
    const lastDeployedAt = "2026-11-21T12:00:00.000Z"; // depois do commit no worker, antes do de scripts/lib
    const now = new Date("2026-11-26T12:00:00.000Z");

    // Comportamento antigo (só workers/{dir}): sem drift — o ponto cego.
    const semFecho = getLastCommitAt("site", root, "origin/master", [], git);
    assert.equal(semFecho, "2026-11-20T10:00:00-03:00");
    const antes = evaluateWorkerDrift(
      { workerName: "diaria-site", workerDir: "site", lastDeployedAt, lastCommitAt: semFecho, deployError: null },
      now,
    );
    assert.equal(antes.status, "ok");

    // Com o fecho: o commit em scripts/lib/shared/base.ts entra, e não o módulo não importado.
    const comFecho = getLastCommitAt("site", root, "origin/master", getWorkerTrackedPaths("site", root), git);
    assert.equal(comFecho, "2026-11-24T10:00:00-03:00");
    const depois = evaluateWorkerDrift(
      { workerName: "diaria-site", workerDir: "site", lastDeployedAt, lastCommitAt: comFecho, deployError: null },
      now,
    );
    assert.equal(depois.status, "drift");
  });

  it("git log com status != 0 continua devolvendo null", () => {
    const failing: GitRunner = () => ({ status: 128, stdout: "" });
    assert.equal(getLastCommitAt("site", root, "origin/master", ["scripts/lib/shared/base.ts"], failing), null);
  });
});
