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
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPrLabelsRest,
  checkBodyCitesIssues,
  checkPrHeadMatchesLocal,
  classifyMismatch,
  compareHeadWithLocal,
  headMismatchError,
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

describe("#10618 fatia 4 (review B) — PR de outro repo da allowlist", () => {
  const DESIGN = "vjpixel/diaria-design";

  it("setPrBodyRest com repo: PATCH em repos/{repo}/pulls/N e releitura com -R (nunca o PR do cwd)", () => {
    const calls: string[][] = [];
    let stored = "";
    const run: GhRunFn = (args) => {
      calls.push(args);
      if (args[0] === "api") {
        stored = args.find((a) => a.startsWith("body="))!.slice("body=".length);
        return ok();
      }
      return ok(`${stored}\n`);
    };
    assert.equal(setPrBodyRest(23, "Closes #21", "/repo", run, DESIGN).ok, true);
    assert.ok(calls[0].includes(`repos/${DESIGN}/pulls/23`));
    assert.ok(!calls.some((c) => c.some((a) => a.includes("{owner}"))), "sem placeholder do cwd");
    assert.deepEqual(calls[1].slice(calls[1].indexOf("-R"), calls[1].indexOf("-R") + 2), ["-R", DESIGN]);
  });

  it("addPrLabelsRest com repo: POST em repos/{repo}/issues/N/labels e releitura com -R", () => {
    const calls: string[][] = [];
    const run: GhRunFn = (args) => {
      calls.push(args);
      return args[0] === "api" ? ok() : ok("no-regression-test\n");
    };
    assert.equal(addPrLabelsRest(23, ["no-regression-test"], "/repo", run, DESIGN).ok, true);
    assert.ok(calls[0].includes(`repos/${DESIGN}/issues/23/labels`));
    assert.ok(calls[1].includes("-R") && calls[1].includes(DESIGN));
  });

  it("resolveExpectedIssues com repo: lê a branch do PR no repo dado", () => {
    const calls: string[][] = [];
    const r = resolveExpectedIssues(23, null, "/repo", (args) => {
      calls.push(args);
      return ok("develop/fix-21-x\n");
    }, DESIGN);
    assert.deepEqual(r, { ok: true, issues: [21], branch: "develop/fix-21-x" });
    assert.ok(calls[0].includes("-R") && calls[0].includes(DESIGN));
  });

  it("sem repo: comportamento de sempre (placeholder do cwd, sem -R)", () => {
    const calls: string[][] = [];
    const run: GhRunFn = (args) => {
      calls.push(args);
      return args[0] === "api" ? ok() : ok("x\n");
    };
    setPrBodyRest(23, "x", "/repo", run);
    assert.ok(calls[0].includes("repos/{owner}/{repo}/pulls/23"));
    assert.ok(!calls[1].includes("-R"));
  });
});

// ─── #11566: HEAD da PR = HEAD local ────────────────────────────────────
//
// Cenário real (/diaria-develop 261029): `develop/fix-11467` sobrou no remoto
// da PR #11480 (squash sem --delete-branch). A 2ª PR reaproveitou o nome, o
// push foi recusado (non-fast-forward) e o `gh pr create` abriu a #11528 em
// cima do commit ANTIGO `24cef52`. O corpo citava a issue certa, então a
// conferência do #10698 sozinha passava.
describe("compareHeadWithLocal (#11566)", () => {
  it("mesma branch, commit diferente → mismatch", () => {
    assert.deepEqual(
      compareHeadWithLocal({ branch: "develop/fix-11467", oid: "24cef52aaa" }, { branch: "develop/fix-11467", oid: "f00dbabe11" }),
      { status: "mismatch", branch: "develop/fix-11467", prOid: "24cef52aaa", localOid: "f00dbabe11" },
    );
  });

  it("mesma branch e commit (case-insensitive) → match", () => {
    assert.equal(compareHeadWithLocal({ branch: "b", oid: "ABC" }, { branch: "b", oid: "abc" }).status, "match");
  });

  it("checkout em outra branch → other-branch (não é o checkout da PR)", () => {
    assert.equal(compareHeadWithLocal({ branch: "b", oid: "1" }, { branch: "master", oid: "2" }).status, "other-branch");
  });
});

