/**
 * test/retrospectiva-kv-namespaces.test.ts (#7581)
 *
 * `parseNamespaceId` (`scripts/lib/shared/retrospectiva-kv-namespaces.ts`) —
 * mesma cobertura de `parseNamespaceId` (mensal, #7580): nomeia a causa
 * certa (bloco ausente vs. `id` ausente vs. placeholder nunca substituído).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseNamespaceId } from "../scripts/lib/shared/retrospectiva-kv-namespaces.ts";

function toml(block: string): string {
  return `name = "anual"\nmain = "src/index.ts"\n\n[[kv_namespaces]]\n${block}\n`;
}

describe("parseNamespaceId (#7581)", () => {
  it("extrai o id do bloco cujo binding casa", () => {
    assert.equal(parseNamespaceId(toml('binding = "ARTICLES"\nid = "abc123"'), "ARTICLES"), "abc123");
  });

  it("binding encontrado mas sem `id` → erro nomeando o bloco incompleto", () => {
    assert.throws(() => parseNamespaceId(toml('binding = "ARTICLES"'), "ARTICLES"), /não declara `id`/);
  });

  it("id placeholder REPLACE_ME_... → erro nomeando o passo manual pendente", () => {
    assert.throws(
      () => parseNamespaceId(toml('binding = "ARTICLES"\nid = "REPLACE_ME_APOS_CRIAR_NAMESPACE_ARTICLES"'), "ARTICLES"),
      /placeholder/,
    );
  });

  it("binding ausente de qualquer bloco → erro 'não encontrado'", () => {
    assert.throws(() => parseNamespaceId(toml('binding = "OUTRO"\nid = "x"'), "ARTICLES"), /não encontrado/);
  });

  it("dois blocos [[kv_namespaces]] — cada binding resolve pro id certo", () => {
    const dois = `name = "anual"\n\n[[kv_namespaces]]\nbinding = "ARTICLES"\nid = "aaa"\n\n[[kv_namespaces]]\nbinding = "RATE_LIMIT"\nid = "bbb"\n`;
    assert.equal(parseNamespaceId(dois, "ARTICLES"), "aaa");
    assert.equal(parseNamespaceId(dois, "RATE_LIMIT"), "bbb");
  });
});
