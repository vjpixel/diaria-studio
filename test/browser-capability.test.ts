/**
 * browser-capability.test.ts (#5208)
 *
 * Testa `detectBrowserCapability` com env/fs mockados — não depende do
 * ambiente real (nem de ter/não ter display gráfico ou browser instalado na
 * máquina que roda os testes). Cobre os 3 estados:
 *   - `'available'`: DISPLAY (ou WAYLAND_DISPLAY) presente + binário no PATH
 *   - `'unavailable'`: sem display, OU display presente mas nenhum binário
 *   - `'unknown'`: falha inesperada durante a sondagem (fail-soft)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectBrowserCapability } from "../scripts/lib/browser-capability.ts";

const PATH_ENV = ["/usr/bin", "/usr/local/bin"].join(process.platform === "win32" ? ";" : ":");

describe("detectBrowserCapability", () => {
  it("retorna 'available' quando DISPLAY e um binário de browser estão presentes", () => {
    const result = detectBrowserCapability({
      env: { DISPLAY: ":0", PATH: PATH_ENV },
      existsFn: (path) => path === "/usr/bin/google-chrome",
    });
    assert.equal(result, "available");
  });

  it("retorna 'available' via WAYLAND_DISPLAY (sem DISPLAY) + chromium no PATH", () => {
    const result = detectBrowserCapability({
      env: { WAYLAND_DISPLAY: "wayland-0", PATH: PATH_ENV },
      existsFn: (path) => path === "/usr/local/bin/chromium",
    });
    assert.equal(result, "available");
  });

  it("retorna 'available' com chromium-browser (3º binário conhecido)", () => {
    const result = detectBrowserCapability({
      env: { DISPLAY: ":1", PATH: PATH_ENV },
      existsFn: (path) => path === "/usr/bin/chromium-browser",
    });
    assert.equal(result, "available");
  });

  it("retorna 'unavailable' quando DISPLAY e WAYLAND_DISPLAY estão ambos ausentes (predator, #5208)", () => {
    const result = detectBrowserCapability({
      env: { PATH: PATH_ENV },
      existsFn: () => true, // binário existiria, mas sem display não importa
    });
    assert.equal(result, "unavailable");
  });

  it("retorna 'unavailable' quando DISPLAY/WAYLAND_DISPLAY são strings vazias", () => {
    const result = detectBrowserCapability({
      env: { DISPLAY: "", WAYLAND_DISPLAY: "", PATH: PATH_ENV },
      existsFn: () => true,
    });
    assert.equal(result, "unavailable");
  });

  it("retorna 'unavailable' quando há display mas nenhum binário conhecido está no PATH", () => {
    const result = detectBrowserCapability({
      env: { DISPLAY: ":0", PATH: PATH_ENV },
      existsFn: () => false,
    });
    assert.equal(result, "unavailable");
  });

  it("retorna 'unavailable' quando PATH está vazio/ausente mesmo com display", () => {
    const result = detectBrowserCapability({
      env: { DISPLAY: ":0" },
      existsFn: () => true,
    });
    assert.equal(result, "unavailable");
  });

  it("retorna 'unknown' quando a sondagem lança uma exceção inesperada (fail-soft)", () => {
    const result = detectBrowserCapability({
      env: { DISPLAY: ":0", PATH: PATH_ENV },
      existsFn: () => {
        throw new Error("EACCES simulado");
      },
    });
    assert.equal(result, "unknown");
  });

  it("usa process.env e fs real quando opções são omitidas — não lança", () => {
    const result = detectBrowserCapability();
    assert.ok(result === "available" || result === "unavailable" || result === "unknown");
  });
});
