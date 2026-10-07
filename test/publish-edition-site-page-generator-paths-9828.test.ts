/**
 * test/publish-edition-site-page-generator-paths-9828.test.ts (#9828)
 *
 * Achado do review do PR #9826 (#9821): `checkCodeFreshness` recusava a
 * página do site com QUALQUER commit atrás de origin/master. O `sync-code.ts`
 * roda no início do Stage 5 e o §6b-site publica 10-50 min depois — um merge
 * nesse intervalo (261001, 261005, 261006, nenhum tocando o gerador) bastava
 * pra página sair com exit 3 e ficar fora do acervo.
 *
 * Garante, com git REAL (bare origin + 2 clones, mesmo padrão do teste do #9821):
 *   - merge entre o sync e a publicação que NÃO toca o gerador → segue;
 *   - merge que toca o gerador (direto, transitivo, ou caminho extra como
 *     `workers/site/`) → recusa com code 3 nomeando o arquivo;
 *   - não deu pra derivar os caminhos → fail-closed;
 *   - o fecho de imports derivado do repo real cobre os geradores conhecidos.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkCodeFreshness,
  codeFreshnessPreflight,
  siteGeneratorDependencyPaths,
  staleCodeRefusalReason,
  SITE_GENERATOR_ENTRY,
  type GitRunner,
} from "../scripts/publish-edition-site-page.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

function write(cwd: string, file: string, content: string): void {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), content);
}

function commit(cwd: string, files: Record<string, string>, msg = "c"): void {
  for (const [f, c] of Object.entries(files)) {
    write(cwd, f, c);
    git(["add", f], cwd);
  }
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg], cwd);
}

/**
 * Repo mínimo com um "gerador": a entrada importa `./lib/gen.ts`, que importa
 * `./shared/deep.ts` (transitivo). `docs/` e `scripts/other.ts` ficam de fora.
 * `local` = checkout que publica (sincronizado), `other` = quem mergeia depois.
 */
function setup(): { local: string; other: string } {
  const origin = tmp("diaria-9828-origin-");
  git(["init", "-q", "--bare", "-b", "master", origin], origin);
  const other = tmp("diaria-9828-other-");
  git(["clone", "-q", origin, other], other);
  git(["checkout", "-q", "-b", "master"], other);
  commit(other, {
    [SITE_GENERATOR_ENTRY]: 'import { gen } from "./lib/gen.ts";\nexport const x = gen;\n',
    "scripts/lib/gen.ts": 'import { deep } from "./shared/deep.ts";\nexport const gen = deep;\n',
    "scripts/lib/shared/deep.ts": "export const deep = 1;\n",
    "scripts/other.ts": "export const other = 1;\n",
    "workers/site/public/sitemap.xml": "<urlset/>\n",
    "docs/x.md": "doc\n",
    "package.json": "{}\n",
  });
  git(["push", "-q", "origin", "master"], other);
  const local = tmp("diaria-9828-local-");
  git(["clone", "-q", "-b", "master", origin, local], local);
  return { local, other };
}

function mergeInOrigin(other: string, files: Record<string, string>): void {
  commit(other, files, "merge entre sync e publicação");
  git(["push", "-q", "origin", "master"], other);
}

