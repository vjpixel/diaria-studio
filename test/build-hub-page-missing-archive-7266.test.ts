/**
 * test/build-hub-page-missing-archive-7266.test.ts (#7266)
 *
 * `findMissingArchivePages` — guard puro que ACUSA (em vez de degradar
 * calado) quando um hub linka `diar.ia.br/p/{slug}` de uma edição sem
 * página de acervo local.
 *
 * **Por que existe.** Antes do #7266, um link `/p/{slug}` num hub que
 * apontasse pra uma edição sem página local (§6d-site pode falhar
 * fail-soft, ou nunca ter rodado — ver docstring de
 * `publish-edition-site-page.ts`) só quebrava em PRODUÇÃO: 404 no Worker
 * `diaria-site`, caindo no fallback pro Kit (#6429), que também 404 se a
 * edição nunca foi publicada por lá. Nada no build do hub, nem no PR que o
 * introduziu, sinalizava o problema — achado ao vivo: PR #7258 nasceu com
 * 2 links quebrados assim.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findMissingArchivePages } from "../scripts/build-hub-page.ts";

describe("findMissingArchivePages (#7266)", () => {
  it("URL /p/{slug} sem página local -> reportada", () => {
    const missing = findMissingArchivePages(
      ["https://diar.ia.br/p/edicao-sem-pagina"],
      () => false,
    );
    assert.deepEqual(missing, ["edicao-sem-pagina"]);
  });

  it("URL /p/{slug} com página local -> não reportada", () => {
    const missing = findMissingArchivePages(
      ["https://diar.ia.br/p/edicao-com-pagina"],
      () => true,
    );
    assert.deepEqual(missing, []);
  });

  it("URL fora do domínio diar.ia.br/p/ -> ignorada, nunca lança", () => {
    const missing = findMissingArchivePages(
      ["https://exemplo.com/artigo", "https://diar.ia.br/subscribe"],
      () => false,
    );
    assert.deepEqual(missing, []);
  });

  it("mesma edição citada 2x (prosa + sourceEditions) -> reportada 1x, sem duplicata", () => {
    const missing = findMissingArchivePages(
      ["https://diar.ia.br/p/duplicada", "https://diar.ia.br/p/duplicada"],
      () => false,
    );
    assert.deepEqual(missing, ["duplicada"]);
  });

  it("lista vazia -> vazio", () => {
    assert.deepEqual(findMissingArchivePages([], () => false), []);
  });

  it("ordena o resultado (determinístico pra mensagem de warning estável)", () => {
    const missing = findMissingArchivePages(
      ["https://diar.ia.br/p/zeta", "https://diar.ia.br/p/alfa"],
      () => false,
    );
    assert.deepEqual(missing, ["alfa", "zeta"]);
  });
});
