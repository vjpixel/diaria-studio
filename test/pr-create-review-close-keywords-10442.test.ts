/**
 * #10442 — `.claude/hooks/pr-create-review.mjs` anexava `Closes #N` ao corpo
 * da PR com `gh pr edit N --body ...`. Essa mutação GraphQL esbarra em
 * `projectCards` (Projects classic) e pode sair `exit 0` sem alterar o corpo
 * (#6292): o hook devolvia `applied: true` e a PR ficava sem o gatilho que
 * fecha a issue. A escrita agora passa por `scripts/lib/gh-pr-safe-edit.ts
 * --body-file` (REST + releitura, falha alto), e a falha volta pra sessão como
 * aviso no `additionalContext`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// @ts-expect-error -- hook .mjs sem .d.mts (mesma situação, já na baseline, de pr-create-review-hook.test.ts)
import { SAFE_EDIT_SCRIPT, closeKeywordWarning, ensureCloseKeywords, writePrBodySafe } from "../.claude/hooks/pr-create-review.mjs";

const ROOT = join(import.meta.dirname, "..");
const HOOK_SRC = readFileSync(join(ROOT, ".claude/hooks/pr-create-review.mjs"), "utf8");

const viewReturning = (body: string) => (_cmd: string, args: string[]) => {
  if (args[1] === "view") return body;
  throw new Error(`execFn não deveria ser chamado para ${args.join(" ")}`);
};

describe("hook não escreve o corpo da PR com gh pr edit (#10442)", () => {
  it("o código do hook não monta mais `gh pr edit` (cenário da issue)", () => {
    assert.doesNotMatch(HOOK_SRC, /\["pr",\s*"edit"/);
  });

  it("o script de escrita apontado existe no repo", () => {
    assert.ok(existsSync(join(ROOT, SAFE_EDIT_SCRIPT)), SAFE_EDIT_SCRIPT);
  });
});

describe("writePrBodySafe — delega pro gh-pr-safe-edit.ts --body-file", () => {
  it("passa --pr e um --body-file com o corpo exato, e apaga o arquivo depois", () => {
    let seenFile = "";
    let seenBody = "";
    let seenArgs: string[] = [];
    const spawnFn = (cmd: string, args: string[]) => {
      // #10453: node --import tsx direto (sem npx/shell) — ver test/pr-create-review-hook-budget-10453.test.ts.
      assert.equal(cmd, process.execPath);
      seenArgs = args;
      seenFile = args[args.indexOf("--body-file") + 1];
      seenBody = readFileSync(seenFile, "utf8");
      return { status: 0, stdout: '{"ok":true}', stderr: "" };
    };
    const body = "Fecha #10442\n\nCloses #10442\n";
    const r = writePrBodySafe(10442, body, { spawnFn, cwd: ROOT });
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(seenArgs.slice(0, 5), ["--import", "tsx", SAFE_EDIT_SCRIPT, "--pr", "10442"]);
    assert.equal(seenBody, body);
    assert.equal(existsSync(dirname(seenFile)), false, "tmpdir do corpo deveria ter sido apagado");
  });

  it("#10716: passa --allow-missing-issue-marker (o hook só anexa marcador; a recusa do #10698 não se aplica)", () => {
    // Cenário real: branch `*/fix-10698-…` com corpo "Fecha #10700". O hook
    // anexa `Closes #10700`; sem a flag o safe-edit exige `#10698` no corpo,
    // recusa com exit 1 e a #10700 não fecha no merge.
    let seenArgs: string[] = [];
    const spawnFn = (_cmd: string, args: string[]) => {
      seenArgs = args;
      return { status: 0, stdout: '{"ok":true}', stderr: "" };
    };
    const r = writePrBodySafe(10708, "Fecha #10700\n\nCloses #10700\n", { spawnFn, cwd: ROOT });
    assert.deepEqual(r, { ok: true });
    assert.ok(seenArgs.includes("--allow-missing-issue-marker"), seenArgs.join(" "));
    // A flag precisa existir com esse nome exato no helper — senão vira no-op silencioso.
    const helperSrc = readFileSync(join(ROOT, SAFE_EDIT_SCRIPT), "utf8");
    assert.match(helperSrc, /flags\.has\("allow-missing-issue-marker"\)/);
  });

  it("releitura que não bate (exit 1 do helper) vira ok:false com o erro", () => {
    const spawnFn = () => ({ status: 1, stdout: '{"ok":false,"error":"corpo lido de volta NÃO bate"}', stderr: "" });
    const r = writePrBodySafe(1, "x", { spawnFn, cwd: ROOT });
    assert.equal(r.ok, false);
    assert.match(r.error, /NÃO bate/);
  });

  it("spawn falho (npx ausente) vira ok:false, nunca lança", () => {
    const spawnFn = () => ({ status: null, error: new Error("spawn npx ENOENT"), stdout: "", stderr: "" });
    const r = writePrBodySafe(1, "x", { spawnFn, cwd: ROOT });
    assert.equal(r.ok, false);
    assert.match(r.error, /ENOENT/);
  });
});

describe("ensureCloseKeywords não reporta sucesso sem a escrita confirmada (#10442)", () => {
  it("escrita que falha → applied:false, reason write-failed (antes: applied:true em silêncio)", () => {
    const r = ensureCloseKeywords("https://github.com/o/r/pull/10442", {
      execFn: viewReturning("Fecha #10442\n"),
      writeFn: () => ({ ok: false, error: "PATCH reportou sucesso mas o corpo lido de volta NÃO bate" }),
    });
    assert.equal(r.applied, false);
    assert.equal(r.reason, "write-failed");
    assert.equal(r.addendum, "Closes #10442");
    assert.equal(r.pr, 10442);
  });

  it("writeFn que lança também vira write-failed, nunca propaga", () => {
    const r = ensureCloseKeywords("https://github.com/o/r/pull/7", {
      execFn: viewReturning("Fecha #7\n"),
      writeFn: () => {
        throw new Error("boom");
      },
    });
    assert.equal(r.reason, "write-failed");
    assert.match(r.error, /boom/);
  });

  it("closeKeywordWarning só avisa em write-failed e cita o comando de correção", () => {
    const w = closeKeywordWarning({ applied: false, reason: "write-failed", pr: 42, addendum: "Closes #9", error: "x" });
    assert.ok(w);
    assert.match(w, /Closes #9/);
    assert.match(w, /gh-pr-safe-edit\.ts --pr 42 --body-file/);
    assert.equal(closeKeywordWarning({ applied: true, addendum: "Closes #9" }), null);
    assert.equal(closeKeywordWarning({ applied: false, reason: "not-needed" }), null);
    assert.equal(closeKeywordWarning({ applied: false, reason: "error" }), null);
    assert.equal(closeKeywordWarning(undefined), null);
  });

  it("o main do hook põe o aviso no additionalContext", () => {
    assert.match(HOOK_SRC, /closeKeywordWarning\(\s*ensureCloseKeywords\(prUrl,/);
    assert.match(HOOK_SRC, /closeWarning \? `\$\{closeWarning\}\\n\\n` : ""/);
  });
});
