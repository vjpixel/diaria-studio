/**
 * #10266: republicação A→B→A. O supersede apaga a branch remota
 * `site-publish/A` via API; a ref de tracking local sobrevivia e o
 * `push --force-with-lease` seguinte recusava. Repo git REAL (bare local).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supersedePreviousSitePage } from "../scripts/publish-edition-site-page.ts";
import type { GhRunner } from "../scripts/publish-edition-site-page.ts";

const git = (args: string[], cwd: string): string =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("#10266 — supersede apaga a ref de tracking local da branch velha", () => {
  it("A→B→A: push --force-with-lease de site-publish/A funciona após o supersede", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-10266-root-"));
    const bare = mkdtempSync(join(tmpdir(), "diaria-10266-bare-"));
    dirs.push(root, bare);
    git(["init", "-b", "master"], root);
    git(["config", "user.email", "t@example.com"], root);
    git(["config", "user.name", "T"], root);
    writeFileSync(join(root, "f.txt"), "0\n");
    git(["add", "-A"], root);
    git(["commit", "-m", "init"], root);
    rmSync(bare, { recursive: true, force: true });
    git(["clone", "--bare", root, bare], root);
    git(["remote", "add", "origin", bare], root);

    // Publicação A: branch site-publish/A pushada (cria a ref de tracking).
    git(["checkout", "-b", "site-publish/A"], root);
    writeFileSync(join(root, "f.txt"), "A1\n");
    git(["commit", "-am", "A1"], root);
    git(["push", "--force-with-lease", "-u", "origin", "site-publish/A"], root);
    git(["checkout", "master"], root);
    assert.match(git(["branch", "-r"], root), /origin\/site-publish\/A/);

    // gh mockado: o DELETE da API apaga a ref no bare, como o GitHub faria.
    const gh: GhRunner = (args) => {
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ state: "OPEN" });
      if (args[0] === "api") {
        git(["update-ref", "-d", "refs/heads/site-publish/A"], bare);
      }
      return "";
    };
    const out = supersedePreviousSitePage(root, gh, { oldSlug: "A", newSlug: "B", oldPrNumber: 1 });
    assert.equal(out.oldPrState, "closed");

    assert.doesNotMatch(git(["branch", "-r"], root), /origin\/site-publish\/A/, "ref local de tracking deve sumir");

    // Volta B→A: branch recriada do zero (outro commit); push não pode recusar.
    git(["checkout", "-B", "site-publish/A", "master"], root);
    writeFileSync(join(root, "f.txt"), "A2\n");
    git(["commit", "-am", "A2"], root);
    git(["push", "--force-with-lease", "-u", "origin", "site-publish/A"], root);
    assert.equal(
      git(["rev-parse", "site-publish/A"], bare).trim(),
      git(["rev-parse", "HEAD"], root).trim(),
    );
  });
});
