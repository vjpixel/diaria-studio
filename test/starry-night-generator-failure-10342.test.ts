/**
 * test/starry-night-generator-failure-10342.test.ts (#10342)
 *
 * Com o 4:5 acusado sobre a arte nativa, o 1º comando de regeneração
 * (`image-generate.ts --force`) apaga `04-dN-4x5-nativo.jpg`/`04-dN-master.jpg`
 * ANTES de chamar o gerador (#6010). Gerador fora → o 2:1 fica intacto, mas o
 * md5 do 4:5 passa a resolver a variante `2x1` (#10325) e difere do `pending`.
 * O plano contava isso como regeneração (`attempts` +1, "esgotou") em vez de
 * falha do gerador (`failed` +1, nova chance).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  normalizeCropReviewResult,
  stampCropReviewImageHashes,
  planEstiloRegeneration,
  MAX_ESTILO_REGEN_FAILED_RUNS,
} from "../scripts/run-image-crop-reviewer.ts";

const ROOT = join(import.meta.dirname, "..");
let dir: string;

const ESTILO_D1_4X5 = {
  results: [{ destaque: "d1", ratio: "4x5", status: "warn", categoria: "estilo", motivo: "espiral no céu" }],
};

function img(name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

function persist(raw: unknown): void {
  const result = stampCropReviewImageHashes(normalizeCropReviewResult(raw, "261016"), dir);
  writeFileSync(join(dir, "_internal", "04-crop-review.json"), JSON.stringify(result, null, 2));
}

function plan(): { regenerate: string[]; exhausted: string[]; attempts: Record<string, number> } {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", join(ROOT, "scripts", "run-image-crop-reviewer.ts"), "--edition-dir", dir, "--estilo-regen-plan"],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function state(): { attempts?: Record<string, number>; failed?: Record<string, number> } {
  return JSON.parse(readFileSync(join(dir, "_internal", "04-estilo-regen.json"), "utf8"));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "starry-10342-"));
  mkdirSync(join(dir, "_internal"));
  img("04-d1-2x1.jpg", "d1-2x1-v1");
  img("04-d1-1x1.jpg", "d1-1x1-v1");
  img("04-d1-4x5-nativo.jpg", "d1-nativo-v1");
  img("04-d1-master.jpg", "d1-master-v1");
  img("04-d1-4x5.jpg", "d1-card-v1");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("#10342: falha do gerador não gasta a tentativa de regeneração", () => {
  it("cenário da issue (CLI): derivados apagados, gerador fora → failed, nova chance", () => {
    persist(ESTILO_D1_4X5);
    assert.deepEqual(plan().regenerate, ["d1"]);

    // image-generate --force apaga os derivados (#6010) e o gerador falha;
    // gen-social-card-4x5 recompõe o card a partir do 2:1 antigo.
    rmSync(join(dir, "04-d1-4x5-nativo.jpg"));
    rmSync(join(dir, "04-d1-master.jpg"));
    img("04-d1-4x5.jpg", "d1-card-recomposto-do-2x1");
    persist(ESTILO_D1_4X5);

    const p2 = plan();
    assert.deepEqual(p2.regenerate, ["d1"], "falha do gerador ganha nova chance");
    assert.deepEqual(p2.exhausted, []);
    assert.equal(state().attempts?.d1 ?? 0, 0, "nenhuma imagem nova: tentativa não gasta");
    assert.equal(state().failed?.d1, 1);

    // gerador continua fora → esgota pelo teto de falhas (o loop termina)
    persist(ESTILO_D1_4X5);
    const p3 = plan();
    assert.deepEqual(p3.exhausted, ["d1"]);
    assert.equal(state().failed?.d1, MAX_ESTILO_REGEN_FAILED_RUNS + 1);
  });

  it("gerador funcionou (2:1 novo) → attempts +1, como antes", () => {
    persist(ESTILO_D1_4X5);
    assert.deepEqual(plan().regenerate, ["d1"]);
    img("04-d1-2x1.jpg", "d1-2x1-v2");
    img("04-d1-1x1.jpg", "d1-1x1-v2");
    img("04-d1-4x5-nativo.jpg", "d1-nativo-v2");
    rmSync(join(dir, "04-d1-master.jpg"));
    img("04-d1-4x5.jpg", "d1-card-v2");
    persist(ESTILO_D1_4X5);
    const p2 = plan();
    assert.deepEqual(p2.exhausted, ["d1"]);
    assert.equal(p2.attempts.d1, 1);
    assert.equal(state().failed?.d1 ?? 0, 0);
  });

  it("puro: variante do 4:5 muda sem o 2:1 mudar → failed", () => {
    const result = normalizeCropReviewResult(ESTILO_D1_4X5, "261016");
    const md5: Record<string, string | null> = { "2x1": "base-v1", "4x5": "nativo-v1", "1x1": "1x1-v1" };
    const cur = (_d: string, r: string) => md5[r] ?? null;
    const p1 = planEstiloRegeneration(result, {}, () => false, cur);
    assert.equal(p1.state.pendingBase?.d1, "base-v1");
    md5["4x5"] = "base-v1"; // nativo apagado: o 4:5 agora resolve o 2:1
    const p2 = planEstiloRegeneration(result, p1.state, () => false, cur);
    assert.deepEqual(p2.regenerate, ["d1"]);
    assert.equal(p2.state.failed?.d1, 1);
    assert.equal(p2.attempts.d1 ?? 0, 0);
  });

  it("puro: estado sem pendingBase (legado) mantém a comparação por ratio", () => {
    const result = normalizeCropReviewResult(ESTILO_D1_4X5, "261016");
    const p = planEstiloRegeneration(
      result,
      { pending: { d1: { "4x5": "velho" } } },
      () => false,
      (_d, r) => (r === "4x5" ? "novo" : null),
    );
    assert.equal(p.attempts.d1, 1);
  });
});
