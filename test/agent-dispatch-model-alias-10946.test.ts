/**
 * test/agent-dispatch-model-alias-10946.test.ts (#10946)
 *
 * O parâmetro `model` do Agent tool só aceita ALIAS (`sonnet`/`opus`/`haiku`/
 * `fable`). ID pinado (`claude-opus-5-5`) só vale em frontmatter de agent/skill.
 * As skills develop/contínuo/overnight mandavam dispatchar o fleet do
 * `pr-review-toolkit` com `model: "claude-opus-5-5"` — achado ao vivo no
 * /diaria-develop 261022b: os 5 dispatches do fleet da PR #10895 voltaram
 * `InputValidationError` e tiveram de ser refeitos com `model: "opus"`.
 *
 * Guard de prosa: no CORPO das skills (fora do frontmatter) e em
 * `context/*.md`, menção `model: claude-…` só passa quando descreve um
 * frontmatter (de agent ou da própria skill). É reprovada quando:
 *   (a) vem entre aspas (`model: "claude-…"`) — é a forma de parâmetro do
 *       Agent tool;
 *   (b) vem seguida de "explícito" — é a forma usada pra instruir o dispatch;
 *   (c) aparece logo depois de `Agent`/`subagent_type` (200 caracteres) sem
 *       "frontmatter" a até 150 caracteres antes ou depois.
 *
 * Não toca frontmatter de agent (ali o ID pinado é o correto, #9003) — esses
 * são travados por test/model-mix-no-sonnet-medium-8941.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = resolve(ROOT, ".claude/skills");
const CONTEXT_DIR = resolve(ROOT, "context");

function stripFrontmatter(content: string): string {
  const m = content.match(/^---\n[\s\S]*?\n---/);
  return m ? content.slice(m[0].length) : content;
}

/** Devolve as menções `model: claude-…` que parecem instrução de dispatch do Agent tool. */
function findPinnedAgentDispatches(body: string): string[] {
  const bad: string[] = [];
  const re = /model:\s*(["'])?claude-[a-z0-9-]+\1?`?/g;
  for (const m of body.matchAll(re)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const quoted = Boolean(m[1]);
    const explicit = /^\s*explícit[oa]/.test(body.slice(end, end + 20));
    const around = body.slice(Math.max(0, start - 150), end + 150);
    const describesFrontmatter = /frontmatter/i.test(around);
    const inAgentDispatch = /\bAgent\b|subagent_type/.test(body.slice(Math.max(0, start - 200), start));
    if (quoted || explicit || (inAgentDispatch && !describesFrontmatter)) {
      bad.push(body.slice(Math.max(0, start - 60), end + 40).replace(/\s+/g, " "));
    }
  }
  return bad;
}

function collectFiles(): string[] {
  const files: string[] = [];
  for (const id of readdirSync(SKILLS_DIR)) {
    const f = join(SKILLS_DIR, id, "SKILL.md");
    if (existsSync(f)) files.push(f);
  }
  for (const f of readdirSync(CONTEXT_DIR)) {
    if (f.endsWith(".md")) files.push(join(CONTEXT_DIR, f));
  }
  return files;
}

describe("#10946 — dispatch de Agent nas skills usa alias de modelo, nunca ID pinado", () => {
  it("o detector reprova as três formas que existiam antes do fix", () => {
    // Trechos reais de master antes do #10946 (develop, contínuo, overnight).
    const develop = "type-design-analyzer` — cada um com `model: \"claude-opus-5-5\"` explícito (#2019; o Agent tool não tem";
    const continuo = "`pr-review-toolkit:code-reviewer` via `Agent` com `model: \"claude-opus-5-5\"`\n  explícito — `effort` não é";
    const overnight = "(nome prefixado pelo plugin), `model: claude-opus-5-5` explícito (#2019; o Agent tool não aceita `effort`, no frontmatter";
    for (const t of [develop, continuo, overnight]) {
      assert.equal(findPinnedAgentDispatches(t).length, 1, t);
    }
  });

  it("o detector aceita a descrição de frontmatter e o alias", () => {
    assert.deepEqual(findPinnedAgentDispatches("O frontmatter fixa `model: claude-opus-5-5` + `effort: medium`."), []);
    assert.deepEqual(
      findPinnedAgentDispatches("`adhoc-opus-low` (agent dedicado, `model: claude-opus-5-5` +\n`effort: low` no frontmatter)"),
      [],
    );
    assert.deepEqual(findPinnedAgentDispatches("via `Agent` com `model: \"opus\"` explícito"), []);
    assert.deepEqual(
      findPinnedAgentDispatches("**Modelo/effort do coordenador.** `model: claude-opus-5-5` + `effort: low` — paridade"),
      [],
    );
  });

  it("o detector reprova ID pinado logo após `Agent`/`subagent_type` sem falar de frontmatter (regra c)", () => {
    const t = "dispatchar um `Agent` com `subagent_type: \"x\"` e `model: claude-sonnet-5-5`, escopo do diff";
    assert.equal(findPinnedAgentDispatches(t).length, 1);
  });

  for (const file of collectFiles()) {
    const rel = relative(ROOT, file);
    it(`${rel}: nenhuma instrução de dispatch com model: claude-… (só alias no Agent tool)`, () => {
      const bad = findPinnedAgentDispatches(stripFrontmatter(readFileSync(file, "utf8")));
      assert.deepEqual(
        bad,
        [],
        `${rel}: o parâmetro model do Agent tool só aceita alias (sonnet/opus/haiku/fable) — use model: "opus"; ID pinado só em frontmatter (#10946)`,
      );
    });
  }

  for (const [skill, n] of [
    ["diaria-develop", 2],
    ["diaria-overnight", 2],
    ["diaria-continuo", 1],
  ] as const) {
    it(`${skill}: review do pr-review-toolkit dispatchado com model: "opus" (${n}×)`, () => {
      const body = stripFrontmatter(readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8"));
      const count = body.match(/model: "opus"`\s+explícito/g)?.length ?? 0;
      assert.equal(count, n);
    });
  }
});
