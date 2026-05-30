/**
 * test/dedup-edition-window.test.ts (#1567 audit)
 *
 * Regressão: a janela de dedup contra past-editions locais selecionava dirs por
 * `/^\d{6}$/` e ordenação lexical. Um dir sintético `260999` (6 dígitos, dia 99)
 * passava o filtro, ordenava no TOPO e roubava um slot da janela de 3 edições —
 * derrubando uma edição REAL (ex: 260527) do dedup. Agora a seleção valida o
 * nome (mês 01-12, dia 01-31) E exige artefato de edição.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  isValidEditionDir,
  recentEditionDirs,
  extractPastDestaqueUrls,
} from "../scripts/dedup.ts";
import { canonicalize } from "../scripts/lib/url-utils.ts";

describe("isValidEditionDir", () => {
  it("aceita AAMMDD válido", () => {
    assert.equal(isValidEditionDir("260527"), true);
    assert.equal(isValidEditionDir("260101"), true);
    assert.equal(isValidEditionDir("261231"), true);
  });
  it("rejeita data inválida (dia 99, mês 13)", () => {
    assert.equal(isValidEditionDir("260999"), false); // dia 99
    assert.equal(isValidEditionDir("261301"), false); // mês 13
    assert.equal(isValidEditionDir("260500"), false); // dia 00
  });
  it("rejeita não-AAMMDD (backup, curto, lixo)", () => {
    assert.equal(isValidEditionDir("260420-backup-2026-04-20"), false);
    assert.equal(isValidEditionDir("26052"), false);
    assert.equal(isValidEditionDir("abcdef"), false);
  });
});

describe("recentEditionDirs — janela não é poluída por dir sintético (#1567)", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "ed-"));
    // 3 edições reais (com artefato)
    for (const ed of ["260527", "260528", "260529"]) {
      mkdirSync(join(dir, ed, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, ed, "_internal", "01-approved.json"),
        JSON.stringify({ highlights: [{ article: { url: `https://x.com/${ed}` } }] }),
      );
    }
    // dir sintético: nome válido-ish em 6 dígitos MAS data inválida + só marker
    mkdirSync(join(dir, "260999", "_internal"), { recursive: true });
    writeFileSync(join(dir, "260999", "_internal", ".marker-test-marker.json"), "{}");
    // backup dir (nome inválido)
    mkdirSync(join(dir, "260420-backup-x", "_internal"), { recursive: true });
    writeFileSync(
      join(dir, "260420-backup-x", "_internal", "01-approved.json"),
      JSON.stringify({ highlights: [{ article: { url: "https://x.com/backup" } }] }),
    );
    return dir;
  }

  it("seleciona as 3 edições REAIS, exclui 260999 e backup", () => {
    const dir = setup();
    try {
      assert.deepEqual(recentEditionDirs(dir, 3), ["260529", "260528", "260527"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exclui currentAammdd e ainda preenche a janela com edições reais", () => {
    const dir = setup();
    try {
      // current=260529 → janela deve trazer 260528 + 260527 (não 260999)
      assert.deepEqual(recentEditionDirs(dir, 3, "260529"), ["260528", "260527"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconhece edição com SÓ newsletter-final.html (fonte de fallback) como real", () => {
    const dir = mkdtempSync(join(tmpdir(), "ed-html-"));
    try {
      mkdirSync(join(dir, "260530", "_internal"), { recursive: true });
      // sem MD/approved.json — só o HTML final publicado (fallback de #1068)
      writeFileSync(join(dir, "260530", "_internal", "newsletter-final.html"), "<html></html>");
      assert.deepEqual(recentEditionDirs(dir, 3), ["260530"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("end-to-end: extractPastDestaqueUrls inclui a edição que 260999 derrubava", () => {
    const dir = setup();
    try {
      const urls = extractPastDestaqueUrls(dir, 3);
      // 260527 (que o 260999 expulsava da janela) está presente
      assert.ok(urls.has(canonicalize("https://x.com/260527")), "260527 deve estar na janela");
      assert.ok(urls.has(canonicalize("https://x.com/260529")));
      // backup nunca entra
      assert.ok(!urls.has(canonicalize("https://x.com/backup")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
