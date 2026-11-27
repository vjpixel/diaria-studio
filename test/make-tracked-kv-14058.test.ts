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

import { jsonSeed, KV_METADATA_MAX_BYTES, makeTrackedKv, makeTrackedKvNamespace, readKv } from "./_helpers/make-tracked-kv.ts";

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

describe("makeTrackedKv: extensões do resíduo (#14058)", () => {
  it("falha injetada: failGet/failPut/failList lançam failMessage e o put falho não grava", async () => {
    const kv = makeTrackedKv({ a: "1" });
    kv.failGet = true;
    await assert.rejects(kv.get("a"), /^Error: kv fora$/);
    await assert.rejects(kv.getWithMetadata("a"), /kv fora/);
    kv.failGet = false;
    kv.failPut = true;
    kv.failMessage = "HTTP 503";
    await assert.rejects(kv.put("b", "2"), /HTTP 503/);
    assert.equal(kv._map.has("b"), false);
    assert.equal(kv.puts.length, 0);
    kv.failList = true;
    await assert.rejects(kv.list(), /HTTP 503/);
    kv.failPut = false;
    kv.failList = false;
    await kv.put("b", "2");
    assert.equal(await kv.get("b"), "2");
  });

  it("metadata: put guarda em _meta, getWithMetadata e list a devolvem; sem metadata o list fica só com name", async () => {
    const kv = makeTrackedKv();
    await kv.put("m", "v", { metadata: { n: 1 }, expirationTtl: 60 });
    await kv.put("s", "v");
    assert.deepEqual(kv._meta.get("m"), { n: 1 });
    assert.deepEqual(await kv.getWithMetadata("m"), { value: "v", metadata: { n: 1 } });
    assert.deepEqual((await kv.list()).keys, [{ name: "m", metadata: { n: 1 } }, { name: "s" }]);
    await kv.put("m", "v2");
    assert.equal(kv._meta.has("m"), false, "regravar sem metadata limpa a anterior, como o KV real");
    await kv.put("s", "v", { metadata: { x: 1 } });
    await kv.delete("s");
    assert.equal(kv._meta.has("s"), false);
  });

  it(`metadata acima de ${KV_METADATA_MAX_BYTES} bytes é recusada, como o KV real`, async () => {
    const kv = makeTrackedKv();
    await assert.rejects(kv.put("k", "v", { metadata: "x".repeat(KV_METADATA_MAX_BYTES) }), /metadata too large/);
    assert.equal(kv._map.has("k"), false);
  });

  it("listPageSize: páginas em ordem lexicográfica, cursor até list_complete", async () => {
    const kv = makeTrackedKv({ "p:c": "3", "q:1": "x", "p:a": "1", "p:b": "2" }, { listPageSize: 2 });
    const p1 = await kv.list({ prefix: "p:" });
    assert.deepEqual(p1, { keys: [{ name: "p:a" }, { name: "p:b" }], list_complete: false, cursor: "2" });
    const p2 = await kv.list({ prefix: "p:", cursor: p1.cursor });
    assert.deepEqual(p2, { keys: [{ name: "p:c" }], list_complete: true, cursor: undefined });
  });

  it("jsonSeed serializa cada valor com JSON.stringify", async () => {
    const kv = makeTrackedKv(jsonSeed({ a: { n: 1 }, b: "txt" }));
    assert.deepEqual(await kv.get("a", "json"), { n: 1 });
    assert.equal(kv._map.get("b"), '"txt"');
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
