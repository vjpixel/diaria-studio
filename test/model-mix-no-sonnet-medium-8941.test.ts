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
  return v === "sonnet" || v === "claude-sonnet-5" || v === "claude-sonnet-5-5";
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

/**
 * #9530 (03/10/2026) — exceções nominais à proibição de Sonnet+medium, cada uma
 * decidida explicitamente pelo editor. Só o COORDENADOR do overnight: a
 * análise de 03/10 mediu que o modelo do coordenador não afeta a qualidade, e
 * os implementadores/fixers/revisores não herdam mais o effort dele (agents
 * dedicados `dev-*` em Opus 5.5/medium, #9081 — travados abaixo). Nenhum
 * outro arquivo ganha a exceção por tabela.
 */
const SONNET_MEDIUM_DECIDED = new Set([".claude/skills/diaria-overnight/SKILL.md"]);

describe("#9530/#9081 — par do overnight e agents dedicados de dev", () => {
  it("diaria-overnight: model claude-sonnet-5-5 + effort medium (#9530)", () => {
    const fm = frontmatter(readFileSync(join(SKILLS_DIR, "diaria-overnight", "SKILL.md"), "utf8"));
    assert.match(fm!, /^model:\s*claude-sonnet-5-5\s*$/m);
    assert.match(fm!, /^effort:\s*medium\s*$/m);
  });
  for (const agent of ["dev-implementador", "dev-fixer", "dev-revisor"]) {
    it(`${agent}: claude-opus-5-5 + effort medium, sem tools: (toolset do general-purpose) (#9081)`, () => {
      const fm = frontmatter(readFileSync(join(AGENTS_DIR, `${agent}.md`), "utf8"));
      assert.match(fm!, /^model:\s*claude-opus-5-5\s*$/m);
      assert.match(fm!, /^effort:\s*medium\s*$/m);
      assert.doesNotMatch(fm!, /^tools:/m, "tools: restringiria o toolset — o implementador precisa commitar/pushar");
    });
  }
  it("adhoc-opus-low: claude-opus-5-5 + effort low, sem tools: (#8941/#9081)", () => {
    const fm = frontmatter(readFileSync(join(AGENTS_DIR, "adhoc-opus-low.md"), "utf8"));
    assert.match(fm!, /^model:\s*claude-opus-5-5\s*$/m);
    assert.match(fm!, /^effort:\s*low\s*$/m);
    assert.doesNotMatch(fm!, /^tools:/m);
  });
  it("nenhuma skill despacha general-purpose com effort= (parâmetro inexistente no Agent tool, #9081)", () => {
    for (const skillId of readdirSync(SKILLS_DIR)) {
      const p = join(SKILLS_DIR, skillId, "SKILL.md");
      if (!existsSync(p)) continue;
      const body = readFileSync(p, "utf8");
      assert.doesNotMatch(
        body,
        /subagent_type="general-purpose"[^)\n]*effort=/,
        `${skillId}: dispatch general-purpose com effort= — usar agent dedicado (#9081)`,
      );
      assert.doesNotMatch(
        body,
        /`general-purpose`[^.\n]{0,80}`effort: "?low"?`/,
        `${skillId}: prosa de dispatch general-purpose com effort — usar agent dedicado (#9081)`,
      );
    }
  });
});

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
      if (SONNET_MEDIUM_DECIDED.has(rel)) return; // exceção decidida pelo editor — ver abaixo
      assert.notEqual(
        effortValue,
        "medium",
        `${rel}: Sonnet + effort:medium é exatamente o que o #8941 proíbe`,
      );
    });
  }
});

/**
 * #9003 item 7 — pins explícitos de versão (sem alias) e effort sempre explícito.
 * Alias (`sonnet`/`opus`/`haiku`) e pins antigos (`claude-sonnet-5`, `claude-opus-5`)
 * seguem "latest" ou ficam defasados sem ninguém decidir; todo `model:` deve ser um
 * dos IDs do mix aprovado. Haiku 4.5 não aceita `effort`, então é isento da exigência.
 */
const APPROVED_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"]);

describe("#9003 — model: pinado por ID aprovado e effort explícito (Haiku isento)", () => {
  for (const file of collectFrontmatterFiles()) {
    const rel = file.slice(ROOT.length + 1);
    it(`${rel}: model aprovado + effort`, () => {
      const fm = frontmatter(readFileSync(file, "utf8"));
      if (!fm) return;
      const modelMatch = fm.match(/^model:\s*(.+)$/m);
      if (!modelMatch) return;
      const model = modelMatch[1].trim().replace(/^["']|["']$/g, "");
      assert.ok(APPROVED_MODELS.has(model), `${rel}: model "${model}" fora do mix aprovado`);
      if (model.startsWith("claude-haiku")) {
        assert.ok(!/^effort:/m.test(fm), `${rel}: Haiku 4.5 não aceita effort`);
        return;
      }
      assert.ok(/^effort:/m.test(fm), `${rel}: ${model} sem effort: explícito`);
    });
  }
});

/**
 * #9003 item 5 (resíduo #9043 item 2) — sessões de edição em Sonnet 5.5 `low`
 * via frontmatter da skill. O override de skill vale até a próxima resposta do
 * editor: cobre os trechos sem ele (Etapas 1-3 até o gate da Etapa 4; o
 * dispatch da Etapa 5) e devolve a sessão ao modelo padrão no gate. O perfil
 * Jev (#8421) espelha `/diaria-edicao` para não confundir o A/B com troca de modelo.
 * Limite: este guard só confere o TEXTO do frontmatter. Não há prova no repo de
 * que o Claude Code aplica `effort:` de skill (o `model:` é campo conhecido);
 * se for ignorado, a sessão roda no effort padrão dela, sem erro.
 */
describe("#9003 item 5 — skills de edição com model/effort de sessão", () => {
  for (const skill of ["diaria-edicao", "diaria-edicao-jev", "diaria-5-publicacao"]) {
    it(`${skill}: model claude-sonnet-5-5 + effort low no frontmatter`, () => {
      const fm = frontmatter(readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8"));
      assert.ok(fm, `${skill}: sem frontmatter`);
      assert.match(fm!, /^model:\s*claude-sonnet-5-5\s*$/m);
      assert.match(fm!, /^effort:\s*low\s*$/m);
    });
  }
});

/** #9003 item 3 (resíduo #9082 item a) — /diaria-zerar-fila em Opus 5.5 `medium`, não `high`. */
describe("#9003 item 3 — /diaria-zerar-fila", () => {
  it("diaria-zerar-fila: model claude-opus-5-5 + effort medium no frontmatter", () => {
    const fm = frontmatter(readFileSync(join(SKILLS_DIR, "diaria-zerar-fila", "SKILL.md"), "utf8"));
    assert.ok(fm, "diaria-zerar-fila: sem frontmatter");
    assert.match(fm!, /^model:\s*claude-opus-5-5\s*$/m);
    assert.match(fm!, /^effort:\s*medium\s*$/m);
  });
});
