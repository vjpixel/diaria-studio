/** #12962: republicar o mesmo slug após squash merge exige base fresca. */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { productionDeps, type GitRunner, type GhRunner, type LockRunner } from "../scripts/publish-edition-site-page.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "diaria-12962-"));
  dirs.push(dir);
  return dir;
}
const git: GitRunner = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const lock: LockRunner = () => ({ ok: true, stdout: "", stderr: "" });
const slug = "mesmo-slug";
const branch = `site-publish/${slug}`;
const page = `workers/site/public/p/${slug}/index.html`;
function write(root: string, path: string, body: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}
function setup() {
  const root = tmp();
  git(["init", "-b", "master"], root);
  git(["config", "user.name", "Test"], root);
  git(["config", "user.email", "test@example.com"], root);
  write(root, "README.md", "base\n");
  git(["add", "."], root);
  git(["commit", "-m", "base"], root);
  const bare = join(tmp(), "origin.git");
  git(["clone", "--bare", root, bare], root);
  git(["remote", "add", "origin", bare], root);
  git(["fetch", "origin"], root);
  const initial = git(["rev-parse", "HEAD"], root).trim();
  // Publicação antiga permanece na branch; master recebe um squash distinto.
  git(["checkout", "-b", branch], root);
  write(root, page, "D3 antigo\n");
  git(["add", "."], root);
  git(["commit", "-m", "publicação antiga"], root);
  git(["push", "origin", branch], root);
  git(["checkout", "master"], root);
  git(["merge", "--squash", branch], root);
  git(["commit", "-m", "squash do PR antigo"], root);
  write(root, "outra-pagina.txt", "mudança concorrente preservada\n");
  git(["add", "."], root);
  git(["commit", "-m", "mudança posterior"], root);
  git(["push", "origin", "master"], root);
  const fresh = git(["rev-parse", "HEAD"], root).trim();
  // Checkout e origin/master locais ficam anteriores ao merge.
  git(["checkout", "--detach", initial], root);
  git(["update-ref", "refs/remotes/origin/master", initial], root);
  // Variação: fetch nominal atualiza FETCH_HEAD, mas não origin/master.
  git(["config", "remote.origin.fetch", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], root);
  return { root, initial, fresh, wt: join(tmp(), "wt") };
}
function fakeGh(state: "merged" | "open" | "closed" = "merged") {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push(args);
    if (args[1] === "list") {
      return args[args.indexOf("--state") + 1] === state ? '[{"number":1,"url":"https://github.com/vjpixel/diaria-studio/pull/1"}]' : "[]";
    }
    if (args[1] === "create") return "https://github.com/vjpixel/diaria-studio/pull/2\n";
    throw new Error(`gh inesperado: ${args.join(" ")}`);
  };
  return { gh, calls };
}

describe("#12962 republicação depois do merge", () => {
  for (const deleted of [false, true]) {
    it(`gera e publica sobre master remoto atual (branch antiga ${deleted ? "apagada" : "preservada"})`, () => {
      const { root, fresh, wt } = setup();
      if (deleted) git(["push", "origin", "--delete", branch], root);
      const { gh, calls } = fakeGh();
      const deps = productionDeps(root, git, gh, lock, () => {}, wt);
      deps.writePage(slug, "D3 corrigido\n");
      assert.equal(git(["rev-parse", "HEAD"], wt).trim(), fresh, "geração precisa nascer do master fresco");
      const result = deps.publish(slug);
      assert.equal(result.pushed, true);
      assert.equal(result.prNumber, 2);
      assert.equal(git(["rev-parse", `${branch}^`], root).trim(), fresh);
      assert.equal(git(["show", `${branch}:${page}`], root), "D3 corrigido\n");
      assert.equal(git(["show", `${branch}:outra-pagina.txt`], root), "mudança concorrente preservada\n");
      assert.equal(git(["status", "--porcelain"], root), "");
      assert.ok(calls.some((a) => a.includes("merged") && a.includes(branch)), "consulta PR mergeado do mesmo slug");
      assert.equal(existsSync(wt), false);
    });
  }

  it("recusa republicar sobre referência velha quando o fetch falha após MERGED", () => {
    const { root, initial, wt } = setup();
    const { gh, calls } = fakeGh();
    const offline: GitRunner = (args, cwd) => {
      if (args[0] === "fetch") throw new Error("offline");
      return git(args, cwd);
    };
    const deps = productionDeps(root, offline, gh, lock, () => {}, wt);
    assert.throws(() => deps.writePage(slug, "D3 corrigido\n"), /republica|MERGED|mergeado/i);
    assert.equal(existsSync(wt), false);
    assert.equal(git(["rev-parse", "HEAD"], root).trim(), initial);
    assert.equal(calls.some((a) => a[1] === "create"), false);
  });

  it("falha de consulta ao GitHub interrompe antes de escrever ou pushar", () => {
    const { root, initial, wt } = setup();
    const gh: GhRunner = () => { throw new Error("GitHub indisponível"); };
    const deps = productionDeps(root, git, gh, lock, () => {}, wt);
    assert.throws(() => deps.writePage(slug, "correção"), /GitHub indisponível/);
    assert.equal(existsSync(wt), false);
    assert.equal(git(["rev-parse", "HEAD"], root).trim(), initial);
  });

  for (const state of ["open", "closed"] as const) {
    it(`PR ${state}: mantém fallback existente de fetch, sem tratar como MERGED`, () => {
      const { root, initial, wt } = setup();
      const { gh } = fakeGh(state);
      const offline: GitRunner = (args, cwd) => {
        if (args[0] === "fetch") throw new Error("offline");
        return git(args, cwd);
      };
      const deps = productionDeps(root, offline, gh, lock, () => {}, wt);
      deps.writePage(slug, "nova tentativa\n");
      assert.equal(git(["rev-parse", "HEAD"], wt).trim(), initial);
      assert.equal(readFileSync(join(wt, page), "utf8"), "nova tentativa\n");
      git(["worktree", "remove", "--force", wt], root);
    });
  }
});
