/**
 * test/check-highlight-themes.test.ts (#2073)
 *
 * Testa o script de detecção de repeat-de-tema em candidatos a destaque.
 *
 * Cenário real (#2073): Gemma 4 12B (260611, URL nova) vs destaque da 260604
 * ("Gemma 4 12B: multimodal que roda no laptop") a ~7 edições de distância.
 * Dedup não pega porque URL é inédita e janela Jaccard é 4 edições.
 *
 * Requisitos:
 *   - Cenário positivo: candidato com mesmo tema deve emitir warn.
 *   - Cenário negativo (falso positivo): mesma empresa em produtos/eventos
 *     diferentes NÃO deve casar só por entidade.
 *   - Candidato sem título não deve crashar.
 *   - Janela vazia (past_editions=[]) → sem warnings.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPastEditionTitles,
  checkHighlightThemes,
  DEFAULT_HIGHLIGHT_WINDOW,
  type PastEditionEntry,
  type HighlightThemeWarning,
} from "../scripts/check-highlight-themes.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** past-editions.md com 260604 incluindo destaque Gemma 4 12B */
const PAST_MD_WITH_GEMMA = `# Últimas edições publicadas — para dedup

---

## 2026-06-10 — "AI Act entra em vigor: o que muda para empresas brasileiras"
URL: https://diaria.beehiiv.com/p/ai-act

Links usados:
- https://ec.europa.eu/ai-act

---

## 2026-06-09 — "Mistral lança Le Chat Pro com ferramentas de agentes"
URL: https://diaria.beehiiv.com/p/mistral-lechat

Links usados:
- https://mistral.ai/le-chat-pro

---

## 2026-06-08 — "DeepSeek R2: raciocínio em cadeia 40% mais rápido"
URL: https://diaria.beehiiv.com/p/deepseek-r2

Links usados:
- https://deepseek.com/r2

---

## 2026-06-07 — "Sam Altman anuncia ferramenta de codegen autônomo"
URL: https://diaria.beehiiv.com/p/codegen

Links usados:
- https://openai.com/codegen

---

## 2026-06-06 — "Perplexity lança modo Deep Research para assinantes"
URL: https://diaria.beehiiv.com/p/perplexity

Links usados:
- https://perplexity.ai/deep-research

---

## 2026-06-05 — "Claude 4 Sonnet: 200k contexto e novo modo extended thinking"
URL: https://diaria.beehiiv.com/p/claude4

Links usados:
- https://anthropic.com/claude4

---

## 2026-06-04 — "Gemma 4 12B: multimodal que roda no laptop"
URL: https://diaria.beehiiv.com/p/gemma-4-12b

Links usados:
- https://blog.google/gemma-4

---

## 2026-06-03 — "Meta lança Llama 4 Scout com 1M de contexto"
URL: https://diaria.beehiiv.com/p/llama4

Links usados:
- https://meta.com/llama4

---
`;

/** past-editions.md sem Gemma — para testar janela vazia */
const PAST_MD_NO_GEMMA = `# Últimas edições publicadas — para dedup

---

## 2026-06-10 — "AI Act entra em vigor: o que muda para empresas brasileiras"
URL: https://diaria.beehiiv.com/p/ai-act

Links usados:
- https://ec.europa.eu/ai-act

---

## 2026-06-09 — "Mistral lança Le Chat Pro com ferramentas de agentes"
URL: https://diaria.beehiiv.com/p/mistral-lechat

Links usados:
- https://mistral.ai/le-chat-pro

---
`;

/**
 * Candidatos a destaque simulando 260611: Gemma 4 12B com URL nova.
 *
 * Candidatos #2 e #3 têm temas claramente diferentes dos títulos no fixture
 * PAST_MD_WITH_GEMMA para evitar falsos-positivos acidentais no teste.
 */
const GEMMA_CANDIDATES = [
  {
    rank: 1,
    title: "Gemma 4 12B: encoder-free multimodal",
    url: "https://deepmind.google/research/gemma-4-12b",
  },
  {
    rank: 2,
    title: "Tribunal brasileiro ordena exclusão de dados de modelo de IA",
    url: "https://tjsp.jus.br/ai-data-ruling",
  },
  {
    rank: 3,
    title: "Pesquisa mapeia impacto econômico da automação em 50 países",
    url: "https://oecd.org/automation-economic-impact-2026",
  },
];

// ---------------------------------------------------------------------------
// extractPastEditionTitles
// ---------------------------------------------------------------------------

