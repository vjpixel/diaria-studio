/**
 * test/inject-inbox-merge-destaque-request-12213.test.ts (#12213)
 *
 * `mergeInjectedIntoPool` descartava o `editor_destaque_request` quando a URL
 * pedida pelo editor ("esse deve ser o d1") já estava no pool — o pesquisador
 * achou o mesmo link, ou carry-over. `tmp-articles-raw.json` ficava sem o
 * pedido e o aviso `editor-destaque-request` do gate 4 nunca disparava, justo
 * no cenário da 261105 que a #12193 queria cobrir.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractEditorUrls,
  mergeInjectedIntoPool,
  parseInboxMd,
} from "../scripts/inject-inbox-urls.ts";
import { DESTAQUE_REQUEST_FIELD } from "../scripts/lib/destaque-upgrade.ts";
import { checkEditorDestaqueRequests } from "../scripts/lib/invariant-checks/stage-4.ts";

const RSI =
  "https://techcrunch.com/2026/11/02/anthropic-warns-that-its-very-close-to-rsi-capability-aka-self-building-ai";

const INBOX = [
  "# Inbox",
  "",
  "## 2026-11-03T23:25:26.000Z",
  "- **from:** Angelo Pixel <vjpixel@gmail.com>",
  "- **subject:** esse deve ser o d1 da edição 261105",
  "- **urls:**",
  `  - ${RSI}`,
  "",
].join("\n");

describe("#12213 mergeInjectedIntoPool preserva o pedido de destaque", () => {
  it("URL já no pool recebe o editor_destaque_request do injetado", () => {
    const injected = extractEditorUrls(parseInboxMd(INBOX));
    const req = injected.find((a) => a.url === RSI);
    assert.equal(req?.[DESTAQUE_REQUEST_FIELD], "d1", "pré-condição: o injetado carrega o pedido");

    const pool: Array<{ url: string; [k: string]: unknown }> = [
      { url: RSI, title: "Anthropic warns...", source: "techcrunch" },
    ];
    const { merged, newInjected } = mergeInjectedIntoPool(pool, injected);
    assert.equal(newInjected.length, 0, "URL já no pool não duplica");
    assert.equal(merged.length, 1);
    assert.equal(merged[0][DESTAQUE_REQUEST_FIELD], "d1");
    assert.equal(merged[0].title, "Anthropic warns...", "resto do item do pool intacto");
    assert.equal(
      pool[0][DESTAQUE_REQUEST_FIELD],
      undefined,
      "não muta o pool de entrada",
    );
  });

  it("pedido já presente no item do pool não é sobrescrito", () => {
    const injected = extractEditorUrls(parseInboxMd(INBOX));
    const pool = [{ url: RSI, [DESTAQUE_REQUEST_FIELD]: "d2" }];
    const { merged } = mergeInjectedIntoPool(pool, injected);
    assert.equal(merged[0][DESTAQUE_REQUEST_FIELD], "d2");
  });

  it("injetado sem pedido não cria o campo no item do pool", () => {
    const pool = [{ url: RSI }];
    const { merged } = mergeInjectedIntoPool(pool, [
      { url: RSI, source: "inbox", title: "(inbox)", flag: "editor_submitted" } as never,
    ]);
    assert.equal(DESTAQUE_REQUEST_FIELD in merged[0], false);
  });

  describe("cenário real: o aviso do gate 4 dispara", () => {
    let dir: string;
    before(() => {
      dir = mkdtempSync(join(tmpdir(), "merge-req-12213-"));
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const injected = extractEditorUrls(parseInboxMd(INBOX));
      const { merged } = mergeInjectedIntoPool([{ url: RSI, title: "Anthropic warns..." }], injected);
      writeFileSync(join(dir, "_internal", "tmp-articles-raw.json"), JSON.stringify(merged));
      writeFileSync(
        join(dir, "_internal", "01-approved.json"),
        JSON.stringify({
          highlights: [{ rank: 1, url: "https://x.com/outro-d1" }],
          radar: [{ url: RSI }],
          lancamento: [],
          use_melhor: [],
          video: [],
        }),
      );
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("editor-destaque-request avisa que o link pedido como D1 ficou no RADAR", () => {
      const v = checkEditorDestaqueRequests(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "editor-destaque-request");
      assert.match(v[0].message, /D1/);
      assert.match(v[0].message, /radar/);
    });
  });
});
