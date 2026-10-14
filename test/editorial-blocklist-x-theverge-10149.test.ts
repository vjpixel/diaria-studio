/**
 * editorial-blocklist-x-theverge-10149.test.ts (#10149, #10155)
 *
 * Regressão: x.com / twitter.com (decisão direta do editor, gate 4 de 261014)
 * e theverge.com (decisão via monitor de cortes por domínio #9787) entram na
 * blacklist editorial e são descartados no Pass 0 do `dedup.ts`.
 *
 * Premissa do carve-out (#10149): submissão do editor por e-mail
 * (`flag: "editor_submitted"`) de um domínio bloqueado segue o tratamento que
 * o Pass 0 já dá a TODO domínio da blacklist — é descartada, mas nunca em
 * silêncio: sai em `editorSubmittedLost` e aparece no aviso do gate da
 * Etapa 1 (#4192), onde o editor pode reincluí-la à mão.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isEditoriallyBlocked, EDITORIAL_BLOCKLIST } from "../scripts/lib/editorial-blocklist.ts";
import { dedup } from "../scripts/dedup.ts";

describe("blacklist editorial: x.com / twitter.com (#10149)", () => {
  it("a lista contém x.com e twitter.com", () => {
    assert.ok(EDITORIAL_BLOCKLIST.has("x.com"));
    assert.ok(EDITORIAL_BLOCKLIST.has("twitter.com"));
  });

  it("bloqueia host exato, www e subdomínios", () => {
    assert.equal(isEditoriallyBlocked("https://x.com/finkd/status/1234567890"), true);
    assert.equal(isEditoriallyBlocked("https://www.x.com/finkd/status/1"), true);
    assert.equal(isEditoriallyBlocked("https://blog.x.com/en_us/topics/product"), true);
    assert.equal(isEditoriallyBlocked("https://twitter.com/finkd/status/1"), true);
    assert.equal(isEditoriallyBlocked("https://mobile.twitter.com/finkd/status/1"), true);
  });

  it("NÃO bloqueia domínios que só contêm a string (x.ai, *.x.com.br, notx.com)", () => {
    assert.equal(isEditoriallyBlocked("https://x.ai/news/grok-5"), false);
    assert.equal(isEditoriallyBlocked("https://notx.com/a"), false);
    assert.equal(isEditoriallyBlocked("https://x.com.evil.example/a"), false);
    assert.equal(isEditoriallyBlocked("https://nottwitter.com/a"), false);
  });
});

describe("blacklist editorial: theverge.com (#10155)", () => {
  it("a lista contém theverge.com e bloqueia URL real do feed", () => {
    assert.ok(EDITORIAL_BLOCKLIST.has("theverge.com"));
    assert.equal(
      isEditoriallyBlocked("https://www.theverge.com/ai-artificial-intelligence/123/openai-x"),
      true,
    );
  });
});

describe("dedup Pass 0 descarta x.com / twitter.com / theverge.com (#10149, #10155)", () => {
  const articles = () => [
    { url: "https://x.com/finkd/status/1234567890", title: "Mark Zuckerberg (@finkd) on X" },
    { url: "https://twitter.com/sama/status/42", title: "Sam Altman on Twitter" },
    { url: "https://blog.x.com/en_us/topics/product/2026/grok", title: "Grok no X" },
    { url: "https://www.theverge.com/ai/1/openai-device", title: "OpenAI mostra dispositivo" },
    { url: "https://x.ai/news/grok-5", title: "Grok 5 é lançado pela xAI" },
  ];

  it("remove os bloqueados com a nota da blacklist editorial e mantém x.ai", () => {
    const { kept, removed } = dedup(articles(), new Set(), 0.85);
    assert.deepEqual(kept.map((a) => a.url), ["https://x.ai/news/grok-5"]);
    const editorialRemoved = removed.filter((r) => r.dedup_note === "fonte em blacklist editorial (#1760)");
    assert.equal(editorialRemoved.length, 4);
  });

  it("submissão do editor de x.com é descartada mas aparece em editorSubmittedLost (#4192)", () => {
    const { kept, editorSubmittedLost } = dedup(
      [
        { url: "https://x.com/finkd/status/1234567890", title: "Mark Zuckerberg (@finkd) on X", flag: "editor_submitted" },
        { url: "https://openai.com/index/gpt-6", title: "GPT-6 chega ao ChatGPT" },
      ],
      new Set(),
      0.85,
    );
    assert.deepEqual(kept.map((a) => a.url), ["https://openai.com/index/gpt-6"]);
    assert.equal(editorSubmittedLost.length, 1);
    assert.equal(editorSubmittedLost[0].url, "https://x.com/finkd/status/1234567890");
    assert.equal(editorSubmittedLost[0].dedup_note, "fonte em blacklist editorial (#1760)");
  });
});
