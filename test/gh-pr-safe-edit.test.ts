/**
 * test/gh-pr-safe-edit.test.ts (#6292)
 *
 * `gh pr edit --body`/`--add-label` falha em silêncio (exit 0, sem mudar
 * nada) — ver docstring de `scripts/lib/gh-pr-safe-edit.ts`. Este módulo
 * substitui esses call sites por REST (`gh api -X PATCH`/`POST`) + releitura
 * pós-escrita. Nenhum teste aqui chama `gh`/rede real — `GhRunFn` é sempre
 * um stub em memória, mesmo padrão de `test/wait-until-sync.test.ts`/
 * `test/alarm-issues.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addPrLabelsRest, setPrBodyRest, type GhRunFn } from "../scripts/lib/gh-pr-safe-edit.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

function ok(stdout = ""): GhSpawnResult {
  return { status: 0, stdout, stderr: "" };
}
function fail(stderr = "erro"): GhSpawnResult {
  return { status: 1, stdout: "", stderr };
}

describe("setPrBodyRest (#6292)", () => {
  it("usa gh api PATCH (nunca `pr edit`) e confirma via releitura", () => {
    const calls: string[][] = [];
    let storedBody = "corpo antigo";
    const run: GhRunFn = (args) => {
      calls.push(args);
      if (args[0] === "api" && args[1] === "-X" && args[2] === "PATCH") {
        const bodyArg = args.find((a) => a.startsWith("body="))!;
        storedBody = bodyArg.slice("body=".length);
        return ok();
      }
      if (args[0] === "pr" && args[1] === "view") {
        return ok(`${storedBody}\n`);
      }
      throw new Error(`comando inesperado: ${args.join(" ")}`);
    };

    const result = setPrBodyRest(42, "Closes #100\n\nnovo corpo", "/repo", run);
    assert.equal(result.ok, true);
    assert.equal(storedBody, "Closes #100\n\nnovo corpo");
    assert.ok(
      calls.every((c) => !(c[0] === "pr" && c[1] === "edit")),
      "nunca deve chamar `gh pr edit`",
    );
  });

  it("reproduz o bug #6292: PATCH sai 0 mas o corpo não mudou — falha alto, nunca reporta sucesso", () => {
    // Simula exatamente o modo de falha medido ao vivo: a escrita "funciona"
    // (exit 0) mas o servidor não aplicou a mudança — a única defesa é a
    // releitura pós-escrita.
    const run: GhRunFn = (args) => {
      if (args[0] === "api") return ok(); // PATCH reporta sucesso...
      if (args[0] === "pr" && args[1] === "view") return ok("corpo antigo inalterado\n"); // ...mas nada mudou
      throw new Error(`comando inesperado: ${args.join(" ")}`);
    };

    const result = setPrBodyRest(6290, "Closes #6186 (corrigido pra REFS)", "/repo", run);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /NÃO bate com o esperado/);
  });

  it("gh api PATCH com exit != 0 — falha alto com o stderr original", () => {
    const run: GhRunFn = () => fail("HTTP 422: validation failed");
    const result = setPrBodyRest(1, "x", "/repo", run);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /HTTP 422/);
  });

  it("releitura pós-escrita falhando (gh pr view quebrado) também é reportado como erro, não sucesso", () => {
    const run: GhRunFn = (args) => (args[0] === "api" ? ok() : fail("rate limited"));
    const result = setPrBodyRest(1, "x", "/repo", run);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /releitura pós-escrita falhou/);
  });
});

describe("addPrLabelsRest (#6292)", () => {
  it("usa gh api POST (nunca `pr edit --add-label`) e confirma via releitura", () => {
    const calls: string[][] = [];
    let labels: string[] = [];
    const run: GhRunFn = (args) => {
      calls.push(args);
      if (args[0] === "api" && args[1] === "-X" && args[2] === "POST") {
        labels = args.filter((a) => a.startsWith("labels[]=")).map((a) => a.slice("labels[]=".length));
        return ok();
      }
      if (args[0] === "pr" && args[1] === "view") {
        return ok(labels.map((l) => `${l}\n`).join(""));
      }
      throw new Error(`comando inesperado: ${args.join(" ")}`);
    };

    const result = addPrLabelsRest(6257, ["no-regression-test"], "/repo", run);
    assert.equal(result.ok, true);
    assert.deepEqual(labels, ["no-regression-test"]);
    assert.ok(
      calls.every((c) => !(c[0] === "pr" && c[1] === "edit")),
      "nunca deve chamar `gh pr edit`",
    );
  });

  it("reproduz o bug #6292 pra labels: POST sai 0 mas a label não aplicou — falha alto", () => {
    // Cenário medido ao vivo: `gh pr edit 6257 --add-label no-regression-test`
    // saiu 0 e `gh pr view 6257 --json labels` voltou `[]`.
    const run: GhRunFn = (args) => (args[0] === "api" ? ok() : ok(""));
    const result = addPrLabelsRest(6257, ["no-regression-test"], "/repo", run);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /não apareceram na releitura/);
  });

  it("lista vazia é no-op — nunca chama gh", () => {
    let called = false;
    const run: GhRunFn = () => {
      called = true;
      return ok();
    };
    const result = addPrLabelsRest(1, [], "/repo", run);
    assert.equal(result.ok, true);
    assert.equal(called, false);
  });

  it("labels parcialmente aplicadas (1 de 2) — falha alto nomeando a que faltou", () => {
    const run: GhRunFn = (args) => (args[0] === "api" ? ok() : ok("a\n"));
    const result = addPrLabelsRest(1, ["a", "b"], "/repo", run);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /\bb\b/);
  });
});
