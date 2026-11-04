/**
 * test/merge-train-sync-identical-copies-12223.test.ts (#12223, regressão #633)
 *
 * O snapshot de audiência do Stage 0 fica no checkout principal
 * (`context/audience-profile.md` modificado + `docs/audience-history/*.md`
 * untracked) e vai ao master pela PR `chore/audience-snapshot-*`. Depois do
 * merge, o `git pull --ff-only` do trem (`syncLocalCheckoutAfterMerge`)
 * recusava com "untracked working tree files would be overwritten" e o
 * checkout ficava atrás do master (evidência: trem 7adbbd12e, PR #12044).
 *
 * O teste principal monta o cenário com git REAL (repo de origem + clone),
 * sem rede nem GitHub: reverter o fix faz o pull falhar e o teste cair.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRealTrainRunner, syncLocalCheckoutAfterMerge, type ExecResult, type TrainRunner } from "../scripts/lib/merge-train-live.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function write(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** origin (master com profile v1) + clone `local` em master. */
function setup(): { base: string; origin: string; local: string } {
  const base = mkdtempSync(join(tmpdir(), "train-sync-12223-"));
  const origin = join(base, "origin");
  const local = join(base, "local");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "master");
  git(origin, "config", "user.email", "t@example.com");
  git(origin, "config", "user.name", "t");
  write(origin, "context/audience-profile.md", "profile v1\n");
  write(origin, "docs/audience-history/2026-10-21.md", "snap 21\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "init");
  git(base, "clone", "-q", origin, "local");
  git(local, "config", "user.email", "t@example.com");
  git(local, "config", "user.name", "t");
  return { base, origin, local };
}

/** O 0i gera no checkout local; a PR de snapshot leva o MESMO conteúdo ao master. */
function snapshotMergedUpstream(origin: string, local: string, profile = "profile v2\n"): void {
  write(local, "context/audience-profile.md", "profile v2\n");
  write(local, "docs/audience-history/2026-10-22.md", "snap 22\n");
  write(local, "docs/audience-history/2026-10-23.md", "snap 23\n");
  write(origin, "context/audience-profile.md", profile);
  write(origin, "docs/audience-history/2026-10-22.md", "snap 22\n");
  write(origin, "docs/audience-history/2026-10-23.md", "snap 23\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "chore: snapshot de audiência 2026-10-22 a 2026-10-23");
}

describe("syncLocalCheckoutAfterMerge — cópias do snapshot de audiência (#12223)", () => {
  it("git real: snapshot idêntico ao mergeado não trava mais o pull; checkout termina no master e limpo", () => {
    const { base, origin, local } = setup();
    try {
      snapshotMergedUpstream(origin, local);
      const note = syncLocalCheckoutAfterMerge(createRealTrainRunner(local));
      assert.equal(note, null, `pull deveria ter passado, aviso: ${note}`);
      assert.equal(git(local, "rev-parse", "HEAD"), git(origin, "rev-parse", "HEAD"));
      assert.equal(git(local, "status", "--porcelain=v1", "--untracked-files=all"), "");
      assert.equal(readFileSync(join(local, "context/audience-profile.md"), "utf8"), "profile v2\n");
      assert.equal(readFileSync(join(local, "docs/audience-history/2026-10-23.md"), "utf8"), "snap 23\n");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("git real: profile local DIFERENTE do mergeado (0i mais novo) não é descartado; pull segue recusado e nada some", () => {
    const { base, origin, local } = setup();
    try {
      snapshotMergedUpstream(origin, local, "profile v2 (outro)\n");
      const headBefore = git(local, "rev-parse", "HEAD");
      const note = syncLocalCheckoutAfterMerge(createRealTrainRunner(local));
      assert.match(note ?? "", /^git pull local falhou: /);
      assert.equal(git(local, "rev-parse", "HEAD"), headBefore);
      // tudo-ou-nada: nem os snapshots idênticos saem, o profile local fica intacto
      assert.equal(readFileSync(join(local, "context/audience-profile.md"), "utf8"), "profile v2\n");
      assert.ok(existsSync(join(local, "docs/audience-history/2026-10-22.md")));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("fake: recusa que não é colisão (divergência) não roda status nem descarte, devolve a recusa original", () => {
    const calls: string[][] = [];
    const runner: TrainRunner = {
      exec(cmd, args): ExecResult {
        calls.push([cmd, ...args]);
        if (args[0] === "fetch") return { ok: true, stdout: "", stderr: "" };
        if (args[0] === "rev-parse") return { ok: true, stdout: "master\n", stderr: "" };
        if (args[0] === "pull") return { ok: false, stdout: "", stderr: "fatal: Not possible to fast-forward, aborting.\n" };
        throw new Error(`chamada inesperada: ${cmd} ${args.join(" ")}`);
      },
      sleep: async () => {},
      now: () => 0,
      mkTempDir: () => "/tmp/x",
      warn: () => {},
    };
    assert.equal(syncLocalCheckoutAfterMerge(runner), "git pull local falhou: fatal: Not possible to fast-forward, aborting.");
    assert.equal(calls.filter((c) => c[1] === "pull").length, 1);
    assert.equal(calls.some((c) => c[1] === "status" || c[1] === "clean" || c[1] === "checkout"), false);
  });
});
