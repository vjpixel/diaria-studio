/**
 * test/apply-factcheck-autofix.test.ts (#2598, estendido a social em #3224)
 *
 * Testes para scripts/apply-factcheck-autofix.ts.
 *
 * Cenários cobertos:
 *   1. DIVERGENT com suggested_fix → aplicado em newsletter (caso real: GPT-4o → GPT-5.4)
 *   2. NOT_FOUND_IN_SOURCE → nunca auto-corrigido (non-divergent)
 *   3. DIVERGENT superlativo → não auto-corrigido (only tone)
 *   4. intentional_error declarado no frontmatter → claim do mesmo destaque é pulado
 *   5. DIVERGENT sem suggested_fix → skipped_no_fix
 *   6. Texto não encontrado nos arquivos → skipped_text_not_found
 *   7. Dry-run não modifica arquivos mas grava fact-check-autofix.json
 *   8. Multiple DIVERGENT (mesmo texto, destaques diferentes) → scoped ao destaque correto
 *   9. Claim apenas em social (#3224) → aplicado em 03-social.md, sentinel regravado com bypass
 *  10. Dry-run registra files_modified (plano) mesmo sem escrever em disco
 *  11. (#3224) sources: ["newsletter","social"] com texto presente nos dois → AMBOS corrigidos
 *  12. (#3224) sources: ["newsletter","social"] com texto só na newsletter → sucesso parcial
 *  13. (#3224) findSocialDestaqueRanges / applySocialTextSubstitution — helpers puros
 *  14. (#3224) sentinel pré-existente (pós-humanizador) é regravado com bypass_reason e
 *      passa a bater com o novo hash de 03-social.md
 *  15. (#3274) `## post_pixel` é aberto como range-alvo quando destaque=1 — claim
 *      DIVERGENT sobre D1 corrige tanto `## d1` quanto `## post_pixel`
 *  16. (#3275) applyTextSubstitution (scoped) substitui TODAS as ocorrências dentro
 *      do range — inclusive quando a mesma claim aparece no corpo E em
 *      `### comment_pixel`/`### comment_diaria` aninhados
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  extractIntentionalErrorDestaque,
  isIntentionalErrorClaim,
  applyTextSubstitution,
  findDestaqueBodyRange,
  findSocialDestaqueRanges,
  applySocialTextSubstitution,
  planAutofixes,
  type AutofixEntry,
} from "../scripts/apply-factcheck-autofix.ts";
import type { FactClaim } from "../scripts/run-fact-checker.ts";
import { checkSentinel, writeSentinel } from "../scripts/check-humanizer-social.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClaim(
  overrides: Partial<FactClaim> & { verdict: FactClaim["verdict"] },
): FactClaim {
  return {
    destaque: 1,
    claim_type: "number",
    text: "GPT-4o",
    context: "comparou com GPT-4o",
    sources: ["newsletter"],
    ...overrides,
  };
}

function runCli(editionDir: string, extraArgs: string[] = []) {
  const projectRoot = join(import.meta.dirname, "..");
  const scriptPath = join(projectRoot, "scripts", "apply-factcheck-autofix.ts");
  return spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, "--edition-dir", editionDir, ...extraArgs],
    { cwd: projectRoot, encoding: "utf8" },
  );
}

interface Fixture {
  dir: string;
  newsletterPath: string;
  socialPath: string;
  factCheckPath: string;
  autofixPath: string;
}

function createFixture(
  opts: {
    newsletterContent?: string;
    socialContent?: string;
    factCheckClaims?: Partial<FactClaim>[];
    /** #3222: quando presente, escreve _internal/intentional-error.json (substitui
     * o antigo frontmatter YAML embutido em newsletterContent). */
    intentionalErrorRecord?: Record<string, unknown>;
  } = {},
): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "factcheck-autofix-"));
  const internalDir = join(dir, "_internal");
  mkdirSync(internalDir, { recursive: true });

  const newsletterContent =
    opts.newsletterContent ??
    `DESTAQUE 1\n\nO modelo GPT-4o foi comparado com o novo lançamento.\n\nPor que isso importa: teste.\n`;
  const socialContent =
    opts.socialContent ??
    `# LinkedIn\n\n## d1\n\nO GPT-4o foi superado pelo novo modelo.\n`;

  writeFileSync(join(dir, "02-reviewed.md"), newsletterContent, "utf8");
  writeFileSync(join(dir, "03-social.md"), socialContent, "utf8");
  writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify({ highlights: [] }), "utf8");
  if (opts.intentionalErrorRecord) {
    writeFileSync(
      join(internalDir, "intentional-error.json"),
      JSON.stringify(opts.intentionalErrorRecord, null, 2),
      "utf8",
    );
  }

  const claims = (opts.factCheckClaims ?? []).map((c) => makeClaim(c as Parameters<typeof makeClaim>[0]));
  const factCheck = {
    edition: "260626",
    checked_at: new Date().toISOString(),
    claims,
    summary: {
      total: claims.length,
      sustained: 0,
      divergent: claims.filter((c) => c.verdict === "DIVERGENT").length,
      not_found_in_source: 0,
      source_unreachable: 0,
      inferred: 0,
      attention_items: 0,
    },
  };
  writeFileSync(join(internalDir, "fact-check.json"), JSON.stringify(factCheck), "utf8");

  return {
    dir,
    newsletterPath: join(dir, "02-reviewed.md"),
    socialPath: join(dir, "03-social.md"),
    factCheckPath: join(internalDir, "fact-check.json"),
    autofixPath: join(internalDir, "fact-check-autofix.json"),
  };
}

// ---------------------------------------------------------------------------
// extractIntentionalErrorDestaque
// ---------------------------------------------------------------------------

describe("extractIntentionalErrorDestaque (#2598, migrado pra JSON #3222)", () => {
  it("retorna null quando record é null (ausente)", () => {
    assert.equal(extractIntentionalErrorDestaque(null), null);
  });

  it("retorna null quando record não tem location", () => {
    assert.equal(extractIntentionalErrorDestaque({ description: "x", category: "factual" }), null);
  });

  it("retorna null quando no_error: true (#2016)", () => {
    assert.equal(extractIntentionalErrorDestaque({ no_error: true, location: "DESTAQUE 1" }), null);
  });

  it("retorna 1 quando location é 'DESTAQUE 1, parágrafo 2'", () => {
    const record = {
      description: "GPT-4o onde deveria ser GPT-5.4",
      location: "DESTAQUE 1, parágrafo 2",
      category: "version_inconsistency",
      correct_value: "GPT-5.4",
    };
    assert.equal(extractIntentionalErrorDestaque(record), 1);
  });

  it("retorna 2 quando location é 'DESTAQUE 2'", () => {
    const record = {
      description: "ano errado",
      location: "DESTAQUE 2, parágrafo 1",
      category: "numeric",
      correct_value: "2024",
    };
    assert.equal(extractIntentionalErrorDestaque(record), 2);
  });
});

// ---------------------------------------------------------------------------
// isIntentionalErrorClaim
// ---------------------------------------------------------------------------

describe("isIntentionalErrorClaim (#2598)", () => {
  it("retorna false quando intentionalDestaque é null", () => {
    const claim = makeClaim({ verdict: "DIVERGENT", destaque: 1 });
    assert.equal(isIntentionalErrorClaim(claim, null), false);
  });

  it("retorna true quando destaque do claim bate com intentional_error", () => {
    const claim = makeClaim({ verdict: "DIVERGENT", destaque: 1 });
    assert.equal(isIntentionalErrorClaim(claim, 1), true);
  });

  it("retorna false quando destaque do claim é diferente", () => {
    const claim = makeClaim({ verdict: "DIVERGENT", destaque: 2 });
    assert.equal(isIntentionalErrorClaim(claim, 1), false);
  });
});

// ---------------------------------------------------------------------------
// applyTextSubstitution
// ---------------------------------------------------------------------------

describe("applyTextSubstitution (#2598)", () => {
  it("substitui primeira ocorrência e retorna changed=true", () => {
    const result = applyTextSubstitution("O modelo GPT-4o é rápido.", "GPT-4o", "GPT-5.4");
    assert.equal(result.changed, true);
    assert.equal(result.content, "O modelo GPT-5.4 é rápido.");
  });

  it("retorna changed=false quando texto não encontrado", () => {
    const result = applyTextSubstitution("Texto sem o claim.", "GPT-4o", "GPT-5.4");
    assert.equal(result.changed, false);
    assert.equal(result.content, "Texto sem o claim.");
  });

  it("substitui apenas a primeira ocorrência (conservador)", () => {
    const result = applyTextSubstitution("GPT-4o vs GPT-4o", "GPT-4o", "GPT-5.4");
    assert.equal(result.changed, true);
    // Apenas o primeiro deve ser substituído
    assert.equal(result.content, "GPT-5.4 vs GPT-4o");
  });
});

