/**
 * test/apoio-level-verify.test.ts (#7030)
 *
 * Regressão do gate dos Artigos Especiais — cobre o CRITÉRIO CENTRAL da
 * issue #7030: visitante sem apoio (ou com apoio abaixo do limiar) recebe o
 * teaser (nunca confirmação positiva forte); visitante com apoio ≥ limiar
 * recebe acesso completo. `meetsApoioThreshold`/`verifyApoioLevelViaKv` são
 * as peças puras/testáveis que decidem isso — `apoio-gate.ts` (worker) só
 * as orquestra.
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import {
  apoioLevelKvKey,
  isApoioNivelValue,
  meetsApoioThreshold,
  verifyApoioLevelViaKv,
  type ApoioNivel,
} from "../scripts/lib/shared/apoio-level-verify.ts";

function fakeKv(store: Record<string, string>) {
  return {
    get: mock.fn(async (key: string) => store[key] ?? null),
  } as unknown as KVNamespace;
}

describe("meetsApoioThreshold (#7030)", () => {
  const threshold: ApoioNivel[] = ["apoiador", "mantenedor", "patrono"];

  it("nível abaixo do limiar (amigo) NÃO atende", () => {
    assert.equal(meetsApoioThreshold("amigo", threshold), false);
  });

  it("nível no piso do limiar (apoiador) atende", () => {
    assert.equal(meetsApoioThreshold("apoiador", threshold), true);
  });

  it("nível acima do limiar (mantenedor, patrono) atende", () => {
    assert.equal(meetsApoioThreshold("mantenedor", threshold), true);
    assert.equal(meetsApoioThreshold("patrono", threshold), true);
  });

  it("sem apoio (null) nunca atende, mesmo com limiar vazio", () => {
    assert.equal(meetsApoioThreshold(null, threshold), false);
    assert.equal(meetsApoioThreshold(null, []), false);
  });

  it("limiar vazio nunca atende, mesmo com o nível mais alto", () => {
    assert.equal(meetsApoioThreshold("patrono", []), false);
  });
});

describe("isApoioNivelValue (#7030)", () => {
  it("aceita os 4 níveis canônicos", () => {
    for (const v of ["amigo", "apoiador", "mantenedor", "patrono"]) {
      assert.equal(isApoioNivelValue(v), true);
    }
  });

  it("rejeita valor não reconhecido", () => {
    assert.equal(isApoioNivelValue("vip"), false);
    assert.equal(isApoioNivelValue(""), false);
  });
});

describe("verifyApoioLevelViaKv (#7030)", () => {
  it("VISITANTE SEM APOIO — chave ausente no KV → unknown (nunca confirmação negativa forte)", async () => {
    const kv = fakeKv({});
    const result = await verifyApoioLevelViaKv(kv, "ninguem@example.com");
    assert.deepEqual(result, { state: "unknown", level: null });
  });

  it("APOIADOR ≥ limiar — chave presente com nível reconhecido → known", async () => {
    const key = await apoioLevelKvKey("patrono@example.com");
    const kv = fakeKv({ [key]: "patrono" });
    const result = await verifyApoioLevelViaKv(kv, "patrono@example.com");
    assert.deepEqual(result, { state: "known", level: "patrono" });
  });

  it("apoiador de nível baixo (amigo) também é 'known' — quem decide o limiar é meetsApoioThreshold, não o lookup", async () => {
    const key = await apoioLevelKvKey("amigo@example.com");
    const kv = fakeKv({ [key]: "amigo" });
    const result = await verifyApoioLevelViaKv(kv, "amigo@example.com");
    assert.deepEqual(result, { state: "known", level: "amigo" });
  });

  it("valor malformado no KV (sync desatualizado) vira unknown, nunca lança", async () => {
    const key = await apoioLevelKvKey("malformado@example.com");
    const kv = fakeKv({ [key]: "vip-secreto" });
    const result = await verifyApoioLevelViaKv(kv, "malformado@example.com");
    assert.deepEqual(result, { state: "unknown", level: null });
  });

  it("e-mail normalizado (case/espaço) resolve pra mesma chave", async () => {
    const key = await apoioLevelKvKey("Patrono@Example.com ");
    const kv = fakeKv({ [key]: "patrono" });
    const result = await verifyApoioLevelViaKv(kv, "  patrono@example.COM");
    assert.deepEqual(result, { state: "known", level: "patrono" });
  });
});

describe("fim-a-fim: gate por lookup + limiar (#7030)", () => {
  const threshold: ApoioNivel[] = ["apoiador", "mantenedor", "patrono"];

  it("visitante SEM apoio → teaser (lookup unknown, meetsApoioThreshold false)", async () => {
    const kv = fakeKv({});
    const lookup = await verifyApoioLevelViaKv(kv, "visitante@example.com");
    assert.equal(meetsApoioThreshold(lookup.level, threshold), false);
  });

  it("visitante com apoio ABAIXO do limiar (amigo) → teaser", async () => {
    const key = await apoioLevelKvKey("amigo2@example.com");
    const kv = fakeKv({ [key]: "amigo" });
    const lookup = await verifyApoioLevelViaKv(kv, "amigo2@example.com");
    assert.equal(meetsApoioThreshold(lookup.level, threshold), false);
  });

  it("visitante com apoio NO limiar ou acima (apoiador+) → conteúdo completo", async () => {
    const key = await apoioLevelKvKey("apoiador2@example.com");
    const kv = fakeKv({ [key]: "apoiador" });
    const lookup = await verifyApoioLevelViaKv(kv, "apoiador2@example.com");
    assert.equal(meetsApoioThreshold(lookup.level, threshold), true);
  });
});
