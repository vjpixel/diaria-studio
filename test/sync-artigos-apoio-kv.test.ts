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
  rowsFromDesiredLevels,
  decideStaleDeletion,
  readNamespaceIdFromWranglerToml,
  type KvBulkEntry,
  type KvSyncOps,
} from "../scripts/sync-artigos-apoio-kv.ts";
import { apoioLevelKvKey } from "../scripts/lib/shared/apoio-level-verify.ts";
import type { DesiredApoioLevel } from "../scripts/sync-apoio-nivel-beehiiv.ts";

function desired(over: Partial<DesiredApoioLevel>): DesiredApoioLevel {
  return { contactId: "c", contactName: "n", emails: [], level: null, unresolved: false, ...over };
}

describe("rowsFromDesiredLevels (#9300) — fonte é o CRM apoia.se, não a Beehiiv", () => {
  it("regressão #9300: Patrono do CRM vira chave patrono no KV, sem depender de assinatura na newsletter", async () => {
    const { rows } = rowsFromDesiredLevels([desired({ emails: ["vitor@example.com"], level: "patrono" })]);
    const entries = await buildKvBulkEntries(rows);
    assert.deepEqual(entries, [{ key: await apoioLevelKvKey("vitor@example.com"), value: "patrono" }]);
  });

  it("todos os e-mails do contato recebem o nível", () => {
    const { rows } = rowsFromDesiredLevels([desired({ emails: ["a@x.com", "b@y.com"], level: "apoiador" })]);
    assert.deepEqual(rows, [
      { email: "a@x.com", nivel: "apoiador" },
      { email: "b@y.com", nivel: "apoiador" },
    ]);
  });

  it("contato sem nível (carência esgotada) não gera linha", () => {
    const { rows, protectedEmails } = rowsFromDesiredLevels([desired({ emails: ["ex@x.com"], level: null })]);
    assert.deepEqual(rows, []);
    assert.deepEqual(protectedEmails, []);
  });

  it("contato sem_dados não gera linha mas fica protegido contra delete", () => {
    const { rows, protectedEmails } = rowsFromDesiredLevels([
      desired({ emails: ["?@x.com"], level: null, unresolved: true }),
    ]);
    assert.deepEqual(rows, []);
    assert.deepEqual(protectedEmails, ["?@x.com"]);
  });
});

describe("decideStaleDeletion (#9300)", () => {
  const base = { staleCount: 1, existingCount: 20, sourceDegraded: false, forceBlastRadius: false };

  it("fonte degradada bloqueia remoção", () => {
    assert.equal(decideStaleDeletion({ ...base, sourceDegraded: true }).allowed, false);
  });

  it("acima de 30% das chaves bloqueia, salvo --force-blast-radius", () => {
    assert.equal(decideStaleDeletion({ ...base, staleCount: 7 }).allowed, false);
    assert.equal(decideStaleDeletion({ ...base, staleCount: 7, forceBlastRadius: true }).allowed, true);
  });

  it("até 30% passa; zero stale sempre passa", () => {
    assert.equal(decideStaleDeletion({ ...base, staleCount: 6 }).allowed, true);
    assert.equal(decideStaleDeletion({ ...base, staleCount: 0, sourceDegraded: true }).allowed, true);
  });

  it("KV pequeno (< 5 chaves) não aplica o percentual", () => {
    assert.equal(decideStaleDeletion({ ...base, staleCount: 3, existingCount: 4 }).allowed, true);
  });
});

describe("readNamespaceIdFromWranglerToml (#9300)", () => {
  it("lê o id do binding ARTIGOS_APOIO_NIVEL", () => {
    const toml = '[[kv_namespaces]]\nbinding = "ARTIGOS_APOIO_NIVEL"\nid = "abc123"\n';
    assert.equal(readNamespaceIdFromWranglerToml(toml), "abc123");
  });

  it("placeholder não conta como id", () => {
    const toml = 'binding = "ARTIGOS_APOIO_NIVEL"\nid = "PLACEHOLDER_X"\n';
    assert.equal(readNamespaceIdFromWranglerToml(toml), undefined);
  });
});

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

  it("#9300: chave protegida nunca entra no delete; guard negando pula o delete", () => {
    const deleted: string[][] = [];
    const ops: KvSyncOps = {
      put: mock.fn(),
      listApoio: mock.fn(() => ["apoio:stale", "apoio:semdados"]),
      bulkDelete: mock.fn((keys: string[]) => deleted.push(keys)),
    };
    const entries: KvBulkEntry[] = [{ key: "apoio:x", value: "patrono" }];
    const r1 = syncKvKeys(entries, "ns", "acc", ops, { protectedKeys: new Set(["apoio:semdados"]) });
    assert.deepEqual(r1.staleKeys, ["apoio:stale"]);
    assert.deepEqual(deleted, [["apoio:stale"]]);

    const r2 = syncKvKeys(entries, "ns", "acc", ops, { decide: () => ({ allowed: false, reason: "x" }) });
    assert.equal(r2.deletion.allowed, false);
    assert.equal(deleted.length, 1);
  });
});
