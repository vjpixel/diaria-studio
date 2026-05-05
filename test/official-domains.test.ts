import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OFFICIAL_SOURCES,
  lancamentoDomains,
  lancamentoPatterns,
  companyToDomain,
} from "../scripts/lib/official-domains.ts";

describe("official-domains registry (#566)", () => {
  it("cada entry tem company não-vazia", () => {
    for (const s of OFFICIAL_SOURCES) {
      assert.ok(s.company.trim().length > 0, `Entry vazia: ${JSON.stringify(s)}`);
    }
  });

  it("domínios não têm protocolo nem barra final", () => {
    for (const s of OFFICIAL_SOURCES) {
      for (const d of s.domains ?? []) {
        assert.ok(!d.startsWith("http"), `${s.company}: domain tem protocolo: ${d}`);
        assert.ok(!d.endsWith("/"), `${s.company}: domain tem barra final: ${d}`);
        assert.ok(d.includes("."), `${s.company}: domain sem ponto: ${d}`);
      }
    }
  });

  it("pelo menos 30 empresas registradas", () => {
    assert.ok(OFFICIAL_SOURCES.length >= 30, `apenas ${OFFICIAL_SOURCES.length} entries`);
  });

  describe("lancamentoDomains()", () => {
    const domains = lancamentoDomains();

    it("retorna Set com pelo menos 35 hostnames", () => {
      assert.ok(domains.size >= 35);
    });

    it("inclui domínios históricos — openai.com NÃO (path-restricted por design)", () => {
      assert.ok(!domains.has("openai.com"), "openai.com deve usar LANCAMENTO_PATTERNS");
      assert.ok(!domains.has("anthropic.com"), "anthropic.com deve usar LANCAMENTO_PATTERNS");
    });

    it("inclui domínios any-path conhecidos", () => {
      assert.ok(domains.has("x.ai"));
      assert.ok(domains.has("mistral.ai"));
      assert.ok(domains.has("replicate.com"));
      assert.ok(domains.has("groq.com"));
    });

    it("corrige drift #566 — deepseek.com agora presente", () => {
      assert.ok(domains.has("deepseek.com"), "deepseek.com deve estar em lancamentoDomains após #566");
    });
  });

  describe("lancamentoPatterns()", () => {
    const patterns = lancamentoPatterns();

    it("retorna array não-vazio", () => {
      assert.ok(patterns.length >= 5);
    });

    it("inclui pattern de OpenAI /blog/ (#354)", () => {
      const someMatchesOpenAI = patterns.some(
        (p) => p.test("openai.com/blog/gpt-5"),
      );
      assert.ok(someMatchesOpenAI, "deve ter pattern pra openai.com/blog/");
    });

    it("inclui pattern de Anthropic /news/", () => {
      const someMatchesAnthropic = patterns.some(
        (p) => p.test("anthropic.com/news/claude-4"),
      );
      assert.ok(someMatchesAnthropic);
    });

    it("inclui GitHub Pages (generic)", () => {
      const someMatchesGH = patterns.some(
        (p) => p.test("myproject.github.io/"),
      );
      assert.ok(someMatchesGH);
    });

    it("bloqueia openai.com/our-principles (#354)", () => {
      const matches = patterns.some(
        (p) => p.test("openai.com/our-principles"),
      );
      assert.ok(!matches, "openai.com/our-principles NÃO deve ser lancamento");
    });
  });

  describe("companyToDomain()", () => {
    const c2d = companyToDomain();

    it("retorna array com pelo menos 30 entries", () => {
      assert.ok(c2d.length >= 30);
    });

    it("todas entries têm keyword e domain não-vazios", () => {
      for (const { keyword, domain } of c2d) {
        assert.ok(keyword instanceof RegExp, `keyword deve ser RegExp: ${keyword}`);
        assert.ok(domain.length > 0, `domain vazio para keyword: ${keyword}`);
        assert.ok(!domain.startsWith("http"), `domain tem protocolo: ${domain}`);
      }
    });

    it("keywords conhecidos casam domínios esperados", () => {
      const map = new Map(c2d.map(({ keyword, domain }) => [keyword.source, domain]));
      const find = (text: string) => c2d.find(({ keyword }) => keyword.test(text));

      assert.equal(find("Anthropic launches Claude")?.domain, "anthropic.com");
      assert.equal(find("OpenAI releases GPT-5")?.domain, "openai.com");
      assert.equal(find("deepseek v4 is out")?.domain, "deepseek.com");
      assert.equal(find("Meta releases Llama 4")?.domain, "ai.meta.com");
      assert.equal(find("Mistral unveils Codestral")?.domain, "mistral.ai");
    });

    it("sem duplicatas por keyword.source", () => {
      const seen = new Set<string>();
      for (const { keyword } of c2d) {
        assert.ok(!seen.has(keyword.source), `keyword duplicado: ${keyword.source}`);
        seen.add(keyword.source);
      }
    });
  });
});
