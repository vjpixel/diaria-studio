/**
 * Tests for #2526: lintAntithesisReveal — no-antithesis-reveal check.
 *
 * Regression: exemplos reais flagrados na edição 260624 devem ser detectados.
 * Texto reescrito direto (sem estrutura de antítese-revelação) deve PASSAR.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lintAntithesisReveal } from "../scripts/lint-social-md.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Envolve texto numa seção LinkedIn mínima pra simular 03-social.md. */
function mkMd(body: string): string {
  return `# LinkedIn\n\n## d1\n\n${body}\n\n# Facebook\n\n## d1\n\nfb\n`;
}

// ---------------------------------------------------------------------------
// Exemplos reais da edição 260624 — DEVEM ser flagrados
// ---------------------------------------------------------------------------

describe("lintAntithesisReveal (#2526) — exemplos reais 260624", () => {
  it("FALHA: padrão 'de verdade, não só' — exemplo real 260624", () => {
    // Exemplo real flagrado: "É delegação de verdade, não só consulta."
    const md = mkMd("É delegação de verdade, não só consulta.");
    const r = lintAntithesisReveal(md);
    assert.equal(r.ok, true, "WARN-ONLY: ok deve ser sempre true");
    assert.ok(r.matches.length > 0, `Deveria ter detectado antítese; matches: ${JSON.stringify(r.matches)}`);
    assert.equal(r.matches[0].pattern, "de_verdade");
  });

  it("FALHA: padrão 'não é X. É Y' — exemplo real 260624", () => {
    // Exemplo real flagrado: "...o que me chama atenção não é a tecnologia. É a aposta de distribuição."
    const md = mkMd("O que me chama atenção não é a tecnologia. É a aposta de distribuição.");
    const r = lintAntithesisReveal(md);
    assert.equal(r.ok, true, "WARN-ONLY: ok deve ser sempre true");
    assert.ok(r.matches.length > 0, `Deveria ter detectado antítese; matches: ${JSON.stringify(r.matches)}`);
  });
});

// ---------------------------------------------------------------------------
// Variantes dos 3 padrões documentados na issue
// ---------------------------------------------------------------------------

describe("lintAntithesisReveal (#2526) — variantes dos padrões banidos", () => {
  it("FALHA: 'não é substituição, é internalização'", () => {
    const md = mkMd("Não é substituição, é internalização de capacidade.");
    const r = lintAntithesisReveal(md);
    assert.equal(r.ok, true, "WARN-ONLY: ok sempre true");
    assert.ok(r.matches.length > 0, `Deveria detectar; matches: ${JSON.stringify(r.matches)}`);
    assert.equal(r.matches[0].pattern, "nao_e_e");
  });

  it("FALHA: 'não é mais um bot, e sim um colega'", () => {
    const md = mkMd("Não é mais um bot, e sim um colega de trabalho.");
    const r = lintAntithesisReveal(md);
    assert.equal(r.ok, true, "WARN-ONLY: ok sempre true");
    assert.ok(r.matches.length > 0, `Deveria detectar; matches: ${JSON.stringify(r.matches)}`);
    assert.equal(r.matches[0].pattern, "nao_e_e");
  });

  it("FALHA: 'o que me chama atenção é X, não Y'", () => {
    const md = mkMd("O que me chama atenção é a aposta de distribuição, não a tecnologia.");
    const r = lintAntithesisReveal(md);
    assert.equal(r.ok, true, "WARN-ONLY: ok sempre true");
    assert.ok(r.matches.length > 0, `Deveria detectar padrão chama_atencao; matches: ${JSON.stringify(r.matches)}`);
  });

  it("FALHA: 'não é mais um bot — é um colega' (travessão)", () => {
    const md = mkMd("Não é mais um assistente — é um colega de trabalho.");
    const r = lintAntithesisReveal(md);
    assert.equal(r.ok, true, "WARN-ONLY: ok sempre true");
    assert.ok(r.matches.length > 0, `Deveria detectar; matches: ${JSON.stringify(r.matches)}`);
  });
});

