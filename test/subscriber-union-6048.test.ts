/**
 * test/subscriber-union-6048.test.ts (#6048)
 *
 * O invariante central: **falha de uma fonte NUNCA pode virar
 * "não-assinante"**.
 *
 * Foi a condição explícita da decisão do editor (26/08). O modo de falha que
 * ela impede é silencioso e injusto: o votante perde o crédito de assinante
 * porque uma API estava fora do ar, e ninguém fica sabendo. Uma fonte
 * quebrada não sabe que a pessoa não é assinante — ela não sabe nada.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSubscriberUnion,
  resolveSubscriberUnionDetailed,
  type SubscriberVerifyState,
} from "../scripts/lib/shared/subscriber-union.ts";

describe("#6048 resolveSubscriberUnion — positivo de qualquer fonte basta", () => {
  it("active em QUALQUER posição vence", () => {
    assert.equal(resolveSubscriberUnion(["active", "unknown"]), "active");
    assert.equal(resolveSubscriberUnion(["unknown", "active"]), "active");
    assert.equal(resolveSubscriberUnion(["inactive", "active"]), "active");
    assert.equal(resolveSubscriberUnion(["verification_failed", "active"]), "active");
  });

  it("é o caso que a migração exige: só-Kit ativo, Beehiiv não conhece", () => {
    // Quem cadastrou pelo Kit não está no KV da Beehiiv. Sem união, viraria
    // "não-assinante" — e essa fatia só cresce.
    assert.equal(resolveSubscriberUnion(["unknown", "unknown", "active"]), "active");
  });

  it("e o inverso: legado ativo na Beehiiv, ausente no Kit", () => {
    // Os 585 importados. Sem união, migrar a leitura pro Kit os apagaria.
    assert.equal(resolveSubscriberUnion(["active", "unknown"]), "active");
  });
});

describe("#6048 o invariante: fonte quebrada NUNCA vira não-assinante", () => {
  it("verification_failed + unknown ⇒ verification_failed, NÃO unknown", () => {
    // A fonte quebrada podia ser justamente a que diria "active".
    assert.equal(resolveSubscriberUnion(["verification_failed", "unknown"]), "verification_failed");
  });

  it("verification_failed + inactive ⇒ verification_failed, NÃO inactive", () => {
    // Nem mesmo um "inactive" real de outra fonte autoriza concluir o
    // negativo enquanto uma fonte está cega — sob partição por origem, cada
    // pessoa vive numa base só, então a cega pode ser a dela.
    assert.equal(resolveSubscriberUnion(["verification_failed", "inactive"]), "verification_failed");
  });

  it("REGRESSÃO: nenhuma combinação com falha e sem active devolve unknown/inactive", () => {
    const semActive: SubscriberVerifyState[][] = [
      ["verification_failed"],
      ["verification_failed", "unknown"],
      ["unknown", "verification_failed"],
      ["verification_failed", "inactive"],
      ["inactive", "verification_failed", "unknown"],
      ["verification_failed", "verification_failed"],
    ];
    for (const combo of semActive) {
      assert.equal(
        resolveSubscriberUnion(combo),
        "verification_failed",
        `combinação ${JSON.stringify(combo)} escondeu a falha`,
      );
    }
  });

  it("mas falha NÃO derruba um active — positivo é conclusivo sozinho", () => {
    assert.equal(resolveSubscriberUnion(["active", "verification_failed"]), "active");
  });
});

describe("#6048 respostas negativas reais", () => {
  it("todas unknown ⇒ unknown", () => {
    assert.equal(resolveSubscriberUnion(["unknown", "unknown"]), "unknown");
  });

  it("inactive + unknown ⇒ inactive (alguém de fato verificou)", () => {
    assert.equal(resolveSubscriberUnion(["inactive", "unknown"]), "inactive");
    assert.equal(resolveSubscriberUnion(["unknown", "inactive"]), "inactive");
  });

  it("lista vazia ⇒ unknown, nunca inactive", () => {
    // Nenhuma fonte consultada ≠ "verificamos e não achamos".
    assert.equal(resolveSubscriberUnion([]), "unknown");
  });
});

describe("#6048 resolveSubscriberUnionDetailed — diagnóstico não pode sumir", () => {
  it("registra QUAL fonte deu o active (mede a migração sem instrumentar nada novo)", () => {
    const o = resolveSubscriberUnionDetailed([
      { source: "kv", state: "unknown" },
      { source: "kit", state: "active" },
    ]);
    assert.equal(o.state, "active");
    assert.equal(o.activeSource, "kit");
  });

  it("lista as fontes que falharam mesmo quando o veredicto é active", () => {
    // Degradação parcial não pode sumir dentro de um resultado bem-sucedido.
    const o = resolveSubscriberUnionDetailed([
      { source: "kv", state: "verification_failed" },
      { source: "beehiiv", state: "verification_failed" },
      { source: "kit", state: "active" },
    ]);
    assert.equal(o.state, "active");
    assert.deepEqual(o.failedSources, ["kv", "beehiiv"]);
  });

  it("sem active, activeSource fica ausente — não inventa origem", () => {
    const o = resolveSubscriberUnionDetailed([{ source: "kv", state: "unknown" }]);
    assert.equal(o.activeSource, undefined);
  });

  it("preserva todas as respostas na ordem consultada", () => {
    const results = [
      { source: "kv", state: "unknown" as const },
      { source: "beehiiv", state: "inactive" as const },
    ];
    assert.deepEqual(resolveSubscriberUnionDetailed(results).results, results);
  });

  it("concorda com a função simples em todas as combinações", () => {
    const estados: SubscriberVerifyState[] = ["active", "inactive", "unknown", "verification_failed"];
    for (const a of estados) {
      for (const b of estados) {
        const detalhado = resolveSubscriberUnionDetailed([
          { source: "x", state: a },
          { source: "y", state: b },
        ]);
        assert.equal(detalhado.state, resolveSubscriberUnion([a, b]), `divergiu em ${a}+${b}`);
      }
    }
  });
});