// ---------------------------------------------------------------------------
// Regressão (self-review #3292): newText com sequências '$' não pode ser
// interpretado como replacement-pattern do replaceAll (GetSubstitution)
// ---------------------------------------------------------------------------

describe("regressao (#3292 self-review): applyTextSubstitution (scoped) trata newText como literal, não replacement-pattern", () => {
  it("newText contendo '$&' não reinsere o oldText casado (GetSubstitution do replaceAll)", () => {
    const content = "## d1\n\nO modelo GPT-4o custou caro.\n\n## d2\n\nOutro destaque.";
    const scope = { start: 0, end: content.indexOf("## d2") };
    const result = applyTextSubstitution(content, "GPT-4o", "GPT-5.4, sucessor de $&", scope);
    assert.equal(result.changed, true);
    // Literal: '$&' deve permanecer como texto puro, NUNCA expandir pra "GPT-4o"
    // (que reinseriria a própria claim errada que a correção deveria remover).
    assert.ok(
      result.content.includes("GPT-5.4, sucessor de $&"),
      "newText deve aparecer literal, incluindo o '$&' puro",
    );
    assert.ok(
      !/sucessor de GPT-4o/.test(result.content),
      "'$&' NUNCA deve expandir para o texto casado (oldText)",
    );
  });

  it("newText contendo '$$' não colapsa para um único '$' (GetSubstitution)", () => {
    const content = "## d1\n\nCusto de GPT-4o foi alto.\n\n## d2\n\nOutro destaque.";
    const scope = { start: 0, end: content.indexOf("## d2") };
    const result = applyTextSubstitution(content, "GPT-4o", "R$$ 24,99", scope);
    assert.equal(result.changed, true);
    assert.ok(result.content.includes("R$$ 24,99"), "'$$' deve permanecer literal, não colapsar para 'R$'");
  });

  it("newText contendo \"$'\" ou '$`' não emenda trechos arbitrários do documento", () => {
    const content = "PREFIXO_UNICO ## d1\n\nGPT-4o é o assunto. SUFIXO_UNICO";
    const scope = { start: content.indexOf("## d1"), end: content.length };
    const result = applyTextSubstitution(content, "GPT-4o", "GPT-5.4 ($` e $')", scope);
    assert.equal(result.changed, true);
    assert.ok(
      result.content.includes("GPT-5.4 ($` e $')"),
      "'$`'/\"$'\" devem permanecer literais",
    );
    assert.ok(
      !result.content.includes("PREFIXO_UNICOPREFIXO_UNICO") && !result.content.includes("SUFIXO_UNICOSUFIXO_UNICO"),
      "nenhum trecho do documento deve ser duplicado/emendado via '$`' ou \"$'\"",
    );
  });

  it("comportamento legado sem scope (indexOf) permanece imune — sempre foi concatenação literal", () => {
    const result = applyTextSubstitution("O modelo GPT-4o é rápido.", "GPT-4o", "GPT-5.4 ($&)");
    assert.equal(result.content, "O modelo GPT-5.4 ($&) é rápido.");
  });
});

// ---------------------------------------------------------------------------
// planAutofixes — lógica de decisão pura
// ---------------------------------------------------------------------------

describe("planAutofixes (#2598)", () => {
  it("DIVERGENT com suggested_fix → status applied (sem intentional_error)", () => {
    const claim = makeClaim({
      verdict: "DIVERGENT",
      text: "GPT-4o",
      suggested_fix: "GPT-5.4",
      sources: ["newsletter"],
    });
    const entries = planAutofixes([claim], null);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, "applied");
  });

  it("DIVERGENT superlativo → skipped_superlative (mesmo com suggested_fix)", () => {
    const claim = makeClaim({
      verdict: "DIVERGENT",
      claim_type: "superlative",
      text: "primeiro do Brasil",
      suggested_fix: "segundo do Brasil",
      sources: ["newsletter"],
    });
    const entries = planAutofixes([claim], null);
    assert.equal(entries[0].status, "skipped_superlative");
  });

  it("DIVERGENT sem suggested_fix → skipped_no_fix", () => {
    const claim = makeClaim({
      verdict: "DIVERGENT",
      text: "GPT-4o",
      suggested_fix: undefined,
      sources: ["newsletter"],
    });
    const entries = planAutofixes([claim], null);
    assert.equal(entries[0].status, "skipped_no_fix");
  });

  it("DIVERGENT do mesmo destaque do intentional_error → skipped_intentional_error", () => {
    const claim = makeClaim({
      verdict: "DIVERGENT",
      destaque: 1,
      text: "GPT-4o",
      suggested_fix: "GPT-5.4",
      sources: ["newsletter"],
    });
    const entries = planAutofixes([claim], 1); // intentional_error no destaque 1
    assert.equal(entries[0].status, "skipped_intentional_error");
  });

  it("DIVERGENT de destaque diferente do intentional_error → applied", () => {
    const claim = makeClaim({
      verdict: "DIVERGENT",
      destaque: 2,
      text: "R$ 99",
      suggested_fix: "R$ 24,99",
      sources: ["newsletter"],
    });
    const entries = planAutofixes([claim], 1); // intentional_error no destaque 1, não no 2
    assert.equal(entries[0].status, "applied");
  });

  it("NOT_FOUND_IN_SOURCE → não entra em planAutofixes (filtra apenas DIVERGENT)", () => {
    const claim = makeClaim({
      verdict: "NOT_FOUND_IN_SOURCE",
      text: "primeira vez",
      sources: ["social"],
    });
    const entries = planAutofixes([claim], null);
    // NOT_FOUND_IN_SOURCE não é DIVERGENT → não processa
    assert.equal(entries.length, 0);
  });

  it("mix de DIVERGENT e NOT_FOUND → só DIVERGENT processado", () => {
    const c1 = makeClaim({ verdict: "DIVERGENT", text: "GPT-4o", suggested_fix: "GPT-5.4", sources: ["newsletter"] });
    const c2 = makeClaim({ verdict: "NOT_FOUND_IN_SOURCE", claim_type: "superlative", text: "primeiro", sources: ["social"] });
    const entries = planAutofixes([c1, c2], null);
    assert.equal(entries.length, 1, "só o DIVERGENT deve ser retornado");
    assert.equal(entries[0].text, "GPT-4o");
  });
});

// ---------------------------------------------------------------------------
// CLI integration — cenário real: GPT-4o → GPT-5.4
// ---------------------------------------------------------------------------

