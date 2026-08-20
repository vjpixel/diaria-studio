/**
 * test/validate-domain-diversity.test.ts (#5735)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateDomainDiversity,
  DEFAULT_MAX_PER_DOMAIN,
} from "../scripts/validate-domain-diversity.ts";

describe("validateDomainDiversity", () => {
  it("2 URLs do mesmo domínio → ok", () => {
    const md = `
Destaque 1: https://theverge.com/a
Destaque 2: https://theverge.com/b
`;
    const report = validateDomainDiversity(md);
    assert.equal(report.ok, true);
    assert.equal(report.violations.length, 0);
  });

  it("3+ URLs do mesmo domínio, espalhadas em seções diferentes → exit ≠0 (violação reportada)", () => {
    const md = `
## Destaques
D1: https://theverge.com/a

## RADAR
- https://theverge.com/b
- https://theverge.com/c
`;
    const report = validateDomainDiversity(md);
    assert.equal(report.ok, false);
    assert.equal(report.violations.length, 1);
    assert.equal(report.violations[0].domain, "theverge.com");
    assert.equal(report.violations[0].urls.length, 3);
  });

  it("blog.x.com + x.com + www.x.com contam como 3 do mesmo domínio, falha", () => {
    const md = `
https://blog.x.com/a
https://x.com/b
https://www.x.com/c
`;
    const report = validateDomainDiversity(md);
    assert.equal(report.ok, false);
    assert.equal(report.violations.length, 1);
    assert.equal(report.violations[0].domain, "x.com");
  });

  it("domínio .com.br não é agrupado errado pelo corte de sufixo (tecnoblog.net vs canaltech.com.br permanecem separados)", () => {
    const md = `
https://tecnoblog.net/a
https://tecnoblog.net/b
https://tecnoblog.net/c
https://canaltech.com.br/x
https://canaltech.com.br/y
`;
    const report = validateDomainDiversity(md);
    assert.equal(report.ok, false);
    // Só tecnoblog.net viola (3 URLs); canaltech.com.br tem 2, dentro do limite.
    assert.equal(report.violations.length, 1);
    assert.equal(report.violations[0].domain, "tecnoblog.net");
  });

  it("--max customizado (3) permite 3 do mesmo domínio", () => {
    const md = `
https://theverge.com/a
https://theverge.com/b
https://theverge.com/c
`;
    const report = validateDomainDiversity(md, 3);
    assert.equal(report.ok, true);
  });

  it("default é 2", () => {
    assert.equal(DEFAULT_MAX_PER_DOMAIN, 2);
  });

  it("URLs duplicadas (markdown [texto](url) repete a URL) não dobram a contagem", () => {
    const md = `[Leia mais](https://theverge.com/a) e [de novo](https://theverge.com/a)`;
    const report = validateDomainDiversity(md);
    assert.equal(report.ok, true);
  });

  it("domínios diferentes cada um com 1-2 URLs → ok", () => {
    const md = `
https://openai.com/a
https://anthropic.com/b
https://theverge.com/c
https://theverge.com/d
`;
    const report = validateDomainDiversity(md);
    assert.equal(report.ok, true);
  });
});
