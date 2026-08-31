import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractEmailUrls,
  decodeRedirectWrapper,
  categorizeUrl,
  checkLinkTracking,
  classifyKnownArtifact,
  isPostWebRedirectTarget,
} from "../scripts/lint-test-email-link-tracking.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("extractEmailUrls (#1248)", () => {
  it("extrai hrefs de HTML", () => {
    const html = '<a href="https://a.com">x</a><a href="https://b.com/p">y</a>';
    assert.deepEqual(extractEmailUrls(html).sort(), ["https://a.com", "https://b.com/p"]);
  });

  it("extrai URLs nuas de plain text", () => {
    const text = "Veja https://example.com/foo e https://other.com/bar";
    const r = extractEmailUrls(text);
    assert.equal(r.length, 2);
  });

  it("dedupe URLs duplicadas", () => {
    const html = '<a href="https://a.com">x</a> <a href="https://a.com">y</a>';
    assert.equal(extractEmailUrls(html).length, 1);
  });
});

describe("decodeRedirectWrapper (#1248)", () => {
  it("decoda Gmail Image Proxy", () => {
    const wrapped = "https://www.google.com/url?q=https%3A%2F%2Freal.com%2Fpath&sa=U";
    assert.equal(decodeRedirectWrapper(wrapped), "https://real.com/path");
  });

  it("retorna URL original se não é wrapper conhecido", () => {
    const url = "https://example.com/page";
    assert.equal(decodeRedirectWrapper(url), url);
  });

  it("não decoda Beehiiv tracking (URL opaca)", () => {
    const url = "https://link.diaria.beehiiv.com/abc123";
    assert.equal(decodeRedirectWrapper(url), url);
  });
});

describe("categorizeUrl (#1248)", () => {
  it("non_http: mailto", () => {
    assert.equal(categorizeUrl("mailto:x@y.com"), "non_http");
  });
  it("non_http: tel", () => {
    assert.equal(categorizeUrl("tel:+5511999999"), "non_http");
  });
  it("non_http: javascript", () => {
    assert.equal(categorizeUrl("javascript:void(0)"), "non_http");
  });
  it("non_http: URL inválida", () => {
    assert.equal(categorizeUrl("not-a-url"), "non_http");
  });
  it("auth_required: linkedin.com", () => {
    assert.equal(categorizeUrl("https://www.linkedin.com/in/x"), "auth_required");
    assert.equal(categorizeUrl("https://linkedin.com/company/y"), "auth_required");
  });
  it("auth_required: facebook.com", () => {
    assert.equal(categorizeUrl("https://www.facebook.com/page"), "auth_required");
  });
  it("null: URL pública normal", () => {
    assert.equal(categorizeUrl("https://example.com/article"), null);
  });
});

describe("checkLinkTracking — integração mock (#1248)", () => {
  it("dedupe URLs antes de fetch", async () => {
    const html = '<a href="https://a.com">x</a><a href="https://a.com">y</a>';
    let fetchCount = 0;
    const fetchStub = (): Promise<Response> => {
      fetchCount++;
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    await checkLinkTracking(html, fetchStub as never);
    assert.equal(fetchCount, 1, "URL duplicada fetched 1×");
  });

  it("skip auth_required + non_http", async () => {
    const html = `
      <a href="https://www.linkedin.com/in/x">li</a>
      <a href="mailto:x@y.com">mail</a>
      <a href="https://example.com/article">real</a>
    `;
    let urlsFetched: string[] = [];
    const fetchStub = (url: string | URL): Promise<Response> => {
      urlsFetched.push(String(url));
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(urlsFetched.length, 1);
    assert.equal(urlsFetched[0], "https://example.com/article");
    assert.equal(r.skipped.length, 2);
  });

  it("link_dead quando HEAD retorna 4xx", async () => {
    const html = '<a href="https://dead.example.com">x</a>';
    const fetchStub = (): Promise<Response> =>
      Promise.resolve(new Response(null, { status: 404 }));
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].type, "link_dead");
    assert.equal(r.issues[0].status, 404);
  });

  it("segue redirects até 200", async () => {
    const html = '<a href="https://start.com">x</a>';
    const responses = [
      new Response(null, { status: 301, headers: { Location: "https://end.com" } }),
      new Response(null, { status: 200 }),
    ];
    let i = 0;
    const fetchStub = (): Promise<Response> => Promise.resolve(responses[i++]);
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 0);
    assert.equal(r.passed, 1);
  });

  it("passed conta URLs OK", async () => {
    const html = '<a href="https://a.com">x</a><a href="https://b.com">y</a>';
    const fetchStub = (): Promise<Response> =>
      Promise.resolve(new Response(null, { status: 200 }));
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.passed, 2);
    assert.equal(r.issues.length, 0);
  });
});

