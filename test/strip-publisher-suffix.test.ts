/**
 * strip-publisher-suffix.test.ts (#2140, extended #2664 + #2672)
 *
 * Testes de regressão para `stripPublisherSuffix`, `stripTrailingPeriod`
 * e `normalizeItemTitle`:
 *
 * # stripPublisherSuffix (#2140, #2664)
 *   - Pipe ` | `: G1, CNN Brasil (casos reais #2140)
 *   - Traço ` - `: Canaltech (caso real #2664)
 *   - Travessão ` — `: veículo conhecido
 *   - Anti-FP: "OpenAI lança GPT-5 - o maior modelo" NÃO strippado (#2664)
 *   - Anti-FP: prefixo curto (< MIN_PREFIX_LEN) → preservar original
 *   - Sem separador → inalterado
 *
 * # stripTrailingPeriod (#2672)
 *   - Ponto final único → strip (caso real: "...November 2025.")
 *   - `?`, `!`, `…`, `...` → preservar
 *   - Sem ponto → inalterado
 *
 * # normalizeItemTitle (#2664 + #2672)
 *   - Sufixo de veículo + ponto: chain completo
 *   - Caso real #2664: "...veja como - Canaltech" → strip sufixo
 *   - Caso real #2672: "...November 2025." → strip ponto
 *   - Ordem correta: sufixo ANTES do ponto (ex: "evento. - Canaltech" → "evento")
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripPublisherSuffix,
  stripTrailingPeriod,
  normalizeItemTitle,
  MIN_PREFIX_LEN,
  KNOWN_DASH_PUBLISHERS,
} from "../scripts/lib/strip-publisher-suffix.ts";

// ===========================================================================
// stripPublisherSuffix — pipe ` | ` (comportamento original #2140)
// ===========================================================================

describe("stripPublisherSuffix — pipe ` | ` (#2140)", () => {
  it("remove sufixo simples '| G1' (caso real #2140)", () => {
    assert.equal(
      stripPublisherSuffix(
        "Especialistas criticam modelo de regulamentação da IA no Brasil | G1",
      ),
      "Especialistas criticam modelo de regulamentação da IA no Brasil",
    );
  });

  it("remove múltiplos segmentos '| Blogs | CNN Brasil' (caso real #2140)", () => {
    assert.equal(
      stripPublisherSuffix(
        "Gigantes da IA terão IPOs bilionários, mas há quem tema uma nova bolha | Blogs | CNN Brasil",
      ),
      "Gigantes da IA terão IPOs bilionários, mas há quem tema uma nova bolha",
    );
  });

  it(`preserva título quando prefixo antes do ' | ' tem < ${MIN_PREFIX_LEN} chars`, () => {
    const input = "IA no Brasil | G1"; // prefixo "IA no Brasil" = 12 chars
    assert.equal(stripPublisherSuffix(input), input);
  });

  it(`preserva título quando prefixo tem exatamente ${MIN_PREFIX_LEN - 1} chars (< limite)`, () => {
    const prefix = "x".repeat(MIN_PREFIX_LEN - 1);
    const input = `${prefix} | Veículo`;
    assert.equal(stripPublisherSuffix(input), input);
  });

  it(`faz strip quando prefixo tem exatamente ${MIN_PREFIX_LEN} chars (= limite)`, () => {
    const prefix = "x".repeat(MIN_PREFIX_LEN);
    assert.equal(
      stripPublisherSuffix(`${prefix} | Veículo`),
      prefix,
    );
  });

  it("retorna título inalterado quando não há ' | '", () => {
    const input = "OpenAI lança novo modelo sem sufixo";
    assert.equal(stripPublisherSuffix(input), input);
  });

  it("retorna string vazia inalterada", () => {
    assert.equal(stripPublisherSuffix(""), "");
  });

  it("NÃO toca em pipe sem espaços (|SemEspaços|)", () => {
    const input = "Título|SemEspaços|Pipe";
    assert.equal(stripPublisherSuffix(input), input);
  });

  it("NÃO toca em pipe com espaço de um lado só", () => {
    const input = "Título |SemEspaçoDepois";
    assert.equal(stripPublisherSuffix(input), input);
  });

  it("C8: prefixo curto — retorna title original (sem strip de whitespace)", () => {
    const input = "  curto | G1  ";
    assert.equal(stripPublisherSuffix(input), input);
  });

  it("C8: sem ' | ' — retorna title original (sem normalizar whitespace)", () => {
    const input = "  Título sem pipe  ";
    assert.equal(stripPublisherSuffix(input), input);
  });

  it("remove espaços extras ao redor do prefixo", () => {
    assert.equal(
      stripPublisherSuffix("  Título com espaço extra   | Veículo  "),
      "Título com espaço extra",
    );
  });

  it("retorna só o prefixo antes do 1º ' | ', ignorando os subsequentes", () => {
    assert.equal(
      stripPublisherSuffix("Título longo suficiente | Seção A | Seção B | Veículo"),
      "Título longo suficiente",
    );
  });
});

// ===========================================================================
// stripPublisherSuffix — traço/travessão (#2664)
// ===========================================================================

describe("stripPublisherSuffix — traço ` - ` e travessão ` — ` (#2664)", () => {
  // Caso real da issue #2664
  it("CASO REAL #2664: remove ' - Canaltech' do título", () => {
    assert.equal(
      stripPublisherSuffix(
        "ChatGPT consegue fazer check-up do seu PC sem abrir nenhum arquivo; veja como - Canaltech",
      ),
      "ChatGPT consegue fazer check-up do seu PC sem abrir nenhum arquivo; veja como",
    );
  });

  it("remove sufixo via travessão ' — Veículo' quando veículo é conhecido", () => {
    assert.equal(
      stripPublisherSuffix("Google anuncia Gemini 2.5 Pro com melhorias significativas — TechCrunch"),
      "Google anuncia Gemini 2.5 Pro com melhorias significativas",
    );
  });

  it("remove ' - TechTudo' (veículo brasileiro conhecido)", () => {
    assert.equal(
      stripPublisherSuffix("Como usar o Copilot no Windows 11 passo a passo - TechTudo"),
      "Como usar o Copilot no Windows 11 passo a passo",
    );
  });

  // Anti-falso-positivo crítico: "OpenAI lança GPT-5 - o maior modelo" NÃO é veículo
  it("ANTI-FP: NÃO strip ' - o maior modelo' (não é veículo conhecido)", () => {
    const input = "OpenAI lança GPT-5 - o maior modelo";
    assert.equal(stripPublisherSuffix(input), input);
  });

  it("ANTI-FP: NÃO strip ' - uma análise técnica aprofundada' (frase, não veículo)", () => {
    const input = "Novos modelos de IA chegam em 2026 - uma análise técnica aprofundada";
    assert.equal(stripPublisherSuffix(input), input);
  });

  it("ANTI-FP: NÃO strip ' - Como funciona na prática' (chamada de reportagem)", () => {
    const input = "Meta Connect 2025 - Como funciona na prática";
    assert.equal(stripPublisherSuffix(input), input);
  });

  it("remove sufixo via ÚLTIMA ocorrência do traço ('título - sub - Canaltech')", () => {
    assert.equal(
      stripPublisherSuffix(
        "ChatGPT consegue fazer check-up do seu PC sem abrir nenhum arquivo - veja como - Canaltech",
      ),
      "ChatGPT consegue fazer check-up do seu PC sem abrir nenhum arquivo - veja como",
    );
  });

  it("preserva título quando prefixo antes do traço tem < MIN_PREFIX_LEN chars", () => {
    // Prefixo curto + veículo conhecido → NÃO strip (anti-FP de prefix curto)
    const input = "IA nova - G1"; // "IA nova" = 7 chars < 15
    assert.equal(stripPublisherSuffix(input), input);
  });

  it("KNOWN_DASH_PUBLISHERS contém Canaltech (minúsculo)", () => {
    assert.ok(KNOWN_DASH_PUBLISHERS.has("canaltech"));
  });

  it("match case-insensitive via lowercase do sufixo", () => {
    // Sufixo em maiúsculas — deve ser lowercased antes da lookup
    assert.equal(
      stripPublisherSuffix("Meta anuncia novo headset de realidade virtual - CANALTECH"),
      "Meta anuncia novo headset de realidade virtual",
    );
  });

  it("pipe + traço: strip pipe PRIMEIRO, depois traço", () => {
    // "Título | Seção - Canaltech" → strip pipe → "Título" (prefixo antes de " | ")
    // Note: pipe é mais amplo (strip tudo após 1º " | "), então "Título" não tem traço
    assert.equal(
      stripPublisherSuffix("Título suficientemente longo aqui | Seção - Canaltech"),
      "Título suficientemente longo aqui",
    );
  });
});

// ===========================================================================
// stripTrailingPeriod (#2672)
// ===========================================================================

describe("stripTrailingPeriod (#2672)", () => {
  // Caso real da issue #2672
  it("CASO REAL #2672: remove ponto final de título com número de versão", () => {
    assert.equal(
      stripTrailingPeriod(
        "AINews: OpenAI reports median internal Codex output tokens grew 56x since November 2025.",
      ),
      "AINews: OpenAI reports median internal Codex output tokens grew 56x since November 2025",
    );
  });

  it("remove ponto final de título simples", () => {
    assert.equal(
      stripTrailingPeriod("OpenAI lança novo modelo de linguagem."),
      "OpenAI lança novo modelo de linguagem",
    );
  });

  it("preserva '?' (pontuação intencional)", () => {
    const input = "Será que a IA vai tomar os empregos?";
    assert.equal(stripTrailingPeriod(input), input);
  });

  it("preserva '!' (pontuação intencional)", () => {
    const input = "Meta anuncia investimento bilionário!";
    assert.equal(stripTrailingPeriod(input), input);
  });

  it("preserva '…' (reticências unicode, intencional)", () => {
    const input = "OpenAI vai lançar modelo de raciocínio ainda mais poderoso…";
    assert.equal(stripTrailingPeriod(input), input);
  });

  it("preserva '...' (reticências ascii, intencional)", () => {
    const input = "O futuro da IA generativa...";
    assert.equal(stripTrailingPeriod(input), input);
  });

  it("preserva '..' (dois pontos — raro mas não é ponto único)", () => {
    const input = "Versão 2.0 lançada..";
    assert.equal(stripTrailingPeriod(input), input);
  });

  it("NÃO strip título sem ponto final", () => {
    const input = "Google anuncia novidades no I/O 2026";
    assert.equal(stripTrailingPeriod(input), input);
  });

  it("NÃO strip string vazia", () => {
    assert.equal(stripTrailingPeriod(""), "");
  });

  it("remove ponto final com espaços ao redor (trimEnd() aplicado)", () => {
    // O ponto é eliminado e o resultado é trimmed à direita
    assert.equal(
      stripTrailingPeriod("  OpenAI lança modelo.  "),
      "OpenAI lança modelo",
    );
  });

  // #2693 item 4 — whitespace asymmetry documentada (contrato pinado, não bug):
  // o ramo "sem ponto final" preserva leading/trailing whitespace do chamador
  // (mesma convenção de stripPipeSuffix/stripDashSuffix); o ramo "com ponto"
  // descarta AMBOS os lados (leading incluso) porque opera sobre `trimmed`.
  // Ver docstring de `stripTrailingPeriod` para o raciocínio completo.
  it("#2693 item 4: ASSIMETRIA — sem ponto final preserva leading whitespace...", () => {
    assert.equal(stripTrailingPeriod("  Hello  "), "  Hello  ");
  });

  it("#2693 item 4: ...mas com ponto final descarta leading whitespace também", () => {
    assert.equal(stripTrailingPeriod("  Hello.  "), "Hello");
  });
});

// ===========================================================================
// normalizeItemTitle — chain completo (#2664 + #2672)
// ===========================================================================

describe("normalizeItemTitle — chain completo (#2664 + #2672)", () => {
  it("CASO REAL #2664: strip sufixo Canaltech", () => {
    assert.equal(
      normalizeItemTitle(
        "ChatGPT consegue fazer check-up do seu PC sem abrir nenhum arquivo; veja como - Canaltech",
      ),
      "ChatGPT consegue fazer check-up do seu PC sem abrir nenhum arquivo; veja como",
    );
  });

  it("CASO REAL #2672: strip ponto final de título AINews", () => {
    assert.equal(
      normalizeItemTitle(
        "AINews: OpenAI reports median internal Codex output tokens grew 56x since November 2025.",
      ),
      "AINews: OpenAI reports median internal Codex output tokens grew 56x since November 2025",
    );
  });

  it("ordem correta: sufixo ANTES do ponto (título com ponto + sufixo Canaltech)", () => {
    // "evento. - Canaltech":
    //   1. stripPublisherSuffix → "evento."  (strip Canaltech)
    //   2. stripTrailingPeriod → "evento"    (strip ponto)
    assert.equal(
      normalizeItemTitle(
        "ChatGPT consegue fazer check-up do seu PC sem abrir nenhum arquivo; veja como. - Canaltech",
      ),
      "ChatGPT consegue fazer check-up do seu PC sem abrir nenhum arquivo; veja como",
    );
  });

  it("ANTI-FP: NÃO strip sufixo legítimo com traço no meio do título", () => {
    const input = "OpenAI lança GPT-5 - o maior modelo da história da IA";
    assert.equal(normalizeItemTitle(input), input);
  });

  it("preserva '?' e '!' (pontuação intencional) — não confunde com ponto", () => {
    const input = "Será que a IA vai tomar os empregos?";
    assert.equal(normalizeItemTitle(input), input);
  });

  it("preserva '…' (reticências) — não confunde com ponto", () => {
    const input = "O futuro da IA generativa…";
    assert.equal(normalizeItemTitle(input), input);
  });

  it("pipe + ponto: strip pipe ENTÃO ponto", () => {
    assert.equal(
      normalizeItemTitle(
        "Especialistas criticam modelo de regulamentação da IA no Brasil | G1.",
      ),
      "Especialistas criticam modelo de regulamentação da IA no Brasil",
    );
  });

  it("título limpo (sem sufixo, sem ponto) — retorna inalterado", () => {
    const input = "Google anuncia novidades no I/O 2026";
    assert.equal(normalizeItemTitle(input), input);
  });
});
