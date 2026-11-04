/**
 * test/deploy-ref-contains-master-12118.test.ts (#12118)
 *
 * Regressão do incidente de 04/11/2026: `workflow_dispatch` do
 * `deploy-poll.yml` a partir de `develop/blast-11412`, 195 commits atrás do
 * master, publicaria em produção o Worker do poll sem a correção #12065 que
 * o master já tinha. Nada no workflow avisava.
 *
 * Duas partes:
 * 1. Comportamento de `scripts/check-deploy-ref-contains-master.sh` contra
 *    repositórios git reais em diretório temporário (origin bare + clone):
 *    branch atrás do master sai 1; branch em dia sai 0; ref master passa
 *    sem nem consultar o remoto; checkout raso (o default do
 *    actions/checkout) também é decidido certo.
 * 2. Estrutura: todo workflow que publica Worker (`npm run deploy`) roda o
 *    guard ANTES do deploy, e todo caller do reusable `deploy-worker.yml`
 *    herda o guard dele. Um deploy-*.yml novo sem o guard quebra aqui.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "check-deploy-ref-contains-master.sh");
const WORKFLOWS_DIR = resolve(ROOT, ".github", "workflows");
const GUARD_CALL = "scripts/check-deploy-ref-contains-master.sh";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} falhou em ${cwd}: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function commit(cwd: string, file: string, content: string, msg: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg);
}

function runGuard(cwd: string, ref: string): { status: number | null; out: string } {
  const r = spawnSync("bash", [SCRIPT, ref], { cwd, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("check-deploy-ref-contains-master.sh (#12118)", () => {
  let base: string;
  let origin: string;
  let work: string;

  before(() => {
    base = mkdtempSync(join(tmpdir(), "deploy-guard-12118-"));
    origin = join(base, "origin.git");
    work = join(base, "work");
    git(base, "init", "-q", "--bare", "-b", "master", origin);
    git(base, "clone", "-q", origin, work);
    git(work, "checkout", "-q", "-b", "master");
    commit(work, "a.txt", "1", "c1");
    git(work, "push", "-q", "origin", "master");
    // Branch criada aqui, depois o master anda (a correção #12065 do caso real).
    git(work, "branch", "feature-atras");
    commit(work, "poll.txt", "fix utm", "c2 correção no master");
    git(work, "push", "-q", "origin", "master");
    // Branch em dia: criada do master atual + commit próprio.
    git(work, "checkout", "-q", "-b", "feature-em-dia");
    commit(work, "b.txt", "x", "c3 da branch");
    git(work, "push", "-q", "origin", "feature-atras", "feature-em-dia");
  });

  after(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("branch atrás do master: sai 1 com instrução de rebasear", () => {
    git(work, "checkout", "-q", "feature-atras");
    const r = runGuard(work, "feature-atras");
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /1 commit\(s\) atrás/);
    assert.match(r.out, /Rebaseie/);
  });

  it("branch que contém o master: sai 0", () => {
    git(work, "checkout", "-q", "feature-em-dia");
    const r = runGuard(work, "feature-em-dia");
    assert.equal(r.status, 0, r.out);
  });

  it("ref master passa direto, sem consultar o remoto (mesmo num HEAD atrás)", () => {
    git(work, "checkout", "-q", "feature-atras");
    const r = spawnSync("bash", [SCRIPT, "master"], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, DEPLOY_GUARD_REMOTE: "remoto-inexistente" },
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const r2 = spawnSync("bash", [SCRIPT, "refs/heads/master"], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, DEPLOY_GUARD_REMOTE: "remoto-inexistente" },
    });
    assert.equal(r2.status, 0, `${r2.stdout}${r2.stderr}`);
  });

  it("ref vazio: sai 1 (não dá pra saber o que se deploya)", () => {
    const r = runGuard(work, "");
    assert.equal(r.status, 1, r.out);
  });

  it("falha de fetch: sai 1 (fail-closed)", () => {
    git(work, "checkout", "-q", "feature-em-dia");
    const r = spawnSync("bash", [SCRIPT, "feature-em-dia"], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, DEPLOY_GUARD_REMOTE: "remoto-inexistente" },
    });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /fail-closed/);
  });

  it("checkout raso (fetch-depth 1, default do actions/checkout) decide igual", () => {
    for (const [branch, expected] of [
      ["feature-atras", 1],
      ["feature-em-dia", 0],
    ] as const) {
      const shallow = join(base, `shallow-${branch}`);
      git(base, "clone", "-q", "--depth", "1", "--branch", branch, `file://${origin}`, shallow);
      assert.equal(git(shallow, "rev-parse", "--is-shallow-repository"), "true");
      const r = runGuard(shallow, branch);
      assert.equal(r.status, expected, `${branch}: ${r.out}`);
    }
  });
});

describe("workflows de deploy de Worker rodam o guard #12118", () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml"));

  function stepsDeploy(text: string): boolean {
    return /^\s*(?:-\s+)?run:\s*npm run deploy\b/m.test(text);
  }

  it("todo workflow com `npm run deploy` chama o guard antes do deploy", () => {
    const deployers = files.filter((f) => stepsDeploy(readFileSync(join(WORKFLOWS_DIR, f), "utf8")));
    assert.ok(deployers.includes("deploy-worker.yml"), "deploy-worker.yml deveria publicar Worker");
    assert.ok(deployers.length >= 6, `esperava >=6 workflows com deploy, achei ${deployers.join(",")}`);
    for (const f of deployers) {
      const text = readFileSync(join(WORKFLOWS_DIR, f), "utf8");
      const guardIdx = text.indexOf(GUARD_CALL);
      const deployIdx = text.search(/^\s*(?:-\s+)?run:\s*npm run deploy\b/m);
      assert.ok(guardIdx >= 0, `${f} publica Worker sem o guard #12118`);
      assert.ok(guardIdx < deployIdx, `${f}: guard #12118 precisa vir ANTES do deploy`);
      // Ref vai por env, nunca interpolado no script (injeção via nome de branch).
      assert.match(text, /DEPLOY_REF: \$\{\{ [^}]*github\.ref_name \}\}/, `${f}: DEPLOY_REF ausente`);
      assert.match(text, /check-deploy-ref-contains-master\.sh "\$DEPLOY_REF"/, `${f}: guard sem "$DEPLOY_REF"`);
    }
  });

  it("deploy-worker.yml usa o ref efetivo (inputs.ref antes do ref do caller)", () => {
    const text = readFileSync(join(WORKFLOWS_DIR, "deploy-worker.yml"), "utf8");
    assert.match(text, /DEPLOY_REF: \$\{\{ inputs\.ref \|\| github\.ref_name \}\}/);
  });

  it("todo workflow que publica Worker é ou chama deploy-worker.yml, ou tem o guard", () => {
    for (const f of files) {
      const text = readFileSync(join(WORKFLOWS_DIR, f), "utf8");
      const callsReusable = /uses:\s*\.\/\.github\/workflows\/deploy-worker\.yml/.test(text);
      if (!callsReusable && !stepsDeploy(text)) continue;
      assert.ok(
        callsReusable || text.includes(GUARD_CALL),
        `${f} publica Worker sem passar pelo guard #12118`,
      );
    }
  });
});
