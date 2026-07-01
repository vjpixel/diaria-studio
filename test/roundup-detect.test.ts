/**
 * roundup-detect.test.ts (#2691 items 1, 2, 3, 4)
 *
 * Testes de regressão para o módulo compartilhado `lib/roundup-detect.ts`,
 * extraído de 2 cópias divergentes (ROUNDUP_SLUG_RE em categorize.ts,
 * ROUNDUP_GUARD_RE em use-melhor-curation.ts) sincronizadas só por
 * comentário "Espelha... — manter em sincronia ao editar".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ROUNDUP_GUARD_RE,
  ROUNDUP_HOWTO_EXCEPTION_RE,
  hasRoundupSignal,
  hasRoundupSignalInUrlOrTitle,
  urlSlugText,
} from "../scripts/lib/roundup-detect.ts";

describe("urlSlugText (#2691 item 4)", () => {
  it("decodifica percent-encoding e substitui separadores por espaço", () => {
    assert.equal(
      urlSlugText("https://example.com/this-week-in%20ai/"),
      " this week in ai ",
    );
  });

  it("retorna string vazia para URL inválida (sem lançar)", () => {
    assert.equal(urlSlugText("not-a-url"), "");
  });
});

describe("hasRoundupSignal (#2691 item 1)", () => {
  it("detecta 'newsletter' como termo isolado", () => {
    assert.ok(hasRoundupSignal("langchain newsletter june 2026"));
  });

  it("detecta 'roundup'", () => {
    assert.ok(hasRoundupSignal("weekly ai roundup june 2026"));
  });

  it("detecta 'this week in'", () => {
    assert.ok(hasRoundupSignal("this week in ai"));
  });

  it("não detecta texto sem sinal de roundup", () => {
    assert.ok(!hasRoundupSignal("how to build agents with langgraph"));
  });
});

describe("ROUNDUP_HOWTO_EXCEPTION_RE (#2691 item 3)", () => {
  it("casa 'build a newsletter'", () => {
    assert.ok(ROUNDUP_HOWTO_EXCEPTION_RE.test("how to build a newsletter with claude"));
  });

  it("casa 'como montar sua newsletter' (PT-BR)", () => {
    assert.ok(ROUNDUP_HOWTO_EXCEPTION_RE.test("como montar sua newsletter"));
  });

  it("casa 'criar uma newsletter' (PT-BR)", () => {
    assert.ok(ROUNDUP_HOWTO_EXCEPTION_RE.test("criar uma newsletter do zero"));
  });

  it("NÃO casa menção solta a 'newsletter' sem verbo de criação antes", () => {
    assert.ok(!ROUNDUP_HOWTO_EXCEPTION_RE.test("june 2026 langchain newsletter"));
  });

  it("hasRoundupSignal: exceção desativa o guard pra how-to genuíno", () => {
    assert.ok(!hasRoundupSignal("how to build a newsletter with claude"));
    assert.ok(!hasRoundupSignal("como montar sua newsletter"));
  });

  it("hasRoundupSignal: exceção NÃO enfraquece detecção de roundup real", () => {
    assert.ok(hasRoundupSignal("june 2026 langchain newsletter"));
    assert.ok(hasRoundupSignal("weekly ai roundup june 2026"));
  });
});

describe("hasRoundupSignalInUrlOrTitle (#2691 item 2 — slug + título simétrico)", () => {
  it("detecta sinal só no slug (título limpo)", () => {
    assert.ok(
      hasRoundupSignalInUrlOrTitle(
        "https://www.langchain.com/blog/june-2026-langchain-newsletter",
        "LangGraph, RAG, and Agents",
      ),
    );
  });

  it("#2691 item 2 FIX: detecta sinal só no título (slug limpo) — antes escapava em isRoundupSlug", () => {
    // Caso que isRoundupSlug (categorize.ts, versão pré-#2691) deixava escapar:
    // slug não tem "newsletter"/"roundup", mas o título é claramente um roundup.
    assert.ok(
      hasRoundupSignalInUrlOrTitle(
        "https://example.com/posts/2026-06-30",
        "AI Weekly Roundup: Models, Tools, and Agents",
      ),
    );
  });

  it("não detecta quando nem slug nem título têm sinal", () => {
    assert.ok(
      !hasRoundupSignalInUrlOrTitle(
        "https://example.com/blog/how-to-build-agents",
        "How to Build Agents with LangGraph",
      ),
    );
  });

  it("URL inválida ainda checa o título", () => {
    assert.ok(hasRoundupSignalInUrlOrTitle("not-a-url", "Weekly AI Roundup"));
  });
});

describe("ROUNDUP_GUARD_RE — regex canônico exportado (#2691 item 1)", () => {
  it("continua acessível pra quem precisa do padrão bruto", () => {
    assert.ok(ROUNDUP_GUARD_RE.test("newsletter"));
    assert.ok(ROUNDUP_GUARD_RE.test("roundup"));
    assert.ok(ROUNDUP_GUARD_RE.test("this-week-in"));
    assert.ok(!ROUNDUP_GUARD_RE.test("weekly"));
  });
});
