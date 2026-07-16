import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractEmailUrls,
  decodeRedirectWrapper,
  categorizeUrl,
  checkLinkTracking,
  classifyKnownArtifact,
} from "../scripts/lint-test-email-link-tracking.ts";

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

  it("vote URL com {{email}}/{{poll_sig}} é SKIPPED (não vira link_dead)", async () => {
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

  it("403/401 → bot_blocked skip (não link_dead)", async () => {
    const html = '<a href="https://diaria.beehiiv.com/cursos">cursos</a>';
    const fetchStub = (): Promise<Response> => Promise.resolve(new Response(null, { status: 403 }));
    const r = await checkLinkTracking(html, fetchStub as never);
    assert.equal(r.issues.length, 0, "403 não é issue");
    const bot = r.skipped.filter((s) => s.reason === "bot_blocked");
    assert.equal(bot.length, 1);
    assert.equal(bot[0].status, 403);
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

describe("classifyKnownArtifact (#3480/#3481/#3482 — post-mortem 260716)", () => {
  it("#3480: domínio Amazon → amazon_bot_block", () => {
    const r1 = classifyKnownArtifact("https://www.amazon.com.br/dp/B0ABCDEF12");
    assert.equal(r1?.reason, "amazon_bot_block");
    const r2 = classifyKnownArtifact("https://amazon.com/dp/B0ABCDEF12");
    assert.equal(r2?.reason, "amazon_bot_block");
    const r3 = classifyKnownArtifact("https://amzn.to/3xYzAbC");
    assert.equal(r3?.reason, "amazon_bot_block");
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
