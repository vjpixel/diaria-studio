/**
 * test/check-highlight-themes.test.ts (#2073, #2652)
 *
 * Testa o script de detecção de repeat-de-tema em candidatos a destaque
 * e em itens secundários (RADAR/LANÇAMENTOS).
 *
 * Cenário real (#2073): Gemma 4 12B (260611, URL nova) vs destaque da 260604
 * ("Gemma 4 12B: multimodal que roda no laptop") a ~7 edições de distância.
 * Dedup não pega porque URL é inédita e janela Jaccard é 4 edições.
 *
 * Cenário real (#2652): Nubank×contratações — 260629 "não vai parar de contratar
 * pessoas por causa da IA" vs 260626 "prioriza mentalidade de IA nas contratações".
 * Dedup não pega: URL/publisher diferentes, Jaccard abaixo do threshold.
 *
 * Requisitos:
 *   - Cenário positivo (highlights): candidato com mesmo tema deve emitir warn.
 *   - Cenário positivo (secundário): caso Nubank DEVE disparar a flag.
 *   - Cenários negativos: empresas/temas distintos NÃO devem disparar.
 *   - Warn-only: checkSecondaryThemes NUNCA bloqueia (só sinaliza, exit 0).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  extractPastEditionTitles,
  checkHighlightThemes,
  checkSecondaryThemes,
  extractSecondaryItems,
  readPastApprovedSecondary,
  isoDateToAammdd,
  DEFAULT_HIGHLIGHT_WINDOW,
  DEFAULT_SECONDARY_WINDOW,
  DEFAULT_SECONDARY_BUCKETS,
  type PastEditionEntry,
  type HighlightThemeWarning,
  type SecondaryItem,
  type PastSecondaryItem,
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
    // #2684 item 3: matched_edition padronizado em AAMMDD (antes YYYY-MM-DD).
    assert.equal(w.matched_edition, "260604");
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
    // #2684 item 3: matched_edition padronizado em AAMMDD (antes YYYY-MM-DD).
    assert.equal(result.warnings[0].matched_edition, "260604");
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

// ---------------------------------------------------------------------------
// Regressões #2103
// ---------------------------------------------------------------------------

describe("extractPastEditionTitles — título com aspas internas (#2103)", () => {
  it("título com aspas duplas internas não é truncado no primeiro par", () => {
    // Antes do fix: sectionRe=[^"]+ parava em "melhor" e capturava apenas 'O modelo '
    const md = `
## 2026-06-10 — "O modelo "melhor" do mercado chegou"
URL: https://diaria.beehiiv.com/p/modelo-melhor

Links usados:
- https://example.com/melhor
`;
    const entries = extractPastEditionTitles(md, 12);
    assert.equal(entries.length, 1);
    // Após fix: captura até a ÚLTIMA aspas da linha
    assert.equal(
      entries[0].title,
      `O modelo "melhor" do mercado chegou`,
      `título com aspas internas deve ser capturado inteiro: ${entries[0].title}`,
    );
  });

  it("título com aspas internas: extração completa garante tokenização correta", () => {
    // Garante que o bug de truncamento não produz tokenização incompleta do título passado.
    // Antes do fix: "O modelo 'melhor'" era truncado → "O modelo " → tokens={modelo}
    // Após o fix: título completo capturado → tokens incluem termos do final do título
    const mdWithQuotedTitle = `
## 2026-06-04 — "O "melhor" modelo multimodal: Gemma 4 12B"
URL: https://diaria.beehiiv.com/p/gemma

Links usados:
- https://example.com/gemma
`;
    const past = extractPastEditionTitles(mdWithQuotedTitle, 12);
    assert.equal(past.length, 1, "deve extrair 1 entrada");
    // Após fix: título completo, não truncado
    assert.ok(
      past[0].title.includes("Gemma 4 12B"),
      `título deve incluir 'Gemma 4 12B' (sem truncamento): "${past[0].title}"`,
    );
    assert.ok(
      past[0].title.includes("multimodal"),
      `título deve incluir 'multimodal' (parte após aspas internas): "${past[0].title}"`,
    );

    // Com o título completo, candidato de tema idêntico (sem aspas internas)
    // deve casar via Jaccard — tokens como "multimodal" agora estão disponíveis
    const candidates = [
      {
        rank: 1,
        title: "Gemma 4 12B: encoder-free multimodal",
        url: "https://deepmind.google/gemma",
      },
    ];
    const result = checkHighlightThemes(candidates, past);
    // Com título completo: pastTokens={modelo,melhor,multimodal,gemma,12b}
    // candidateTokens={gemma,12b,encoder,free,multimodal}
    // shared={gemma,12b,multimodal} → Jaccard=3/7≈0.43 → acima de 0.35 → warn
    assert.equal(
      result.warnings.length,
      1,
      `deve detectar repeat com título completo (não truncado): ${JSON.stringify(result.warnings)}`,
    );
  });

  it("título SEM aspas internas continua funcionando normalmente", () => {
    const entries = extractPastEditionTitles(PAST_MD_WITH_GEMMA, 12);
    assert.equal(entries.length, 8, "deve extrair 8 entradas do fixture padrão");
    // Spot check: sem truncamento nos títulos normais
    assert.equal(entries[6].title, "Gemma 4 12B: multimodal que roda no laptop");
  });
});

// ---------------------------------------------------------------------------
// Regressão #2124 — item 5: tolerância CRLF em extractPastEditionTitles
// ---------------------------------------------------------------------------

describe("extractPastEditionTitles — tolerância CRLF (#2124)", () => {
  it("extrai títulos de arquivo com quebra CRLF (\\r\\n)", () => {
    // Simula past-editions.md com CRLF (ex: checkout no Windows com core.autocrlf=true)
    const crlfMd = [
      "# Últimas edições publicadas — para dedup",
      "",
      "---",
      "",
      `## 2026-06-10 — "AI Act entra em vigor: o que muda para empresas brasileiras"`,
      "URL: https://diaria.beehiiv.com/p/ai-act",
      "",
      "Links usados:",
      "- https://ec.europa.eu/ai-act",
      "",
      "---",
      "",
      `## 2026-06-09 — "Gemma 4 12B: multimodal que roda no laptop"`,
      "URL: https://diaria.beehiiv.com/p/gemma",
      "",
      "Links usados:",
      "- https://blog.google/gemma",
      "",
      "---",
    ].join("\r\n"); // CRLF

    const entries = extractPastEditionTitles(crlfMd, 12);
    assert.equal(entries.length, 2, `deve extrair 2 entradas do MD com CRLF, got ${entries.length}`);
    assert.equal(entries[0].date, "2026-06-10");
    assert.equal(
      entries[0].title,
      "AI Act entra em vigor: o que muda para empresas brasileiras",
      `título não deve conter \\r residual: "${entries[0].title}"`,
    );
    assert.equal(entries[1].date, "2026-06-09");
    assert.equal(
      entries[1].title,
      "Gemma 4 12B: multimodal que roda no laptop",
      `2º título com CRLF: "${entries[1].title}"`,
    );
  });

  it("arquivo com LF puro continua funcionando após a mudança CRLF (#2124)", () => {
    // Garante que a adição de \\r? não quebra o comportamento LF normal
    const entries = extractPastEditionTitles(PAST_MD_WITH_GEMMA, 12);
    assert.equal(entries.length, 8, "LF puro: deve extrair 8 entradas");
    assert.equal(entries[0].title, "AI Act entra em vigor: o que muda para empresas brasileiras");
    assert.ok(!entries[0].title.includes("\r"), "título LF não deve ter \\r");
  });
});

// ---------------------------------------------------------------------------
// checkSecondaryThemes — caso real Nubank (#2652)
//
// Regressão obrigatória (#633): 260629 "não vai parar de contratar pessoas por
// causa da IA" × 260626 "prioriza mentalidade de IA nas contratações".
// Empresa em comum: Nubank (posição 0 em ambos os títulos).
// Sub-tema em comum: raiz "contra" (contratar / contratações) — capturado por
// prefix overlap de 6 chars, pois Jaccard puro fica abaixo do threshold.
// ---------------------------------------------------------------------------

// Fixtures do caso real Nubank (#2652)
const NUBANK_CURRENT_ITEMS: SecondaryItem[] = [
  {
    bucket: "radar",
    title: "Nubank não vai parar de contratar pessoas por causa da IA",
    url: "https://tecnoblog.net/noticias/nubank-nao-vai-parar-de-contratar-por-causa-da-ia/",
  },
  {
    bucket: "radar",
    title: "Banco Central divulga regulação para stablecoins brasileiras",
    url: "https://bcb.gov.br/stablecoins-regulacao-2026",
  },
];

const NUBANK_PAST_ITEMS: PastSecondaryItem[] = [
  // 260626: a edição anterior com o item sobre Nubank+contratações
  {
    edition: "260626",
    title: "Nubank prioriza mentalidade de IA nas contratações",
    bucket: "radar",
  },
  // Uma edição ainda mais antiga — tema completamente diferente
  {
    edition: "260620",
    title: "Stripe lança programa de aceleração para fintechs brasileiras",
    bucket: "lancamento",
  },
];

describe("checkSecondaryThemes — caso real Nubank 260626 × 260629 (#2652)", () => {
  it("detecta repeat de tema: Nubank+contratações via prefix 'contra' (contratar/contratações)", () => {
    const result = checkSecondaryThemes(NUBANK_CURRENT_ITEMS, NUBANK_PAST_ITEMS);

    // Deve haver exatamente 1 warning — só o Nubank+contratações casa
    assert.equal(
      result.secondary_warnings.length,
      1,
      `esperado 1 warning, got ${result.secondary_warnings.length}: ${JSON.stringify(result.secondary_warnings)}`,
    );

    const w = result.secondary_warnings[0];
    assert.equal(w.bucket, "radar", "bucket deve ser radar");
    assert.ok(
      w.item_title.includes("Nubank"),
      `item_title deve incluir "Nubank": ${w.item_title}`,
    );
    assert.ok(
      w.item_title.includes("contratar"),
      `item_title deve incluir "contratar": ${w.item_title}`,
    );
    assert.equal(w.matched_edition, "260626", "deve casar com a edição 260626");
    assert.ok(
      w.matched_title.includes("Nubank"),
      `matched_title deve incluir "Nubank": ${w.matched_title}`,
    );
    assert.ok(
      w.matched_title.includes("contrata"),
      `matched_title deve incluir "contrata": ${w.matched_title}`,
    );
    assert.ok(
      w.shared_entities.includes("nubank"),
      `shared_entities deve conter "nubank": ${JSON.stringify(w.shared_entities)}`,
    );
    assert.ok(
      w.theme_evidence.startsWith("prefix:"),
      `theme_evidence deve indicar match por prefixo (o Jaccard puro fica abaixo do threshold): "${w.theme_evidence}"`,
    );
  });

  it("Banco Central (sem relação com Nubank+contratações) NÃO gera warning", () => {
    const result = checkSecondaryThemes(NUBANK_CURRENT_ITEMS, NUBANK_PAST_ITEMS);
    const warnedTitles = result.secondary_warnings.map((w) => w.item_title);
    assert.ok(
      !warnedTitles.some((t) => t.includes("Banco Central")),
      `Banco Central não deveria gerar warn (títulos com warn: ${JSON.stringify(warnedTitles)})`,
    );
  });

  it("campo secondary_checked reflete número de itens avaliados", () => {
    const result = checkSecondaryThemes(NUBANK_CURRENT_ITEMS, NUBANK_PAST_ITEMS);
    assert.equal(result.secondary_checked, NUBANK_CURRENT_ITEMS.length);
  });

  it("#2684 item 4: secondary_editions_with_data reflete número de edições distintas no histórico (renomeado de secondary_window)", () => {
    const result = checkSecondaryThemes(NUBANK_CURRENT_ITEMS, NUBANK_PAST_ITEMS);
    // NUBANK_PAST_ITEMS tem 2 edições distintas: 260626 e 260620
    assert.equal(result.secondary_editions_with_data, 2);
  });

  it("#2684 item 4: secondary_window_requested reporta a janela nominal passada (default DEFAULT_SECONDARY_WINDOW)", () => {
    const resultDefault = checkSecondaryThemes(NUBANK_CURRENT_ITEMS, NUBANK_PAST_ITEMS);
    assert.equal(resultDefault.secondary_window_requested, 10);

    const resultCustom = checkSecondaryThemes(NUBANK_CURRENT_ITEMS, NUBANK_PAST_ITEMS, 5);
    assert.equal(resultCustom.secondary_window_requested, 5);
    // secondary_editions_with_data não muda — reflete pastItems, não o requestedWindow.
    assert.equal(resultCustom.secondary_editions_with_data, 2);
  });
});

// ---------------------------------------------------------------------------
// checkSecondaryThemes — casos NEGATIVOS (falso positivo guard)
// ---------------------------------------------------------------------------

describe("checkSecondaryThemes — guard de falso positivo (#2652)", () => {
  it("empresas distintas (OpenAI vs Apple) → sem warning mesmo com tema similar", () => {
    const current: SecondaryItem[] = [
      {
        bucket: "radar",
        title: "OpenAI anuncia novo programa de parcerias com universidades",
        url: "https://openai.com/partnerships-universities",
      },
    ];
    const past: PastSecondaryItem[] = [
      {
        edition: "260620",
        title: "Apple lança programa de parceria para desenvolvedores independentes",
        bucket: "radar",
      },
    ];

    const result = checkSecondaryThemes(current, past);
    assert.equal(
      result.secondary_warnings.length,
      0,
      `empresas distintas não devem casar: ${JSON.stringify(result.secondary_warnings)}`,
    );
  });

  it("mesma empresa (Nubank) mas tópicos completamente diferentes → sem warning", () => {
    // Nubank+crédito vs Nubank+contratações: empresa em comum mas sub-temas distintos
    const current: SecondaryItem[] = [
      {
        bucket: "radar",
        title: "Nubank lança cartão de crédito com cashback em criptomoedas",
        url: "https://tecnoblog.net/nubank-cartao-cripto",
      },
    ];
    const past: PastSecondaryItem[] = [
      {
        edition: "260626",
        title: "Nubank não vai parar de contratar pessoas por causa da IA",
        bucket: "radar",
      },
    ];

    const result = checkSecondaryThemes(current, past);
    assert.equal(
      result.secondary_warnings.length,
      0,
      `mesma empresa mas tópicos distintos não deve gerar warning: ${JSON.stringify(result.secondary_warnings)}`,
    );
  });

  it("mesmo tema (contratações) mas empresa diferente → sem warning", () => {
    // "Itaú contrata" vs "Nubank prioriza contratações" — sub-tema semelhante mas empresa diferente
    const current: SecondaryItem[] = [
      {
        bucket: "radar",
        title: "Itaú abre 800 vagas para engenheiros de software e IA",
        url: "https://itau.com.br/vagas-engenharia-2026",
      },
    ];
    const past: PastSecondaryItem[] = [
      {
        edition: "260626",
        title: "Nubank prioriza mentalidade de IA nas contratações",
        bucket: "radar",
      },
    ];

    // "Itaú" e "Nubank" são entidades distintas → sem entity overlap → sem warning
    const result = checkSecondaryThemes(current, past);
    assert.equal(
      result.secondary_warnings.length,
      0,
      `empresa diferente não deve casar mesmo com tema similar: ${JSON.stringify(result.secondary_warnings)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// checkSecondaryThemes — via Jaccard (empresas+tema com sobreposição lexical direta)
// ---------------------------------------------------------------------------

describe("checkSecondaryThemes — detecção via Jaccard direto (#2652)", () => {
  it("mesma empresa + sobreposição lexical direta → warning via Jaccard", () => {
    // "demite" / "demissão" / "demitir" — palavras completamente distintas (não compartilham
    // prefixo de 6 chars). Mas "Nubank demite" + "Nubank demissão" têm Jaccard > 0.15 se
    // compartilham tokens como "funcionarios" diretamente.
    const current: SecondaryItem[] = [
      {
        bucket: "radar",
        title: "Nubank anuncia demissão de 200 funcionários na área de TI",
        url: "https://tecnoblog.net/nubank-demissoes-2026",
      },
    ];
    const past: PastSecondaryItem[] = [
      {
        edition: "260620",
        title: "Nubank demite 150 funcionários em reestruturação de equipes",
        bucket: "radar",
      },
    ];

    // Entity: {nubank}, tokens comuns: {nubank, funcionarios}
    // Jaccard = 2/N > 0.15 → match via Jaccard
    const result = checkSecondaryThemes(current, past);
    assert.equal(
      result.secondary_warnings.length,
      1,
      `mesma empresa + funcionarios em ambos deve gerar warning via Jaccard: ${JSON.stringify(result.secondary_warnings)}`,
    );
    const w = result.secondary_warnings[0];
    assert.ok(
      w.theme_evidence.startsWith("jaccard:"),
      `deve indicar match via jaccard: "${w.theme_evidence}"`,
    );
    assert.ok(
      w.shared_entities.includes("nubank"),
      `shared_entities deve conter "nubank"`,
    );
  });
});

// ---------------------------------------------------------------------------
// checkSecondaryThemes — best-match selection (#2652 regressão do rounding)
//
// Quando um item corrente casa com VÁRIOS itens passados, reportar o de maior
// Jaccard. Regressão do bug onde a comparação usava `jaccard > bestWarning.jaccard`
// (campo arredondado) em vez do raw — um match marginalmente melhor podia ser
// descartado se o anterior arredondou pra cima.
// ---------------------------------------------------------------------------

describe("checkSecondaryThemes — best-match selection multi-match (#2652)", () => {
  it("entre vários matches, reporta o de maior Jaccard (1 warning por item)", () => {
    const current: SecondaryItem[] = [
      {
        bucket: "radar",
        title: "Nubank anuncia demissão de 200 funcionários na área de tecnologia",
        url: "https://example.com/atual",
      },
    ];
    // Past WEAK: compartilha nubank + funcionarios apenas.
    // Past STRONG: quase idêntico ao atual → Jaccard maior.
    const past: PastSecondaryItem[] = [
      {
        edition: "260610",
        title: "Nubank demite funcionários em reestruturação",
        bucket: "radar",
      },
      {
        edition: "260625",
        title: "Nubank anuncia demissão de 200 funcionários na área de tecnologia financeira",
        bucket: "radar",
      },
    ];

    const result = checkSecondaryThemes(current, past);
    assert.equal(result.secondary_warnings.length, 1, "1 warning por item corrente (best-match)");
    assert.equal(
      result.secondary_warnings[0].matched_edition,
      "260625",
      `deve reportar o match de maior Jaccard (260625), não o mais fraco: ${JSON.stringify(result.secondary_warnings[0])}`,
    );
  });
});

// ---------------------------------------------------------------------------
// checkSecondaryThemes — edge cases (#2652)
// ---------------------------------------------------------------------------

describe("checkSecondaryThemes — edge cases (#2652)", () => {
  it("sem itens secundários → sem warnings, secondary_checked=0", () => {
    const result = checkSecondaryThemes([], NUBANK_PAST_ITEMS);
    assert.equal(result.secondary_warnings.length, 0);
    assert.equal(result.secondary_checked, 0);
  });

  it("sem histórico → sem warnings, secondary_editions_with_data=0", () => {
    const result = checkSecondaryThemes(NUBANK_CURRENT_ITEMS, []);
    assert.equal(result.secondary_warnings.length, 0);
    assert.equal(result.secondary_editions_with_data, 0);
  });

  it("item com título vazio não crasha e não emite warning", () => {
    const current: SecondaryItem[] = [
      { bucket: "radar", title: "", url: "https://example.com/no-title" },
    ];

    let threw = false;
    let result;
    try {
      result = checkSecondaryThemes(current, NUBANK_PAST_ITEMS);
    } catch {
      threw = true;
    }

    assert.equal(threw, false, "não deve lançar exceção com título vazio");
    assert.ok(result !== undefined);
    assert.equal(result!.secondary_warnings.length, 0, "título vazio não deve gerar warning");
  });

  it("warn-only: checkSecondaryThemes nunca lança exceção mesmo com inputs degenerados", () => {
    // Inputs degenerados: títulos sem tokens significativos + histórico com entrada inválida
    const current: SecondaryItem[] = [
      { bucket: "radar", title: "a b c", url: "https://example.com" },  // tokens < 3 chars
    ];
    const past: PastSecondaryItem[] = [
      { edition: "260601", title: "x y z", bucket: "radar" },
    ];

    let threw = false;
    try {
      checkSecondaryThemes(current, past);
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "nunca deve lançar exceção — warn-only");
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_SECONDARY_WINDOW
// ---------------------------------------------------------------------------

describe("DEFAULT_SECONDARY_WINDOW", () => {
  it("é 10 (conforme spec #2652: janela 7–12 edições)", () => {
    assert.equal(DEFAULT_SECONDARY_WINDOW, 10);
    // Deve ser maior que a janela de dedup (3-4 edições) — razão de existir do check
    assert.ok(DEFAULT_SECONDARY_WINDOW > 4, "janela secundária deve ser maior que dedup");
  });
});

// ---------------------------------------------------------------------------
// #2684 — findings do self-review do PR #2682 (#2652)
// ---------------------------------------------------------------------------

function makeTempEditionsDir(): string {
  return mkdtempSync(join(tmpdir(), "check-highlight-themes-"));
}

function writeCategorized(dir: string, data: unknown): string {
  const path = resolve(dir, "01-categorized.json");
  writeFileSync(path, JSON.stringify(data), "utf8");
  return path;
}

describe("isoDateToAammdd (#2684 item 3)", () => {
  it("converte YYYY-MM-DD para AAMMDD", () => {
    assert.equal(isoDateToAammdd("2026-06-04"), "260604");
    assert.equal(isoDateToAammdd("2026-12-31"), "261231");
  });

  it("retorna a entrada inalterada se não bater o formato YYYY-MM-DD", () => {
    assert.equal(isoDateToAammdd("260604"), "260604");
    assert.equal(isoDateToAammdd("not-a-date"), "not-a-date");
  });
});

describe("DEFAULT_SECONDARY_BUCKETS (#2684 item 2)", () => {
  it("inclui os 4 buckets secundários (radar, lancamento, use_melhor, video)", () => {
    assert.deepEqual(
      [...DEFAULT_SECONDARY_BUCKETS].sort(),
      ["lancamento", "radar", "use_melhor", "video"].sort(),
    );
  });
});

describe("extractSecondaryItems — cobertura de buckets (#2684 item 2)", () => {
  it("por default, extrai itens de use_melhor e video também (não só radar/lancamento)", () => {
    const dir = makeTempEditionsDir();
    try {
      const path = writeCategorized(dir, {
        radar: [{ title: "Item radar", url: "https://example.com/radar" }],
        lancamento: [{ title: "Item lancamento", url: "https://example.com/lancamento" }],
        use_melhor: [{ title: "Item use_melhor", url: "https://example.com/use-melhor" }],
        video: [{ title: "Item video", url: "https://example.com/video" }],
      });
      const items = extractSecondaryItems(path);
      const buckets = items.map((i) => i.bucket).sort();
      assert.deepEqual(buckets, ["lancamento", "radar", "use_melhor", "video"].sort());
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("respeita buckets explícitos passados pelo caller (compat)", () => {
    const dir = makeTempEditionsDir();
    try {
      const path = writeCategorized(dir, {
        radar: [{ title: "Item radar", url: "https://example.com/radar" }],
        use_melhor: [{ title: "Item use_melhor", url: "https://example.com/use-melhor" }],
      });
      const items = extractSecondaryItems(path, ["radar"]);
      assert.equal(items.length, 1);
      assert.equal(items[0].bucket, "radar");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("extractSecondaryItems — dedup cross-bucket highlight↔secundário (#2684 item 5)", () => {
  it("exclui item de bucket secundário cuja URL já está em highlights (pré-gate)", () => {
    const dir = makeTempEditionsDir();
    try {
      // finalize-stage1.ts mantém o artigo no bucket de origem MESMO quando
      // escolhido como highlight (só isenta do filtro de score/domain-cap) —
      // caso real que este teste reproduz.
      const path = writeCategorized(dir, {
        highlights: [
          { rank: 1, url: "https://example.com/nubank-contratacao", title: "Nubank contrata mais" },
        ],
        radar: [
          { title: "Nubank contrata mais", url: "https://example.com/nubank-contratacao" },
          { title: "Outro item qualquer", url: "https://example.com/outro" },
        ],
      });
      const items = extractSecondaryItems(path);
      assert.equal(items.length, 1, "artigo já em highlights não deve duplicar no bucket secundário");
      assert.equal(items[0].url, "https://example.com/outro");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("dedup funciona com URL canonicalizada (UTM/trailing-slash não escapam)", () => {
    const dir = makeTempEditionsDir();
    try {
      const path = writeCategorized(dir, {
        highlights: [
          { rank: 1, url: "https://example.com/artigo", title: "Artigo X" },
        ],
        radar: [
          { title: "Artigo X", url: "https://example.com/artigo/?utm_source=x" },
        ],
      });
      const items = extractSecondaryItems(path);
      assert.equal(items.length, 0, "variante com UTM da mesma URL de highlight deve ser excluída");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("sem highlights no categorized.json, comportamento é inalterado", () => {
    const dir = makeTempEditionsDir();
    try {
      const path = writeCategorized(dir, {
        radar: [{ title: "Item radar", url: "https://example.com/radar" }],
      });
      const items = extractSecondaryItems(path);
      assert.equal(items.length, 1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("extractSecondaryItems — guard de resume p/ formato antigo/corrompido (#2684 item 6)", () => {
  it("root do JSON não é objeto (array) → retorna [] sem lançar", () => {
    const dir = makeTempEditionsDir();
    try {
      const path = writeCategorized(dir, ["not", "an", "object"]);
      assert.deepEqual(extractSecondaryItems(path), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("root do JSON é null → retorna [] sem lançar", () => {
    const dir = makeTempEditionsDir();
    try {
      const path = writeCategorized(dir, null);
      assert.deepEqual(extractSecondaryItems(path), []);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("item null dentro de um bucket é ignorado sem lançar TypeError", () => {
    const dir = makeTempEditionsDir();
    try {
      const path = writeCategorized(dir, {
        radar: [null, { title: "Item válido", url: "https://example.com/x" }],
      });
      const items = extractSecondaryItems(path);
      assert.equal(items.length, 1);
      assert.equal(items[0].title, "Item válido");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("readPastApprovedSecondary — guard de resume p/ formato antigo/corrompido (#2684 item 6)", () => {
  it("edição com 01-approved.json de root não-objeto é pulada sem lançar", () => {
    const editionsDir = makeTempEditionsDir();
    try {
      const editionDir = resolve(editionsDir, "260601");
      mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
      writeFileSync(resolve(editionDir, "_internal", "01-approved.json"), JSON.stringify(["legacy", "array"]), "utf8");

      const items = readPastApprovedSecondary(editionsDir, 10);
      assert.deepEqual(items, []);
    } finally {
      rmSync(editionsDir, { recursive: true });
    }
  });

  it("bucket com item null é ignorado sem lançar TypeError", () => {
    const editionsDir = makeTempEditionsDir();
    try {
      const editionDir = resolve(editionsDir, "260601");
      mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        resolve(editionDir, "_internal", "01-approved.json"),
        JSON.stringify({ radar: [null, { title: "Item válido", url: "https://example.com/x" }] }),
        "utf8",
      );

      const items = readPastApprovedSecondary(editionsDir, 10);
      assert.equal(items.length, 1);
      assert.equal(items[0].title, "Item válido");
    } finally {
      rmSync(editionsDir, { recursive: true });
    }
  });

  it("por default, lê os 4 buckets secundários (não só radar/lancamento) — #2684 item 2", () => {
    const editionsDir = makeTempEditionsDir();
    try {
      const editionDir = resolve(editionsDir, "260601");
      mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        resolve(editionDir, "_internal", "01-approved.json"),
        JSON.stringify({
          radar: [{ title: "R", url: "https://example.com/r" }],
          lancamento: [{ title: "L", url: "https://example.com/l" }],
          use_melhor: [{ title: "U", url: "https://example.com/u" }],
          video: [{ title: "V", url: "https://example.com/v" }],
        }),
        "utf8",
      );

      const items = readPastApprovedSecondary(editionsDir, 10);
      const buckets = items.map((i) => i.bucket).sort();
      assert.deepEqual(buckets, ["lancamento", "radar", "use_melhor", "video"].sort());
    } finally {
      rmSync(editionsDir, { recursive: true });
    }
  });
});
