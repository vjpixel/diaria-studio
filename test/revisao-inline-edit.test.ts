/**
 * test/revisao-inline-edit.test.ts (#3806, Opção B spike) — cobertura da
 * lógica PURA da edição inline do título de destaque
 * (`scripts/studio-ui/public/revisao-inline-edit.js`). Mesmo padrão de
 * test/revisao-guards.test.ts (#3668): o módulo não toca `document`/`fetch`,
 * testável com fixtures puras, sem DOM real (#633). O DOM-wiring (revisao.js)
 * não é unit-testado, mesma convenção já estabelecida pro resto do painel.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DESTAQUE_HEADLINE_SELECTOR,
  MAX_EDITABLE_DESTAQUES,
  sanitizeInlineTitleText,
  shouldSaveInlineTitle,
  buildDestaqueTitleSavePayload,
  buildInlineTitleConflictMessage,
} from "../scripts/studio-ui/public/revisao-inline-edit.js";

describe("constantes de escopo (#3806)", () => {
  it("DESTAQUE_HEADLINE_SELECTOR mira a MESMA classe do template de produção (a.headline)", () => {
    assert.equal(DESTAQUE_HEADLINE_SELECTOR, "a.headline");
  });

  it("MAX_EDITABLE_DESTAQUES é 3 (regra #3369: edição nunca tem mais que 3 destaques)", () => {
    assert.equal(MAX_EDITABLE_DESTAQUES, 3);
  });
});

describe("sanitizeInlineTitleText", () => {
  it("colapsa quebras de linha em espaço único", () => {
    assert.equal(sanitizeInlineTitleText("Título\ncom\r\nquebras"), "Título com quebras");
  });

  it("colapsa espaços múltiplos", () => {
    assert.equal(sanitizeInlineTitleText("Título   com    espaços"), "Título com espaços");
  });

  it("tira espaço de borda", () => {
    assert.equal(sanitizeInlineTitleText("  Título com bordas  "), "Título com bordas");
  });

  it("null/undefined -> string vazia (nunca lança)", () => {
    assert.equal(sanitizeInlineTitleText(null), "");
    assert.equal(sanitizeInlineTitleText(undefined), "");
  });

  it("string já limpa passa inalterada", () => {
    assert.equal(sanitizeInlineTitleText("Título normal"), "Título normal");
  });
});

describe("shouldSaveInlineTitle", () => {
  it("false quando o texto sanitizado ficou vazio — evita PUT por um blur sem conteúdo", () => {
    assert.equal(shouldSaveInlineTitle("", "Título original"), false);
  });

  it("false quando o texto é idêntico ao original — evita PUT por um blur sem edição real", () => {
    assert.equal(shouldSaveInlineTitle("Título original", "Título original"), false);
  });

  it("true quando o texto mudou e não é vazio", () => {
    assert.equal(shouldSaveInlineTitle("Título novo", "Título original"), true);
  });
});

describe("buildDestaqueTitleSavePayload", () => {
  it("monta o shape esperado pelo server (n, title, expectedModifiedAt)", () => {
    assert.deepEqual(buildDestaqueTitleSavePayload(1, "Título", "2026-01-01T00:00:00.000Z"), {
      n: 1,
      title: "Título",
      expectedModifiedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("expectedModifiedAt ausente/undefined vira null (arquivo ainda não existia no load, mesma convenção de saveCurrent())", () => {
    assert.deepEqual(buildDestaqueTitleSavePayload(2, "Título d2", undefined), {
      n: 2,
      title: "Título d2",
      expectedModifiedAt: null,
    });
  });

  it("expectedModifiedAt já null passa através sem alteração", () => {
    assert.deepEqual(buildDestaqueTitleSavePayload(3, "Título d3", null), {
      n: 3,
      title: "Título d3",
      expectedModifiedAt: null,
    });
  });
});

describe("buildInlineTitleConflictMessage (#3729 — 409 na edição inline)", () => {
  it("menciona o número do destaque e que a edição feita agora foi descartada", () => {
    const msg = buildInlineTitleConflictMessage(2);
    assert.match(msg, /D2/);
    assert.match(msg, /descartada/);
  });

  it("comunica que a versão atual do disco será recarregada (sem opção de forçar sobrescrita, simplificação do spike)", () => {
    const msg = buildInlineTitleConflictMessage(1);
    assert.match(msg, /recarregando a versão atual/);
  });
});
