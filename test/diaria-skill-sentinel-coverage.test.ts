/**
 * test/diaria-skill-sentinel-coverage.test.ts (#5793, #5792)
 *
 * Grep tests pra garantir que `.claude/skills/diaria-2-escrita/SKILL.md` e
 * `.claude/skills/diaria-3-imagens/SKILL.md` de fato escrevem o sentinel de
 * conclusão do próprio stage (`pipeline-sentinel.ts write --step N`) em TODO
 * caminho de finalização do playbook — gate humano aprovado E `--no-gate`/
 * `--no-gates`.
 *
 * Achado ao vivo (#5792/#5793): as duas skills completavam o trabalho de
 * verdade mas nunca escreviam `_internal/.step-N-done.json`, então qualquer
 * consumidor que depende do sentinel (run-edition-stages.ts, o runner
 * AGENDADO #5738, resume-aware do /diaria-edicao) tratava um stage COMPLETO
 * como incompleto. Não executa a skill de verdade (isso exigiria uma sessão
 * Claude Code real) — só confirma que o comando está presente no texto do
 * playbook, nos pontos certos, mesmo padrão de
 * `test/orchestrator-stage-6-wiring.test.ts` (#4574).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSentinel, writeSentinel } from "../scripts/lib/pipeline-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_2 = resolve(ROOT, ".claude/skills/diaria-2-escrita/SKILL.md");
const SKILL_3 = resolve(ROOT, ".claude/skills/diaria-3-imagens/SKILL.md");

describe("diaria-2-escrita/SKILL.md escreve o sentinel do Stage 2 (#5792)", () => {
  const skill = readFileSync(SKILL_2, "utf8");

  it("referencia pipeline-sentinel.ts write --step 2", () => {
    assert.match(skill, /pipeline-sentinel\.ts write[\s\S]*?--step 2/);
  });

  it("referencia a issue #5792", () => {
    assert.match(skill, /#5792/);
  });

  it("o caminho --no-gate/--no-gates (Passo 6) leva explicitamente ao sentinel (Passo 7c)", () => {
    const marker = skill.indexOf("pular este passo. Ir direto pro Passo 7");
    assert.ok(marker !== -1, "Passo 6 deve descrever o caminho --no-gate/--no-gates");
    const around = skill.slice(marker, marker + 300);
    assert.match(around, /7c/, "Passo 6 deve apontar para o Passo 7c (sentinel) no caminho --no-gate/--no-gates");
  });

  it("o caminho COM gate ('sim' do editor) leva explicitamente ao sentinel (Passo 7c)", () => {
    const marker = skill.indexOf('Aguardar resposta. Se "sim"');
    assert.ok(marker !== -1, "Passo 6 deve descrever a resposta 'sim' do editor");
    const around = skill.slice(marker, marker + 300);
    assert.match(around, /7c/, "resposta 'sim' deve apontar para o Passo 7c (sentinel)");
  });

  it("Passo 7c (sentinel) vem depois do Passo 7 (title-picker) e 7b (título/subtítulo) no arquivo", () => {
    const idx7 = skill.indexOf("## Passo 7 —");
    const idx7b = skill.indexOf("## Passo 7b —");
    const idx7c = skill.indexOf("## Passo 7c —");
    assert.ok(idx7 !== -1 && idx7b !== -1 && idx7c !== -1, "Passos 7, 7b e 7c devem existir");
    assert.ok(idx7 < idx7b && idx7b < idx7c, "ordem correta: 7 < 7b < 7c — sentinel nunca antes do title-picker");
  });

  it("a chamada do sentinel usa os outputs 02-reviewed.md e 03-social.md", () => {
    const idx = skill.indexOf("## Passo 7c —");
    assert.ok(idx !== -1);
    const block = skill.slice(idx, idx + 900);
    assert.match(block, /--outputs\s+"02-reviewed\.md,03-social\.md"/);
  });
});

describe("diaria-3-imagens/SKILL.md escreve o sentinel do Stage 3 (#5793)", () => {
  const skill = readFileSync(SKILL_3, "utf8");

  it("referencia a issue #5793", () => {
    assert.match(skill, /#5793/);
  });

  it("referencia pipeline-sentinel.ts write --step 3 pelo menos 2x (caminho --no-gate e caminho gate/--no-gates)", () => {
    const matches = skill.match(/pipeline-sentinel\.ts write[\s\S]*?--step 3/g) ?? [];
    assert.ok(
      matches.length >= 2,
      `esperado >=2 ocorrências (--no-gate isolado + gate/--no-gates), achou ${matches.length}`,
    );
  });

  it("o caminho `--no-gate` (early skip) escreve o sentinel antes de finalizar", () => {
    const marker = skill.indexOf("**Se `--no-gate`:** pular. Emitir `[AUTO] Etapa 3 auto-aprovada`");
    assert.ok(marker !== -1, "deve haver o branch --no-gate no Passo 2d");
    const around = skill.slice(marker, marker + 400);
    assert.match(around, /pipeline-sentinel\.ts write/);
    assert.match(around, /--step 3/);
  });

  it("o caminho `--no-gates` (dentro do gate apresentado) e o 'sim' orgânico escrevem o sentinel", () => {
    // Há 2 ocorrências de "--no-gates" no arquivo — a do gate do É IA? (Parte 1,
    // não relevante aqui) e a do gate de imagens (Parte 2, "### 2d."). Localizar
    // especificamente a de imagens pelo texto único desse branch.
    const marker = skill.indexOf('assumir "sim", finalizar direto');
    assert.ok(marker !== -1, "deve haver o branch --no-gates do gate de imagens (2d)");
    const around = skill.slice(marker, marker + 700);
    assert.match(around, /pipeline-sentinel\.ts write/);
    assert.match(around, /--step 3/);
  });

  // #12256: até aqui o teste PROIBIA 04-d2-2x1.jpg/04-d3-2x1.jpg nos
  // --outputs, alegando que os arquivos não existiam. Existem desde o #2133
  // (hero 2:1 de cada destaque, `d{N}_2x1` em 06-public-images.json) — a
  // proibição deixava o sentinel sem conferir o hero do D2/D3. E a lista
  // única citava 04-d3-4x5.jpg também em edição de 2 destaques (#2316), o
  // que faz o assertSentinel do Stage 4 reprovar uma edição válida.
  const COMMON = [
    "01-eia.md",
    "01-eia-A.jpg",
    "01-eia-B.jpg",
    "04-d1-2x1.jpg",
    "04-d1-4x5.jpg",
    "04-d2-2x1.jpg",
    "04-d2-4x5.jpg",
  ];
  const D3 = ["04-d3-2x1.jpg", "04-d3-4x5.jpg"];

  function sentinelOutputLists(text: string): string[][] {
    const re = /pipeline-sentinel\.ts write[^`]*?--step 3[^`]*?--outputs\s+"([^"]*)"/g;
    return [...text.matchAll(re)].map((m) => m[1].split(","));
  }

  /** Bloco ```bash que vem logo depois do marcador (o comando daquele caminho). */
  function bashBlockAfter(marker: string): string {
    const idx = skill.indexOf(marker);
    assert.ok(idx !== -1, `marcador ausente: ${marker}`);
    const start = skill.indexOf("```bash", idx);
    const end = skill.indexOf("```", start + 7);
    assert.ok(start !== -1 && end !== -1, `bloco bash ausente depois de: ${marker}`);
    return skill.slice(start, end);
  }

  const PATHS: Array<[string, string]> = [
    ["--no-gate", "**Se `--no-gate`:** pular. Emitir `[AUTO] Etapa 3 auto-aprovada`"],
    ["gate/--no-gates", "**Escrever sentinel de conclusão (#5793)**"],
  ];

  for (const [label, marker] of PATHS) {
    it(`caminho ${label}: variante de 3 destaques exige os 2:1 e 4:5 de d1/d2/d3 (#12256)`, () => {
      const lists = sentinelOutputLists(bashBlockAfter(marker));
      const three = lists.filter((l) => l.includes("04-d3-4x5.jpg"));
      assert.equal(three.length, 1, `esperada 1 variante com D3, achou ${three.length}`);
      assert.deepEqual([...three[0]].sort(), [...COMMON, ...D3].sort());
    });

    it(`caminho ${label}: variante de 2 destaques não cita nenhuma imagem do D3 (#12256, #2316)`, () => {
      const lists = sentinelOutputLists(bashBlockAfter(marker));
      assert.equal(lists.length, 2, `esperadas 2 variantes (3 e 2 destaques), achou ${lists.length}`);
      const two = lists.filter((l) => !l.some((f) => f.startsWith("04-d3-")));
      assert.equal(two.length, 1, `esperada 1 variante sem D3, achou ${two.length}`);
      assert.deepEqual([...two[0]].sort(), [...COMMON].sort());
    });
  }

  it("nenhuma variante exige o 1:1, que deixou de ser gerado (#12226)", () => {
    for (const list of sentinelOutputLists(skill)) {
      assert.ok(!list.some((f) => /-1x1\.jpg$/.test(f)), `1:1 nos outputs: ${list.join(",")}`);
    }
  });

  it("todo arquivo dos --outputs consta da seção ## Outputs", () => {
    const outputsIdx = skill.indexOf("## Outputs");
    assert.ok(outputsIdx !== -1);
    const outputsSection = skill.slice(outputsIdx, skill.indexOf("## Notas", outputsIdx));
    for (const file of [...COMMON, ...D3]) {
      assert.match(outputsSection, new RegExp(file.replace(/\./g, "\\.")), `Outputs deve listar ${file}`);
    }
  });

  it("a regra de escolha da variante cita destaqueCount do runner e o fallback em 01-approved-capped.json", () => {
    assert.match(skill, /destaqueCount/);
    assert.match(skill, /01-approved-capped\.json/);
  });

  it("assertSentinel aceita a variante de 2 destaques numa edição sem D3, e a de 3 reprovaria (#12256)", () => {
    const lists = sentinelOutputLists(bashBlockAfter(PATHS[1][1]));
    const two = lists.find((l) => !l.some((f) => f.startsWith("04-d3-")))!;
    const three = lists.find((l) => l.includes("04-d3-4x5.jpg"))!;
    const dir = mkdtempSync(join(tmpdir(), "sentinel-12256-"));
    try {
      for (const f of COMMON) writeFileSync(join(dir, f), "x");
      writeSentinel(dir, 3, two);
      assert.deepEqual(assertSentinel(dir, 3), { ok: true });
      writeSentinel(dir, 3, three);
      const r = assertSentinel(dir, 3);
      assert.ok(!r.ok && r.reason === "outputs_missing", `esperado outputs_missing: ${JSON.stringify(r)}`);
      assert.deepEqual([...r.missingOutputs].sort(), [...D3].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
