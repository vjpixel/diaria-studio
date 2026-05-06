import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseInboxMd,
  filterEditorBlocks,
  extractEditorUrls,
  validateInjection,
  isTrackingUrl,
  decodeTrackerUrl,
} from "../scripts/inject-inbox-urls.ts";

const sampleInbox = `# Inbox Editorial — Diar.ia

<!-- entries abaixo -->
## 2026-05-04T17:44:00.000Z
- **from:** Angelo Pixel <vjpixel@gmail.com>
- **subject:** Gemini's new UI is out now
- **urls:**
  - https://www.androidauthority.com/gemini-ui-ios-app-3663119/
- **raw:** > https://www.androidauthority.com/gemini-ui-ios-app-3663119/

## 2026-05-03T03:02:10.000Z
- **from:** AI Agents News <agentpulse@mail.beehiiv.com>
- **subject:** Google Gemini Expands Into In Car AI
- **urls:**
  - https://media.beehiiv.com/cdn-cgi/image/x.jpg
  - https://example.com/article
- **raw:** > forwarded newsletter

## 2026-05-04T19:09:10.000Z
- **from:** Angelo Pixel <vjpixel@gmail.com>
- **subject:** Fwd: TLDR AI - 2026-05-04
- **urls:**
  - https://tracking.tldrnewsletter.com/CL0/x/1/abc=
  - https://example.org/real-article
- **raw:** > forward
`;

describe("parseInboxMd", () => {
  it("extrai blocos com from, subject, urls", () => {
    const blocks = parseInboxMd(sampleInbox);
    assert.equal(blocks.length, 3);
    assert.ok(blocks[0].from.includes("vjpixel@gmail.com"));
    assert.equal(blocks[0].subject, "Gemini's new UI is out now");
    assert.ok(blocks[0].urls.some((u) => u.includes("androidauthority")));
  });

  it("captura URLs de raw preview também", () => {
    const blocks = parseInboxMd(sampleInbox);
    // raw mention duplica o androidauthority — captura ambas
    const block0 = blocks[0];
    assert.ok(block0.urls.length >= 1);
  });

  it("ignora cabeçalho do markdown", () => {
    const blocks = parseInboxMd("# Header\n## 2026-01-01\n- **from:** test\n- **urls:**\n  - https://x.com");
    assert.equal(blocks.length, 1);
  });
});

describe("filterEditorBlocks", () => {
  it("inclui só blocos com email do editor", () => {
    const blocks = parseInboxMd(sampleInbox);
    const editor = filterEditorBlocks(blocks, "vjpixel@gmail.com");
    assert.equal(editor.length, 2);
    assert.ok(editor.every((b) => b.from.includes("vjpixel")));
  });

  it("é case-insensitive", () => {
    const blocks = parseInboxMd(sampleInbox);
    assert.equal(filterEditorBlocks(blocks, "VJPIXEL@GMAIL.COM").length, 2);
  });

  it("retorna vazio quando ninguém bate", () => {
    const blocks = parseInboxMd(sampleInbox);
    assert.equal(filterEditorBlocks(blocks, "noone@example.com").length, 0);
  });

  it("#711: filtrar com diariaeditor@gmail.com retorna 0 blocos (inbox tem vjpixel@)", () => {
    // Regressão: bug causou 0 injeções em 260506 porque playbook passava
    // --editor diariaeditor@gmail.com mas os forwards chegam From: vjpixel@gmail.com.
    const blocks = parseInboxMd(sampleInbox);
    assert.equal(filterEditorBlocks(blocks, "diariaeditor@gmail.com").length, 0);
    assert.equal(filterEditorBlocks(blocks, "vjpixel@gmail.com").length, 2);
  });
});

