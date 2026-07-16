/**
 * test/box-divulgacao-marker-agnostic.test.ts (#3204)
 *
 * Regressão do bug relatado: um box de divulgação numa lacuna entre destaques
 * (slot D1/D2 ou D2/D3) com um marcador FORA do allowlist antigo (📚|📖|📣|🎉
 * bold-line, 🛒 carrinho) sumia silenciosamente — sem erro, sem lint, sem
 * entrada no render (caso real: 📖 na edição 260709, antes do stopgap que
 * adicionou só esse emoji).
 *
 * Fix (#3204): `locateBoxInGap` em newsletter-parse.ts detecta o box por
 * POSIÇÃO + ESTRUTURA (bloco `---`-isolado após o próprio destaque), não por
 * um allowlist de marcadores — nenhum código novo é necessário pra um
 * marcador inédito. Backstop: `findOrphanBoxWarnings` (lacuna com blocos
 * extras ambíguos) + `lintCalloutPlacement` (marcador-agnóstico desde #3204,
 * box colado sem `---` isolando) garantem que, se ALGO ainda assim não virar
 * box, falha alto em vez de sumir em silêncio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractContent,
  extractBoxDivulgacao1,
  extractBoxDivulgacao2,
  extractBoxDivulgacao3,
  findOrphanBoxWarnings,
} from "../scripts/lib/newsletter-parse.ts";
import { renderHTML } from "../scripts/lib/newsletter-render-html.ts";
import { lintCalloutPlacement } from "../scripts/lib/lint-checks/callout-placement.ts";

const EIA = `**É IA?**

Foto teste. [Autor](https://example.com/a) / CC.

Resultado da última edição: 40% das pessoas acertaram.
`;

function d(n: number, cat: string, url: string): string {
  return `**DESTAQUE ${n} | ${cat}**

**[Título D${n}](${url})**

Corpo do destaque ${n}.

Por que isso importa:

Why do D${n}.
`;
}

function buildReviewed(box1: string): string {
  return `Para esta edição, selecionamos 12 itens.

---

${d(1, "🚀 LANÇAMENTO", "https://example.com/d1")}

---

${box1}

---

${d(2, "💼 MERCADO", "https://example.com/d2")}

---

${d(3, "💼 TRABALHO", "https://example.com/d3")}

---

${EIA}

---

**📡 RADAR**

**[Item de radar](https://example.com/r1)**
Resumo do item.
`;
}

function withEdition(reviewed: string, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ed-3204-"));
  try {
    writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
    writeFileSync(join(dir, "01-eia.md"), EIA, "utf8");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#3204 — box com marcador NOVO (fora de qualquer allowlist) não some", () => {
  // Caso concreto do issue: marcador nunca antes suportado (🎥), formato
  // multi-parágrafo (título + corpo), isolado por `---` na lacuna D1/D2 —
  // exatamente a forma da 📖 Recomendação de Leitura da 260709.
  const BOX_NOVO_MARCADOR = `🎥 Assista: como a IA está mudando o cinema

Um documentário recente mostra bastidores de produção com IA generativa.

[Assista ao trailer](https://example.com/trailer)`;

  it("extractBoxDivulgacao1 encontra o box com marcador 🎥 (nunca esteve em nenhum allowlist)", () => {
    withEdition(buildReviewed(BOX_NOVO_MARCADOR), (dir) => {
      const c = extractContent(dir);
      assert.ok(c.boxDivulgacao1, "box com marcador 🎥 deveria ser extraído (não sumir)");
      assert.match(c.boxDivulgacao1!, /Assista: como a IA está mudando o cinema/);
      assert.match(c.boxDivulgacao1!, /documentário recente/);
    });
  });

  it("renderHTML inclui o conteúdo do box 🎥 (nunca desaparece do e-mail final)", () => {
    withEdition(buildReviewed(BOX_NOVO_MARCADOR), (dir) => {
      const html = renderHTML(extractContent(dir));
      assert.ok(
        html.includes("Assista: como a IA está mudando o cinema"),
        "conteúdo do box com marcador novo deve aparecer no HTML renderizado",
      );
      assert.ok(html.includes("trailer"), "link do box preservado");
      // Não deve vazar o destaque D2 nem duplicar conteúdo — o box some do lugar
      // certo (entre D1 e D2) e não contamina o body/why de nenhum destaque.
      const d1Idx = html.indexOf("Título D1");
      const d2Idx = html.indexOf("Título D2");
      const boxIdx = html.indexOf("Assista: como a IA");
      assert.ok(d1Idx !== -1 && d2Idx !== -1 && boxIdx > d1Idx && boxIdx < d2Idx);
    });
  });

  it("box SEM nenhum marcador emoji (texto puro) também é extraído — o parser não depende de emoji nenhum", () => {
    const boxSemEmoji = `Recomendação de leitura: o futuro do trabalho remoto

Um ensaio longo sobre como equipes distribuídas estão se reorganizando.

[Leia o ensaio completo](https://example.com/ensaio)`;
    withEdition(buildReviewed(boxSemEmoji), (dir) => {
      const c = extractContent(dir);
      assert.ok(c.boxDivulgacao1, "box sem emoji nenhum deve ser extraído");
      assert.match(c.boxDivulgacao1!, /futuro do trabalho remoto/);
      const html = renderHTML(c);
      assert.ok(html.includes("futuro do trabalho remoto"), "conteúdo aparece no HTML");
      assert.ok(html.includes("ensaio completo"), "link do box preservado");
    });
  });

  it("code-review: box cujo CORPO menciona uma palavra igual a nome de seção (ex: 'RADAR' numa linha isolada) não é rejeitado (a checagem de header é só a 1ª linha do bloco, não o bloco inteiro)", () => {
    const boxComPalavraDeSecao = `🎥 Cobertura completa do lançamento

RADAR

Detalhe extra sobre o assunto, sem relação com a seção RADAR da newsletter.

[Saiba mais](https://example.com/cobertura)`;
    withEdition(buildReviewed(boxComPalavraDeSecao), (dir) => {
      const c = extractContent(dir);
      assert.ok(
        c.boxDivulgacao1,
        "box não deveria ser rejeitado só porque uma linha do meio parece um header de seção",
      );
      assert.match(c.boxDivulgacao1!, /Cobertura completa do lançamento/);
    });
  });

  it("box bold-line com marcador novo (🎁) infere formato pela ESTRUTURA (bold-wrap), não pelo emoji", () => {
    const boxBoldNovo = "**🎁 Sorteio surpresa: participe até sexta. [Saiba mais](https://example.com/sorteio).**";
    withEdition(buildReviewed(boxBoldNovo), (dir) => {
      const c = extractContent(dir);
      assert.ok(c.boxDivulgacao1, "box bold-line com marcador novo deve ser extraído");
      // formatBoxInner despe o `**` estrutural (mesmo contrato do antigo BOLD_RE).
      assert.equal(c.boxDivulgacao1, "🎁 Sorteio surpresa: participe até sexta. [Saiba mais](https://example.com/sorteio).");
      const html = renderHTML(c);
      assert.ok(html.includes("Sorteio surpresa"), "conteúdo aparece no HTML");
      assert.ok(!html.includes("**"), "delimitadores ** não vazam pro HTML");
    });
  });
});

describe("#3204 — regressão: marcadores já suportados continuam funcionando", () => {
  const CASES: Array<[string, string, RegExp]> = [
    ["📚 bold-line (livros)", "**📚 Curadoria de livros sobre IA. [Confira](https://livros.diaria.workers.dev).**", /Curadoria de livros/],
    ["📣 bold-line (patrocinado)", "**📣 Escreva melhor com a Clarice.ai. [Acesse](https://clarice.ai/precos-planos?via=diaria).**", /Escreva melhor com a Clarice/],
    ["🎉 bold-line (CTA editorial)", "**🎉 Venha pro sorteio ao vivo! [Participe](https://meet.google.com/xyz).**", /Venha pro sorteio ao vivo/],
    ["🛒 carrinho (multi-parágrafo)", "🛒 Equipe sua casa com a Alexa+\n\nVeja os dispositivos: [Show 8](https://link.amazon/B00RlxPou)\n\nAo comprar, a Diar.ia recebe comissão.", /Equipe sua casa com a Alexa/],
    ["📖 multi-parágrafo (recomendação de leitura)", "📖 Recomendação de Leitura: o dilema dos dados\n\nUm texto longo sobre privacidade e IA.\n\n[Leia o texto completo](https://example.com/texto)", /dilema dos dados/],
  ];

  for (const [label, box, expected] of CASES) {
    it(`${label} — continua sendo extraído e renderizado sem regressão`, () => {
      withEdition(buildReviewed(box), (dir) => {
        const c = extractContent(dir);
        assert.ok(c.boxDivulgacao1, `${label}: box deveria ser extraído`);
        assert.match(c.boxDivulgacao1!, expected);
        const html = renderHTML(c);
        assert.match(html, expected, `${label}: conteúdo deveria aparecer no HTML`);
      });
    });
  }
});

describe("#3204 — findOrphanBoxWarnings: lacuna com blocos extras ambíguos", () => {
  it("2 blocos --- isolados na mesma lacuna → warning (só o 1º vira box; o resto seria descartado)", () => {
    const reviewed = `${d(1, "🚀 LANÇAMENTO", "https://example.com/d1")}

---

🎥 Primeiro box candidato

[Link 1](https://example.com/1)

---

🎁 Segundo box candidato (ambíguo — mesma lacuna)

[Link 2](https://example.com/2)

---

${d(2, "💼 MERCADO", "https://example.com/d2")}`;
    const warnings = findOrphanBoxWarnings(reviewed);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].gapIndex, 0);
    assert.match(warnings[0].reason, /2 blocos extras/);
  });

  it("lacuna com só 1 bloco extra → sem warning", () => {
    const reviewed = buildReviewed("🎥 Box único\n\n[Link](https://example.com/x)");
    assert.deepEqual(findOrphanBoxWarnings(reviewed), []);
  });

  it("lacuna sem nenhum box → sem warning", () => {
    const reviewed = `${d(1, "🚀 LANÇAMENTO", "https://example.com/d1")}

---

${d(2, "💼 MERCADO", "https://example.com/d2")}`;
    assert.deepEqual(findOrphanBoxWarnings(reviewed), []);
  });
});

describe("#3204 — lintCalloutPlacement marcador-agnóstico: box colado (sem ---) é flagrado mesmo sem emoji reconhecido", () => {
  it("bold-line inteiro colado dentro da seção do destaque (emoji NUNCA visto antes) → flag", () => {
    const misplaced = [
      "**DESTAQUE 1 | LANÇAMENTO**",
      "",
      "**[Título](https://x.com)**",
      "",
      "Corpo.",
      "",
      "Por que isso importa:",
      "",
      "Why.",
      "",
      "**🎥 Box colado sem separador. [Assista](https://x.com/v).**",
      "",
      "---",
      "",
      "**DESTAQUE 2 | LANÇAMENTO**",
    ].join("\n");
    const result = lintCalloutPlacement(misplaced);
    assert.equal(result.ok, false, "deveria flagrar o bloco colado, mesmo com emoji nunca visto");
    assert.match(result.matches[0].context, /🎥/);
  });

  it("parágrafo emoji-led (sem bold-wrap) colado dentro da seção → flag", () => {
    const misplaced = [
      "**DESTAQUE 1 | LANÇAMENTO**",
      "",
      "**[Título](https://x.com)**",
      "",
      "Corpo.",
      "",
      "🎁 Presente colado sem separador nem negrito.",
      "",
      "---",
      "",
      "**DESTAQUE 2 | LANÇAMENTO**",
    ].join("\n");
    const result = lintCalloutPlacement(misplaced);
    assert.equal(result.ok, false, "parágrafo emoji-led colado também deve ser flagrado");
  });

  it("título do destaque (1º parágrafo, bold-wrapped) NUNCA é flagrado", () => {
    const ok = [
      "**DESTAQUE 1 | LANÇAMENTO**",
      "",
      "**[Título completamente bold-wrapped](https://x.com)**",
      "",
      "Corpo normal, sem nenhum bloco suspeito.",
      "",
      "---",
      "",
      "**DESTAQUE 2 | LANÇAMENTO**",
    ].join("\n");
    assert.equal(lintCalloutPlacement(ok).ok, true);
  });
});

describe("#3204 — box GLUADO (sem ---) ao final do destaque ainda é recuperado quando tem link (Opção A robustez)", () => {
  it("bold-line com link, colado ao final do why (sem ---), é extraído mesmo assim — não é descartado", () => {
    const reviewed = `${d(1, "🚀 LANÇAMENTO", "https://example.com/d1").trimEnd()}

**🎥 Box colado sem separador. [Assista](https://example.com/v).**

---

${d(2, "💼 MERCADO", "https://example.com/d2")}`;
    const box = extractBoxDivulgacao1(reviewed);
    assert.ok(box, "box colado com link deveria ser recuperado (fallback glued)");
    assert.match(box!, /Box colado sem separador/);
  });

  it("ênfase retórica bold-wrapped SEM link no fim do why NÃO é confundida com box (evita falso-positivo)", () => {
    const reviewed = `${d(1, "🚀 LANÇAMENTO", "https://example.com/d1").trimEnd()}

**Isso muda tudo para o mercado.**

---

${d(2, "💼 MERCADO", "https://example.com/d2")}`;
    assert.equal(extractBoxDivulgacao1(reviewed), null, "ênfase sem link não deveria virar box");
  });
});

// ─── #3476 — extractBoxDivulgacao3: box na região pós-ÚLTIMO-destaque ────────

describe("#3476 — extractBoxDivulgacao3: box posicionado após o ÚLTIMO destaque, antes de USE MELHOR/É IA?", () => {
  function buildReviewedWithBox3(box3: string | null, useMelhorBlock = ""): string {
    const um = useMelhorBlock ? `${useMelhorBlock}\n\n---\n\n` : "";
    return `Para esta edição, selecionamos 12 itens.

---

${d(1, "🚀 LANÇAMENTO", "https://example.com/d1")}

---

${d(2, "💼 MERCADO", "https://example.com/d2")}

---

${d(3, "💼 TRABALHO", "https://example.com/d3")}

---

${box3 ? `${box3}\n\n---\n\n` : ""}${um}${EIA}

---

**📡 RADAR**

**[Item de radar](https://example.com/r1)**
Resumo do item.
`;
  }

  it("box com marcador novo (🔧) isolado entre D3 e É IA? é extraído (marker-agnóstico, mesma técnica do #3204)", () => {
    const box3 = `🔧 Indicação de ferramenta: uso o Raycast todo dia.

_Não recebi comissão por essa indicação._`;
    const reviewed = buildReviewedWithBox3(box3);
    const found = extractBoxDivulgacao3(reviewed);
    assert.ok(found, "box3 deveria ser extraído");
    assert.match(found!, /uso o Raycast todo dia/);
    assert.match(found!, /Não recebi comissão/);
  });

  it("box3 entre D3 e USE MELHOR (não entre D3 e É IA? quando USE MELHOR presente)", () => {
    const box3 = "🔧 Indicação de ferramenta: [Raycast](https://raycast.com).";
    const useMelhorBlock = "**🛠️ USE MELHOR**\n\n**[Tutorial](https://example.com/t)**\nDescrição.";
    const reviewed = buildReviewedWithBox3(box3, useMelhorBlock);
    const found = extractBoxDivulgacao3(reviewed);
    assert.ok(found, "box3 deveria ser extraído mesmo com USE MELHOR na região");
    assert.match(found!, /Raycast/);
  });

  it("sem box3 na região — extractBoxDivulgacao3 retorna null (não confunde USE MELHOR/É IA? com box)", () => {
    const reviewed = buildReviewedWithBox3(null);
    assert.equal(extractBoxDivulgacao3(reviewed), null);
  });

  it("box3 GLUADO (sem ---) ao final do último destaque ainda é recuperado (fallback, mesma técnica do #3204)", () => {
    const reviewed = `${d(1, "🚀 LANÇAMENTO", "https://example.com/d1")}

---

${d(2, "💼 MERCADO", "https://example.com/d2")}

---

${d(3, "💼 TRABALHO", "https://example.com/d3").trimEnd()}

**🔧 Box colado sem separador. [Ver](https://example.com/f).**

---

${EIA}`;
    const found = extractBoxDivulgacao3(reviewed);
    assert.ok(found, "box3 glúado deveria ser recuperado");
    assert.match(found!, /Box colado sem separador/);
  });

  it("box3 renderiza no HTML entre Destaque 3 e USE MELHOR (round-trip extractContent + renderHTML)", () => {
    const box3 = "🔧 Indicação de ferramenta: uso o [Raycast](https://raycast.com) todo dia.";
    const useMelhorBlock = "**🛠️ USE MELHOR**\n\n**[Tutorial de Cursor](https://example.com/t)**\nDescrição do tutorial.";
    const reviewed = buildReviewedWithBox3(box3, useMelhorBlock);
    const dir = mkdtempSync(join(tmpdir(), "ed-3476-"));
    try {
      writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
      writeFileSync(join(dir, "01-eia.md"), EIA, "utf8");
      const content = extractContent(dir);
      assert.ok(content.boxDivulgacao3, "content.boxDivulgacao3 populado");
      const html = renderHTML(content);
      const d3Idx = html.indexOf("<!-- Destaque 3 -->");
      const box3Idx = html.indexOf("uso o");
      const umIdx = html.indexOf("<!-- USE MELHOR -->");
      const eiaIdx = html.indexOf("<!-- É IA? (poll) -->");
      assert.ok(d3Idx !== -1 && box3Idx !== -1 && umIdx !== -1 && eiaIdx !== -1);
      // #3476: D3 < box3 < USE MELHOR < É IA?.
      assert.ok(
        d3Idx < box3Idx && box3Idx < umIdx && umIdx < eiaIdx,
        `Posição incorreta: D3(${d3Idx}) < box3(${box3Idx}) < USEM(${umIdx}) < ÉIA(${eiaIdx})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#3476 — findOrphanBoxWarnings: região pós-destaques (slot 3) com blocos extras ambíguos", () => {
  it("2 blocos --- isolados entre D3 e USE MELHOR → warning (só o 1º vira box3)", () => {
    const reviewed = `${d(1, "🚀 LANÇAMENTO", "https://example.com/d1")}

---

${d(2, "💼 MERCADO", "https://example.com/d2")}

---

${d(3, "💼 TRABALHO", "https://example.com/d3")}

---

🔧 Primeiro candidato

[Link 1](https://example.com/1)

---

🎁 Segundo candidato (ambíguo — mesma região)

[Link 2](https://example.com/2)

---

**🛠️ USE MELHOR**

**[Tutorial](https://example.com/t)**
Desc.`;
    const warnings = findOrphanBoxWarnings(reviewed);
    const slot3Warning = warnings.find((w) => w.gapIndex === 2);
    assert.ok(slot3Warning, "deveria haver warning pra região pós-destaques (gapIndex 2)");
    assert.match(slot3Warning!.reason, /2 blocos extras/);
  });

  it("só 1 bloco extra entre D3 e USE MELHOR → sem warning de slot3", () => {
    const reviewed = `${d(1, "🚀 LANÇAMENTO", "https://example.com/d1")}

---

${d(2, "💼 MERCADO", "https://example.com/d2")}

---

${d(3, "💼 TRABALHO", "https://example.com/d3")}

---

🔧 Box único

[Link](https://example.com/x)

---

**🛠️ USE MELHOR**

**[Tutorial](https://example.com/t)**
Desc.`;
    const warnings = findOrphanBoxWarnings(reviewed);
    assert.equal(warnings.find((w) => w.gapIndex === 2), undefined);
  });
});
