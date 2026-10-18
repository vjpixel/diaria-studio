/**
 * test/starry-night-ran-10375.test.ts (#10375)
 *
 * 2:1 `--force` falha (apaga o nativo) e `--ratio 4x5 --force` gera um
 * 4x5-nativo novo: `changed=false`, mas o md5 do 4x5 novo é da regeneração.
 * O orchestrator informa o comando que saiu com exit 0 (`--estilo-regen-ran`).
 * Sem o registro, a arte trocada pelo editor (#10335) continua sem herdar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeCropReviewResult, planEstiloRegeneration, parseEstiloRegenRan } from "../scripts/run-image-crop-reviewer.ts";

const estilo = (ratio: "1x1" | "4x5") =>
  normalizeCropReviewResult(
    { results: [{ destaque: "d1", ratio, status: "warn", categoria: "estilo", motivo: "espiral" }] },
    "261018",
  );

function scenario(ran: string) {
  const md5: Record<string, string> = { "2x1": "2x1-v1", "1x1": "1x1-v1", "4x5": "nativo-v1" };
  const cur = (_d: string, r: string) => md5[r] ?? null;
  const p1 = planEstiloRegeneration(estilo("4x5"), {}, () => false, cur);
  // 2:1 falha (md5 do 2:1 igual); 4:5 nativo novo aparece
  md5["4x5"] = "nativo-v2";
  const p2 = planEstiloRegeneration(estilo("4x5"), p1.state, () => false, cur, 1, parseEstiloRegenRan(ran));
  return p2;
}

describe("#10375: --estilo-regen-ran", () => {
  it("4:5 gerado com exit 0 e 2:1 falho: md5 novo entra em images e o teto segura", () => {
    const p2 = scenario("d1:4x5");
    assert.ok((p2.state.images?.d1 ?? []).includes("nativo-v2"));
    assert.equal(p2.state.failed?.d1, 1);
    assert.deepEqual(p2.regenerate, ["d1"], "1ª falha ganha nova chance");
    // novo ciclo: segue falhando e 4:5 gerando de novo → termina em exhausted
    const md5 = { "2x1": "2x1-v1", "1x1": "1x1-v1", "4x5": "nativo-v2" } as Record<string, string>;
    const cur = (_d: string, r: string) => md5[r] ?? null;
    md5["4x5"] = "nativo-v3";
    const p3 = planEstiloRegeneration(estilo("4x5"), p2.state, () => false, cur, 1, parseEstiloRegenRan("d1:4x5"));
    assert.deepEqual(p3.exhausted, ["d1"], "loop não é infinito");
  });

  it("sem registro de comando (arte trocada pelo editor) não herda a contagem", () => {
    const p2 = scenario("");
    assert.ok(!(p2.state.images?.d1 ?? []).includes("nativo-v2"));
  });

  it("registro de outro ratio (só 2x1) não confia no 4x5", () => {
    const p2 = scenario("d1:2x1");
    assert.ok(!(p2.state.images?.d1 ?? []).includes("nativo-v2"));
  });

  it("parseEstiloRegenRan rejeita token inválido", () => {
    assert.throws(() => parseEstiloRegenRan("d4:4x5"));
    assert.throws(() => parseEstiloRegenRan("d1:card"));
    assert.deepEqual(parseEstiloRegenRan("d1:2x1,d1:4x5"), { d1: ["2x1", "4x5"] });
  });
});
