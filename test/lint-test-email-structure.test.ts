import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractMdStructure,
  extractEmailStructure,
  compareStructure,
} from "../scripts/lint-test-email-structure.ts";

describe("extractMdStructure (#1248)", () => {
  it("detecta É IA? presente", () => {
    const md = "Algum texto\n\nÉ IA?\n\n[Foto](url)\n";
    const r = extractMdStructure(md);
    assert.equal(r.has_eia, true);
  });

  it("É IA? ausente quando não há menção", () => {
    const md = "Apenas destaques\n";
    assert.equal(extractMdStructure(md).has_eia, false);
  });

  it("extrai destaques", () => {
    const md = `
**DESTAQUE 1 | MERCADO**

**[Título A](https://a.com)**

Body...

---

**DESTAQUE 2 | LANÇAMENTO**

**[Título B](https://b.com)**

Body...
`;
    const r = extractMdStructure(md);
    assert.equal(r.destaques.length, 2);
    assert.equal(r.destaques[0], "Título A");
    assert.equal(r.destaques[1], "Título B");
  });

  it("conta itens em seções LANÇAMENTOS/PESQUISAS/OUTRAS NOTÍCIAS", () => {
    const md = `
**LANÇAMENTOS**

**[Item 1](https://a.com)**
desc 1

**[Item 2](https://b.com)**
desc 2

---

**OUTRAS NOTÍCIAS**

**[Item 3](https://c.com)**
desc 3
`;
    const r = extractMdStructure(md);
    const lan = r.sections.find((s) => s.name === "LANÇAMENTOS");
    const outras = r.sections.find((s) => s.name === "OUTRAS NOTÍCIAS");
    assert.equal(lan?.item_count, 2);
    assert.equal(outras?.item_count, 1);
  });

  it("#1660: detecta USE MELHOR e VÍDEOS (headers com emoji)", () => {
    const md = `
**📡 RADAR**

**[Notícia 1](https://r.com/1)**
desc

**[Notícia 2](https://r.com/2)**
desc

---

**🛠️ USE MELHOR**

**[Tutorial X](https://t.com/x)**
desc

---

**📺 VÍDEOS**

**[Vídeo A](https://v.com/a)**
desc

**[Vídeo B](https://v.com/b)**
desc
`;
    const r = extractMdStructure(md);
    const radar = r.sections.find((s) => s.name === "RADAR");
    const useMelhor = r.sections.find((s) => s.name === "USE MELHOR");
    const videos = r.sections.find((s) => s.name === "VÍDEOS");
    assert.equal(useMelhor?.item_count, 1, "USE MELHOR deve ser detectada");
    assert.equal(videos?.item_count, 2, "VÍDEOS deve ser detectada");
    // #1660 agravante: boundary de VÍDEOS impede RADAR de super-contar.
    assert.equal(radar?.item_count, 2, "RADAR não deve super-contar itens de USE MELHOR/VÍDEOS");
  });

  it("#1660: VÍDEO singular (#1324) também é detectado", () => {
    const md = `
**📺 VÍDEO**

**[Único vídeo](https://v.com/só)**
desc
`;
    const r = extractMdStructure(md);
    const videos = r.sections.find((s) => s.name === "VÍDEOS");
    assert.equal(videos?.item_count, 1);
  });
});

describe("extractEmailStructure (#1248)", () => {
  it("detecta É IA? presente em HTML", () => {
    const html = '<p>texto</p><h2>É IA?</h2><p>imagens</p>';
    assert.equal(extractEmailStructure(html).has_eia, true);
  });

  it("strip HTML tags pra detectar seções (headers com emoji, como em produção)", () => {
    // #1660: o render sempre prefixa o header com emoji (section-naming.ts).
    const html = `
      <div><h3>🚀 LANÇAMENTOS</h3>
        <a href="https://a.com">Item 1</a>
        <a href="https://b.com">Item 2</a>
      </div>
      <div><h3>📰 OUTRAS NOTÍCIAS</h3>
        <a href="https://c.com">Item 3</a>
      </div>
    `;
    const r = extractEmailStructure(html);
    const lan = r.sections.find((s) => s.name === "LANÇAMENTOS");
    assert.ok(lan);
    assert.ok(lan!.item_count >= 1);
  });

  it("#1936: detecta seção com bullet ● (kicker DS sem emoji)", () => {
    // O novo design troca o emoji do kicker pelo ponto ● (`&#9679;`). A detecção
    // não pode exigir emoji, senão o loop do Stage 4 reporta toda seção faltando.
    const html = `
      <td style="color:#00A0A0;"><span style="color:#00A0A0;">&#9679;</span>&nbsp;RADAR</td>
      <a href="https://r.com/1">N1</a>
      <a href="https://r.com/2">N2</a>
      <td style="color:#00A0A0;"><span style="color:#00A0A0;">&#9679;</span>&nbsp;USE MELHOR</td>
      <a href="https://t.com/x">Tutorial</a>
    `;
    const r = extractEmailStructure(html);
    assert.ok(r.sections.find((s) => s.name === "RADAR"), "RADAR detectado via bullet ●");
    assert.ok(r.sections.find((s) => s.name === "USE MELHOR"), "USE MELHOR detectado via bullet ●");
  });

  it("#1660: detecta USE MELHOR e VÍDEOS no email (headers com emoji)", () => {
    const html = `
      <h3>📡 RADAR</h3>
      <a href="https://r.com/1">N1</a>
      <a href="https://r.com/2">N2</a>
      <h3>🛠️ USE MELHOR</h3>
      <a href="https://t.com/x">Tutorial</a>
      <h3>📺 VÍDEOS</h3>
      <a href="https://v.com/a">Vídeo A</a>
      <a href="https://v.com/b">Vídeo B</a>
    `;
    const r = extractEmailStructure(html);
    assert.ok(r.sections.find((s) => s.name === "USE MELHOR"), "USE MELHOR detectada");
    assert.ok(r.sections.find((s) => s.name === "VÍDEOS"), "VÍDEOS detectada");
  });

  it("#1660: keyword bare em prosa NÃO cria seção fantasma (âncora de emoji)", () => {
    // "vídeo"/"radar"/"use melhor" em headline/prosa SEM emoji de header → não
    // deve virar seção (senão mascara section_missing — bug do review #1720).
    const html = `
      <h3>📡 RADAR</h3>
      <a href="https://r.com/1">Assista o novo vídeo viral da OpenAI</a>
      <a href="https://r.com/2">Como o radar de IA mudou — use melhor seus prompts</a>
    `;
    const r = extractEmailStructure(html);
    assert.ok(r.sections.find((s) => s.name === "RADAR"), "RADAR (header real) detectada");
    assert.equal(r.sections.find((s) => s.name === "VÍDEOS"), undefined, "VÍDEOS fantasma NÃO criada");
    assert.equal(r.sections.find((s) => s.name === "USE MELHOR"), undefined, "USE MELHOR fantasma NÃO criada");
  });

  it("ignora <style>/<script>", () => {
    const html = `
      <style>body { color: red; } .nope { content: "É IA?" }</style>
      <p>conteúdo</p>
    `;
    const r = extractEmailStructure(html);
    assert.equal(r.has_eia, false);
  });
});

