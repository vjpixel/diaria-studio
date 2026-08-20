/**
 * test/diaria-3-imagens-card-4x5-5822.test.ts (#5822)
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
 * Grep tests, mesmo padrão de `test/diaria-skill-sentinel-coverage.test.ts`
 * (#5793/#5792) e `test/orchestrator-stage-6-wiring.test.ts` (#4574): não
 * executa a skill de verdade (exigiria uma sessão Claude Code real) — só
 * confirma que os 2 comandos gate-blocking e o invariant check estão
 * presentes no texto do playbook, nos pontos certos (depois da geração
 * 2:1/1:1, antes do gate humano).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_3 = resolve(ROOT, ".claude/skills/diaria-3-imagens/SKILL.md");
const ORCHESTRATOR_STAGE_3 = resolve(ROOT, ".claude/agents/orchestrator-stage-3.md");

describe("diaria-3-imagens/SKILL.md cobre o card 4:5 (#5822)", () => {
  const skill = readFileSync(SKILL_3, "utf8");

  it("referencia a issue #5822", () => {
    assert.match(skill, /#5822/);
  });

  it("chama image-generate.ts --ratio 4x5 por destaque", () => {
    assert.match(skill, /image-generate\.ts[\s\S]*?--ratio 4x5/);
  });

  it("chama gen-social-card-4x5.ts com --edition-dir", () => {
    assert.match(skill, /gen-social-card-4x5\.ts\s+--edition-dir/);
  });

  it("o passo do card 4:5 (2c) vem depois da geração 2:1/1:1 (2b) e antes do gate (2d)", () => {
    const idx2b = skill.indexOf("### 2b. Gerar imagens");
    const idx2c = skill.indexOf("### 2c. Card 4:5 do feed");
    const idx2d = skill.indexOf("### 2d. Gate unificado de imagens");
    assert.ok(idx2b !== -1 && idx2c !== -1 && idx2d !== -1, "passos 2b, 2c e 2d devem existir");
    assert.ok(idx2b < idx2c && idx2c < idx2d, "ordem correta: 2b < 2c < 2d — card 4:5 nunca antes da geração base, nunca depois do gate");
  });

  it("marca a falha do card 4:5 como BLOQUEANTE, igual ao playbook do orchestrator", () => {
    const idx2c = skill.indexOf("### 2c. Card 4:5 do feed");
    assert.ok(idx2c !== -1);
    const block = skill.slice(idx2c, idx2c + 1400);
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
