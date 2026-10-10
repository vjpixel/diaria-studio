/**
 * #9960 — regressão do incidente 261009 (`/diaria-5-publicacao`): um arquivo
 * untracked `nul` na raiz (nome reservado do Windows, criado por `> nul` num
 * shell Unix) impedia o `git stash --include-untracked` de limpar o working
 * tree. O stash era CRIADO, o comando saía 1, e o sync terminava
 * `stash_partial_failure_unrecovered` sem nem tentar o ff — checkout 38
 * commits atrás, página do site recusada pelo guard #9821.
 *
 * Fix: (1) o stash amplo exclui nomes reservados por pathspec e avisa com a
 * ação exata; (2) depois de um stash parcial, o ff-only é re-tentado.
 *
 * O Linux não reproduz a não-removibilidade do `nul`; a falha parcial é
 * simulada envolvendo o git REAL (o stash roda de verdade, só o exit code é
 * trocado por 1 — exatamente o que o git faz no Windows nesse caso).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collapsedUntrackedDirs,
  describeReservedRemoval,
  mergeExpandedUntracked,
  findWindowsReservedUntracked,
  reservedExcludePathspecs,
  syncCode,
  type SpawnFn,
  type SpawnResult,
  type SyncLock,
} from "../scripts/lib/git-sync.ts";

const NOOP_LOCK: SyncLock = { path: "(noop)", acquire: () => true, release: () => {} };
const MAIN_CHECKOUT = "/home/editor/diaria-studio";

describe("#9960 nomes reservados do Windows — puro", () => {
  it("detecta nul/con/aux/com1/lpt9, com ou sem extensão, qualquer caixa, em subdiretório", () => {
    assert.deepEqual(
      findWindowsReservedUntracked(["nul", "NUL.txt", "sub/con", "aux.log", "com1", "LPT9.x", "docs/x.md", "nulo.txt", "com0", "dir/"]),
      ["nul", "NUL.txt", "sub/con", "aux.log", "com1", "LPT9.x"],
    );
  });

  it("caminho entre aspas (escapado pelo porcelain) nunca casa", () => {
    assert.deepEqual(findWindowsReservedUntracked(['"nul"']), []);
  });

  it("pathspec de exclusão literal e ação de remoção exata", () => {
    assert.deepEqual(reservedExcludePathspecs(["nul", "sub/con"]), [":(exclude,literal)nul", ":(exclude,literal)sub/con"]);
    const a = describeReservedRemoval(["nul"]);
    assert.match(a, /rm -f -- '\.\/nul'/);
    assert.match(a, /\/dev\/null/);
  });
});

// ── git REAL ───────────────────────────────────────────────────────────────
function realPair() {
  const root = mkdtempSync(join(tmpdir(), "git-sync-9960-"));
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
  up("add", ".");
  up("commit", "-qm", "init");
  up("push", "-q", "origin", "master");
  const dir = join(root, "local");
  run(root)("clone", "-q", bare, dir);
  const git = run(dir);
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  return { root, git, up, upDir, dir };
}

const isStashPush = (args: string[]) => args[0] === "stash" && args[1] === "push";

describe("#9960 syncCode — stash parcial re-tenta o ff (git real)", () => {
  it("incidente 261009: stash sai 1 mas cria stash → ff re-tentado sincroniza (antes: stash_partial_failure_unrecovered)", () => {
    const p = realPair();
    try {
      writeFileSync(join(p.upDir, "sitemap.xml"), "<urlset>up</urlset>\n");
      p.up("commit", "-qam", "upstream");
      p.up("push", "-q", "origin", "master");
      writeFileSync(join(p.dir, "sitemap.xml"), "<urlset>local</urlset>\n");
      writeFileSync(join(p.dir, "nul"), "");

      // O stash roda DE VERDADE (guarda a colisão); o exit vira 1, como no
      // Windows quando o git não consegue remover o `nul`.
      const spawn: SpawnFn = (cmd, args) => {
        if (cmd !== "git") return { status: 1, stdout: "", stderr: "só git" };
        const r = p.git(...args);
        if (isStashPush(args) && r.status === 0) {
          return { status: 1, stdout: r.stdout, stderr: "error: unable to unlink old 'nul': Invalid argument" };
        }
        return r;
      };
      const r = syncCode(spawn, NOOP_LOCK, MAIN_CHECKOUT);

      assert.equal(r.outcome, "synced_stash_preserved", r.message);
      assert.equal(r.commits_behind, 0);
      assert.equal(r.ff_retried_after_partial_stash, true);
      assert.ok(r.preserved_stash?.ref, "stash preservado, nunca despopado (#8719)");
      assert.equal(readFileSync(join(p.dir, "sitemap.xml"), "utf8"), "<urlset>up</urlset>\n");
      assert.equal(p.git("show", `${r.preserved_stash!.ref}:sitemap.xml`).stdout, "<urlset>local</urlset>\n");
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });

  it("stash parcial e o ff re-tentado ainda recusa → segue stash_partial_failure_unrecovered, com o motivo", () => {
    const p = realPair();
    try {
      writeFileSync(join(p.upDir, "sitemap.xml"), "<urlset>up</urlset>\n");
      p.up("commit", "-qam", "upstream");
      p.up("push", "-q", "origin", "master");
      writeFileSync(join(p.dir, "sitemap.xml"), "<urlset>local</urlset>\n");

      let ffCalls = 0;
      const spawn: SpawnFn = (cmd, args) => {
        if (cmd !== "git") return { status: 1, stdout: "", stderr: "só git" };
        if (args[0] === "merge" && args[1] === "--ff-only" && ++ffCalls === 2) {
          return { status: 1, stdout: "", stderr: "fatal: Not possible to fast-forward, aborting.\n" };
        }
        const r = p.git(...args);
        if (isStashPush(args) && r.status === 0) return { status: 1, stdout: r.stdout, stderr: "error: unlink" };
        return r;
      };
      const r = syncCode(spawn, NOOP_LOCK, MAIN_CHECKOUT);
      assert.equal(r.outcome, "stash_partial_failure_unrecovered", r.message);
      assert.equal(r.ff_retried_after_partial_stash, true);
      assert.ok(r.warnings.some((w) => /re-tentado após o stash parcial.*divergência/.test(w)));
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });
});

describe("#9960 syncCode — stash amplo exclui `nul` (git real)", () => {
  it("recusa sem lista de caminhos + untracked que colide + `nul` → stash -u com exclusão, `nul` fica, sync passa", () => {
    const p = realPair();
    try {
      mkdirSync(join(p.upDir, "novo"), { recursive: true });
      writeFileSync(join(p.upDir, "novo", "x.ts"), "export const up = 1;\n");
      p.up("add", ".");
      p.up("commit", "-qm", "upstream novo/");
      p.up("push", "-q", "origin", "master");
      mkdirSync(join(p.dir, "novo"), { recursive: true });
      writeFileSync(join(p.dir, "novo", "x.ts"), "local\n");
      writeFileSync(join(p.dir, "nul"), "");

      // Força a 1ª recusa do ff a vir num formato não reconhecido (sem lista
      // de caminhos) → cai no stash AMPLO, o caminho do incidente.
      const stashCalls: string[][] = [];
      let ffCalls = 0;
      const spawn: SpawnFn = (cmd, args) => {
        if (cmd !== "git") return { status: 1, stdout: "", stderr: "só git" };
        if (args[0] === "merge" && args[1] === "--ff-only" && ++ffCalls === 1) {
          return { status: 1, stdout: "", stderr: "fatal: formato que o classificador não conhece\n" };
        }
        if (isStashPush(args)) {
          stashCalls.push(args);
          // No Windows o git não remove `nul`: se ele não foi excluído, falha.
          if (!args.includes(":(exclude,literal)nul")) {
            const r = p.git(...args);
            return { ...r, status: 1, stderr: "error: unable to unlink old 'nul'" };
          }
        }
        return p.git(...args);
      };
      const r = syncCode(spawn, NOOP_LOCK, MAIN_CHECKOUT);

      assert.equal(stashCalls.length, 1);
      assert.ok(stashCalls[0].includes("--include-untracked"));
      assert.deepEqual(stashCalls[0].slice(stashCalls[0].indexOf("--")), ["--", ":(exclude,literal)nul"]);
      assert.equal(r.outcome, "synced_stash_preserved", r.message);
      assert.equal(r.commits_behind, 0);
      assert.deepEqual(r.reserved_untracked_excluded, ["nul"]);
      assert.equal(r.ff_retried_after_partial_stash, undefined, "stash saiu 0 — sem re-tentativa");
      assert.ok(existsSync(join(p.dir, "nul")), "`nul` fica no lugar, fora do stash");
      assert.equal(readFileSync(join(p.dir, "novo", "x.ts"), "utf8"), "export const up = 1;\n");
      const stashed = p.git("stash", "show", "--include-untracked", "--name-only", r.preserved_stash!.ref!).stdout;
      assert.match(stashed, /novo\/x\.ts/);
      assert.doesNotMatch(stashed, /^nul$/m);
      assert.ok(r.warnings.some((w) => /nome reservado do Windows.*rm -f -- '\.\/nul'/.test(w)));
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });
});

// ── #9988: nome reservado DENTRO de diretório untracked colapsado ─────────────
describe("#9988 diretório untracked colapsado — puro", () => {
  it("collapsedUntrackedDirs pega só `dir/` (sem aspas), sem a barra", () => {
    assert.deepEqual(collapsedUntrackedDirs(["nul", "novo/", "a/b/", '"x y/"', "f.txt"]), ["novo", "a/b"]);
  });

  it("mergeExpandedUntracked troca `dir/` pelo conteúdo do ls-files -z e então o `dir/nul` aparece", () => {
    const merged = mergeExpandedUntracked(["nul", "novo/"], "novo/x.ts\0novo/nul\0");
    assert.deepEqual(merged, ["nul", "novo/x.ts", "novo/nul"]);
    assert.deepEqual(findWindowsReservedUntracked(merged), ["nul", "novo/nul"]);
    // Sem a expansão, o porcelain colapsado escondia o `novo/nul` (o bug).
    assert.deepEqual(findWindowsReservedUntracked(["nul", "novo/"]), ["nul"]);
  });
});

describe("#9988 syncCode — stash amplo exclui `dir/nul` de diretório untracked (git real)", () => {
  it("untracked `novo/` colapsado contendo `nul` → ls-files expande, `novo/nul` excluído, sync passa", () => {
    const p = realPair();
    try {
      mkdirSync(join(p.upDir, "novo"), { recursive: true });
      writeFileSync(join(p.upDir, "novo", "x.ts"), "export const up = 1;\n");
      p.up("add", ".");
      p.up("commit", "-qm", "upstream novo/");
      p.up("push", "-q", "origin", "master");
      mkdirSync(join(p.dir, "novo"), { recursive: true });
      writeFileSync(join(p.dir, "novo", "x.ts"), "local\n");
      writeFileSync(join(p.dir, "novo", "nul"), "");
      assert.match(p.git("status", "--porcelain").stdout, /^\?\? novo\/$/m, "pré-condição: porcelain colapsa o diretório");

      const stashCalls: string[][] = [];
      let ffCalls = 0;
      const spawn: SpawnFn = (cmd, args) => {
        if (cmd !== "git") return { status: 1, stdout: "", stderr: "só git" };
        if (args[0] === "merge" && args[1] === "--ff-only" && ++ffCalls === 1) {
          return { status: 1, stdout: "", stderr: "fatal: formato que o classificador não conhece\n" };
        }
        if (isStashPush(args)) {
          stashCalls.push(args);
          // No Windows o git não remove `novo/nul`: se ele não foi excluído, falha.
          if (!args.includes(":(exclude,literal)novo/nul")) {
            const r = p.git(...args);
            return { ...r, status: 1, stderr: "error: unable to unlink old 'novo/nul'" };
          }
        }
        return p.git(...args);
      };
      const r = syncCode(spawn, NOOP_LOCK, MAIN_CHECKOUT);

      assert.equal(stashCalls.length, 1);
      assert.deepEqual(stashCalls[0].slice(stashCalls[0].indexOf("--")), ["--", ":(exclude,literal)novo/nul"]);
      assert.equal(r.outcome, "synced_stash_preserved", r.message);
      assert.equal(r.commits_behind, 0);
      assert.deepEqual(r.reserved_untracked_excluded, ["novo/nul"]);
      assert.ok(existsSync(join(p.dir, "novo", "nul")), "`novo/nul` fica no lugar, fora do stash");
      assert.equal(readFileSync(join(p.dir, "novo", "x.ts"), "utf8"), "export const up = 1;\n");
      const stashed = p.git("stash", "show", "--include-untracked", "--name-only", r.preserved_stash!.ref!).stdout;
      assert.match(stashed, /novo\/x\.ts/);
      assert.doesNotMatch(stashed, /novo\/nul/);
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  });
});
