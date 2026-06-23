/**
 * test/run-fact-checker.test.ts (#2455)
 *
 * Testes unitários para scripts/run-fact-checker.ts.
 *
 * O core do fact-checker é um subagente LLM (não unit-testável diretamente),
 * mas a lógica TS de orquestração e parsing é 100% testável:
 *
 *  (a) extractPriceClaims: detecta R$ 24,99, US$ 20 etc.
 *  (b) extractSuperlativeClaims: detecta "primeira vez", "inédito", "pioneiro" etc.
 *  (c) parseClaimsFromText: combina preços + superlativos.
 *  (d) formatGateSummary: formata seção do gate corretamente.
 *  (e) normalizeFactCheckResult: valida e normaliza output do subagente.
 *  (f) computeAttentionItems: conta itens de atenção.
 *
 * Regressão #2455 — os dois cenários motivadores da issue:
 *  1. Claim de ineditismo ("pela primeira vez uma operadora distribui IA") →
 *     aparece na lista do gate como superlativo.
 *  2. Cifra divergente ("R$ 99" quando fonte diz "R$ 24,99") →
 *     aparece como DIVERGENT no gate summary.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  extractPriceClaims,
  extractSuperlativeClaims,
  parseClaimsFromText,
  formatGateSummary,
  normalizeFactCheckResult,
  computeAttentionItems,
  type FactCheckResult,
  type FactClaim,
  type DryRunOutput,
} from "../scripts/run-fact-checker.ts";

// ---------------------------------------------------------------------------
// extractPriceClaims
// ---------------------------------------------------------------------------

describe("extractPriceClaims (#2455)", () => {
  it("extrai preço R$ com decimal", () => {
    const claims = extractPriceClaims("O plano custa R$ 24,99 por mês.");
    assert.equal(claims.length, 1);
    assert.equal(claims[0].text, "R$ 24,99");
    assert.equal(claims[0].claim_type, "price");
  });

  it("extrai US$ com número inteiro", () => {
    const claims = extractPriceClaims("Plano Google AI Plus a US$ 20/mês.");
    assert.equal(claims.length, 1);
    assert.equal(claims[0].text, "US$ 20");
    assert.equal(claims[0].claim_type, "price");
  });

  it("extrai múltiplos preços distintos", () => {
    const claims = extractPriceClaims("R$ 99/mês ou US$ 20/mês — dois planos disponíveis.");
    assert.equal(claims.length, 2);
    const texts = claims.map((c) => c.text);
    assert.ok(texts.includes("R$ 99") || texts.some((t) => t.startsWith("R$")));
    assert.ok(texts.some((t) => t.startsWith("US$")));
  });

  it("não duplica preços iguais que aparecem duas vezes", () => {
    const claims = extractPriceClaims("Custa R$ 99/mês. O R$ 99 cobre todos os recursos.");
    assert.equal(claims.length, 1, "mesmo preço não deve aparecer duas vezes");
  });

  it("inclui contexto no campo context", () => {
    const claims = extractPriceClaims("O Google AI Plus custa R$ 99/mês e inclui Gemini.");
    assert.ok(claims[0].context.includes("Google AI Plus"), "contexto deve incluir texto ao redor");
  });

  it("texto sem preços → array vazio", () => {
    const claims = extractPriceClaims("A empresa lançou um modelo de linguagem natural.");
    assert.deepEqual(claims, []);
  });
});

// ---------------------------------------------------------------------------
// extractSuperlativeClaims
// ---------------------------------------------------------------------------

describe("extractSuperlativeClaims (#2455)", () => {
  it("detecta 'pela primeira vez' — caso real 260622", () => {
    const claims = extractSuperlativeClaims(
      "pela primeira vez uma operadora distribui IA no Brasil",
    );
    assert.equal(claims.length, 1);
    assert.equal(claims[0].claim_type, "superlative");
    assert.ok(claims[0].text.toLowerCase().includes("primeira vez"));
  });

  it("detecta 'inédito'", () => {
    const claims = extractSuperlativeClaims("Recurso inédito no mercado brasileiro.");
    assert.equal(claims.length, 1);
    assert.ok(claims[0].text.toLowerCase().includes("inédito"));
  });

  it("detecta 'pioneiro'", () => {
    const claims = extractSuperlativeClaims("A empresa é pioneira no segmento.");
    assert.equal(claims.length, 1);
    assert.ok(claims[0].text.toLowerCase().includes("pioneiro") || claims[0].text.toLowerCase().includes("pioneira"));
  });

  it("detecta 'primeiro do Brasil'", () => {
    const claims = extractSuperlativeClaims("Primeiro assistente do Brasil com IA generativa.");
    assert.equal(claims.length, 1);
    assert.ok(claims[0].text.toLowerCase().includes("primeiro"));
  });

  it("detecta 'primeiro a lançar'", () => {
    const claims = extractSuperlativeClaims("A operadora foi a primeira a lançar IA no pré-pago.");
    assert.equal(claims.length, 1);
  });

  it("texto sem superlativos → array vazio", () => {
    const claims = extractSuperlativeClaims("A empresa lançou um produto novo.");
    assert.deepEqual(claims, []);
  });
});

// ---------------------------------------------------------------------------
// parseClaimsFromText — combinação price + superlative
// ---------------------------------------------------------------------------

describe("parseClaimsFromText (#2455)", () => {
  it("combina preços e superlativos", () => {
    const text =
      "Pela primeira vez, um serviço de IA custa R$ 24,99/mês e é inédito no mercado.";
    const claims = parseClaimsFromText(text);
    const types = claims.map((c) => c.claim_type);
    assert.ok(types.includes("price"), "deve ter claim de preço");
    assert.ok(types.includes("superlative"), "deve ter claim de superlativo");
  });

  it("texto vazio → array vazio", () => {
    assert.deepEqual(parseClaimsFromText(""), []);
  });

  it("detecta claim de ineditismo sem preço", () => {
    const claims = parseClaimsFromText("É a primeira a oferecer IA embarcada.");
    assert.ok(claims.some((c) => c.claim_type === "superlative"));
    assert.ok(claims.every((c) => c.claim_type !== "price"));
  });
});

// ---------------------------------------------------------------------------
// computeAttentionItems
// ---------------------------------------------------------------------------

describe("computeAttentionItems (#2455)", () => {
  const makeCllaim = (verdict: FactClaim["verdict"], claim_type: FactClaim["claim_type"]): FactClaim => ({
    destaque: 1,
    claim_type,
    text: "test",
    context: "ctx",
    sources: ["newsletter"],
    verdict,
  });

  it("DIVERGENT → conta como attention", () => {
    const claims = [makeCllaim("DIVERGENT", "price")];
    assert.equal(computeAttentionItems(claims), 1);
  });

  it("superlativo NOT_FOUND_IN_SOURCE → conta como attention", () => {
    const claims = [makeCllaim("NOT_FOUND_IN_SOURCE", "superlative")];
    assert.equal(computeAttentionItems(claims), 1);
  });

  it("superlativo SUSTAINED → NÃO conta como attention", () => {
    const claims = [makeCllaim("SUSTAINED", "superlative")];
    assert.equal(computeAttentionItems(claims), 0);
  });

  it("NOT_FOUND_IN_SOURCE de preço → conta como attention", () => {
    const claims = [makeCllaim("NOT_FOUND_IN_SOURCE", "price")];
    assert.equal(computeAttentionItems(claims), 1);
  });

  it("SUSTAINED de preço → NÃO conta como attention", () => {
    const claims = [makeCllaim("SUSTAINED", "price")];
    assert.equal(computeAttentionItems(claims), 0);
  });

  it("SOURCE_UNREACHABLE → NÃO conta como attention (não verificável)", () => {
    const claims = [makeCllaim("SOURCE_UNREACHABLE", "price")];
    assert.equal(computeAttentionItems(claims), 0);
  });

  it("múltiplos claims mistos", () => {
    const claims = [
      makeCllaim("DIVERGENT", "price"),         // conta
      makeCllaim("SUSTAINED", "superlative"),   // não conta
      makeCllaim("NOT_FOUND_IN_SOURCE", "superlative"), // conta
      makeCllaim("SUSTAINED", "price"),          // não conta
      makeCllaim("NOT_FOUND_IN_SOURCE", "date"), // conta
    ];
    assert.equal(computeAttentionItems(claims), 3);
  });
});

// ---------------------------------------------------------------------------
// normalizeFactCheckResult
// ---------------------------------------------------------------------------

describe("normalizeFactCheckResult (#2455)", () => {
  it("normaliza output bem-formado do subagente", () => {
    const raw = {
      edition: "260622",
      checked_at: "2026-06-22T10:00:00.000Z",
      claims: [
        {
          destaque: 1,
          claim_type: "price",
          text: "R$ 99/mês",
          context: "Google AI Plus custa R$ 99/mês",
          sources: ["newsletter"],
          verdict: "DIVERGENT",
          source_url: "https://example.com",
          source_text: "R$ 24,99/mês",
          note: "Fonte diz R$ 24,99; texto diz R$ 99",
        },
      ],
      summary: { total: 1, sustained: 0, divergent: 1, not_found_in_source: 0, source_unreachable: 0, inferred: 0, attention_items: 1 },
    };
    const result = normalizeFactCheckResult(raw, "260622");
    assert.equal(result.edition, "260622");
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].verdict, "DIVERGENT");
    assert.equal(result.summary.divergent, 1);
    assert.equal(result.summary.attention_items, 1);
  });

  it("filtra claims inválidos (sem text ou verdict)", () => {
    const raw = {
      claims: [
        { destaque: 1, claim_type: "price", text: "R$ 99", context: "x", sources: ["newsletter"], verdict: "DIVERGENT" },
        { destaque: 2, claim_type: "price" }, // inválido — sem text/verdict
        null, // inválido
      ],
    };
    const result = normalizeFactCheckResult(raw, "260622");
    assert.equal(result.claims.length, 1, "deve filtrar claims inválidos");
  });

  it("claims vazio → summary zerado com attention_items=0", () => {
    const raw = { claims: [], checked_at: "2026-06-22T00:00:00Z" };
    const result = normalizeFactCheckResult(raw, "260622");
    assert.equal(result.summary.total, 0);
    assert.equal(result.summary.attention_items, 0);
  });

  it("recalcula summary.attention_items independentemente do raw", () => {
    // O subagente pode enviar attention_items errado — deve ser recalculado
    const raw = {
      claims: [
        { destaque: 1, claim_type: "price", text: "R$ 99", context: "x", sources: ["newsletter"], verdict: "DIVERGENT" },
        { destaque: 2, claim_type: "superlative", text: "inédito", context: "y", sources: ["social"], verdict: "SUSTAINED" },
      ],
      summary: { attention_items: 999 }, // valor errado proposital
    };
    const result = normalizeFactCheckResult(raw, "260622");
    // Só o DIVERGENT conta como attention; superlativo SUSTAINED não conta
    assert.equal(result.summary.attention_items, 1, "deve recalcular attention_items, não confiar no raw");
  });

  it("lança erro se raw não é objeto", () => {
    assert.throws(() => normalizeFactCheckResult(null, "260622"), /não é um objeto JSON/);
    assert.throws(() => normalizeFactCheckResult("string", "260622"), /não é um objeto JSON/);
  });
});

// ---------------------------------------------------------------------------
// formatGateSummary (#2455)
// ---------------------------------------------------------------------------

const EMPTY_RESULT: FactCheckResult = {
  edition: "260622",
  checked_at: "2026-06-22T10:00:00Z",
  claims: [],
  summary: { total: 0, sustained: 0, divergent: 0, not_found_in_source: 0, source_unreachable: 0, inferred: 0, attention_items: 0 },
};

describe("formatGateSummary (#2455)", () => {
  it("sem claims → mensagem informativa sem alarme", () => {
    const s = formatGateSummary(EMPTY_RESULT);
    assert.ok(s.includes("FACT-CHECK"), "deve ter cabeçalho");
    assert.ok(s.includes("Nenhum claim"), "deve indicar ausência de claims");
    assert.ok(!s.includes("❌"), "sem claims não deve ter ❌");
  });

  it("claim DIVERGENT aparece com ❌ no gate summary", () => {
    const result: FactCheckResult = {
      ...EMPTY_RESULT,
      claims: [
        {
          destaque: 1,
          claim_type: "price",
          text: "R$ 99/mês",
          context: "Google AI Plus custa R$ 99/mês",
          sources: ["newsletter"],
          verdict: "DIVERGENT",
          source_url: "https://blog.google/",
          source_text: "R$ 24,99",
          note: "Fonte diz R$ 24,99; texto diz R$ 99",
        },
      ],
      summary: { total: 1, sustained: 0, divergent: 1, not_found_in_source: 0, source_unreachable: 0, inferred: 0, attention_items: 1 },
    };
    const s = formatGateSummary(result);
    assert.ok(s.includes("❌"), "divergência deve aparecer com ❌");
    assert.ok(s.includes("R$ 99/mês"), "deve mostrar o claim divergente");
    assert.ok(s.includes("R$ 24,99"), "deve mostrar o valor da fonte");
    assert.ok(s.includes("DIVERGÊNCIAS"), "deve ter cabeçalho de divergências");
  });

  it("claim de ineditismo NOT_FOUND_IN_SOURCE aparece com ⚠️ — caso real 260622", () => {
    const result: FactCheckResult = {
      ...EMPTY_RESULT,
      claims: [
        {
          destaque: 2,
          claim_type: "superlative",
          text: "pela primeira vez uma operadora distribui IA",
          context: "pela primeira vez uma operadora distribui IA no Brasil",
          sources: ["social"],
          verdict: "NOT_FOUND_IN_SOURCE",
          note: "Claro e TIM já ofereceram IA anteriormente; superlativo sem suporte na fonte",
        },
      ],
      summary: { total: 1, sustained: 0, divergent: 0, not_found_in_source: 1, source_unreachable: 0, inferred: 0, attention_items: 1 },
    };
    const s = formatGateSummary(result);
    assert.ok(s.includes("⚠️"), "ineditismo não confirmado deve ter ⚠️");
    assert.ok(s.includes("primeira vez"), "deve mostrar o claim de ineditismo");
    assert.ok(s.includes("INEDITISMO"), "deve ter cabeçalho de superlativos");
  });

  it("todos claims SUSTAINED → sem alarme visual", () => {
    const result: FactCheckResult = {
      ...EMPTY_RESULT,
      claims: [
        {
          destaque: 1,
          claim_type: "price",
          text: "R$ 24,99",
          context: "custa R$ 24,99/mês",
          sources: ["newsletter"],
          verdict: "SUSTAINED",
          source_text: "R$ 24,99/mês",
        },
      ],
      summary: { total: 1, sustained: 1, divergent: 0, not_found_in_source: 0, source_unreachable: 0, inferred: 0, attention_items: 0 },
    };
    const s = formatGateSummary(result);
    assert.ok(!s.includes("❌"), "sem divergências não deve ter ❌");
    assert.ok(s.includes("✅"), "todos sustentados deve ter ✅");
  });

  it("inclui nota ao editor sobre decisão final", () => {
    const result: FactCheckResult = {
      ...EMPTY_RESULT,
      claims: [
        {
          destaque: 1,
          claim_type: "price",
          text: "R$ 99",
          context: "custa R$ 99",
          sources: ["newsletter"],
          verdict: "DIVERGENT",
          note: "Fonte diz R$ 24,99",
        },
      ],
      summary: { total: 1, sustained: 0, divergent: 1, not_found_in_source: 0, source_unreachable: 0, inferred: 0, attention_items: 1 },
    };
    const s = formatGateSummary(result);
    assert.ok(s.includes("Decisão final"), "deve incluir nota de que decisão é do editor");
    assert.ok(s.includes("editor"), "deve mencionar o editor");
  });
});

// ---------------------------------------------------------------------------
// CLI — modo --dry-run (integração leve sem subagente)
// ---------------------------------------------------------------------------

describe("run-fact-checker CLI --dry-run (#2455)", () => {
  function runCli(editionDir: string, extraArgs: string[] = []) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "run-fact-checker.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "--edition-dir", editionDir, ...extraArgs],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("--dry-run com newsletter que contém R$ 24,99 → claim de preço detectado", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fact-check-test-"));
    const internalDir = join(tmp, "_internal");
    try {
      // Criar arquivos mínimos
      mkdirSync(internalDir, { recursive: true });

      writeFileSync(
        join(tmp, "02-reviewed.md"),
        `DESTAQUE 1

O Google AI Plus custa R$ 24,99 por mês e inclui acesso ao Gemini.

Por que isso importa: é o primeiro plano de IA integrado a uma conta Google.`,
        "utf8",
      );
      writeFileSync(
        join(tmp, "03-social.md"),
        `# LinkedIn

## d1

Google lança AI Plus por R$ 24,99/mês.`,
        "utf8",
      );
      writeFileSync(
        join(internalDir, "01-approved.json"),
        JSON.stringify({
          highlights: [
            {
              url: "https://blog.google/produtos/gemini/",
              title_options: ["Google lança AI Plus"],
              article: { title: "Google AI Plus", summary: "Plano de IA por R$ 24,99/mês" },
            },
          ],
        }),
        "utf8",
      );

      const result = runCli(tmp, ["--dry-run"]);
      assert.equal(result.status, 0, `exit 0 esperado. stderr: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as { claims_heuristic: Array<{ claim_type: string; text: string }> };
      assert.ok(Array.isArray(parsed.claims_heuristic), "deve retornar claims_heuristic");
      const prices = parsed.claims_heuristic.filter((c) => c.claim_type === "price");
      assert.ok(prices.length >= 1, "deve detectar ao menos 1 claim de preço (R$ 24,99)");
      assert.ok(
        prices.some((c) => c.text.includes("24,99") || c.text.includes("24")),
        `deve detectar R$ 24,99. Claims encontrados: ${JSON.stringify(prices)}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--dry-run com social que contém 'primeira vez' → claim de ineditismo detectado — caso real 260622", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fact-check-test2-"));
    const internalDir = join(tmp, "_internal");
    try {
      mkdirSync(internalDir, { recursive: true });

      writeFileSync(join(tmp, "02-reviewed.md"), "DESTAQUE 1\n\nTexto sem ineditismo.\n", "utf8");
      writeFileSync(
        join(tmp, "03-social.md"),
        `# LinkedIn

## d2

Pela primeira vez uma operadora distribui IA no pacote pré-pago.`,
        "utf8",
      );
      writeFileSync(
        join(internalDir, "01-approved.json"),
        JSON.stringify({ highlights: [
          { url: "https://example.com", title_options: ["Operadora lança IA"], article: { title: "IA no pré-pago", summary: "primeira operadora" } },
        ] }),
        "utf8",
      );

      const result = runCli(tmp, ["--dry-run"]);
      assert.equal(result.status, 0, `exit 0 esperado. stderr: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as { claims_heuristic: Array<{ claim_type: string; text: string }> };
      const superlatives = parsed.claims_heuristic.filter((c) => c.claim_type === "superlative");
      assert.ok(superlatives.length >= 1, "deve detectar ao menos 1 claim de ineditismo");
      assert.ok(
        superlatives.some((c) => c.text.toLowerCase().includes("primeira vez")),
        `deve detectar 'primeira vez'. Claims: ${JSON.stringify(superlatives)}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falha com exit 1 se 02-reviewed.md não existe", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fact-check-missing-"));
    try {
      const result = runCli(tmp);
      assert.equal(result.status, 1, "deve falhar se arquivo não existe");
      assert.ok(result.stderr.includes("02-reviewed.md"), "stderr deve mencionar o arquivo ausente");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falha com exit 1 se --edition-dir não fornecido", () => {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "run-fact-checker.ts");
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath],
      { cwd: projectRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 1, "deve falhar sem --edition-dir");
    assert.ok(result.stderr.includes("edition-dir"), "stderr deve mencionar edition-dir");
  });
});

// ---------------------------------------------------------------------------
// CLI — modo --input-json (integração com output do subagente)
// ---------------------------------------------------------------------------

describe("run-fact-checker CLI --input-json (#2455)", () => {
  function runCli(editionDir: string, extraArgs: string[] = []) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "run-fact-checker.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "--edition-dir", editionDir, ...extraArgs],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("grava fact-check.json e exibe gate summary com DIVERGENT", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fact-check-inputjson-"));
    const internalDir = join(tmp, "_internal");
    try {
      mkdirSync(internalDir, { recursive: true });

      // Criar arquivos obrigatórios (pré-condições)
      writeFileSync(join(tmp, "02-reviewed.md"), "DESTAQUE 1\nTexto.\n", "utf8");
      writeFileSync(join(tmp, "03-social.md"), "# LinkedIn\n## d1\nPost.\n", "utf8");
      writeFileSync(
        join(internalDir, "01-approved.json"),
        JSON.stringify({ highlights: [{ url: "https://ex.com", title_options: ["T"], article: { title: "T", summary: "S" } }] }),
        "utf8",
      );

      // Simular output do subagente
      const agentOutput = {
        edition: "260622",
        checked_at: "2026-06-22T10:00:00Z",
        claims: [
          {
            destaque: 1,
            claim_type: "price",
            text: "R$ 99/mês",
            context: "Google AI Plus custa R$ 99/mês",
            sources: ["newsletter"],
            verdict: "DIVERGENT",
            source_url: "https://blog.google/",
            source_text: "R$ 24,99/mês",
            note: "Fonte diz R$ 24,99; texto diz R$ 99",
          },
        ],
        summary: { total: 1, sustained: 0, divergent: 1, not_found_in_source: 0, source_unreachable: 0, inferred: 0, attention_items: 1 },
      };
      const inputJsonPath = join(tmp, "agent-output.json");
      writeFileSync(inputJsonPath, JSON.stringify(agentOutput), "utf8");

      const result = runCli(tmp, ["--input-json", inputJsonPath]);
      // DIVERGENT → attention_items=1 → exit 2 (#2468 finding 4)
      assert.equal(result.status, 2, `exit 2 esperado (attention_items>0). stderr: ${result.stderr}`);

      // Gate summary no stdout deve conter ❌
      assert.ok(result.stdout.includes("❌"), `stdout deve ter ❌ para DIVERGENT. stdout: ${result.stdout}`);
      assert.ok(result.stdout.includes("R$ 99"), "stdout deve mencionar o claim divergente");

      // fact-check.json deve ter sido gravado
      // existsSync and readFileSync imported at top of file
      const outPath = join(internalDir, "fact-check.json");
      assert.ok(existsSync(outPath), "fact-check.json deve ter sido gravado");
      const saved = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(saved.summary.divergent, 1, "fact-check.json deve ter divergent=1");
      assert.equal(saved.summary.attention_items, 1, "fact-check.json deve ter attention_items=1 recalculado");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Regressões #2468 — 6 findings do self-review pós-#2455
// ---------------------------------------------------------------------------

describe("regressões #2468 — finding 1: dry-run schema alinhado", () => {
  function runCli(editionDir: string, extraArgs: string[] = []) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "run-fact-checker.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "--edition-dir", editionDir, ...extraArgs],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("dry-run output satisfaz schema DryRunOutput (mode, edition, claims_heuristic, note)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fact-check-2468-f1-"));
    const internalDir = join(tmp, "_internal");
    try {
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(join(tmp, "02-reviewed.md"), "DESTAQUE 1\n\nTexto R$ 99/mês.\n", "utf8");
      writeFileSync(join(tmp, "03-social.md"), "# LinkedIn\n## d1\nPost.\n", "utf8");
      writeFileSync(
        join(internalDir, "01-approved.json"),
        JSON.stringify({ highlights: [{ url: "https://ex.com", title_options: ["T"], article: { title: "T", summary: "S" } }] }),
        "utf8",
      );

      const result = runCli(tmp, ["--dry-run"]);
      assert.equal(result.status, 0, `exit 0 esperado. stderr: ${result.stderr}`);

      const parsed = JSON.parse(result.stdout) as DryRunOutput;
      // Verificar que o output satisfaz DryRunOutput schema
      assert.equal(parsed.mode, "dry-run", "mode deve ser 'dry-run'");
      assert.ok(typeof parsed.edition === "string", "edition deve ser string");
      assert.ok(Array.isArray(parsed.claims_heuristic), "claims_heuristic deve ser array");
      assert.ok(typeof parsed.note === "string", "note deve ser string");
      // Cada item de claims_heuristic deve ter text, claim_type, context (ExtractedClaim)
      for (const c of parsed.claims_heuristic) {
        assert.ok(typeof c.text === "string", "claim.text deve ser string");
        assert.ok(typeof c.claim_type === "string", "claim.claim_type deve ser string");
        assert.ok(typeof c.context === "string", "claim.context deve ser string");
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("regressões #2468 — finding 2: destaque=0 não filtrado por falsy", () => {
  it("normalizeFactCheckResult preserva claim com destaque=0", () => {
    const raw = {
      claims: [
        {
          destaque: 0,
          claim_type: "price" as const,
          text: "R$ 99",
          context: "custa R$ 99",
          sources: ["newsletter"] as const,
          verdict: "DIVERGENT" as const,
        },
        {
          destaque: 1,
          claim_type: "price" as const,
          text: "R$ 24,99",
          context: "custa R$ 24,99",
          sources: ["newsletter"] as const,
          verdict: "SUSTAINED" as const,
        },
      ],
    };
    const result = normalizeFactCheckResult(raw, "260622");
    assert.equal(result.claims.length, 2, "destaque=0 não deve ser filtrado por falsy");
    const d0 = result.claims.find((c) => c.destaque === 0);
    assert.ok(d0, "claim com destaque=0 deve estar presente");
    assert.equal(d0?.verdict, "DIVERGENT");
  });

  it("normalizeFactCheckResult ainda filtra claim sem destaque (undefined)", () => {
    const raw = {
      claims: [
        {
          // destaque ausente (undefined) — inválido
          claim_type: "price",
          text: "R$ 99",
          context: "custa R$ 99",
          sources: ["newsletter"],
          verdict: "DIVERGENT",
        },
      ],
    };
    const result = normalizeFactCheckResult(raw, "260622");
    // destaque=undefined → null check falha → filtrado
    assert.equal(result.claims.length, 0, "claim sem destaque (undefined) deve ser filtrado");
  });
});

describe("regressões #2468 — finding 3: USD/BRL/EUR ancorado com \\b", () => {
  it("USD com valor numérico é detectado", () => {
    const claims = extractPriceClaims("O plano custa USD 20 por mês.");
    assert.ok(claims.some((c) => c.text.includes("20")), "USD 20 deve ser detectado");
  });

  it("BRL com valor numérico é detectado", () => {
    const claims = extractPriceClaims("Custo de BRL 99,90 mensais.");
    assert.ok(claims.some((c) => c.text.includes("99")), "BRL 99,90 deve ser detectado");
  });

  it("EUR com valor numérico é detectado", () => {
    const claims = extractPriceClaims("Plano europeu por EUR 15/mês.");
    assert.ok(claims.some((c) => c.text.includes("15")), "EUR 15 deve ser detectado");
  });

  it("USD/BRL/EUR como substring mid-word NÃO gera FP (#2468 finding 3)", () => {
    // 'ESTUDANTE' contém 'EUR'? Não, mas vamos usar exemplos realistas.
    // Palavra que contém BRL: há poucas em português, mas testamos o padrão
    // Uma palavra inventada que contém USD/BRL/EUR no meio
    const claims = extractPriceClaims("Texto sem preço (OCURSD, OBLRL, BLEUR são siglas).");
    // Nenhuma dessas deve casar como preço porque não têm dígitos após a sigla
    // (o regex já exige \d após a sigla), mas o importante é que o \b evita
    // matches onde USD/BRL/EUR aparecem no meio de palavras seguidos de número.
    // Teste mais realista: "BRLTOKEN123" — sem \b, "BRL" casaria "BRL123"
    const claimsWordBoundary = extractPriceClaims("O BRLTOKEN123 é um crypto, não um preço.");
    // Com \b, "BRL" em "BRLTOKEN" não deve casar (B é precedido por início de palavra, OK)
    // mas "BRLTOKEN123" — o \b está ANTES de BRL, não depois, então isso casa
    // O real FP seria: "BRLTOKEN 123" → com \b, BRL deve casar se está no início de palavra
    // Caso verdadeiro de FP sem \b: "fooBRL 123" → "BRL 123" seria extraído
    const claimsInfix = extractPriceClaims("fooBRL 123 é um código interno, não preço.");
    assert.equal(claimsInfix.length, 0, "'BRL' dentro de 'fooBRL' não deve gerar FP de preço");
  });

  it("USD/BRL/EUR NÃO são FP em contexto sem dígitos", () => {
    const claims = extractPriceClaims("Moedas: USD, BRL e EUR são unidades monetárias.");
    assert.equal(claims.length, 0, "siglas sem valor numérico não devem gerar claims");
  });
});

describe("regressões #2468 — finding 4: exit codes distintos", () => {
  function runCli(editionDir: string, extraArgs: string[] = []) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "run-fact-checker.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "--edition-dir", editionDir, ...extraArgs],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("--input-json com attention_items=0 → exit 0", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fact-check-2468-f4a-"));
    const internalDir = join(tmp, "_internal");
    try {
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(join(tmp, "02-reviewed.md"), "DESTAQUE 1\n\nTexto.\n", "utf8");
      writeFileSync(join(tmp, "03-social.md"), "# LinkedIn\n## d1\nPost.\n", "utf8");
      writeFileSync(
        join(internalDir, "01-approved.json"),
        JSON.stringify({ highlights: [{ url: "https://ex.com", title_options: ["T"], article: { title: "T", summary: "S" } }] }),
        "utf8",
      );
      const agentOutput = {
        claims: [{ destaque: 1, claim_type: "price", text: "R$ 99", context: "custa R$ 99", sources: ["newsletter"], verdict: "SUSTAINED" }],
        checked_at: new Date().toISOString(),
      };
      const inputJsonPath = join(tmp, "agent.json");
      writeFileSync(inputJsonPath, JSON.stringify(agentOutput), "utf8");

      const result = runCli(tmp, ["--input-json", inputJsonPath]);
      assert.equal(result.status, 0, `exit 0 esperado quando attention_items=0. stderr: ${result.stderr}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("--input-json com attention_items>0 → exit 2 (#2468 finding 4)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "fact-check-2468-f4b-"));
    const internalDir = join(tmp, "_internal");
    try {
      mkdirSync(internalDir, { recursive: true });
      writeFileSync(join(tmp, "02-reviewed.md"), "DESTAQUE 1\n\nTexto.\n", "utf8");
      writeFileSync(join(tmp, "03-social.md"), "# LinkedIn\n## d1\nPost.\n", "utf8");
      writeFileSync(
        join(internalDir, "01-approved.json"),
        JSON.stringify({ highlights: [{ url: "https://ex.com", title_options: ["T"], article: { title: "T", summary: "S" } }] }),
        "utf8",
      );
      const agentOutput = {
        claims: [{ destaque: 1, claim_type: "price", text: "R$ 99", context: "custa R$ 99", sources: ["newsletter"], verdict: "DIVERGENT", note: "fonte diz R$ 24,99" }],
        checked_at: new Date().toISOString(),
      };
      const inputJsonPath = join(tmp, "agent.json");
      writeFileSync(inputJsonPath, JSON.stringify(agentOutput), "utf8");

      const result = runCli(tmp, ["--input-json", inputJsonPath]);
      assert.equal(result.status, 2, `exit 2 esperado quando attention_items>0. stderr: ${result.stderr}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("regressões #2468 — finding 5: ghost-header em formatGateSummary", () => {
  it("formatGateSummary com attention_items>0 mas claims vazios → fallback genérico, sem header vazio", () => {
    // Simula inconsistência: summary.attention_items=1 mas claims=[]
    // (edge case defensivo — não deveria acontecer em prod com computeAttentionItems correto)
    const result: FactCheckResult = {
      edition: "260622",
      checked_at: "2026-06-22T10:00:00Z",
      claims: [],
      summary: { total: 1, sustained: 0, divergent: 0, not_found_in_source: 0, source_unreachable: 0, inferred: 0, attention_items: 1 },
    };
    const s = formatGateSummary(result);
    // Não deve ter header de seção sem conteúdo
    assert.ok(!s.includes("DIVERGÊNCIAS") || s.indexOf("DIVERGÊNCIAS") < s.indexOf("D1"), "não deve ter seção vazia");
    // Deve ter o fallback genérico
    assert.ok(s.includes("item(ns) de atenção"), "deve ter fallback genérico quando seções estão vazias");
    assert.ok(s.includes("━━━"), "deve ter separador de fechamento");
  });

  it("formatGateSummary normal (com claims reais) não usa fallback genérico", () => {
    const result: FactCheckResult = {
      edition: "260622",
      checked_at: "2026-06-22T10:00:00Z",
      claims: [
        { destaque: 1, claim_type: "price", text: "R$ 99", context: "custa R$ 99", sources: ["newsletter"], verdict: "DIVERGENT", note: "fonte diz R$ 24,99" },
      ],
      summary: { total: 1, sustained: 0, divergent: 1, not_found_in_source: 0, source_unreachable: 0, inferred: 0, attention_items: 1 },
    };
    const s = formatGateSummary(result);
    assert.ok(!s.includes("item(ns) de atenção"), "fallback genérico não deve aparecer com seções reais");
    assert.ok(s.includes("DIVERGÊNCIAS"), "seção de divergências deve aparecer");
  });
});
