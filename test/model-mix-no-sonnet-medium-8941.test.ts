/**
 * test/model-mix-no-sonnet-medium-8941.test.ts (#8941)
 *
 * Guard de regressão pedido explicitamente no plano da issue #8941 (passo 6):
 * "nenhuma skill/agent/dispatch realiza tarefa alguma usando Sonnet 5 com
 * effort `medium` — nem por pin explícito, nem por herança de effort da
 * sessão" — a definição de feito da issue.
 *
 * Varre o frontmatter de `.claude/agents/*.md` e `.claude/skills/* /SKILL.md`
 * e falha se algum arquivo tiver:
 *   (a) `model:` resolvendo pra Sonnet (`sonnet` ou `claude-sonnet-5`) COM
 *       `effort: medium`, ou
 *   (b) `model:` resolvendo pra Sonnet SEM nenhum `effort:` no frontmatter
 *       (brecha de herança/default do CLI que o #8941 fechou).
 *
 * Não cobre o corpo de prosa de cada skill (dispatches de subagente ad-hoc
 * descritos em texto) — esses são cobertos por testes específicos por
 * arquivo (ex: test/claude-openrouter-subscription-lane-7649.test.ts,
 * test/pr-create-review-hook.test.ts, test/token-reduction-3453-3454.test.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = resolve(ROOT, ".claude/agents");
const SKILLS_DIR = resolve(ROOT, ".claude/skills");

function frontmatter(content: string): string | null {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

function isSonnetModel(value: string): boolean {
  const v = value.trim().replace(/^["']|["']$/g, "");
  return v === "sonnet" || v === "claude-sonnet-5";
}

/** Coleta todos os `.md` de agents/ + todos os `SKILL.md` de skills/. */
function collectFrontmatterFiles(): string[] {
  const files: string[] = [];
  if (existsSync(AGENTS_DIR)) {
    for (const f of readdirSync(AGENTS_DIR)) {
      if (f.endsWith(".md")) files.push(join(AGENTS_DIR, f));
    }
  }
  if (existsSync(SKILLS_DIR)) {
    for (const skillId of readdirSync(SKILLS_DIR)) {
      const skillMd = join(SKILLS_DIR, skillId, "SKILL.md");
      if (existsSync(skillMd)) files.push(skillMd);
    }
  }
  return files;
}

describe("#8941 — nenhum pin de Sonnet 5 com effort medium ou sem effort explícito", () => {
  const files = collectFrontmatterFiles();

  it("encontrou arquivos de agent/skill pra varrer (sanity check do próprio guard)", () => {
    assert.ok(files.length > 10, "esperado dezenas de agents/skills no repo");
  });

  for (const file of files) {
    const rel = file.slice(ROOT.length + 1);
    it(`${rel}: sem Sonnet+medium, sem Sonnet sem effort`, () => {
      const content = readFileSync(file, "utf8");
      const fm = frontmatter(content);
      if (!fm) return; // arquivo sem frontmatter — fora de escopo deste guard

      const modelMatch = fm.match(/^model:\s*(.+)$/m);
      if (!modelMatch) return; // sem model: explícito — nada a checar aqui
      const modelValue = modelMatch[1];
      if (!isSonnetModel(modelValue)) return; // não é Sonnet — fora de escopo

      const effortMatch = fm.match(/^effort:\s*(.+)$/m);
      assert.ok(
        effortMatch,
        `${rel}: model resolve pra Sonnet mas frontmatter não tem effort: explícito (#8941)`,
      );
      const effortValue = effortMatch![1].trim().replace(/^["']|["']$/g, "");
      assert.notEqual(
        effortValue,
        "medium",
        `${rel}: Sonnet + effort:medium é exatamente o que o #8941 proíbe`,
      );
    });
  }
});
