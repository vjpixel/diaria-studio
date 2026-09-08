/**
 * test/annual-kv-namespaces-7581.test.ts (#7581)
 *
 * `parseAnnualNamespaceId` (`scripts/lib/anual/annual-kv-namespaces.ts`) —
 * mesma cobertura de `parseNamespaceId` (mensal, #7580): nomeia a causa
 * certa (bloco ausente vs. `id` ausente vs. placeholder nunca substituído).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAnnualNamespaceId } from "../scripts/lib/anual/annual-kv-namespaces.ts";

function toml(block: string): string {
  return `name = "anual"\nmain = "src/index.ts"\n\n[[kv_namespaces]]\n${block}\n`;
}

describe("parseAnnualNamespaceId (#7581)", () => {
  it("extrai o id do bloco cujo binding casa", () => {
    assert.equal(parseAnnualNamespaceId(toml('binding = "ARTICLES"\nid = "abc123"'), "ARTICLES"), "abc123");
  });

  it("binding encontrado mas sem `id` → erro nomeando o bloco incompleto", () => {
    assert.throws(() => parseAnnualNamespaceId(toml('binding = "ARTICLES"'), "ARTICLES"), /não declara `id`/);
  });

  it("id placeholder REPLACE_ME_... → erro nomeando o passo manual pendente", () => {
    assert.throws(
      () => parseAnnualNamespaceId(toml('binding = "ARTICLES"\nid = "REPLACE_ME_APOS_CRIAR_NAMESPACE_ARTICLES"'), "ARTICLES"),
      /placeholder/,
    );
  });

  it("binding ausente de qualquer bloco → erro 'não encontrado'", () => {
    assert.throws(() => parseAnnualNamespaceId(toml('binding = "OUTRO"\nid = "x"'), "ARTICLES"), /não encontrado/);
  });

  it("dois blocos [[kv_namespaces]] — cada binding resolve pro id certo", () => {
    const dois = `name = "anual"\n\n[[kv_namespaces]]\nbinding = "ARTICLES"\nid = "aaa"\n\n[[kv_namespaces]]\nbinding = "RATE_LIMIT"\nid = "bbb"\n`;
    assert.equal(parseAnnualNamespaceId(dois, "ARTICLES"), "aaa");
    assert.equal(parseAnnualNamespaceId(dois, "RATE_LIMIT"), "bbb");
  });
});