describe("compareStructure (#1248)", () => {
  it("eia_section_missing quando source tem mas email não", () => {
    const source = { has_eia: true, destaques: [], sections: [] };
    const email = { has_eia: false, destaques: [], sections: [] };
    const issues = compareStructure(source, email);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].type, "eia_section_missing");
  });

  it("section_missing quando source tem mas email não", () => {
    const source = {
      has_eia: false,
      destaques: [],
      sections: [{ name: "LANÇAMENTOS", item_count: 2 }],
    };
    const email = { has_eia: false, destaques: [], sections: [] };
    const issues = compareStructure(source, email);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].type, "section_missing");
    assert.equal(issues[0].section, "LANÇAMENTOS");
  });

  it("#1660 e2e: VÍDEOS dropado no email (com 'vídeo' em prosa) → section_missing dispara", () => {
    // O bug exato do #1660: paste dropa a seção VÍDEOS. Antes (KNOWN_SECTIONS sem
    // VÍDEOS) não emitia nada. Agora emite — e o keyword "vídeo" na prosa do RADAR
    // NÃO cria fantasma que mascararia (review #1720).
    const sourceMd = `
**📡 RADAR**

**[Notícia](https://r.com/1)**
desc

---

**📺 VÍDEOS**

**[Vídeo A](https://v.com/a)**
desc
`;
    const emailHtml = `
      <h3>📡 RADAR</h3>
      <a href="https://r.com/1">Assista o vídeo viral</a>
    `; // VÍDEOS header dropado; "vídeo" só na prosa
    const source = extractMdStructure(sourceMd);
    const email = extractEmailStructure(emailHtml);
    const issues = compareStructure(source, email);
    const videosMissing = issues.find(
      (i) => i.type === "section_missing" && i.section === "VÍDEOS",
    );
    assert.ok(videosMissing, "section_missing de VÍDEOS deve disparar (não mascarado por fantasma)");
  });

  it("destaque_count_mismatch quando counts divergem", () => {
    const source = { has_eia: false, destaques: ["A", "B", "C"], sections: [] };
    const email = { has_eia: false, destaques: ["A", "B"], sections: [] };
    const issues = compareStructure(source, email);
    const m = issues.find((i) => i.type === "destaque_count_mismatch");
    assert.ok(m);
    assert.equal(m!.source_count, 3);
    assert.equal(m!.email_count, 2);
  });

  it("#1721: seção presente com contagem divergente NÃO emite mismatch", () => {
    // Documenta a decisão do #1721: `section_item_count_mismatch` foi removido
    // do union porque compareStructure só compara PRESENÇA de seção (o item_count
    // do email é heurístico → comparar exato geraria falso-positivo). Uma seção
    // presente em ambos mas com counts diferentes não deve gerar issue alguma.
    const source = {
      has_eia: false,
      destaques: [],
      sections: [{ name: "LANÇAMENTOS", item_count: 5 }],
    };
    const email = {
      has_eia: false,
      destaques: [],
      sections: [{ name: "LANÇAMENTOS", item_count: 3 }],
    };
    assert.deepEqual(compareStructure(source, email), []);
  });

  it("sem issues quando estruturas batem", () => {
    const source = {
      has_eia: true,
      destaques: ["A"],
      sections: [{ name: "LANÇAMENTOS", item_count: 2 }],
    };
    const email = {
      has_eia: true,
      destaques: ["A"],
      sections: [{ name: "LANÇAMENTOS", item_count: 2 }],
    };
    assert.deepEqual(compareStructure(source, email), []);
  });
});
