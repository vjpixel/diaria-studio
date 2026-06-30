/**
 * Tests for #2658: lintTrailingEditorialHook — no-trailing-editorial-hook check.
 *
 * Regression: os 3 exemplos reais da issue (social 260630, removidos manualmente
 * pelo editor) devem ser detectados. Coordenação legítima com ", e" sem gatilho
 * editorial NÃO deve ser flagada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintTrailingEditorialHook } from "../scripts/lint-social-md.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Envolve texto numa seção LinkedIn mínima pra simular 03-social.md. */
function mkMd(body: string): string {
  return `# LinkedIn\n\n## d1\n\n${body}\n\n# Facebook\n\n## d1\n\nfb\n`;
}

// ---------------------------------------------------------------------------
// Exemplos reais da issue #2658 (social 260630) — DEVEM ser flagrados
// ---------------------------------------------------------------------------

describe("lintTrailingEditorialHook (#2658) — exemplos reais da issue", () => {
  it("FALHA: 'diz mais sobre estratégia do que os benchmarks' — exemplo real 1", () => {
    const md = mkMd(
      "A OpenAI colocou no ar a prévia do GPT-5.6 Sol, e a escolha de focos diz mais sobre estratégia do que os benchmarks costumam revelar.",
    );
    const r = lintTrailingEditorialHook(md);
    assert.equal(r.ok, true, "WARN-ONLY: ok deve ser sempre true");
    assert.ok(r.matches.length > 0, `Deveria ter detectado gancho editorial; matches: ${JSON.stringify(r.matches)}`);
    assert.ok(
      r.matches[0].context.includes("diz mais sobre"),
      `contexto deve incluir o gatilho 'diz mais sobre'; got: "${r.matches[0].context}"`,
    );
  });

  it("FALHA: 'é tão relevante quanto o lançamento' — exemplo real 2", () => {
    const md = mkMd(
      "O governo dos EUA autorizou a Anthropic a operar em parceria com empresas de defesa, e o processo de como isso aconteceu é tão relevante quanto o lançamento.",
    );
    const r = lintTrailingEditorialHook(md);
    assert.equal(r.ok, true, "WARN-ONLY: ok deve ser sempre true");
    assert.ok(r.matches.length > 0, `Deveria ter detectado gancho editorial; matches: ${JSON.stringify(r.matches)}`);
    assert.ok(
      r.matches[0].context.includes("tão relevante quanto"),
      `contexto deve incluir o gatilho 'é tão relevante quanto'; got: "${r.matches[0].context}"`,
    );
  });

  it("FALHA: 'o que mais pesa não é o que o modelo faz' — exemplo real 3", () => {
    const md = mkMd(
      "O GPT-5.6 Sol entrou em prévia, e o que mais pesa não é o que o modelo faz. É como o lançamento aconteceu.",
    );
    const r = lintTrailingEditorialHook(md);
    assert.equal(r.ok, true, "WARN-ONLY: ok deve ser sempre true");
    assert.ok(r.matches.length > 0, `Deveria ter detectado gancho editorial; matches: ${JSON.stringify(r.matches)}`);
    assert.ok(
      r.matches[0].context.includes("o que mais pesa"),
      `contexto deve incluir o gatilho 'o que mais pesa'; got: "${r.matches[0].context}"`,
    );
  });
});

// ---------------------------------------------------------------------------
// Outros gatilhos documentados na issue — também devem ser flagrados
// ---------------------------------------------------------------------------

describe("lintTrailingEditorialHook (#2658) — outros gatilhos editoriais", () => {
  it("FALHA: 'mais do que parece'", () => {
    // Uso exato do gatilho "mais do que parece" — a IA anuncia relevância em vez de afirmar
    const md = mkMd(
      "A Microsoft integrou agentes autônomos ao Office, e a mudança no fluxo de trabalho é mais do que parece.",
    );
    const r = lintTrailingEditorialHook(md);
    assert.equal(r.ok, true, "WARN-ONLY: ok sempre true");
    assert.ok(r.matches.length > 0, `Deveria detectar 'mais do que parece'; matches: ${JSON.stringify(r.matches)}`);
  });

  it("FALHA: 'vai além de'", () => {
    const md = mkMd(
      "A Anthropic publicou o novo relatório de segurança, e a decisão vai além de relações públicas.",
    );
    const r = lintTrailingEditorialHook(md);
    assert.equal(r.ok, true, "WARN-ONLY: ok sempre true");
    assert.ok(r.matches.length > 0, `Deveria detectar 'vai além de'; matches: ${JSON.stringify(r.matches)}`);
  });

  it("FALHA: 'é tão importante quanto'", () => {
    const md = mkMd(
      "A OpenAI lançou o GPT-5 com capacidade de raciocínio expandida, e o preço do acesso é tão importante quanto o desempenho.",
    );
    const r = lintTrailingEditorialHook(md);
    assert.equal(r.ok, true, "WARN-ONLY: ok sempre true");
    assert.ok(r.matches.length > 0, `Deveria detectar 'é tão importante quanto'; matches: ${JSON.stringify(r.matches)}`);
  });
});

