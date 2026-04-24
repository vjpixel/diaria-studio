import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkUnresolvedPlaceholders,
  checkBrokenLinks,
  checkDuplicateHeadings,
  checkMojibake,
  checkWideTables,
  checkImgsWithoutAlt,
  checkUnsafeTargetBlank,
  lintHtml,
} from "../scripts/lint-newsletter-html.ts";

describe("checkUnresolvedPlaceholders", () => {
  it("detecta placeholders {{IMG:...}} remanescentes", () => {
    const html = `<img src="{{IMG:04-d1-2x1.jpg}}"/><img src="https://drive.google.com/x"/>`;
    const issues = checkUnresolvedPlaceholders(html);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].count, 1);
    assert.equal(issues[0].severity, "error");
  });

  it("HTML sem placeholders passa", () => {
    assert.deepEqual(checkUnresolvedPlaceholders("<img src='https://x'/>"), []);
  });
});

describe("checkBrokenLinks", () => {
  it("detecta href vazio, '#', e javascript:", () => {
    const html = `
      <a href="">empty</a>
      <a href="#">anchor</a>
      <a href="javascript:void(0)">js</a>
      <a href="https://ok.com">ok</a>
    `;
    const issues = checkBrokenLinks(html);
    assert.equal(issues[0].count, 3);
  });

  it("links válidos passam", () => {
    assert.deepEqual(checkBrokenLinks('<a href="https://ok.com">x</a>'), []);
  });
});

describe("checkDuplicateHeadings", () => {
  it("detecta h2 duplicados", () => {
    const html = `<h2>Lançamentos</h2><h2>Pesquisas</h2><h2>Lançamentos</h2>`;
    const issues = checkDuplicateHeadings(html);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].count, 1);
  });

  it("headings únicos passam", () => {
    assert.deepEqual(
      checkDuplicateHeadings("<h2>A</h2><h2>B</h2><h3>C</h3>"),
      [],
    );
  });

  it("case-insensitive", () => {
    const issues = checkDuplicateHeadings("<h2>TITLE</h2><h2>title</h2>");
    assert.equal(issues.length, 1);
  });
});

describe("checkMojibake", () => {
  it("detecta padrões de encoding quebrado", () => {
    const html = "GeraÃ§Ã£o de modelos"; // "Geração" → mojibake
    const issues = checkMojibake(html);
    assert.equal(issues.length, 1);
    assert.ok(issues[0].count! >= 2);
  });

  it("HTML com acentos corretos passa", () => {
    assert.deepEqual(checkMojibake("Geração de modelos"), []);
  });
});

describe("checkWideTables", () => {
  it("detecta table width > 600", () => {
    const html = `<table width="800"><tr><td>x</td></tr></table>`;
    const issues = checkWideTables(html);
    assert.equal(issues.length, 1);
  });

  it("detecta style width > 600", () => {
    const html = `<table style="width: 900px"><tr><td>x</td></tr></table>`;
    const issues = checkWideTables(html);
    assert.equal(issues.length, 1);
  });

  it("table width <= 600 passa", () => {
    assert.deepEqual(
      checkWideTables(`<table width="600"><tr><td>x</td></tr></table>`),
      [],
    );
  });
});

describe("checkImgsWithoutAlt", () => {
  it("detecta <img> sem alt", () => {
    const html = `<img src="x.jpg"/><img src="y.jpg" alt="foo"/>`;
    const issues = checkImgsWithoutAlt(html);
    assert.equal(issues[0].count, 1);
  });

  it("alt vazio conta como sem alt", () => {
    const html = `<img src="x.jpg" alt=""/>`;
    const issues = checkImgsWithoutAlt(html);
    assert.equal(issues[0].count, 1);
  });

  it("todos com alt passam", () => {
    assert.deepEqual(
      checkImgsWithoutAlt(`<img src="x" alt="foo"/><img src="y" alt="bar"/>`),
      [],
    );
  });
});

describe("checkUnsafeTargetBlank", () => {
  it("detecta target=_blank sem rel", () => {
    const html = `<a href="https://x" target="_blank">link</a>`;
    const issues = checkUnsafeTargetBlank(html);
    assert.equal(issues[0].count, 1);
  });

  it("rel=noopener passa", () => {
    const html = `<a href="https://x" target="_blank" rel="noopener">link</a>`;
    assert.deepEqual(checkUnsafeTargetBlank(html), []);
  });

  it("rel=noreferrer passa", () => {
    const html = `<a href="https://x" target="_blank" rel="noreferrer">link</a>`;
    assert.deepEqual(checkUnsafeTargetBlank(html), []);
  });

  it("sem target=_blank passa", () => {
    const html = `<a href="https://x">link</a>`;
    assert.deepEqual(checkUnsafeTargetBlank(html), []);
  });
});

describe("lintHtml — integração", () => {
  it("HTML perfeito: 0 erros, 0 warnings", () => {
    const html = `<h2>Título único</h2><p><a href="https://ok.com" target="_blank" rel="noopener noreferrer">Link</a></p><img src="https://img.com/x" alt="descrição"/>`;
    const result = lintHtml(html);
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.checked_rules.length, 7);
  });

  it("HTML ruim: múltiplos erros e warnings", () => {
    const html = `
      <h2>Duplicado</h2>
      <h2>Duplicado</h2>
      <img src="{{IMG:bad.jpg}}"/>
      <a href="">broken</a>
      <img src="x.jpg"/>
      <a href="https://x" target="_blank">unsafe</a>
      GeraÃ§Ã£o
    `;
    const result = lintHtml(html);
    // Erros: unresolved, broken_links, duplicate_headings, mojibake = 4
    assert.equal(result.errors.length, 4);
    // Warnings: img_no_alt, unsafe_target_blank = 2
    assert.equal(result.warnings.length, 2);
  });

  it("conta cada rule só 1x nos errors/warnings (agregação)", () => {
    const html = `<a href="">x</a><a href="#">y</a>`;
    const result = lintHtml(html);
    // Apesar de 2 broken links, só 1 entry no errors[] (count: 2)
    const brokenIssue = result.errors.find((e) => e.rule === "broken_links");
    assert.equal(brokenIssue?.count, 2);
  });
});
