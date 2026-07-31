/**
 * url-blocklist.test.ts (#4340)
 *
 * Blacklist editorial por URL EXATA — artigo específico bloqueado, mas
 * outros artigos do MESMO domínio continuam válidos (diferença chave vs
 * editorial-blocklist.ts/#1760, que bane o domínio inteiro).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isUrlBlocked, URL_BLOCKLIST } from "../scripts/lib/url-blocklist.ts";

describe("isUrlBlocked (#4340)", () => {
  it("bloqueia a URL exata cadastrada", () => {
    assert.equal(
      isUrlBlocked(
        "https://www.cnnbrasil.com.br/inteligencia-artificial/entenda-como-um-comando-oculto-entregou-alunos-que-usaram-ia/",
      ),
      true,
    );
  });

  it("bloqueia com query string diferente (normaliza)", () => {
    assert.equal(
      isUrlBlocked(
        "https://blog.google/innovation-and-ai/models-and-research/gemini-models/using-gemini-to-manage-farm/?utm_source=x",
      ),
      true,
    );
  });

  it("NÃO bloqueia outro artigo do MESMO domínio (diferença-chave vs #1760)", () => {
    assert.equal(isUrlBlocked("https://blog.google/innovation-and-ai/products/gemini-app/speak-naturally-gemini-app-mac-os/"), false);
    assert.equal(isUrlBlocked("https://www.cnnbrasil.com.br/inteligencia-artificial/outra-materia-qualquer/"), false);
  });

  it("URL inválida → false (defensivo)", () => {
    assert.equal(isUrlBlocked("not a url"), false);
    assert.equal(isUrlBlocked(""), false);
  });

  it("a lista contém as 2 entradas de 260730 (#4340)", () => {
    assert.equal(URL_BLOCKLIST.size >= 2, true);
  });
});
