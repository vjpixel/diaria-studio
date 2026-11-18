/**
 * test/gh-pr-create-env-prefix-13550.test.ts (#13550)
 *
 * Teste de regressão (#633): os guards de `gh pr create` eram pulados por
 * qualquer atribuição de ambiente (ou wrapper, `&`, subshell) na frente do
 * comando. `isGhPrCreateCommand` (em `block-pr-create-pii-runtime-artifacts.mjs`,
 * importado também pelos guards de typecheck, de import de test runner e de
 * snapshot do orchestrator) devolvia `false`, e o de `pr-create-review.mjs`
 * devolvia `"not-create"` — a PR saía sem guard e sem review automático.
 *
 * Cobre: o detector compartilhado (`lib/gh-pr-create-command.mjs`), a função
 * de cada hook, os três guards que importam a do PII (amarrados por import),
 * a decisão de emitir o review e o guard de PII ponta a ponta, rodando o hook
 * de verdade num repo fixture com `data/**` na branch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { runsGhPrCreate, legacyAnchoredMatch } from "../.claude/hooks/lib/gh-pr-create-command.mjs";

// Os dois hooks não têm `.d.mts`; o import por caminho em variável evita um
// TS7016 novo na catraca de `tsconfig.test.json` e os tipos vêm declarados aqui.
const HOOKS_DIR = join(import.meta.dirname, "..", ".claude", "hooks");
const piiModulePath = pathToFileURL(join(HOOKS_DIR, "block-pr-create-pii-runtime-artifacts.mjs")).href;
const reviewModulePath = pathToFileURL(join(HOOKS_DIR, "pr-create-review.mjs")).href;
const { isGhPrCreateCommand: piiIsCreate } = (await import(piiModulePath)) as {
  isGhPrCreateCommand: (command: unknown) => boolean;
};
const { isGhPrCreateCommand: reviewIsCreate, resolveEmitDecision } = (await import(reviewModulePath)) as {
  isGhPrCreateCommand: (command: unknown) => "create" | "not-create" | "unknown";
  resolveEmitDecision: (out: unknown, command: unknown) => { prUrl: string | null; reason: string };
};

// Formas citadas na issue e no comentário de confirmação do review do PR #13549.
const SHOULD_GUARD = [
  "FOO=x gh pr create --fill",
  "GH_TOKEN=x gh pr create --fill",
  "cd wt && GH_REPO=a/b gh pr create --fill",
  "env FOO=1 gh pr create",
  "env DIARIA_ALLOW_PR_WITH_TSC_ERRORS=1 gh pr create",
  "FOO=$(git rev-parse HEAD) gh pr create",
  "make & FOO=1 gh pr create",
  "(FOO=1 gh pr create)",
  "{ FOO=1 gh pr create; }",
  "command gh pr create",
  "time gh pr create --fill",
  "nohup gh pr create --fill",
  "timeout 300 gh pr create --fill",
  "gh -R vjpixel/diaria-studio pr create --fill",
  "/usr/bin/gh pr create --fill",
  "URL=$(gh pr create --fill)",
  "bash -c 'FOO=1 gh pr create --fill'",
  // `env -S` em todas as formas (review do PR #13562): separado, cluster com
  // outras flags curtas, valor colado e `--split-string`.
  "env -S 'gh pr create --fill'",
  "env -iS 'gh pr create --fill'",
  "env -S'gh pr create --fill'",
  "env -iS'gh pr create --fill'",
  "env --split-string='gh pr create --fill'",
  "env --split-string 'gh pr create --fill'",
  // as formas de antes continuam valendo
  "gh pr create --fill",
  "git push -u origin x && gh pr create --fill",
];

const SHOULD_NOT_GUARD = [
  'echo "gh pr create"',
  "echo FOO=1 gh pr create",
  "gh pr comment 5 --body 'rode FOO=1 gh pr create'",
  'git commit -m "FOO=1 gh pr create"',
  "gh pr view 5",
  "gh issue create --title x",
  "ghx pr create",
  "command -v gh",
  "env -iS 'gh pr view 5'",
  "env -S'echo gh pr create'",
];

describe("detector compartilhado runsGhPrCreate (#13550)", () => {
  for (const cmd of SHOULD_GUARD) {
    it(`reconhece: ${cmd}`, () => assert.equal(runsGhPrCreate(cmd), true));
  }
  for (const cmd of SHOULD_NOT_GUARD) {
    it(`não reconhece: ${cmd}`, () => assert.equal(runsGhPrCreate(cmd), false));
  }
  it("não-string → false", () => {
    assert.equal(runsGhPrCreate(undefined), false);
    assert.equal(runsGhPrCreate(null), false);
  });
  it("o regex antigo de fato não via o prefixo (o bug)", () => {
    assert.equal(legacyAnchoredMatch("GH_TOKEN=x gh pr create --fill"), false);
    assert.equal(legacyAnchoredMatch("gh pr create --fill"), true);
  });
});

describe("isGhPrCreateCommand de cada hook (#13550)", () => {
  for (const cmd of SHOULD_GUARD) {
    it(`PII/typecheck/test-runner/snapshot e review entram no guard: ${cmd}`, () => {
      assert.equal(piiIsCreate(cmd), true);
      assert.equal(reviewIsCreate(cmd), "create");
    });
  }
  for (const cmd of SHOULD_NOT_GUARD) {
    it(`fora do guard: ${cmd}`, () => {
      assert.equal(piiIsCreate(cmd), false);
      assert.equal(reviewIsCreate(cmd), "not-create");
    });
  }
  it("review: comando ausente segue 'unknown' (permissivo, #6298)", () => {
    assert.equal(reviewIsCreate(undefined), "unknown");
  });

  // Os três guards abaixo não têm detector próprio: importam o do PII. Se um
  // deles voltar a ter regex local, este teste acusa e o caso acima deixa de
  // cobri-lo.
  for (const hook of [
    "block-pr-create-tsc-failure.mjs",
    "block-pr-create-test-runner-import.mjs",
    "block-pr-create-orchestrator-snapshot-stale.mjs",
  ]) {
    it(`${hook} usa o isGhPrCreateCommand do guard de PII`, () => {
      const src = readFileSync(join(HOOKS_DIR, hook), "utf8");
      assert.match(
        src,
        /import\s*\{[^}]*\bisGhPrCreateCommand\b[^}]*\}\s*from\s*["']\.\/block-pr-create-pii-runtime-artifacts\.mjs["']/,
      );
      assert.doesNotMatch(src, /gh\\s\+pr\\s\+create/, "regex local de gh pr create reapareceu");
    });
  }
});

describe("review automático com prefixo de ambiente (#13550)", () => {
  it("PR criada com GH_TOKEN=x na frente emite o review", () => {
    const out = "https://github.com/vjpixel/diaria-studio/pull/13550\n";
    assert.deepEqual(resolveEmitDecision(out, "GH_TOKEN=x gh pr create --fill"), {
      prUrl: "https://github.com/vjpixel/diaria-studio/pull/13550",
      reason: "ok",
    });
  });
});

describe("guard de PII ponta a ponta com prefixo de ambiente (#13550)", () => {
  const HOOK = join(HOOKS_DIR, "block-pr-create-pii-runtime-artifacts.mjs");

  function git(args: string[], cwd: string) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  }

  function runHook(command: string, cwd: string) {
    const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd });
    const r = spawnSync(process.execPath, [HOOK], { input: payload, encoding: "utf8", cwd });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  }

  it("branch com data/** versionado: recusa com e sem prefixo, ignora citação", { timeout: 60_000 }, () => {
    const repo = mkdtempSync(join(tmpdir(), "pr-create-env-13550-"));
    try {
      git(["init", "-q", "-b", "master"], repo);
      git(["config", "user.email", "t@exemplo-teste.invalid"], repo);
      git(["config", "user.name", "t"], repo);
      writeFileSync(join(repo, "README.md"), "x\n");
      git(["add", "README.md"], repo);
      git(["commit", "-q", "-m", "base"], repo);
      git(["checkout", "-q", "-b", "feat"], repo);
      mkdirSync(join(repo, "data"));
      writeFileSync(join(repo, "data", "estado.json"), "{}\n");
      git(["add", "data/estado.json"], repo);
      git(["commit", "-q", "-m", "artefato"], repo);

      for (const cmd of ["gh pr create --fill", "GH_TOKEN=x gh pr create --fill", "env FOO=1 gh pr create --fill"]) {
        const out = runHook(cmd, repo);
        assert.match(out, /"permissionDecision":"deny"/, `não recusou: ${cmd}`);
        assert.match(out, /data\/estado\.json/);
      }
      assert.equal(runHook('echo "GH_TOKEN=x gh pr create"', repo), "");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
