/**
 * test/sync-artigos-apoio-kv.test.ts (#7030)
 *
 * Cobre as peças puras de `scripts/sync-artigos-apoio-kv.ts` — nunca invoca
 * `wrangler`/rede de verdade (mesmo padrão de
 * `test/sync-cursos-subscribers-kv.test.ts`).
 */
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import {
  buildKvBulkEntries,
  diffStaleApoioKeys,
  buildKvKeyListCommand,
  buildKvBulkDeleteCommand,
  syncKvKeys,
  type KvBulkEntry,
  type KvSyncOps,
} from "../scripts/sync-artigos-apoio-kv.ts";
import { apoioLevelKvKey } from "../scripts/lib/shared/apoio-level-verify.ts";

describe("buildKvBulkEntries (#7030)", () => {
  it("mapeia {email, nivel} pra {key: apoio:{hash}, value: nivel}", async () => {
    const entries = await buildKvBulkEntries([{ email: "patrono@example.com", nivel: "patrono" }]);
    const expectedKey = await apoioLevelKvKey("patrono@example.com");
    assert.deepEqual(entries, [{ key: expectedKey, value: "patrono" }]);
  });

  it("dedupe por chave — mesmo e-mail normalizado 2x colapsa numa entrada", async () => {
    const entries = await buildKvBulkEntries([
      { email: "x@example.com", nivel: "amigo" },
      { email: "X@Example.com", nivel: "mantenedor" }, // último vence
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].value, "mantenedor");
  });
});

describe("diffStaleApoioKeys (#7030)", () => {
  it("chave presente no KV mas ausente do conjunto atual entra na lista de delete", () => {
    const stale = diffStaleApoioKeys(["apoio:abc", "apoio:def"], [{ key: "apoio:abc", value: "patrono" }]);
    assert.deepEqual(stale, ["apoio:def"]);
  });

  it("chave ainda presente no conjunto atual NUNCA entra no delete", () => {
    const stale = diffStaleApoioKeys(["apoio:abc"], [{ key: "apoio:abc", value: "amigo" }]);
    assert.deepEqual(stale, []);
  });

  it("ignora chaves de outro prefixo do mesmo namespace (defesa em profundidade)", () => {
    const stale = diffStaleApoioKeys(["rl:artigos-gate:1.2.3.4", "apoio:zzz"], []);
    assert.deepEqual(stale, ["apoio:zzz"]);
  });
});

describe("buildKvKeyListCommand / buildKvBulkDeleteCommand (#7030)", () => {
  it("kv key list usa --prefix apoio: (nunca lista o namespace inteiro)", () => {
    const cmd = buildKvKeyListCommand({ namespaceId: "ns123" });
    assert.match(cmd, /--prefix "apoio:"/);
    assert.match(cmd, /--namespace-id=ns123/);
  });

  it("kv bulk delete usa --force (script roda desassistido)", () => {
    const cmd = buildKvBulkDeleteCommand({ tmpFile: "/tmp/x.json", namespaceId: "ns123" });
    assert.match(cmd, /--force/);
  });
});

describe("syncKvKeys (#7030) — ordem put→delete preservada", () => {
  it("put roda, e SE lançar, delete NUNCA roda", () => {
    const calls: string[] = [];
    const ops: KvSyncOps = {
      put: mock.fn(() => {
        calls.push("put");
        throw new Error("put falhou");
      }),
      listApoio: mock.fn(() => {
        calls.push("list");
        return [];
      }),
      bulkDelete: mock.fn(() => {
        calls.push("delete");
      }),
    };
    const entries: KvBulkEntry[] = [{ key: "apoio:x", value: "patrono" }];
    assert.throws(() => syncKvKeys(entries, "ns", "acc", ops));
    assert.deepEqual(calls, ["list", "put"]);
  });

  it("caminho feliz: list → put → delete, nesta ordem", () => {
    const calls: string[] = [];
    const ops: KvSyncOps = {
      put: mock.fn(() => calls.push("put")),
      listApoio: mock.fn(() => {
        calls.push("list");
        return ["apoio:stale"];
      }),
      bulkDelete: mock.fn(() => calls.push("delete")),
    };
    const entries: KvBulkEntry[] = [{ key: "apoio:x", value: "patrono" }];
    const result = syncKvKeys(entries, "ns", "acc", ops);
    assert.deepEqual(calls, ["list", "put", "delete"]);
    assert.deepEqual(result.staleKeys, ["apoio:stale"]);
  });
});
