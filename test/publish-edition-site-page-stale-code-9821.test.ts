/**
 * test/publish-edition-site-page-stale-code-9821.test.ts (#9821)
 *
 * Incidente 261007: `sync-code.ts` saiu `protected_config_dirty` (#9276), o
 * checkout ficou 97 commits atrás de origin/master e `publish-edition-site-page.ts`
 * gerou página/home/archive com o gerador VELHO — o worktree do #8636 isola só
 * o commit/push, não o código que gera. O PR #9797 regerou 12 páginas com a
 * seta `→` já proibida (#9721/#9723).
 *
 * Garante:
 *   (a) o script recusa (code 3, motivo acionável) quando HEAD não contém
 *       origin/master — com git REAL (bare origin + 2 clones), não só mock;
 *   (b) o invariant `sync-code-ran` do Stage 6 vira `error` quando o marker
 *       registra checkout defasado ou `protected_config_dirty`; Stage 5 segue warning.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCodeFreshness,
  codeFreshnessPreflight,
  staleCodeRefusalReason,
  type GitRunner,
} from "../scripts/publish-edition-site-page.ts";
import { checkSyncCodeMarker, writeSyncCodeMarker } from "../scripts/lib/sync-code-marker.ts";
import { STAGE_6_RULES } from "../scripts/lib/invariant-checks/stage-6.ts";
import { STAGE_5_RULES } from "../scripts/lib/invariant-checks/stage-5.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

const cleanup: string[] = [];
after(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

function commit(cwd: string, file: string, content: string): void {
  writeFileSync(join(cwd, file), content);
  git(["add", file], cwd);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", file], cwd);
}

/** bare origin + `stale` (checkout de trabalho) + `other` (quem empurra commits novos). */
function setup(): { stale: string; other: string } {
  const origin = tmp("diaria-9821-origin-");
  git(["init", "-q", "--bare", "-b", "master", origin], origin);
  const other = tmp("diaria-9821-other-");
  git(["clone", "-q", origin, other], other);
  git(["checkout", "-q", "-b", "master"], other);
  commit(other, "a.txt", "1");
  git(["push", "-q", "origin", "master"], other);
  const stale = tmp("diaria-9821-stale-");
  git(["clone", "-q", "-b", "master", origin, stale], stale);
  return { stale, other };
}

describe("checkCodeFreshness — git real (#9821)", () => {
  it("checkout em dia → não defasado", () => {
    const { stale } = setup();
    const f = checkCodeFreshness(stale);
    assert.equal(f.stale, false);
    assert.equal(f.behindBy, 0);
    assert.equal(staleCodeRefusalReason(f), null);
  });

  it("origin/master avançou → fetch enxerga e acusa N commits atrás", () => {
    const { stale, other } = setup();
    commit(other, "b.txt", "2");
    commit(other, "c.txt", "3");
    git(["push", "-q", "origin", "master"], other);
    // #9828: só conta como defasado se os commits tocam o gerador — aqui b.txt faz esse papel.
    const f = checkCodeFreshness(stale, undefined, ["b.txt"]);
    assert.equal(f.fetchFailed, false);
    assert.equal(f.stale, true);
    assert.equal(f.behindBy, 2);
    const reason = staleCodeRefusalReason(f);
    assert.ok(reason);
    assert.match(reason, /2 commit\(s\) atrás/);
    assert.match(reason, /sync-code\.ts/);
    assert.match(reason, /protected_config_dirty/);
  });

  it("checkout à frente de origin/master (branch com commits locais) → não defasado", () => {
    const { stale } = setup();
    commit(stale, "local.txt", "x");
    assert.equal(checkCodeFreshness(stale).stale, false);
  });
});

describe("codeFreshnessPreflight (#9821)", () => {
  // #9828: o diff dos caminhos do gerador acusa mudança.
  const behind: GitRunner = (args) =>
    args[0] === "rev-list" ? "97\n" : args[0] === "diff" ? "scripts/lib/site-home-page.ts\n" : "";
  const paths = ["scripts/lib/site-home-page.ts"];
  const upToDate: GitRunner = (args) => (args[0] === "rev-list" ? "0\n" : "");
  const broken: GitRunner = (args) => {
    if (args[0] === "rev-list") throw new Error("unknown revision origin/master");
    throw new Error("offline");
  };

  it("defasado → code 3 com motivo (cenário real: 97 commits)", () => {
    const r = codeFreshnessPreflight(["--edition-dir", "x", "--slug", "s"], "/r", behind, paths);
    assert.equal(r?.code, 3);
    assert.match(r!.reason, /97 commit/);
  });

  it("em dia → null (segue)", () => {
    assert.equal(codeFreshnessPreflight(["--edition-dir", "x"], "/r", upToDate), null);
  });

  it("não mediu (origin/master ausente) → fail-closed, code 3", () => {
    const r = codeFreshnessPreflight(["--edition-dir", "x"], "/r", broken);
    assert.equal(r?.code, 3);
    assert.match(r!.reason, /não foi possível medir/);
    assert.match(r!.reason, /fetch origin master. falhou/);
  });

  it("--skip-publish e --allow-stale-code pulam o guard", () => {
    assert.equal(codeFreshnessPreflight(["--skip-publish"], "/r", behind), null);
    assert.equal(codeFreshnessPreflight(["--allow-stale-code"], "/r", behind), null);
  });
});

describe("sync-code-ran: Stage 6 vira error com código defasado (#9821)", () => {
  const rule6 = STAGE_6_RULES.find((r) => r.id === "sync-code-ran")!;
  const rule5 = STAGE_5_RULES.find((r) => r.id === "sync-code-ran")!;

  it("protected_config_dirty, 97 atrás → error no Stage 6, warning no Stage 5", () => {
    const d = tmp("diaria-9821-ed-");
    writeSyncCodeMarker(d, { ran_at: "x", outcome: "protected_config_dirty", commits_behind: 97, up_to_date: false });
    const v6 = rule6.run(d);
    assert.equal(v6.length, 1);
    assert.equal(v6[0].severity, "error");
    assert.match(v6[0].message, /97 commit/);
    assert.match(v6[0].message, /#9821/);
    assert.equal(rule5.run(d)[0].severity, "warning");
  });

  it("protected_config_dirty sem defasagem contada → ainda acusa (error no 6)", () => {
    const d = tmp("diaria-9821-ed-");
    writeSyncCodeMarker(d, { ran_at: "x", outcome: "protected_config_dirty", commits_behind: 0, up_to_date: false });
    assert.equal(rule6.run(d)[0].severity, "error");
    assert.equal(checkSyncCodeMarker(d)[0].severity, "warning");
  });

  it("marker ausente ou em dia → inalterado (warning / nada)", () => {
    const d = tmp("diaria-9821-ed-");
    assert.equal(rule6.run(d)[0].severity, "warning");
    writeSyncCodeMarker(d, { ran_at: "x", outcome: "already_up_to_date", commits_behind: 0, up_to_date: true });
    assert.deepEqual(rule6.run(d), []);
  });
});
