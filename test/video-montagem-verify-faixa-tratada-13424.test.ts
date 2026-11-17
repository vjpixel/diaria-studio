/**
 * #13424: o verify-xml mede as bordas na faixa tratada (a que o XML toca) quando
 * ela existe, e no bruto quando não há faixa (fallback).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { treatedEdgeEnvelope } from "../scripts/video-montagem.ts";
import { maxDbIn } from "../scripts/lib/diaria/video-cut-refine.ts";

const SR = 16000;
/** WAV PCM16 mono: piso `floor` e tom de `speech` em [a,b) s. */
function wav(durationS: number, floor: number, speech: [number, number], amp = 3000): Buffer {
  const n = Math.round(durationS * SR);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const a = t >= speech[0] && t < speech[1] ? amp : floor;
    buf.writeInt16LE(Math.round(a * Math.sin(2 * Math.PI * 220 * t)), 44 + i * 2);
  }
  return buf;
}

describe("#13424 treatedEdgeEnvelope", () => {
  const dir = mkdtempSync(join(tmpdir(), "t13424-"));
  const ctx = { workDir: dir } as never;

  it("com faixa tratada mede nela (piso mais baixo que o do bruto)", () => {
    const treated = join(dir, "tratada.wav");
    writeFileSync(treated, wav(6, 1, [2, 4]));
    const r = treatedEdgeEnvelope(ctx, "v1", treated);
    assert.ok(r.env, "envoltória da tratada");
    assert.equal(r.warning, undefined);
    assert.ok(maxDbIn(r.env!, 4.5, 5.5) < -70, "silêncio da tratada medido nela");
    assert.ok(maxDbIn(r.env!, 2.5, 3.5) > -30, "fala medida");
  });

  it("sem faixa tratada registrada: fallback silencioso para o bruto", () => {
    assert.deepEqual(treatedEdgeEnvelope(ctx, "v1", undefined), { env: null });
  });

  it("faixa registrada mas ausente: fallback para o bruto com aviso", () => {
    const r = treatedEdgeEnvelope(ctx, "v1", join(dir, "nao-existe.wav"));
    assert.equal(r.env, null);
    assert.match(r.warning ?? "", /ausente/);
  });

  it("faixa ilegível: fallback para o bruto com aviso", () => {
    const bad = join(dir, "ruim.wav");
    writeFileSync(bad, "nao e wav");
    const r = treatedEdgeEnvelope(ctx, "v1", bad);
    assert.equal(r.env, null);
    assert.match(r.warning ?? "", /ilegível/);
    rmSync(dir, { recursive: true, force: true });
  });
});
