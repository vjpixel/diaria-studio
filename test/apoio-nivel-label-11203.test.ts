import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NIVEL_LABEL, type ApoioNivelId } from "../scripts/lib/shared/apoio-nivel-label.ts";
import { isApoioNivel, type ApoioNivel } from "../scripts/lib/shared/apoio-nivel-types.ts";
import type { RewardGroup } from "../scripts/studio-ui/studio-apoios.ts";

// #11205: os 3 nomes de tipo são a MESMA união (falha no typecheck de test/**
// se alguma voltar a ser declarada à parte e divergir).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _idIsNivel: Same<ApoioNivelId, ApoioNivel> = true;
const _groupIsNivel: Same<RewardGroup, ApoioNivel> = true;
void _idIsNivel;
void _groupIsNivel;

describe("#11203 — rótulos públicos dos níveis de apoio", () => {
  it("mapa cobre os 4 ids internos com os nomes novos", () => {
    assert.deepEqual(NIVEL_LABEL, {
      amigo: "Comunidade",
      apoiador: "Clube",
      mantenedor: "Conselho",
      patrono: "Núcleo",
    });
  });

  it("toda chave de NIVEL_LABEL é um ApoioNivel válido (#11205)", () => {
    for (const id of Object.keys(NIVEL_LABEL)) assert.ok(isApoioNivel(id), id);
    assert.equal(Object.keys(NIVEL_LABEL).length, 4);
  });

  it("LEVEL_NAME do Studio (JS cru) espelha o mapa", () => {
    const js = readFileSync(new URL("../scripts/studio-ui/public/apoios.js", import.meta.url), "utf8");
    for (const [id, label] of Object.entries(NIVEL_LABEL)) {
      assert.ok(js.includes(`${id}: "${label}"`), `apoios.js sem ${id}: "${label}"`);
    }
  });
});
