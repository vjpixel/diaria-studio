/**
 * test/issue-file-collisions.test.ts (#7137, item 3)
 *
 * Cobre `scripts/lib/issue-file-collisions.ts` com fixtures de issues
 * mockadas (nunca chama `gh` de verdade) — os 3 casos pedidos no escopo:
 * nenhuma colisão, colisão real, falso positivo evitado (path genérico
 * demais sozinho).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractFilePathsFromIssueBody,
  computeIssueFileCollisions,
  GENERIC_PATH_DENYLIST,
  type IssueWithPaths,
} from "../scripts/lib/issue-file-collisions.ts";

describe("extractFilePathsFromIssueBody", () => {
  it("extrai path entre crase simples com extensão reconhecida", () => {
    const body = "Mexer em `scripts/foo.ts` pra consertar o bug.";
    assert.deepEqual(extractFilePathsFromIssueBody(body), ["scripts/foo.ts"]);
  });

  it("extrai múltiplos paths distintos, dedup e ordenado", () => {
    const body = "Tocar `scripts/b.ts` e `scripts/a.ts`, e de novo `scripts/b.ts`.";
    assert.deepEqual(extractFilePathsFromIssueBody(body), ["scripts/a.ts", "scripts/b.ts"]);
  });

  it("extrai path de skill (.claude/skills/.../SKILL.md)", () => {
    const body = "Atualizar `.claude/skills/diaria-develop/SKILL.md` com a nova regra.";
    assert.deepEqual(extractFilePathsFromIssueBody(body), [".claude/skills/diaria-develop/SKILL.md"]);
  });

  it("extrai path de teste (test/*.test.ts)", () => {
    const body = "PR de bugfix exige `test/foo.test.ts` novo (#633).";
    assert.deepEqual(extractFilePathsFromIssueBody(body), ["test/foo.test.ts"]);
  });

  it("extrai paths de dentro de um bloco de código cercado (crase tripla vira crase simples linha a linha)", () => {
    const body = "Escopo:\n```\nscripts/lib/foo.ts\n```\nna verdade cita assim: `scripts/lib/foo.ts`";
    assert.deepEqual(extractFilePathsFromIssueBody(body), ["scripts/lib/foo.ts"]);
  });

  it("NÃO extrai texto entre crases sem barra (não é path)", () => {
    const body = "A flag `--dry-run` e a versão `v1.2` não são paths.";
    assert.deepEqual(extractFilePathsFromIssueBody(body), []);
  });

  it("NÃO extrai algo com barra mas sem extensão reconhecida (evita falso positivo tipo modelo)", () => {
    const body = "O modelo `claude-4/opus` não é um path de arquivo.";
    assert.deepEqual(extractFilePathsFromIssueBody(body), []);
  });

  it("corpo vazio/null/undefined retorna []", () => {
    assert.deepEqual(extractFilePathsFromIssueBody(""), []);
    assert.deepEqual(extractFilePathsFromIssueBody(null), []);
    assert.deepEqual(extractFilePathsFromIssueBody(undefined), []);
  });

});

describe("computeIssueFileCollisions", () => {
  function issue(number: number, paths: string[], title = `issue ${number}`): IssueWithPaths {
    return { number, title, paths };
  }

  it("caso 1 — nenhuma colisão: issues com paths totalmente disjuntos", () => {
    const issues = [issue(1, ["scripts/a.ts"]), issue(2, ["scripts/b.ts"])];
    assert.deepEqual(computeIssueFileCollisions(issues), []);
  });

  it("caso 2 — colisão real: mesmo path específico em 2 issues", () => {
    const issues = [
      issue(10, ["scripts/lib/foo.ts", "test/foo.test.ts"]),
      issue(20, ["scripts/lib/foo.ts"]),
    ];
    const collisions = computeIssueFileCollisions(issues);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].a.number, 10);
    assert.equal(collisions[0].b.number, 20);
    assert.deepEqual(collisions[0].paths, ["scripts/lib/foo.ts"]);
  });

  it("colisão por prefixo de diretório (não precisa ser o MESMO arquivo)", () => {
    const issues = [issue(1, ["scripts/lib/foo.ts"]), issue(2, ["scripts/lib"])];
    const collisions = computeIssueFileCollisions(issues);
    assert.equal(collisions.length, 1);
  });

  it("caso 3 — falso positivo evitado: só path genérico (package.json) em comum NÃO dispara", () => {
    const issues = [issue(1, ["package.json"]), issue(2, ["package.json"])];
    assert.deepEqual(computeIssueFileCollisions(issues), []);
  });

  it("path genérico dispara achado quando coexiste com pelo menos 1 path específico", () => {
    const issues = [
      issue(1, ["package.json", "scripts/lib/foo.ts"]),
      issue(2, ["package.json", "scripts/lib/foo.ts"]),
    ];
    const collisions = computeIssueFileCollisions(issues);
    assert.equal(collisions.length, 1);
    // path genérico entra no relatório como contexto, mas não sozinho.
    assert.deepEqual(collisions[0].paths, ["package.json", "scripts/lib/foo.ts"]);
  });

  it("CLAUDE.md sozinho (denylist) também não dispara sozinho", () => {
    const issues = [issue(1, ["CLAUDE.md"]), issue(2, ["CLAUDE.md"])];
    assert.deepEqual(computeIssueFileCollisions(issues), []);
    assert.ok(GENERIC_PATH_DENYLIST.has("CLAUDE.md"));
  });

  it("3 issues -- pares corretos, sem duplicar nem colidir consigo mesma", () => {
    const issues = [
      issue(1, ["scripts/x.ts"]),
      issue(2, ["scripts/x.ts"]),
      issue(3, ["scripts/y.ts"]),
    ];
    const collisions = computeIssueFileCollisions(issues);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].a.number, 1);
    assert.equal(collisions[0].b.number, 2);
  });

  it("nunca reporta uma issue colidindo consigo mesma (mesmo número por engano na lista)", () => {
    const issues = [issue(1, ["scripts/x.ts"]), issue(1, ["scripts/x.ts"])];
    assert.deepEqual(computeIssueFileCollisions(issues), []);
  });

  it("lista vazia ou issue única -> []", () => {
    assert.deepEqual(computeIssueFileCollisions([]), []);
    assert.deepEqual(computeIssueFileCollisions([issue(1, ["scripts/x.ts"])]), []);
  });
});
