/**
 * test/intro-callout-marker-agnostic.test.ts (#3232)
 *
 * Regressão do bug relatado no #3232 (item 3 do inventário, o mais próximo
 * análogo ao bug do #3204): `extractIntroCallout` (scripts/lib/newsletter-parse.ts)
 * só reconhecia um CTA de topo (introCallout) quando o parágrafo bold-wrap
 * começava com `🎉` ou `📣`. Um CTA de topo com um marcador NOVO (ex: 🎥) —
 * ou até sem NENHUM marcador — não batia no regex e `extractIntroCallout`
 * retornava `null`: `content.introCallout` ficava vazio e o bloco inteiro
 * SUMIA do e-mail final, sem erro nenhum. Mesma classe de bug que #3204
 * corrigiu pro box-entre-destaques (silent content loss por dependência de
 * um allowlist de emoji), só que na região de INTRO (antes do 1º destaque)
 * em vez da lacuna entre 2 destaques.
 *
 * Fix (#3232): `extractIntroCallout` detecta o callout por POSIÇÃO (região de
 * intro, antes do 1º `**DESTAQUE`) + ESTRUTURA (bloco INTEIRAMENTE bold-wrap),
 * não por um allowlist de marcadores — nenhum código novo é necessário pra um
 * marcador inédito, mesma técnica do `locateBoxInGap` do #3204.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractIntroCallout } from "../scripts/lib/newsletter-parse.ts";
import { renderHTML, type NewsletterContent } from "../scripts/lib/newsletter-render-html.ts";

const INTRO_BEFORE = "Para esta edição, eu (o editor) enviei 3 submissões e a Diar.ia encontrou outros 10 artigos. Selecionamos os 5 mais relevantes.";

function buildMd(introCalloutBlock: string): string {
  return `TÍTULO

Um título qualquer

SUBTÍTULO

Sub um | Sub dois

---

${INTRO_BEFORE}

${introCalloutBlock}

---

**DESTAQUE 1 | 🧠 FRONTEIRA**

**[Título do destaque](https://example.com/d1)**

Corpo do destaque.

Por que isso importa:

Importa por isso.`;
}

describe("#3232 — extractIntroCallout com marcador NOVO (fora de qualquer allowlist) não some", () => {
  it("extrai o CTA de topo com marcador 🎥 (nunca esteve em nenhum allowlist)", () => {
    const md = buildMd(
      "**🎥 Assista: como a IA está mudando o cinema. Um documentário recente mostra bastidores de produção com IA generativa. [Assista ao trailer](https://example.com/trailer).**",
    );
    const cta = extractIntroCallout(md);
    assert.ok(cta, "CTA de topo com marcador 🎥 deveria ser extraído (não sumir)");
    assert.match(cta!, /Assista: como a IA está mudando o cinema/);
    assert.match(cta!, /trailer/);
  });

  it("CTA de topo SEM nenhum marcador emoji (texto puro bold-wrap) também é extraído", () => {
    const md = buildMd(
      "**Recomendação de leitura: o futuro do trabalho remoto. Um ensaio longo sobre como equipes distribuídas estão se reorganizando. [Leia o ensaio completo](https://example.com/ensaio).**",
    );
    const cta = extractIntroCallout(md);
    assert.ok(cta, "CTA de topo sem emoji nenhum deve ser extraído");
    assert.match(cta!, /futuro do trabalho remoto/);
  });

  it("reprodução do silent-drop pré-fix: um marcador NUNCA reconhecido pelo allowlist antigo (🎉|📣) resultaria em null — prova via um regex equivalente ao código antigo", () => {
    // Não podemos "voltar no tempo" e rodar o código antigo diretamente, mas
    // podemos provar que o BUG existia reproduzindo o comportamento do
    // regex antigo (`^\*\*\s*(?:🎉|📣)[\s\S]+\*\*\s*$`) contra o mesmo input
    // que o novo extractIntroCallout aceita — demonstrando que o antigo
    // rejeitaria (retornaria null) exatamente o caso que o novo aceita.
    const md = buildMd(
      "**🎥 Assista: como a IA está mudando o cinema. [Assista ao trailer](https://example.com/trailer).**",
    );
    const introRegion = md.split(/^\*\*DESTAQUE/m)[0];
    const OLD_RE = /^\*\*\s*((?:🎉|📣)[\s\S]+)\*\*\s*$/m;
    assert.equal(OLD_RE.test(introRegion), false, "regex antigo NÃO reconhecia o marcador 🎥 — silent-drop confirmado");
    // O NOVO extractIntroCallout, no mesmo input, encontra o bloco.
    assert.ok(extractIntroCallout(md), "extractIntroCallout novo (marcador-agnóstico) encontra o bloco que o antigo perderia");
  });

  it("renderHTML inclui o conteúdo do CTA 🎥 no e-mail final (nunca desaparece)", () => {
    const md = buildMd(
      "**🎥 Assista: como a IA está mudando o cinema. [Assista ao trailer](https://example.com/trailer).**",
    );
    const introCallout = extractIntroCallout(md);
    assert.ok(introCallout);
    const content: NewsletterContent = {
      title: "Título do destaque",
      subtitle: "Sub um | Sub dois",
      coverImage: "04-d1-2x1.jpg",
      coverageLine: INTRO_BEFORE,
      introCallout,
      destaques: [
        {
          n: 1,
          category: "FRONTEIRA",
          title: "Título do destaque",
          body: "Corpo do destaque.",
          why: "Importa por isso.",
          url: "https://example.com/d1",
          emoji: "🧠",
        },
        {
          n: 2,
          category: "PRODUTO",
          title: "Segundo destaque",
          body: "Corpo do destaque dois.",
          why: "Importa também.",
          url: "https://example.com/d2",
          emoji: "📦",
        },
      ],
      eia: { credit: "", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition: "260710" },
      sections: [],
    };
    const html = renderHTML(content);
    assert.ok(
      html.includes("Assista: como a IA está mudando o cinema"),
      "conteúdo do CTA de topo com marcador novo deve aparecer no HTML final",
    );
    assert.ok(html.includes("trailer"), "link do CTA preservado");
  });

  it("ignora negrito dentro de um destaque mesmo sem marcador (só olha a região de intro)", () => {
    const cta = extractIntroCallout(
      "intro\n\n**DESTAQUE 1 | X**\n\n**isso é título de destaque, não CTA de topo**",
    );
    assert.equal(cta, null);
  });
});
