/**
 * test/make-tracked-kv-14058.test.ts (#14058)
 *
 * Trava o contrato do KV em memória compartilhado de `test/_helpers/make-tracked-kv.ts`,
 * que desde o #14058 substitui as cópias locais `makeMapKV`/`makeKv`/`fakeKv`.
 * As extensões precisam ser aditivas: os importadores anteriores seguem com o
 * mesmo comportamento de get/put/delete/list/puts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeTrackedKv, makeTrackedKvNamespace, readKv } from "./_helpers/make-tracked-kv.ts";

describe("makeTrackedKv (#14058)", () => {
  it("seed inicial, get de chave ausente devolve null", async () => {
    const kv = makeTrackedKv({ a: "1" });
    assert.equal(await kv.get("a"), "1");
    assert.equal(await kv.get("ausente"), null);
  });

  it("put grava no Map exposto em _map e registra em puts com opts", async () => {
    const kv = makeTrackedKv();
    await kv.put("k", "v", { expirationTtl: 60 });
    assert.equal(kv._map.get("k"), "v");
    assert.deepEqual(kv.puts, [{ key: "k", value: "v", opts: { expirationTtl: 60 } }]);
  });

  it("_map é o store vivo: escrita direta no Map aparece no get e o delete remove do Map", async () => {
    const kv = makeTrackedKv();
    kv._map.set("direto", "x");
    assert.equal(await kv.get("direto"), "x");
    await kv.delete("direto");
    assert.equal(kv._map.has("direto"), false);
  });

  it("get sem tipo devolve a string crua, mesmo quando o valor é JSON", async () => {
    const kv = makeTrackedKv({ j: JSON.stringify({ n: 1 }) });
    assert.equal(await kv.get("j"), '{"n":1}');
  });

  it('get(key, "json") e get(key, { type: "json" }) devolvem o valor parseado, como o KV real', async () => {
    const kv = makeTrackedKv({ j: JSON.stringify({ n: 1 }) });
    assert.deepEqual(await kv.get("j", "json"), { n: 1 });
    assert.deepEqual(await kv.get("j", { type: "json" }), { n: 1 });
    assert.equal(await kv.get("ausente", "json"), null);
  });

  it("getWithMetadata devolve o valor guardado e metadata null", async () => {
    const kv = makeTrackedKv({ a: "1" });
    assert.deepEqual(await kv.getWithMetadata("a"), { value: "1", metadata: null });
    assert.deepEqual(await kv.getWithMetadata("b"), { value: null, metadata: null });
  });

  it("list filtra por prefixo, em ordem de inserção, e sempre completo", async () => {
    const kv = makeTrackedKv({ "p:2": "b", "q:1": "c", "p:1": "a" });
    assert.deepEqual(await kv.list({ prefix: "p:" }), {
      keys: [{ name: "p:2" }, { name: "p:1" }],
      list_complete: true,
      cursor: undefined,
    });
    assert.equal((await kv.list()).keys.length, 3);
  });

  it("readKv lê a chave e falha com mensagem descritiva quando ausente", async () => {
    const kv = makeTrackedKv({ a: "1" });
    assert.equal(await readKv(kv, "a"), "1");
    await assert.rejects(readKv(kv, "b"), /KV key "b" não encontrada/);
  });

  it("instâncias não compartilham estado", async () => {
    const a = makeTrackedKv();
    const b = makeTrackedKv();
    await a.put("k", "v");
    assert.equal(await b.get("k"), null);
    assert.equal(b.puts.length, 0);
  });
});

describe("makeTrackedKvNamespace (#14058)", () => {
  it("é o mesmo stub, tipado como KVNamespace, com _map e puts", async () => {
    const kv = makeTrackedKvNamespace({ a: "1" });
    assert.equal(await kv.get("a"), "1");
    await kv.put("b", "2");
    assert.equal(kv._map.get("b"), "2");
    assert.equal(kv.puts.length, 1);
    // Atribuível a KVNamespace sem cast no teste: é o motivo da variante.
    const ns: KVNamespace = kv;
    assert.ok(ns);
  });
});
