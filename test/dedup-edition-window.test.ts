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
  extractPastEditionArticleTitles,
  deriveCurrentEdition,
  dedup,
} from "../scripts/dedup.ts";
import { canonicalize } from "../scripts/lib/url-utils.ts";

describe("deriveCurrentEdition (#1856)", () => {
  it("deriva AAMMDD do path de --out", () => {
    assert.equal(
      deriveCurrentEdition("data/editions/260605/_internal/01-approved.json"),
      "260605",
    );
  });
  it("deriva do --articles quando --out ausente", () => {
    assert.equal(
      deriveCurrentEdition(undefined, "data/editions/260530/_internal/02-articles.json"),
      "260530",
    );
  });
  it("aceita separador Windows", () => {
    assert.equal(
      deriveCurrentEdition("data\\editions\\260605\\_internal\\out.json"),
      "260605",
    );
  });
  it("retorna undefined quando nenhum path tem editions/{AAMMDD}", () => {
    assert.equal(deriveCurrentEdition("/tmp/foo.json", undefined), undefined);
    // não casa dir base sem AAMMDD
    assert.equal(deriveCurrentEdition("data/editions/"), undefined);
  });
  it("não casa segmento de 6 dígitos fora de editions/", () => {
    assert.equal(deriveCurrentEdition("data/cache/260605/x.json"), undefined);
  });
  it("não casa dir com sufixo (editions/260605-backup/)", () => {
    assert.equal(deriveCurrentEdition("data/editions/260605-backup-x/out.json"), undefined);
  });
  it("rejeita AAMMDD inválido (dia 99 / mês 13) via isValidEditionDir", () => {
    assert.equal(deriveCurrentEdition("data/editions/260999/x.json"), undefined);
    assert.equal(deriveCurrentEdition("data/editions/261301/x.json"), undefined);
  });
  it("--out tem precedência sobre --articles quando ambos têm edição", () => {
    assert.equal(
      deriveCurrentEdition("data/editions/260605/out.json", "data/editions/260604/articles.json"),
      "260605",
    );
  });
});

describe("extractPastEditionArticleTitles — self-exclusion (#1856)", () => {
  it("exclui a edição corrente → não retorna os próprios títulos (evita self-match)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ed-self-"));
    try {
      // edição passada + edição corrente, ambas com approved.json (highlights+titulos)
      mkdirSync(join(dir, "260604", "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "260604", "_internal", "01-approved.json"),
        JSON.stringify({ highlights: [{ article: { url: "https://x/past", title: "Past Edition Title" } }] }),
      );
      mkdirSync(join(dir, "260605", "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "260605", "_internal", "01-approved.json"),
        JSON.stringify({ highlights: [{ article: { url: "https://x/cur", title: "GPT-Rosalind Launch" } }] }),
      );

      // SEM exclusão: título da própria edição aparece (self-match).
      const withSelf = extractPastEditionArticleTitles(dir, 3);
      assert.ok(withSelf.includes("GPT-Rosalind Launch"), "sanity: sem exclusão inclui o próprio título");

      // COM exclusão da edição corrente: o título da 260605 NÃO aparece.
      const excluded = extractPastEditionArticleTitles(dir, 3, "260605");
      assert.ok(!excluded.includes("GPT-Rosalind Launch"), "título da edição corrente deve sair");
      assert.ok(excluded.includes("Past Edition Title"), "título da edição passada permanece");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("e2e #1856: dedup() NÃO remove o próprio destaque por self-match (subject-Jaccard)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ed-e2e-"));
    try {
      // approved.json da edição CORRENTE com o título do destaque GPT-Rosalind.
      mkdirSync(join(dir, "260605", "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "260605", "_internal", "01-approved.json"),
        JSON.stringify({
          highlights: [{ article: { url: "https://openai.com/index/gpt-rosalind", title: "GPT Rosalind ganha novas capacidades de pesquisa autônoma" } }],
        }),
      );

      // Artigo do POOL cru = o mesmo destaque (URL de pesquisa, título idêntico).
      const poolArticle = {
        url: "https://www.google.com/search?q=gpt-rosalind",
        title: "GPT Rosalind ganha novas capacidades de pesquisa autônoma",
      };

      // SEM exclusão → pastArticleTitles inclui o próprio título → self-match
      // remove o destaque (reproduz o bug #1856).
      const titlesWithSelf = extractPastEditionArticleTitles(dir, 3);
      const buggy = dedup([{ ...poolArticle }], new Set(), 0.85, [], 0.70, titlesWithSelf, 0.6);
      assert.equal(buggy.kept.length, 0, "sanity: sem exclusão o destaque é removido por self-match");

      // COM exclusão (currentAammdd derivado/explícito) → destaque sobrevive.
      const titlesExcluded = extractPastEditionArticleTitles(dir, 3, "260605");
      const fixed = dedup([{ ...poolArticle }], new Set(), 0.85, [], 0.70, titlesExcluded, 0.6);
      assert.equal(fixed.kept.length, 1, "com exclusão o destaque sobrevive");
      assert.equal(fixed.kept[0].url, poolArticle.url);

      // Idempotência: re-rodar sobre o kept dá o mesmo resultado.
      const again = dedup(fixed.kept.map((a) => ({ ...a })), new Set(), 0.85, [], 0.70, titlesExcluded, 0.6);
      assert.equal(again.kept.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
