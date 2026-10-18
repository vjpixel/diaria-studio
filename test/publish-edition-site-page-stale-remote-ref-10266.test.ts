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
import { supersedePreviousSitePage, dropStaleTrackingRef } from "../scripts/publish-edition-site-page.ts";
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

  it("PR velho já CLOSED + branch remota apagada por fora: dropStaleTrackingRef libera A→B→A", () => {
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
    git(["checkout", "-b", "site-publish/A"], root);
    writeFileSync(join(root, "f.txt"), "A1\n");
    git(["commit", "-am", "A1"], root);
    git(["push", "--force-with-lease", "-u", "origin", "site-publish/A"], root);
    git(["checkout", "master"], root);

    // Remoto apagado por fora (delete branch on close); a ref local fica stale.
    git(["update-ref", "-d", "refs/heads/site-publish/A"], bare);
    assert.match(git(["branch", "-r"], root), /origin\/site-publish\/A/);

    const gh: GhRunner = (args) =>
      args[0] === "pr" && args[1] === "view" ? JSON.stringify({ state: "CLOSED" }) : "";
    const out = supersedePreviousSitePage(root, gh, { oldSlug: "A", newSlug: "B", oldPrNumber: 1 });
    assert.equal(out.oldPrState, "already-closed");
    // Supersede sozinho não limpa (PR não estava OPEN); o caminho do push limpa.
    assert.equal(dropStaleTrackingRef((a, c) => git(a, c), root, "site-publish/A"), undefined);
    assert.doesNotMatch(git(["branch", "-r"], root), /origin\/site-publish\/A/);

    git(["checkout", "-B", "site-publish/A", "master"], root);
    writeFileSync(join(root, "f.txt"), "A2\n");
    git(["commit", "-am", "A2"], root);
    git(["push", "--force-with-lease", "-u", "origin", "site-publish/A"], root);
    assert.equal(git(["rev-parse", "site-publish/A"], bare).trim(), git(["rev-parse", "HEAD"], root).trim());
  });

  it("branch ainda existe no remoto: ref de tracking é preservada", () => {
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
    git(["checkout", "-b", "site-publish/A"], root);
    git(["push", "-u", "origin", "site-publish/A"], root);
    assert.equal(dropStaleTrackingRef((a, c) => git(a, c), root, "site-publish/A"), undefined);
    assert.match(git(["branch", "-r"], root), /origin\/site-publish\/A/);
  });

  it("update-ref falhando vira nota, sem lançar", () => {
    const fake = (a: string[]): string => {
      if (a[0] === "update-ref") throw new Error("boom");
      return a[0] === "ls-remote" ? "" : "sha";
    };
    const note = dropStaleTrackingRef(fake, "/x", "site-publish/A");
    assert.match(note ?? "", /não apagada \(boom\)/);
  });
});
