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
import {
  addPrLabelsRest,
  checkBodyCitesIssues,
  issuesFromBranch,
  issuesMissingFromBody,
  parseIssuesFlag,
  resolveExpectedIssues,
  setPrBodyRest,
  type GhRunFn,
} from "../scripts/lib/gh-pr-safe-edit.ts";
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

// ─── #10698: corpo de PR cruzado entre implementadores ────────────────────

describe("issuesFromBranch (#10698)", () => {
  it("extrai o número das convenções das trilhas autônomas", () => {
    assert.deepEqual(issuesFromBranch("overnight/fix-10643-kit-eventos"), [10643]);
    assert.deepEqual(issuesFromBranch("develop/fix-5700"), [5700]);
    assert.deepEqual(issuesFromBranch("develop/blast-4242"), [4242]);
    assert.deepEqual(issuesFromBranch("continuo/fix-8123-slug"), [8123]);
    assert.deepEqual(issuesFromBranch("feat-77"), [77]);
  });

  it("branch de lote não carrega número", () => {
    assert.deepEqual(issuesFromBranch("overnight/batch-overnight-dispatch"), []);
    assert.deepEqual(issuesFromBranch("master"), []);
  });

  it("não casa prefixo que só termina em fix (`hotfix-N`)", () => {
    assert.deepEqual(issuesFromBranch("overnight/hotfix-123"), []);
  });
});

describe("issuesMissingFromBody (#10698)", () => {
  it("aceita Closes/fixes/Resolves e REFS", () => {
    const body = "Closes #10\nfixes #11\nResolves #12\nREFS #13, NÃO CLOSES (parcial)";
    assert.deepEqual(issuesMissingFromBody(body, [10, 11, 12, 13]), []);
  });

  it("menção solta não conta como marcador", () => {
    assert.deepEqual(issuesMissingFromBody("ver #10 e #11", [10, 11]), [10, 11]);
  });

  it("boundary de dígito: `#7788` não satisfaz `#77`", () => {
    assert.deepEqual(issuesMissingFromBody("Closes #7788", [77]), [77]);
  });
});

describe("checkBodyCitesIssues — cenário real do #10698", () => {
  it("corpo da PR vizinha (sobrescrito no arquivo de nome comum) é recusado", () => {
    // A PR da issue 10640 recebeu, pelo arquivo temporário compartilhado, o
    // corpo escrito por outro implementador para a issue 10641.
    const crossed = "Closes #10641\n\nCorpo de outra PR";
    const r = checkBodyCitesIssues(crossed, issuesFromBranch("overnight/fix-10640-algo"));
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /#10640/);
  });

  it("corpo certo passa", () => {
    assert.equal(checkBodyCitesIssues("Closes #10640", [10640]).ok, true);
  });

  it("lista vazia de issues (lote sem --issues) não recusa", () => {
    assert.equal(checkBodyCitesIssues("qualquer coisa", []).ok, true);
  });
});

describe("resolveExpectedIssues (#10698)", () => {
  it("--issues explícito vence e não consulta gh", () => {
    const run: GhRunFn = () => {
      throw new Error("não devia chamar gh");
    };
    assert.deepEqual(resolveExpectedIssues(1, [5, 6], "/repo", run), { ok: true, issues: [5, 6] });
  });

  it("sem --issues, lê a branch da PR", () => {
    const run: GhRunFn = (args) => {
      assert.deepEqual(args.slice(0, 4), ["pr", "view", "9", "--json"]);
      return ok("overnight/fix-321-slug\n");
    };
    assert.deepEqual(resolveExpectedIssues(9, null, "/repo", run), {
      ok: true,
      issues: [321],
      branch: "overnight/fix-321-slug",
    });
  });

  it("falha de consulta é erro (fail-closed), nunca lista vazia", () => {
    const r = resolveExpectedIssues(9, null, "/repo", () => fail("rate limit"));
    assert.equal(r.ok, false);
  });
});

describe("parseIssuesFlag (#10698)", () => {
  it("aceita lista com ou sem #", () => {
    assert.deepEqual(parseIssuesFlag("10698,#10699"), [10698, 10699]);
    assert.equal(parseIssuesFlag(undefined), null);
    assert.throws(() => parseIssuesFlag("abc"));
  });
});
