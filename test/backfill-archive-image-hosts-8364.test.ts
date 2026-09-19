/**
 * test/backfill-archive-image-hosts-8364.test.ts (#8364)
 *
 * `backfill-archive-image-hosts-8364.ts` corrige as páginas do acervo JÁ
 * COMMITTED (`workers/site/public/p/{slug}/index.html`) sem precisar do
 * cache `data/beehiiv-cache/` (mesmo racional de `backfill-archive-dek-7921
 * .test.ts`). Cobre: (a) o miolo puro, sem tocar disco; (b) idempotência
 * num diretório temporário real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { backfillImageHosts, backfillImageHostsDir } from "../scripts/backfill-archive-image-hosts-8364.ts";

describe("backfillImageHosts (#8364) — miolo puro", () => {
  it("reescreve poll.diaria.workers.dev/img/ mesmo sem nenhuma entrada no mapa", () => {
    const html = '<img src="https://poll.diaria.workers.dev/img/img-x.jpg">';
    const { html: out, changed } = backfillImageHosts(html, {});
    assert.equal(changed, true);
    assert.equal(out, '<img src="https://diar.ia.br/img/img-x.jpg">');
  });

  it("reescreve media.beehiiv.com só quando presente no mapa", () => {
    const html = '<img src="https://media.beehiiv.com/a.jpg">';
    const mapped = { "https://media.beehiiv.com/a.jpg": { key: "img-archive-a.jpg", alt: "A" } };
    const { html: outMapped, changed: changedMapped } = backfillImageHosts(html, mapped);
    assert.equal(changedMapped, true);
    assert.ok(outMapped.includes("https://diar.ia.br/img/img-archive-a.jpg"));

    const { html: outUnmapped, changed: changedUnmapped } = backfillImageHosts(html, {});
    assert.equal(changedUnmapped, false);
    assert.equal(outUnmapped, html);
  });

  it("página já corrigida é no-op (changed: false)", () => {
    const html = '<img src="https://diar.ia.br/img/img-x.jpg">';
    const { changed } = backfillImageHosts(html, {});
    assert.equal(changed, false);
  });
});

describe("backfillImageHostsDir (#8364) — sobre diretório temporário real", () => {
  it("reescreve todas as páginas do diretório, idempotente numa 2ª rodada", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-archive-backfill-"));
    try {
      const slugDir = join(dir, "edicao-1");
      mkdirSync(slugDir);
      writeFileSync(
        join(slugDir, "index.html"),
        '<html><body><img src="https://poll.diaria.workers.dev/img/img-260721-a.jpg">' +
          '<a href="https://poll.diaria.workers.dev/jogar?edition=260721">jogar</a></body></html>',
        "utf8",
      );

      const first = backfillImageHostsDir(dir, false);
      assert.equal(first.length, 1);
      assert.equal(first[0].changed, true);

      const contents = readFileSync(join(slugDir, "index.html"), "utf8");
      assert.ok(contents.includes("https://diar.ia.br/img/img-260721-a.jpg"));
      assert.ok(contents.includes("https://poll.diaria.workers.dev/jogar?edition=260721"), "link /jogar preservado");

      const second = backfillImageHostsDir(dir, false);
      assert.equal(second[0].changed, false, "2ª rodada não deveria mudar nada — idempotente");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dry-run não escreve no disco", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-archive-backfill-dry-"));
    try {
      const slugDir = join(dir, "edicao-1");
      mkdirSync(slugDir);
      const original = '<img src="https://poll.diaria.workers.dev/img/img-x.jpg">';
      writeFileSync(join(slugDir, "index.html"), original, "utf8");

      const results = backfillImageHostsDir(dir, true);
      assert.equal(results[0].changed, true, "resultado ainda reporta o que MUDARIA");
      assert.equal(readFileSync(join(slugDir, "index.html"), "utf8"), original, "arquivo não deveria ser tocado");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diretório sem index.html num slug é pulado sem erro", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-archive-backfill-empty-"));
    try {
      mkdirSync(join(dir, "sem-html"));
      const results = backfillImageHostsDir(dir, true);
      assert.equal(results.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