describe("extractPastEditionTitles", () => {
  it("extrai títulos e datas das edições no formato correto", () => {
    const entries = extractPastEditionTitles(PAST_MD_WITH_GEMMA, 3);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].date, "2026-06-10");
    assert.equal(entries[0].title, "AI Act entra em vigor: o que muda para empresas brasileiras");
    assert.equal(entries[1].date, "2026-06-09");
    assert.equal(entries[2].date, "2026-06-08");
  });

  it("respeita a janela passada", () => {
    const entries = extractPastEditionTitles(PAST_MD_WITH_GEMMA, 1);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].date, "2026-06-10");
  });

  it("retorna array vazio para MD vazio", () => {
    const entries = extractPastEditionTitles("", 12);
    assert.equal(entries.length, 0);
  });

  it("retorna array vazio para MD só com header (sem seções)", () => {
    const headerOnly = "# Últimas edições publicadas — para dedup\n\n**atualizado em:** 2026-06-10\n";
    const entries = extractPastEditionTitles(headerOnly, 12);
    assert.equal(entries.length, 0);
  });

  it("extrai todos os 8 títulos do MD fixture com window=12", () => {
    const entries = extractPastEditionTitles(PAST_MD_WITH_GEMMA, 12);
    assert.equal(entries.length, 8);
    // Último deve ser Meta Llama4
    assert.equal(entries[7].date, "2026-06-03");
    assert.ok(entries[7].title.includes("Llama"));
  });
});

// ---------------------------------------------------------------------------
// checkHighlightThemes — cenário positivo (caso real #2073)
// ---------------------------------------------------------------------------

describe("checkHighlightThemes — cenário positivo (Gemma 4 12B)", () => {
  it("detecta repeat de tema: Gemma 4 12B com URL nova vs destaque da 260604", () => {
    const past = extractPastEditionTitles(PAST_MD_WITH_GEMMA, 12);
    const result = checkHighlightThemes(GEMMA_CANDIDATES, past);

    // Deve haver exatamente 1 warning — só o Gemma casa
    assert.equal(result.warnings.length, 1, `esperado 1 warning, got ${result.warnings.length}: ${JSON.stringify(result.warnings)}`);

    const w = result.warnings[0];
    assert.equal(w.candidate_rank, 1);
    assert.ok(w.candidate_title.includes("Gemma 4 12B"), `título candidato deve incluir "Gemma 4 12B": ${w.candidate_title}`);
    assert.equal(w.matched_edition, "2026-06-04");
    assert.ok(w.matched_title.includes("Gemma 4 12B"), `título matched deve incluir "Gemma 4 12B": ${w.matched_title}`);
    assert.ok(w.jaccard >= 0.25, `Jaccard deve ser >= 0.25, got ${w.jaccard}`);
  });

  it("candidatos #2 e #3 (OpenAI codegen, regulação BR) não acionam warn com o histórico", () => {
    const past = extractPastEditionTitles(PAST_MD_WITH_GEMMA, 12);
    const result = checkHighlightThemes(GEMMA_CANDIDATES, past);

    const warnedRanks = result.warnings.map((w) => w.candidate_rank);
    assert.ok(!warnedRanks.includes(2), `Candidato #2 não deveria gerar warn (ranks com warn: ${warnedRanks})`);
    assert.ok(!warnedRanks.includes(3), `Candidato #3 não deveria gerar warn (ranks com warn: ${warnedRanks})`);
  });

  it("campo checked reflete número de candidatos avaliados", () => {
    const past = extractPastEditionTitles(PAST_MD_WITH_GEMMA, 12);
    const result = checkHighlightThemes(GEMMA_CANDIDATES, past);
    assert.equal(result.checked, GEMMA_CANDIDATES.length);
  });

  it("campo window reflete número de edições passadas usadas", () => {
    const past = extractPastEditionTitles(PAST_MD_WITH_GEMMA, 12);
    const result = checkHighlightThemes(GEMMA_CANDIDATES, past);
    // MD tem 8 edições, window=12 → 8 entradas disponíveis
    assert.equal(result.window, 8);
  });
});

// ---------------------------------------------------------------------------
// checkHighlightThemes — cenário negativo (falso positivo)
// ---------------------------------------------------------------------------

