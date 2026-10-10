/**
 * #9925 — regressão do incidente 261009: `merge --ff-only` recusou porque
 * arquivos gerados rastreados (sitemap.xml, audience-profile.md) e uma página
 * nova não-rastreada colidiam com origin/master; o fallback de stash
 * `--include-untracked` (sem pathspec) tentou limpar TODO untracked do
 * checkout, falhou com Permission denied em caminhos que nem colidiam, e o
 * sync terminou `stash_partial_failure_unrecovered` — 18 commits atrás.
 *
 * Fix: stash DIRECIONADO só aos caminhos que o git listou como colisão; e o
 * veredito `code_freshness` faz o "não sincronizou" virar banner explícito.
 *
 * Camadas: puro (targetedStashPathsFor, assessCodeFreshness) + git REAL num
 * par origin(bare)+clone temporário, com um diretório untracked sem permissão
 * de escrita reproduzindo o Permission denied.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  syncCode,
  targetedStashPathsFor,
  TARGETED_STASH_MAX_PATHS,
  type SpawnFn,
  type SpawnResult,
  type SyncLock,
} from "../scripts/lib/git-sync.ts";
import { assessCodeFreshness, formatCodeFreshnessBanner } from "../scripts/lib/sync-code-freshness.ts";

const NOOP_LOCK: SyncLock = { path: "(noop)", acquire: () => true, release: () => {} };
const MAIN_CHECKOUT = "/home/editor/diaria-studio";

describe("#9925 targetedStashPathsFor — puro", () => {
  it("colisão de arquivos → os caminhos (dedup)", () => {
    assert.deepEqual(
      targetedStashPathsFor({ kind: "local_changes_collide", paths: ["a", "p/x/index.html", "a"], stderr: "" }),
      ["a", "p/x/index.html"],
    );
    assert.deepEqual(targetedStashPathsFor({ kind: "untracked_collide", paths: ["n.txt"], stderr: "" }), ["n.txt"]);
  });

  it("divergência / desconhecido / lista vazia / caminho entre aspas / lista enorme → null (stash amplo)", () => {
    assert.equal(targetedStashPathsFor({ kind: "diverged", paths: [], stderr: "" }), null);
    assert.equal(targetedStashPathsFor({ kind: "unknown", paths: [], stderr: "" }), null);
    assert.equal(targetedStashPathsFor({ kind: "local_changes_collide", paths: [], stderr: "" }), null);
    assert.equal(targetedStashPathsFor({ kind: "local_changes_collide", paths: ['"a b.txt"'], stderr: "" }), null);
    const many = Array.from({ length: TARGETED_STASH_MAX_PATHS + 1 }, (_, i) => `f${i}`);
    assert.equal(targetedStashPathsFor({ kind: "local_changes_collide", paths: many, stderr: "" }), null);
  });
});

describe("#9925 assessCodeFreshness — puro", () => {
  it("em dia → fresh, sem banner", () => {
    const f = assessCodeFreshness({ outcome: "synced", commits_behind: 0, up_to_date: true });
    assert.equal(f.status, "fresh");
    assert.equal(formatCodeFreshnessBanner(f, { outcome: "synced" }), null);
  });

  it("atrás → stale com banner CÓDIGO DEFASADO (inclusive o outcome do incidente)", () => {
    const f = assessCodeFreshness({ outcome: "stash_partial_failure_unrecovered", commits_behind: 18, up_to_date: false });
    assert.equal(f.status, "stale");
    assert.match(formatCodeFreshnessBanner(f, { outcome: "stash_partial_failure_unrecovered" }) ?? "", /CÓDIGO DEFASADO — código 18 commit/);
  });

  it("fetch falhou com commits_behind 0 (ref local velho) → unknown, banner NÃO VERIFICADO", () => {
    for (const outcome of ["fetch_failed", "fetch_timeout", "sync_in_progress", "checkout_failed"] as const) {
      const f = assessCodeFreshness({ outcome, commits_behind: 0, up_to_date: true });
      assert.equal(f.status, "unknown", outcome);
      assert.match(formatCodeFreshnessBanner(f, { outcome }) ?? "", /CÓDIGO NÃO VERIFICADO/);
    }
  });

  it("#9988: preexisting_unmerged_state com commits_behind 0 (branch à frente do ref velho) → unknown, nunca fresh", () => {
    const f = assessCodeFreshness({ outcome: "preexisting_unmerged_state", commits_behind: 0, up_to_date: true });
    assert.equal(f.status, "unknown");
    assert.match(formatCodeFreshnessBanner(f, { outcome: "preexisting_unmerged_state" }) ?? "", /CÓDIGO NÃO VERIFICADO/);
  });

  it("medição falhou (-1) → unknown, nunca fresh", () => {
    assert.equal(assessCodeFreshness({ outcome: "synced", commits_behind: -1, up_to_date: false }).status, "unknown");
  });

  it("banner diz que a edição CONTINUA e pede repasse ao editor", () => {
    const b = formatCodeFreshnessBanner(assessCodeFreshness({ outcome: "ff_failed", commits_behind: 3, up_to_date: false }), { outcome: "ff_failed" }) ?? "";
    assert.match(b, /vai continuar \(fail-soft/);
    assert.match(b, /Repasse este aviso ao editor/);
  });
});

// ── git REAL ───────────────────────────────────────────────────────────────
function realPair() {
  const root = mkdtempSync(join(tmpdir(), "git-sync-9925-"));
  const env = { ...process.env, LC_ALL: "C", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", HOME: root };
  const run = (cwd: string) => (...args: string[]): SpawnResult => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const bare = join(root, "origin.git");
  run(root)("init", "-q", "--bare", "-b", "master", bare);
  const upDir = join(root, "up");
  run(root)("clone", "-q", bare, upDir);
  const up = run(upDir);
  up("config", "user.email", "t@t");
  up("config", "user.name", "t");
  writeFileSync(join(upDir, "sitemap.xml"), "<urlset/>\n");
  writeFileSync(join(upDir, "audience-profile.md"), "perfil v1\n");
  writeFileSync(join(upDir, "outro.ts"), "export const x = 1;\n");
  up("add", ".");
  up("commit", "-qm", "init");
  up("push", "-q", "origin", "master");
  const dir = join(root, "local");
  run(root)("clone", "-q", bare, dir);
  const git = run(dir);
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  const spawn: SpawnFn = (cmd, args) => (cmd === "git" ? git(...args) : { status: 1, stdout: "", stderr: "só git" });
  return { root, spawn, git, up, upDir, dir };
}

/** Cenário do incidente: upstream regenera os arquivos gerados e publica uma página nova. */
function setupIncident(p: ReturnType<typeof realPair>) {
  writeFileSync(join(p.upDir, "sitemap.xml"), "<urlset><url>nova</url></urlset>\n");
  writeFileSync(join(p.upDir, "audience-profile.md"), "perfil v2\n");
  mkdirSync(join(p.upDir, "p", "haiku"), { recursive: true });
  writeFileSync(join(p.upDir, "p", "haiku", "index.html"), "<p>upstream</p>\n");
  p.up("add", ".");
  p.up("commit", "-qm", "upstream regenera");
  p.up("push", "-q", "origin", "master");

  // Local: mesmos arquivos gerados regenerados à parte (colidem)...
  writeFileSync(join(p.dir, "sitemap.xml"), "<urlset><url>local</url></urlset>\n");
  writeFileSync(join(p.dir, "audience-profile.md"), "perfil local\n");
  mkdirSync(join(p.dir, "p", "haiku"), { recursive: true });
  writeFileSync(join(p.dir, "p", "haiku", "index.html"), "<p>local</p>\n");
  // ...mudança rastreada que NÃO colide...
  writeFileSync(join(p.dir, "outro.ts"), "export const x = 1; // wip local\n");
  // ...e untracked alheio num diretório que não dá pra limpar (Permission denied).
  mkdirSync(join(p.dir, "travado"), { recursive: true });
  writeFileSync(join(p.dir, "travado", "skill.md"), "de outra sessão\n");
  chmodSync(join(p.dir, "travado"), 0o555);
}

