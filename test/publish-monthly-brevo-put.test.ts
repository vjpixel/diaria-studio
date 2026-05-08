import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regressão (#1025): publish-monthly.ts usava PATCH pra `/emailCampaigns/{id}`,
 * que o Brevo rejeita com 404 "Invalid route/method passed". O método correto
 * pra updates de email campaign é PUT (verificado empiricamente em 2026-05-08).
 *
 * Esses testes lock-in o método correto via inspeção estática do source. Se
 * alguém reintroduzir `method: "PATCH"` no arquivo (intencionalmente ou via
 * refactor automático), o teste falha.
 *
 * Inspeção estática (e não mock de fetch) é a abordagem certa aqui porque:
 *   - O bug é literal-string-no-código ("PATCH" vs "PUT")
 *   - publish-monthly.ts ainda não tem infraestrutura de teste (#1024)
 *   - Mock de fetch globalmente neste arquivo seria invasivo só pra isso
 */

const SCRIPT_PATH = resolve(import.meta.dirname, "..", "scripts", "publish-monthly.ts");
const SRC = readFileSync(SCRIPT_PATH, "utf8");

describe("publish-monthly: Brevo /emailCampaigns/{id} method (#1025)", () => {
  it("não usa method: \"PATCH\" em chamadas fetch", () => {
    // Procura literalmente pela string `method: "PATCH"` no source.
    // Se alguém reintroduzir, esse teste falha.
    const hasPatch = /method:\s*["']PATCH["']/.test(SRC);
    assert.equal(
      hasPatch,
      false,
      "scripts/publish-monthly.ts não deve usar method: \"PATCH\" — Brevo /emailCampaigns/{id} requer PUT (#1025).",
    );
  });

  it("usa method: \"PUT\" no helper brevoPut", () => {
    // Garante que existe pelo menos uma chamada PUT (substituiu o PATCH antigo).
    const hasPut = /method:\s*["']PUT["']/.test(SRC);
    assert.equal(
      hasPut,
      true,
      "scripts/publish-monthly.ts precisa usar method: \"PUT\" pra updates de campanha Brevo.",
    );
  });

  it("brevoPut é a função de update (não brevoPatch)", () => {
    // Função renomeada de brevoPatch → brevoPut em #1025. Lock-in do nome
    // pra evitar reintrodução acidental.
    assert.match(
      SRC,
      /async function brevoPut\(/,
      "Função brevoPut deve existir em publish-monthly.ts.",
    );
    assert.doesNotMatch(
      SRC,
      /async function brevoPatch\(/,
      "Função brevoPatch foi renomeada pra brevoPut em #1025; não deve mais existir.",
    );
  });

  it("--schedule-at e --update-existing usam brevoPut (não brevoPatch)", () => {
    // Esses 2 callsites são onde o bug se manifestava. Lock-in do callsite.
    const patchCallsites = SRC.match(/brevoPatch\s*\(/g);
    assert.equal(
      patchCallsites,
      null,
      "Não deve ter callsites de brevoPatch em publish-monthly.ts.",
    );
    const putCallsites = SRC.match(/brevoPut\s*\(/g);
    assert.ok(
      putCallsites !== null && putCallsites.length >= 2,
      `Esperava ≥2 callsites de brevoPut (--schedule-at e --update-existing); achou ${putCallsites?.length ?? 0}.`,
    );
  });
});
