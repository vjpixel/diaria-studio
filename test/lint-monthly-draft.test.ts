/**
 * test/lint-monthly-draft.test.ts (#2794)
 *
 * Regressão do bug real do ciclo 2606-07: o writer-monthly emitiu os labels
 * de seção do draft mensal em TEXTO PLANO (`DESTAQUE 1 | BRASIL`, sem `**`)
 * em vez do formato esperado (`**DESTAQUE 1 | BRASIL**`). Sem o `**`,
 * `isSectionLabel`/`splitByLabels` (scripts/lib/mensal/monthly-render.ts) não
 * reconheciam NENHUM label — o draft inteiro caía no fallback
 * `renderParagraphs`, produzindo um email sem imagens e sem seções
 * estruturadas (falha 100% silenciosa: o pipeline seguia adiante sem avisar
 * ninguém).
 *
 * Este arquivo cobre as duas frentes de defesa adicionadas em #2794:
 *   1. `checkSectionIntegrity`/`checkImageRenderProbe` (scripts/lint-monthly-draft.ts)
 *      — o guardrail que NUNCA deve passar silencioso diante desse cenário.
 *   2. Efeito indireto de `isSectionLabel` agora tolerar labels sem negrito
 *      (scripts/lib/mensal/monthly-render.ts, coberto em detalhe em
 *      test/publish-monthly.test.ts) — aqui validamos que, GRAÇAS a essa
 *      tolerância, um draft real no formato do bug 2606-07 passa a ser
 *      corretamente reconhecido (seções + imagens), fechando o ciclo:
 *      causa raiz mitigada E guardrail funcional caso reapareça.
 *
 * Não coberto por teste (documentado no PR, #633 permite): a Frente 1 do fix
 * (instrução no agent prompt `.claude/agents/writer-monthly.md` +
 * `context/templates/newsletter-monthly.md` pra sempre emitir `**negrito**`)
 * não é testável automaticamente — é texto de prompt lido por um LLM.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkSectionIntegrity,
  checkImageRenderProbe,
  REQUIRED_SECTION_CHECKS,
} from "../scripts/lint-monthly-draft.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

/**
 * Reproduz o formato REAL do bug do ciclo 2606-07: todos os labels de seção
 * em texto plano, SEM `**`. Inclui também o sufixo "ASSUNTO (3 OPÇÕES)"
 * mencionado na issue como sintoma adicional observado naquele ciclo.
 */
function plainLabelDraft(): string {
  return [
    "ASSUNTO (3 OPÇÕES)",
    "1. Diar.ia | Junho 2026 — Brasil acelera regulação de IA",
    "2. Diar.ia | Junho 2026 — o mês em que os agentes decolaram",
    "3. Diar.ia | Junho 2026 — síntese do mês",
    "",
    "PREVIEW",
    "",
    "O mês em que o Brasil acelerou e os agentes decolaram.",
    "",
    "INTRO",
    "",
    "Junho foi marcado pela regulação brasileira de IA e pelo avanço de agentes autônomos.",
    "",
    "---",
    "",
    "DESTAQUE 1 | BRASIL",
    "",
    "Brasil acelera regulação de IA em junho",
    "",
    "No início do mês, o Congresso avançou o [marco regulatório de IA](https://example.com/marco).",
    "",
    "Duas semanas depois, o setor produtivo reagiu com [ajustes de compliance](https://example.com/compliance).",
    "",
    "O fio condutor:",
    "Junho consolidou o Brasil como protagonista regulatório na América Latina.",
    "",
    "---",
    "",
    "CLARICE — DIVULGAÇÃO",
    "",
    "Conheça a Clarice, a IA que revisa seu texto. Teste grátis: https://example.com/clarice",
    "",
    "---",
    "",
    "DESTAQUE 2 | INDÚSTRIA",
    "",
    "Agentes autônomos dominam o roadmap das grandes empresas",
    "",
    "No meio do mês, a Anthropic lançou [um agente que executa tarefas complexas](https://example.com/agente).",
    "",
    "Concorrentes responderam com anúncios próprios de [agentes multi-etapa](https://example.com/multi).",
    "",
    "O fio condutor:",
    "A corrida por agentes autônomos redefiniu a competição entre os grandes laboratórios.",
    "",
    "---",
    "",
    "CLARICE — TUTORIAL",
    "",
    "Aprenda a usar a Clarice para revisar textos longos em minutos.",
    "",
    "---",
    "",
    "DESTAQUE 3 | MERCADO",
    "",
    "Captações recordes marcam o trimestre",
    "",
    "No fim do mês, uma startup brasileira [captou uma rodada recorde](https://example.com/rodada).",
    "",
    "Investidores globais ampliaram aportes em [infraestrutura de IA](https://example.com/infra).",
    "",
    "O fio condutor:",
    "O capital seguiu fluindo para IA mesmo em meio à volatilidade macro.",
    "",
    "---",
    "",
    "É IA? — DESTAQUE DO MÊS",
    "",
    "Recap da edição de 12/06, cujo poll ficou em 48% de acerto.",
    "",
    "---",
    "",
    "USE MELHOR DO MÊS",
    "",
    "[Como usar prompts encadeados](https://example.com/tutorial1)",
    "",
    "Ensina a encadear prompts para tarefas complexas.",
    "",
    "---",
    "",
    "RADAR DO MÊS",
    "",
    "[Novo benchmark de raciocínio](https://example.com/radar1)",
    "",
    "Por que importa: mede capacidade de raciocínio em múltiplas etapas.",
    "",
    "---",
    "",
    "ENCERRAMENTO",
    "",
    "Quer sugerir um tema? Responda este e-mail. Assine em https://diaria.beehiiv.com/?utm_source=clarice",
  ].join("\n");
}

