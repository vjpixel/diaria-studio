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
    assert.match(errs([YT, OUT, { ...SOBERANA, name: "Diaria comentada_Vertical_V1" }]).join("\n"), /precisa terminar em -soberana/);
  });

  it("recusa corte que não é slug", () => {
    assert.match(errs([YT, OUT, { ...SOBERANA, corte: "IA Soberana", name: "Diaria comentada_Vertical_V1-IA Soberana" }]).join("\n"), /corte precisa ser um slug/);
  });

  it("o target interno continua único", () => {
    assert.match(errs([YT, OUT, { ...SOBERANA, target: "outras-redes" }]).join("\n"), /target outras-redes repetido/);
  });
});