// ---------------------------------------------------------------------------
// Casos negativos — coordenação legítima com ", e" SEM gatilho editorial
// NÃO devem ser flagados
// ---------------------------------------------------------------------------

describe("lintTrailingEditorialHook (#2658) — casos negativos (coordenação legítima)", () => {
  it("PASSA: 'lançou o modelo, e disponibilizou a API' — coordenação simples", () => {
    const md = mkMd("A empresa lançou o modelo, e disponibilizou a API para desenvolvedores.");
    const r = lintTrailingEditorialHook(md);
    assert.equal(r.ok, true);
    assert.equal(
      r.matches.length, 0,
      `Coordenação simples não deve ser flagada; matches: ${JSON.stringify(r.matches)}`,
    );
  });

  it("PASSA: 'abriu o código, e publicou os pesos do modelo' — coordenação simples", () => {
    const md = mkMd("A Meta abriu o código, e publicou os pesos do modelo para pesquisadores.");
    const r = lintTrailingEditorialHook(md);
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0, `Falso-positivo em coordenação; matches: ${JSON.stringify(r.matches)}`);
  });

  it("PASSA: 'aumentou o contexto, e reduziu a latência' — lista de feitos", () => {
    const md = mkMd("O Google aumentou o contexto do Gemini, e reduziu a latência média em 40%.");
    const r = lintTrailingEditorialHook(md);
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0, `Lista de feitos não deve ser flagada; matches: ${JSON.stringify(r.matches)}`);
  });

  it("PASSA: texto sem ', e' algum", () => {
    const md = mkMd(
      "A Anthropic lançou o Claude 4 com foco em raciocínio de longa duração. " +
      "O modelo resolve problemas de engenharia que levavam dias em horas.",
    );
    const r = lintTrailingEditorialHook(md);
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0, `Texto limpo não deve ser flagado; matches: ${JSON.stringify(r.matches)}`);
  });

  it("PASSA: cabeçalhos de seção (## d1) não são flagados mesmo se contêm o padrão", () => {
    // Headers ## são pulados — não são prosa
    const md = "# LinkedIn\n\n## d1 e o que mais pesa\n\nTexto limpo aqui.\n";
    const r = lintTrailingEditorialHook(md);
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0, `Header ## não deve ser flagado; matches: ${JSON.stringify(r.matches)}`);
  });

  it("PASSA: comentários HTML não são flagados", () => {
    const md = mkMd("<!-- e o que mais pesa não é o modelo -->\nTexto limpo.");
    const r = lintTrailingEditorialHook(md);
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0, `Comentário HTML não deve ser flagado; matches: ${JSON.stringify(r.matches)}`);
  });
});

// ---------------------------------------------------------------------------
// WARN-ONLY: ok deve ser sempre true, nunca bloqueia
// ---------------------------------------------------------------------------

describe("lintTrailingEditorialHook (#2658) — WARN-ONLY: ok sempre true", () => {
  it("ok é sempre true independente do número de matches", () => {
    const md = mkMd(
      "O GPT-5.6 entrou em prévia, e o que mais pesa não é o que faz.\n" +
      "A Anthropic lançou o modelo, e a escolha de foco diz mais sobre estratégia do que parece.",
    );
    const r = lintTrailingEditorialHook(md);
    assert.equal(r.ok, true, "ok deve ser sempre true — check é WARN-ONLY");
    assert.ok(r.matches.length >= 1, `Esperava detectar ao menos 1 padrão; matches: ${JSON.stringify(r.matches)}`);
  });

  it("ok é true quando não há matches (texto limpo)", () => {
    const md = mkMd("A empresa publicou os resultados e anunciou novos planos.");
    const r = lintTrailingEditorialHook(md);
    assert.equal(r.ok, true, "ok deve ser true mesmo sem matches");
    assert.equal(r.matches.length, 0);
  });
});
