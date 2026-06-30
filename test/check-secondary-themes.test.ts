/**
 * check-secondary-themes.test.ts (#2605)
 *
 * Testa detecção de repeat de tema de itens SECUNDÁRIOS de edições passadas
 * contra candidatos da edição corrente.
 *
 * Caso real (#2605):
 *   260625 (secundário radar): "Nubank prioriza mentalidade de IA nas contratações"
 *   260626 (candidato radar): "Nubank não vai parar de contratar por causa da IA"
 *   → mesmo tema "Nubank/contratação", URLs diferentes → deve gerar AVISO.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractCompaniesFromText,
  extractPastSecondaryItems,
  extractCurrentCandidates,
  checkSecondaryThemes,
  type PastSecondaryItem,
  type CurrentCandidate,
} from "../scripts/check-secondary-themes.ts";

// ---------------------------------------------------------------------------
// extractCompaniesFromText
// ---------------------------------------------------------------------------

describe("extractCompaniesFromText", () => {
  it("extrai empresa conhecida do texto", () => {
    const companies = extractCompaniesFromText("Nubank não vai parar de contratar por causa da IA");
    assert.ok(companies.has("nubank"), "deve detectar nubank");
  });

  it("extrai múltiplas empresas", () => {
    const companies = extractCompaniesFromText("Google e Microsoft anunciam parceria com Nubank");
    assert.ok(companies.has("google"), "deve detectar google");
    assert.ok(companies.has("microsoft"), "deve detectar microsoft");
    assert.ok(companies.has("nubank"), "deve detectar nubank");
  });

  it("não faz partial match (nubank não bate com nubankpro)", () => {
    const companies = extractCompaniesFromText("nubankpro lança produto");
    assert.ok(!companies.has("nubank"), "não deve fazer partial match");
  });

  it("retorna vazio quando nenhuma empresa conhecida", () => {
    const companies = extractCompaniesFromText("startup desconhecida lança produto novo");
    assert.equal(companies.size, 0);
  });
});

// ---------------------------------------------------------------------------
// checkSecondaryThemes — caso real #2605 (Nubank/contratação)
// ---------------------------------------------------------------------------

describe("checkSecondaryThemes — caso real #2605 Nubank/contratação", () => {
  const pastItems: PastSecondaryItem[] = [
    {
      edition: "260625",
      bucket: "radar",
      title: "Nubank prioriza mentalidade de IA nas contratações",
      url: "https://finsiders.com.br/nubank-mentalidade-ia",
    },
    {
      edition: "260625",
      bucket: "radar",
      title: "ChatGPT lança feature de memória persistente",
      url: "https://techcrunch.com/chatgpt-memory",
    },
  ];

  it("sinaliza candidato com mesmo tema Nubank/contratação", () => {
    const candidates: CurrentCandidate[] = [
      {
        url: "https://tecnoblog.net/nubank-nao-vai-parar",
        title: "Nubank não vai parar de contratar por causa da IA",
        bucket: "radar",
      },
    ];

    const result = checkSecondaryThemes(candidates, pastItems, 3);

    assert.ok(result.warnings.length >= 1, "deve gerar pelo menos 1 aviso");
    const w = result.warnings[0];
    assert.equal(w.candidate_url, "https://tecnoblog.net/nubank-nao-vai-parar");
    assert.equal(w.matched_edition, "260625");
    assert.ok(w.shared_companies.includes("nubank"), "deve identificar nubank como empresa compartilhada");
    assert.ok(w.jaccard >= w.effective_threshold, "Jaccard deve estar acima do threshold efetivo");
  });

  it("não sinaliza candidato sobre tema diferente", () => {
    const candidates: CurrentCandidate[] = [
      {
        url: "https://exame.com/openai-novo-modelo",
        title: "OpenAI anuncia novo modelo de linguagem para 2027",
        bucket: "highlight",
      },
    ];

    const result = checkSecondaryThemes(candidates, pastItems, 3);
    assert.equal(result.warnings.length, 0, "não deve gerar aviso para tema diferente");
  });

  it("não sinaliza quando lista de passados vazia", () => {
    const candidates: CurrentCandidate[] = [
      {
        url: "https://tecnoblog.net/nubank-nao-vai-parar",
        title: "Nubank não vai parar de contratar por causa da IA",
        bucket: "radar",
      },
    ];

    const result = checkSecondaryThemes(candidates, [], 3);
    assert.equal(result.warnings.length, 0, "lista vazia = sem avisos");
  });

  it("threshold reduzido quando empresa compartilhada", () => {
    const candidates: CurrentCandidate[] = [
      {
        url: "https://fintechs.com.br/nubank-estrategia",
        title: "Estratégia do Nubank para 2027",  // Jaccard baixo vs "Nubank prioriza mentalidade..."
        bucket: "radar",
      },
    ];

    // Empresa em comum (nubank) → threshold deve cair para 0.25 → match esperado
    const result = checkSecondaryThemes(candidates, pastItems, 3);
    const nubank_warnings = result.warnings.filter((w) =>
      w.shared_companies.includes("nubank"),
    );
    assert.ok(nubank_warnings.length >= 1, "threshold reduzido deve pegar match com empresa");
    // Threshold com empresa deve ser menor que o threshold base (0.40)
    assert.ok(nubank_warnings[0].effective_threshold < 0.40, "threshold com empresa deve ser reduzido vs base 0.40");
  });
});

// ---------------------------------------------------------------------------
// extractPastSecondaryItems — lê editions dir real
// ---------------------------------------------------------------------------

describe("extractPastSecondaryItems", () => {
  let tmpDir: string;

  it("extrai itens secundários de edições passadas", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "diaria-test-"));
    try {
      // Criar estrutura de edição passada
      const editionDir = join(tmpDir, "260625", "_internal");
      mkdirSync(editionDir, { recursive: true });
      const approved = {
        highlights: [
          { rank: 1, url: "https://h1.com", article: { url: "https://h1.com", title: "Destaque 1" } },
        ],
        radar: [
          { url: "https://finsiders.com.br/nubank", title: "Nubank prioriza mentalidade de IA nas contratações" },
          { url: "https://tech.com/openai", title: "OpenAI lança GPT-5" },
        ],
        lancamento: [
          { url: "https://official.com/v2", title: "Produto v2 disponível" },
        ],
        use_melhor: [],
        video: [],
      };
      writeFileSync(join(editionDir, "01-approved.json"), JSON.stringify(approved));

      const items = extractPastSecondaryItems(tmpDir, "260626", 3);
      assert.ok(items.length >= 3, "deve retornar os 3 itens secundários");
      const urls = items.map((it) => it.url);
      assert.ok(urls.includes("https://finsiders.com.br/nubank"));
      assert.ok(urls.includes("https://tech.com/openai"));
      assert.ok(urls.includes("https://official.com/v2"));
      // Highlights NÃO devem ser incluídos
      assert.ok(!urls.includes("https://h1.com"), "highlights não devem aparecer como secundários");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("exclui a edição corrente ao buscar passadas", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "diaria-test-"));
    try {
      const editionDir = join(tmpDir, "260626", "_internal");
      mkdirSync(editionDir, { recursive: true });
      writeFileSync(join(editionDir, "01-approved.json"), JSON.stringify({
        radar: [{ url: "https://current.com", title: "Item da edição corrente" }],
      }));

      const items = extractPastSecondaryItems(tmpDir, "260626", 3);
      assert.equal(items.length, 0, "edição corrente não deve ser incluída nas passadas");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// extractCurrentCandidates — lê categorized.json
// ---------------------------------------------------------------------------

describe("extractCurrentCandidates", () => {
  let tmpDir: string;

  it("extrai candidatos de todos os buckets incluindo highlights", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "diaria-test-"));
    try {
      const categorizedPath = join(tmpDir, "01-categorized.json");
      writeFileSync(categorizedPath, JSON.stringify({
        highlights: [
          { rank: 1, url: "https://h1.com", article: { url: "https://h1.com", title: "Destaque D1" } },
        ],
        radar: [
          { url: "https://r1.com", title: "RADAR item 1" },
        ],
        lancamento: [
          { url: "https://l1.com", title: "Lançamento 1" },
        ],
        use_melhor: [],
        video: [],
      }));

      const candidates = extractCurrentCandidates(categorizedPath);
      const buckets = candidates.map((c) => c.bucket);
      assert.ok(buckets.includes("highlight"), "deve incluir highlights");
      assert.ok(buckets.includes("radar"), "deve incluir radar");
      assert.ok(buckets.includes("lancamento"), "deve incluir lancamento");
      assert.equal(candidates.length, 3);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("retorna vazio se arquivo não existe", () => {
    const candidates = extractCurrentCandidates("/nao/existe/01-categorized.json");
    assert.equal(candidates.length, 0);
  });
});

// ---------------------------------------------------------------------------
// match_reason (#2629)
// ---------------------------------------------------------------------------

describe("match_reason — stem (#2629 finding 1)", () => {
  it("warning com jaccard < effective_threshold mas hasStemMatch=true → match_reason='stem'", () => {
    // Cenário de stem-match com jaccard abaixo do threshold reduzido por empresa.
    // Candidate: "Nubank contratando [9 tokens muito distintos]" → jaccard baixo (~0.06)
    // Past: "Nubank [tokens distintos] contratações" → "contrat-" compartilhado (>= 7 chars)
    // Resultado antes do fix: warning exibia "Jaccard=0.06 (threshold=0.08)" — parecia que
    // threshold NÃO foi atingido. Com fix, match_reason='stem' deixa o sinal inequívoco.
    const candidates: CurrentCandidate[] = [
      {
        url: "https://fintechs.com/nubank-contratando",
        title: "Nubank contratando profissionais experientes especialistas sistemas bancários globais internacionais",
        bucket: "radar",
      },
    ];
    const pastItems: PastSecondaryItem[] = [
      {
        edition: "260624",
        bucket: "radar",
        title: "Nubank divulga relatorio contratacoes abrangente perspectivas futuras regionais",
        url: "https://finsiders.com.br/nubank-relatorio",
      },
    ];

    const result = checkSecondaryThemes(candidates, pastItems, 3);
    // Deve emitir aviso (hasStemMatch via "contrat-" prefix)
    assert.equal(result.warnings.length, 1, "deve emitir 1 aviso via stem match");
    const w = result.warnings[0];
    // O motivo real do match deve ser explicitamente 'stem', não 'jaccard' nem 'company'
    assert.equal(w.match_reason, "stem", "match_reason deve ser 'stem' quando jaccard < effectiveThreshold");
    // Jaccard deve estar ABAIXO do threshold efetivo (por isso é stem, não jaccard/company)
    assert.ok(w.jaccard < w.effective_threshold, `jaccard=${w.jaccard} deve ser < effective_threshold=${w.effective_threshold} no caso stem`);
    // Deve ter empresa compartilhada (stem só ativa com company)
    assert.ok(w.shared_companies.includes("nubank"), "empresa nubank deve estar em shared_companies");
    // Campo present no JSON (para renderização no gate)
    assert.ok("match_reason" in w, "match_reason deve existir no objeto warning");
  });
});

describe("match_reason — company (#2629 finding 1)", () => {
  it("warning com jaccard entre effective_threshold e threshold_base → match_reason='company'", () => {
    // O caso real #2605: jaccard ≈ 0.10 (acima do company threshold 0.08,
    // abaixo do base 0.40) → match_reason='company'
    const candidates: CurrentCandidate[] = [
      {
        url: "https://tecnoblog.net/nubank-nao-vai-parar",
        title: "Nubank não vai parar de contratar por causa da IA",
        bucket: "radar",
      },
    ];
    const pastItems: PastSecondaryItem[] = [
      {
        edition: "260625",
        bucket: "radar",
        title: "Nubank prioriza mentalidade de IA nas contratações",
        url: "https://finsiders.com.br/nubank-mentalidade-ia",
      },
    ];

    const result = checkSecondaryThemes(candidates, pastItems, 3);
    assert.equal(result.warnings.length, 1, "deve emitir 1 aviso");
    const w = result.warnings[0];
    // Jaccard ~0.10 >= company threshold 0.08, mas < base 0.40 → 'company'
    assert.equal(w.match_reason, "company", "match_reason deve ser 'company' quando company threshold disparou");
    assert.ok(w.jaccard >= w.effective_threshold, "Jaccard deve ser >= effective_threshold");
    assert.ok(w.jaccard < 0.40, "Jaccard deve ser < threshold base (0.40) — senão seria 'jaccard'");
    assert.ok(w.shared_companies.includes("nubank"));
  });
});

describe("match_reason — jaccard (#2629 finding 1)", () => {
  it("warning com jaccard >= threshold base (0.40) → match_reason='jaccard'", () => {
    // Títulos com alta sobreposição de tokens, sem empresa tech
    const candidates: CurrentCandidate[] = [
      {
        url: "https://gov.br/novas-politicas",
        title: "Governo federal anuncia novas políticas públicas para habitação popular",
        bucket: "radar",
      },
    ];
    const pastItems: PastSecondaryItem[] = [
      {
        edition: "260624",
        bucket: "radar",
        title: "Governo federal lança novas políticas públicas habitação popular",
        url: "https://agencia.gov.br/politicas-habitacao",
      },
    ];

    const result = checkSecondaryThemes(candidates, pastItems, 3);
    assert.equal(result.warnings.length, 1, "deve emitir 1 aviso");
    const w = result.warnings[0];
    assert.equal(w.match_reason, "jaccard", "match_reason deve ser 'jaccard' quando Jaccard >= 0.40");
    assert.ok(w.jaccard >= 0.40, `Jaccard=${w.jaccard} deve ser >= 0.40`);
  });
});

describe("match_reason — sem falso positivo (#2629)", () => {
  it("títulos sem relação não geram warning", () => {
    const candidates: CurrentCandidate[] = [
      {
        url: "https://g1.com.br/eleicoes",
        title: "Eleições municipais registram alta abstenção no nordeste",
        bucket: "radar",
      },
    ];
    const pastItems: PastSecondaryItem[] = [
      {
        edition: "260624",
        bucket: "radar",
        title: "Banco Central anuncia corte na taxa Selic",
        url: "https://agencia.gov.br/selic",
      },
    ];

    const result = checkSecondaryThemes(candidates, pastItems, 3);
    assert.equal(result.warnings.length, 0, "sem relação temática = sem aviso");
  });

  it("todos os warnings (#2629) têm match_reason válido", () => {
    const candidates: CurrentCandidate[] = [
      {
        url: "https://tech.com/openai-lanca",
        title: "OpenAI lança novo modelo de linguagem avançado",
        bucket: "radar",
      },
    ];
    const pastItems: PastSecondaryItem[] = [
      {
        edition: "260624",
        bucket: "radar",
        title: "OpenAI anuncia novo modelo de linguagem para 2027",
        url: "https://techcrunch.com/openai-model",
      },
    ];

    const result = checkSecondaryThemes(candidates, pastItems, 3);
    for (const w of result.warnings) {
      assert.ok(
        ["jaccard", "stem", "company"].includes(w.match_reason),
        `match_reason='${w.match_reason}' não é um valor válido`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Integração: end-to-end com dados reais do caso #2605
// ---------------------------------------------------------------------------

describe("checkSecondaryThemes — integração caso #2605", () => {
  it("detecta repeat Nubank/contratação em cenário completo", () => {
    // 260625: Nubank como SECUNDÁRIO
    const pastItems: PastSecondaryItem[] = [
      {
        edition: "260625",
        bucket: "radar",
        title: "Nubank prioriza mentalidade de IA nas contratações",
        url: "https://finsiders.com.br/nubank-mentalidade-ia-contratacoes",
      },
    ];

    // 260626: candidato com URL nova, mesmo tema
    const candidates: CurrentCandidate[] = [
      {
        url: "https://tecnoblog.net/nubank-nao-vai-parar-de-contratar",
        title: "Nubank não vai parar de contratar por causa da IA",
        bucket: "radar",
      },
    ];

    const result = checkSecondaryThemes(candidates, pastItems, 3);

    assert.ok(result.warnings.length >= 1, "deve sinalizar repeat de tema Nubank/contratação");
    const w = result.warnings[0];
    // Sinaliza, NÃO dropa — o campo é "warnings" não "removed"
    assert.equal(typeof w.candidate_title, "string", "warning deve ter título do candidato");
    assert.equal(typeof w.matched_edition, "string", "warning deve ter edição passada");
    assert.ok(w.shared_companies.length > 0, "deve identificar empresa compartilhada");
  });
});
