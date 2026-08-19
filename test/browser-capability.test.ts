/**
 * browser-capability.test.ts (#5208)
 *
 * Testa `detectBrowserCapability` com env/fs/platform mockados — não depende
 * do ambiente real (nem de ter/não ter display gráfico ou browser instalado
 * na máquina que roda os testes). Cobre os 3 estados nos dois eixos de
 * plataforma que o repo conhece:
 *   - Linux (`helios`): `'available'` exige DISPLAY/WAYLAND_DISPLAY E
 *     binário no PATH; `'unavailable'` se faltar qualquer um dos dois.
 *   - Windows (`neo`): a checagem de DISPLAY NÃO se aplica (não é um
 *     conceito da plataforma) — só o binário decide, via PATH OU diretórios
 *     de instalação usuais (Chrome raramente entra no PATH no Windows).
 *   - `'unknown'`: falha inesperada durante a sondagem (fail-soft), em
 *     qualquer plataforma.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectBrowserCapability } from "../scripts/lib/browser-capability.ts";

const PATH_ENV = ["/usr/bin", "/usr/local/bin"].join(process.platform === "win32" ? ";" : ":");

describe("detectBrowserCapability — Linux (helios)", () => {
  it("retorna 'available' quando DISPLAY e um binário de browser estão presentes", () => {
    const result = detectBrowserCapability({
      platform: "linux",
      env: { DISPLAY: ":0", PATH: PATH_ENV },
      existsFn: (path) => path === "/usr/bin/google-chrome",
    });
    assert.equal(result, "available");
  });

  it("retorna 'available' via WAYLAND_DISPLAY (sem DISPLAY) + chromium no PATH", () => {
    const result = detectBrowserCapability({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0", PATH: PATH_ENV },
      existsFn: (path) => path === "/usr/local/bin/chromium",
    });
    assert.equal(result, "available");
  });

  it("retorna 'available' com chromium-browser (3º binário conhecido)", () => {
    const result = detectBrowserCapability({
      platform: "linux",
      env: { DISPLAY: ":1", PATH: PATH_ENV },
      existsFn: (path) => path === "/usr/bin/chromium-browser",
    });
    assert.equal(result, "available");
  });

  it("retorna 'unavailable' quando DISPLAY e WAYLAND_DISPLAY estão ambos ausentes (helios, #5208)", () => {
    const result = detectBrowserCapability({
      platform: "linux",
      env: { PATH: PATH_ENV },
      existsFn: () => true, // binário existiria, mas sem display não importa
    });
    assert.equal(result, "unavailable");
  });

  it("retorna 'unavailable' quando DISPLAY/WAYLAND_DISPLAY são strings vazias", () => {
    const result = detectBrowserCapability({
      platform: "linux",
      env: { DISPLAY: "", WAYLAND_DISPLAY: "", PATH: PATH_ENV },
      existsFn: () => true,
    });
    assert.equal(result, "unavailable");
  });

  it("retorna 'unavailable' quando há display mas nenhum binário conhecido está no PATH", () => {
    const result = detectBrowserCapability({
      platform: "linux",
      env: { DISPLAY: ":0", PATH: PATH_ENV },
      existsFn: () => false,
    });
    assert.equal(result, "unavailable");
  });

  it("retorna 'unavailable' quando PATH está vazio/ausente mesmo com display", () => {
    const result = detectBrowserCapability({
      platform: "linux",
      env: { DISPLAY: ":0" },
      existsFn: () => true,
    });
    assert.equal(result, "unavailable");
  });

  it("retorna 'unknown' quando a sondagem lança uma exceção inesperada (fail-soft)", () => {
    const result = detectBrowserCapability({
      platform: "linux",
      env: { DISPLAY: ":0", PATH: PATH_ENV },
      existsFn: () => {
        throw new Error("EACCES simulado");
      },
    });
    assert.equal(result, "unknown");
  });
});

describe("detectBrowserCapability — Windows (neo, #5209)", () => {
  it("retorna 'available' com chrome.exe no PATH, mesmo SEM DISPLAY/WAYLAND_DISPLAY setados", () => {
    const result = detectBrowserCapability({
      platform: "win32",
      env: { PATH: "C:\\some\\dir" },
      existsFn: (path) => path === "C:\\some\\dir\\chrome.exe",
    });
    assert.equal(result, "available");
  });

  it("retorna 'available' com msedge.exe no PATH", () => {
    const result = detectBrowserCapability({
      platform: "win32",
      env: { PATH: "C:\\some\\dir" },
      existsFn: (path) => path === "C:\\some\\dir\\msedge.exe",
    });
    assert.equal(result, "available");
  });

  it("retorna 'available' via diretório de instalação usual (%LOCALAPPDATA%) quando PATH não tem o binário — caso comum: instalador não adiciona Chrome ao PATH", () => {
    const result = detectBrowserCapability({
      platform: "win32",
      env: { PATH: "C:\\some\\dir", LOCALAPPDATA: "C:\\Users\\editor\\AppData\\Local" },
      existsFn: (path) =>
        path === "C:\\Users\\editor\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    });
    assert.equal(result, "available");
  });

  it("retorna 'available' via %ProgramFiles%", () => {
    const result = detectBrowserCapability({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      existsFn: (path) => path === "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    });
    assert.equal(result, "available");
  });

  it("retorna 'unavailable' quando nenhum binário é encontrado em PATH nem nos diretórios de instalação usuais", () => {
    const result = detectBrowserCapability({
      platform: "win32",
      env: { PATH: "C:\\some\\dir", LOCALAPPDATA: "C:\\Users\\editor\\AppData\\Local" },
      existsFn: () => false,
    });
    assert.equal(result, "unavailable");
  });

  it("retorna 'unknown' quando a sondagem lança uma exceção inesperada (fail-soft)", () => {
    const result = detectBrowserCapability({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      existsFn: () => {
        throw new Error("erro simulado");
      },
    });
    assert.equal(result, "unknown");
  });
});

describe("detectBrowserCapability — outras plataformas / defaults", () => {
  it("retorna 'available' no macOS com google-chrome no PATH, sem exigir DISPLAY", () => {
    const result = detectBrowserCapability({
      platform: "darwin",
      env: { PATH: "/usr/local/bin" },
      existsFn: (path) => path === "/usr/local/bin/google-chrome",
    });
    assert.equal(result, "available");
  });

  it("usa process.env, process.platform e fs real quando opções são omitidas — não lança", () => {
    const result = detectBrowserCapability();
    assert.ok(result === "available" || result === "unavailable" || result === "unknown");
  });
});
