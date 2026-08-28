import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OFFICIAL_SOURCES,
  lancamentoDomains,
  lancamentoPatterns,
  companyToDomain,
} from "../scripts/lib/official-domains.ts";
import { isOfficialLancamentoUrl } from "../scripts/lib/launch-heuristics.ts";

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

    it("corrige drift #6613 — z.ai (Z.ai/GLM) agora presente", () => {
      assert.ok(domains.has("z.ai"), "z.ai deve estar em lancamentoDomains após #6613");
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

    it("inclui pattern de blog.google/innovation-and-ai/ (#586)", () => {
      const matches = patterns.some(
        (p) => p.test("blog.google/innovation-and-ai/technology/developers-tools/event-driven-webhooks/"),
      );
      assert.ok(matches, "deve ter pattern pra blog.google/innovation-and-ai/");
    });

    it("inclui pattern de blog.google/products/ (regressão)", () => {
      const matches = patterns.some(
        (p) => p.test("blog.google/products/gemini/feature-x/"),
      );
      assert.ok(matches, "blog.google/products/ deve continuar sendo lancamento");
    });

    // #2370: claude.com/blog/ como caminho de anúncio oficial da Anthropic.
    // Restrito a /blog/ — verificado contra dado real: /news e /release-notes
    // redirecionam pra claude.ai; /product/* são marketing estático evergreen.
    it("#2370 — claude.com/blog/ reconhecido como lançamento oficial Anthropic", () => {
      const matches = patterns.some(
        (p) => p.test("claude.com/blog/claude-design-stays-on-brand-for-daily-work"),
      );
      assert.ok(matches, "claude.com/blog/ deve ser lancamento");
    });

    it("#2370 — claude.com/product/* (marketing estático) NÃO é lançamento", () => {
      // claude.com/product/claude-code, /product/design etc. são páginas de
      // marketing evergreen sem data — não anúncios.
      assert.ok(!patterns.some((p) => p.test("claude.com/product/claude-code")), "/product/claude-code NÃO é lancamento");
      assert.ok(!patterns.some((p) => p.test("claude.com/product/design")), "/product/design NÃO é lancamento");
    });

    it("#2370 — claude.com/news e /release-notes (redirecionam pra claude.ai) NÃO são lançamento", () => {
      assert.ok(!patterns.some((p) => p.test("claude.com/news/x")), "claude.com/news NÃO é path de conteúdo");
      assert.ok(!patterns.some((p) => p.test("claude.com/release-notes/x")), "claude.com/release-notes NÃO é path de conteúdo");
    });

    it("#2370 — claude.com/login, /pricing, /signup, /upgrade, /settings NÃO são lançamento", () => {
      for (const path of ["login", "pricing", "signup", "upgrade", "settings"]) {
        assert.ok(
          !patterns.some((p) => p.test(`claude.com/${path}`)),
          `claude.com/${path} NÃO deve ser lancamento`,
        );
      }
    });

    it("#2370 — anthropic.com/news/ continua reconhecido (não regrediu)", () => {
      const matches = patterns.some(
        (p) => p.test("anthropic.com/news/claude-opus-4-5"),
      );
      assert.ok(matches, "anthropic.com/news/ não deve regredir");
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
      assert.equal(find("Z.ai launches GLM-5.3-Flash")?.domain, "z.ai");
      assert.equal(find("Zhipu AI releases GLM-4.6")?.domain, "z.ai");
    });

    it("Z.ai: a serie GLM sugere o dominio oficial a partir do TEXTO (#6613)", () => {
      // Este bloco cobre `companyToDomain()` — sugerir a fonte primaria a
      // partir de uma manchete de cobertura. NAO e o caminho que produziu o
      // bug da 260828; esse esta no `describe` proprio abaixo.
      const find = (text: string) => c2d.find(({ keyword }) => keyword.test(text));
      assert.equal(find("Z.ai lanca novo modelo")?.domain, "z.ai");
      assert.equal(find("GLM-5.3-Flash chega perto do Opus")?.domain, "z.ai");
      assert.equal(find("glm-4.6 disponivel")?.domain, "z.ai");
      // Formatos que o regex antigo (`glm-?[0-9]`) nao pegava.
      assert.equal(find("GLM-45 chega ao mercado")?.domain, "z.ai");
      assert.equal(find("GLM-4o anunciado")?.domain, "z.ai");
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

/**
 * Regressão do gate da edição 260828 (#6613).
 *
 * O bloco `companyToDomain()` acima NÃO cobre este caminho — achado do
 * review da PR #6614 (P2, confiança alta). São dois consumidores distintos
 * do MESMO registro:
 *
 * - `companyToDomain()` lê `detection_keywords` e serve pra SUGERIR a fonte
 *   primária a partir do texto de uma cobertura (`launch-detect.ts`).
 * - `lancamentoDomains()` lê `domains` e alimenta `isOfficialLancamentoUrl`,
 *   que é o gate de verdade: é ele que `validate-lancamentos.ts` consulta
 *   pra decidir se um LANÇAMENTO tem link oficial (#160).
 *
 * Foi o SEGUNDO que falhou na 260828. Um teste só sobre o primeiro passa
 * mesmo que alguém remova `domains: ["z.ai"]` — ou seja, o bug original
 * volta em silêncio com a suíte verde. Por isso este bloco existe à parte,
 * batendo direto na função que o gate chama.
 */
describe("Z.ai no gate de LANÇAMENTOS (#6613)", () => {
  it("z.ai está entre os domínios oficiais de lançamento", () => {
    assert.ok(lancamentoDomains().has("z.ai"));
  });

  it("zhipuai.cn (marca antiga) também — conteúdo histórico não pode regredir", () => {
    assert.ok(lancamentoDomains().has("zhipuai.cn"));
  });

  it("isOfficialLancamentoUrl aceita uma URL real do blog da Z.ai", () => {
    assert.equal(isOfficialLancamentoUrl("https://z.ai/blog/glm-5.3-flash"), true);
    assert.equal(isOfficialLancamentoUrl("https://zhipuai.cn/news/glm"), true);
  });

  it("não vira allowlist ampla demais: cobertura de imprensa segue NÃO-oficial", () => {
    // O ponto do #160 é que só o link OFICIAL vira LANÇAMENTO. Um domínio
    // parecido não pode passar de carona.
    assert.equal(isOfficialLancamentoUrl("https://techcrunch.com/glm-5-3-flash"), false);
    assert.equal(isOfficialLancamentoUrl("https://not-z.ai/blog/glm"), false);
  });
});