describe("checkHighlightThemes — guard de falso positivo", () => {
  it("mesma empresa em evento diferente NÃO casa: 'Google lança Gemini X' vs 'Google demite 100'", () => {
    const candidates = [
      {
        rank: 1,
        title: "Google lança Gemini Ultra com capacidade multimodal avançada",
        url: "https://deepmind.google/gemini-ultra",
      },
    ];
    const past: PastEditionEntry[] = [
      { date: "2026-06-04", title: "Google demite 100 engenheiros de equipe de IA" },
    ];

    const result = checkHighlightThemes(candidates, past);
    assert.equal(result.warnings.length, 0, `não deveria gerar warn para eventos diferentes da mesma empresa: ${JSON.stringify(result.warnings)}`);
  });

  it("tema completamente diferente não gera warn mesmo com entidade compartilhada", () => {
    const candidates = [
      {
        rank: 1,
        title: "Mistral lança modelo Le Chat Pro para empresas",
        url: "https://mistral.ai/le-chat-pro-v2",
      },
    ];
    // Mesma empresa (Mistral), produto diferente
    const past: PastEditionEntry[] = [
      { date: "2026-06-09", title: "Mistral lança Le Chat Pro com ferramentas de agentes" },
    ];

    // Este SIM deve casar porque o tema é idêntico (mesmo produto)
    const result = checkHighlightThemes(candidates, past);
    assert.equal(result.warnings.length, 1, `deve detectar o repeat do Le Chat Pro: ${JSON.stringify(result.warnings)}`);
  });

  it("tema de regulação vs tema de produto não casa", () => {
    const candidates = [
      {
        rank: 1,
        title: "Novas regulações europeias para modelos de fundação",
        url: "https://ec.europa.eu/regulation-2026",
      },
    ];
    const past: PastEditionEntry[] = [
      { date: "2026-06-05", title: "Gemini Flash 3: o modelo mais rápido da Google" },
    ];

    const result = checkHighlightThemes(candidates, past);
    assert.equal(result.warnings.length, 0, `regulação EU vs Gemini não deveria casar: ${JSON.stringify(result.warnings)}`);
  });
});

// ---------------------------------------------------------------------------
// checkHighlightThemes — edge cases
// ---------------------------------------------------------------------------

describe("checkHighlightThemes — edge cases", () => {
  it("sem past editions → sem warnings", () => {
    const result = checkHighlightThemes(GEMMA_CANDIDATES, []);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.window, 0);
  });

  it("sem candidatos → sem warnings, checked=0", () => {
    const past = extractPastEditionTitles(PAST_MD_WITH_GEMMA, 12);
    const result = checkHighlightThemes([], past);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.checked, 0);
  });

  it("candidato com título vazio não crasha e não emite warn", () => {
    const candidates = [
      { rank: 1, title: "", url: "https://example.com/no-title" },
    ];
    const past: PastEditionEntry[] = [
      { date: "2026-06-04", title: "Gemma 4 12B: multimodal que roda no laptop" },
    ];

    let threw = false;
    let result;
    try {
      result = checkHighlightThemes(candidates, past);
    } catch {
      threw = true;
    }

    assert.equal(threw, false, "não deve lançar exceção com título vazio");
    assert.ok(result !== undefined);
    // Título vazio → tokenizeForJaccard retorna set vazio → Jaccard=0 → sem warn
    assert.equal(result!.warnings.length, 0);
  });

  it("Gemma NÃO detectado quando 260604 está fora de uma janela de 3 edições", () => {
    // Simula o bug original: janela pequena deixa 260604 fora
    const past = extractPastEditionTitles(PAST_MD_WITH_GEMMA, 3); // só as 3 mais recentes
    const gemma604Included = past.some((p) => p.date === "2026-06-04");
    assert.equal(gemma604Included, false, "260604 não deveria estar na janela de 3");

    const result = checkHighlightThemes(GEMMA_CANDIDATES, past);
    // Com janela 3, 260604 não está no histórico → sem warn (demonstra por que #2073 é necessário)
    assert.equal(result.warnings.length, 0, "janela de 3 não deve pegar 260604");
  });

  it("Gemma É detectado com janela de 12 edições (fix #2073)", () => {
    // Janela 12 pega 260604 → warn emitido
    const past = extractPastEditionTitles(PAST_MD_WITH_GEMMA, 12);
    const gemma604Included = past.some((p) => p.date === "2026-06-04");
    assert.equal(gemma604Included, true, "260604 deve estar na janela de 12");

    const result = checkHighlightThemes(GEMMA_CANDIDATES, past);
    assert.equal(result.warnings.length, 1, "janela de 12 deve detectar o repeat da 260604");
    assert.equal(result.warnings[0].matched_edition, "2026-06-04");
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_HIGHLIGHT_WINDOW
// ---------------------------------------------------------------------------

describe("DEFAULT_HIGHLIGHT_WINDOW", () => {
  it("é 12 (conforme spec #2073)", () => {
    assert.equal(DEFAULT_HIGHLIGHT_WINDOW, 12);
  });
});
