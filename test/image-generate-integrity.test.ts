/**
 * test/image-generate-integrity.test.ts (#4989, #12226)
 *
 * Regressão do bug real de 260811: promoção manual de D3 → D1 (mv de
 * `04-d3-*.jpg` para `04-d1-*.jpg` fora do pipeline) seguida de uma
 * re-invocação de `image-generate.ts --destaque d1` apagava silenciosamente
 * o `04-d1-2x1.jpg` recém-promovido — o check antigo exigia o PAR 2x1+1x1 e
 * caía pro fluxo de geração nova, que sobrescreve o destino em silêncio.
 *
 * #12226: o 1x1 deixou de ser gerado. A idempotência olha só o 2x1, e o
 * script não grava mais `04-d{N}-1x1.jpg` no fluxo wide (default da diária).
 *
 * `resolveWideImageIntegrity` foi extraído de `main()` (mesmo padrão de
 * `resolveRatio`, #4093) pra testar a decisão sem gerar imagem real nem
 * tocar disco — teste nunca chama o gerador de imagem (Gemini/Codex).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveWideImageIntegrity } from "../scripts/image-generate.ts";

describe("resolveWideImageIntegrity — idempotência do 2x1 wide (#4989, #12226)", () => {
  it("2x1 presente, sem --force → skip (nunca sobrescreve um 2x1 promovido)", () => {
    assert.deepEqual(resolveWideImageIntegrity(true, false), { kind: "skip" });
  });

  it("CASO REAL #4989 — 2x1 promovido sem 1x1 ao lado → skip, NUNCA regenerate (nada a derivar desde o #12226)", () => {
    // Antes do #12226 este estado virava `derive-1x1-from-2x1`. Sem o 1x1 no
    // pipeline, o 2x1 sozinho já é o estado completo.
    assert.deepEqual(resolveWideImageIntegrity(true, false), { kind: "skip" });
  });

  it("2x1 ausente → regenerate (primeira geração; nada é sobrescrito)", () => {
    assert.deepEqual(resolveWideImageIntegrity(false, false), { kind: "regenerate" });
  });

  it("--force sempre força regenerate, mesmo com o 2x1 presente", () => {
    assert.deepEqual(resolveWideImageIntegrity(true, true), { kind: "regenerate" });
  });
});

describe("image-generate.ts não grava mais o 1x1 no fluxo wide (#12226)", () => {
  const src = readFileSync(resolve(import.meta.dirname, "..", "scripts", "image-generate.ts"), "utf8");
  // Só olha o código, não a prosa dos comentários.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  it("sem crop 1:1 derivado (cropToSquare / widePath1x1 / 800x800)", () => {
    assert.doesNotMatch(code, /cropToSquare/);
    assert.doesNotMatch(code, /widePath1x1/);
    assert.doesNotMatch(code, /"--width",\s*"800",\s*"--height",\s*"800"/);
  });

  it("o único caminho -1x1.jpg restante é o override manual --ratio 1x1 (branch não-wide)", () => {
    const hits = code.match(/-1x1\.jpg/g) ?? [];
    assert.equal(hits.length, 1, "só o outJpgPath do branch não-wide pode citar -1x1.jpg");
    assert.match(code, /: `\$\{normalizedOutDir\}04-\$\{destaque\}-1x1\.jpg`;/);
  });
});
