/**
 * test/hub-content-no-diaria-nickname-4795.test.ts (#4795)
 *
 * Guard anti-regressão: o texto reader-facing dos hubs temáticos
 * (`scripts/lib/hubs/*.ts` — `question`/`answer` do FAQ, `heading`/
 * `paragraphs` das sections, `introHeading`/`introParagraph`) deve se referir
 * à newsletter pelo nome de marca "a diar.ia.br", nunca pelo apelido informal
 * "a diária" (e variantes de concordância que contêm essa substring — "da
 * diária", "pela diária", "segundo a diária"). Mesmo espírito do guard que o
 * #4424 já tem pra "Diar.ia" (`test/reader-facing-no-legacy-brand-4424.test.ts`)
 * — impede a forma errada de voltar via edição futura do conteúdo do hub.
 *
 * Escopo: só os 3 arquivos de conteúdo de hub temático publicados hoje
 * (#4558 Partes A-C). Comentários de código (docstrings, notas de
 * implementação) NÃO são cobertos por este guard — não aparecem em nenhuma
 * página, trocar é opcional (ver corpo da #4795).
 *
 * "a diária" é o achado real (#4795): nunca "à diária" (não existe em
 * PT-BR) nem "a Diária" maiúscula fora de início de frase — cobrir os dois
 * casos de capitalização (início de sentença vs. no meio) é suficiente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAnthropicClaudeHub } from "../scripts/lib/hubs/anthropic-claude.ts";
import { getOpenaiChatgptHub } from "../scripts/lib/hubs/openai-chatgpt.ts";
import { getGoogleGeminiHub } from "../scripts/lib/hubs/google-gemini.ts";
import type { HubContent } from "../scripts/lib/shared/hub-page.ts";

const NICKNAME_RE = /[Aa] diária/;

const HUBS: { slug: string; content: HubContent }[] = [
  { slug: "anthropic-claude", content: getAnthropicClaudeHub() },
  { slug: "openai-chatgpt", content: getOpenaiChatgptHub() },
  { slug: "google-gemini", content: getGoogleGeminiHub() },
];

function collectReaderFacingStrings(content: HubContent): { field: string; value: string }[] {
  const out: { field: string; value: string }[] = [];
  out.push({ field: "introHeading", value: content.introHeading });
  out.push({ field: "introParagraph", value: content.introParagraph });
  content.sections.forEach((section, sIdx) => {
    out.push({ field: `sections[${sIdx}].heading`, value: section.heading });
    section.paragraphs.forEach((p, pIdx) => {
      out.push({ field: `sections[${sIdx}].paragraphs[${pIdx}]`, value: p });
    });
  });
  content.faq.forEach((item, fIdx) => {
    out.push({ field: `faq[${fIdx}].question`, value: item.question });
    out.push({ field: `faq[${fIdx}].answer`, value: item.answer });
  });
  return out;
}

describe("#4795 — hubs temáticos usam 'a diar.ia.br', nunca o apelido 'a diária', no texto reader-facing", () => {
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
