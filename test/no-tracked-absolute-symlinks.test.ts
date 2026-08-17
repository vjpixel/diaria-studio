/**
 * test/no-tracked-absolute-symlinks.test.ts (#5572, regressão #633)
 *
 * O repo passou a rastrear um symlink `node_modules ->
 * /home/vjpixel/diaria-studio/node_modules` (mergeado sem ninguém notar na
 * PR #5569). Como aconteceu: uma sessão criou um worktree em /tmp, ligou
 * `node_modules` de volta ao checkout principal pra rodar a suíte, e um
 * `git add -A` varreu tudo. O `.gitignore` tinha `node_modules/` **com
 * barra**, que casa apenas DIRETÓRIOS — um symlink é um arquivo, então
 * escapou do ignore e entrou no commit. Nenhum check pegou: `tsc`, `knip`,
 * a suíte inteira e os 5 agentes de review passaram, porque nada disso
 * olha para o que está no ÍNDICE do git.
 *
 * Por que importa: o alvo é um caminho ABSOLUTO da máquina de quem commitou.
 * Em qualquer clone fresco (CI, sessão cloud, outra máquina) o git
 * materializa um symlink pendurado, e `npm install`/`npm ci` passam a
 * operar sobre ele — na máquina de origem o npm já substituiu o symlink por
 * um diretório real, deixando o checkout permanentemente sujo (`D
 * node_modules` em todo `git status`, convidando o próximo `git add -A` a
 * commitar a remoção).
 *
 * Este teste trava a CLASSE inteira, não só o caso `node_modules`: nenhum
 * arquivo rastreado pode ser um symlink para caminho absoluto. Symlink
 * relativo (dentro do repo) continua permitido — é uma construção legítima
 * e portável.
 *
 * @see .gitignore (`node_modules` sem barra, pra casar arquivo E diretório)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

/** Modo git de symlink (`man git-ls-files`: 120000). */
const GIT_SYMLINK_MODE = "120000";

interface TrackedEntry {
  mode: string;
  oid: string;
  path: string;
}

function listTrackedEntries(): TrackedEntry[] {
  const out = execFileSync("git", ["ls-files", "-s"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });

  return out
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((line) => {
      // formato: "<mode> <oid> <stage>\t<path>"
      const [meta, path] = line.split("\t");
      const [mode, oid] = meta.split(" ");
      return { mode, oid, path };
    });
}

/** Conteúdo de um blob de symlink É o caminho-alvo. */
function symlinkTarget(oid: string): string {
  return execFileSync("git", ["cat-file", "-p", oid], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  }).trim();
}

describe("higiene do índice do git", () => {
  it("nenhum symlink rastreado aponta para caminho absoluto", () => {
    const offenders = listTrackedEntries()
      .filter((e) => e.mode === GIT_SYMLINK_MODE)
      .map((e) => ({ path: e.path, target: symlinkTarget(e.oid) }))
      .filter((e) => e.target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(e.target));

    assert.deepEqual(
      offenders.map((o) => `${o.path} -> ${o.target}`),
      [],
      "symlink rastreado com alvo absoluto: quebra em qualquer clone fora da máquina " +
        "que commitou. Se foi um symlink de conveniência de worktree, remova do índice " +
        "(`git rm --cached <path>`) e garanta que o .gitignore o cobre.",
    );
  });

  it("node_modules não está rastreado, em nenhuma forma", () => {
    const tracked = listTrackedEntries().filter(
      (e) => e.path === "node_modules" || e.path.startsWith("node_modules/"),
    );

    assert.deepEqual(
      tracked.map((e) => `${e.mode} ${e.path}`),
      [],
      "node_modules entrou no índice. Provável causa: `git add -A` num worktree com " +
        "symlink de conveniência — o padrão `node_modules/` do .gitignore só casa " +
        "diretório, não symlink.",
    );
  });

  it(".gitignore ignora `node_modules` mesmo quando ele NÃO é um diretório", () => {
    // `git check-ignore` é a autoridade sobre o próprio matching do git —
    // afirmar isso lendo o .gitignore com regex reimplementaria a semântica
    // de pattern do git, que é exatamente a sutileza que causou o bug.
    //
    // Só o path `node_modules` é consultado, nunca algo DENTRO dele: quando
    // node_modules é um symlink (o caso que originou este teste, e o estado
    // normal de um worktree que reaproveita as deps do checkout principal),
    // o git recusa pathspec "beyond a symbolic link" com exit 128 — o teste
    // falharia por artefato do ambiente, não por regressão.
    let ignored: boolean;
    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", "node_modules"], {
        cwd: REPO_ROOT,
      });
      ignored = true;
    } catch {
      ignored = false;
    }

    assert.ok(
      ignored,
      "`node_modules` precisa ser ignorado seja qual for sua forma no disco " +
        "(diretório, symlink ou arquivo).",
    );
  });

  it("o padrão do .gitignore não tem barra final (que casaria só diretório)", () => {
    const patterns = readFileSync(resolve(REPO_ROOT, ".gitignore"), "utf-8")
      .split("\n")
      .map((l) => l.trim());

    assert.ok(
      patterns.includes("node_modules"),
      "esperava o padrão exato `node_modules` no .gitignore",
    );
    assert.ok(
      !patterns.includes("node_modules/"),
      "`node_modules/` (com barra) casa apenas DIRETÓRIOS — foi assim que um symlink " +
        "de mesmo nome escapou do ignore e foi commitado na #5569.",
    );
  });
});