const canTestPermissionDenied = typeof process.getuid === "function" && process.getuid() !== 0 && process.platform !== "win32";

describe("#9925 syncCode — stash direcionado (git real)", () => {
  it("incidente 261009: sincroniza, stasha só as colisões, não toca untracked travado nem a mudança que não colide", { skip: !canTestPermissionDenied && "precisa de usuário não-root em POSIX pra reproduzir Permission denied" }, () => {
    const p = realPair();
    try {
      setupIncident(p);
      const r = syncCode(p.spawn, NOOP_LOCK, MAIN_CHECKOUT);

      assert.equal(r.outcome, "synced_stash_preserved", r.message);
      assert.equal(r.commits_behind, 0);
      assert.equal(assessCodeFreshness(r).status, "fresh");
      assert.deepEqual([...(r.targeted_stash_paths ?? [])].sort(), ["audience-profile.md", "p/haiku/index.html", "sitemap.xml"]);
      assert.ok(r.preserved_stash?.ref, "stash preservado, nunca despopado (#8719)");

      // Upstream aplicado nos arquivos que colidiam.
      assert.equal(readFileSync(join(p.dir, "sitemap.xml"), "utf8"), "<urlset><url>nova</url></urlset>\n");
      assert.equal(readFileSync(join(p.dir, "p", "haiku", "index.html"), "utf8"), "<p>upstream</p>\n");
      // Mudança local que não colide segue no working tree; untracked alheio intocado.
      assert.match(readFileSync(join(p.dir, "outro.ts"), "utf8"), /wip local/);
      assert.ok(existsSync(join(p.dir, "travado", "skill.md")));

      // O stash guarda as versões LOCAIS das colisões (nada se perde).
      const stashed = p.git("stash", "show", "--include-untracked", "--name-only", r.preserved_stash!.ref!).stdout.split("\n").filter(Boolean).sort();
      assert.deepEqual(stashed, ["audience-profile.md", "p/haiku/index.html", "sitemap.xml"]);
      assert.equal(p.git("show", `${r.preserved_stash!.ref}:sitemap.xml`).stdout, "<urlset><url>local</url></urlset>\n");
    } finally {
      try { chmodSync(join(p.dir, "travado"), 0o755); } catch { /* já removido */ }
      rmSync(p.root, { recursive: true, force: true });
    }
  });

  it("sem diretório travado: só colisão rastreada → stash direcionado, sincroniza", () => {
    const p = realPair();
    try {
      writeFileSync(join(p.upDir, "sitemap.xml"), "<urlset>up</urlset>\n");
      p.up("commit", "-qam", "up");
      p.up("push", "-q", "origin", "master");
      writeFileSync(join(p.dir, "sitemap.xml"), "<urlset>local</urlset>\n");
      writeFileSync(join(p.dir, "solto.txt"), "untracked que não colide\n");

      const r = syncCode(p.spawn, NOOP_LOCK, MAIN_CHECKOUT);
      assert.equal(r.outcome, "synced_stash_preserved", r.message);
      assert.deepEqual(r.targeted_stash_paths, ["sitemap.xml"]);
      assert.ok(existsSync(join(p.dir, "solto.txt")), "untracked fora da colisão nunca vai pro stash");
      assert.ok(r.warnings.some((w) => /stash direcionado/.test(w)));
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });

  it("divergência (sem lista de caminhos) → stash amplo de sempre, sem targeted_stash_paths", () => {
    const p = realPair();
    try {
      writeFileSync(join(p.upDir, "outro.ts"), "export const x = 3;\n");
      p.up("commit", "-qam", "up");
      p.up("push", "-q", "origin", "master");
      writeFileSync(join(p.dir, "novo.ts"), "x\n");
      p.git("add", "novo.ts");
      p.git("commit", "-qm", "local");
      writeFileSync(join(p.dir, "novo.ts"), "y\n");

      const r = syncCode(p.spawn, NOOP_LOCK, MAIN_CHECKOUT);
      assert.equal(r.outcome, "ff_failed");
      assert.equal(r.targeted_stash_paths, undefined);
      assert.equal(assessCodeFreshness(r).status, "stale");
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });
});
