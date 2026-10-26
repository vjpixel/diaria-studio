import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NIVEL_LABEL } from "../scripts/lib/shared/apoio-nivel-label.ts";

describe("#11203 — rótulos públicos dos níveis de apoio", () => {
  it("mapa cobre os 4 ids internos com os nomes novos", () => {
    assert.deepEqual(NIVEL_LABEL, {
      amigo: "Comunidade",
      apoiador: "Clube",
      mantenedor: "Conselho",
      patrono: "Núcleo",
    });
  });

  it("LEVEL_NAME do Studio (JS cru) espelha o mapa", () => {
    const js = readFileSync(new URL("../scripts/studio-ui/public/apoios.js", import.meta.url), "utf8");
    for (const [id, label] of Object.entries(NIVEL_LABEL)) {
      assert.ok(js.includes(`${id}: "${label}"`), `apoios.js sem ${id}: "${label}"`);
    }
  });
});
