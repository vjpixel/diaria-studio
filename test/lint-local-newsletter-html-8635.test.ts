/**
 * #8635 — review inconclusivo (Gmail MCP indisponível) deixa pelo menos os
 * lints determinísticos rodando contra o HTML final local.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintLocalNewsletterHtml, resolveLocalHtmlPath } from "../scripts/lint-local-newsletter-html.ts";

const MD = [
  "**📡 RADAR**",
  "",
  "**[Item um](https://a.com/1)**",
  "",
  "---",
  "",
  "**🛠️ USE MELHOR**",
  "",
  "**[Tutorial](https://b.com/1)**",
  "",
].join("\n");

describe("lintLocalNewsletterHtml (#8635)", () => {
  it("HTML sem a seção USE MELHOR → section_missing", () => {
    const html = "<html><body><h2>📡 RADAR</h2><a href='https://a.com/1'>Item um</a></body></html>";
    const r = lintLocalNewsletterHtml(MD, html);
    assert.ok(r.structure_issues.some((i) => i.type === "section_missing" && i.section === "USE MELHOR"));
  });

  it("HTML completo → sem issue de estrutura", () => {
    const html =
      "<html><body><h2>📡 RADAR</h2><a href='https://a.com/1'>Item um</a>" +
      "<h2>🛠️ USE MELHOR</h2><a href='https://b.com/1'>Tutorial</a></body></html>";
    assert.deepEqual(lintLocalNewsletterHtml(MD, html).structure_issues, []);
  });
});

describe("resolveLocalHtmlPath (#8635)", () => {
  it("kit prefere newsletter-final-kit.html e cai no genérico", () => {
    const d = mkdtempSync(join(tmpdir(), "diaria-8635-"));
    try {
      mkdirSync(join(d, "_internal"));
      assert.equal(resolveLocalHtmlPath(d, "kit"), null);
      writeFileSync(join(d, "_internal", "newsletter-final.html"), "x");
      assert.match(resolveLocalHtmlPath(d, "kit")!, /newsletter-final\.html$/);
      writeFileSync(join(d, "_internal", "newsletter-final-kit.html"), "x");
      assert.match(resolveLocalHtmlPath(d, "kit")!, /newsletter-final-kit\.html$/);
      assert.match(resolveLocalHtmlPath(d, "beehiiv")!, /newsletter-final\.html$/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