describe("apply-factcheck-autofix CLI — cenário real GPT-4o → GPT-5.4 (#2598)", () => {
  it("(#3224) sources newsletter+social com texto nos dois → AMBOS corrigidos + sentinel regravado com bypass", () => {
    const originalSocial = "# LinkedIn\n\n## d1\n\nGPT-4o superado.\n\n# Facebook\n\n## d1\n\nGPT-4o foi superado pelo rival.\n";
    const fixture = createFixture({
      newsletterContent: "DESTAQUE 1\n\nO modelo GPT-4o foi comparado.\n",
      socialContent: originalSocial,
      factCheckClaims: [
        {
          verdict: "DIVERGENT",
          claim_type: "number",
          text: "GPT-4o",
          suggested_fix: "GPT-5.4",
          sources: ["newsletter", "social"],
          note: "Fonte compara com GPT-5.4, não GPT-4o",
        } as Partial<FactClaim>,
      ],
    });
    try {
      const result = runCli(fixture.dir);
      assert.equal(result.status, 0, `exit 0 esperado. stderr: ${result.stderr}`);

      // Newsletter deve ter sido corrigida
      const newsletter = readFileSync(fixture.newsletterPath, "utf8");
      assert.ok(newsletter.includes("GPT-5.4"), "newsletter deve ter GPT-5.4 após autofix");
      assert.ok(!newsletter.includes("GPT-4o"), "newsletter não deve mais ter GPT-4o");

      // Social (#3224) TAMBÉM deve ter sido corrigido — em AMBOS os canais (LinkedIn + Facebook)
      const social = readFileSync(fixture.socialPath, "utf8");
      assert.ok(!social.includes("GPT-4o"), "03-social.md não deve mais ter GPT-4o (LinkedIn + Facebook)");
      const gpt54Count = (social.match(/GPT-5\.4/g) ?? []).length;
      assert.equal(gpt54Count, 2, "GPT-5.4 deve aparecer 2x — 1 em LinkedIn ## d1, 1 em Facebook ## d1");

      // Sentinel do humanizador deve ter sido regravado com bypass explícito (#2529 reusado)
      const sentinelPath = join(fixture.dir, "_internal", ".humanizer-social-done.json");
      assert.ok(existsSync(sentinelPath), "sentinel deve ter sido gravado");
      const sentinel = JSON.parse(readFileSync(sentinelPath, "utf8"));
      assert.ok(sentinel.bypass_reason?.includes("factcheck-autofix"), "bypass_reason deve identificar a origem factcheck-autofix");
      const check = checkSentinel(fixture.dir);
      assert.equal(check.ok, true, "checkSentinel deve confirmar que o sentinel bate com o social JÁ CORRIGIDO");

      // Verificar fact-check-autofix.json
      assert.ok(existsSync(fixture.autofixPath), "fact-check-autofix.json deve existir");
      const autofix = JSON.parse(readFileSync(fixture.autofixPath, "utf8"));
      assert.equal(autofix.summary.applied, 1, "1 claim aplicado (independente de quantos arquivos tocou)");
      assert.equal(autofix.entries[0].status, "applied");
      assert.equal(autofix.entries[0].text, "GPT-4o");
      assert.equal(autofix.entries[0].suggested_fix, "GPT-5.4");
      assert.deepEqual(autofix.entries[0].files_modified, ["newsletter", "social"], "files_modified = newsletter + social");
      assert.equal(autofix.social_modified, true, "social_modified deve sinalizar pro orchestrator re-renderizar o preview");
      assert.ok(autofix.social_sentinel_bypass_reason, "social_sentinel_bypass_reason deve estar presente");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("(#3224) sources newsletter+social mas texto só existe na newsletter → sucesso parcial (newsletter corrigida, social intocado)", () => {
    const originalSocial = "# LinkedIn\n\n## d1\n\nO novo modelo superou a concorrência.\n";
    const fixture = createFixture({
      newsletterContent: "DESTAQUE 1\n\nO modelo GPT-4o foi comparado.\n",
      socialContent: originalSocial,
      factCheckClaims: [
        {
          verdict: "DIVERGENT",
          claim_type: "number",
          text: "GPT-4o",
          suggested_fix: "GPT-5.4",
          sources: ["newsletter", "social"],
        } as Partial<FactClaim>,
      ],
    });
    try {
      const result = runCli(fixture.dir);
      assert.equal(result.status, 0, `exit 0. stderr: ${result.stderr}`);

      const newsletter = readFileSync(fixture.newsletterPath, "utf8");
      assert.ok(newsletter.includes("GPT-5.4"), "newsletter deve ter sido corrigida");

      // Social não continha o texto — permanece intocado, sentinel NÃO regravado
      const social = readFileSync(fixture.socialPath, "utf8");
      assert.equal(social, originalSocial, "social sem o texto-alvo não deve ser alterado");
      const sentinelPath = join(fixture.dir, "_internal", ".humanizer-social-done.json");
      assert.ok(!existsSync(sentinelPath), "sentinel não deve ser gravado quando social não foi modificado");

      const autofix = JSON.parse(readFileSync(fixture.autofixPath, "utf8"));
      assert.equal(autofix.entries[0].status, "applied", "aplicado (sucesso parcial via newsletter) — não é skip");
      assert.deepEqual(autofix.entries[0].files_modified, ["newsletter"], "só newsletter foi de fato modificada");
      assert.ok(autofix.entries[0].note?.includes("03-social.md"), "note deve explicar que social não foi encontrado");
      assert.equal(autofix.social_modified, false, "social_modified deve ser false — nada foi escrito em 03-social.md");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("NOT_FOUND_IN_SOURCE (superlativo) não é auto-corrigido", () => {
    const fixture = createFixture({
      newsletterContent: "DESTAQUE 2\n\nPela primeira vez uma operadora distribui IA.\n",
      socialContent: "# LinkedIn\n\n## d2\n\nPrimeira operadora com IA.\n",
      factCheckClaims: [
        {
          verdict: "NOT_FOUND_IN_SOURCE",
          claim_type: "superlative",
          text: "primeira vez",
          suggested_fix: undefined, // fact-checker não emite fix pra NOT_FOUND
          sources: ["newsletter", "social"],
          destaque: 2,
        } as Partial<FactClaim>,
      ],
    });
    try {
      const result = runCli(fixture.dir);
      assert.equal(result.status, 0, `exit 0. stderr: ${result.stderr}`);

      // Arquivos não devem ter sido modificados
      const newsletter = readFileSync(fixture.newsletterPath, "utf8");
      assert.ok(newsletter.includes("primeira vez"), "NOT_FOUND_IN_SOURCE não deve ser alterado");

      const autofix = JSON.parse(readFileSync(fixture.autofixPath, "utf8"));
      assert.equal(autofix.summary.applied, 0, "nenhuma correção aplicada para NOT_FOUND_IN_SOURCE");
      assert.equal(autofix.summary.total_divergent, 0, "NOT_FOUND_IN_SOURCE não entra em total_divergent");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("intentional_error no destaque 1 → claim DIVERGENT do D1 é pulado (#3222: via _internal/intentional-error.json)", () => {
    const newsletterContent = [
      "DESTAQUE 1",
      "",
      "O modelo GPT-4o foi comparado com o novo lançamento.",
      "",
    ].join("\n");

    const fixture = createFixture({
      newsletterContent,
      intentionalErrorRecord: {
        description: "GPT-4o onde deveria ser GPT-5.4 (erro intencional)",
        location: "DESTAQUE 1, corpo",
        category: "version_inconsistency",
        correct_value: "GPT-5.4",
      },
      factCheckClaims: [
        {
          verdict: "DIVERGENT",
          claim_type: "number",
          destaque: 1,
          text: "GPT-4o",
          suggested_fix: "GPT-5.4",
          sources: ["newsletter"],
        } as Partial<FactClaim>,
      ],
    });
    try {
      const result = runCli(fixture.dir);
      assert.equal(result.status, 0, `exit 0. stderr: ${result.stderr}`);

      // Newsletter NÃO deve ter sido modificada — o erro intencional deve ser preservado
      const newsletter = readFileSync(fixture.newsletterPath, "utf8");
      assert.ok(newsletter.includes("GPT-4o"), "GPT-4o deve permanecer no corpo (é o erro intencional)");
      assert.ok(!newsletter.includes("GPT-5.4"), "GPT-5.4 não deve aparecer no corpo — substituição não aplicada");

      const autofix = JSON.parse(readFileSync(fixture.autofixPath, "utf8"));
      assert.equal(autofix.summary.applied, 0, "nenhuma correção aplicada quando é erro intencional");
      assert.equal(autofix.entries[0].status, "skipped_intentional_error");
      assert.ok(autofix.intentional_error_destaque === 1, "deve registrar o destaque do erro intencional");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("--dry-run não modifica arquivos mas grava fact-check-autofix.json", () => {
    const originalContent = "DESTAQUE 1\n\nO modelo GPT-4o foi comparado.\n";
    const fixture = createFixture({
      newsletterContent: originalContent,
      factCheckClaims: [
        {
          verdict: "DIVERGENT",
          claim_type: "number",
          text: "GPT-4o",
          suggested_fix: "GPT-5.4",
          sources: ["newsletter"],
        } as Partial<FactClaim>,
      ],
    });
    try {
      const result = runCli(fixture.dir, ["--dry-run"]);
      assert.equal(result.status, 0, `exit 0. stderr: ${result.stderr}`);

      // Arquivo não deve ter sido modificado
      const newsletter = readFileSync(fixture.newsletterPath, "utf8");
      assert.equal(newsletter, originalContent, "dry-run não deve modificar arquivos");

      // Mas o JSON deve ter sido gravado
      assert.ok(existsSync(fixture.autofixPath), "fact-check-autofix.json deve existir em dry-run");
      const autofix = JSON.parse(readFileSync(fixture.autofixPath, "utf8"));
      assert.equal(autofix.dry_run, true, "dry_run deve ser true");
      assert.equal(autofix.summary.applied, 1, "dry-run conta correção como aplicada (plano)");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("DIVERGENT sem suggested_fix → skipped_no_fix, arquivo intacto", () => {
    const originalContent = "DESTAQUE 1\n\nO modelo GPT-4o foi comparado.\n";
    const fixture = createFixture({
      newsletterContent: originalContent,
      factCheckClaims: [
        {
          verdict: "DIVERGENT",
          claim_type: "number",
          text: "GPT-4o",
          suggested_fix: undefined, // sem suggested_fix
          sources: ["newsletter"],
        } as Partial<FactClaim>,
      ],
    });
    try {
      const result = runCli(fixture.dir);
      assert.equal(result.status, 0);

      const newsletter = readFileSync(fixture.newsletterPath, "utf8");
      assert.equal(newsletter, originalContent, "sem suggested_fix não deve modificar");

      const autofix = JSON.parse(readFileSync(fixture.autofixPath, "utf8"));
      assert.equal(autofix.summary.applied, 0);
      assert.equal(autofix.entries[0].status, "skipped_no_fix");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("falha com exit 1 se fact-check.json não existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "factcheck-autofix-missing-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), "DESTAQUE 1\n\nTexto.\n", "utf8");
    writeFileSync(join(dir, "03-social.md"), "# LinkedIn\n\n## d1\nPost.\n", "utf8");
    // fact-check.json ausente
    try {
      const result = runCli(dir);
      assert.equal(result.status, 1, "deve falhar com exit 1 quando fact-check.json ausente");
      assert.ok(result.stderr.includes("fact-check.json"), "stderr deve mencionar o arquivo ausente");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Gate presentation — autofix no bloco do gate
// ---------------------------------------------------------------------------

describe("autofix gate presentation helpers (#2598)", () => {
  it("planAutofixes retorna entries só para DIVERGENT (exclui SUSTAINED, SOURCE_UNREACHABLE)", () => {
    const claims = [
      makeClaim({ verdict: "DIVERGENT", text: "GPT-4o", suggested_fix: "GPT-5.4", sources: ["newsletter"] }),
      makeClaim({ verdict: "SUSTAINED", text: "R$ 99", sources: ["newsletter"] }),
      makeClaim({ verdict: "SOURCE_UNREACHABLE", text: "primeiro", claim_type: "superlative", sources: ["social"] }),
      makeClaim({ verdict: "INFERRED", text: "~R$ 25", sources: ["newsletter"] }),
    ];
    const entries = planAutofixes(claims, null);
    // Só o DIVERGENT deve entrar
    assert.equal(entries.length, 1, "só claims DIVERGENT entram em planAutofixes");
    assert.equal(entries[0].text, "GPT-4o");
    assert.equal(entries[0].status, "applied");
  });
});

// ---------------------------------------------------------------------------
// findDestaqueBodyRange
// ---------------------------------------------------------------------------

describe("findDestaqueBodyRange (#2617)", () => {
  it("retorna null quando destaque não existe no conteúdo", () => {
    const content = "Sem destaque aqui.\n";
    assert.equal(findDestaqueBodyRange(content, 1), null);
  });

  it("encontra range do DESTAQUE 1 excluindo frontmatter", () => {
    const content = [
      "---",
      "correct_value: GPT-5.4",
      "---",
      "",
      "DESTAQUE 1",
      "",
      "Texto do destaque um.",
      "",
      "DESTAQUE 2",
      "",
      "Texto do destaque dois.",
    ].join("\n");
    const range = findDestaqueBodyRange(content, 1);
    assert.ok(range !== null, "deve encontrar DESTAQUE 1");
    const block = content.slice(range.start, range.end);
    assert.ok(block.includes("Texto do destaque um"), "bloco deve conter texto do D1");
    assert.ok(!block.includes("Texto do destaque dois"), "bloco NÃO deve conter texto do D2");
    assert.ok(!block.includes("correct_value"), "bloco NÃO deve incluir frontmatter");
  });

  it("encontra range do DESTAQUE 2 corretamente", () => {
    const content = [
      "DESTAQUE 1",
      "",
      "Valor errado GPT-4o aqui.",
      "",
      "DESTAQUE 2",
      "",
      "Outro GPT-4o aqui.",
    ].join("\n");
    const range = findDestaqueBodyRange(content, 2);
    assert.ok(range !== null);
    const block = content.slice(range.start, range.end);
    assert.ok(block.includes("Outro GPT-4o aqui"), "deve conter o texto do D2");
    assert.ok(!block.includes("Valor errado GPT-4o aqui"), "NÃO deve conter texto do D1");
  });
});

// ---------------------------------------------------------------------------
// Cenário 13 (#3224): findSocialDestaqueRanges / applySocialTextSubstitution
// ---------------------------------------------------------------------------

describe("findSocialDestaqueRanges (#3224)", () => {
  it("retorna [] quando o destaque não aparece no arquivo", () => {
    const content = "# LinkedIn\n\n## d2\n\nTexto do d2.\n";
    assert.deepEqual(findSocialDestaqueRanges(content, 1), []);
  });

  it("encontra 1 range quando o destaque só aparece em 1 canal", () => {
    const content = "# LinkedIn\n\n## d1\n\nGPT-4o superado.\n\n## d2\n\nOutro texto.\n";
    const ranges = findSocialDestaqueRanges(content, 1);
    assert.equal(ranges.length, 1);
    const block = content.slice(ranges[0].start, ranges[0].end);
    assert.ok(block.includes("GPT-4o superado"));
    assert.ok(!block.includes("Outro texto"), "não deve engolir o próximo header ## d2");
  });

  it("encontra 3 ranges quando o destaque=1 aparece em LinkedIn E Facebook (## d1 LinkedIn + ## post_pixel + ## d1 Facebook, #3274)", () => {
    const content = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "GPT-4o no LinkedIn.",
      "",
      "## post_pixel",
      "",
      "Post pessoal sem GPT-4o aqui.",
      "",
      "# Facebook",
      "",
      "## d1",
      "",
      "GPT-4o no Facebook.",
    ].join("\n");
    const ranges = findSocialDestaqueRanges(content, 1);
    // #3274: post_pixel é seção IRMÃ de ## d1 (fecha o range de d1, como antes),
    // mas também é aberta como range-alvo próprio quando destaque=1 — daí 3
    // ranges, não 2 (## d1 LinkedIn, ## post_pixel, ## d1 Facebook).
    assert.equal(ranges.length, 3, "deve achar o ## d1 do LinkedIn, o ## post_pixel E o ## d1 do Facebook");
    const block0 = content.slice(ranges[0].start, ranges[0].end);
    const block1 = content.slice(ranges[1].start, ranges[1].end);
    const block2 = content.slice(ranges[2].start, ranges[2].end);
    assert.ok(block0.includes("GPT-4o no LinkedIn"));
    assert.ok(!block0.includes("post_pixel") && !block0.includes("Post pessoal"), "range do d1 continua não incluindo post_pixel (scoping preservado)");
    assert.ok(block1.includes("## post_pixel") && block1.includes("Post pessoal sem GPT-4o aqui"), "post_pixel agora é range-alvo próprio");
    assert.ok(block2.includes("GPT-4o no Facebook"));
  });

  it("### comment_diaria / ### comment_pixel (3 hashes) ficam DENTRO do bloco — não fecham", () => {
    const content = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "GPT-4o no main.",
      "",
      "### comment_diaria",
      "",
      "GPT-4o no comment também.",
      "",
      "## d2",
      "",
      "Outro destaque.",
    ].join("\n");
    const ranges = findSocialDestaqueRanges(content, 1);
    assert.equal(ranges.length, 1);
    const block = content.slice(ranges[0].start, ranges[0].end);
    assert.ok(block.includes("GPT-4o no comment também"), "comment_diaria deve estar dentro do range do d1");
    assert.ok(!block.includes("Outro destaque"));
  });
});

describe("applySocialTextSubstitution (#3224)", () => {
  it("substitui em AMBOS os canais quando o texto aparece nos dois", () => {
    const content = "# LinkedIn\n\n## d1\n\nGPT-4o superado.\n\n# Facebook\n\n## d1\n\nGPT-4o venceu o mercado.\n";
    const result = applySocialTextSubstitution(content, 1, "GPT-4o", "GPT-5.4");
    assert.equal(result.changed, true);
    assert.equal(result.modifiedRanges, 2);
    assert.ok(!result.content.includes("GPT-4o"));
    assert.equal((result.content.match(/GPT-5\.4/g) ?? []).length, 2);
  });

  it("substitui em apenas 1 canal quando o outro não menciona o texto", () => {
    const content = "# LinkedIn\n\n## d1\n\nGPT-4o superado.\n\n# Facebook\n\n## d1\n\nO rival venceu o mercado.\n";
    const result = applySocialTextSubstitution(content, 1, "GPT-4o", "GPT-5.4");
    assert.equal(result.changed, true);
    assert.equal(result.modifiedRanges, 1);
    assert.ok(result.content.includes("GPT-5.4"));
    assert.ok(result.content.includes("O rival venceu o mercado"));
  });

  it("changed=false quando o destaque não existe ou o texto não é encontrado", () => {
    const content = "# LinkedIn\n\n## d1\n\nSem o claim aqui.\n";
    const result = applySocialTextSubstitution(content, 1, "GPT-4o", "GPT-5.4");
    assert.equal(result.changed, false);
    assert.equal(result.content, content);
  });

  it("não vaza correção pro bloco de outro destaque com o mesmo texto (scoped)", () => {
    const content = "# LinkedIn\n\n## d1\n\nProtegido: GPT-4o.\n\n## d2\n\nGPT-4o aqui.\n";
    const result = applySocialTextSubstitution(content, 2, "GPT-4o", "GPT-5.4");
    assert.equal(result.changed, true);
    assert.equal(result.modifiedRanges, 1);
    assert.ok(result.content.includes("Protegido: GPT-4o."), "d1 não deve ser tocado ao corrigir d2");
    assert.ok(result.content.includes("GPT-5.4 aqui"));
  });
});

// ---------------------------------------------------------------------------
// Regressão #3274: `## post_pixel` nunca era alvo de correção
// ---------------------------------------------------------------------------

describe("regressao #3274: findSocialDestaqueRanges abre ## post_pixel para destaque=1", () => {
  it("abre um range próprio para ## post_pixel quando destaque=1", () => {
    const content = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "GPT-4o no main.",
      "",
      "## post_pixel",
      "",
      "<!-- destaque: d1 -->",
      "",
      "GPT-4o no post pessoal também.",
    ].join("\n");
    const ranges = findSocialDestaqueRanges(content, 1);
    // Antes do fix: 1 range (só ## d1) — post_pixel fechava o range de d1 mas
    // nunca era aberto como alvo. Depois: 2 ranges (## d1 + ## post_pixel).
    assert.equal(ranges.length, 2, "## post_pixel deve virar um 2º range-alvo para destaque=1");
    const block0 = content.slice(ranges[0].start, ranges[0].end);
    const block1 = content.slice(ranges[1].start, ranges[1].end);
    assert.ok(block0.includes("GPT-4o no main"));
    assert.ok(!block0.includes("post_pixel"), "range de ## d1 continua não incluindo post_pixel");
    assert.ok(block1.includes("## post_pixel"));
    assert.ok(block1.includes("GPT-4o no post pessoal também"));
  });

  it("NÃO abre ## post_pixel como alvo para destaque=2 ou 3 (post_pixel é sempre D1)", () => {
    const content = [
      "# LinkedIn",
      "",
      "## d2",
      "",
      "Texto do d2.",
      "",
      "## post_pixel",
      "",
      "<!-- destaque: d1 -->",
      "",
      "Texto do post pessoal (sempre sobre D1).",
    ].join("\n");
    const ranges = findSocialDestaqueRanges(content, 2);
    assert.equal(ranges.length, 1, "post_pixel não é alvo de correção pra destaques diferentes de 1");
    const block = content.slice(ranges[0].start, ranges[0].end);
    assert.ok(!block.includes("post_pixel"));
  });

  it("applySocialTextSubstitution corrige a claim tanto em ## d1 quanto em ## post_pixel", () => {
    const content = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "GPT-4o superou o mercado.",
      "",
      "## post_pixel",
      "",
      "<!-- destaque: d1 -->",
      "",
      "O que me chamou atenção foi o GPT-4o superando expectativas.",
    ].join("\n");
    const result = applySocialTextSubstitution(content, 1, "GPT-4o", "GPT-5.4");
    assert.equal(result.changed, true);
    assert.equal(result.modifiedRanges, 2, "deve corrigir tanto ## d1 quanto ## post_pixel");
    assert.ok(!result.content.includes("GPT-4o"), "nenhuma ocorrência de GPT-4o deve sobrar");
    assert.equal((result.content.match(/GPT-5\.4/g) ?? []).length, 2);
  });
});

// ---------------------------------------------------------------------------
// Regressão #3275: applyTextSubstitution (scoped) só corrigia a 1ª ocorrência
// ---------------------------------------------------------------------------

describe("regressao #3275: applyTextSubstitution (scoped) substitui TODAS as ocorrências", () => {
  it("corrige a claim tanto no corpo principal quanto em ### comment_pixel aninhado", () => {
    const content = [
      "## d1",
      "",
      "GPT-4o superou o mercado no corpo principal.",
      "",
      "### comment_pixel",
      "",
      "Reforçando: o GPT-4o também aparece aqui, com outro framing.",
      "",
      "## d2",
      "",
      "Outro destaque, sem relação.",
    ].join("\n");
    const scope = { start: 0, end: content.indexOf("## d2") };
    const result = applyTextSubstitution(content, "GPT-4o", "GPT-5.4", scope);
    assert.equal(result.changed, true);
    assert.ok(!result.content.slice(0, result.content.indexOf("## d2")).includes("GPT-4o"),
      "nenhuma ocorrência de GPT-4o deve sobrar dentro do range de d1 (corpo + comment_pixel)");
    assert.equal((result.content.match(/GPT-5\.4/g) ?? []).length, 2, "as 2 ocorrências devem ter sido corrigidas");
    assert.ok(result.content.includes("Outro destaque, sem relação."), "range de d2 não deve ser tocado");
  });

  it("preserva o comportamento legado (só 1ª ocorrência) quando scope é omitido", () => {
    // Cobertura de não-regressão do comportamento já testado em
    // "applyTextSubstitution (#2598)" > "substitui apenas a primeira ocorrência" —
    // reafirma aqui explicitamente que o fix do #3275 é scoped-only.
    const result = applyTextSubstitution("GPT-4o vs GPT-4o", "GPT-4o", "GPT-5.4");
    assert.equal(result.content, "GPT-5.4 vs GPT-4o");
  });

  it("applySocialTextSubstitution corrige múltiplas ocorrências dentro de UM range E ajusta corretamente o offset do range seguinte (LinkedIn + Facebook)", () => {
    const content = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "GPT-4o no corpo.",
      "",
      "### comment_pixel",
      "",
      "GPT-4o de novo, framing diferente.",
      "",
      "# Facebook",
      "",
      "## d1",
      "",
      "GPT-4o no Facebook, sem duplicata aqui.",
    ].join("\n");
    const result = applySocialTextSubstitution(content, 1, "GPT-4o", "modelo mais recente");
    assert.equal(result.changed, true);
    assert.equal(result.modifiedRanges, 2, "LinkedIn (2 ocorrências) + Facebook (1 ocorrência) — 2 ranges tocados");
    assert.ok(!result.content.includes("GPT-4o"), "nenhuma ocorrência deve sobrar em nenhum canal");
    assert.equal(
      (result.content.match(/modelo mais recente/g) ?? []).length,
      3,
      "2 no range do LinkedIn (corpo + comment_pixel) + 1 no Facebook",
    );
    assert.ok(result.content.includes("# Facebook"), "boundary do Facebook deve permanecer intacto (offset ajustado corretamente)");
  });
});

// ---------------------------------------------------------------------------
// Cenário 8: Multi-DIVERGENT — mesmo texto em destaques diferentes
// ---------------------------------------------------------------------------

describe("apply-factcheck-autofix cenário 8 — multi-DIVERGENT com mesmo texto (#2617)", () => {
  it("substitui claim D2 sem clobberar GPT-4o protegido no D1 (intentional_error, #3222 via JSON)", () => {
    const newsletterContent = [
      "DESTAQUE 1",
      "",
      "O modelo GPT-4o foi comparado com o novo lançamento. (erro intencional)",
      "",
      "DESTAQUE 2",
      "",
      "O modelo GPT-4o superou a concorrência.",
      "",
    ].join("\n");

    const fixture = createFixture({
      newsletterContent,
      intentionalErrorRecord: {
        description: "GPT-4o onde deveria ser GPT-5.4",
        location: "DESTAQUE 1, corpo",
        category: "version_inconsistency",
        correct_value: "GPT-5.4",
      },
      factCheckClaims: [
        // D1: claim DIVERGENT — mas pertence ao intentional_error, deve ser pulado
        {
          verdict: "DIVERGENT",
          claim_type: "number",
          destaque: 1,
          text: "GPT-4o",
          suggested_fix: "GPT-5.4",
          sources: ["newsletter"],
        } as Partial<FactClaim>,
        // D2: claim DIVERGENT — deve ser aplicado scoped ao bloco D2
        {
          verdict: "DIVERGENT",
          claim_type: "number",
          destaque: 2,
          text: "GPT-4o",
          suggested_fix: "GPT-5.4",
          sources: ["newsletter"],
        } as Partial<FactClaim>,
      ],
    });
    try {
      const result = runCli(fixture.dir);
      assert.equal(result.status, 0, `exit 0. stderr: ${result.stderr}`);

      const newsletter = readFileSync(fixture.newsletterPath, "utf8");

      // D1: GPT-4o protegido no bloco D1 deve permanecer
      const d1Start = newsletter.indexOf("DESTAQUE 1");
      const d2Start = newsletter.indexOf("DESTAQUE 2");
      assert.ok(d1Start !== -1 && d2Start !== -1, "ambos os blocos devem existir");
      const d1Block = newsletter.slice(d1Start, d2Start);
      const d2Block = newsletter.slice(d2Start);
      assert.ok(d1Block.includes("GPT-4o"), "GPT-4o deve permanecer intacto no D1 (erro intencional)");

      // D2: GPT-4o substituído por GPT-5.4
      assert.ok(!d2Block.includes("GPT-4o"), "GPT-4o deve ter sido substituído no D2");
      assert.ok(d2Block.includes("GPT-5.4"), "D2 deve ter GPT-5.4 após autofix");

      const autofix = JSON.parse(readFileSync(fixture.autofixPath, "utf8"));
      assert.equal(autofix.summary.applied, 1, "apenas 1 correção aplicada (D2)");
      const skippedEntry = autofix.entries.find((e: { status: string }) => e.status === "skipped_intentional_error");
      assert.ok(skippedEntry, "deve ter entry skipped_intentional_error para D1");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cenário 9 (#3224): Claim apenas em social → aplicado, sentinel regravado com bypass
// ---------------------------------------------------------------------------

describe("apply-factcheck-autofix cenário 9 — claim social-only (#3224, antes #2617 skipped)", () => {
  it("claim com sources:['social'] é aplicado em 03-social.md e o sentinel é regravado com bypass", () => {
    const fixture = createFixture({
      newsletterContent: "DESTAQUE 1\n\nTexto sem o claim aqui.\n",
      socialContent: "# LinkedIn\n\n## d1\n\nO GPT-4o foi superado.\n",
      factCheckClaims: [
        {
          verdict: "DIVERGENT",
          claim_type: "number",
          destaque: 1,
          text: "GPT-4o",
          suggested_fix: "GPT-5.4",
          sources: ["social"], // apenas social
        } as Partial<FactClaim>,
      ],
    });
    try {
      const result = runCli(fixture.dir);
      assert.equal(result.status, 0, `exit 0. stderr: ${result.stderr}`);

      // Newsletter (sem o claim) permanece intocada
      const newsletter = readFileSync(fixture.newsletterPath, "utf8");
      assert.ok(!newsletter.includes("GPT-5.4"), "newsletter não tinha o claim — não deve ser tocada");

      // Social DEVE ter sido corrigido (#3224)
      const social = readFileSync(fixture.socialPath, "utf8");
      assert.ok(social.includes("GPT-5.4"), "03-social.md deve ter GPT-5.4 após autofix");
      assert.ok(!social.includes("GPT-4o"), "03-social.md não deve mais ter GPT-4o");

      // Sentinel do humanizador regravado com bypass (mecanismo #2529 reusado)
      const sentinelPath = join(fixture.dir, "_internal", ".humanizer-social-done.json");
      const sentinel = JSON.parse(readFileSync(sentinelPath, "utf8"));
      assert.ok(sentinel.bypass_reason, "sentinel deve ter bypass_reason gravado");
      assert.equal(checkSentinel(fixture.dir).ok, true, "checkSentinel deve confirmar hash pós-correção");

      const autofix = JSON.parse(readFileSync(fixture.autofixPath, "utf8"));
      assert.equal(autofix.summary.applied, 1, "1 correção aplicada (social)");
      assert.equal(autofix.entries[0].status, "applied");
      assert.deepEqual(autofix.entries[0].files_modified, ["social"]);
      assert.equal(autofix.social_modified, true);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("claim social-only sem o texto no arquivo → skipped_text_not_found, sentinel não tocado", () => {
    const fixture = createFixture({
      newsletterContent: "DESTAQUE 1\n\nTexto sem o claim aqui.\n",
      socialContent: "# LinkedIn\n\n## d1\n\nConteúdo que não menciona o modelo.\n",
      factCheckClaims: [
        {
          verdict: "DIVERGENT",
          claim_type: "number",
          destaque: 1,
          text: "GPT-4o",
          suggested_fix: "GPT-5.4",
          sources: ["social"],
        } as Partial<FactClaim>,
      ],
    });
    const originalSocial = readFileSync(fixture.socialPath, "utf8");
    try {
      const result = runCli(fixture.dir);
      assert.equal(result.status, 0, `exit 0. stderr: ${result.stderr}`);

      const social = readFileSync(fixture.socialPath, "utf8");
      assert.equal(social, originalSocial, "social sem o texto-alvo não deve ser alterado");

      const sentinelPath = join(fixture.dir, "_internal", ".humanizer-social-done.json");
      assert.ok(!existsSync(sentinelPath), "sentinel não deve ser gravado quando nada foi corrigido");

      const autofix = JSON.parse(readFileSync(fixture.autofixPath, "utf8"));
      assert.equal(autofix.summary.applied, 0, "nenhuma correção aplicada");
      assert.equal(autofix.entries[0].status, "skipped_text_not_found");
      assert.equal(autofix.social_modified, false);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it("(#3224) sentinel PRÉ-EXISTENTE (pós-humanizador) é regravado com bypass_reason e passa a bater com o novo hash", () => {
    const fixture = createFixture({
      newsletterContent: "DESTAQUE 1\n\nTexto sem o claim aqui.\n",
      socialContent: "# LinkedIn\n\n## d1\n\nO GPT-4o foi superado.\n",
      factCheckClaims: [
        {
          verdict: "DIVERGENT",
          claim_type: "number",
          destaque: 1,
          text: "GPT-4o",
          suggested_fix: "GPT-5.4",
          sources: ["social"],
        } as Partial<FactClaim>,
      ],
    });
    try {
      // Simula o humanizador já tendo rodado no Stage 2 e gravado o sentinel
      // ANTES do autofix (§4c.2b já validou --check exit 0 nesse ponto do pipeline real).
      writeSentinel(fixture.dir);
      const preSentinel = JSON.parse(
        readFileSync(join(fixture.dir, "_internal", ".humanizer-social-done.json"), "utf8"),
      );
      assert.equal(preSentinel.bypass_reason, undefined, "sentinel inicial (1ª escrita) não precisa de bypass_reason");
      assert.equal(checkSentinel(fixture.dir).ok, true, "sentinel inicial deve bater com o social ainda não corrigido");

      const result = runCli(fixture.dir);
      assert.equal(result.status, 0, `exit 0. stderr: ${result.stderr}`);

      const postSentinel = JSON.parse(
        readFileSync(join(fixture.dir, "_internal", ".humanizer-social-done.json"), "utf8"),
      );
      assert.notEqual(postSentinel.social_sha256, preSentinel.social_sha256, "hash deve mudar — social foi corrigido");
      assert.ok(postSentinel.bypass_reason?.includes("factcheck-autofix"), "regravação deve carregar bypass_reason");
      assert.equal(checkSentinel(fixture.dir).ok, true, "sentinel regravado deve bater com o social JÁ CORRIGIDO");
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cenário 10: Dry-run registra files_modified no plano
// ---------------------------------------------------------------------------

describe("apply-factcheck-autofix cenário 10 — dry-run files_modified (#2617)", () => {
  it("dry-run popula files_modified sem escrever em disco", () => {
    const originalContent = "DESTAQUE 1\n\nO modelo GPT-4o foi comparado.\n";
    const fixture = createFixture({
      newsletterContent: originalContent,
      factCheckClaims: [
        {
          verdict: "DIVERGENT",
          claim_type: "number",
          text: "GPT-4o",
          suggested_fix: "GPT-5.4",
          sources: ["newsletter"],
        } as Partial<FactClaim>,
      ],
    });
    try {
      const result = runCli(fixture.dir, ["--dry-run"]);
      assert.equal(result.status, 0, `exit 0. stderr: ${result.stderr}`);

      // Arquivo não modificado em disco
      assert.equal(readFileSync(fixture.newsletterPath, "utf8"), originalContent, "dry-run não escreve em disco");

      const autofix = JSON.parse(readFileSync(fixture.autofixPath, "utf8"));
      assert.equal(autofix.dry_run, true);
      assert.equal(autofix.summary.applied, 1);
      // files_modified deve estar populado mesmo em dry-run (mostra o plano)
      assert.ok(
        Array.isArray(autofix.entries[0].files_modified) && autofix.entries[0].files_modified.length > 0,
        "dry-run deve popular files_modified para mostrar o que seria modificado",
      );
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// planAutofixes — guard order: intentional_error antes de no_fix
// ---------------------------------------------------------------------------

describe("planAutofixes guard order (#2617)", () => {
  it("claim no destaque do intentional_error sem suggested_fix → skipped_intentional_error (não skipped_no_fix)", () => {
    const claim = makeClaim({
      verdict: "DIVERGENT",
      destaque: 1,
      text: "GPT-4o",
      suggested_fix: undefined, // sem fix
      sources: ["newsletter"],
    });
    // intentional_error no destaque 1 — deve vencer o check de no_fix
    const entries = planAutofixes([claim], 1);
    assert.equal(entries[0].status, "skipped_intentional_error", "motivo correto: intentional_error, não no_fix");
  });

  it("texto vazio → skipped_no_fix", () => {
    const claim = makeClaim({
      verdict: "DIVERGENT",
      text: "",
      suggested_fix: "GPT-5.4",
      sources: ["newsletter"],
    });
    const entries = planAutofixes([claim], null);
    assert.equal(entries[0].status, "skipped_no_fix");
  });

  it("suggested_fix whitespace-only → skipped_no_fix (não aplica string em branco)", () => {
    const claim = makeClaim({
      verdict: "DIVERGENT",
      text: "GPT-4o",
      suggested_fix: "   ",
      sources: ["newsletter"],
    });
    const entries = planAutofixes([claim], null);
    assert.equal(entries[0].status, "skipped_no_fix");
  });
});

// ─── #2628 gap 1: findDestaqueBodyRange sem linha em branco entre DESTAQUEs ────

describe("regressao #2628 gap1: findDestaqueBodyRange — DESTAQUEs adjacentes", () => {
  it("D1 nao engloba D2 quando nao ha linha em branco entre eles", () => {
    const content = [
      "DESTAQUE 1",
      "Texto do primeiro destaque com claim X.",
      "DESTAQUE 2",
      "Texto do segundo destaque com claim X.",
    ].join("\n");
    const rangeD1 = findDestaqueBodyRange(content, 1);
    const rangeD2 = findDestaqueBodyRange(content, 2);
    assert.ok(rangeD1 !== null, "range D1 deve existir");
    assert.ok(rangeD2 !== null, "range D2 deve existir");
    // D1 nao deve se estender alem do inicio de D2
    assert.ok(rangeD1!.end <= rangeD2!.start, `D1.end (${rangeD1!.end}) deve ser <= D2.start (${rangeD2!.start})`);
    // Texto de D2 nao deve aparecer no slice do range D1
    const d1Block = content.slice(rangeD1!.start, rangeD1!.end);
    assert.ok(!d1Block.includes("segundo destaque"), "bloco D1 nao deve conter texto de D2");
  });

  it("D1 SEM corpo (D2 imediatamente apos) — range D1 exclui D2 (trigger real do bug)", () => {
    // Cenário que de fato dispara o bug: D1 sem corpo, D2 na linha seguinte.
    // afterStart começa direto com "DESTAQUE 2" (sem \n antes) → o regex antigo
    // /\nDESTAQUE/ não casava → blockEnd=EOF → range D1 englobava D2.
    // O regex novo /^DESTAQUE/im (ancorado em início de linha) casa mesmo sem \n
    // de separação. Este teste FALHA contra o código antigo e passa com o fix.
    const content = "DESTAQUE 1\nDESTAQUE 2\nTexto do segundo destaque com claim X.";
    const rangeD1 = findDestaqueBodyRange(content, 1);
    const rangeD2 = findDestaqueBodyRange(content, 2);
    assert.ok(rangeD1 !== null, "range D1 deve existir");
    assert.ok(rangeD2 !== null, "range D2 deve existir");
    assert.ok(rangeD1!.end <= rangeD2!.start, `D1.end (${rangeD1!.end}) deve ser <= D2.start (${rangeD2!.start})`);
    const d1Block = content.slice(rangeD1!.start, rangeD1!.end);
    assert.ok(!d1Block.includes("DESTAQUE 2"), "bloco D1 nao deve conter o marcador DESTAQUE 2");
    assert.ok(!d1Block.includes("segundo destaque"), "bloco D1 nao deve conter texto de D2");
  });

  it("substituicao em D1 nao toca D2 com claim identico em ambos", () => {
    const content = [
      "DESTAQUE 1",
      "A empresa tem claim identico aqui.",
      "DESTAQUE 2",
      "A empresa tem claim identico aqui.",
    ].join("\n");
    // Simular substituicao dentro de D1 apenas
    const rangeD1 = findDestaqueBodyRange(content, 1);
    assert.ok(rangeD1 !== null, "range D1 deve existir");
    const block = content.slice(rangeD1!.start, rangeD1!.end);
    assert.ok(block.includes("claim identico"), "bloco D1 deve conter o claim");
    // Verificar que D2 nao esta incluso no range D1
    assert.ok(!block.includes("DESTAQUE 2"), "bloco D1 nao deve conter o marcador DESTAQUE 2");
  });
});

// ─── #2628 gap 2: TypeError quando sources ausente no claim ──────────────────

describe("regressao #2628 gap2: applyFactcheckAutofix — claim DIVERGENT sem campo sources", () => {
  it("nao crasha (TypeError) quando fact-checker omite campo sources", () => {
    // Simula o cenário real: o fact-checker emite um claim sem o campo "sources"
    // (ex: modelo que não segue o schema completamente). Antes do fix, isso causava
    // TypeError: Cannot read properties of undefined (reading 'includes') no loop principal.
    const dir = mkdtempSync(join(tmpdir(), "factcheck-gap2-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });

    writeFileSync(join(dir, "02-reviewed.md"), "DESTAQUE 1\n\nO modelo GPT-4 foi usado.\n", "utf8");
    writeFileSync(join(dir, "03-social.md"), "## d1\n\nSocial content.\n", "utf8");
    writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify({ highlights: [] }), "utf8");

    // Claim DIVERGENT sem campo "sources" — simula saída de fact-checker incompleto
    const factCheck = {
      edition: "260626",
      checked_at: new Date().toISOString(),
      claims: [
        {
          verdict: "DIVERGENT",
          claim_type: "number",
          destaque: 1,
          text: "GPT-4",
          suggested_fix: "GPT-5",
          context: "O modelo GPT-4 foi usado.",
          // sources campo omitido propositalmente
        },
      ],
      summary: { total: 1, sustained: 0, divergent: 1, not_found_in_source: 0, source_unreachable: 0, inferred: 0, attention_items: 0 },
    };
    writeFileSync(join(internalDir, "fact-check.json"), JSON.stringify(factCheck), "utf8");

    try {
      const projectRoot = join(import.meta.dirname, "..");
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", join(projectRoot, "scripts", "apply-factcheck-autofix.ts"), "--edition-dir", dir],
        { encoding: "utf8", timeout: 30_000 },
      );
      // Antes do fix: exit code 1 com "TypeError: Cannot read properties of undefined (reading 'includes')"
      // Apos o fix: exit code 0, claim tratado como sem-newsletter (skipped)
      assert.ok(
        !result.stderr.includes("TypeError"),
        `nao deve lancar TypeError. stderr: ${result.stderr}`
      );
      assert.equal(result.status, 0, `exit code 0 esperado. stderr: ${result.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── #2634: edge-case texto "DESTAQUE N ..." no corpo do destaque ────────────

describe("regressao #2634: findDestaqueBodyRange — texto DESTAQUE N no corpo nao corta range", () => {
  it("linha iniciando com 'DESTAQUE N texto...' no corpo NAO corta o range prematuramente", () => {
    // Edge-case: corpo do DESTAQUE 1 contem uma linha que comeca com "DESTAQUE 2 foi coberto..."
    // O regex antigo /^DESTAQUE\s+\d+/im casava essa linha e cortava o range do D1 cedo,
    // excluindo todo o texto abaixo dela.
    // Com o fix (#2634), exige-se DESTAQUE N seguido de \s*\| (pipe) ou \s*$ (fim de linha),
    // entao "DESTAQUE 2 foi coberto..." (seguido de " foi", nao de "|" nem de EOL) eh pulado.
    // Nota: markerRe (para encontrar o INICIO de um destaque) nao e alterado neste fix —
    // apenas nextMatch (para encontrar o FIM do bloco atual) e corrigido. Por isso, nao
    // testamos a relacao entre rangeD1.end e rangeD2.start (que usa o markerRe nao corrigido).
    // Testamos apenas que o CONTEUDO do bloco D1 inclui o texto que estava sendo perdido.
    const content = [
      "DESTAQUE 1 | MERCADO",
      "",
      "DESTAQUE 2 foi amplamente coberto pela midia especializada.",
      "",
      "Mais texto do D1 com claim-alvo aqui.",
      "",
      "DESTAQUE 2 | PRODUTO",
      "",
      "Texto do D2.",
    ].join("\n");

    const rangeD1 = findDestaqueBodyRange(content, 1);

    assert.ok(rangeD1 !== null, "range D1 deve existir");

    const d1Block = content.slice(rangeD1!.start, rangeD1!.end);

    // O bloco D1 deve incluir o texto apos "DESTAQUE 2 foi coberto..."
    // (antes do fix, nextMatch casava "DESTAQUE 2 foi..." e cortava D1 ali)
    assert.ok(
      d1Block.includes("Mais texto do D1 com claim-alvo aqui"),
      "texto apos linha 'DESTAQUE 2 foi coberto' deve estar incluido no range D1 (nao cortado pelo regex)",
    );
    // D2's exclusive content should not be in D1
    assert.ok(!d1Block.includes("Texto do D2"), "bloco D1 nao deve incluir texto exclusivo de D2");
    // D1 must end EXACTLY at the real "DESTAQUE 2 | PRODUTO" header (exclusive end).
    // Igualdade exata (nao <= realD2Pos + 1) — o +1 toleraria um off-by-one que
    // incluiria o "D" do header seguinte no range de D1 (self-review #2634).
    const realD2Pos = content.indexOf("DESTAQUE 2 | PRODUTO");
    assert.equal(rangeD1!.end, realD2Pos, `D1.end (${rangeD1!.end}) deve ser exatamente o inicio do header DESTAQUE 2 | PRODUTO (${realD2Pos})`);
  });

  it("formato canonico DESTAQUE N | CATEGORIA continua delimitando corretamente (nao regrediu)", () => {
    // Garante que o fix nao quebrou o caso normal.
    const content = [
      "DESTAQUE 1 | MERCADO",
      "",
      "Valor errado GPT-4o aqui.",
      "",
      "DESTAQUE 2 | PRODUTO",
      "",
      "Outro conteudo com GPT-4o.",
    ].join("\n");

    const rangeD1 = findDestaqueBodyRange(content, 1);
    const rangeD2 = findDestaqueBodyRange(content, 2);

    assert.ok(rangeD1 !== null, "range D1 deve existir");
    assert.ok(rangeD2 !== null, "range D2 deve existir");

    const d1Block = content.slice(rangeD1!.start, rangeD1!.end);
    const d2Block = content.slice(rangeD2!.start, rangeD2!.end);

    assert.ok(d1Block.includes("Valor errado GPT-4o aqui"), "D1 deve conter seu texto");
    assert.ok(!d1Block.includes("Outro conteudo"), "D1 NAO deve conter texto de D2");
    assert.ok(d2Block.includes("Outro conteudo com GPT-4o"), "D2 deve conter seu texto");
    assert.ok(rangeD1!.end <= rangeD2!.start, "D1 deve terminar antes de D2 comecar");
  });
});

// ─── #2707: markerRe (start-boundary) tinha o MESMO bug-class do #2634 ───────

describe("regressao #2707: findDestaqueBodyRange — markerRe (start-boundary) nao confunde texto de corpo com header real", () => {
  it("texto de corpo 'DESTAQUE 2 e importante porque...' ANTES do header real nao e confundido com o inicio do D2", () => {
    // Antes do fix #2707, markerRe = /(?:^|\n)(DESTAQUE\s+2(?:\s|$))/i — o grupo
    // `(?:\s|$)` exige so UM whitespace apos o numero, entao "DESTAQUE 2 e
    // importante..." tambem casava (o "2" e seguido por um espaco), fazendo
    // findDestaqueBodyRange(content, 2) apontar para o texto de CORPO do D1 em
    // vez do header real "DESTAQUE 2 | PRODUTO" mais abaixo.
    const content = [
      "DESTAQUE 1 | MERCADO",
      "",
      "DESTAQUE 2 e importante porque muda o mercado de forma relevante.",
      "",
      "Mais texto do D1.",
      "",
      "DESTAQUE 2 | PRODUTO",
      "",
      "Texto real do D2 com claim-alvo aqui.",
    ].join("\n");

    const rangeD2 = findDestaqueBodyRange(content, 2);
    assert.ok(rangeD2 !== null, "range D2 deve existir");

    const realHeaderPos = content.indexOf("DESTAQUE 2 | PRODUTO");
    assert.equal(
      rangeD2!.start,
      realHeaderPos,
      `D2.start (${rangeD2!.start}) deve apontar para o header real "DESTAQUE 2 | PRODUTO" (${realHeaderPos}), nao para a mencao de corpo dentro do D1`,
    );

    const d2Block = content.slice(rangeD2!.start, rangeD2!.end);
    assert.ok(d2Block.includes("Texto real do D2 com claim-alvo aqui"), "bloco D2 deve conter o texto real do D2");
    assert.ok(!d2Block.includes("Mais texto do D1"), "bloco D2 NAO deve incluir texto do D1");
  });

  it("formato canonico DESTAQUE N | CATEGORIA continua sendo encontrado corretamente (nao regrediu)", () => {
    const content = [
      "DESTAQUE 1 | MERCADO",
      "",
      "Texto do D1.",
      "",
      "DESTAQUE 2 | PRODUTO",
      "",
      "Texto do D2.",
      "",
      "DESTAQUE 3 | PESQUISA",
      "",
      "Texto do D3.",
    ].join("\n");

    for (const [n, expectedText] of [
      [1, "Texto do D1"],
      [2, "Texto do D2"],
      [3, "Texto do D3"],
    ] as const) {
      const range = findDestaqueBodyRange(content, n);
      assert.ok(range !== null, `range D${n} deve existir`);
      const block = content.slice(range!.start, range!.end);
      assert.ok(block.includes(expectedText), `bloco D${n} deve conter "${expectedText}"`);
    }
  });

  it("header sem pipe/colon (formato legado, so 'DESTAQUE N' no fim da linha) ainda e encontrado", () => {
    const content = ["DESTAQUE 1", "", "Texto do D1 legado."].join("\n");
    const range = findDestaqueBodyRange(content, 1);
    assert.ok(range !== null, "range D1 deve existir mesmo sem pipe/categoria");
    const block = content.slice(range!.start, range!.end);
    assert.ok(block.includes("Texto do D1 legado"), "bloco D1 deve conter o texto");
  });
});

describe("regressao #2715 item 1: findDestaqueBodyRange — header nao-canonico (':'/'—'/'-') nao estende range ate EOF", () => {
  it("header 'DESTAQUE 2: Titulo' (dois-pontos) delimita corretamente o fim do D1 e o inicio/fim do D2", () => {
    // Antes do fix #2715, destaqueHeaderPattern so aceitava '|' ou fim-de-linha
    // como separador. Um header nao-canonico como "DESTAQUE 2: Titulo" nao
    // casava com nextMatch, entao o range do D1 pulava direto pro proximo
    // header que CASASSE (ou EOF), englobando o D2 inteiro.
    const content = [
      "DESTAQUE 1 | MERCADO",
      "",
      "Texto do D1.",
      "",
      "DESTAQUE 2: Titulo Nao Canonico",
      "",
      "Texto do D2.",
      "",
      "DESTAQUE 3 | PESQUISA",
      "",
      "Texto do D3.",
    ].join("\n");

    const rangeD1 = findDestaqueBodyRange(content, 1);
    const rangeD2 = findDestaqueBodyRange(content, 2);
    assert.ok(rangeD1 !== null && rangeD2 !== null, "ranges D1 e D2 devem existir");

    const d1Block = content.slice(rangeD1!.start, rangeD1!.end);
    assert.ok(d1Block.includes("Texto do D1"), "bloco D1 deve conter o texto do D1");
    assert.ok(!d1Block.includes("Texto do D2"), "bloco D1 NAO deve englobar o D2");

    const d2Block = content.slice(rangeD2!.start, rangeD2!.end);
    assert.ok(d2Block.includes("Texto do D2"), "bloco D2 deve conter o texto do D2");
    assert.ok(!d2Block.includes("Texto do D3"), "bloco D2 NAO deve englobar o D3");
  });

  it("header 'DESTAQUE 2 — Titulo' (travessao) delimita corretamente o fim do D1", () => {
    const content = [
      "DESTAQUE 1 | MERCADO",
      "",
      "Texto do D1.",
      "",
      "DESTAQUE 2 — Titulo Nao Canonico",
      "",
      "Texto do D2.",
    ].join("\n");

    const rangeD1 = findDestaqueBodyRange(content, 1);
    assert.ok(rangeD1 !== null, "range D1 deve existir");
    const d1Block = content.slice(rangeD1!.start, rangeD1!.end);
    assert.ok(d1Block.includes("Texto do D1"), "bloco D1 deve conter o texto do D1");
    assert.ok(!d1Block.includes("Texto do D2"), "bloco D1 NAO deve englobar o D2");
  });

  it("header 'DESTAQUE 2 - Titulo' (hifen) delimita corretamente o fim do D1", () => {
    const content = [
      "DESTAQUE 1 | MERCADO",
      "",
      "Texto do D1.",
      "",
      "DESTAQUE 2 - Titulo Nao Canonico",
      "",
      "Texto do D2.",
    ].join("\n");

    const rangeD1 = findDestaqueBodyRange(content, 1);
    assert.ok(rangeD1 !== null, "range D1 deve existir");
    const d1Block = content.slice(rangeD1!.start, rangeD1!.end);
    assert.ok(d1Block.includes("Texto do D1"), "bloco D1 deve conter o texto do D1");
    assert.ok(!d1Block.includes("Texto do D2"), "bloco D1 NAO deve englobar o D2");
  });
});
