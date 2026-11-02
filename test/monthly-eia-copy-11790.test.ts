import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { stripPrevResultLine } from "../scripts/lib/mensal/monthly-eia-copy.ts";
import { parseEiaLegend } from "../scripts/lib/mensal/monthly-render.ts";

describe("stripPrevResultLine (#11790)", () => {
  const md = "---\neia_answer: {A: real}\n---\n\n**É IA?**\n\nFoto de fulano.\n\nResultado da última edição: 68% das pessoas acertaram.\n";
  it("remove a linha de resultado da diária e preserva o resto", () => {
    const out = stripPrevResultLine(md);
    assert.doesNotMatch(out, /Resultado da última edição/);
    assert.match(out, /Foto de fulano\./);
    assert.match(out, /eia_answer/);
  });
  it("a legenda parseada não carrega mais o resultado", () => {
    assert.equal(parseEiaLegend(stripPrevResultLine(md)), "Foto de fulano.");
  });
  it("sem a linha, é idempotente", () => {
    const clean = stripPrevResultLine(md);
    assert.equal(stripPrevResultLine(clean), clean);
  });
});

describe("stripPrevResultLine: CRLF (#11790)", () => {
  it("sem a linha, devolve o texto byte a byte", () => {
    const crlf = "a\r\nb\r\n";
    assert.equal(stripPrevResultLine(crlf), crlf);
  });
  it("com a linha, remove só ela", () => {
    assert.equal(stripPrevResultLine("a\r\nResultado da última edição: 1%\r\nb\r\n"), "a\r\nb\r\n");
  });
});

describe("SKILL.md diaria-mensal Etapa 3 (#11790)", () => {
  const skill = readFileSync(".claude/skills/diaria-mensal/SKILL.md", "utf8");
  it("usa o layout nested {AAMM}/{AAMMDD}", () => {
    assert.match(skill, /DAILY_EIA_DIR="data\/editions\/\$\{EAI_EDITION:0:4\}\/\$EAI_EDITION"/);
    assert.doesNotMatch(skill, /DAILY_EIA_DIR="data\/editions\/\$EAI_EDITION"/);
  });
  it("chama monthly-eia-copy.ts e não faz cp cru do 01-eia.md", () => {
    assert.match(skill, /monthly-eia-copy\.ts/);
    assert.doesNotMatch(skill, /cp\s+"\$DAILY_EIA_DIR\/01-eia\.md"/);
  });
});
