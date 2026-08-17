/**
 * test/utm-link-check-5514.test.ts (#5514)
 *
 * Regression test — antes desta issue não existia mecanismo nenhum que
 * detectasse um link `diar.ia.br` sem `utm_source`/`utm_campaign` numa copy
 * de campanha antes de publicar. Trava `checkUtmCoverage`/`isBrandHost`/
 * `hasFullUtmCoverage` (`scripts/lib/shared/utm-link-check.ts`) e o wrapper
 * de CLI (`scripts/check-utm-coverage.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { checkUtmCoverage, hasFullUtmCoverage, isBrandHost } from "../scripts/lib/shared/utm-link-check.ts";

describe("isBrandHost", () => {
  it("reconhece o domínio raiz e subdomínios", () => {
    assert.equal(isBrandHost("diar.ia.br"), true);
    assert.equal(isBrandHost("arquivo.diar.ia.br"), true);
    assert.equal(isBrandHost("livros.diar.ia.br"), true);
    assert.equal(isBrandHost("DIAR.IA.BR"), true); // case-insensitive
  });

  it("rejeita hosts externos, inclusive parecidos", () => {
    assert.equal(isBrandHost("example.com"), false);
    assert.equal(isBrandHost("notdiar.ia.br"), false); // não é subdomínio real (falta o ponto)
    assert.equal(isBrandHost("diar.ia.br.evil.com"), false);
  });
});

describe("checkUtmCoverage", () => {
  it("achado da #5514: link diar.ia.br cru (sem query nenhuma) é sinalizado", () => {
    const issues = checkUtmCoverage("Confira: https://diar.ia.br/");
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].missing.sort(), ["utm_campaign", "utm_source"]);
  });

  it("link com utm_source e utm_campaign preenchidos não é sinalizado", () => {
    const issues = checkUtmCoverage(
      "Confira: https://diar.ia.br/?utm_source=instagram&utm_medium=bio&utm_campaign=lancamento",
    );
    assert.equal(issues.length, 0);
  });

  it("falta só um dos dois parâmetros — reporta só o que falta", () => {
    const issues = checkUtmCoverage("https://diar.ia.br/?utm_source=whatsapp");
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].missing, ["utm_campaign"]);
  });

  it("valor vazio conta como ausente, não só o parâmetro faltando", () => {
    const issues = checkUtmCoverage("https://diar.ia.br/?utm_source=&utm_campaign=x");
    assert.deepEqual(issues[0].missing, ["utm_source"]);
  });

  it("subdomínio de marca também é coberto", () => {
    const issues = checkUtmCoverage("https://arquivo.diar.ia.br/temas/openai");
    assert.equal(issues.length, 1);
  });

  it("link de host externo (artigo original citado) nunca entra no resultado", () => {
    const issues = checkUtmCoverage(
      "Fonte: https://example.com/artigo e nosso resumo em https://diar.ia.br/?utm_source=x&utm_campaign=y",
    );
    assert.equal(issues.length, 0);
  });

  it("texto sem nenhuma URL retorna lista vazia", () => {
    assert.deepEqual(checkUtmCoverage("nenhum link aqui"), []);
  });

  it("múltiplos links de marca sem UTM — todos reportados, na ordem de aparição", () => {
    const issues = checkUtmCoverage("https://diar.ia.br/a e depois https://livros.diar.ia.br/b");
    assert.equal(issues.length, 2);
    assert.match(issues[0].url, /\/a$/);
    assert.match(issues[1].url, /\/b$/);
  });
});

describe("hasFullUtmCoverage", () => {
  it("true quando não há link de marca no texto", () => {
    assert.equal(hasFullUtmCoverage("texto sem link nenhum"), true);
  });

  it("false quando há pelo menos um link de marca incompleto", () => {
    assert.equal(hasFullUtmCoverage("https://diar.ia.br/"), false);
  });

  it("true quando todos os links de marca estão completos", () => {
    assert.equal(
      hasFullUtmCoverage("https://diar.ia.br/?utm_source=x&utm_campaign=y"),
      true,
    );
  });
});

describe("CLI check-utm-coverage.ts", () => {
  it("--text com link incompleto sai com exit 0 em modo advisory (default)", () => {
    // Não lança → exit 0, mesmo com achado (advisory por padrão, só --strict falha).
    execFileSync("npx", ["tsx", "scripts/check-utm-coverage.ts", "--text", "https://diar.ia.br/"], {
      encoding: "utf-8",
      stdio: "pipe",
    });
  });

  it("--text com link incompleto sai com exit 1 em --strict", () => {
    assert.throws(() => {
      execFileSync(
        "npx",
        ["tsx", "scripts/check-utm-coverage.ts", "--text", "https://diar.ia.br/", "--strict"],
        { encoding: "utf-8", stdio: "pipe" },
      );
    });
  });

  it("--text com link completo sai 0 mesmo em --strict", () => {
    execFileSync(
      "npx",
      [
        "tsx",
        "scripts/check-utm-coverage.ts",
        "--text",
        "https://diar.ia.br/?utm_source=x&utm_campaign=y",
        "--strict",
      ],
      { encoding: "utf-8", stdio: "pipe" },
    );
    // não lança → exit 0
  });

  it("sem --text nem --file sai com exit 2", () => {
    assert.throws(() => {
      execFileSync("npx", ["tsx", "scripts/check-utm-coverage.ts"], { encoding: "utf-8", stdio: "pipe" });
    });
  });
});
