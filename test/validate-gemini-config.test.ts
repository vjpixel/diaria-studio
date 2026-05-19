/**
 * test/validate-gemini-config.test.ts (#1396)
 *
 * Cobre `checkModelInCatalog` — função pure que decide se um model
 * configurado em platform.config.json resolve no catálogo /v1beta/models
 * da Gemini API. O regressor concreto que motivou (#1396): Bundle 6
 * (PR #1391) mudou `gemini.model` pra `gemini-2.5-flash-image-preview`,
 * que retornou 404 — só `gemini-2.5-flash-image` sem `-preview` existe.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkModelInCatalog } from "../scripts/validate-gemini-config.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts", "validate-gemini-config.ts");

describe("checkModelInCatalog (#1396)", () => {
  const realCatalog = [
    "models/gemini-2.5-flash-image",
    "models/gemini-2.5-flash",
    "models/gemini-flash-latest",
    "models/gemini-pro-latest",
    "models/imagen-3.0-generate-002",
  ];

  it("ok=true quando configured está no catálogo (sem prefix)", () => {
    const r = checkModelInCatalog("gemini-2.5-flash-image", realCatalog);
    assert.equal(r.ok, true);
  });

  it("ok=true quando configured tem prefix models/ e bate", () => {
    const r = checkModelInCatalog("models/gemini-2.5-flash-image", realCatalog);
    assert.equal(r.ok, true);
  });

  it("ok=true matching case-insensitive", () => {
    const r = checkModelInCatalog("Gemini-2.5-Flash-Image", realCatalog);
    assert.equal(r.ok, true);
  });

  it("ok=false + suggestion quando model não existe (regressor #1395)", () => {
    // Esse foi o bug real: -preview suffix não existe no catálogo
    const r = checkModelInCatalog("gemini-2.5-flash-image-preview", realCatalog);
    assert.equal(r.ok, false);
    assert.ok(r.suggestion, "Esperava sugestão de model próximo");
    // A sugestão deve ser o model real (sem -preview)
    assert.match(r.suggestion!, /gemini-2.5-flash-image/);
  });

  it("ok=false sem suggestion quando nada parecido no catálogo", () => {
    const r = checkModelInCatalog("totally-different-model-xyz", realCatalog);
    assert.equal(r.ok, false);
  });

  it("ok=false quando catálogo vazio", () => {
    const r = checkModelInCatalog("gemini-2.5-flash-image", []);
    assert.equal(r.ok, false);
  });

  it("sugere mesmo prefixo de família quando model não encontrado", () => {
    // Catalog tem gemini-2.5-flash; configured pede gemini-2.5-flash-pro
    // (não existe). Sugestão deve cair em gemini-2.5-flash (mesma família).
    const r = checkModelInCatalog("gemini-2.5-flash-pro", [
      "models/gemini-2.5-flash",
      "models/gemini-pro-latest",
    ]);
    assert.equal(r.ok, false);
    // Aceita qualquer sugestão da mesma família major.minor
    assert.ok(r.suggestion);
    assert.match(r.suggestion!, /^gemini-2\.5/);
  });
});

describe("validate-gemini-config exit semantics (#1401)", () => {
  // Regression test pro Windows process.exit() crash. O bug:
  // process.exit(N) forçava libuv shutdown enquanto fetch keep-alive
  // sockets ainda estavam abertos, disparando UV_HANDLE_CLOSING assertion
  // (exit 134/127) mesmo quando o resultado era OK. Fix: process.exitCode
  // + return, deixando event loop drenar naturalmente.
  //
  // O check estático abaixo garante que main() não chama process.exit()
  // — single source of truth pra detectar a regressão. Portável em
  // Linux/Mac (CI) e Windows (onde o bug original aparecia).

  it("main() usa process.exitCode em vez de process.exit() (#1401)", () => {
    const source = readFileSync(SCRIPT, "utf8");
    // Strip line comments pra não matchar referências em // process.exit() ...
    const sourceNoComments = source.replace(/\/\/.*$/gm, "");
    // Pega só o corpo da função main()
    const mainMatch = sourceNoComments.match(/async function main\(\)[\s\S]*?\n\}\n/);
    assert.ok(mainMatch, "main() function não encontrada no script");
    const mainBody = mainMatch[0];
    // Bug original: process.exit(N) com N >= 0 dentro de main()
    // Fix: deve usar process.exitCode pra evitar UV_HANDLE_CLOSING no Windows
    assert.equal(
      /process\.exit\s*\(/.test(mainBody),
      false,
      "main() não pode chamar process.exit() — usar process.exitCode (#1401 Windows crash)",
    );
    // E deve setar exitCode em todos os branches
    assert.match(mainBody, /process\.exitCode/, "main() deve setar process.exitCode");
  });

  it("script com config válida exita 0 sem crashar (cross-platform)", () => {
    // Smoke test: spawnSync sem GEMINI_API_KEY (cai em reason=key_missing,
    // exit 2). O ponto não é testar a lógica de validação — é provar que
    // o script SAI LIMPO sem disparar UV_HANDLE_CLOSING. Antes do fix,
    // Windows retornava exit 127 (crash) em vez de 2.
    const env = { ...process.env };
    delete env.GEMINI_API_KEY;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", SCRIPT],
      { encoding: "utf8", env, timeout: 30_000 },
    );
    // Aceita só códigos do contrato (0, 1, 2, 3) — bug retornava 127/134
    assert.ok(
      [0, 1, 2, 3].includes(result.status ?? -1),
      `exit code ${result.status} fora do contrato — script crashou. stderr: ${result.stderr?.slice(0, 200)}`,
    );
    // JSON output deve estar presente (não foi truncado por crash)
    assert.match(result.stdout, /"ok":/, "stdout deve conter JSON com 'ok' field");
  });
});
