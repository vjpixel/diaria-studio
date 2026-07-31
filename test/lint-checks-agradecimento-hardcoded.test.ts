/**
 * test/lint-checks-agradecimento-hardcoded.test.ts (#4359, regressão #633)
 *
 * `context/snippets/agradecimento-apoiadores.md` continha o nome "Mônica
 * Herculano" hardcoded desde a edição 260729, sobrevivendo a pelo menos 2
 * edições consecutivas (260729→260730→260731) sem o editor perceber — o
 * arquivo deveria voltar ao placeholder `{apoiadores}` a cada edição, e
 * nada acusava a divergência.
 *
 * `checkAgradecimentoHardcoded` é o guard novo (WARN-only, mesmo espírito
 * do #4076/snippet-staleness): dado o conteúdo do snippet, reporta se o
 * placeholder foi substituído por um nome real. Este teste cobre:
 *   1. versão hardcoded (sem `{apoiadores}`) → `ok: false`, nome extraído.
 *   2. versão placeholder (`{apoiadores}` presente) → `ok: true`.
 *   3. arquivo vazio/só comentário de header → `ok: true` (graceful).
 *   4. conteúdo sem `{apoiadores}` mas sem o padrão bold-name reconhecível
 *      ainda flagra `ok: false` (o que importa é a ausência do placeholder).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkAgradecimentoHardcoded } from "../scripts/lib/lint-checks/agradecimento-hardcoded.ts";

describe("checkAgradecimentoHardcoded (#4359)", () => {
  it("flags a hardcoded name — placeholder ausente, ok: false (caso real: Mônica Herculano)", () => {
    const raw = "**Agradeço ao novo apoiador: **Mônica Herculano**. Seu apoio ajuda a manter essa curadoria diária de pé!**";
    const result = checkAgradecimentoHardcoded(raw);
    assert.equal(result.ok, false, "nome hardcoded deveria ser flagrado");
    assert.equal(result.name, "Mônica Herculano");
  });

  it("passa (ok: true) na versão com o placeholder {apoiadores}", () => {
    const raw = "**Agradeço ao(s) novo(s) apoiador(es): {apoiadores}. Seu apoio ajuda a manter essa curadoria diária de pé!**";
    const result = checkAgradecimentoHardcoded(raw);
    assert.equal(result.ok, true, "placeholder presente não deveria ser flagrado");
    assert.equal(result.name, null);
  });

  it("arquivo vazio (só comentário HTML de header) → ok: true, graceful", () => {
    const raw = "<!-- categoria: agradecimento -->\n\n   \n";
    const result = checkAgradecimentoHardcoded(raw);
    assert.equal(result.ok, true);
  });

  it("extrai o nome hardcoded pra mensagem do warning quando o padrão bate (caso genérico)", () => {
    const raw = "**Agradeço ao novo apoiador: **Fulano de Tal**. Seu apoio ajuda a manter essa curadoria diária de pé!**";
    const result = checkAgradecimentoHardcoded(raw);
    assert.equal(result.ok, false);
    assert.equal(result.name, "Fulano de Tal");
  });

  it("conteúdo sem o padrão bold-name reconhecido ainda flagra ok:false (placeholder ausente é o que importa)", () => {
    const raw = "Obrigado a quem apoiou recentemente, seu apoio é muito importante.";
    const result = checkAgradecimentoHardcoded(raw);
    assert.equal(result.ok, false, "placeholder ausente é hardcoded mesmo sem o padrão bold reconhecido");
    assert.equal(result.name, null);
  });
});
