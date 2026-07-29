/**
 * test/studio-skills-4270.test.ts (#4270) — cobertura de
 * `scripts/studio-ui/studio-skills.ts` + rotas `/skills` e `/api/skills`.
 *
 * O que este arquivo trava (regressão #633):
 *   1. **Parser puro** de frontmatter + heading + seção `## Argumentos`,
 *      contra fixtures de `SKILL.md` — nunca lendo `.claude/skills/` real
 *      (senão o teste passaria a depender do estado da máquina, #4270
 *      "Implementação sugerida").
 *   2. **4 fixtures pedidas explicitamente pela issue**: frontmatter
 *      completo; sem seção `## Argumentos`; frontmatter faltando
 *      `description`; diretório sem `SKILL.md`.
 *   3. **Diretórios stale/vazios são ignorados em silêncio** (não viram
 *      erro nem entrada fantasma) — cenário real da máquina do editor
 *      (`diaria-4-publicar`, `diaria-sorteio`).
 *   4. **Agrupamento** (`deriveSkillGroup`) sempre resolve pra um grupo
 *      válido, mesmo pra id desconhecido (fallback, nunca invisível).
 *   5. **Contrato HTTP** — `/skills` serve o shell, `/api/skills` devolve o
 *      catálogo real do repo (as skills verdadeiras de `.claude/skills/`).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseFrontmatter,
  extractUsageHeading,
  extractArgumentsSection,
  deriveInvocable,
  parseSkillFlags,
  deriveSkillGroup,
  parseSkillMarkdown,
  listSkillsFromDir,
  buildSkillsData,
  SKILL_GROUP_ORDER,
  SKILL_GROUP_LABELS,
} from "../scripts/studio-ui/studio-skills.ts";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, "data", "editions"), { recursive: true });
  return root;
}

function writeSkill(skillsDir: string, id: string, content: string): void {
  const dir = join(skillsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf8");
}

// ── Fixtures (#4270 "Implementação sugerida" — as 4 pedidas na issue) ────

const FIXTURE_COMPLETE = `---
name: diaria-log
description: Lê \`data/run-log.jsonl\` e mostra eventos recentes. Uso — \`/diaria-log [edition] [level]\`.
model: sonnet
effort: high
disable-model-invocation: true
---

# /diaria-log [edition] [level]

Inspeciona o log estruturado da pipeline.

## Argumentos

- \`edition\` (opcional): \`AAMMDD\`. Filtra eventos daquela edição.
- \`level\` (opcional): \`error\`, \`warn\`, \`info\`, ou \`all\`.

## Execução

1. Ler o log.
`;

const FIXTURE_NO_ARGS_SECTION = `---
name: diaria-refresh-dedup
description: Regenera manualmente data/past-editions.md.
---

# /diaria-refresh-dedup (manual / opcional)

Atualiza o cache de edições passadas.

## Execução

Rode via Bash.
`;

const FIXTURE_MISSING_DESCRIPTION = `---
name: diaria-sem-descricao
---

# /diaria-sem-descricao

Corpo sem frontmatter de descrição.
`;

describe("#4270 — parseFrontmatter (pura)", () => {
  it("separa frontmatter e body, uma linha por chave", () => {
    const { frontmatter, body } = parseFrontmatter(FIXTURE_COMPLETE);
    assert.equal(frontmatter.name, "diaria-log");
    assert.match(frontmatter.description, /run-log\.jsonl/);
    assert.equal(frontmatter.model, "sonnet");
    assert.equal(frontmatter.effort, "high");
    assert.equal(frontmatter["disable-model-invocation"], "true");
    assert.match(body, /^# \/diaria-log/);
  });

  it("fail-soft: sem abertura '---' devolve frontmatter vazio e o arquivo inteiro como body", () => {
    const { frontmatter, body } = parseFrontmatter("# /sem-frontmatter\n\nconteúdo\n");
    assert.deepEqual(frontmatter, {});
    assert.match(body, /^# \/sem-frontmatter/);
  });

  it("fail-soft: '---' de abertura sem fechamento também devolve frontmatter vazio", () => {
    const { frontmatter, body } = parseFrontmatter("---\nname: x\n\n# heading\n");
    assert.deepEqual(frontmatter, {});
    assert.match(body, /^---/);
  });
});

describe("#4270 — extractUsageHeading (pura)", () => {
  it("extrai o H1 cru, ignorando H2", () => {
    const { body } = parseFrontmatter(FIXTURE_COMPLETE);
    assert.equal(extractUsageHeading(body), "/diaria-log [edition] [level]");
  });

  it("heading com sufixo parentético (diaria-refresh-dedup)", () => {
    const { body } = parseFrontmatter(FIXTURE_NO_ARGS_SECTION);
    assert.equal(extractUsageHeading(body), "/diaria-refresh-dedup (manual / opcional)");
  });

  it("null quando não há H1", () => {
    assert.equal(extractUsageHeading("## só H2\n\ntexto"), null);
  });

  it("nunca casa uma linha H2 como se fosse H1", () => {
    assert.equal(extractUsageHeading("## Argumentos\n\nconteúdo"), null);
  });
});

describe("#4270 — extractArgumentsSection (pura)", () => {
  it("extrai o conteúdo até o próximo heading H1/H2", () => {
    const { body } = parseFrontmatter(FIXTURE_COMPLETE);
    const section = extractArgumentsSection(body);
    assert.match(section ?? "", /edition.*opcional/s);
    assert.match(section ?? "", /level.*opcional/s);
    assert.doesNotMatch(section ?? "", /## Execução/);
    assert.doesNotMatch(section ?? "", /Ler o log/);
  });

  it("REGRESSÃO fixture 'sem seção Argumentos' (#4270): null quando a skill não declara", () => {
    const { body } = parseFrontmatter(FIXTURE_NO_ARGS_SECTION);
    assert.equal(extractArgumentsSection(body), null);
  });

  it("seção no fim do arquivo (sem próximo heading) também é capturada inteira", () => {
    const body = "# /x\n\n## Argumentos\n\n- só isso, sem heading depois\n";
    assert.match(extractArgumentsSection(body) ?? "", /só isso/);
  });
});

describe("#4270 — deriveInvocable (pura)", () => {
  it("primeiro token do heading quando começa com '/'", () => {
    assert.equal(deriveInvocable("/diaria-log [edition] [level]", "diaria-log"), "/diaria-log");
  });

  it("fallback pro id do diretório quando o heading não começa com '/'", () => {
    assert.equal(deriveInvocable("Sem barra no início", "diaria-x"), "/diaria-x");
  });

  it("fallback pro id quando não há heading", () => {
    assert.equal(deriveInvocable(null, "diaria-y"), "/diaria-y");
  });
});

describe("#4270 — parseSkillFlags (pura)", () => {
  it("só inclui os campos presentes no frontmatter", () => {
    assert.deepEqual(parseSkillFlags({ name: "x" }), {});
    assert.deepEqual(parseSkillFlags({ model: "sonnet" }), { model: "sonnet" });
  });

  it("disable-model-invocation vira boolean real", () => {
    assert.deepEqual(parseSkillFlags({ "disable-model-invocation": "true" }), { disableModelInvocation: true });
    assert.deepEqual(parseSkillFlags({ "disable-model-invocation": "false" }), { disableModelInvocation: false });
  });

  it("os 3 flags juntos (diaria-overnight real)", () => {
    const flags = parseSkillFlags({ model: "sonnet", effort: "high", "disable-model-invocation": "true" });
    assert.deepEqual(flags, { model: "sonnet", effort: "high", disableModelInvocation: true });
  });
});

describe("#4270 — deriveSkillGroup (pura, nunca deixa skill sem grupo)", () => {
  it("pipeline diária: diaria-edicao e diaria-N-*", () => {
    assert.equal(deriveSkillGroup("diaria-edicao"), "pipeline-diaria");
    assert.equal(deriveSkillGroup("diaria-1-pesquisa"), "pipeline-diaria");
    assert.equal(deriveSkillGroup("diaria-6-agendamento"), "pipeline-diaria");
  });

  it("mensal/semanal", () => {
    assert.equal(deriveSkillGroup("diaria-mensal"), "mensal-semanal");
    assert.equal(deriveSkillGroup("diaria-semanal"), "mensal-semanal");
  });

  it("sessões de dev", () => {
    assert.equal(deriveSkillGroup("diaria-overnight"), "dev-sessions");
    assert.equal(deriveSkillGroup("diaria-develop"), "dev-sessions");
  });

  it("fallback auxiliares/debug — inclusive id totalmente desconhecido (skill nova sem convenção); a issue #4270 cita 'log, inbox, refresh-dedup, source-health, mes-erros' como exemplos deste grupo", () => {
    assert.equal(deriveSkillGroup("diaria-log"), "auxiliares");
    assert.equal(deriveSkillGroup("diaria-inbox"), "auxiliares");
    assert.equal(deriveSkillGroup("diaria-refresh-dedup"), "auxiliares");
    assert.equal(deriveSkillGroup("diaria-source-health"), "auxiliares");
    assert.equal(deriveSkillGroup("diaria-mes-erros"), "auxiliares");
    assert.equal(deriveSkillGroup("uma-skill-qualquer-nova"), "auxiliares");
  });

  it("todo id de SKILL_GROUP_ORDER tem label em SKILL_GROUP_LABELS", () => {
    for (const g of SKILL_GROUP_ORDER) assert.ok(SKILL_GROUP_LABELS[g], `grupo ${g} sem label`);
  });
});

describe("#4270 — parseSkillMarkdown (composição)", () => {
  it("fixture completa: todos os campos populados", () => {
    const entry = parseSkillMarkdown("diaria-log", FIXTURE_COMPLETE, ".claude/skills/diaria-log/SKILL.md");
    assert.equal(entry.id, "diaria-log");
    assert.equal(entry.invocable, "/diaria-log");
    assert.match(entry.description, /run-log\.jsonl/);
    assert.equal(entry.usageHeading, "/diaria-log [edition] [level]");
    assert.match(entry.argumentsMarkdown ?? "", /edition/);
    assert.deepEqual(entry.flags, { model: "sonnet", effort: "high", disableModelInvocation: true });
    assert.equal(entry.group, "auxiliares");
    assert.equal(entry.sourcePath, ".claude/skills/diaria-log/SKILL.md");
  });

  it("REGRESSÃO fixture 'frontmatter faltando description' (#4270): não lança, description vira string vazia", () => {
    const entry = parseSkillMarkdown(
      "diaria-sem-descricao",
      FIXTURE_MISSING_DESCRIPTION,
      ".claude/skills/diaria-sem-descricao/SKILL.md",
    );
    assert.equal(entry.description, "");
    assert.equal(entry.invocable, "/diaria-sem-descricao");
    assert.equal(entry.usageHeading, "/diaria-sem-descricao");
  });

  it("sourcePath sempre com barras forward (normaliza separador do Windows)", () => {
    const entry = parseSkillMarkdown("x", "# /x\n", ".claude\\skills\\x\\SKILL.md");
    assert.equal(entry.sourcePath, ".claude/skills/x/SKILL.md");
  });
});

describe("#4270 — listSkillsFromDir (filesystem, fixtures isoladas — nunca lê .claude/skills/ real)", () => {
  let skillsDir: string;
  let root: string;

  before(() => {
    root = tempRoot("studio-skills-list-");
    skillsDir = join(root, ".claude", "skills");
    writeSkill(skillsDir, "diaria-log", FIXTURE_COMPLETE);
    writeSkill(skillsDir, "diaria-refresh-dedup", FIXTURE_NO_ARGS_SECTION);
    writeSkill(skillsDir, "diaria-sem-descricao", FIXTURE_MISSING_DESCRIPTION);
    // REGRESSÃO fixture "diretório sem SKILL.md" (#4270) — dir stale/vazio,
    // como diaria-4-publicar/diaria-sorteio na máquina real do editor.
    mkdirSync(join(skillsDir, "diaria-stale-sem-skill-md"), { recursive: true });
    // arquivo solto (não-diretório) dentro de .claude/skills — defensivo,
    // não deve quebrar o readdir nem virar entrada.
    writeFileSync(join(skillsDir, "README.md"), "não é uma skill", "utf8");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lista as 3 skills com SKILL.md legível, ordenadas por id", () => {
    const { skills, errors } = listSkillsFromDir(skillsDir);
    assert.deepEqual(
      skills.map((s) => s.id),
      ["diaria-log", "diaria-refresh-dedup", "diaria-sem-descricao"],
    );
    assert.deepEqual(errors, []);
  });

  it("REGRESSÃO: diretório sem SKILL.md é ignorado em silêncio — não aparece em skills nem em errors", () => {
    const { skills, errors } = listSkillsFromDir(skillsDir);
    assert.ok(!skills.some((s) => s.id === "diaria-stale-sem-skill-md"));
    assert.ok(!errors.some((e) => e.id === "diaria-stale-sem-skill-md"));
  });

  it("arquivo solto (README.md) na raiz de skills/ nunca vira entrada", () => {
    const { skills } = listSkillsFromDir(skillsDir);
    assert.ok(!skills.some((s) => s.id === "README.md"));
  });

  it("diretório .claude/skills inexistente: fail-soft, listas vazias, nunca lança", () => {
    const result = listSkillsFromDir(join(root, "nao-existe", "skills"));
    assert.deepEqual(result, { skills: [], errors: [] });
  });
});

describe("#4270 — buildSkillsData (snapshot)", () => {
  it("junta execMode + skills + metadados de agrupamento", () => {
    const root = tempRoot("studio-skills-build-");
    try {
      writeSkill(join(root, ".claude", "skills"), "diaria-log", FIXTURE_COMPLETE);
      const data = buildSkillsData(root, { now: () => Date.parse("2026-07-29T12:00:00Z") });
      assert.equal(data.skills.length, 1);
      assert.equal(data.generatedAt, "2026-07-29T12:00:00.000Z");
      assert.deepEqual([...data.groupOrder], [...SKILL_GROUP_ORDER]);
      assert.ok(data.execMode === "local" || data.execMode === "cloud");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── contrato HTTP: /skills e /api/skills servem o catálogo REAL do repo ──

describe("#4270 — contrato HTTP (/skills e /api/skills)", () => {
  let server: StudioServer;
  let root: string;

  before(async () => {
    // Aqui, diferente das suites acima, usamos o REPO_ROOT real (não um tmp
    // isolado) — o objetivo deste bloco é confirmar que o servidor aponta
    // pro `.claude/skills/` verdadeiro e devolve as skills reais do projeto
    // (mesmo padrão do teste de nav.js, que também roda contra rotas reais).
    const __dir = fileURLToPath(new URL(".", import.meta.url));
    root = resolve(__dir, "..");
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
  });

  it("GET /skills serve a página (shell estático)", async () => {
    const res = await fetch(new URL("/skills", server.url));
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(body.includes('window.STUDIO_PAGE = "skills";'));
    assert.ok(body.includes('src="/skills.js"'));
  });

  it("GET /api/skills devolve o catálogo real, incluindo diaria-log com Argumentos", async () => {
    const res = await fetch(new URL("/api/skills", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.skills));
    assert.ok(body.skills.length >= 15, "esperado >=15 skills reais em .claude/skills/");
    const log = body.skills.find((s) => s.id === "diaria-log");
    assert.ok(log, "diaria-log precisa aparecer no catálogo real");
    assert.equal(log.invocable, "/diaria-log");
    assert.match(log.argumentsMarkdown ?? "", /edition/);
    // diaria-overnight declara os 3 flags reais — trava contra regressão do
    // parser em cima de um arquivo de verdade, não só fixture sintética.
    const overnight = body.skills.find((s) => s.id === "diaria-overnight");
    assert.ok(overnight);
    assert.equal(overnight.flags.model, "sonnet");
    assert.equal(overnight.flags.disableModelInvocation, true);
  });
});
