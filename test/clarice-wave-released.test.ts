import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isWaveReleased,
  readWaveReleasedMarker,
  waveReleasedRefusal,
  writeWaveReleasedMarker,
} from "../scripts/lib/clarice-wave-released.ts";

// #9761 — onda liberada (seleção devolvida à fila) nunca pode ser retomada.
test("marcador de onda liberada: grava, detecta, e a recusa cita data/contagem e o risco de envio duplo", () => {
  const dir = mkdtempSync(join(tmpdir(), "wave-released-"));
  assert.equal(isWaveReleased(dir, "d1-sab03"), false);
  writeWaveReleasedMarker(dir, { group: "d1-sab03", releasedAt: "2026-10-06T18:00:00.000Z", count: 18700, reason: "teste" });
  assert.equal(isWaveReleased(dir, "d1-sab03"), true);
  assert.equal(isWaveReleased(dir, "d1-dom04"), false);
  assert.equal(readWaveReleasedMarker(dir, "d1-sab03")?.count, 18700);
  const msg = waveReleasedRefusal(dir, "d1-sab03");
  assert.match(msg, /LIBERADA em 2026-10-06T18:00:00.000Z \(18700 contato/);
  assert.match(msg, /envio duplo/);
});