describe("checkCodeFreshness — merge entre o sync e a publicação (#9828, git real)", () => {
  it("merge que NÃO toca o gerador → segue (antes: code 3)", () => {
    const { local, other } = setup();
    mergeInOrigin(other, { "docs/x.md": "doc 2\n", "scripts/other.ts": "export const other = 2;\n" });
    const f = checkCodeFreshness(local);
    assert.equal(f.behindBy, 1);
    assert.equal(f.stale, false);
    assert.deepEqual(f.generatorFilesChanged, []);
    assert.equal(staleCodeRefusalReason(f), null);
    assert.equal(codeFreshnessPreflight(["--edition-dir", "x"], local), null);
  });

  it("merge que toca dependência TRANSITIVA do gerador → recusa nomeando o arquivo", () => {
    const { local, other } = setup();
    mergeInOrigin(other, { "scripts/lib/shared/deep.ts": "export const deep = 2;\n" });
    const f = checkCodeFreshness(local);
    assert.equal(f.stale, true);
    assert.deepEqual(f.generatorFilesChanged, ["scripts/lib/shared/deep.ts"]);
    const r = codeFreshnessPreflight(["--edition-dir", "x"], local);
    assert.equal(r?.code, 3);
    assert.match(r!.reason, /1 commit\(s\) atrás/);
    assert.match(r!.reason, /scripts\/lib\/shared\/deep\.ts/);
  });

  it("merge que toca a entrada (ex: import novo) → recusa", () => {
    const { local, other } = setup();
    mergeInOrigin(other, {
      "scripts/lib/novo.ts": "export const n = 1;\n",
      [SITE_GENERATOR_ENTRY]: 'import { gen } from "./lib/gen.ts";\nimport { n } from "./lib/novo.ts";\nexport const x = gen + n;\n',
    });
    const f = checkCodeFreshness(local);
    assert.equal(f.stale, true);
    assert.deepEqual(f.generatorFilesChanged, [SITE_GENERATOR_ENTRY]);
  });

  it("merge que toca caminho extra (workers/site/, package.json) → recusa", () => {
    const { local, other } = setup();
    mergeInOrigin(other, { "workers/site/public/sitemap.xml": "<urlset>2</urlset>\n" });
    assert.equal(checkCodeFreshness(local).stale, true);
    const b = setup();
    mergeInOrigin(b.other, { "package.json": '{"x":1}\n' });
    assert.deepEqual(checkCodeFreshness(b.local).generatorFilesChanged, ["package.json"]);
  });

  it("commits locais à frente mexendo no gerador + origin com merge irrelevante → segue (diff de 3 pontos)", () => {
    const { local, other } = setup();
    commit(local, { "scripts/lib/gen.ts": 'import { deep } from "./shared/deep.ts";\nexport const gen = deep + 1;\n' });
    mergeInOrigin(other, { "docs/x.md": "doc 3\n" });
    const f = checkCodeFreshness(local);
    assert.equal(f.behindBy, 1);
    assert.equal(f.stale, false);
  });

  it("entrada do gerador ausente → fail-closed (code 3, 'não foi possível medir')", () => {
    const { local, other } = setup();
    mergeInOrigin(other, { "docs/x.md": "doc 4\n" });
    rmSync(join(local, SITE_GENERATOR_ENTRY));
    const r = codeFreshnessPreflight(["--edition-dir", "x"], local);
    assert.equal(r?.code, 3);
    assert.match(r!.reason, /não foi possível medir/);
    assert.match(r!.reason, /entrada do gerador ausente/);
  });

  it("git diff falha → fail-closed", () => {
    const failingDiff: GitRunner = (args) => {
      if (args[0] === "rev-list") return "3\n";
      if (args[0] === "diff") throw new Error("bad revision");
      return "";
    };
    const f = checkCodeFreshness("/r", failingDiff, ["scripts/x.ts"]);
    assert.equal(f.stale, true);
    assert.equal(f.behindBy, 3);
    assert.match(staleCodeRefusalReason(f)!, /não foi possível medir.*bad revision/);
  });

  it("checkout em dia não roda diff nem deriva caminhos", () => {
    const calls: string[] = [];
    const upToDate: GitRunner = (args) => {
      calls.push(args[0]);
      return args[0] === "rev-list" ? "0\n" : "";
    };
    const f = checkCodeFreshness("/nao-existe", upToDate);
    assert.equal(f.stale, false);
    assert.ok(!calls.includes("diff"));
  });
});

describe("siteGeneratorDependencyPaths — repo real (#9828)", () => {
  const paths = siteGeneratorDependencyPaths(REPO_ROOT);

  it("inclui a entrada, geradores diretos/transitivos e os caminhos extras", () => {
    for (const p of [
      SITE_GENERATOR_ENTRY,
      "scripts/lib/edition-site-page.ts",
      "scripts/lib/site-home-page.ts",
      "scripts/lib/site-archive-pages.ts",
      "scripts/gen-archive-index.ts",
      "scripts/lib/shared/design-tokens.ts",
      "workers/arquivo/src/hubs/meta.ts",
      "workers/site/",
      "package.json",
      "package-lock.json",
      "platform.config.json",
    ]) {
      assert.ok(paths.includes(p), `faltou ${p}`);
    }
  });

  it("não inclui scripts fora do grafo (os merges dos incidentes não recusam)", () => {
    for (const p of ["scripts/sync-code.ts", "scripts/publish-instagram.ts", ".claude/hooks/block-unsafe-shared-checkout-ops.mjs"]) {
      assert.ok(!paths.includes(p), `não devia incluir ${p}`);
    }
  });

  it("caminhos relativos com barra normal, sem duplicata", () => {
    assert.equal(new Set(paths).size, paths.length);
    for (const p of paths) {
      assert.ok(!p.startsWith("/") && !p.includes("\\") && !p.startsWith(".."), p);
    }
  });
});