describe("#1949 — cortar falso-positivos (merge tags, 403 bot-block, timeout warning)", () => {
  it("categorizeUrl: URL com merge tag {{...}} → merge_tag", () => {
    assert.equal(
      categorizeUrl("https://poll.diaria.workers.dev/vote?email={{email}}&choice=A&sig={{poll_sig}}"),
      "merge_tag",
    );
    assert.equal(categorizeUrl("https://example.com/p?u={{ email }}"), "merge_tag");
    // sem merge tag → segue normal
    assert.equal(categorizeUrl("https://example.com/p?u=real"), null);
  });

  it("vote URL com {{email}}/{{poll_sig}} é SKIPPED (não vira link_dead) — stage default 'draft'", async () => {
    const html = '<a href="https://poll.diaria.workers.dev/vote?email={{email}}&sig={{poll_sig}}">vote</a>';
    // fetchStub jamais deve ser chamado pra merge_tag
    let called = false;
    const fetchStub = (): Promise<Response> => {
      called = true;
      return Promise.resolve(new Response(null, { status: 404 }));
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(called, false, "não faz HEAD em URL com merge tag");
    assert.equal(r.issues.length, 0);
    assert.equal(r.skipped.filter((s) => s.reason === "merge_tag").length, 1);
  });

  it("#4512 (achado silent-failure-hunter): stage='delivered' — {{poll_token}} ainda literal NÃO é skipped, vira link_dead se o HEAD retornar 4xx", async () => {
    // Simula o e-mail JÁ ENTREGUE (fetchado via Gmail MCP) onde a Beehiiv
    // deveria ter substituído {{poll_token}} mas não substituiu (custom
    // field não populado pro assinante de teste). Isso é o próprio defeito
    // que este linter existe pra pegar — não pode ser mascarado como
    // merge_tag esperado.
    const html = '<a href="https://poll.diaria.workers.dev/vote?email={{poll_token}}@vote.eia.diaria.local&edition=260801&choice=A">vote</a>';
    let called = false;
    const fetchStub = (): Promise<Response> => {
      called = true;
      // Mesmo status que o /vote real retornaria via isUnsubstitutedMergeTag
      // (workers/poll/src/vote.ts) pra um parâmetro email com merge tag literal.
      return Promise.resolve(new Response(null, { status: 400 }));
    };
    const r = await checkLinkTracking(html, fetchStub as never, undefined, "delivered");
    assert.equal(called, true, "stage='delivered' deve fazer HEAD real, não skipar por merge_tag");
    assert.equal(r.skipped.filter((s) => s.reason === "merge_tag").length, 0, "não deve aparecer como merge_tag skip neste estágio");
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].type, "link_dead");
    assert.equal(r.issues[0].severity, "blocker");
  });

  it("#4512: stage='delivered' — merge tag já substituída (caminho feliz) não é afetada, HEAD normal com 200 → passed", async () => {
    // Confirma que a mudança não penaliza o caso normal: quando a Beehiiv
    // JÁ substituiu {{poll_token}} por um token real, a URL não tem mais
    // chaves {{ }} — segue pelo pipeline normal de sempre, sem relação com
    // o guard novo.
    const html = '<a href="https://poll.diaria.workers.dev/vote?email=abc123def456abc123def456@vote.eia.diaria.local&edition=260801&choice=A">vote</a>';
    const fetchStub = (): Promise<Response> => Promise.resolve(new Response(null, { status: 200 }));
    const r = await checkLinkTracking(html, fetchStub as never, undefined, "delivered");
    assert.equal(r.passed, 1);
    assert.equal(r.issues.length, 0);
  });

  it("#4512: categorizeUrl(url, 'delivered') retorna null (não 'merge_tag') pra URL com {{...}} literal", () => {
    assert.equal(
      categorizeUrl("https://poll.diaria.workers.dev/vote?email={{poll_token}}@vote.eia.diaria.local", "delivered"),
      null,
    );
    // stage default (sem 2º arg) continua 'draft' — comportamento pré-#4512 preservado.
    assert.equal(
      categorizeUrl("https://poll.diaria.workers.dev/vote?email={{poll_token}}@vote.eia.diaria.local"),
      "merge_tag",
    );
  });

  it("403/401 → bot_blocked skip (não link_dead)", async () => {
    const html = '<a href="https://diaria.beehiiv.com/cursos">cursos</a>';
    const fetchStub = (): Promise<Response> => Promise.resolve(new Response(null, { status: 403 }));
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 0, "403 não é issue");
    const bot = r.skipped.filter((s) => s.reason === "bot_blocked");
    assert.equal(bot.length, 1);
    assert.equal(bot[0].status, 403);
  });

  it("#3941: 429 (rate limit) → skip rate_limited (não link_dead) — caso VentureBeat post-mortem 260723", async () => {
    const html = '<a href="https://venturebeat.com/ai/some-article">artigo</a>';
    const fetchStub = (): Promise<Response> => Promise.resolve(new Response(null, { status: 429 }));
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 0, "429 não é issue — é anti-bot, não link morto");
    const rl = r.skipped.filter((s) => s.reason === "rate_limited");
    assert.equal(rl.length, 1);
    assert.equal(rl[0].status, 429);
  });

  it("404 (real) ainda é link_dead blocker (não confundir com 403)", async () => {
    const html = '<a href="https://dead.example.com">x</a>';
    const fetchStub = (): Promise<Response> => Promise.resolve(new Response(null, { status: 404 }));
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].type, "link_dead");
    assert.equal(r.issues[0].severity, "blocker");
  });

  it("timeout → link_timeout com severity warning (não blocker)", async () => {
    const html = '<a href="https://slow.example.com">x</a>';
    // AbortError simula timeout
    const fetchStub = (): Promise<Response> => {
      const e = new Error("aborted");
      e.name = "AbortError";
      return Promise.reject(e);
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].type, "link_timeout");
    assert.equal(r.issues[0].severity, "warning");
    // nenhum blocker → exit deveria ser 0 (validado via filtro de severity)
    assert.equal(r.issues.filter((i) => i.severity === "blocker").length, 0);
  });
});

