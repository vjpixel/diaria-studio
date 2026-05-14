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
});

describe("extractEmailStructure (#1248)", () => {
  it("detecta É IA? presente em HTML", () => {
    const html = '<p>texto</p><h2>É IA?</h2><p>imagens</p>';
    assert.equal(extractEmailStructure(html).has_eia, true);
  });

  it("strip HTML tags pra detectar seções", () => {
    const html = `
      <div><h3>LANÇAMENTOS</h3>
        <a href="https://a.com">Item 1</a>
        <a href="https://b.com">Item 2</a>
      </div>
      <div><h3>OUTRAS NOTÍCIAS</h3>
        <a href="https://c.com">Item 3</a>
      </div>
    `;
    const r = extractEmailStructure(html);
    const lan = r.sections.find((s) => s.name === "LANÇAMENTOS");
    assert.ok(lan);
    assert.ok(lan!.item_count >= 1);
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

  it("destaque_count_mismatch quando counts divergem", () => {
    const source = { has_eia: false, destaques: ["A", "B", "C"], sections: [] };
    const email = { has_eia: false, destaques: ["A", "B"], sections: [] };
    const issues = compareStructure(source, email);
    const m = issues.find((i) => i.type === "destaque_count_mismatch");
    assert.ok(m);
    assert.equal(m!.source_count, 3);
    assert.equal(m!.email_count, 2);
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
