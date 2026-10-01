/**
 * #9320 — rollback do lote verificado não reverte imagens/prompts já
 * renomeados (#5087); a mensagem de erro precisa dizer isso, e o
 * intentional-error.json do reorder só é gravado depois do lote.
 * #9321 — promote-to-destaque não re-carimba .social-source-hash.json antes
 * do splice social (espelho do #9149/#9169) e lista o recarimbo nos next_steps.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { annotateRenamesNotReverted } from "../scripts/lib/write-files-verified.ts";
import { promoteToDestaque } from "../scripts/promote-to-destaque.ts";

describe("annotateRenamesNotReverted (#9320)", () => {
  it("anexa os renames não revertidos à mensagem", () => {
    const e = annotateRenamesNotReverted(new Error("x: Lote revertido ao estado anterior."), [
      { from: "/e/04-d1-2x1.jpg", to: "/e/04-d2-2x1.jpg" },
    ]);
    assert.match(e.message, /Lote revertido/);
    assert.match(e.message, /NÃO foram revertidos/);
    assert.match(e.message, /04-d1-2x1\.jpg→04-d2-2x1\.jpg/);
    assert.match(e.message, /NÃO reexecute o mesmo comando/);
  });
  it("sem renames, mensagem intacta", () => {
    const e = annotateRenamesNotReverted(new Error("orig"), []);
    assert.equal(e.message, "orig");
  });
});

describe("reorder/promote: sequenciamento do rollback (#9320)", () => {
  it("reorder grava intentional-error DEPOIS do lote e anota o erro do lote", () => {
    const src = readFileSync(resolve("scripts/reorder-destaques.ts"), "utf8");
    const batch = src.indexOf('writeFilesVerified(pendingWrites, "reorder-destaques")');
    const ie = src.indexOf("writeIntentionalErrorJson(intentionalErrorPath");
    assert.ok(batch > 0 && ie > 0);
    assert.ok(ie > batch, "intentional-error deve ser gravado após o lote verificado");
    assert.match(src, /annotateRenamesNotReverted\(err, modified\.renamed\)/);
  });
  it("promote também anota o erro do lote", () => {
    const src = readFileSync(resolve("scripts/promote-to-destaque.ts"), "utf8");
    assert.match(src, /annotateRenamesNotReverted\(err, renamed\)/);
  });
});

describe("promote-to-destaque não re-carimba o hash social (#9321)", () => {
  const URL_RADAR = "https://ex.com/radar";
  function makeEdition(): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-9321-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const approved = {
      highlights: [
        { rank: 1, score: 90, bucket: "noticias", url: "https://a.com/d1", article: { url: "https://a.com/d1", title: "D1" } },
        { rank: 2, score: 80, bucket: "noticias", url: "https://b.com/d2", article: { url: "https://b.com/d2", title: "D2" } },
      ],
      radar: [{ url: URL_RADAR, title: "R", score: 70, category: "pesquisa" }],
      use_melhor: [],
    };
    writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved));
    writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\ns1\n\n## d2\n\ns2\n");
    return dir;
  }

  it("não grava .social-source-hash.json e lista o recarimbo pós-splice", () => {
    const dir = makeEdition();
    try {
      const r = promoteToDestaque(dir, URL_RADAR, 1);
      const hashPath = join(dir, "_internal", ".social-source-hash.json");
      assert.equal(existsSync(hashPath), false, "hash social não pode ser carimbado antes do splice");
      assert.ok(!r.rewritten.some((p) => p.endsWith(".social-source-hash.json")));
      assert.match(readFileSync(join(dir, "03-social.md"), "utf8"), /## d3\n\ns2/);
      const iSocial = r.next_steps.findIndex((s) => s.includes("## d1"));
      const iHash = r.next_steps.findIndex((s) => s.includes("refresh-social-hash.ts"));
      assert.ok(iSocial >= 0 && iHash > iSocial, "recarimbo vem depois do splice social");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
