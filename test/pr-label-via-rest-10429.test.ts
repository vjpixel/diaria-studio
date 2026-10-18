/**
 * #10429 — nenhuma skill/playbook/regra manda aplicar label em PR com
 * `gh pr edit N --add-label`.
 *
 * Regressão do incidente da rodada overnight 261018: a SKILL do overnight
 * mandava reter PR sensível com `gh pr edit {N} --add-label retido-para-editor`
 * (#10278). Esse comando esbarra em `projectCards` (Projects classic) e NÃO
 * aplica a label — quem segue o texto acredita que reteve a PR e o gate
 * `check-pr-retido-gate.ts` não a enxerga. O caminho certo é
 * `scripts/lib/gh-pr-safe-edit.ts --add-label` (REST + releitura, #6292).
 *
 * Linhas que citam o comando só para proibi-lo (contêm "nunca" ou a issue
 * de origem) não contam.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { addPrLabelsRest, type GhRunFn } from "../scripts/lib/gh-pr-safe-edit.ts";

const ROOT = join(import.meta.dirname, "..");

/** `gh pr edit` com alvo de PR (placeholder, N, número ou variável) e `--add-label` no mesmo comando. */
const FORBIDDEN = /gh pr edit\s+(?:\{N\}|\{pr\}|N|\d+|\$\{?\w+\}?)\s+[^`\n]*--add-label/;
const EXEMPT = /nunca|#6292|#10429/i;

function findPrEditAddLabelInstructions(content: string): string[] {
  return content
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => FORBIDDEN.test(line) && !EXEMPT.test(line))
    .map(({ line, n }) => `${n}: ${line.trim().slice(0, 160)}`);
}

function walkMd(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkMd(full, out);
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

describe("instruções de label em PR não usam gh pr edit --add-label (#10429)", () => {
  it("detector pega a forma antiga da SKILL do overnight (cenário real do incidente)", () => {
    const old = "decide que uma PR precisa do editor, rodar `gh pr edit {N} --add-label retido-para-editor` além do comentário.";
    assert.equal(findPrEditAddLabelInstructions(old).length, 1);
  });

  it("detector ignora linha que proíbe o comando", () => {
    assert.equal(findPrEditAddLabelInstructions("**Nunca `gh pr edit {N} --add-label x`** (#10429)").length, 0);
    assert.equal(findPrEditAddLabelInstructions("`gh issue edit N --add-label x` é issue, não PR").length, 0);
  });

  it("skills, agents, context/ e CLAUDE.md não instruem gh pr edit --add-label", () => {
    const files = [
      ...walkMd(join(ROOT, ".claude/skills")),
      ...walkMd(join(ROOT, ".claude/agents")),
      ...walkMd(join(ROOT, "context")),
      ...walkMd(join(ROOT, "hermes")),
      join(ROOT, "CLAUDE.md"),
    ];
    const violations: string[] = [];
    for (const f of files) {
      for (const v of findPrEditAddLabelInstructions(readFileSync(f, "utf8"))) {
        violations.push(`${relative(ROOT, f)}:${v}`);
      }
    }
    assert.deepEqual(violations, [], `use scripts/lib/gh-pr-safe-edit.ts --pr N --add-label:\n${violations.join("\n")}`);
  });

  it("regra 31 do dispatch-rules aponta o helper", () => {
    const rules = readFileSync(join(ROOT, "context/overnight-dispatch-rules.md"), "utf8");
    assert.match(rules, /gh-pr-safe-edit\.ts --pr N --add-label/);
  });
});

describe("addPrLabelsRest aplica retido-para-editor via REST e confirma (#10429)", () => {
  it("POST em issues/N/labels com labels[]=retido-para-editor, depois releitura", () => {
    const calls: string[][] = [];
    const gh: GhRunFn = (args) => {
      calls.push(args);
      if (args[0] === "api") return { status: 0, stdout: "[]", stderr: "" };
      return { status: 0, stdout: "retido-para-editor\n", stderr: "" };
    };
    const r = addPrLabelsRest(10221, ["retido-para-editor"], ROOT, gh);
    assert.equal(r.ok, true);
    assert.deepEqual(calls[0], ["api", "-X", "POST", "repos/{owner}/{repo}/issues/10221/labels", "-f", "labels[]=retido-para-editor"]);
    assert.ok(calls.every((c) => !(c[0] === "pr" && c[1] === "edit")));
  });

  it("label ausente na releitura → ok:false (retenção não aplicada não passa em silêncio)", () => {
    const gh: GhRunFn = (args) =>
      args[0] === "api" ? { status: 0, stdout: "[]", stderr: "" } : { status: 0, stdout: "bug\n", stderr: "" };
    const r = addPrLabelsRest(10221, ["retido-para-editor"], ROOT, gh);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /retido-para-editor/);
  });
});