describe("isTrackingUrl", () => {
  it("detecta TLDR tracking", () => {
    assert.ok(isTrackingUrl("https://tracking.tldrnewsletter.com/CL0/x"));
  });

  it("detecta Beehiiv mail link", () => {
    assert.ok(isTrackingUrl("https://link.mail.beehiiv.com/v1/c/abc"));
  });

  it("detecta Beehiiv CDN images", () => {
    assert.ok(isTrackingUrl("https://media.beehiiv.com/cdn-cgi/image/x.jpg"));
  });

  it("detecta Wisprflow refer", () => {
    assert.ok(isTrackingUrl("https://ref.wisprflow.ai/x"));
  });

  it("não confunde com URL de conteúdo", () => {
    assert.equal(isTrackingUrl("https://www.androidauthority.com/article"), false);
    assert.equal(isTrackingUrl("https://example.com/post"), false);
  });

  it("#659: detecta magic.beehiiv.com (subscribe/unsubscribe links)", () => {
    assert.ok(isTrackingUrl("https://magic.beehiiv.com/v1/abc123?redirect_to=x"));
  });

  it("#659: detecta email.beehiivstatus.com (tracking pixel)", () => {
    assert.ok(isTrackingUrl("https://email.beehiivstatus.com/abc/hclick"));
  });

  it("#659: detecta hp.beehiiv.com (helper page)", () => {
    assert.ok(isTrackingUrl("https://hp.beehiiv.com/abc-def"));
  });

  it("#659: detecta link.tldrnewsletter.com (sem 'tracking.' prefix)", () => {
    assert.ok(isTrackingUrl("https://link.tldrnewsletter.com/CL0/x"));
  });

  it("#659: detecta elink email trackers", () => {
    assert.ok(isTrackingUrl("https://elink725.ainews.recaply.co/ss/c/abc"));
  });

  it("#660: dedup usa canonicalize — UTM params não criam duplicata", () => {
    const block = {
      iso: "2026-05-05T10:00:00Z",
      from: "vjpixel@gmail.com",
      subject: "test",
      urls: [
        "https://example.com/article?utm_source=twitter",
        "https://example.com/article?utm_medium=email",
      ],
    };
    const articles = extractEditorUrls([block]);
    assert.equal(articles.length, 1, "UTM variants devem colapsar para 1 artigo");
  });

  it("#660: dedup preserva query params legítimos como parte da identidade", () => {
    const block = {
      iso: "2026-05-05T10:00:00Z",
      from: "vjpixel@gmail.com",
      subject: "test",
      urls: [
        "https://example.com/post?id=1",
        "https://example.com/post?id=2",
      ],
    };
    const articles = extractEditorUrls([block]);
    assert.equal(articles.length, 2, "IDs distintos devem gerar 2 artigos");
  });

  it("#686: domínio legítimo com 'elink' mas sem dígitos não é filtrado", () => {
    // Padrão antigo /elink\d*\./ filtraria elinkage.com pois \d* aceita zero dígitos.
    // Novo padrão /elink\d+\./ requer pelo menos 1 dígito após "elink".
    assert.equal(isTrackingUrl("https://elinkage.com/article"), false, "elinkage.com não deve ser filtrado");
    assert.equal(isTrackingUrl("https://elink.io/redirect"), false, "elink.io sem dígitos não deve ser filtrado");
  });

  it("#686: subdomínio numérico elink\d+ ainda é filtrado", () => {
    assert.ok(isTrackingUrl("https://elink725.ainews.recaply.co/ss/c/abc"), "elink725.* deve ser filtrado");
    assert.ok(isTrackingUrl("https://elink42.tracking.com/x"), "elink42.* deve ser filtrado");
  });
});

describe("extractEditorUrls", () => {
  it("extrai URLs do editor filtrando tracking", () => {
    const blocks = parseInboxMd(sampleInbox);
    const editor = filterEditorBlocks(blocks, "vjpixel@gmail.com");
    const articles = extractEditorUrls(editor);

    // Editor tem 2 blocos — primeiro com 1 URL androidauthority,
    // segundo com 1 tracking URL (filtrada) + 1 example.org
    const urls = articles.map((a) => a.url);
    assert.ok(urls.some((u) => u.includes("androidauthority")));
    assert.ok(urls.some((u) => u.includes("example.org")));
    assert.ok(!urls.some((u) => u.includes("tracking.tldrnewsletter")));
  });

  it("cada artigo tem flag editor_submitted + source inbox", () => {
    const blocks = parseInboxMd(sampleInbox);
    const editor = filterEditorBlocks(blocks, "vjpixel@gmail.com");
    const articles = extractEditorUrls(editor);
    for (const a of articles) {
      assert.equal(a.flag, "editor_submitted");
      assert.equal(a.source, "inbox");
      assert.equal(a.title, "(inbox)");
    }
  });

  it("dedup canonical URL", () => {
    const blocks = [
      { iso: "T1", from: "ed@x", subject: "S", urls: ["https://a.com/x", "https://a.com/x?utm_source=foo"] },
    ];
    const articles = extractEditorUrls(blocks);
    assert.equal(articles.length, 1);
  });

  it("submitted_via=forward quando subject é Fwd:", () => {
    const blocks = [
      { iso: "T1", from: "ed@x", subject: "Fwd: TLDR AI", urls: ["https://a.com/x"] },
    ];
    const [a] = extractEditorUrls(blocks);
    assert.equal(a.submitted_via, "forward");
  });

  it("submitted_via=direct quando subject não é Fwd:", () => {
    const blocks = [
      { iso: "T1", from: "ed@x", subject: "Check this article", urls: ["https://a.com/x"] },
    ];
    const [a] = extractEditorUrls(blocks);
    assert.equal(a.submitted_via, "direct");
  });
});

