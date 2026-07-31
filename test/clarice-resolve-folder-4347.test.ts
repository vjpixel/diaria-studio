/**
 * test/clarice-resolve-folder-4347.test.ts (#4347 Etapa 4)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFolderIdOrDefault, DEFAULT_FOLDER_ID } from "../scripts/clarice-resolve-folder.ts";

test("resolveFolderIdOrDefault: sucesso -> resolved=true, folderId retornado", async () => {
  const result = await resolveFolderIdOrDefault("key", "Clarice novos", async () => 42);
  assert.deepEqual(result, { folderId: 42, resolved: true });
});

test("resolveFolderIdOrDefault: falha (rede/permissão) -> cai na folder default COM aviso, nunca lança", async () => {
  const result = await resolveFolderIdOrDefault("key", "Clarice novos", async () => {
    throw new Error("network down");
  });
  assert.equal(result.folderId, DEFAULT_FOLDER_ID);
  assert.equal(result.resolved, false);
  assert.match(result.error ?? "", /network down/);
});
