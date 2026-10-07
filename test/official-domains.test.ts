import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OFFICIAL_SOURCES,
  lancamentoDomains,
  lancamentoPatterns,
  companyToDomain,
} from "../scripts/lib/official-domains.ts";
import { categorizeWithRule, isOfficialLancamentoUrl } from "../scripts/lib/launch-heuristics.ts";
import { extractScoringFeatures } from "../scripts/lib/scoring-features.ts";

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

    it("corrige drift #8576 — prismml.com agora presente", () => {
      assert.ok(
        domains.has("prismml.com"),
        "prismml.com deve estar em lancamentoDomains após #8576 (Bonsai 2 27B)",
      );
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

    it("inclui pattern de blog.google/products-and-platforms/ (achado ao vivo, edição 260908)", () => {
      const matches = patterns.some(
        (p) => p.test("blog.google/products-and-platforms/products/translate/google-translate-ios-android-upgrades/"),
      );
      assert.ok(matches, "blog.google/products-and-platforms/ deve ser lancamento (re-org do blog oficial do Google)");
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

    // Decisão do editor 07/10/2026 (edição 261008): claude.com/resources/articles/
    // é link oficial da Anthropic; o resto de /resources/ e /product/* seguem fora.
    it("claude.com/resources/articles/ reconhecido como lançamento oficial Anthropic", () => {
      const url = "https://claude.com/resources/articles/claude-now-works-in-google-docs-sheets-and-slides";
      assert.equal(isOfficialLancamentoUrl(url), true);
      assert.ok(patterns.some((p) => p.test("claude.com/resources/articles/claude-now-works-in-google-docs-sheets-and-slides")));
    });

    it("claude.com/resources/ sem articles/, /resourcesevil/ e /product/ seguem fora", () => {
      for (const url of [
        "https://claude.com/product/x",
        "https://claude.com/resources/",
        "https://claude.com/resources/guides/x",
        "https://claude.com/resourcesevil/articles/x",
        "https://claude.com/resources/articlesevil/x",
      ]) {
        assert.equal(isOfficialLancamentoUrl(url), false, `${url} NÃO deve ser lancamento`);
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

/**
 * Regressão do gate da edição 260921 (#8576).
 *
 * Mesma arquitetura do bloco Z.ai (#6613): o `lancamentoDomains()` acima
 * cobre a estrutura, mas o bug real é no GATE — `validate-lancamentos.ts`
 * chama `isOfficialLancamentoUrl` pra decidir se um LANÇAMENTOS tem link
 * oficial (#160). Um teste só sobre `lancamentoDomains().has("prismml.com")`
 * passa mesmo que alguém remova `domains: ["prismml.com"]`, então bate-se
 * direto na função que o gate consulta.
 */
describe("PrismML no gate de LANÇAMENTOS (#8576)", () => {
  it("prismml.com está entre os domínios oficiais de lançamento", () => {
    assert.ok(lancamentoDomains().has("prismml.com"));
  });

  it("isOfficialLancamentoUrl aceita o anúncio real do Bonsai 2 27B", () => {
    assert.equal(
      isOfficialLancamentoUrl("https://prismml.com/news/bonsai-2-27b"),
      true,
    );
  });

  it("não vira allowlist ampla demais: cobertura de imprensa de terceiro segue NÃO-oficial", () => {
    // O ponto do #160 é que só o link OFICIAL vira LANÇAMENTO. Um domínio
    // parecido não pode passar de carona.
    assert.equal(
      isOfficialLancamentoUrl("https://techcrunch.com/bonsai-2-27b"),
      false,
    );
    assert.equal(isOfficialLancamentoUrl("https://not-prismml.com/news/bonsai"), false);
  });
});

describe("Qwen no GitHub é lançamento oficial (260922)", () => {
  it("repo da org QwenLM conta; outras orgs e github.com raiz não", () => {
    assert.equal(isOfficialLancamentoUrl("https://github.com/QwenLM/Qwen-Image-2.1"), true);
    assert.equal(isOfficialLancamentoUrl("https://github.com/someone/qwen-fork"), false);
    assert.equal(isOfficialLancamentoUrl("https://github.com/"), false);
    // fronteiras (review #8674)
    assert.equal(isOfficialLancamentoUrl("https://github.com/qwenlm/qwen"), true, "case-insensitive");
    assert.equal(isOfficialLancamentoUrl("https://github.com/QwenLM/Qwen-Image-2.1/"), true, "barra final");
    assert.equal(isOfficialLancamentoUrl("https://github.com/QwenLM-fork/x"), false);
    assert.equal(isOfficialLancamentoUrl("https://github.com/QwenLM"), false, "perfil da org");
    assert.equal(isOfficialLancamentoUrl("https://github.com/QwenLM/Qwen/issues/123"), false);
    assert.equal(isOfficialLancamentoUrl("https://github.com/QwenLM/Qwen/pull/9"), false);
    assert.equal(isOfficialLancamentoUrl("https://github.com/QwenLM/Qwen/blob/main/README.md"), false);
  });
});

describe("GitHub oficial de xAI, DeepSeek e Qwen: repo e release (#9424)", () => {
  it("raiz do repo e página de UMA release da org oficial contam", () => {
    for (const url of [
      "https://github.com/QwenLM/qwen-code/releases/tag/v0.25.0",
      "https://github.com/deepseek-ai/DeepSeek-V3",
      "https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0",
      "https://github.com/xai-org/grok-build",
      "https://github.com/xai-org/xai-sdk-python/releases/tag/v1.20.0/",
    ]) {
      assert.equal(isOfficialLancamentoUrl(url), true, url);
    }
  });
  it("lista de releases, issues, blobs, perfil da org e org parecida não contam", () => {
    for (const url of [
      "https://github.com/xai-org/xai-sdk-python/releases",
      "https://github.com/xai-org/xai-sdk-python/releases/tag/v1.20.0/extra",
      "https://github.com/deepseek-ai/DeepSeek-V3/issues/1",
      "https://github.com/deepseek-ai/DeepSeek-V3/blob/main/README.md",
      "https://github.com/deepseek-ai",
      "https://github.com/deepseek-ai-fan/DeepSeek-V3",
      "https://github.com/xai-orgx/grok",
    ]) {
      assert.equal(isOfficialLancamentoUrl(url), false, url);
    }
  });
  it("release de tag com sufixo (nightly, rc, alpha, preview) não é link oficial no Stage 1", () => {
    for (const tag of ["v0.24.7-nightly.20261004.9915c7ff8f", "v0.25.1-preview.0", "dsh-v0.2.0-rc.2", "dsh-v0.2.1-alpha.1"]) {
      assert.equal(isOfficialLancamentoUrl(`https://github.com/QwenLM/qwen-code/releases/tag/${tag}`), false, tag);
    }
    for (const tag of ["v0.24.7", "dsh-v0.2.0", "sdk-typescript-v0.1.18", "1.2"]) {
      assert.equal(isOfficialLancamentoUrl(`https://github.com/QwenLM/qwen-code/releases/tag/${tag}`), true, tag);
    }
  });
});

describe("Efeito no Stage 1 dos padrões GitHub de DeepSeek/xAI (#9424, intencional, igual ao QwenLM)", () => {
  it("categorize: repo da org oficial vira lançamento; blob do mesmo repo não", () => {
    assert.equal(categorizeWithRule({ url: "https://github.com/deepseek-ai/DeepSeek-V4", title: "DeepSeek-V4" } as never).category, "lancamento");
    assert.equal(categorizeWithRule({ url: "https://github.com/xai-org/grok-build", title: "grok-build: coding agent harness" } as never).category, "lancamento");
    assert.notEqual(categorizeWithRule({ url: "https://github.com/deepseek-ai/DeepSeek-V4/blob/main/README.md", title: "DeepSeek-V4" } as never).category, "lancamento");
  });
  it("scoring: has_official_link passa a true para repo de deepseek-ai/xai-org, false para org alheia", async () => {
    const rows = await extractScoringFeatures(
      {
        highlights: [],
        runners_up: [],
        lancamento: [
          { url: "https://github.com/deepseek-ai/DeepSeek-V4", title: "DeepSeek-V4" },
          { url: "https://github.com/xai-org/xai-sdk-python/releases/tag/v1.20.0", title: "v1.20.0" },
        ],
        radar: [{ url: "https://github.com/someone/deepseek-fork", title: "fork" }],
        use_melhor: [],
        video: [],
      },
      null,
    );
    const by = Object.fromEntries(rows.map((r) => [r.url, r.has_official_link]));
    assert.equal(by["https://github.com/deepseek-ai/DeepSeek-V4"], true);
    assert.equal(by["https://github.com/xai-org/xai-sdk-python/releases/tag/v1.20.0"], true);
    assert.equal(by["https://github.com/someone/deepseek-fork"], false);
  });
});

describe("Cloudflare no gate de LANÇAMENTOS (#9390)", () => {
  it("isOfficialLancamentoUrl aceita o anúncio real do Pay Per Use", () => {
    assert.ok(lancamentoDomains().has("blog.cloudflare.com"));
    assert.equal(isOfficialLancamentoUrl("https://blog.cloudflare.com/pay-per-use/"), true);
  });

  it("só o blog: cloudflare.com raiz e domínio parecido seguem NÃO-oficiais", () => {
    assert.equal(isOfficialLancamentoUrl("https://www.cloudflare.com/plans/"), false);
    assert.equal(isOfficialLancamentoUrl("https://blog.cloudflare.com.evil.io/x"), false);
    assert.equal(isOfficialLancamentoUrl("https://techcrunch.com/cloudflare-pay-per-use"), false);
  });

  it("não registra keyword de detecção (Cloudflare é ruído de incidente/infra)", () => {
    assert.ok(!companyToDomain().some((c) => c.domain === "blog.cloudflare.com"));
  });
});

describe("OpenAI developers/community no gate de LANÇAMENTOS (#9788)", () => {
  it("developers.openai.com (docs oficiais) é oficial", () => {
    assert.equal(isOfficialLancamentoUrl("https://developers.openai.com/api/docs/guides/decisions"), true);
  });

  it("community.openai.com: só a categoria Announcements", () => {
    assert.equal(isOfficialLancamentoUrl("https://community.openai.com/c/announcements/6"), true);
    assert.equal(isOfficialLancamentoUrl("https://community.openai.com/c/announcements"), true);
  });

  it("community.openai.com fora de Announcements segue NÃO-oficial", () => {
    assert.equal(isOfficialLancamentoUrl("https://community.openai.com/"), false);
    assert.equal(isOfficialLancamentoUrl("https://community.openai.com/c/api/42"), false);
    assert.equal(isOfficialLancamentoUrl("https://community.openai.com/c/announcements-fake/9"), false);
    assert.equal(isOfficialLancamentoUrl("https://community.openai.com/t/some-topic/123"), false);
  });

  it("não vaza pra host parecido", () => {
    assert.equal(isOfficialLancamentoUrl("https://developers.openai.com.evil.io/x"), false);
    assert.equal(isOfficialLancamentoUrl("https://community.openai.com.evil.io/c/announcements/6"), false);
  });

  it("não registra domínio inteiro", () => {
    const d = lancamentoDomains();
    assert.ok(!d.has("developers.openai.com") && !d.has("community.openai.com"));
  });
});