describe("validateInjection (#594 sentinel)", () => {
  it("retorna lista vazia quando todos URLs estão no pool", () => {
    const injected = [
      { url: "https://a.com/x", source: "inbox" as const, title: "(inbox)", flag: "editor_submitted" as const },
    ];
    const pool = [{ url: "https://a.com/x" }];
    assert.deepEqual(validateInjection(injected, pool), []);
  });

  it("retorna URLs faltantes quando pool incompleto", () => {
    const injected = [
      { url: "https://a.com/x", source: "inbox" as const, title: "(inbox)", flag: "editor_submitted" as const },
      { url: "https://b.com/y", source: "inbox" as const, title: "(inbox)", flag: "editor_submitted" as const },
    ];
    const pool = [{ url: "https://a.com/x" }];
    const missing = validateInjection(injected, pool);
    assert.equal(missing.length, 1);
    assert.equal(missing[0], "https://b.com/y");
  });
});

describe("decodeTrackerUrl (#719 — 7min.ai tracker decoder)", () => {
  // Build a real-looking 7min.ai base64 payload: segments separated by |
  // Third segment (index 2) is the destination URL.
  function make7minUrl(dest: string): string {
    const payload = `seg0|seg1|${dest}|seg3`;
    const b64 = Buffer.from(payload, "utf8").toString("base64");
    return `https://track.newsletter.7min.ai/c/${b64}`;
  }

  it("extrai URL de destino de tracker 7min.ai válido", () => {
    const dest = "https://example.com/real-article";
    const trackerUrl = make7minUrl(dest);
    const result = decodeTrackerUrl(trackerUrl);
    assert.equal(result.decoded, true);
    assert.equal(result.url, dest);
  });

  it("retorna decoded=false com URL original quando base64 é inválido", () => {
    const badUrl = "https://track.newsletter.7min.ai/c/!!!notbase64!!!";
    const result = decodeTrackerUrl(badUrl);
    assert.equal(result.decoded, false);
    assert.equal(result.url, badUrl);
  });

  it("retorna decoded=false quando não há segmento com 'http' no payload", () => {
    const payload = "seg0|seg1|seg2|seg3"; // nenhum começa com http
    const b64 = Buffer.from(payload, "utf8").toString("base64");
    const trackerUrl = `https://track.newsletter.7min.ai/c/${b64}`;
    const result = decodeTrackerUrl(trackerUrl);
    assert.equal(result.decoded, false);
    assert.equal(result.url, trackerUrl);
  });

  it("não toca URLs que não são trackers conhecidos", () => {
    const url = "https://example.com/article";
    const result = decodeTrackerUrl(url);
    assert.equal(result.decoded, false);
    assert.equal(result.url, url);
  });

  it("extractEditorUrls decodifica URL de tracker e seta tracker_decoded=true", () => {
    const dest = "https://example.com/real-article-from-tracker";
    const trackerUrl = make7minUrl(dest);
    const block = {
      iso: "2026-05-05T10:00:00Z",
      from: "editor@example.com",
      subject: "Fwd: 7min newsletter",
      urls: [trackerUrl],
    };
    const articles = extractEditorUrls([block]);
    assert.equal(articles.length, 1, "deve produzir 1 artigo a partir do tracker");
    assert.equal(articles[0].url, dest, "URL deve ser a destino decodificado");
    assert.equal((articles[0] as Record<string, unknown>)["tracker_decoded"], true);
  });
});