describe("checkPrHeadMatchesLocal (#11566) — com git real", () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function repoWithTwoCommits(branch: string): { dir: string; old: string; head: string } {
    const dir = mkdtempSync(join(tmpdir(), "safe-edit-11566-"));
    dirs.push(dir);
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git("init", "-q", "-b", branch);
    writeFileSync(join(dir, "a.txt"), "1");
    git("add", "a.txt");
    git("commit", "-q", "-m", "antigo");
    const old = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "a.txt"), "2");
    git("commit", "-q", "-am", "novo");
    return { dir, old, head: git("rev-parse", "HEAD") };
  }

  it("PR num commit DIVERGENTE (branch sobrada, cenário da #11566) → mismatch diverged, mensagem de renomear", () => {
    const { dir, old } = repoWithTwoCommits("develop/fix-11467");
    // Commit irmão do `novo` a partir do `antigo`: fica fora da linha do HEAD,
    // como o commit da PR mergeada que sobrou no remoto.
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
        cwd: dir,
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git("checkout", "-q", "-b", "sobra", old);
    writeFileSync(join(dir, "a.txt"), "sobra");
    git("commit", "-q", "-am", "sobra");
    const stale = git("rev-parse", "HEAD");
    git("checkout", "-q", "develop/fix-11467");
    const head = git("rev-parse", "HEAD");
    const calls: string[][] = [];
    const r = checkPrHeadMatchesLocal(11528, "/repo", dir, (args) => {
      calls.push(args);
      return ok(`develop/fix-11467 ${stale}\n`);
    });
    assert.ok(r.ok);
    assert.deepEqual(r.check, { status: "mismatch", branch: "develop/fix-11467", prOid: stale, localOid: head, relation: "diverged" });
    assert.ok(calls[0].includes("headRefName,headRefOid"));
    assert.ok(r.check.status === "mismatch");
    const msg = headMismatchError(11528, r.check);
    assert.match(msg, /PR #11528/);
    assert.match(msg, /non-fast-forward/);
    assert.match(msg, /#11566/);
    assert.match(msg, /sufixo -2/);
  });

  it("PR num ancestral do HEAD local → mismatch ahead, mensagem manda dar push (não renomear)", () => {
    const { dir, old, head } = repoWithTwoCommits("develop/fix-11467");
    const r = checkPrHeadMatchesLocal(11528, "/repo", dir, () => ok(`develop/fix-11467 ${old}\n`));
    assert.ok(r.ok);
    assert.deepEqual(r.check, { status: "mismatch", branch: "develop/fix-11467", prOid: old, localOid: head, relation: "ahead" });
    assert.ok(r.check.status === "mismatch");
    const msg = headMismatchError(11528, r.check);
    assert.match(msg, /falta push/);
    assert.match(msg, /git push origin develop\/fix-11467/);
    assert.doesNotMatch(msg, /sufixo -2/);
  });

  // Review do #11584 (P2): depois de `gh-pr-update-branch.ts` com `updated`, o
  // checkout local fica ATRÁS do headRefOid. Antes saía `mismatch` (exit 1) com
  // o conselho errado de fechar a PR.
  it("HEAD local ancestral do da PR (checkout atrás) → local-behind, não mismatch", () => {
    const { dir, old, head } = repoWithTwoCommits("overnight/fix-11566-x");
    const r0 = spawnSync("git", ["reset", "-q", "--hard", old], { cwd: dir, encoding: "utf8" });
    assert.equal(r0.status, 0, r0.stderr);
    const r = checkPrHeadMatchesLocal(11584, "/repo", dir, () => ok(`overnight/fix-11566-x ${head}\n`));
    assert.deepEqual(r, { ok: true, check: { status: "local-behind", branch: "overnight/fix-11566-x", prOid: head, localOid: old } });
  });

  it("objeto da PR ausente localmente e fetch falha → mismatch unknown (segue erro)", () => {
    const { dir, head } = repoWithTwoCommits("overnight/fix-2-x");
    const ghost = "0123456789abcdef0123456789abcdef01234567";
    const r = checkPrHeadMatchesLocal(2, "/repo", dir, () => ok(`overnight/fix-2-x ${ghost}\n`));
    assert.ok(r.ok);
    assert.deepEqual(r.check, { status: "mismatch", branch: "overnight/fix-2-x", prOid: ghost, localOid: head, relation: "unknown" });
  });

  it("objeto ausente: faz fetch da branch e reclassifica (local-behind)", () => {
    const calls: string[][] = [];
    let fetched = false;
    const check = classifyMismatch(
      { status: "mismatch", branch: "b", prOid: "p", localOid: "l" },
      "/dir",
      (args) => {
        calls.push(args);
        if (args[0] === "fetch") {
          fetched = true;
          return ok("");
        }
        if (!fetched) return { status: 128, stdout: "", stderr: "fatal: Not a valid commit name p" };
        return args[2] === "l" ? ok("") : { status: 1, stdout: "", stderr: "" };
      },
    );
    assert.deepEqual(check, { status: "local-behind", branch: "b", prOid: "p", localOid: "l" });
    assert.deepEqual(calls[1], ["fetch", "--quiet", "origin", "b"]);
  });

  it("PR no commit atual → match", () => {
    const { dir, head } = repoWithTwoCommits("overnight/fix-1-x");
    const r = checkPrHeadMatchesLocal(1, "/repo", dir, () => ok(`overnight/fix-1-x ${head}\n`));
    assert.deepEqual(r, { ok: true, check: { status: "match", oid: head } });
  });

  it("diretório fora do git → no-local-checkout, sem consultar o gh", () => {
    const dir = mkdtempSync(join(tmpdir(), "safe-edit-11566-nogit-"));
    dirs.push(dir);
    const r = checkPrHeadMatchesLocal(1, "/repo", dir, () => {
      throw new Error("não devia chamar gh");
    });
    assert.ok(r.ok);
    assert.equal(r.check.status, "no-local-checkout");
  });

  it("falha do gh é erro (fail-closed); PR de outro repo vai com -R", () => {
    const { dir } = repoWithTwoCommits("develop/fix-21-x");
    const calls: string[][] = [];
    const r = checkPrHeadMatchesLocal(
      23,
      "/repo",
      dir,
      (args) => {
        calls.push(args);
        return fail("rate limit");
      },
      undefined,
      "vjpixel/diaria-design",
    );
    assert.equal(r.ok, false);
    assert.ok(calls[0].includes("-R") && calls[0].includes("vjpixel/diaria-design"));
  });
});
