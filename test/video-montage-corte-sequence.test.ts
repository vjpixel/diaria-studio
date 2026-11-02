/**
 * Vertical extra como corte (261103): o editor gravou 2 verticais, a da notícia
 * (a vertical da edição) e uma sobre IA soberana, que sai pelo modo corte do
 * `publish-shorts.ts`. O nome dela é o da vertical normal com `-soberana` no
 * fim; antes, o `blocks.json` recusava porque o nome não batia com o `target`
 * interno (único por plano).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultSequences, parseBlocksFile } from "../scripts/lib/diaria/video-montage.ts";

const [YT, OUT] = defaultSequences();
const SOBERANA = { ...OUT, target: "instagram", name: "Diaria comentada_Vertical_V1-soberana", corte: "soberana" };
const file = (sequences: unknown[]) => ({ edition: "261103", sequences, blocks: { comentario: [{ start: 1, end: 2 }] } });
const errs = (sequences: unknown[]) => {
  const r = parseBlocksFile(file(sequences));
  return r.ok ? [] : r.errors;
};

describe("sequência de corte no blocks.json", () => {
  it("aceita a 2ª vertical com o nome normal + -soberana", () => {
    assert.deepEqual(errs([YT, OUT, SOBERANA]), []);
  });

  it("sem corte, o mesmo nome continua recusado (o export cairia no destino errado)", () => {
    const { corte: _c, ...semCorte } = SOBERANA;
    assert.match(errs([YT, OUT, semCorte]).join("\n"), /não indica o destino instagram/);
  });

  it("recusa corte cujo nome não termina em -{corte}", () => {
    assert.match(errs([YT, OUT, { ...SOBERANA, name: "Diaria comentada_Vertical_V1" }]).join("\n"), /precisa terminar em _V{n}-soberana/);
  });

  it("recusa corte que não é slug", () => {
    assert.match(errs([YT, OUT, { ...SOBERANA, corte: "IA Soberana", name: "Diaria comentada_Vertical_V1-IA Soberana" }]).join("\n"), /corte precisa ser um slug/);
  });

  it("a identidade é o corte (#11900): o corte pode repetir o destino da vertical da edição, o slug não repete", () => {
    assert.deepEqual(errs([YT, OUT, { ...SOBERANA, target: "outras-redes" }]), []);
    assert.match(errs([YT, OUT, SOBERANA, { ...SOBERANA, target: "outras-redes" }]).join("\n"), /corte soberana repetido/);
    // Sem corte, o destino segue único.
    assert.match(errs([YT, OUT, OUT]).join("\n"), /target outras-redes repetido/);
  });
});

describe("nome de corte não é a vertical da edição", () => {
  it("corteSuffixOf lê o slug; videoTargetOf devolve null", async () => {
    const { corteSuffixOf, videoTargetOf } = await import("../scripts/lib/diaria/drive-video-source.ts");
    assert.equal(corteSuffixOf("Diaria comentada_Vertical_V1-soberana.mp4"), "soberana");
    assert.equal(videoTargetOf("Diaria comentada_Vertical_V1-soberana.mp4"), null);
    assert.equal(corteSuffixOf("Diaria comentada_Vertical_V1.mp4"), null);
    assert.equal(videoTargetOf("Diaria comentada_Vertical_V1.mp4"), "outras-redes");
  });

  it("review-final manda o export do corte para a sequência do corte, nunca para a vertical da edição", async () => {
    const { reviewFinalTarget } = await import("../scripts/video-montagem.ts");
    const specs = [YT, OUT, SOBERANA] as Parameters<typeof reviewFinalTarget>[2];
    assert.equal(reviewFinalTarget("x/Diaria comentada_Vertical_V1-soberana.mp4", undefined, specs), "instagram");
    assert.equal(reviewFinalTarget("x/Diaria comentada_Vertical_V1.mp4", undefined, specs), "outras-redes");
    assert.throws(() => reviewFinalTarget("x/Diaria comentada_Vertical_V1-soberana.mp4", undefined, [YT, OUT]), /corte "soberana"/);
  });

  it("corte é vertical e nunca youtube", () => {
    assert.match(errs([OUT, { ...SOBERANA, target: "youtube" }]).join("\n"), /target instagram ou outras-redes/);
    assert.match(errs([YT, OUT, { ...SOBERANA, width: 1920, height: 1080 }]).join("\n"), /height > width/);
  });
});
