/**
 * test/hub-content-no-diaria-nickname-4795.test.ts (#4795)
 *
 * Guard anti-regressão: o texto reader-facing dos hubs temáticos
 * (`scripts/lib/hubs/*.ts` — `title`, `metaDescription`, `question`/`answer`
 * do FAQ, `heading`/`paragraphs` das sections, `introHeading`/
 * `introParagraph`) deve se referir à newsletter pelo nome de marca
 * "a diar.ia.br", nunca pelo apelido informal "a diária" (e variantes de
 * concordância que contêm essa substring — "da diária", "pela diária",
 * "segundo a diária"). Mesmo espírito do guard que o #4424 já tem pra
 * "Diar.ia" (`test/reader-facing-no-legacy-brand-4424.test.ts`) — impede a
 * forma errada de voltar via edição futura do conteúdo do hub.
 *
 * Escopo: TODOS os hubs de `HUB_LOADERS` (#4899). Até 10/08/2026 este guard
 * tinha um array `HUBS` escrito à mão com os 3 hubs de então, e o aviso "um
 * hub novo precisa ser adicionado à mão, senão escapa em silêncio" — foi
 * exatamente o que aconteceu: a #4926 publicou o 4º hub (`meta-ai`) e ele
 * ficou fora deste guard sem ninguém notar. Iterar o registry é o que faz
 * hub futuro nascer coberto. Comentários de código (docstrings, notas de
 * implementação) continuam NÃO cobertos — não aparecem em nenhuma página,
 * trocar é opcional (ver corpo da #4795).
 *
 * `NICKNAME_RE` exige que não haja letra imediatamente antes de "a"/"A"
 * (lookbehind), pra não casar substantivos femininos terminados em "a" que
 * antecedem "diária" como adjetivo comum ("rotina diária", "cadência
 * diária"). "à diária" nunca aparece nas construções deste conteúdo
 * ("segundo/da/pela a diária" não exigem crase), e "a Diária" maiúscula só
 * ocorre em início de frase — cobrir os dois casos de capitalização (início
 * de sentença vs. no meio) é suficiente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HUB_LOADERS } from "../scripts/build-hub-page.ts";
import { collectReaderFacingStrings } from "../scripts/lib/shared/hub-page.ts";

const NICKNAME_RE = /(?<![\p{L}])[Aa] diária/u;

const HUBS = Object.entries(HUB_LOADERS).map(([slug, load]) => ({ slug, content: load() }));


describe("#4795 — hubs temáticos usam 'a diar.ia.br', nunca o apelido 'a diária', no texto reader-facing", () => {
  it("cobre TODO hub de HUB_LOADERS, não uma lista escrita à mão (#4899)", () => {
    assert.ok(HUBS.length >= 4, `esperado >= 4 hubs, veio ${HUBS.length} — o registry regrediu?`);
  });

  for (const { slug, content } of HUBS) {
    it(`${slug}: question/answer/heading/paragraphs/intro sem 'a diária'`, () => {
      const strings = collectReaderFacingStrings(content);
      assert.ok(strings.length > 0, `sanity: ${slug} deveria ter pelo menos 1 string reader-facing`);
      const violations = strings
        .filter(({ value }) => NICKNAME_RE.test(value))
        .map(({ field, value }) => `${slug}.${field}: "${value.match(NICKNAME_RE)?.[0]}" em "${value.slice(0, 80)}..."`);
      assert.deepEqual(
        violations,
        [],
        `Apelido informal "a diária" encontrado (use "a diar.ia.br"):\n  ${violations.join("\n  ")}`,
      );
    });
  }
});
