/**
 * test/check-brevo-diaria-guardrail-6799.test.ts (#6799)
 *
 * As 3 execuções de 30/08/2026 (03:00, 07:00, 11:00 UTC) do guardrail
 * morreram todas com:
 *
 *   [check-brevo-diaria-guardrail] erro: SyntaxError: Expected
 *   double-quoted property name in JSON at position 10550 (line 92 column 1)
 *
 * Causa: `main()` fazia `JSON.parse(readFileSync(PLATFORM_CONFIG_PATH))`
 * SEM try/catch — o único ponto do fluxo principal do script capaz de
 * deixar um `SyntaxError` cru propagar até `process.exitCode=1`. Exit≠0
 * por erro PRÓPRIO (JSON local corrompido), não por detecção de breach —
 * o guardrail da cota Brevo não estava guardando nada.
 *
 * Este teste cobre `loadPlatformConfig` (extraída pra ser testável em
 * isolamento): JSON corrompido vira `PlatformConfigError` catchable com
 * mensagem clara, nunca um `SyntaxError` cru não-tratado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlatformConfig, PlatformConfigError } from "../scripts/check-brevo-diaria-guardrail.ts";

test("loadPlatformConfig — JSON corrompido lança PlatformConfigError (catchable), nunca um SyntaxError cru", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-brevo-diaria-guardrail-6799-"));
  try {
    const path = join(dir, "platform.config.json");
    // Reproduz a classe de corrupção da issue: JSON com shape quebrado
    // (chave sem aspas / objeto concatenado) — não precisa ser byte-a-byte
    // idêntico ao incidente real pra provar o comportamento do guard.
    writeFileSync(path, '{ "brevo_diaria": { api_key_env: "X" } }{ "extra": true }');

    assert.throws(
      () => loadPlatformConfig(path),
      (e: unknown) => {
        assert.ok(e instanceof PlatformConfigError, "deveria lançar PlatformConfigError, não um SyntaxError cru");
        assert.match((e as Error).message, /não parseia como JSON válido/);
        assert.match((e as Error).message, /config corrompida ou escrita parcial/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlatformConfig — JSON truncado (escrita parcial) também vira PlatformConfigError", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-brevo-diaria-guardrail-6799-trunc-"));
  try {
    const path = join(dir, "platform.config.json");
    writeFileSync(path, '{ "brevo_diaria": { "api_key_env": "BREVO_DIARIA_API');
    assert.throws(() => loadPlatformConfig(path), PlatformConfigError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlatformConfig — JSON válido parseia normalmente (comportamento anterior preservado)", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-brevo-diaria-guardrail-6799-valid-"));
  try {
    const path = join(dir, "platform.config.json");
    writeFileSync(path, JSON.stringify({ brevo_diaria: { api_key_env: "BREVO_DIARIA_API_KEY" } }));
    const cfg = loadPlatformConfig(path);
    assert.equal(cfg.brevo_diaria?.api_key_env, "BREVO_DIARIA_API_KEY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