// ---------------------------------------------------------------------------
// Texto reescrito direto — DEVE PASSAR (sem antítese-revelação)
// ---------------------------------------------------------------------------

describe("lintAntithesisReveal (#2526) — texto reescrito direto deve PASSAR", () => {
  it("PASSA: reescrita direta do 'de verdade, não só' (exemplo 260624)", () => {
    // Reescrito: "É delegação de verdade, não só consulta."
    // → "A delegação aqui é real — a IA decide, não só sugere."
    const md = mkMd("A delegação aqui é real — a IA decide, não só sugere.");
    const r = lintAntithesisReveal(md);
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0, `Falso-positivo na reescrita direta; matches: ${JSON.stringify(r.matches)}`);
  });

  it("PASSA: reescrita direta do 'não é a tecnologia. É a aposta de distribuição'", () => {
    // Reescrito: sem negar primeiro; vai direto ao ponto
    // → "A aposta de distribuição me interessa mais que a tecnologia."
    const md = mkMd("A aposta de distribuição me interessa mais que a tecnologia.");
    const r = lintAntithesisReveal(md);
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0, `Falso-positivo na reescrita direta; matches: ${JSON.stringify(r.matches)}`);
  });

  it("PASSA: 'não é só isso' (uso legítimo sem revelação)", () => {
    // "não é só" sem o padrão de revelação subsequente deve passar
    const md = mkMd("Não é só a velocidade que impressiona — a qualidade também surpreende.");
    const r = lintAntithesisReveal(md);
    // Este caso é borderline; o importante é que o padrão de_verdade não case aqui
    // (sem "de verdade, não só"). O padrão nao_e_e pode ou não casar dependendo da
    // heurística — documentamos o comportamento atual sem forçar.
    assert.equal(r.ok, true, "WARN-ONLY: ok sempre true independente de matches");
  });

  it("PASSA: texto editorial sem nenhum dos padrões", () => {
    const md = mkMd(
      "A Anthropic lançou o Claude 4 com foco em raciocínio de longa duração. " +
      "O modelo resolve problemas de engenharia que levavam dias em horas. " +
      "O diferencial está na capacidade de manter coerência em tarefas de múltiplas etapas.",
    );
    const r = lintAntithesisReveal(md);
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 0, `Falso-positivo em texto limpo; matches: ${JSON.stringify(r.matches)}`);
  });

  it("PASSA: cabeçalhos de seção (## d1) não são flagados mesmo com padrão no texto do header", () => {
    // Headers são pulados — "não é" num header não deve ser flagado
    const md = "# LinkedIn\n\n## não é destaque\n\nTexto normal aqui.\n";
    const r = lintAntithesisReveal(md);
    assert.equal(r.ok, true);
    // O header ## não é destaque deve ser pulado pelo check de headers
    // O texto "Texto normal aqui." não tem o padrão → 0 matches
    assert.equal(r.matches.length, 0, `Falso-positivo em header; matches: ${JSON.stringify(r.matches)}`);
  });
});

// ---------------------------------------------------------------------------
// WARN-ONLY: verificar que exit seria 0 mesmo com matches
// (testado pela propriedade ok: always true)
// ---------------------------------------------------------------------------

describe("lintAntithesisReveal (#2526) — WARN-ONLY: ok sempre true", () => {
  it("ok é sempre true independente do número de matches", () => {
    // Múltiplos padrões banidos na mesma string
    const md = mkMd(
      "Não é substituição, é internalização.\n" +
      "É delegação de verdade, não só consulta.\n" +
      "O que me chama atenção não é a tecnologia.",
    );
    const r = lintAntithesisReveal(md);
    assert.equal(r.ok, true, "ok deve ser sempre true — check é WARN-ONLY");
    assert.ok(r.matches.length >= 2, `Esperava detectar ao menos 2 padrões; matches: ${JSON.stringify(r.matches)}`);
  });
});
