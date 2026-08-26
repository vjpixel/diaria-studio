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
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    assert.deepEqual(
      result.hits[0].matches.map((m) => m.ruleId),
      ["acervo-publico"],
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

describe("cada regra casa com arquivo REAL do repo (#6277, achado do review)", () => {
  /**
   * O bug que este bloco existe para impedir: a regra `paginas-publicas`
   * nasceu apontando para `scripts/lib/{curadoria-page,entity-page}.ts`,
   * enquanto os arquivos reais moram em `scripts/lib/shared/`. A regra nunca
   * casava com nada — uma das 7 estava MORTA, e o guard reproduzia dentro de
   * si exatamente o modo de falha silenciosa que ele existe para prevenir.
   *
   * A causa foi testar o MECANISMO (`matchesGlob` contra strings escritas à
   * mão) e nunca os DADOS (`SENSITIVE_RULES` contra o que existe em disco).
   * Este teste fecha a classe inteira, não só a regra que quebrou: qualquer
   * typo de path, e qualquer migração de arquivo que deixe uma regra órfã
   * (o repo tem histórico disso — `context/snippets/` → `data/snippets/`,
   * #5227), passa a quebrar o CI em vez de degradar o guard em silêncio.
   */
  const trackedFiles = execFileSync("git", ["ls-files"], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);

  it("o repo tem arquivos rastreados (sanity — senão o teste abaixo passaria vazio)", () => {
    assert.ok(trackedFiles.length > 100, `git ls-files devolveu ${trackedFiles.length} arquivo(s)`);
  });

  for (const rule of SENSITIVE_RULES) {
    it(`regra "${rule.id}" (${rule.pattern}) casa com ao menos 1 arquivo existente`, () => {
      const matched = trackedFiles.filter((f) => matchesGlob(f, rule.pattern));
      assert.ok(
        matched.length > 0,
        `regra "${rule.id}" não casa com NENHUM arquivo do repo — pattern "${rule.pattern}" está morto ` +
          "(arquivo movido/renomeado, ou typo). Regra morta = guard silenciosamente furado.",
      );
    });
  }

  it("regressão direta do achado: as páginas públicas de curadoria são sensíveis", () => {
    assert.equal(isSensitivePath("scripts/lib/shared/curadoria-page.ts"), true);
    assert.equal(isSensitivePath("scripts/lib/shared/entity-page.ts"), true);
  });
});

describe("matchesGlob falha ALTO em pattern malformado (#6277, achado do review)", () => {
  it("`{` sem `}` lança em vez de degradar para literal", () => {
    // Degradar silenciosamente faria uma regra inválida virar "existe mas
    // nunca casa" — a falha silenciosa que este módulo existe pra evitar.
    assert.throws(() => matchesGlob("qualquer/path.ts", "scripts/{a,b.ts"), /pattern malformado/);
  });
});

describe("formatVerdict imprime TODAS as razões de um hit multi-regra (#6277)", () => {
  it("path que casa com 2 regras mostra as 2 razões, não só a primeira", () => {
    const hit = {
      path: "scripts/exemplo.ts",
      matches: [
        { ruleId: "regra-a", reason: "PRIMEIRA razão distinta e suficientemente longa" },
        { ruleId: "regra-b", reason: "SEGUNDA razão distinta e suficientemente longa" },
      ],
    };
    const msg = formatVerdict({ sensitive: true, hits: [hit], clean: [] });
    assert.match(msg, /PRIMEIRA razão/);
    assert.match(msg, /SEGUNDA razão/, "a 2ª razão sumia no formato de arrays paralelos");
    assert.match(msg, /regra-a, regra-b/);
  });
});

describe("CLI (#6277, achado do review — main() não tinha teste nenhum)", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const script = resolve(repoRoot, "scripts/lib/sensitive-path-guard.ts");

  function runCli(args: string[]) {
    return spawnSync("npx", ["tsx", script, ...args], { cwd: repoRoot, encoding: "utf8" });
  }

  it("--files com caminho sensível → exit 0 e veredito SENSÍVEL no stdout", () => {
    const r = runCli(["--files", "scripts/lib/site-archive-pages.ts"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /SENSÍVEL/);
  });

  it("--files limpo → exit 0 e libera fluxo normal", () => {
    const r = runCli(["--files", "CLAUDE.md"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /nenhum caminho sensível/);
  });

  it("--json emite o envelope estruturado com `sensitive`", () => {
    const r = runCli(["--files", "scripts/publish-facebook.ts", "--json"]);
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.sensitive, true);
    assert.equal(parsed.hits[0].matches[0].ruleId, "publicadores");
  });

  it("FAIL-CLOSED: --base inválido → exit 1 e NENHUM veredito no stdout", () => {
    // O modo de falha proibido seria imprimir "nenhum caminho sensível" sobre
    // um diff que o guard nunca conseguiu ler.
    const r = runCli(["--base", "ref/que/nao/existe/jamais"]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /nenhum caminho sensível/);
    assert.match(r.stderr, /erro/);
  });

  it("FAIL-CLOSED: --files vazio é recusado, nunca lido como 'zero arquivos'", () => {
    const r = runCli(["--files", ""]);
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stdout, /nenhum caminho sensível/);
    assert.match(r.stderr, /vazio/);
  });

  it("--files e --base juntos são recusados (precedência silenciosa)", () => {
    const r = runCli(["--files", "CLAUDE.md", "--base", "origin/master"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mutuamente exclusivos/);
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
