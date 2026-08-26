/**
 * test/sensitive-path-guard.test.ts (#6277 item 1)
 *
 * Teste de regressão do guard de caminho sensível — a classe de mudança que o
 * review de diff isolado do `hermes-diaria-continuo` demonstrou não conseguir
 * revisar. O caso canônico é `scripts/lib/site-archive-pages.ts` (PR #6214,
 * que quebrou o acervo público inteiro e exigiu o hotfix #6255).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SENSITIVE_RULES,
  classifyChangedPaths,
  formatVerdict,
  isSensitivePath,
  matchesGlob,
  matchingRules,
} from "../scripts/lib/sensitive-path-guard.ts";

describe("matchesGlob — subconjunto de glob suportado", () => {
  it("`*` não cruza `/`", () => {
    assert.equal(matchesGlob("scripts/publish-facebook.ts", "scripts/publish-*.ts"), true);
    assert.equal(matchesGlob("scripts/sub/publish-x.ts", "scripts/publish-*.ts"), false);
  });

  it("`**` cruza `/`", () => {
    assert.equal(matchesGlob("a/b/c/d.ts", "a/**/d.ts"), true);
  });

  it("`{a,b}` casa alternativas literais", () => {
    assert.equal(matchesGlob("scripts/lib/curadoria-page.ts", "scripts/lib/{curadoria-page,entity-page}.ts"), true);
    assert.equal(matchesGlob("scripts/lib/entity-page.ts", "scripts/lib/{curadoria-page,entity-page}.ts"), true);
    assert.equal(matchesGlob("scripts/lib/outra-page.ts", "scripts/lib/{curadoria-page,entity-page}.ts"), false);
  });

  it("caracteres especiais de regex no pattern são literais, nunca interpretados", () => {
    // O `.` do `.ts` não pode casar com qualquer caractere.
    assert.equal(matchesGlob("scripts/publish-fbXts", "scripts/publish-*.ts"), false);
  });

  it("ancora nas duas pontas — não casa por substring", () => {
    assert.equal(matchesGlob("prefixo/scripts/publish-x.ts", "scripts/publish-*.ts"), false);
    assert.equal(matchesGlob("scripts/publish-x.ts.bak", "scripts/publish-*.ts"), false);
  });
});

describe("regressão do #6214/#6255 — o caminho que quebrou o acervo é sensível", () => {
  it("scripts/lib/site-archive-pages.ts é classificado como sensível", () => {
    assert.equal(isSensitivePath("scripts/lib/site-archive-pages.ts"), true);
    const rules = matchingRules("scripts/lib/site-archive-pages.ts");
    assert.deepEqual(
      rules.map((r) => r.id),
      ["acervo-publico"],
    );
  });

  it("o diff REAL do PR #6214 é barrado (skills + teste são limpos, o render não)", () => {
    const result = classifyChangedPaths([
      ".claude/skills/diaria-continuo/SKILL.md",
      ".claude/skills/diaria-develop/SKILL.md",
      ".claude/skills/diaria-overnight/SKILL.md",
      "scripts/lib/site-archive-pages.ts",
      "test/continuo-route-issue-invariant.test.ts",
    ]);
    assert.equal(result.sensitive, true, "o PR que quebrou o acervo deve ser barrado pelo guard");
    assert.deepEqual(
      result.hits.map((h) => h.path),
      ["scripts/lib/site-archive-pages.ts"],
    );
    assert.equal(result.clean.length, 4, "os outros 4 arquivos do mesmo PR não são sensíveis");
  });

  it("todo publicador de scripts/publish-*.ts é sensível", () => {
    for (const p of [
      "scripts/publish-facebook.ts",
      "scripts/publish-instagram.ts",
      "scripts/publish-linkedin.ts",
      "scripts/publish-daily-brevo.ts",
      "scripts/publish-newsletter-kit.ts",
    ]) {
      assert.equal(isSensitivePath(p), true, `${p} deveria ser sensível`);
    }
  });
});

describe("classifyChangedPaths", () => {
  it("diff sem caminho sensível → sensitive:false", () => {
    const result = classifyChangedPaths(["scripts/lib/session-registry.ts", "test/x.test.ts", "CLAUDE.md"]);
    assert.equal(result.sensitive, false);
    assert.deepEqual(result.hits, []);
    assert.equal(result.clean.length, 3);
  });

  it("ignora linhas vazias/whitespace (saída típica de `git diff --name-only`)", () => {
    const result = classifyChangedPaths(["", "  ", "CLAUDE.md", ""]);
    assert.equal(result.sensitive, false);
    assert.deepEqual(result.clean, ["CLAUDE.md"]);
  });

  it("normaliza separador do Windows e prefixo ./", () => {
    assert.equal(isSensitivePath("scripts\\publish-facebook.ts"), true);
    assert.equal(isSensitivePath("./scripts/publish-facebook.ts"), true);
  });

  it("conjunto vazio → sensitive:false, nunca lança", () => {
    const result = classifyChangedPaths([]);
    assert.equal(result.sensitive, false);
    assert.deepEqual(result.clean, []);
  });
});

describe("formatVerdict", () => {
  it("caso sensível diz o que fazer, não só que foi barrado", () => {
    const msg = formatVerdict(classifyChangedPaths(["scripts/lib/site-archive-pages.ts"]));
    assert.match(msg, /SENSÍVEL/);
    assert.match(msg, /review consolidado/, "precisa dizer para onde encaminhar");
    assert.match(msg, /#6255/, "precisa carregar a razão concreta da regra");
  });

  it("caso limpo libera o fluxo normal explicitamente", () => {
    const msg = formatVerdict(classifyChangedPaths(["CLAUDE.md"]));
    assert.match(msg, /nenhum caminho sensível/);
  });
});

describe("higiene das regras", () => {
  it("ids são únicos e não-vazios", () => {
    const ids = SENSITIVE_RULES.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length, "ids duplicados tornam o output ambíguo");
    for (const rule of SENSITIVE_RULES) {
      assert.ok(rule.id.length > 0);
      assert.ok(rule.pattern.length > 0);
      assert.ok(rule.reason.length > 20, `regra "${rule.id}" precisa de uma razão real, não um rótulo`);
    }
  });

  it("a lista fica CURTA de propósito — guard que barra tudo vira guard ignorado", () => {
    assert.ok(
      SENSITIVE_RULES.length <= 12,
      "passou de 12 regras: revisar se o guard ainda é um filtro estreito ou virou gargalo da cadência horária do contínuo",
    );
  });

  it("nenhuma regra casa com um arquivo de teste ou com CLAUDE.md", () => {
    for (const p of ["test/qualquer.test.ts", "CLAUDE.md", ".claude/skills/diaria-continuo/SKILL.md"]) {
      assert.equal(isSensitivePath(p), false, `${p} não deveria ser barrado`);
    }
  });
});
