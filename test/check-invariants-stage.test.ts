/**
 * test/check-invariants-stage.test.ts (#1007 Fase 1)
 *
 * Cobre o modo `--stage N` do check-invariants.ts e cada uma das regras
 * registradas em scripts/lib/invariant-checks/. Cada teste constrói uma
 * edição-fixture mínima e dispara violations específicas.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ALL_INVARIANT_RULES,
  getRulesForStage,
} from "../scripts/lib/invariant-checks/index.ts";
import { STAGE_0_RULES } from "../scripts/lib/invariant-checks/stage-0.ts";
import {
  checkApprovedHas3Highlights,
  checkCategorizedHasEiaSection,
} from "../scripts/lib/invariant-checks/stage-1.ts";
import {
  checkReviewedPassesAllLints,
  checkSocialPassesLints,
  checkPorQueIssoImportaSeparate,
} from "../scripts/lib/invariant-checks/stage-2.ts";
import {
  checkAllImagesExist,
  checkPromptsClean,
  checkEiaAnswerResolved,
} from "../scripts/lib/invariant-checks/stage-3.ts";
import {
  checkPublicImagesPopulated,
  checkSocialHashFresh,
  checkImageContentFresh,
  findImageContentMismatches,
  checkLinkedinWorkerUrlSet,
  checkFbPageIdSet,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { hashHighlights } from "../scripts/lib/social-source-hash.ts";
import {
  checkStep4Sentinel,
  checkSocialPublishedComplete,
  checkStage4ReviewLoop,
  checkClosePollMarker,
} from "../scripts/lib/invariant-checks/stage-5.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");

function makeFixtureEdition(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-invariants-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

describe("invariant-checks registry (#1007)", () => {
  it("expõe regras nos stages 0-5", () => {
    for (let stage = 0; stage <= 5; stage++) {
      const rules = getRulesForStage(stage as 0 | 1 | 2 | 3 | 4 | 5);
      assert.ok(rules.length > 0, `Stage ${stage} sem regras`);
      for (const rule of rules) {
        assert.equal(rule.stage, stage);
        assert.ok(typeof rule.run === "function");
        assert.ok(rule.source_issue.startsWith("#"));
      }
    }
  });

  it("ALL_INVARIANT_RULES tem ≥14 regras (cobre stages 0-5)", () => {
    assert.ok(
      ALL_INVARIANT_RULES.length >= 14,
      `Esperava ≥14 regras, achei ${ALL_INVARIANT_RULES.length}`,
    );
  });
});

describe("Stage 0 invariants", () => {
  it("beehiiv-key-set falha quando BEEHIIV_API_KEY ausente", () => {
    const original = process.env.BEEHIIV_API_KEY;
    delete process.env.BEEHIIV_API_KEY;
    try {
      const rule = STAGE_0_RULES.find((r) => r.id === "beehiiv-key-set")!;
      const v = rule.run("");
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /BEEHIIV_API_KEY/);
    } finally {
      if (original !== undefined) process.env.BEEHIIV_API_KEY = original;
    }
  });

  it("beehiiv-key-set passa quando setada", () => {
    const original = process.env.BEEHIIV_API_KEY;
    process.env.BEEHIIV_API_KEY = "test-key";
    try {
      const rule = STAGE_0_RULES.find((r) => r.id === "beehiiv-key-set")!;
      assert.equal(rule.run("").length, 0);
    } finally {
      if (original !== undefined) process.env.BEEHIIV_API_KEY = original;
      else delete process.env.BEEHIIV_API_KEY;
    }
  });

  // #1370 — todas as keys são hard halt (severity: error) per editor decision 2026-05-19
  const KEY_RULES: Array<{ rule: string; env: string; messageRe: RegExp }> = [
    { rule: "clarice-key-set", env: "CLARICE_API_KEY", messageRe: /CLARICE_API_KEY/ },
    { rule: "linkedin-cron-creds-set", env: "DIARIA_LINKEDIN_CRON_URL", messageRe: /DIARIA_LINKEDIN_CRON_URL/ },
    { rule: "linkedin-cron-creds-set", env: "DIARIA_LINKEDIN_CRON_TOKEN", messageRe: /DIARIA_LINKEDIN_CRON_TOKEN/ },
    { rule: "poll-secrets-set", env: "POLL_SECRET", messageRe: /POLL_SECRET/ },
    { rule: "poll-secrets-set", env: "ADMIN_SECRET", messageRe: /ADMIN_SECRET/ },
  ];

  for (const { rule: ruleId, env, messageRe } of KEY_RULES) {
    it(`${ruleId} falha (severity=error) quando ${env} ausente (#1370)`, () => {
      const original = process.env[env];
      delete process.env[env];
      try {
        const rule = STAGE_0_RULES.find((r) => r.id === ruleId)!;
        const v = rule.run("");
        assert.ok(v.length >= 1, `Esperava ≥1 violation pra ${env} ausente`);
        const match = v.find((x) => messageRe.test(x.message));
        assert.ok(match, `Esperava violation com message matching ${messageRe}, achei: ${v.map((x) => x.message).join("|")}`);
        assert.equal(match!.severity, "error", `#1370 — todas keys hard halt, ${env} deve ser error não warning`);
      } finally {
        if (original !== undefined) process.env[env] = original;
      }
    });
  }

  it("image-generator-key-set falha quando gemini config + GEMINI_API_KEY ausente (#1370)", () => {
    const original = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const rule = STAGE_0_RULES.find((r) => r.id === "image-generator-key-set")!;
      const v = rule.run("");
      // platform.config.json default = gemini
      assert.ok(v.length >= 1, "Esperava violation pra image_generator=gemini sem key");
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /GEMINI_API_KEY/);
    } finally {
      if (original !== undefined) process.env.GEMINI_API_KEY = original;
    }
  });

  // #1382 — mcp-binaries-exist
  it("mcp-binaries-exist passa quando .mcp.json sem stdio servers (estado pós-fix #1382)", () => {
    const rule = STAGE_0_RULES.find((r) => r.id === "mcp-binaries-exist")!;
    const v = rule.run("");
    // .mcp.json atual deve ter mcpServers: {} (clarice movido pra user scope)
    assert.equal(v.length, 0, `Esperava 0 violations com .mcp.json limpo, achei: ${v.map((x) => x.message).join("|")}`);
  });

  // #1396 — gemini-model-valid
  it("gemini-model-valid skipa silently quando GEMINI_API_KEY ausente (#1396)", () => {
    const original = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const rule = STAGE_0_RULES.find((r) => r.id === "gemini-model-valid")!;
      const v = rule.run("");
      // sem key, outro rule (image-generator-key-set) cobre — não duplicar
      assert.equal(v.length, 0);
    } finally {
      if (original !== undefined) process.env.GEMINI_API_KEY = original;
    }
  });
});

describe("Stage 1 invariants", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = makeFixtureEdition();
  });

  it("approved-has-3-highlights falha quando arquivo ausente", () => {
    const v = checkApprovedHas3Highlights(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "approved-exists");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("approved-has-3-highlights falha com 2 highlights", () => {
    writeFileSync(
      join(fixture, "_internal", "01-approved.json"),
      JSON.stringify({ highlights: [{}, {}] }),
    );
    const v = checkApprovedHas3Highlights(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "approved-has-3-highlights");
    assert.match(v[0].message, /2 highlights/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("approved-has-3-highlights passa com 3", () => {
    writeFileSync(
      join(fixture, "_internal", "01-approved.json"),
      JSON.stringify({ highlights: [{}, {}, {}], coverage: { line: "x" } }),
    );
    const v = checkApprovedHas3Highlights(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("categorized-has-eia-section falha sem '## É IA?'", () => {
    writeFileSync(join(fixture, "01-categorized.md"), "# foo\n\n## bar\n");
    const v = checkCategorizedHasEiaSection(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "categorized-has-eia-section");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("categorized-has-eia-section passa com seção presente", () => {
    writeFileSync(join(fixture, "01-categorized.md"), "## É IA?\n\nfoto X\n");
    const v = checkCategorizedHasEiaSection(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  // #1260: render-categorized-md.ts insere placeholder com sufixo quando
  // 01-eia.md não existe ainda: "## É IA? ⏳ (ainda processando...)". Antes
  // a regex strict /^## É IA\?\s*$/m rejeitava esse caso e bloqueava o gate
  // mesmo com a seção corretamente presente.
  it("categorized-has-eia-section passa com placeholder '## É IA? ⏳ (...)' (#1260)", () => {
    writeFileSync(
      join(fixture, "01-categorized.md"),
      "## É IA? ⏳ (ainda processando — será revisado quando disponível)\n\n",
    );
    const v = checkCategorizedHasEiaSection(fixture);
    assert.equal(v.length, 0, "placeholder header com sufixo deve passar");
    rmSync(fixture, { recursive: true, force: true });
  });
});

describe("Stage 2 invariants", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = makeFixtureEdition();
  });

  it("por-que-isso-importa-separate-line passa silenciosamente quando 02-reviewed.md ausente", () => {
    // Sanity check é early-return quando arquivo não existe — Stage 2 ainda
    // não rodou. O check de existência fica em reviewed-passes-all-lints.
    const v = checkPorQueIssoImportaSeparate(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("por-que-isso-importa-separate-line falha quando inline com texto", () => {
    writeFileSync(
      join(fixture, "02-reviewed.md"),
      "Lorem ipsum. Por que isso importa: contexto.\n",
    );
    const v = checkPorQueIssoImportaSeparate(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "por-que-isso-importa-separate-line");
    assert.equal(v[0].severity, "error");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("por-que-isso-importa-separate-line passa quando em linha separada", () => {
    writeFileSync(
      join(fixture, "02-reviewed.md"),
      "Lorem ipsum.\n\nPor que isso importa: contexto.\n",
    );
    const v = checkPorQueIssoImportaSeparate(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("reviewed-passes-all-lints falha com 'file-exists' quando 02-reviewed.md ausente", () => {
    const v = checkReviewedPassesAllLints(fixture);
    // 8 lints granulares, todos retornam file-exists violation
    assert.ok(v.length >= 1);
    assert.ok(v.every((x) => x.rule.endsWith("-file-exists")));
    assert.match(v[0].message, /02-reviewed\.md ausente/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("reviewed-passes-all-lints propaga violations de subprocess (spawn integration)", () => {
    // MD trivial — vai falhar em vários lints granulares (não só file-exists).
    // Esse teste valida que `runCheck` invoca tsx corretamente e propaga
    // exit code != 0 como violation (cobre regressão de #1010 item 3 —
    // shell:true mangling de args quando edition-dir tem espaço).
    writeFileSync(join(fixture, "02-reviewed.md"), "# Diar.ia\n\nNada relevante.\n");
    const v = checkReviewedPassesAllLints(fixture);
    // Pelo menos 1 violation de lint real (não file-exists), provando que
    // o subprocess foi invocado e seu exit code propagado.
    const realViolations = v.filter((x) => !x.rule.endsWith("-file-exists"));
    assert.ok(
      realViolations.length > 0,
      `Esperava violation de lint real, achei: ${JSON.stringify(v.map((x) => x.rule))}`,
    );
    // Mensagem contém o nome do script invocado — confirma que runCheck
    // formata a violation com contexto de qual lint falhou.
    assert.ok(
      realViolations.every((x) => x.message.includes("lint-newsletter-md.ts")),
    );
    rmSync(fixture, { recursive: true, force: true });
  });

  it("social-passes-lints falha com 'file-exists' quando 03-social.md ausente", () => {
    const v = checkSocialPassesLints(fixture);
    assert.equal(v.length, 3); // linkedin-schema + relative-time + post_pixel-matches-d1 (#1861)
    assert.ok(v.every((x) => x.rule.endsWith("-file-exists")));
    // #1861: a nova check está registrada (não só a contagem mudou).
    assert.ok(
      v.some((x) => x.rule === "social-post-pixel-matches-d1-file-exists"),
      "rule social-post-pixel-matches-d1 deve estar presente",
    );
    assert.match(v[0].message, /03-social\.md ausente/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("social-passes-lints retorna 0 violations quando ambos subprocess saem 0 (success path)", () => {
    // MD trivial sem `# LinkedIn` (linkedin-schema é no-op) e sem palavras-
    // gatilho temporais (relative-time não casa). Valida que `runCheck`
    // propaga exit code 0 sem violations espúrias — cobre o success path
    // do spawnSync sem shell:true.
    writeFileSync(join(fixture, "03-social.md"), "# Outros\n\nConteúdo neutro.\n");
    const v = checkSocialPassesLints(fixture);
    assert.equal(v.length, 0, `Esperava 0 violations, achei ${JSON.stringify(v)}`);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("social-passes-lints detecta relative-time inline (spawn integration)", () => {
    // Palavra-gatilho "ontem" fora de aspas → relative-time falha. Valida
    // que `runCheck` invoca lint-social-md.ts corretamente e propaga
    // exit code != 0 como violation.
    writeFileSync(
      join(fixture, "03-social.md"),
      "# Outros\n\nIA aprendeu novo truque ontem.\n",
    );
    const v = checkSocialPassesLints(fixture);
    const ruleIds = v.map((x) => x.rule);
    assert.ok(
      ruleIds.includes("social-relative-time"),
      `Esperava social-relative-time, achei ${JSON.stringify(ruleIds)}`,
    );
    rmSync(fixture, { recursive: true, force: true });
  });
});

describe("Stage 3 invariants", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = makeFixtureEdition();
  });

  it("all-images-exist falha quando todas ausentes", () => {
    const v = checkAllImagesExist(fixture);
    assert.equal(v.length, 8); // 8 imagens obrigatórias (#2133/#2141: d2/d3 2x1 adicionadas)
    for (const violation of v) {
      assert.equal(violation.severity, "error");
    }
    rmSync(fixture, { recursive: true, force: true });
  });

  it("prompts-clean detecta '1024x1024'", () => {
    writeFileSync(
      join(fixture, "04-d1-sd-prompt.json"),
      JSON.stringify({ prompt: "Van Gogh impasto, 1024x1024 resolution" }),
    );
    const v = checkPromptsClean(fixture);
    assert.ok(v.some((x) => x.rule === "prompts-no-pixels"));
    rmSync(fixture, { recursive: true, force: true });
  });

  it("prompts-clean detecta 'Noite Estrelada'", () => {
    writeFileSync(
      join(fixture, "04-d1-sd-prompt.json"),
      JSON.stringify({ prompt: "estilo Noite Estrelada Van Gogh" }),
    );
    const v = checkPromptsClean(fixture);
    assert.ok(v.some((x) => x.rule === "prompts-no-noite-estrelada"));
    rmSync(fixture, { recursive: true, force: true });
  });

  it("prompts-clean passa com prompt limpo", () => {
    writeFileSync(
      join(fixture, "04-d1-sd-prompt.json"),
      JSON.stringify({ prompt: "Van Gogh impasto style, 2:1 aspect ratio" }),
    );
    const v = checkPromptsClean(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("eia-answer-resolved falha sem frontmatter", () => {
    writeFileSync(join(fixture, "01-eia.md"), "# É IA?\n\nfoto X\n");
    const v = checkEiaAnswerResolved(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "eia-answer-resolved");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("eia-answer-resolved passa com YAML aninhado A=ia/B=real", () => {
    writeFileSync(
      join(fixture, "01-eia.md"),
      "---\neia_answer:\n  A: ia\n  B: real\n---\n\nÉ IA?\n",
    );
    const v = checkEiaAnswerResolved(fixture);
    assert.equal(v.length, 0, JSON.stringify(v));
    rmSync(fixture, { recursive: true, force: true });
  });

  it("eia-answer-resolved falha quando A==B (sorteio inválido)", () => {
    writeFileSync(
      join(fixture, "01-eia.md"),
      "---\neia_answer:\n  A: ia\n  B: ia\n---\n\nÉ IA?\n",
    );
    const v = checkEiaAnswerResolved(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "eia-answer-pair-distinct");
    rmSync(fixture, { recursive: true, force: true });
  });
});

describe("Stage 4 invariants", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = makeFixtureEdition();
  });

  it("public-images-populated falha quando arquivo ausente", () => {
    const v = checkPublicImagesPopulated(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "public-images-exists");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("public-images-populated falha quando d1.url ausente (shape real)", () => {
    writeFileSync(
      join(fixture, "06-public-images.json"),
      JSON.stringify({
        images: {
          d1: { file_id: "abc", filename: "04-d1-1x1.jpg" }, // sem url
          d2: { url: "https://drive.example/d2" },
          d3: { url: "https://drive.example/d3" },
        },
      }),
    );
    const v = checkPublicImagesPopulated(fixture);
    assert.ok(v.some((x) => x.message.includes("images.d1.url")));
    rmSync(fixture, { recursive: true, force: true });
  });

  it("public-images-populated passa com shape real completo (social 1x1 + newsletter hero 2x1)", () => {
    // #2158 finding 4: shape completo inclui cover/d2_2x1/d3_2x1 (newsletter hero)
    // além dos d1/d2/d3 1x1 (social). Todos presentes → 0 violations.
    writeFileSync(
      join(fixture, "06-public-images.json"),
      JSON.stringify({
        images: {
          d1: { url: "https://drive.example/d1", file_id: "a" },
          d2: { url: "https://drive.example/d2", file_id: "b" },
          d3: { url: "https://drive.example/d3", file_id: "c" },
          cover: { url: "https://cf.example/cover" },
          d2_2x1: { url: "https://cf.example/d2_2x1" },
          d3_2x1: { url: "https://cf.example/d3_2x1" },
        },
      }),
    );
    const v = checkPublicImagesPopulated(fixture);
    assert.equal(v.length, 0, JSON.stringify(v));
    rmSync(fixture, { recursive: true, force: true });
  });

  it("#2158 finding 4: public-images-newsletter-hero emite warning quando d2_2x1 ausente (cross-mode blind spot)", () => {
    // Social mode só preenche d2/d3 1x1; newsletter mode optional falhou silenciosamente.
    // O check deve emitir warning para cada chave hero 2x1 ausente.
    writeFileSync(
      join(fixture, "06-public-images.json"),
      JSON.stringify({
        images: {
          d1: { url: "https://drive.example/d1", file_id: "a" },
          d2: { url: "https://drive.example/d2", file_id: "b" },
          d3: { url: "https://drive.example/d3", file_id: "c" },
          // cover, d2_2x1, d3_2x1 ausentes (newsletter mode falhou)
        },
      }),
    );
    const v = checkPublicImagesPopulated(fixture);
    // Deve ter 3 warnings (cover, d2_2x1, d3_2x1) e 0 errors para social keys
    assert.equal(v.filter((x) => x.rule === "public-images-newsletter-hero").length, 3, JSON.stringify(v));
    assert.ok(v.every((x) => x.severity === "warning"), `Esperado só warnings: ${JSON.stringify(v)}`);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("linkedin-worker-url-set warning quando ausente (graceful degrade pra Make)", () => {
    const original = process.env.DIARIA_LINKEDIN_CRON_URL;
    delete process.env.DIARIA_LINKEDIN_CRON_URL;
    try {
      const v = checkLinkedinWorkerUrlSet();
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "linkedin-worker-url-set");
      assert.equal(v[0].severity, "warning");
    } finally {
      if (original !== undefined) process.env.DIARIA_LINKEDIN_CRON_URL = original;
    }
  });

  it("linkedin-worker-url-set falha quando não-HTTPS (error)", () => {
    const original = process.env.DIARIA_LINKEDIN_CRON_URL;
    process.env.DIARIA_LINKEDIN_CRON_URL = "http://insecure.example/fire";
    try {
      const v = checkLinkedinWorkerUrlSet();
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "linkedin-worker-url-https");
      assert.equal(v[0].severity, "error");
    } finally {
      if (original !== undefined) process.env.DIARIA_LINKEDIN_CRON_URL = original;
      else delete process.env.DIARIA_LINKEDIN_CRON_URL;
    }
  });

  it("fb-page-id-set falha quando FACEBOOK_PAGE_ID ausente", () => {
    const original = process.env.FACEBOOK_PAGE_ID;
    delete process.env.FACEBOOK_PAGE_ID;
    try {
      const v = checkFbPageIdSet();
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "facebook-page-id-set");
    } finally {
      if (original !== undefined) process.env.FACEBOOK_PAGE_ID = original;
    }
  });

  describe("social-hash-fresh (#1413)", () => {
    let fixture: string;

    beforeEach(() => {
      fixture = makeFixtureEdition();
    });

    function writeApproved(highlights: unknown[]): void {
      writeFileSync(
        join(fixture, "_internal", "01-approved.json"),
        JSON.stringify({ highlights }),
      );
    }

    function writeSocial(content = "## d1\nany\n"): void {
      writeFileSync(join(fixture, "03-social.md"), content);
    }

    function writeHash(hash: string): void {
      writeFileSync(
        join(fixture, "_internal", ".social-source-hash.json"),
        JSON.stringify({ hash, generated_at: new Date().toISOString() }),
      );
    }

    it("passa silenciosamente quando approved.json ausente (outro check cobre)", () => {
      const v = checkSocialHashFresh(fixture);
      assert.equal(v.length, 0);
      rmSync(fixture, { recursive: true, force: true });
    });

    it("passa silenciosamente quando 03-social.md ausente", () => {
      writeApproved([{ url: "https://a", title_options: ["A"] }]);
      const v = checkSocialHashFresh(fixture);
      assert.equal(v.length, 0);
      rmSync(fixture, { recursive: true, force: true });
    });

    it("warning quando hash file ausente (social.md gerado pre-#1413)", () => {
      writeApproved([{ url: "https://a", title_options: ["A"] }]);
      writeSocial();
      const v = checkSocialHashFresh(fixture);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.equal(v[0].rule, "social-hash-fresh");
      rmSync(fixture, { recursive: true, force: true });
    });

    it("passa quando hash bate (social.md current)", () => {
      const highlights = [{ url: "https://a", title_options: ["A"] }];
      writeApproved(highlights);
      writeSocial();
      writeHash(hashHighlights(highlights));
      const v = checkSocialHashFresh(fixture);
      assert.equal(v.length, 0, JSON.stringify(v));
      rmSync(fixture, { recursive: true, force: true });
    });

    it("#1413: falha quando hash diverge (caso 260520: D1 trocou pós-Stage 2)", () => {
      const oldHighlights = [
        { url: "https://karpathy", title_options: ["Karpathy"] },
        { url: "https://kpmg", title_options: ["KPMG"] },
      ];
      const newHighlights = [
        { url: "https://google-io", title_options: ["Google I/O"] },
        { url: "https://karpathy", title_options: ["Karpathy"] },
      ];
      writeHash(hashHighlights(oldHighlights)); // social.md foi gerado com old
      writeApproved(newHighlights); // editor reestruturou
      writeSocial();
      const v = checkSocialHashFresh(fixture);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /Highlights mudaram/);
      assert.match(v[0].message, /Re-dispatch/);
      rmSync(fixture, { recursive: true, force: true });
    });

    it("hash file corrupted → error parseable", () => {
      writeApproved([{ url: "https://a", title_options: ["A"] }]);
      writeSocial();
      writeFileSync(
        join(fixture, "_internal", ".social-source-hash.json"),
        "not-json",
      );
      const v = checkSocialHashFresh(fixture);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "social-hash-fresh-parseable");
      rmSync(fixture, { recursive: true, force: true });
    });
  });

  describe("image-content-fresh (#1730)", () => {
    let fixture: string;

    beforeEach(() => {
      fixture = makeFixtureEdition();
    });

    function writeReviewed(urls: [string, string, string]): void {
      // Formato real (#1730 review): header em bold markdown + link markdown,
      // como o 02-reviewed.md de produção desde ~260520. Exercita o fix do
      // extractDestaqueUrls que tolera `**DESTAQUE N |**`.
      const md =
        `---\neia:\n  location: "DESTAQUE 1, parágrafo 1"\n---\n\n` +
        urls
          .map(
            (u, i) =>
              `**DESTAQUE ${i + 1} | 🔬 NOTÍCIAS**\n\n` +
              `**[Título do destaque ${i + 1}](${u})**\n\n` +
              `Corpo do destaque ${i + 1}.\n`,
          )
          .join("\n---\n\n");
      writeFileSync(join(fixture, "02-reviewed.md"), md);
    }

    function writePrompt(slot: "d1" | "d2" | "d3", url: string | null): void {
      const fm = url == null ? "" : `destaque_url: ${url}\n`;
      writeFileSync(
        join(fixture, "_internal", `02-${slot}-prompt.md`),
        `---\n${fm}---\n\nVan Gogh impasto scene for ${slot}.\n`,
      );
    }

    it("findImageContentMismatches: pure — detecta D1 trocado, ignora wording-same-URL", () => {
      const { mismatches, missingFrontmatter, haveFrontmatter } =
        findImageContentMismatches(
          { d1: "https://old.example/a", d2: "https://b", d3: "https://c" },
          ["https://new.example/x", "https://b", "https://c"],
        );
      assert.equal(missingFrontmatter.length, 0);
      assert.equal(haveFrontmatter, 3);
      assert.equal(mismatches.length, 1);
      assert.equal(mismatches[0].slot, "d1");
      assert.equal(mismatches[0].reviewedUrl, "https://new.example/x");
    });

    it("findImageContentMismatches: trailing slash + host case + utm são benignos (urlsMatch)", () => {
      const { mismatches } = findImageContentMismatches(
        {
          d1: "https://A.Example.com/path/",
          d2: "https://b.com/y?utm_source=news",
          d3: "https://c.com/z",
        },
        ["https://a.example.com/path", "https://b.com/y", "https://c.com/z"],
      );
      assert.equal(mismatches.length, 0, JSON.stringify(mismatches));
    });

    it("findImageContentMismatches: case DO PATH diverge → mismatch (artigos diferentes, F3)", () => {
      // canonicalize lowercaseia só host; path é case-sensitive (RFC 3986).
      const { mismatches } = findImageContentMismatches(
        { d1: "https://x.com/Build2026", d2: "https://b", d3: "https://c" },
        ["https://x.com/build2026", "https://b", "https://c"],
      );
      assert.equal(mismatches.length, 1);
      assert.equal(mismatches[0].slot, "d1");
    });

    it("findImageContentMismatches: prompt file existe sem frontmatter (null) → missingFrontmatter", () => {
      const { mismatches, missingFrontmatter, haveFrontmatter } =
        findImageContentMismatches(
          { d1: null, d2: "https://b", d3: "https://c" },
          ["https://a", "https://b", "https://c"],
        );
      assert.equal(mismatches.length, 0);
      assert.deepEqual(missingFrontmatter, ["d1"]);
      assert.equal(haveFrontmatter, 2);
    });

    it("findImageContentMismatches: prompt file ausente (undefined) NÃO vira missingFrontmatter (#1832)", () => {
      // d1 omitido = file não existe → fora de escopo, all-images-exist cobre.
      const { mismatches, missingFrontmatter } = findImageContentMismatches(
        { d2: "https://b", d3: "https://c" },
        ["https://a", "https://b", "https://c"],
      );
      assert.equal(mismatches.length, 0);
      assert.deepEqual(missingFrontmatter, []);
    });

    it("findImageContentMismatches: reviewed mais curto que 3 → slots extras ignorados", () => {
      const { mismatches, missingFrontmatter } = findImageContentMismatches(
        { d1: "https://a", d2: "https://b", d3: "https://stale" },
        ["https://a", "https://b"], // só 2 destaques
      );
      assert.equal(mismatches.length, 0);
      assert.deepEqual(missingFrontmatter, []);
    });

    it("passa silenciosamente quando 02-reviewed.md ausente", () => {
      writePrompt("d1", "https://a");
      const v = checkImageContentFresh(fixture);
      assert.equal(v.length, 0);
      rmSync(fixture, { recursive: true, force: true });
    });

    it("passa silenciosamente quando nenhum prompt existe (Stage 3 não rodou)", () => {
      writeReviewed(["https://a", "https://b", "https://c"]);
      const v = checkImageContentFresh(fixture);
      assert.equal(v.length, 0);
      rmSync(fixture, { recursive: true, force: true });
    });

    it("passa quando prompts batem com destaques atuais", () => {
      writeReviewed([
        "https://a.example/x",
        "https://b.example/y",
        "https://c.example/z",
      ]);
      writePrompt("d1", "https://a.example/x");
      writePrompt("d2", "https://b.example/y");
      writePrompt("d3", "https://c.example/z");
      const v = checkImageContentFresh(fixture);
      assert.equal(v.length, 0, JSON.stringify(v));
      rmSync(fixture, { recursive: true, force: true });
    });

    it("#1730: warning quando editor troca artigo do D1 sem regenerar imagem", () => {
      // Prompt do D1 aponta pro artigo antigo (Karpathy); reviewed atual é Google I/O
      writeReviewed([
        "https://google-io.example/keynote",
        "https://b.example/y",
        "https://c.example/z",
      ]);
      writePrompt("d1", "https://karpathy.example/talk");
      writePrompt("d2", "https://b.example/y");
      writePrompt("d3", "https://c.example/z");
      const v = checkImageContentFresh(fixture);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "image-content-fresh");
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /D1/);
      assert.match(v[0].message, /karpathy/);
      assert.match(v[0].message, /google-io/);
      rmSync(fixture, { recursive: true, force: true });
    });

    it("warning quando 1 prompt sem destaque_url mas OUTROS têm (formato atual, anomalia)", () => {
      writeReviewed([
        "https://a.example/x",
        "https://b.example/y",
        "https://c.example/z",
      ]);
      writePrompt("d1", null);
      writePrompt("d2", "https://b.example/y");
      writePrompt("d3", "https://c.example/z");
      const v = checkImageContentFresh(fixture);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /destaque_url ausente/);
      assert.match(v[0].message, /02-d1-prompt\.md/);
      // file aponta pro prompt que EXISTE (não pro _internal dir)
      assert.match(v[0].file ?? "", /02-d1-prompt\.md$/);
      rmSync(fixture, { recursive: true, force: true });
    });

    it("#1832: edição legada (NENHUM prompt tem frontmatter) → silêncio, sem spam", () => {
      writeReviewed([
        "https://a.example/x",
        "https://b.example/y",
        "https://c.example/z",
      ]);
      writePrompt("d1", null);
      writePrompt("d2", null);
      writePrompt("d3", null);
      const v = checkImageContentFresh(fixture);
      assert.equal(v.length, 0, JSON.stringify(v));
      rmSync(fixture, { recursive: true, force: true });
    });

    it("#1833: URL com parêntese interno (Wikipedia) não dispara mismatch falso", () => {
      // reviewed e prompt apontam pro MESMO artigo; antes do #1833 o reviewed
      // era truncado no `)` interno → urlsMatch falhava → warning falso.
      const wiki = "https://en.wikipedia.org/wiki/AI_(disambiguation)";
      writeReviewed([wiki, "https://b.example/y", "https://c.example/z"]);
      writePrompt("d1", wiki);
      writePrompt("d2", "https://b.example/y");
      writePrompt("d3", "https://c.example/z");
      const v = checkImageContentFresh(fixture);
      assert.equal(v.length, 0, JSON.stringify(v));
      rmSync(fixture, { recursive: true, force: true });
    });

    it("#1832: prompt file ausente (Stage 3 parcial) NÃO vira warning de frontmatter", () => {
      writeReviewed([
        "https://a.example/x",
        "https://b.example/y",
        "https://c.example/z",
      ]);
      // só d1 e d3 gerados; d2 ausente → não deve avisar nada (matches batem)
      writePrompt("d1", "https://a.example/x");
      writePrompt("d3", "https://c.example/z");
      const v = checkImageContentFresh(fixture);
      assert.equal(v.length, 0, JSON.stringify(v));
      rmSync(fixture, { recursive: true, force: true });
    });
  });

});

describe("Stage 5 invariants (pós-publicação)", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = makeFixtureEdition();
  });

  it("step-4-sentinel-exists falha quando ausente", () => {
    const v = checkStep4Sentinel(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "step-4-sentinel-exists");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("step-4-sentinel-exists passa quando presente", () => {
    writeFileSync(
      join(fixture, "_internal", ".step-4-done.json"),
      JSON.stringify({ step: 4, completed_at: new Date().toISOString() }),
    );
    const v = checkStep4Sentinel(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("social-published-complete falha quando arquivo ausente", () => {
    const v = checkSocialPublishedComplete(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "social-published-exists");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("social-published-complete falha quando posts[] vazio", () => {
    writeFileSync(
      join(fixture, "_internal", "06-social-published.json"),
      JSON.stringify({ posts: [] }),
    );
    const v = checkSocialPublishedComplete(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "social-published-non-empty");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("social-published-complete passa com 6 posts ok", () => {
    writeFileSync(
      join(fixture, "_internal", "06-social-published.json"),
      JSON.stringify({
        posts: [
          { platform: "linkedin", status: "scheduled" },
          { platform: "linkedin", status: "scheduled" },
          { platform: "linkedin", status: "scheduled" },
          { platform: "facebook", status: "scheduled" },
          { platform: "facebook", status: "scheduled" },
          { platform: "facebook", status: "scheduled" },
        ],
      }),
    );
    const v = checkSocialPublishedComplete(fixture);
    assert.equal(v.length, 0);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("social-published-complete warning quando algum failed", () => {
    writeFileSync(
      join(fixture, "_internal", "06-social-published.json"),
      JSON.stringify({
        posts: [
          { platform: "linkedin", status: "scheduled" },
          { platform: "linkedin", status: "failed" },
        ],
      }),
    );
    const v = checkSocialPublishedComplete(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning");
    rmSync(fixture, { recursive: true, force: true });
  });

  // #1410 — stage-4 review loop enforcement
  describe("stage-5-review-loop-enforced (#1410)", () => {
    it("passa silenciosamente quando 05-published.json ausente (outro check pega)", () => {
      const v = checkStage4ReviewLoop(fixture);
      assert.equal(v.length, 0);
    });

    it("passa quando review_status='ok' (sem requirement de fix-mode)", () => {
      writeFileSync(
        join(fixture, "_internal", "05-published.json"),
        JSON.stringify({ review_status: "ok", review_attempts: 1 }),
      );
      const v = checkStage4ReviewLoop(fixture);
      assert.equal(v.length, 0);
    });

    it("passa quando review_status='inconclusive' (não exige fix-mode)", () => {
      writeFileSync(
        join(fixture, "_internal", "05-published.json"),
        JSON.stringify({ review_status: "inconclusive", review_attempts: 1 }),
      );
      const v = checkStage4ReviewLoop(fixture);
      assert.equal(v.length, 0);
    });

    it("#1410: falha quando issues_unfixable + review_attempts=1 (caso 260520: skip silencioso)", () => {
      writeFileSync(
        join(fixture, "_internal", "05-published.json"),
        JSON.stringify({ review_status: "issues_unfixable", review_attempts: 1 }),
      );
      const v = checkStage4ReviewLoop(fixture);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "stage-5-review-loop-enforced");
      assert.match(v[0].message, /review_attempts=1/);
      assert.match(v[0].message, /fix-mode/);
    });

    it("passa quando issues_unfixable + review_attempts>=2 (loop rodou de verdade)", () => {
      writeFileSync(
        join(fixture, "_internal", "05-published.json"),
        JSON.stringify({ review_status: "issues_unfixable", review_attempts: 2 }),
      );
      const v = checkStage4ReviewLoop(fixture);
      assert.equal(v.length, 0);
    });

    it("trata review_attempts ausente como 0 (passa fail check)", () => {
      writeFileSync(
        join(fixture, "_internal", "05-published.json"),
        JSON.stringify({ review_status: "issues_unfixable" }),
      );
      const v = checkStage4ReviewLoop(fixture);
      assert.equal(v.length, 1);
      assert.match(v[0].message, /review_attempts=0/);
    });

    it("reporta violation quando 05-published.json corrupted (audit nit)", () => {
      writeFileSync(
        join(fixture, "_internal", "05-published.json"),
        "not-json-{{{",
      );
      const v = checkStage4ReviewLoop(fixture);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "stage-5-review-loop-parseable");
    });
  });

  // #1367 — close-poll marker invariant
  it("close-poll-marker-exists falha quando marker ausente (#1367)", () => {
    const v = checkClosePollMarker(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "close-poll-marker-exists");
    assert.equal(v[0].severity, "error");
    assert.match(v[0].message, /close-poll/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("close-poll-marker passa quando marker presente e válido (#1367)", () => {
    writeFileSync(
      join(fixture, "_internal", ".close-poll-done.json"),
      JSON.stringify({
        edition: "260519",
        answer: "A",
        updated_votes: 3,
        closed_at: new Date().toISOString(),
        sanity_check: { correct_answer: "A" },
      }),
    );
    const v = checkClosePollMarker(fixture);
    assert.equal(v.length, 0, JSON.stringify(v));
    rmSync(fixture, { recursive: true, force: true });
  });

  it("close-poll-marker falha quando answer diverge do sanity_check (#1367)", () => {
    writeFileSync(
      join(fixture, "_internal", ".close-poll-done.json"),
      JSON.stringify({
        edition: "260519",
        answer: "A",
        sanity_check: { correct_answer: "B" },
      }),
    );
    const v = checkClosePollMarker(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "close-poll-marker-consistency");
    rmSync(fixture, { recursive: true, force: true });
  });

  it("close-poll-marker falha quando marker sem sanity_check (#1367)", () => {
    writeFileSync(
      join(fixture, "_internal", ".close-poll-done.json"),
      JSON.stringify({ edition: "260519", answer: "A" }),
    );
    const v = checkClosePollMarker(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "close-poll-marker-valid");
    rmSync(fixture, { recursive: true, force: true });
  });
});

describe("CLI --stage N", () => {
  function runCli(args: string[], env: Record<string, string> = {}) {
    const scriptPath = join(PROJECT_ROOT, "scripts", "check-invariants.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: { ...process.env, ...env },
      },
    );
  }

  it("--stage 0 sem env vars = exit 1 com violations", () => {
    const r = runCli(["--stage", "0"], { BEEHIIV_API_KEY: "" });
    // exit 1 (algum env ausente) é o caso normal num ambiente vanilla
    const out = JSON.parse(r.stdout);
    assert.ok(Array.isArray(out.violations));
    assert.ok(out.rules_run.length > 0);
  });

  it("--stage 1 sem --edition-dir = exit 2", () => {
    const r = runCli(["--stage", "1"]);
    assert.equal(r.status, 2);
  });

  it("--stage 6 (inválido) cai pra default = exit 2", () => {
    const r = runCli(["--stage", "6"]);
    // stage=6 não passa o regex /^[0-5]$/, então fica undefined →
    // sem editionDir e sem static, exit 2
    assert.equal(r.status, 2);
  });

  it("--stage 1 com edition-dir tmp = exit 1 (todos ausentes)", () => {
    const fixture = makeFixtureEdition();
    try {
      const r = runCli(["--stage", "1", "--edition-dir", fixture]);
      assert.equal(r.status, 1, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.passed, false);
      assert.ok(out.violations.length > 0);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("--stage 0 carrega .env.local via DIARIA_PROJECT_ROOT (#1010 item 4)", () => {
    // E2E real: escreve .env.local em tmp dir, invoca CLI com
    // DIARIA_PROJECT_ROOT apontando pra ele, valida que loadProjectEnv()
    // foi chamado (BEEHIIV_API_KEY do disco satisfaz beehiiv-key-set).
    // Cobre o gap onde testes anteriores setavam process.env manual e nunca
    // exercitavam o caminho de leitura do disco no CLI.
    const tmpRoot = mkdtempSync(join(tmpdir(), "diaria-cli-env-"));
    try {
      writeFileSync(
        join(tmpRoot, ".env.local"),
        "BEEHIIV_API_KEY=from-env-local\n",
      );
      // dotenv usa override:false → BEEHIIV_API_KEY precisa estar AUSENTE
      // (não vazio) no env do subprocess pra que .env.local consiga setá-lo.
      // Construímos um env limpo sem BEEHIIV_API_KEY herdado do shell parent.
      const scriptPath = join(PROJECT_ROOT, "scripts", "check-invariants.ts");
      const cleanEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (k !== "BEEHIIV_API_KEY" && v !== undefined) cleanEnv[k] = v;
      }
      cleanEnv.DIARIA_PROJECT_ROOT = tmpRoot;
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "--stage", "0"],
        { cwd: PROJECT_ROOT, encoding: "utf8", env: cleanEnv },
      );
      const out = JSON.parse(r.stdout);
      const beehivViolations = out.violations.filter(
        (v: { rule: string }) => v.rule === "beehiiv-key-set",
      );
      assert.equal(
        beehivViolations.length,
        0,
        `BEEHIIV_API_KEY do .env.local deveria satisfazer regra; achei ${JSON.stringify(beehivViolations)} (stderr: ${r.stderr})`,
      );
      assert.ok(out.rules_run.includes("beehiiv-key-set"));
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
