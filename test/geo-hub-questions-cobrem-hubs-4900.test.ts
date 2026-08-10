/**
 * test/geo-hub-questions-cobrem-hubs-4900.test.ts (#4900 item a)
 *
 * Guard: todo hub publicado precisa ter pergunta correspondente no painel
 * temático do monitor de citação. Sem isto, o painel mede um recorte do
 * inventário sem ninguém notar — foi exatamente o que aconteceu: a #4926
 * publicou o 4º hub (`meta-ai`) e o painel continuou com perguntas para 3,
 * com o docstring afirmando "não existe hub `meta-*` hoje" horas depois de
 * ele passar a existir.
 *
 * **Por que um guard e não derivação.** O contrato de prosa do #4899 resolve
 * o problema irmão derivando de `HUB_LOADERS`, pra que hub futuro nasça
 * coberto. Aqui a derivação seria ATIVAMENTE ERRADA: publicar um hub passaria
 * a mudar o conjunto de perguntas no meio da série, e a regra de parada de
 * outubro (#4558, comentário de 07/08) depende de o instrumento ficar fixo —
 * trocar as perguntas depois de ver o resultado invalida a comparação.
 *
 * Um guard que AVISA preserva as duas coisas: a série não muda sozinha, e a
 * lacuna não passa em silêncio. Quando este teste quebrar, a decisão é do
 * editor, não do código: acrescentar as perguntas e RESETAR o baseline, ou
 * registrar por escrito que o hub novo fica fora da série corrente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GEO_HUB_QUESTIONS } from "../scripts/lib/geo-citation-monitor.ts";
import { HUB_META } from "../workers/arquivo/src/hubs/meta.ts";

/** Primeiro token do rótulo do hub — a empresa. "Anthropic e Claude" →
 * "Anthropic". É o termo que uma pergunta sobre o tema necessariamente cita;
 * o segundo ("Claude", "ChatGPT") é o produto, e nem toda pergunta o usa. */
function companyOf(label: string): string {
  return label.split(/\s+/)[0];
}

describe("#4900 — o painel temático cobre todo hub publicado", () => {
  it("sanity: HUB_META e GEO_HUB_QUESTIONS não estão vazios", () => {
    assert.ok(HUB_META.length > 0);
    assert.ok(GEO_HUB_QUESTIONS.length > 0);
  });

  for (const hub of HUB_META) {
    it(`${hub.slug}: existe pelo menos uma pergunta citando "${companyOf(hub.label)}"`, () => {
      const company = companyOf(hub.label).toLowerCase();
      const matching = GEO_HUB_QUESTIONS.filter((q) => q.toLowerCase().includes(company));
      assert.ok(
        matching.length > 0,
        `Hub "${hub.slug}" (${hub.label}) foi publicado mas não tem pergunta no painel temático.\n` +
          `Isso NÃO se resolve sozinho de propósito — acrescentar pergunta com a série em curso\n` +
          `invalida a comparação do checkpoint. Decisão do editor: acrescentar e resetar o\n` +
          `baseline, ou registrar que este hub fica fora da série corrente.\n` +
          `Perguntas atuais:\n  ${GEO_HUB_QUESTIONS.join("\n  ")}`,
      );
    });
  }

  it("nenhuma pergunta é duplicada (uma duplicata dobraria o peso do tema na série)", () => {
    const seen = new Set<string>();
    const dups = GEO_HUB_QUESTIONS.filter((q) => {
      const k = q.trim().toLowerCase();
      if (seen.has(k)) return true;
      seen.add(k);
      return false;
    });
    assert.deepEqual(dups, []);
  });

  it("o painel NÃO é derivado do registry — a lista é literal", () => {
    // Trava a decisão de desenho descrita no docstring: se alguém trocar a
    // constante por algo computado a partir de HUB_META/HUB_LOADERS, o
    // instrumento passa a mudar sozinho quando um hub é publicado, no meio
    // da série. Este teste não impede a mudança, mas força quem a fizer a
    // apagá-lo — e a ler o porquê antes.
    assert.ok(
      GEO_HUB_QUESTIONS.length >= HUB_META.length,
      "esperado ao menos 1 pergunta por hub; abaixo disso o painel não cobre o inventário",
    );
    assert.ok(
      GEO_HUB_QUESTIONS.every((q) => typeof q === "string" && q.trim().endsWith("?")),
      "toda entrada precisa ser uma pergunta literal em pt-BR",
    );
  });
});
