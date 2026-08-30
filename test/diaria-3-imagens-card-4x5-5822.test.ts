/**
 * test/diaria-3-imagens-card-4x5-5822.test.ts (#5822, atualizado pelo #6740)
 *
 * `.claude/skills/diaria-3-imagens/SKILL.md` (fluxo STANDALONE, hoje usado
 * por `run-edition-stages.ts` no Passo 2 de `/diaria-edicao`, #5744/#5738)
 * gerava só as imagens 2:1/1:1 de destaque e parava — nunca chamava
 * `image-generate.ts --ratio 4x5` nem `gen-social-card-4x5.ts`, nem rodava
 * `check-invariants.ts --stage 3` no pre-gate. Sem esses 2 comandos o card
 * 4:5 com título embutido (`04-d{N}-4x5.jpg`, #4114) nunca existe, e
 * `selectSocialCardImageFile` cai no fallback 1:1 sem título **em silêncio**
 * — os posts de Facebook/Instagram saíam sem o título embutido.
 *
 * **#6740 mudou o mecanismo, não a garantia.** O passo 2b/2c em prosa própria
 * (que o #5822 tinha corrigido) era exatamente o tipo de duplicação que
 * divergiu de novo quando o #6005 Parte B acrescentou `gen-carousel-cards.ts`
 * só a `orchestrator-stage-3.md` — esta skill ficou defasada em silêncio e
 * nunca gerou o carrossel do Instagram (achado ao vivo #6740). O conserto foi
 * delegar ao mesmo runner determinístico (`scripts/stage-3-run.ts`) que
 * `orchestrator-stage-3.md` já usava, então os testes abaixo passaram a
 * verificar a DELEGAÇÃO em vez dos comandos individuais em prosa própria —
 * os comandos em si (incluindo `--ratio 4x5`, `gen-social-card-4x5.ts` e
 * `gen-carousel-cards.ts`) continuam garantidos, só que dentro do runner.
 *
 * Grep tests, mesmo padrão de `test/diaria-skill-sentinel-coverage.test.ts`
 * (#5793/#5792) e `test/orchestrator-stage-6-wiring.test.ts` (#4574): não
 * executa a skill de verdade (exigiria uma sessão Claude Code real) — só
 * confirma que a delegação e o invariant check estão presentes no texto do
 * playbook, nos pontos certos (depois do match de prompts, antes do gate
 * humano).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_3 = resolve(ROOT, ".claude/skills/diaria-3-imagens/SKILL.md");
const ORCHESTRATOR_STAGE_3 = resolve(ROOT, ".claude/agents/orchestrator-stage-3.md");
const STAGE_3_RUN = resolve(ROOT, "scripts/stage-3-run.ts");

describe("diaria-3-imagens/SKILL.md cobre o card 4:5 (#5822, delegação via #6740)", () => {
  const skill = readFileSync(SKILL_3, "utf8");
  const stage3Run = readFileSync(STAGE_3_RUN, "utf8");

  it("referencia a issue #5822 (histórico) e #6740 (delegação atual)", () => {
    assert.match(skill, /#5822/);
    assert.match(skill, /#6740/);
  });

  it("delega ao runner scripts/stage-3-run.ts em vez de reimplementar os comandos", () => {
    assert.match(skill, /npx tsx scripts\/stage-3-run\.ts --edition/);
  });

  it("o runner delegado (stage-3-run.ts) de fato chama image-generate.ts --ratio 4x5", () => {
    assert.match(stage3Run, /image-generate\.ts[\s\S]*?"--ratio",\s*"4x5"/);
  });

  it("o runner delegado (stage-3-run.ts) de fato chama gen-social-card-4x5.ts com --edition-dir", () => {
    assert.match(stage3Run, /gen-social-card-4x5\.ts[\s\S]{0,80}--edition-dir/);
  });

  it("o passo de delegação (2b) vem depois do match de prompts (2a-bis) e antes do gate (2d)", () => {
    const idx2aBis = skill.indexOf("### 2a-bis. Match prompts");
    const idx2b = skill.indexOf("### 2b. Runner determinístico");
    const idx2d = skill.indexOf("### 2d. Gate unificado de imagens");
    assert.ok(idx2aBis !== -1 && idx2b !== -1 && idx2d !== -1, "passos 2a-bis, 2b e 2d devem existir");
    assert.ok(idx2aBis < idx2b && idx2b < idx2d, "ordem correta: 2a-bis < 2b < 2d");
  });

  it("marca a falha do runner (imagem/card/carrossel) como BLOQUEANTE, igual ao playbook do orchestrator", () => {
    const idx2b = skill.indexOf("### 2b. Runner determinístico");
    assert.ok(idx2b !== -1);
    const idx2d = skill.indexOf("### 2d. Gate unificado de imagens");
    const block = skill.slice(idx2b, idx2d);
    assert.match(block, /BLOQUEANTE/);
  });

  it("roda check-invariants.ts --stage 3 antes de apresentar o gate 2d", () => {
    const idx2d = skill.indexOf("### 2d. Gate unificado de imagens");
    assert.ok(idx2d !== -1);
    const block = skill.slice(idx2d, idx2d + 600);
    assert.match(block, /check-invariants\.ts\s+--stage 3/);
    // o invariant check precisa aparecer ANTES do texto do gate em si
    const idxInvariant = block.indexOf("check-invariants.ts");
    const idxGateBanner = block.indexOf("Etapa 3 — Imagens prontas.");
    assert.ok(idxGateBanner === -1 || idxInvariant < idxGateBanner, "invariant check deve rodar antes do banner do gate");
  });

  it("os sentinels de conclusão (--no-gate e --no-gates/sim) incluem os 3 arquivos 04-d{N}-4x5.jpg", () => {
    const sentinelCalls = skill.match(/pipeline-sentinel\.ts write[\s\S]*?--outputs\s+"[^"]*"/g) ?? [];
    assert.ok(sentinelCalls.length >= 2, `esperado >=2 chamadas de sentinel write, achou ${sentinelCalls.length}`);
    for (const call of sentinelCalls) {
      for (const file of ["04-d1-4x5.jpg", "04-d2-4x5.jpg", "04-d3-4x5.jpg"]) {
        assert.match(call, new RegExp(file.replace(/\./g, "\\.")), `sentinel write deve incluir ${file}: ${call}`);
      }
    }
  });

  it("a seção ## Outputs documenta os arquivos 4:5 (nativo + card final)", () => {
    const outputsIdx = skill.indexOf("## Outputs");
    assert.ok(outputsIdx !== -1);
    const outputsSection = skill.slice(outputsIdx, outputsIdx + 1200);
    assert.match(outputsSection, /04-d1-4x5-nativo\.jpg/);
    assert.match(outputsSection, /04-d1-4x5\.jpg/);
    assert.match(outputsSection, /selectSocialCardImageFile/);
  });
});

describe("diaria-3-imagens/SKILL.md e orchestrator-stage-3.md concordam nos 2 comandos gate-blocking (#5822)", () => {
  const skill = readFileSync(SKILL_3, "utf8");
  const orchestrator = readFileSync(ORCHESTRATOR_STAGE_3, "utf8");

  it("orchestrator-stage-3.md (fonte da verdade) ainda documenta os 2 comandos — não regrediu", () => {
    assert.match(orchestrator, /image-generate\.ts[\s\S]*?--ratio 4x5/);
    assert.match(orchestrator, /gen-social-card-4x5\.ts\s+--edition-dir/);
  });

  it("os dois arquivos citam o mesmo script de composição do card", () => {
    assert.match(skill, /gen-social-card-4x5\.ts/);
    assert.match(orchestrator, /gen-social-card-4x5\.ts/);
  });
});