describe("#6819 — HEAD→GET fallback (Worker eia.diar.ia.br/jogar só tem handler pra GET)", () => {
  // #6819: o Worker `/jogar` não implementa HEAD — o router retorna 404 pra
  // HEAD mas 200 pra GET. Sem o fallback, o link do rodapé virava falso
  // blocker toda edition. O teste simula exatamente essa resposta
  // assimétrica: HEAD 404, GET 200 → deve vir `passed`, não `link_dead`.
  it("HEAD 404 → GET 200 → passed (não blocker) — falso-positivo corrigido", async () => {
    const html = '<a href="https://eia.diar.ia.br/jogar">jogar</a>';
    const fetchStub = (_url: string | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method || "GET";
      if (method === "HEAD") {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 0, "nenhum issue — GET 200 após HEAD 404 não é blocker");
    assert.equal(r.passed, 1);
    assert.equal(r.skipped.length, 0);
  });

  it("HEAD 404 → GET 404 → link_dead de fato (ambos falham — GET é o que humanos usam)", async () => {
    const html = '<a href="https://dead.example.com">x</a>';
    const fetchStub = (_url: string | URL, init?: RequestInit): Promise<Response> => {
      return Promise.resolve(new Response(null, { status: 404 }));
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].type, "link_dead");
    assert.equal(r.issues[0].severity, "blocker");
    assert.equal(r.issues[0].status, 404);
  });

  it("HEAD 500 → GET 200 → passed (fallback cobre 5xx também, não só 4xx)", async () => {
    const html = '<a href="https://eia.diar.ia.br/jogar">jogar</a>';
    const fetchStub = (_url: string | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method || "GET";
      if (method === "HEAD") {
        return Promise.resolve(new Response(null, { status: 500 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 0, "GET 200 após HEAD 500 também não é blocker");
    assert.equal(r.passed, 1);
  });

  it("HEAD 401 → skip bot_blocked (NÃO cai pra GET — 401 é bot_blocked, não falso-positivo)", async () => {
    const html = '<a href="https://diaria.beehiiv.com/cursos">cursos</a>';
    const fetchStub = (_url: string | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method || "GET";
      if (method === "HEAD") {
        return Promise.resolve(new Response(null, { status: 401 }));
      }
      // GET nunca deve ser chamado pra 401 — o caller skipa antes de chegar aqui
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 0, "401 não é issue");
    const bot = r.skipped.filter((s) => s.reason === "bot_blocked");
    assert.equal(bot.length, 1);
    assert.equal(bot[0].status, 401);
  });

  it("HEAD 429 → skip rate_limited (NÃO cai pra GET — 429 é rate_limited, já skipado)", async () => {
    const html = '<a href="https://venturebeat.com/ai/some-article">artigo</a>';
    const fetchStub = (_url: string | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method || "GET";
      if (method === "HEAD") {
        return Promise.resolve(new Response(null, { status: 429 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 0, "429 não é issue");
    const rl = r.skipped.filter((s) => s.reason === "rate_limited");
    assert.equal(rl.length, 1);
    assert.equal(rl[0].status, 429);
  });

  // ── #6825: regression test — ≥2 hops de redirect com HEAD 3xx não deve
  // forçar GET no meio da cadeia. O bug original: o loop `for (attempt < 2)`
  // usava o mesmo counter pra "seguir redirect" e "cair pra GET", então
  // um redirect HEAD fazia `continue` que avançava `attempt` pra 1 —
  // forçando GET no 2º hop mesmo sendo só continuação legítima. O GET
  // usava `redirect: "follow"` e terminava a cadeia inteira sem incrementar
  // `hops`, então `hops` nunca passava de 1 e o blocker
  // `link_redirect_chain_long` (hops > MAX_REDIRECTS) nunca disparava.
  it("#6825: 3 hops de redirect via HEAD contados corretamente — hops=3, não 1", async () => {
    const html = '<a href="https://hop1.example.com">chain</a>';
    const responses = [
      new Response(null, { status: 301, headers: { Location: "https://hop2.example.com" } }),
      new Response(null, { status: 302, headers: { Location: "https://hop3.example.com" } }),
      new Response(null, { status: 301, headers: { Location: "https://hop4.example.com" } }),
      new Response(null, { status: 200 }),
    ];
    let i = 0;
    const fetchStub = (_url: string | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method || "GET";
      // Confirma que todos os hops rodam via HEAD (não GET no meio)
      assert.equal(method, "HEAD", `hop ${i} deveria ser HEAD, recebeu ${method}`);
      return Promise.resolve(responses[i++]);
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 0, "cadeia de 3 redirects até 200 não é issue");
    assert.equal(r.passed, 1);
  });

  it("#6825: 4 hops de redirect via HEAD → link_redirect_chain_long (MAX_REDIRECTS=3)", async () => {
    const html = '<a href="https://hop1.example.com">chain</a>';
    const responses = [
      new Response(null, { status: 301, headers: { Location: "https://hop2.example.com" } }),
      new Response(null, { status: 302, headers: { Location: "https://hop3.example.com" } }),
      new Response(null, { status: 301, headers: { Location: "https://hop4.example.com" } }),
      new Response(null, { status: 302, headers: { Location: "https://hop5.example.com" } }),
    ];
    let i = 0;
    const fetchStub = (_url: string | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method || "GET";
      assert.equal(method, "HEAD", `hop ${i} deveria ser HEAD, recebeu ${method}`);
      return Promise.resolve(responses[i++]);
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 1, "cadeia de 4 redirects (> MAX_REDIRECTS=3) é blocker");
    assert.equal(r.issues[0].type, "link_redirect_chain_long");
    assert.equal(r.issues[0].severity, "blocker");
    assert.equal(r.issues[0].hops, 4, "hops deve ser 4 (contados via HEAD, não abortado pelo GET)");
  });

  it("#6825: HEAD 4xx no 2º hop → GET fallback no local final, hops=1 preservado", async () => {
    const html = '<a href="https://hop1.example.com">chain</a>';
    const responses = [
      new Response(null, { status: 301, headers: { Location: "https://hop2.example.com" } }),
      new Response(null, { status: 404 }),
    ];
    let i = 0;
    const methods: string[] = [];
    const fetchStub = (_url: string | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method || "GET";
      methods.push(method);
      return Promise.resolve(responses[i++]);
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    // hop1=HEAD(301), hop2=HEAD(404) → break → GET fallback
    assert.equal(methods[0], "HEAD", "1º hop é HEAD");
    assert.equal(methods[1], "HEAD", "2º hop é HEAD");
    assert.equal(methods[2], "GET", "3ª tentativa é GET fallback");
    assert.equal(r.issues.length, 1, "GET 4xx → link_dead");
    assert.equal(r.issues[0].type, "link_dead");
    assert.equal(r.issues[0].status, 404);
    // Achado do review (#6825, confiança alta/85, P3): o título do teste
    // alega "hops=1 preservado" mas nenhuma assertion verificava esse
    // valor — só a sequência de métodos e o status/type final. A fase GET
    // (Phase 2) não incrementa hops (ver comentário em headWithRedirects),
    // então só o hop real via HEAD (301→hop2) conta: hops deve ficar em 1.
    assert.equal(r.issues[0].hops, 1, "hops deve ficar em 1 — a fase GET (fallback) não incrementa hops");
  });

  it("#6825: HEAD 3xx no 2º hop + GET 200 no final → passed, hops=2", async () => {
    const html = '<a href="https://hop1.example.com">chain</a>';
    let callCount = 0;
    const fetchStub = (_url: string | URL, init?: RequestInit): Promise<Response> => {
      callCount++;
      const method = init?.method || "GET";
      if (method === "HEAD") {
        const hop = callCount; // 1=hop1, 2=hop2
        if (hop === 1) {
          return Promise.resolve(new Response(null, { status: 301, headers: { Location: "https://hop2.example.com" } }));
        }
        // hop2: HEAD 404 (simula worker que só responde GET)
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      // GET fallback
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 0, "GET 200 após HEAD 4xx no 2º hop não é blocker");
    assert.equal(r.passed, 1);
    assert.equal(callCount, 3, "2 HEAD + 1 GET");
  });
});

describe("classifyKnownArtifact (#3480/#3481/#3482 — post-mortem 260716)", () => {
  it("#3480: domínio Amazon → amazon_bot_block", () => {
    const r1 = classifyKnownArtifact("https://www.amazon.com.br/dp/B0ABCDEF12");
    assert.equal(r1?.reason, "amazon_bot_block");
    const r2 = classifyKnownArtifact("https://amazon.com/dp/B0ABCDEF12");
    assert.equal(r2?.reason, "amazon_bot_block");
    const r3 = classifyKnownArtifact("https://amzn.to/3xYzAbC");
    assert.equal(r3?.reason, "amazon_bot_block");
  });

  it("#5840: link.amazon (SiteStripe) e amzlinks.in (hop intermediário) → amazon_bot_block", () => {
    const r1 = classifyKnownArtifact("https://link.amazon/B09zuNGrF");
    assert.equal(r1?.reason, "amazon_bot_block");
    const r2 = classifyKnownArtifact("https://amzlinks.in/B09zuNGrF");
    assert.equal(r2?.reason, "amazon_bot_block");
  });

  it("#3482: fonts.gstatic.com / fonts.googleapis.com → font_degradation", () => {
    const r1 = classifyKnownArtifact("https://fonts.gstatic.com/s/inter/v13/abc.woff2");
    assert.equal(r1?.reason, "font_degradation");
    const r2 = classifyKnownArtifact("https://fonts.googleapis.com/css2?family=Inter");
    assert.equal(r2?.reason, "font_degradation");
  });

  it("#3481: link preferences/unsubscribe do footer Beehiiv → beehiiv_footer_artifact (mesmo malformado)", () => {
    const r1 = classifyKnownArtifact("https://diaria.beehiiv.com/unsubscribe?token=");
    assert.equal(r1?.reason, "beehiiv_footer_artifact");
    // URL malformada (não parseável) que ainda contém o padrão — checagem
    // roda no raw string ANTES do new URL(), então não precisa ser válida.
    const r2 = classifyKnownArtifact("beehiiv preferences ??? not-a-real-url");
    assert.equal(r2?.reason, "beehiiv_footer_artifact");
  });

  it("link normal (não artefato conhecido) → null", () => {
    assert.equal(classifyKnownArtifact("https://example.com/article"), null);
    assert.equal(classifyKnownArtifact("https://dead.example.com"), null);
  });
});

describe("checkLinkTracking — allowlist de artefatos de test-send não mascara link real quebrado", () => {
  it("#3480: Amazon 404 vira known-artifact (skipped), não error — sem HEAD", async () => {
    const html = '<a href="https://www.amazon.com.br/dp/B0XYZ">produto</a>';
    let called = false;
    const fetchStub = (): Promise<Response> => {
      called = true;
      return Promise.resolve(new Response(null, { status: 404 }));
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(called, false, "não faz HEAD em domínio Amazon — bot-block conhecido");
    assert.equal(r.issues.length, 0);
    const skip = r.skipped.find((s) => s.reason === "amazon_bot_block");
    assert.ok(skip, "deve aparecer em skipped[] com reason amazon_bot_block");
    assert.ok(skip?.note, "deve ter note explicando o motivo");
  });

  it("#3482: gstatic font 404 vira known-artifact (skipped), não error", async () => {
    const html = '<link href="https://fonts.gstatic.com/s/inter/v13/abc.woff2">';
    let called = false;
    const fetchStub = (): Promise<Response> => {
      called = true;
      return Promise.resolve(new Response(null, { status: 404 }));
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(called, false);
    assert.equal(r.issues.length, 0);
    const skip = r.skipped.find((s) => s.reason === "font_degradation");
    assert.ok(skip);
  });

  it("#3481: preferences link malformado do footer Beehiiv vira known-artifact, não error", async () => {
    const html = '<a href="https://diaria.beehiiv.com/unsubscribe?e=%7B%7Bsubscriber%7D%7D&broken=true">preferências</a>';
    let called = false;
    const fetchStub = (): Promise<Response> => {
      called = true;
      return Promise.resolve(new Response(null, { status: 404 }));
    };
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(called, false);
    assert.equal(r.issues.length, 0);
    const skip = r.skipped.find((s) => s.reason === "beehiiv_footer_artifact");
    assert.ok(skip);
  });

  it("link REALMENTE quebrado (fora da allowlist) continua link_dead — não mascarado", async () => {
    const html = '<a href="https://some-random-news-site.example.com/article-404">artigo</a>';
    const fetchStub = (): Promise<Response> => Promise.resolve(new Response(null, { status: 404 }));
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].type, "link_dead");
    assert.equal(r.issues[0].severity, "blocker");
    assert.equal(r.skipped.length, 0);
  });

  it("mix: Amazon + gstatic + link real quebrado na mesma checagem — só o real vira issue", async () => {
    const html = `
      <a href="https://www.amazon.com.br/dp/B0XYZ">produto</a>
      <link href="https://fonts.gstatic.com/s/inter/v13/abc.woff2">
      <a href="https://real-dead-link.example.com/gone">morto de verdade</a>
    `;
    const fetchStub = (): Promise<Response> => Promise.resolve(new Response(null, { status: 404 }));
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 1, "só o link real quebrado vira issue");
    assert.equal(r.issues[0].url, "https://real-dead-link.example.com/gone");
    assert.equal(r.skipped.filter((s) => s.reason === "amazon_bot_block").length, 1);
    assert.equal(r.skipped.filter((s) => s.reason === "font_degradation").length, 1);
  });
});

// ── #4520: mainCli() --stage via argv (CLI e2e, sem teste até aqui) ────────
//
// checkLinkTracking(html, fetch, concurrency, stage) e categorizeUrl(url,
// stage) já são bem testados diretamente com o argumento explícito acima —
// mas nada até o #4520 invocava o PROCESSO de verdade pra confirmar que
// `--stage draft` no argv de fato chega em `stage: "draft"` dentro de
// mainCli() (`values.stage === "draft" ? "draft" : "delivered"`). Um typo no
// nome da flag ou na ternária passaria batido pela suíte anterior.
//
// Fixture: uma única URL com merge tag literal (`{{ subscriber.email }}`) —
// só em stage="draft" ela é SKIPADA (reason "merge_tag", sem HEAD real); em
// qualquer outro valor (incluindo o default "delivered") ela vai pra fila de
// HEAD. `LINK_TRACKING_TIMEOUT_MS` baixo limita o tempo de qualquer tentativa
// de rede real a um domínio .invalid (RFC 2606, nunca resolve) — determinístico
// e rápido, sem depender de rede de verdade pra passar.
describe("#4520 — mainCli() --stage via argv (CLI e2e)", () => {
  const SCRIPT = join(PROJECT_ROOT, "scripts", "lint-test-email-link-tracking.ts");
  // #4520: merge tag SEM espaço (`{{poll_token}}`, forma real usada pelo
  // diário — ver poll-token.ts) — com espaço (`{{ subscriber.email }}`,
  // sintaxe Brevo), `extractEmailUrls` produziria uma 2ª URL truncada via o
  // regex de "URL nua" (que para no 1º espaço), diferente da capturada pelo
  // regex de href — 2 entradas no Set em vez de 1, poluindo a asserção de
  // total_urls_checked sem relação nenhuma com o que este teste quer provar
  // (threading do argv `--stage`).
  const MERGE_TAG_HTML = '<a href="http://example.invalid/vote?email={{poll_token}}&edition=260801&choice=A">votar</a>';

  function makeEmailFile(html: string): string {
    const dir = mkdtempSync(join(tmpdir(), "lint-link-tracking-cli-"));
    const path = join(dir, "email.html");
    writeFileSync(path, html, "utf8");
    return path;
  }

  function runCli(args: string[], envOverrides: Record<string, string> = {}) {
    return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: { ...process.env, LINK_TRACKING_TIMEOUT_MS: "200", ...envOverrides },
    });
  }

  it("--stage draft: merge tag literal é SKIPADA (reason merge_tag), zero URLs vão pra fila de HEAD", () => {
    const emailFile = makeEmailFile(MERGE_TAG_HTML);
    try {
      const r = runCli(["--email-file", emailFile, "--stage", "draft"]);
      assert.equal(r.status, 0, `esperava exit 0 (sem blockers): ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.total_urls_checked, 0, "merge tag em stage=draft não deve ir pra fila de HEAD");
      assert.ok(
        out.skipped.some((s: { reason: string }) => s.reason === "merge_tag"),
        `esperava skip com reason "merge_tag": ${JSON.stringify(out.skipped)}`,
      );
    } finally {
      rmSync(dirname(emailFile), { recursive: true, force: true });
    }
  });

  it("SEM --stage (default): resolve pra 'delivered' — merge tag NÃO é skipada, vai pra fila de HEAD", () => {
    const emailFile = makeEmailFile(MERGE_TAG_HTML);
    try {
      const r = runCli(["--email-file", emailFile]);
      const out = JSON.parse(r.stdout);
      assert.equal(out.total_urls_checked, 1, "sem --stage, default deve ser 'delivered' — URL vai pra fila de HEAD, não é skipada");
      assert.ok(
        !out.skipped.some((s: { reason: string }) => s.reason === "merge_tag"),
        `default NÃO deveria skipar como merge_tag: ${JSON.stringify(out.skipped)}`,
      );
    } finally {
      rmSync(dirname(emailFile), { recursive: true, force: true });
    }
  });

  it("--stage delivered (explícito): mesmo comportamento do default — confirma a ternária pros 2 valores não-'draft'", () => {
    const emailFile = makeEmailFile(MERGE_TAG_HTML);
    try {
      const r = runCli(["--email-file", emailFile, "--stage", "delivered"]);
      const out = JSON.parse(r.stdout);
      assert.equal(out.total_urls_checked, 1);
      assert.ok(!out.skipped.some((s: { reason: string }) => s.reason === "merge_tag"));
    } finally {
      rmSync(dirname(emailFile), { recursive: true, force: true });
    }
  });

  // #6608: threading do argv `--send-mode` até `sendMode` em checkLinkTracking.
  it("--send-mode generic (delivered implícito): merge tag literal é SKIPADA (reason generic_send_merge_tag), exit 0", () => {
    const emailFile = makeEmailFile(MERGE_TAG_HTML);
    try {
      const r = runCli(["--email-file", emailFile, "--send-mode", "generic"]);
      assert.equal(r.status, 0, `esperava exit 0 (sem blockers): ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.total_urls_checked, 0, "merge tag em send-mode=generic não deve ir pra fila de HEAD");
      assert.ok(
        out.skipped.some((s: { reason: string }) => s.reason === "generic_send_merge_tag"),
        `esperava skip com reason "generic_send_merge_tag": ${JSON.stringify(out.skipped)}`,
      );
    } finally {
      rmSync(dirname(emailFile), { recursive: true, force: true });
    }
  });

  it("SEM --send-mode (default simulate-as): merge tag literal continua indo pra HEAD normal — comportamento pré-#6608 intocado", () => {
    const emailFile = makeEmailFile(MERGE_TAG_HTML);
    try {
      const r = runCli(["--email-file", emailFile]);
      const out = JSON.parse(r.stdout);
      assert.equal(out.total_urls_checked, 1, "default simulate-as não deve skipar merge tag no e-mail entregue");
      assert.ok(!out.skipped.some((s: { reason: string }) => s.reason === "generic_send_merge_tag"));
    } finally {
      rmSync(dirname(emailFile), { recursive: true, force: true });
    }
  });

  it("--send-mode simulate-as (explícito): mesmo comportamento do default", () => {
    const emailFile = makeEmailFile(MERGE_TAG_HTML);
    try {
      const r = runCli(["--email-file", emailFile, "--send-mode", "simulate-as"]);
      const out = JSON.parse(r.stdout);
      assert.equal(out.total_urls_checked, 1);
      assert.ok(!out.skipped.some((s: { reason: string }) => s.reason === "generic_send_merge_tag"));
    } finally {
      rmSync(dirname(emailFile), { recursive: true, force: true });
    }
  });
});

describe("isPostWebRedirectTarget (#4604)", () => {
  it("true: pathname /jogar + from=post-web", () => {
    assert.equal(
      isPostWebRedirectTarget("https://eia.diar.ia.br/jogar?edition=260801&from=post-web"),
      true,
    );
  });

  it("false: pathname /jogar SEM from=post-web (link legítimo do embed, embed.ts::buildEmbedJogarUrl)", () => {
    assert.equal(
      isPostWebRedirectTarget("https://eia.diar.ia.br/jogar?edition=260801&utm_source=embed"),
      false,
    );
  });

  it("false: from=post-web em pathname diferente de /jogar", () => {
    assert.equal(
      isPostWebRedirectTarget("https://eia.diar.ia.br/jogar/arquivo?from=post-web"),
      false,
    );
  });

  it("false: URL sem relação nenhuma", () => {
    assert.equal(isPostWebRedirectTarget("https://example.com/article"), false);
  });

  it("false: URL inválida não lança", () => {
    assert.equal(isPostWebRedirectTarget("not-a-url"), false);
  });
});

describe("#4604 — redirect pro /jogar?from=post-web pós-#4578 não mascara merge tag travada", () => {
  // Reproduz o comportamento REAL de handleVote (workers/poll/src/vote.ts,
  // guard isUnsubstitutedMergeTag) desde o #4578: merge tag ainda literal +
  // edition em formato válido → 302 com Location /jogar?edition=...&from=post-web
  // (em vez do 400 incondicional de antes do #4578, que o teste #4512 acima
  // ainda cobre para o caso de edition malformada).
  const VOTE_URL_WITH_LITERAL_TAG =
    "https://eia.diar.ia.br/vote?email={{poll_token}}@vote.eia.diaria.local&edition=260801&choice=A";

  it("HEAD segue o 302 até /jogar?...&from=post-web (HTTP final 200) → ainda vira link_dead (blocker), não passed", async () => {
    const html = `<a href="${VOTE_URL_WITH_LITERAL_TAG}">votar</a>`;
    const responses = [
      new Response(null, {
        status: 302,
        headers: { Location: "https://eia.diar.ia.br/jogar?edition=260801&from=post-web" },
      }),
      new Response(null, { status: 200 }),
    ];
    let i = 0;
    const fetchStub = (): Promise<Response> => Promise.resolve(responses[i++]);
    const r = await checkLinkTracking(html, fetchStub as never, undefined, "delivered");
    assert.equal(r.passed, 0, "não deve contar como passed — mascararia a merge tag travada");
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].type, "link_dead");
    assert.equal(r.issues[0].severity, "blocker");
    assert.equal(r.issues[0].status, 200, "status final do HEAD é 200 (a página /jogar existe)");
    assert.equal(r.issues[0].final_url, "https://eia.diar.ia.br/jogar?edition=260801&from=post-web");
    assert.match(r.issues[0].details, /from=post-web/);
  });

  it("mesma URL SEM redirecionar (voto normal, merge tag já resolvida) → passed, não vira issue", async () => {
    // Caminho feliz: a Beehiiv já substituiu o poll_token — a URL do /vote
    // real (sem {{...}}) responde 200 direto, sem redirect nenhum.
    const html = '<a href="https://eia.diar.ia.br/vote?email=abc123@vote.eia.diaria.local&edition=260801&choice=A">votar</a>';
    const fetchStub = (): Promise<Response> => Promise.resolve(new Response(null, { status: 200 }));
    const r = await checkLinkTracking(html, fetchStub as never, undefined, "delivered");
    assert.equal(r.passed, 1);
    assert.equal(r.issues.length, 0);
  });

  it("redirect pra /jogar SEM from=post-web (ex: link de embed) não é confundido com merge tag travada", async () => {
    const html = '<a href="https://eia.diar.ia.br/embed-redirect">embed</a>';
    const responses = [
      new Response(null, {
        status: 301,
        headers: { Location: "https://eia.diar.ia.br/jogar?edition=260801&utm_source=embed" },
      }),
      new Response(null, { status: 200 }),
    ];
    let i = 0;
    const fetchStub = (): Promise<Response> => Promise.resolve(responses[i++]);
    const r = await checkLinkTracking(html, fetchStub as never, undefined, "delivered");
    assert.equal(r.issues.length, 0, "sem from=post-web não é o sinal de merge tag travada");
    assert.equal(r.passed, 1);
  });

  it("edition malformada (caminho pré-#4578 preservado): guard ainda retorna 400 direto, sem redirect — continua link_dead pelo ramo genérico de status", async () => {
    // #4578: isValidVoteEditionFormat(edition) falso → o guard cai no 400 de
    // sempre (comportamento intocado desse caso combinado). Sem redirect
    // nenhum — hops=0, então o novo branch de #4604 nem entra em jogo; o
    // ramo genérico >=400 já pré-existente continua responsável por isso.
    const html = '<a href="https://eia.diar.ia.br/vote?email={{poll_token}}@vote.eia.diaria.local&edition=lixo&choice=A">votar</a>';
    const fetchStub = (): Promise<Response> => Promise.resolve(new Response(null, { status: 400 }));
    const r = await checkLinkTracking(html, fetchStub as never, undefined, "delivered");
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].type, "link_dead");
    assert.equal(r.issues[0].status, 400);
  });
});

describe("#6608 — --send-mode generic trata merge tag literal como skip, não blocker", () => {
  const VOTE_URL_WITH_LITERAL_TAG =
    "https://eia.diar.ia.br/vote?email={{poll_token}}@vote.eia.diaria.local&edition=260828&choice=A";

  it("categorizeUrl(url, 'delivered', 'generic') → 'generic_send_merge_tag' pra URL com {{...}} literal", () => {
    assert.equal(
      categorizeUrl(VOTE_URL_WITH_LITERAL_TAG, "delivered", "generic"),
      "generic_send_merge_tag",
    );
  });

  it("categorizeUrl(url, 'delivered', 'simulate-as') (ou default) → null, preserva comportamento pré-#6608", () => {
    assert.equal(categorizeUrl(VOTE_URL_WITH_LITERAL_TAG, "delivered", "simulate-as"), null);
    assert.equal(categorizeUrl(VOTE_URL_WITH_LITERAL_TAG, "delivered"), null);
  });

  it("checkLinkTracking sendMode 'generic': merge tag literal vira skipped, NÃO issue/blocker", async () => {
    const html = `<a href="${VOTE_URL_WITH_LITERAL_TAG}">votar</a>`;
    let fetchCalled = false;
    const fetchStub = (): Promise<Response> => {
      fetchCalled = true;
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const r = await checkLinkTracking(html, fetchStub as never, undefined, "delivered", "generic");
    assert.equal(r.issues.length, 0, "não deve virar issue/blocker em modo generic");
    assert.equal(fetchCalled, false, "URL com merge tag literal é skipada ANTES do HEAD, não faz fetch");
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].reason, "generic_send_merge_tag");
  });

  it("checkLinkTracking sendMode default ('simulate-as'): mesma URL continua link_dead (blocker) — comportamento pré-#6608 intocado", async () => {
    const html = `<a href="${VOTE_URL_WITH_LITERAL_TAG}">votar</a>`;
    const fetchStub = (): Promise<Response> => Promise.resolve(new Response(null, { status: 400 }));
    const r = await checkLinkTracking(html, fetchStub as never, undefined, "delivered");
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].type, "link_dead");
    assert.equal(r.issues[0].severity, "blocker");
  });

  it("sendMode 'generic' + sinal indireto do redirect pra /jogar?...&from=post-web (#4604) → skip, não blocker", async () => {
    const html = `<a href="${VOTE_URL_WITH_LITERAL_TAG}">votar</a>`;
    const responses = [
      new Response(null, {
        status: 302,
        headers: { Location: "https://eia.diar.ia.br/jogar?edition=260828&from=post-web" },
      }),
      new Response(null, { status: 200 }),
    ];
    let i = 0;
    const fetchStub = (): Promise<Response> => Promise.resolve(responses[i++]);
    const r = await checkLinkTracking(html, fetchStub as never, undefined, "delivered", "generic");
    assert.equal(r.issues.length, 0, "não deve virar issue/blocker em modo generic");
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].reason, "generic_send_merge_tag");
  });

  it("sendMode default + o mesmo sinal indireto continua blocker (regressão #4604 preservada)", async () => {
    const html = `<a href="${VOTE_URL_WITH_LITERAL_TAG}">votar</a>`;
    const responses = [
      new Response(null, {
        status: 302,
        headers: { Location: "https://eia.diar.ia.br/jogar?edition=260828&from=post-web" },
      }),
      new Response(null, { status: 200 }),
    ];
    let i = 0;
    const fetchStub = (): Promise<Response> => Promise.resolve(responses[i++]);
    const r = await checkLinkTracking(html, fetchStub as never, undefined, "delivered");
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].type, "link_dead");
    assert.equal(r.issues[0].severity, "blocker");
  });
});
