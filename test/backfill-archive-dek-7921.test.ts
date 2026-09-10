/**
 * test/backfill-archive-dek-7921.test.ts (#7921)
 *
 * `scripts/backfill-archive-dek-7921.ts` injeta `<meta name="dek">` em
 * páginas do acervo já COMMITTED (geradas antes do #7921 ter esse campo),
 * derivando a dek do que já está no HTML — sem precisar de
 * `data/beehiiv-cache/` (indisponível em sessão sem a junction do OneDrive).
 * Cobre o critério de recuperação (só quando 100% confiável — nunca grava
 * dek truncada/cortada) e o bug real encontrado ao rodar isto pela 1ª vez
 * neste PR: `--dry-run` (flag BARE) nunca tinha efeito porque `parseArgs`
 * registra flags bare em `flags`, não em `values` — checar `values["dry-
 * run"]` é sempre falsy, então a 1ª invocação "--dry-run" desta sessão
 * escreveu os arquivos de verdade sem querer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveDekFromRenderedPage,
  injectDekMeta,
  backfillDir,
} from "../scripts/backfill-archive-dek-7921.ts";

function fakePage(title: string, description: string): string {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title><meta name="description" content="${description}"><link rel="canonical" href="x"></head><body></body></html>`;
}

describe("deriveDekFromRenderedPage (#7921)", () => {
  it("recupera D2|D3 quando description bate exatamente title + '. ' + resto", () => {
    const html = fakePage("Título D1", "Título D1. D2 title | D3 title");
    assert.equal(deriveDekFromRenderedPage(html), "D2 title | D3 title");
  });

  it("null quando a description termina em … (truncateDescription cortou — resto não confiável)", () => {
    const html = fakePage("Título D1", "Título D1. D2 title que foi cortado no meio…");
    assert.equal(deriveDekFromRenderedPage(html), null);
  });

  it("null quando a description não começa com 'título. ' (sem D2/D3, ou fonte diferente)", () => {
    const html = fakePage("Título D1", "Descrição totalmente diferente do título");
    assert.equal(deriveDekFromRenderedPage(html), null);
  });

  it("null quando falta <title> ou <meta name=\"description\">", () => {
    assert.equal(deriveDekFromRenderedPage("<html><head></head><body></body></html>"), null);
  });

  it("null (pula) quando a página já tem <meta name=\"dek\"> — idempotente", () => {
    const html =
      fakePage("Título D1", "Título D1. D2 title") + `<meta name="dek" content="já tinha">`;
    assert.equal(deriveDekFromRenderedPage(html), null);
  });
});

describe("injectDekMeta (#7921)", () => {
  it("injeta logo após <meta name=\"description\">", () => {
    const html = fakePage("T", "T. resto");
    const out = injectDekMeta(html, "resto");
    assert.match(out, /<meta name="description" content="T\. resto"><meta name="dek" content="resto">/);
  });

  it("HTML sem <meta name=\"description\"> passa intacto", () => {
    const html = "<html><head></head><body></body></html>";
    assert.equal(injectDekMeta(html, "x"), html);
  });
});

describe("backfillDir (#7921) — integração em tmpdir", () => {
  it("backfilled / skipped_has_dek / skipped_unrecoverable, e dry-run REALMENTE não escreve", () => {
    const tmp = mkdtempSync(join(tmpdir(), "backfill-dek-"));
    try {
      mkdirSync(join(tmp, "recuperavel"), { recursive: true });
      writeFileSync(join(tmp, "recuperavel", "index.html"), fakePage("D1 A", "D1 A. D2 | D3"));

      mkdirSync(join(tmp, "ja-tem-dek"), { recursive: true });
      writeFileSync(
        join(tmp, "ja-tem-dek", "index.html"),
        fakePage("D1 B", "D1 B. D2 | D3") + '<meta name="dek" content="já">',
      );

      mkdirSync(join(tmp, "truncado"), { recursive: true });
      writeFileSync(join(tmp, "truncado", "index.html"), fakePage("D1 C", "D1 C. resto cortado…"));

      // dry-run: NADA escrito no disco, mesmo reportando o que faria.
      const dryResults = backfillDir(tmp, true);
      assert.equal(dryResults.find((r) => r.slug === "recuperavel")?.outcome, "backfilled");
      assert.equal(dryResults.find((r) => r.slug === "ja-tem-dek")?.outcome, "skipped_has_dek");
      assert.equal(dryResults.find((r) => r.slug === "truncado")?.outcome, "skipped_unrecoverable");
      const afterDry = readFileSync(join(tmp, "recuperavel", "index.html"), "utf8");
      assert.ok(!afterDry.includes('name="dek"'), "dry-run não deveria ter escrito nada no disco");

      // real: escreve de verdade.
      const realResults = backfillDir(tmp, false);
      assert.equal(realResults.find((r) => r.slug === "recuperavel")?.outcome, "backfilled");
      const afterReal = readFileSync(join(tmp, "recuperavel", "index.html"), "utf8");
      assert.match(afterReal, /<meta name="dek" content="D2 \| D3">/);

      // idempotente: rodar de novo não duplica nem quebra.
      const secondPass = backfillDir(tmp, false);
      assert.equal(secondPass.find((r) => r.slug === "recuperavel")?.outcome, "skipped_has_dek");
      const afterSecond = readFileSync(join(tmp, "recuperavel", "index.html"), "utf8");
      assert.equal((afterSecond.match(/name="dek"/g) ?? []).length, 1, "não deveria duplicar a tag dek");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
