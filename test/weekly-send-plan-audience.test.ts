/**
 * #2974: helpers puros de scripts/weekly-send-plan-audience.ts (Parte 2 local).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVolumesArg, sliceIntoVolumes } from "../scripts/weekly-send-plan-audience.ts";

test("parseVolumesArg — 3 inteiros válidos", () => {
  assert.deepEqual(parseVolumesArg("7000,7500,8000"), [7000, 7500, 8000]);
});

test("parseVolumesArg — rejeita contagem != 3, não-inteiros, <=0, ausente", () => {
  assert.equal(parseVolumesArg("7000,7500"), null);
  assert.equal(parseVolumesArg("7000,7500,8000,9000"), null);
  assert.equal(parseVolumesArg("7000,abc,8000"), null);
  assert.equal(parseVolumesArg("7000,-1,8000"), null);
  assert.equal(parseVolumesArg("7000,7500.5,8000"), null);
  assert.equal(parseVolumesArg(undefined), null);
});

test("sliceIntoVolumes — respeita a ordem e os tamanhos pedidos", () => {
  const ordered = Array.from({ length: 10 }, (_, i) => i);
  const groups = sliceIntoVolumes(ordered, [3, 4, 2]);
  assert.deepEqual(groups, [[0, 1, 2], [3, 4, 5, 6], [7, 8]]);
});

test("sliceIntoVolumes — audiência menor que o pedido: últimos grupos ficam menores/vazios", () => {
  const ordered = [0, 1, 2, 3];
  const groups = sliceIntoVolumes(ordered, [3, 3, 3]);
  assert.deepEqual(groups, [[0, 1, 2], [3], []]);
});
