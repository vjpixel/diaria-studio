/**
 * test/check-stage2-invariants.test.ts (#1072 / #1073)
 *
 * Cobre os 3 invariants pós-Stage 2: humanizador, Clarice, e
 * render-erro-intencional. Cada um detectável via comparação byte-idêntica
 * de arquivos intermediários ou presença de placeholder literal.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkHumanizadorRan,
  checkClariceRan,
  checkErroIntencionalRendered,
  checkIntentionalErrorFrontmatter,
  checkStage2Invariants,
} from "../scripts/check-stage2-invariants.ts";

function mkEdition() {
  const dir = mkdtempSync(join(tmpdir(), "stage2-invariants-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("checkHumanizadorRan (#1072)", () => {
  it("OK quando 02-humanized.md existe e difere de 02-normalized.md", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "texto agent");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "texto humano");
      const r = checkHumanizadorRan(join(dir, "_internal"));
      assert.equal(r.ok, true);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando 02-humanized.md não existe", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "x");
      const r = checkHumanizadorRan(join(dir, "_internal"));
      assert.equal(r.ok, false);
      assert.match(r.label!, /humanized_missing/);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando 02-humanized.md byte-idêntico a 02-normalized.md (no-op)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      const txt = "texto idêntico em ambos";
      writeFileSync(join(dir, "_internal", "02-normalized.md"), txt);
      writeFileSync(join(dir, "_internal", "02-humanized.md"), txt);
      const r = checkHumanizadorRan(join(dir, "_internal"));
      assert.equal(r.ok, false);
      assert.match(r.label!, /humanized_unchanged/);
    } finally {
      cleanup();
    }
  });

  it("OK quando 02-normalized.md não existe (passo anterior falhou — não é problema do humanizador)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "x");
      const r = checkHumanizadorRan(join(dir, "_internal"));
      assert.equal(r.ok, true);
    } finally {
      cleanup();
    }
  });
});

describe("checkClariceRan (#1072, refined #1402)", () => {
  function setupWithSuggestions(dir: string, suggestions: unknown) {
    writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "pré");
    writeFileSync(join(dir, "02-reviewed.md"), "pós-clarice");
    writeFileSync(
      join(dir, "_internal", "02-clarice-suggestions.json"),
      JSON.stringify(suggestions),
    );
  }

  it("OK quando os 3 artefatos existem e suggestions é array", () => {
    const { dir, cleanup } = mkEdition();
    try {
      setupWithSuggestions(dir, [{ from: "a", to: "b" }]);
      const r = checkClariceRan(dir);
      assert.equal(r.ok, true);
    } finally {
      cleanup();
    }
  });

  it("#1402: OK quando suggestions é array vazio (Clarice rodou sem sugestões)", () => {
    // Caso real 260520: humanizador eficaz → Clarice retornou [] em 59
    // parágrafos. Antes do fix, output bytes-idênticos a pre-clarice
    // disparava clarice_unchanged false positive. Agora é OK legítimo.
    const { dir, cleanup } = mkEdition();
    try {
      const txt = "texto já limpo pelo humanizador";
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), txt);
      writeFileSync(join(dir, "02-reviewed.md"), txt); // byte-idêntico — Clarice [] suggestions
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const r = checkClariceRan(dir);
      assert.equal(r.ok, true, `esperado OK com suggestions=[], got: ${r.label}`);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando 02-reviewed.md não existe", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "x");
      const r = checkClariceRan(dir);
      assert.equal(r.ok, false);
      assert.match(r.label!, /reviewed_missing/);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando snapshot 02-pre-clarice.md ausente (assertion #889)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "x");
      const r = checkClariceRan(dir);
      assert.equal(r.ok, false);
      assert.match(r.label!, /pre_clarice_missing/);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando 02-clarice-suggestions.json ausente (Clarice não foi chamada)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "pré");
      writeFileSync(join(dir, "02-reviewed.md"), "pós-clarice");
      // sem 02-clarice-suggestions.json
      const r = checkClariceRan(dir);
      assert.equal(r.ok, false);
      assert.match(r.label!, /suggestions_missing/);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando suggestions.json não é JSON válido", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "pré");
      writeFileSync(join(dir, "02-reviewed.md"), "pós");
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "{ not json");
      const r = checkClariceRan(dir);
      assert.equal(r.ok, false);
      assert.match(r.label!, /suggestions_invalid/);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando suggestions não é array (shape inesperado)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      setupWithSuggestions(dir, { error: "wrong shape" });
      const r = checkClariceRan(dir);
      assert.equal(r.ok, false);
      assert.match(r.label!, /suggestions_invalid/);
    } finally {
      cleanup();
    }
  });
});

describe("checkErroIntencionalRendered (#1073)", () => {
  it("OK quando reviewed não tem placeholder literal", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "**ERRO INTENCIONAL**\n\nNa última edição, X.\n");
      const r = checkErroIntencionalRendered(dir);
      assert.equal(r.ok, true);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando placeholder literal do writer ainda presente", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(
        join(dir, "02-reviewed.md"),
        "Body...\n\n{placeholder, script render-erro-intencional.ts substitui pós-Clarice}\n",
      );
      const r = checkErroIntencionalRendered(dir);
      assert.equal(r.ok, false);
      assert.match(r.label!, /erro_intencional_placeholder/);
    } finally {
      cleanup();
    }
  });

  it("FAIL com variante de placeholder (case-insensitive, com ou sem vírgula)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(
        join(dir, "02-reviewed.md"),
        "{Placeholder script render-erro-intencional substitui}",
      );
      const r = checkErroIntencionalRendered(dir);
      assert.equal(r.ok, false);
    } finally {
      cleanup();
    }
  });

  it("OK quando reviewed.md não existe (outro check captura)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      const r = checkErroIntencionalRendered(dir);
      assert.equal(r.ok, true);
    } finally {
      cleanup();
    }
  });
});

const REVIEWED_WITH_FRONTMATTER = `---
intentional_error:
  description: "teste"
  location: "DESTAQUE 1"
  category: "factual"
  correct_value: "valor correto"
---
b clarificado, sem placeholder`;

describe("checkStage2Invariants — integração", () => {
  it("OK quando os 4 invariants passam (#2284: inclui frontmatter)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a humanizado");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_WITH_FRONTMATTER);
      // #1402: Clarice agora exige suggestions.json
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const r = checkStage2Invariants(dir);
      assert.equal(r.ok, true);
      assert.equal(r.checks.humanizador.ok, true);
      assert.equal(r.checks.clarice.ok, true);
      assert.equal(r.checks.erro_intencional.ok, true);
      assert.equal(r.checks.intentional_error_frontmatter.ok, true);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando humanizador pulou (260511 real case)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      // Pula humanizador (sem 02-humanized.md)
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "a");
      writeFileSync(join(dir, "02-reviewed.md"), "a clarificado");
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const r = checkStage2Invariants(dir);
      assert.equal(r.ok, false);
      assert.equal(r.checks.humanizador.ok, false);
    } finally {
      cleanup();
    }
  });

  // #1456: novo check urls_accessible
  it("urls_accessible OK quando cache marca todas as URLs accessible", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a hum");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      writeFileSync(
        join(dir, "02-reviewed.md"),
        `${REVIEWED_WITH_FRONTMATTER}\n[T1](https://a.com/x) [T2](https://b.com/y)`,
      );
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const cachePath = join(dir, "verify-cache.json");
      writeFileSync(
        cachePath,
        JSON.stringify({
          "https://a.com/x": { verdict: "accessible" },
          "https://b.com/y": { verdict: "accessible" },
        }),
      );
      const r = checkStage2Invariants(dir, { cachePath });
      assert.equal(r.ok, true);
      assert.equal(r.checks.urls_accessible.ok, true);
    } finally {
      cleanup();
    }
  });

  it("urls_accessible FAIL quando URL pós-edit não está no cache (caso 260522)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a hum");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      // MD com URL que foi adicionada manual após Stage 1 verify
      writeFileSync(
        join(dir, "02-reviewed.md"),
        "[Hallucinated](https://hallucinated.com/x)",
      );
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const cachePath = join(dir, "verify-cache.json");
      writeFileSync(cachePath, JSON.stringify({})); // cache vazio
      const r = checkStage2Invariants(dir, { cachePath });
      assert.equal(r.ok, false);
      assert.equal(r.checks.urls_accessible.ok, false);
      assert.match(
        r.checks.urls_accessible.label ?? "",
        /not_in_cache|urls_suspicious/,
      );
    } finally {
      cleanup();
    }
  });

  it("urls_accessible FAIL quando URL tem verdict != accessible no cache", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a hum");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      writeFileSync(
        join(dir, "02-reviewed.md"),
        "[Paywall](https://nyt.com/x)",
      );
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const cachePath = join(dir, "verify-cache.json");
      writeFileSync(
        cachePath,
        JSON.stringify({ "https://nyt.com/x": { verdict: "paywall" } }),
      );
      const r = checkStage2Invariants(dir, { cachePath });
      assert.equal(r.ok, false);
      assert.equal(r.checks.urls_accessible.ok, false);
    } finally {
      cleanup();
    }
  });

  it("urls_accessible ignora footer/affiliate URLs (não bloqueia stage 2)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a hum");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      writeFileSync(
        join(dir, "02-reviewed.md"),
        `${REVIEWED_WITH_FRONTMATTER}\n[Cursos](https://diaria.beehiiv.com/cursos-gratuitos-de-ia) [Wispr](https://wisprflow.ai/r?x)`,
      );
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const cachePath = join(dir, "verify-cache.json");
      writeFileSync(cachePath, JSON.stringify({})); // cache vazio mas só tem footer URLs
      const r = checkStage2Invariants(dir, { cachePath });
      assert.equal(r.ok, true);
      assert.equal(r.checks.urls_accessible.ok, true);
    } finally {
      cleanup();
    }
  });

  // #1456 review fix: schema canonical {version, entries}
  it("urls_accessible aceita schema canonical {version, entries: {...}}", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a hum");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      writeFileSync(
        join(dir, "02-reviewed.md"),
        `${REVIEWED_WITH_FRONTMATTER}\n[T1](https://a.com/x) [T2](https://b.com/y)`,
      );
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const cachePath = join(dir, "verify-cache.json");
      // Schema real de produção
      writeFileSync(
        cachePath,
        JSON.stringify({
          version: 1,
          entries: {
            "https://a.com/x": { verdict: "accessible" },
            "https://b.com/y": { verdict: "accessible" },
          },
        }),
      );
      const r = checkStage2Invariants(dir, { cachePath });
      assert.equal(r.ok, true, `failed: ${r.checks.urls_accessible.label}`);
      assert.equal(r.checks.urls_accessible.ok, true);
    } finally {
      cleanup();
    }
  });

  it("urls_accessible normaliza trailing slash entre MD e cache", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a hum");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      // MD tem URL com trailing slash, cache sem
      writeFileSync(
        join(dir, "02-reviewed.md"),
        `${REVIEWED_WITH_FRONTMATTER}\n[T1](https://blog.google/x/) [T2](https://anthropic.com/y)`,
      );
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const cachePath = join(dir, "verify-cache.json");
      writeFileSync(
        cachePath,
        JSON.stringify({
          version: 1,
          entries: {
            "https://blog.google/x": { verdict: "accessible" }, // sem trailing slash
            "https://anthropic.com/y/": { verdict: "accessible" }, // com trailing slash
          },
        }),
      );
      const r = checkStage2Invariants(dir, { cachePath });
      assert.equal(r.ok, true, `failed: ${r.checks.urls_accessible.label}`);
    } finally {
      cleanup();
    }
  });

  it("urls_accessible faz match via finalUrl (redirect)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a hum");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      // MD tem a URL canonical (pós-redirect)
      writeFileSync(
        join(dir, "02-reviewed.md"),
        `${REVIEWED_WITH_FRONTMATTER}\n[T](https://canonical.com/final)`,
      );
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const cachePath = join(dir, "verify-cache.json");
      // Cache tem entry com finalUrl populated
      writeFileSync(
        cachePath,
        JSON.stringify({
          version: 1,
          entries: {
            "https://short.url/abc": {
              verdict: "accessible",
              finalUrl: "https://canonical.com/final",
            },
          },
        }),
      );
      const r = checkStage2Invariants(dir, { cachePath });
      assert.equal(r.ok, true, `failed: ${r.checks.urls_accessible.label}`);
    } finally {
      cleanup();
    }
  });

  it("urls_accessible aceita variantes wikipedia (en.wikipedia.org)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a hum");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      writeFileSync(
        join(dir, "02-reviewed.md"),
        `${REVIEWED_WITH_FRONTMATTER}\n[En Wiki](https://en.wikipedia.org/wiki/X) [Commons](https://upload.wikimedia.org/x.jpg)`,
      );
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const cachePath = join(dir, "verify-cache.json");
      writeFileSync(cachePath, JSON.stringify({ version: 1, entries: {} }));
      const r = checkStage2Invariants(dir, { cachePath });
      assert.equal(r.ok, true, `failed: ${r.checks.urls_accessible.label}`);
    } finally {
      cleanup();
    }
  });

  it("urls_accessible persiste lista completa em _internal/02-urls-suspicious.json", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a hum");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      // Mais que 5 URLs suspeitas pra triggerar o `+N mais`
      const urls = Array.from({ length: 7 }, (_, i) => `[T${i}](https://s${i}.com/x)`).join(" ");
      writeFileSync(join(dir, "02-reviewed.md"), urls);
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const cachePath = join(dir, "verify-cache.json");
      writeFileSync(cachePath, JSON.stringify({ version: 1, entries: {} }));
      const r = checkStage2Invariants(dir, { cachePath });
      assert.equal(r.ok, false);
      // Verifica que o arquivo foi gerado
      const persisted = JSON.parse(
        readFileSync(join(dir, "_internal", "02-urls-suspicious.json"), "utf8"),
      );
      assert.equal(persisted.suspicious.length, 7);
    } finally {
      cleanup();
    }
  });

  it("urls_accessible skip silencioso quando cache não existe", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a hum");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      writeFileSync(join(dir, "02-reviewed.md"), `${REVIEWED_WITH_FRONTMATTER}\n[T](https://x.com/y)`);
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const r = checkStage2Invariants(dir, { cachePath: join(dir, "nonexistent.json") });
      assert.equal(r.ok, true); // não bloqueia
      assert.equal(r.checks.urls_accessible.ok, true);
      assert.match(r.checks.urls_accessible.label ?? "", /verify_cache_missing/);
    } finally {
      cleanup();
    }
  });

  // #2284: novo check intentional_error_frontmatter
  it("#2284: FAIL quando frontmatter intentional_error ausente em 02-reviewed.md", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a hum");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      // Sem frontmatter — simula o bug do pre-gate onde render-erro não inseria o bloco
      writeFileSync(join(dir, "02-reviewed.md"), "b clarificado, sem placeholder");
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const r = checkStage2Invariants(dir, { cachePath: join(dir, "no-cache.json") });
      assert.equal(r.ok, false);
      assert.equal(r.checks.intentional_error_frontmatter.ok, false);
      assert.match(
        r.checks.intentional_error_frontmatter.label ?? "",
        /intentional_error_frontmatter_missing/,
      );
    } finally {
      cleanup();
    }
  });

  it("#2284: FAIL quando frontmatter existe mas sem chave intentional_error", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a hum");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      writeFileSync(
        join(dir, "02-reviewed.md"),
        "---\noutro_campo: valor\n---\nb clarificado",
      );
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const r = checkStage2Invariants(dir, { cachePath: join(dir, "no-cache.json") });
      assert.equal(r.ok, false);
      assert.equal(r.checks.intentional_error_frontmatter.ok, false);
      assert.match(
        r.checks.intentional_error_frontmatter.label ?? "",
        /intentional_error_frontmatter_missing/,
      );
    } finally {
      cleanup();
    }
  });

  it("#2284: OK quando frontmatter tem intentional_error (mesmo com placeholders)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a hum");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      // Frontmatter com placeholders — inserido automaticamente por render-erro-intencional
      writeFileSync(
        join(dir, "02-reviewed.md"),
        `---\nintentional_error:\n  description: "{PREENCHER}"\n  location: "{PREENCHER}"\n  category: "{PREENCHER}"\n  correct_value: "{PREENCHER}"\n---\nb clarificado, sem placeholder`,
      );
      writeFileSync(join(dir, "_internal", "02-clarice-suggestions.json"), "[]");
      const r = checkStage2Invariants(dir, { cachePath: join(dir, "no-cache.json") });
      assert.equal(r.checks.intentional_error_frontmatter.ok, true);
    } finally {
      cleanup();
    }
  });
});

describe("checkIntentionalErrorFrontmatter (#2284)", () => {
  it("OK quando frontmatter tem intentional_error com valores reais", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), REVIEWED_WITH_FRONTMATTER);
      const r = checkIntentionalErrorFrontmatter(dir);
      assert.equal(r.ok, true);
    } finally {
      cleanup();
    }
  });

  it("OK quando reviewed.md não existe (outro check captura)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      const r = checkIntentionalErrorFrontmatter(dir);
      assert.equal(r.ok, true);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando sem frontmatter algum", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "corpo sem frontmatter");
      const r = checkIntentionalErrorFrontmatter(dir);
      assert.equal(r.ok, false);
      assert.match(r.label ?? "", /intentional_error_frontmatter_missing/);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando frontmatter sem chave intentional_error", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "---\noutro: x\n---\ncorpo");
      const r = checkIntentionalErrorFrontmatter(dir);
      assert.equal(r.ok, false);
      assert.match(r.label ?? "", /intentional_error_frontmatter_missing/);
    } finally {
      cleanup();
    }
  });

  it("OK com intentional_error placeholder (pre_gate auto-insert)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(
        join(dir, "02-reviewed.md"),
        `---\nintentional_error:\n  description: "{PREENCHER}"\n  location: "{PREENCHER}"\n  category: "{PREENCHER}"\n  correct_value: "{PREENCHER}"\n---\ncorpo`,
      );
      const r = checkIntentionalErrorFrontmatter(dir);
      assert.equal(r.ok, true);
    } finally {
      cleanup();
    }
  });

  it("P2 fix #2300: OK quando documento começa com stub ---/--- vazio seguido do bloco YAML real", () => {
    // Regressão da divergência detectada em code-review: o loop hand-rolled anterior
    // tomava os primeiros 2 `---` incondicionalmente, coletando o bloco vazio e
    // retornando false-negative (ok: false mesmo com intentional_error presente).
    //
    // Cenário: `---\n---\n` (stub/empty frontmatter), seguido direto do YAML real.
    // O loop anterior: fmStart=0, fmEnd=1, body="" → /intentional_error/ não bate → false.
    // extractFrontmatter(): canonical regex captura o body incluindo o YAML real
    // (entre o 1º e o último `---`) → /intentional_error/ bate → true.
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(
        join(dir, "02-reviewed.md"),
        [
          "---",
          "---",       // stub empty — hand-rolled loop para aqui (body="") → false-negative
          "intentional_error:",
          '  description: "Detalhe do erro"',
          '  location: "DESTAQUE 1"',
          '  category: "factual"',
          '  correct_value: "2014"',
          "---",
          "",
          "Corpo da newsletter.",
        ].join("\n"),
      );
      const r = checkIntentionalErrorFrontmatter(dir);
      assert.equal(r.ok, true, "extractFrontmatter deve achar intentional_error mesmo com stub ---/--- antes");
    } finally {
      cleanup();
    }
  });
});