/** Mesmo conteúdo, mas com os labels no formato ESPERADO (`**...**`). */
function boldLabelDraft(): string {
  return plainLabelDraft().replace(
    /^(ASSUNTO \(3 OPÇÕES\)|PREVIEW|INTRO|DESTAQUE \d+ \| \S.*|CLARICE — \S.*|É IA\? — \S.*|USE MELHOR DO MÊS|RADAR DO MÊS|ENCERRAMENTO)$/gm,
    "**$1**",
  );
}

/** Draft genuinamente quebrado — nenhum label reconhecível, mesmo com a tolerância. */
function unrecognizableDraft(): string {
  return [
    "Este mês foi bastante movimentado para o setor de inteligência artificial.",
    "",
    "Várias empresas anunciaram novidades importantes ao longo das semanas.",
    "",
    "O Brasil também teve destaque com avanços regulatórios relevantes.",
  ].join("\n");
}

// ─── checkSectionIntegrity ──────────────────────────────────────────────────

describe("checkSectionIntegrity (#2794)", () => {
  it("draft com labels em NEGRITO (formato esperado): todas as seções reconhecidas", () => {
    const r = checkSectionIntegrity(boldLabelDraft());
    assert.equal(r.ok, true, `missing: ${r.missing.join(", ")}`);
    assert.equal(r.missing.length, 0);
    assert.ok(r.sectionCount >= REQUIRED_SECTION_CHECKS.length, `sectionCount=${r.sectionCount}`);
  });

  it("draft com labels em TEXTO PLANO (bug real 2606-07): defesa em profundidade reconhece todas as seções", () => {
    const r = checkSectionIntegrity(plainLabelDraft());
    assert.equal(r.ok, true, `missing: ${r.missing.join(", ")} (sectionCount=${r.sectionCount})`);
    assert.equal(r.missing.length, 0);
  });

  it("draft genuinamente quebrado (sem NENHUM label reconhecível): guardrail acusa faltando tudo, nunca passa silencioso", () => {
    const r = checkSectionIntegrity(unrecognizableDraft());
    assert.equal(r.ok, false);
    assert.ok(r.missing.length > 0, "deve listar os labels ausentes explicitamente");
    // O draft inteiro deve colapsar em 1 única "seção" (nenhuma fronteira encontrada).
    assert.equal(r.sectionCount, 1);
  });

  it("draft faltando só um DESTAQUE (ex: D2 ausente) é pego especificamente", () => {
    const withoutD2 = boldLabelDraft()
      .split("---")
      .filter((chunk) => !chunk.includes("**DESTAQUE 2"))
      .join("---");
    const r = checkSectionIntegrity(withoutD2);
    assert.equal(r.ok, false);
    assert.ok(r.missing.includes("DESTAQUE 2"), `missing deveria incluir DESTAQUE 2: ${r.missing.join(", ")}`);
    assert.ok(!r.missing.includes("DESTAQUE 1"), "DESTAQUE 1 não deveria estar faltando");
    assert.ok(!r.missing.includes("DESTAQUE 3"), "DESTAQUE 3 não deveria estar faltando");
  });
});

// ─── checkImageRenderProbe ──────────────────────────────────────────────────

describe("checkImageRenderProbe (#2794)", () => {
  it("draft com labels em negrito: render simulado produz 3 <img> (1 por destaque)", () => {
    const r = checkImageRenderProbe(boldLabelDraft(), "2606");
    assert.equal(r.ok, true, `imgCount=${r.imgCount}`);
    assert.ok(r.imgCount >= 3);
  });

  it("draft com labels em texto plano (bug real 2606-07): pós-fix, render simulado AINDA produz as 3 imagens", () => {
    const r = checkImageRenderProbe(plainLabelDraft(), "2606");
    assert.equal(r.ok, true, `imgCount=${r.imgCount}`);
    assert.ok(r.imgCount >= 3);
  });

  it("draft genuinamente quebrado: probe de imagem falha (0 <img> apesar de URLs fornecidas) — reproduz o sintoma real do bug", () => {
    const r = checkImageRenderProbe(unrecognizableDraft(), "2606");
    assert.equal(r.ok, false);
    assert.equal(r.imgCount, 0, "sem nenhum label DESTAQUE reconhecido, renderDestaque nunca roda — 0 imagens, exatamente o sintoma reportado em 2606-07");
  });
});
