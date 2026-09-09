/**
 * test/hub-editorial-gate.test.ts (#7101, #7103)
 *
 * Regressão pra `scripts/lib/hub-editorial-gate.ts` — garante que:
 *
 * 1. O cenário que abortou a tentativa registrada em #7101 (comentário
 *    03/09/2026) — `updatedDate` atrás da edição mais recente citada em
 *    `sourceEditions` — é classificado como `needs-editorial-review`
 *    (gate #4911/#5124 esperado), NUNCA como `invalid`/bug.
 * 2. O caso que o guard #5124 existe pra pegar de verdade — uma violação
 *    de OUTRA natureza (ex: FAQ fora do intervalo 6-10) — continua sendo
 *    classificada como `invalid`, mesmo quando ocorre JUNTO com o guard de
 *    `updatedDate` (mistura de causas nunca vira falso "só precisa de
 *    passada editorial").
 * 3. Hub válido (estado atual commitado) classifica `ok`.
 * 4. `checkHubEditorialGate` nunca lança — uma exceção interna vira
 *    `cannot-verify` com o motivo, nunca `ok` nem propagação.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadHubContent } from "../scripts/build-hub-page.ts";
import {
  checkHubEditorialGate,
  classifyHubGateVerdict,
  isEditorialReviewGateViolation,
  type HubEditorialGateResult,
} from "../scripts/lib/hub-editorial-gate.ts";
import type { HubContent } from "../scripts/lib/shared/hub-page.ts";

describe("isEditorialReviewGateViolation (#7101/#7103)", () => {
  it("reconhece a mensagem exata do guard #4911/#5124", () => {
    assert.equal(
      isEditorialReviewGateViolation(
        'updatedDate "2026-08-27" é anterior à edição mais recente citada em sourceEditions ("2026-08-31")',
      ),
      true,
    );
  });

  it("reconhece a mensagem exata de checkNoFutureDates (hub-fact-gate.ts) — 2ª linha do erro colado em #7101", () => {
    assert.equal(
      isEditorialReviewGateViolation('faq[0].answer: data "31/08/2026" (2026-08-31) é posterior a updatedDate (2026-08-27)'),
      true,
    );
    assert.equal(
      isEditorialReviewGateViolation(
        'sections[1].paragraphs[2]: data "6 de agosto de 2026" (2026-08-06) é posterior a updatedDate (2026-08-04)',
      ),
      true,
    );
  });

  it("não casa outras violações de validateHubContent", () => {
    assert.equal(isEditorialReviewGateViolation("faq tem 3 perguntas — issue #4558 item 3 pede 6-10"), false);
    assert.equal(isEditorialReviewGateViolation('updatedDate "2026-08-27" é anterior a publishedDate "2026-09-01"'), false);
  });
});

describe("classifyHubGateVerdict (#7101/#7103)", () => {
  it("ok quando não há violações", () => {
    assert.equal(classifyHubGateVerdict([]), "ok");
  });

  it("needs-editorial-review quando TODAS as violações são o guard #4911/#5124", () => {
    assert.equal(
      classifyHubGateVerdict([
        'updatedDate "2026-08-27" é anterior à edição mais recente citada em sourceEditions ("2026-08-31")',
      ]),
      "needs-editorial-review",
    );
  });

  it("invalid quando há QUALQUER violação fora do guard — mesmo misturada com ele", () => {
    assert.equal(
      classifyHubGateVerdict([
        'updatedDate "2026-08-27" é anterior à edição mais recente citada em sourceEditions ("2026-08-31")',
        "faq tem 3 perguntas — issue #4558 item 3 pede 6-10",
      ]),
      "invalid",
    );
  });

  it("invalid quando a única violação já não é o guard", () => {
    assert.equal(classifyHubGateVerdict(["sections está vazio — hub sem nenhuma seção narrativa"]), "invalid");
  });
});

describe("checkHubEditorialGate — sobre conteúdo REAL commitado (#7101/#7103)", () => {
  const REAL_SLUG = "anthropic-claude";
  const realHub = loadHubContent(REAL_SLUG);

  it("hub válido (estado atual) classifica ok", () => {
    const result = checkHubEditorialGate(REAL_SLUG, realHub);
    assert.equal(result.verdict, "ok");
    assert.deepEqual(result.violations, []);
  });

  it("updatedDate voltado pra antes da edição mais recente citada → needs-editorial-review (cenário exato de #7101)", () => {
    // >= publishedDate (não trip o guard IRMÃO "updatedDate anterior a
    // publishedDate") e < sourceEditions[0].date (trip SÓ o guard alvo).
    assert.ok(realHub.publishedDate < realHub.sourceEditions[0].date, "fixture pressupõe publishedDate < sourceEditions[0].date");
    const staleHub: HubContent = { ...realHub, updatedDate: realHub.publishedDate };
    const result = checkHubEditorialGate(REAL_SLUG, staleHub);
    assert.equal(result.verdict, "needs-editorial-review");
    // Regredir updatedDate pra publishedDate também empurra qualquer data
    // absoluta citada na prosa (intro/seções/FAQ) pro "futuro" em relação a
    // updatedDate (checkNoFutureDates, hub-fact-gate.ts) — mesma causa raiz,
    // efeito em cascata. O que importa pro classificador é que TODAS as
    // violações, sejam quantas forem, pertencem ao gate #4911/#5124.
    assert.ok(result.violations.length >= 1);
    for (const v of result.violations) assert.ok(isEditorialReviewGateViolation(v), `violação fora do gate esperado: ${v}`);
  });

  it("updatedDate voltado + faq fora do intervalo → invalid (o guard #5124 continua pegando defeito real)", () => {
    const brokenHub: HubContent = {
      ...realHub,
      updatedDate: realHub.publishedDate,
      faq: realHub.faq.slice(0, 2),
    };
    const result = checkHubEditorialGate(REAL_SLUG, brokenHub);
    assert.equal(result.verdict, "invalid");
    assert.ok(result.violations.length >= 2);
  });

  it("exceção interna nunca propaga — vira cannot-verify com o motivo", () => {
    // Proxy que lança em QUALQUER acesso a propriedade — simula um
    // `HubContent` malformado ao ponto de `validateHubContent` não
    // conseguir nem ler o 1º campo, sem precisar prever qual campo é lido
    // primeiro (acoplaria este teste à ordem interna de `validateHubContent`).
    const throwingHub = new Proxy(
      {},
      {
        get() {
          throw new Error("boom — simulação de HubContent malformado");
        },
      },
    ) as unknown as HubContent;
    const result: HubEditorialGateResult = checkHubEditorialGate("fixture-quebrada", throwingHub);
    assert.equal(result.verdict, "cannot-verify");
    assert.equal(result.violations.length, 0);
    assert.match(result.cannotVerifyReason ?? "", /boom/);
  });
});
