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
  checkNarrativeNotGenericPlaceholder,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { hashHighlights } from "../scripts/lib/social-source-hash.ts";
import {
  checkStep4Sentinel,
  checkSocialPublishedComplete,
  checkStage4ReviewLoop,
  checkClosePollMarker,
  checkLinkedinWorkerUrlSet,
  checkLinkedinWorkerUrlHttps,
  checkFbPageIdSet,
  checkFbTokenSet,
  checkCloudflareTokenSet,
  checkEditionUrlFile,
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

  it("#2172 registry contém entry linkedin-worker-url-https por id (remoção acidental seria detectada)", () => {
    const entry = ALL_INVARIANT_RULES.find((r) => r.id === "linkedin-worker-url-https");
    assert.ok(
      entry !== undefined,
      "ALL_INVARIANT_RULES deve conter entry com id 'linkedin-worker-url-https'",
    );
    assert.equal(entry!.stage, 5, "linkedin-worker-url-https deve estar no stage 5");
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
  // #1186 — POLL_SECRET removido do check poll-secrets-set (modo merge-tag, sem sig HMAC)
  const KEY_RULES: Array<{ rule: string; env: string; messageRe: RegExp }> = [
    { rule: "clarice-key-set", env: "CLARICE_API_KEY", messageRe: /CLARICE_API_KEY/ },
    { rule: "linkedin-cron-creds-set", env: "DIARIA_LINKEDIN_CRON_URL", messageRe: /DIARIA_LINKEDIN_CRON_URL/ },
    { rule: "linkedin-cron-creds-set", env: "DIARIA_LINKEDIN_CRON_TOKEN", messageRe: /DIARIA_LINKEDIN_CRON_TOKEN/ },
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

  it("poll-secrets-set NÃO falha quando POLL_SECRET ausente (#1186 — merge-tag mode, POLL_SECRET removido)", () => {
    // Regressão: antes de #1186, POLL_SECRET ausente bloqueava pipeline.
    // Em modo merge-tag, POLL_SECRET não é mais necessário.
    const originalPoll = process.env.POLL_SECRET;
    const originalAdmin = process.env.ADMIN_SECRET;
    delete process.env.POLL_SECRET;
    // Garantir que ADMIN_SECRET está presente (para não misturar causas)
    process.env.ADMIN_SECRET = "test-secret";
    try {
      const rule = STAGE_0_RULES.find((r) => r.id === "poll-secrets-set")!;
      const v = rule.run("");
      const pollSecretViolation = v.find((x) => /POLL_SECRET/.test(x.message));
      assert.ok(!pollSecretViolation, "#1186 — POLL_SECRET removido, ausência não deve gerar violation");
    } finally {
      if (originalPoll !== undefined) process.env.POLL_SECRET = originalPoll;
      else delete process.env.POLL_SECRET;
      if (originalAdmin !== undefined) process.env.ADMIN_SECRET = originalAdmin;
      else delete process.env.ADMIN_SECRET;
    }
  });

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

  // #2343: 2 destaques são válidos — range {2,3}. Antes era obrigatório exatamente 3.
  it("approved-has-3-highlights PASSA com 2 highlights (#2343 — range {2,3})", () => {
    writeFileSync(
      join(fixture, "_internal", "01-approved.json"),
      JSON.stringify({ highlights: [{}, {}] }),
    );
    const v = checkApprovedHas3Highlights(fixture);
    assert.equal(v.length, 0, `Esperava 0 violations com 2 destaques (range {2,3}): ${JSON.stringify(v)}`);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("approved-has-3-highlights falha com 1 highlight (fail-loud: < 2)", () => {
    writeFileSync(
      join(fixture, "_internal", "01-approved.json"),
      JSON.stringify({ highlights: [{}] }),
    );
    const v = checkApprovedHas3Highlights(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "approved-has-3-highlights");
    assert.match(v[0].message, /1 highlight/);
    rmSync(fixture, { recursive: true, force: true });
  });

  it("approved-has-3-highlights falha com 4 highlights (fail-loud: > 3)", () => {
    writeFileSync(
      join(fixture, "_internal", "01-approved.json"),
      JSON.stringify({ highlights: [{}, {}, {}, {}] }),
    );
    const v = checkApprovedHas3Highlights(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "approved-has-3-highlights");
    assert.match(v[0].message, /4 highlight/);
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
    // linkedin-schema + relative-time + post_pixel-matches-d1 (#1861) +
    // personal-post-no-newsletter-deixis (#2148) +
    // no-email-cta-linkedin (#2458) + linkedin-page-link (#2458) +
    // no-credential-bio (#2494).
    // humanizer-section-coverage só roda quando snapshot existe → não conta aqui.
    assert.equal(v.length, 7);
    assert.ok(v.every((x) => x.rule.endsWith("-file-exists")));
    // #1861: a nova check está registrada (não só a contagem mudou).
    assert.ok(
      v.some((x) => x.rule === "social-post-pixel-matches-d1-file-exists"),
      "rule social-post-pixel-matches-d1 deve estar presente",
    );
    // #2148: deixis check registrada
    assert.ok(
      v.some((x) => x.rule === "social-personal-post-no-newsletter-deixis-file-exists"),
      "rule social-personal-post-no-newsletter-deixis deve estar presente",
    );
    // #2458: email CTA + page link checks registradas
    assert.ok(
      v.some((x) => x.rule === "social-no-email-cta-linkedin-file-exists"),
      "rule social-no-email-cta-linkedin deve estar presente (#2458)",
    );
    assert.ok(
      v.some((x) => x.rule === "social-linkedin-page-link-file-exists"),
      "rule social-linkedin-page-link deve estar presente (#2458)",
    );
    // #2494: no-credential-bio check registrada
    assert.ok(
      v.some((x) => x.rule === "social-no-credential-bio-file-exists"),
      "rule social-no-credential-bio deve estar presente (#2494)",
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

  // --- #2148: Finding 1 fix — lints novos registrados no gate de Stage 2 ---

  it("#2148: gate social detecta deixis pessoal em post_pixel (personal-post-no-newsletter-deixis é gate-blocking)", () => {
    // Garante que o check NEW não é código morto — roda e bloqueia o gate
    // quando 03-social.md contém "esta newsletter" em post_pixel.
    const withDeixis = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "Texto do destaque 1.",
      "",
      "### comment_diaria",
      "",
      "Edição completa em {edition_url}",
      "",
      "Siga a Diar.ia no LinkedIn em linkedin.com/company/diaria",
      "",
      "### comment_pixel",
      "",
      "Comentário pessoal sem problema.",
      "",
      "## d2",
      "",
      "Texto do destaque 2.",
      "",
      "### comment_diaria",
      "",
      "Edição completa em {edition_url}",
      "",
      "Siga a Diar.ia no LinkedIn em linkedin.com/company/diaria",
      "",
      "### comment_pixel",
      "",
      "Comentário pessoal sem problema.",
      "",
      "## d3",
      "",
      "Texto do destaque 3.",
      "",
      "### comment_diaria",
      "",
      "Edição completa em {edition_url}",
      "",
      "Siga a Diar.ia no LinkedIn em linkedin.com/company/diaria",
      "",
      "### comment_pixel",
      "",
      "Comentário pessoal sem problema.",
      "",
      "## post_pixel",
      "",
      "<!-- destaque: d1 -->",
      "",
      "Esta newsletter roda em grande parte com agentes — o que ainda me surpreende.",
      "",
      "Siga a Diar.ia em linkedin.com/company/diaria",
      "",
      "#IA #Brasil",
      "",
      "# Facebook",
      "",
      "## d1",
      "",
      "Texto do Facebook.",
      "",
      "Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.",
    ].join("\n");
    writeFileSync(join(fixture, "03-social.md"), withDeixis);
    const v = checkSocialPassesLints(fixture);
    const ruleIds = v.map((x) => x.rule);
    assert.ok(
      ruleIds.includes("social-personal-post-no-newsletter-deixis"),
      `Gate não detectou deixis. violations: ${JSON.stringify(ruleIds)}`,
    );
    rmSync(fixture, { recursive: true, force: true });
  });

  it("#2148: gate social detecta seção não coberta pelo humanizador (humanizer-section-coverage é gate-blocking quando snapshot existe)", () => {
    // Garante que o check NEW humanizer-section-coverage é invocado pelo gate
    // quando o snapshot pré-humanizador existe.
    const pre = [
      "# LinkedIn",
      "## d1",
      "Texto ORIGINAL d1.",
      "### comment_diaria",
      "link",
      "### comment_pixel",
      "Comentário ORIGINAL.",
      "## post_pixel",
      "Post pixel ORIGINAL — não tocado.",
      "# Facebook",
      "## d1",
      "Foo",
    ].join("\n");
    const post = [
      "# LinkedIn",
      "## d1",
      "Texto reescrito d1.",
      "### comment_diaria",
      "link",
      "### comment_pixel",
      "Comentário reescrito.",
      "## post_pixel",
      "Post pixel ORIGINAL — não tocado.", // idêntico ao pre
      "# Facebook",
      "## d1",
      "Foo",
    ].join("\n");
    // Escrever o snapshot pré-humanizador em _internal/
    writeFileSync(join(fixture, "_internal", "03-social-pre-humanizador.md"), pre);
    writeFileSync(join(fixture, "03-social.md"), post);
    const v = checkSocialPassesLints(fixture);
    const ruleIds = v.map((x) => x.rule);
    assert.ok(
      ruleIds.includes("social-humanizer-section-coverage"),
      `Gate não detectou cobertura incompleta do humanizador. violations: ${JSON.stringify(ruleIds)}`,
    );
    rmSync(fixture, { recursive: true, force: true });
  });

  it("#2148: gate social não roda humanizer-section-coverage quando snapshot ausente (não bloqueia edições sem snapshot)", () => {
    // Sem snapshot → check skipped. Não deve gerar violation espúria.
    writeFileSync(join(fixture, "03-social.md"), "# Outros\n\nConteúdo neutro.\n");
    // _internal/ existe mas sem o snapshot
    const v = checkSocialPassesLints(fixture);
    const ruleIds = v.map((x) => x.rule);
    assert.ok(
      !ruleIds.includes("social-humanizer-section-coverage"),
      `Não devia rodar humanizer-section-coverage sem snapshot: ${JSON.stringify(ruleIds)}`,
    );
    rmSync(fixture, { recursive: true, force: true });
  });

  it("#2458: gate social detecta CTA de e-mail em post LinkedIn (social-no-email-cta-linkedin é gate-blocking)", () => {
    const withEmailCta = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "Texto editorial d1.",
      "",
      "### comment_diaria",
      "",
      "Edição completa em {edition_url}",
      "",
      "Receba a Diar.ia todo dia por e-mail, assine grátis em diar.ia.br",
      "",
      "### comment_pixel",
      "",
      "Comentário pessoal.",
      "",
      "## d2",
      "",
      "Texto editorial d2.",
      "",
      "### comment_diaria",
      "",
      "Edição completa em {edition_url}",
      "",
      "Siga a Diar.ia no LinkedIn em linkedin.com/company/diaria",
      "",
      "### comment_pixel",
      "",
      "Comentário pessoal.",
      "",
      "## d3",
      "",
      "Texto editorial d3.",
      "",
      "### comment_diaria",
      "",
      "Edição completa em {edition_url}",
      "",
      "Siga a Diar.ia no LinkedIn em linkedin.com/company/diaria",
      "",
      "### comment_pixel",
      "",
      "Comentário pessoal.",
      "",
      "## post_pixel",
      "",
      "Texto do post pessoal.",
      "",
      "Siga a Diar.ia em linkedin.com/company/diaria",
      "",
      "# Facebook",
      "",
      "## d1",
      "",
      "Post Facebook.",
      "",
      "Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.",
    ].join("\n");
    writeFileSync(join(fixture, "03-social.md"), withEmailCta);
    const v = checkSocialPassesLints(fixture);
    const ruleIds = v.map((x) => x.rule);
    assert.ok(
      ruleIds.includes("social-no-email-cta-linkedin"),
      `Gate não detectou email CTA. violations: ${JSON.stringify(ruleIds)}`,
    );
    rmSync(fixture, { recursive: true, force: true });
  });

  it("#2458: gate social detecta link da página ausente em comment_diaria (social-linkedin-page-link é gate-blocking)", () => {
    const missingPageLink = [
      "# LinkedIn",
      "",
      "## d1",
      "",
      "Texto editorial d1.",
      "",
      "### comment_diaria",
      "",
      "Edição completa em {edition_url}",
      "",
      "### comment_pixel",
      "",
      "Comentário pessoal.",
      "",
      "## d2",
      "",
      "Texto editorial d2.",
      "",
      "### comment_diaria",
      "",
      "Edição completa em {edition_url}",
      "",
      "Siga a Diar.ia em linkedin.com/company/diaria",
      "",
      "### comment_pixel",
      "",
      "Comentário pessoal.",
      "",
      "## d3",
      "",
      "Texto editorial d3.",
      "",
      "### comment_diaria",
      "",
      "Edição completa em {edition_url}",
      "",
      "Siga a Diar.ia em linkedin.com/company/diaria",
      "",
      "### comment_pixel",
      "",
      "Comentário pessoal.",
      "",
      "## post_pixel",
      "",
      "Texto do post pessoal.",
      "",
      "Siga a Diar.ia em linkedin.com/company/diaria",
      "",
      "# Facebook",
      "",
      "## d1",
      "",
      "Post Facebook.",
      "",
      "Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.",
    ].join("\n");
    writeFileSync(join(fixture, "03-social.md"), missingPageLink);
    const v = checkSocialPassesLints(fixture);
    const ruleIds = v.map((x) => x.rule);
    assert.ok(
      ruleIds.includes("social-linkedin-page-link"),
      `Gate não detectou link ausente. violations: ${JSON.stringify(ruleIds)}`,
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

  // #2154 pass-2: smoke tests para checkFbTokenSet e checkCloudflareTokenSet
  // — cobertura faltava (were 2 das 4 funções movidas stage-4→stage-5 sem teste unitário).
  it("facebook-token-set falha (severity=error) quando FACEBOOK_PAGE_ACCESS_TOKEN ausente", () => {
    const original = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    try {
      const v = checkFbTokenSet();
      assert.equal(v.length, 1, `esperava 1 violation, recebeu ${JSON.stringify(v)}`);
      assert.equal(v[0].rule, "facebook-token-set");
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /FACEBOOK_PAGE_ACCESS_TOKEN/);
    } finally {
      if (original !== undefined) process.env.FACEBOOK_PAGE_ACCESS_TOKEN = original;
    }
  });

  it("facebook-token-set ok quando FACEBOOK_PAGE_ACCESS_TOKEN setado", () => {
    const original = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "test-token-value";
    try {
      const v = checkFbTokenSet();
      assert.equal(v.length, 0, `esperava 0 violations, recebeu ${JSON.stringify(v)}`);
    } finally {
      if (original !== undefined) process.env.FACEBOOK_PAGE_ACCESS_TOKEN = original;
      else delete process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    }
  });

  it("linkedin-worker-token-set warning quando DIARIA_LINKEDIN_CRON_TOKEN ausente (graceful degrade)", () => {
    const original = process.env.DIARIA_LINKEDIN_CRON_TOKEN;
    delete process.env.DIARIA_LINKEDIN_CRON_TOKEN;
    try {
      const v = checkCloudflareTokenSet();
      assert.equal(v.length, 1, `esperava 1 violation, recebeu ${JSON.stringify(v)}`);
      assert.equal(v[0].rule, "linkedin-worker-token-set");
      // Assimetria intencional: stage-0 é error; stage-5 é warning (graceful degrade pra Make webhook).
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /DIARIA_LINKEDIN_CRON_TOKEN/);
    } finally {
      if (original !== undefined) process.env.DIARIA_LINKEDIN_CRON_TOKEN = original;
    }
  });

  it("linkedin-worker-token-set ok quando DIARIA_LINKEDIN_CRON_TOKEN setado", () => {
    const original = process.env.DIARIA_LINKEDIN_CRON_TOKEN;
    process.env.DIARIA_LINKEDIN_CRON_TOKEN = "test-bearer-token";
    try {
      const v = checkCloudflareTokenSet();
      assert.equal(v.length, 0, `esperava 0 violations, recebeu ${JSON.stringify(v)}`);
    } finally {
      if (original !== undefined) process.env.DIARIA_LINKEDIN_CRON_TOKEN = original;
      else delete process.env.DIARIA_LINKEDIN_CRON_TOKEN;
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

  describe("use-melhor-tempo (#2372)", () => {
    function getTempoRule() {
      const rule = getRulesForStage(4).find((r) => r.id === "use-melhor-tempo");
      assert.ok(rule, "use-melhor-tempo deve estar registrado no Stage 4");
      return rule!;
    }

    it("registrado no Stage 4 (não Stage 2 — roda pós-gate)", () => {
      assert.ok(getRulesForStage(4).some((r) => r.id === "use-melhor-tempo"));
      assert.ok(!getRulesForStage(2).some((r) => r.id === "use-melhor-tempo"));
    });

    it("falha quando item USE MELHOR sem estimativa de tempo (severity=error, gate-blocking — #2447)", () => {
      // REGRESSÃO #2447 (opção a): regra promovida de warning→error.
      // stitch-newsletter.ts injeta `(X min)` automaticamente (#2447 opção b),
      // então um item sem tempo no Stage 4 indica edição manual que removeu a estimativa.
      // severity=error garante que o pipeline TRAVA nesse caso — a rede de segurança.
      writeFileSync(
        join(fixture, "02-reviewed.md"),
        `**🛠️ USE MELHOR**\n\n**[Tutorial](https://x.com/t)**\nComo usar ChatGPT no trabalho\n\n---\n`,
      );
      const v = getTempoRule().run(fixture);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "use-melhor-tempo");
      assert.equal(v[0].severity, "error", "use-melhor-tempo deve ser error (gate-blocking) — #2447");
      assert.match(v[0].message, /sem estimativa de tempo/);
      rmSync(fixture, { recursive: true, force: true });
    });

    it("passa com tempo em parênteses '(N min)' (formato canônico)", () => {
      writeFileSync(
        join(fixture, "02-reviewed.md"),
        `**🛠️ USE MELHOR**\n\n**[Tutorial](https://x.com/t)**\nComo usar ChatGPT no trabalho (5 min)\n\n---\n`,
      );
      const v = getTempoRule().run(fixture);
      assert.equal(v.length, 0, JSON.stringify(v));
      rmSync(fixture, { recursive: true, force: true });
    });

    it("passa quando 02-reviewed.md ausente (não bloqueia setup parcial)", () => {
      const v = getTempoRule().run(fixture);
      assert.equal(v.length, 0);
      rmSync(fixture, { recursive: true, force: true });
    });
  });

  describe("use-melhor-sentinel (#2464 finding 2)", () => {
    // #2464 finding 2: o sentinel [DESCRIÇÃO PENDENTE] satisfaz o check de tempo
    // (stitch appenda "(X min)") mas não deve chegar ao leitor.
    // Este check rejeita itens que ainda têm o placeholder não-preenchido.

    it("registrado no Stage 4 (gate-blocking, severity=error)", () => {
      const rule = getRulesForStage(4).find((r) => r.id === "use-melhor-sentinel");
      assert.ok(rule, "use-melhor-sentinel deve estar registrado no Stage 4");
    });

    it("falha quando 02-reviewed.md contém '[DESCRIÇÃO PENDENTE]' (severity=error)", () => {
      writeFileSync(
        join(fixture, "02-reviewed.md"),
        `**🛠️ USE MELHOR**\n\n**[Tutorial](https://x.com/t)**\n[DESCRIÇÃO PENDENTE] (5 min)\n\n---\n`,
      );
      const rule = getRulesForStage(4).find((r) => r.id === "use-melhor-sentinel")!;
      const v = rule.run(fixture);
      assert.equal(v.length, 1, "deve detectar o sentinel");
      assert.equal(v[0].rule, "use-melhor-sentinel");
      assert.equal(v[0].severity, "error", "sentinel deve ser error (gate-blocking) — #2464");
      assert.match(v[0].message, /DESCRIÇÃO PENDENTE/, "mensagem deve mencionar o sentinel");
      rmSync(fixture, { recursive: true, force: true });
    });

    it("passa quando 02-reviewed.md não contém '[DESCRIÇÃO PENDENTE]'", () => {
      writeFileSync(
        join(fixture, "02-reviewed.md"),
        `**🛠️ USE MELHOR**\n\n**[Tutorial](https://x.com/t)**\nComo usar ChatGPT no trabalho (5 min)\n\n---\n`,
      );
      const rule = getRulesForStage(4).find((r) => r.id === "use-melhor-sentinel")!;
      const v = rule.run(fixture);
      assert.equal(v.length, 0, JSON.stringify(v));
      rmSync(fixture, { recursive: true, force: true });
    });

    it("passa quando 02-reviewed.md ausente (não bloqueia setup parcial)", () => {
      const rule = getRulesForStage(4).find((r) => r.id === "use-melhor-sentinel")!;
      const v = rule.run(fixture);
      assert.equal(v.length, 0);
      rmSync(fixture, { recursive: true, force: true });
    });
  });

  describe("narrative-not-generic-placeholder (#2377 hotfix)", () => {
    // REGRESSÃO: regra rebaixada de error→warning (hotfix #2377/#2372).
    // O sinal continua aparecendo mas NÃO deve causar exit 1.

    it("registrado no Stage 4", () => {
      assert.ok(getRulesForStage(4).some((r) => r.id === "narrative-not-generic-placeholder"));
    });

    it("dispara warning (não error) quando narrative é placeholder genérico do sorteio (#2377 hotfix)", () => {
      // Fixtures usando prosa genérica real que o editor habitualmente usa —
      // exatamente o caso que causou o bloqueio nas edições 260617 e 260618.
      const genericNarrative = "há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio";
      writeFileSync(
        join(fixture, "02-reviewed.md"),
        `**ERRO INTENCIONAL**\n\nNessa edição, ${genericNarrative}.\n\n---\n`,
      );
      const v = checkNarrativeNotGenericPlaceholder(fixture);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "narrative-not-generic-placeholder");
      assert.equal(v[0].severity, "warning", "narrative-not-generic-placeholder deve ser warning (não error) — hotfix #2377");
      assert.match(v[0].message, /placeholder genérico/);
      rmSync(fixture, { recursive: true, force: true });
    });

    it("passa silenciosamente quando narrative é declaração real de primeira pessoa", () => {
      writeFileSync(
        join(fixture, "02-reviewed.md"),
        `**ERRO INTENCIONAL**\n\nNessa edição, escrevi que Karpathy cofundou a OpenAI em 1914, quando o correto é 2015.\n\n---\n`,
      );
      const v = checkNarrativeNotGenericPlaceholder(fixture);
      assert.equal(v.length, 0, JSON.stringify(v));
      rmSync(fixture, { recursive: true, force: true });
    });

    it("passa silenciosamente quando 02-reviewed.md ausente", () => {
      const v = checkNarrativeNotGenericPlaceholder(fixture);
      assert.equal(v.length, 0);
      rmSync(fixture, { recursive: true, force: true });
    });

    // (#2438 Item 2 — caso 3) Sem reveal dedicado E sem narrative válido → warning não-blocking.
    it("#2438 caso 3: só description no frontmatter + sem reveal + sem narrative → warning não-blocking", () => {
      // Cenário real: editor preencheu description (catálogo) mas não preencheu
      // reveal nem narrative — o reveal da próxima edição cairia no fallback genérico.
      // Deve emitir warning (não error) E a edição deve passar o gate (verde).
      const fixture2 = makeFixtureEdition();
      try {
        writeFileSync(
          join(fixture2, "02-reviewed.md"),
          [
            "---",
            "intentional_error:",
            '  description: "DESTAQUE 2 lista o Spotify entre os assistentes de IA"',
            '  location: "DESTAQUE 2"',
            '  category: "factual"',
            '  correct_value: "Perplexity ou Copilot"',
            "---",
            "",
            "**ERRO INTENCIONAL**",
            "",
            "Na última edição, foo.",
            "",
            "Nessa edição, há um erro proposital escondido em um dos destaques. Responda este e-mail com a correção para concorrer ao sorteio.",
            "",
            "---",
          ].join("\n"),
        );
        const v = checkNarrativeNotGenericPlaceholder(fixture2);
        // Deve emitir warning (corpo genérico já dispara antes do caso 3 neste fixture)
        assert.equal(v.length, 1);
        assert.equal(v[0].severity, "warning",
          "#2438 caso 3: violation deve ser warning, não error — edição passa o gate");
      } finally {
        rmSync(fixture2, { recursive: true, force: true });
      }
    });

    it("#2438 caso 3: ERRO INTENCIONAL block sem qualquer fonte válida (sem narrative no corpo) → warning", () => {
      // Caso mais puro do caso 3: bloco ERRO INTENCIONAL presente mas sem linha
      // "Nessa edição," — e sem reveal/narrative no frontmatter.
      // O reveal da PRÓXIMA edição seria o fallback genérico seguro.
      const fixture3 = makeFixtureEdition();
      try {
        writeFileSync(
          join(fixture3, "02-reviewed.md"),
          [
            "---",
            "intentional_error:",
            '  description: "DESTAQUE 2 lista o Spotify"',
            '  location: "DESTAQUE 2"',
            '  category: "factual"',
            '  correct_value: "Perplexity"',
            "---",
            "",
            "**ERRO INTENCIONAL**",
            "",
            "Na última edição, foo.",
            "",
            "---",
          ].join("\n"),
        );
        const v = checkNarrativeNotGenericPlaceholder(fixture3);
        assert.equal(v.length, 1, "deve emitir 1 violation (caso 3 — fallback garantido)");
        assert.equal(v[0].severity, "warning",
          "#2438 caso 3: severity deve ser warning (não blocking)");
        assert.match(v[0].message, /sem campo.*reveal.*sem fonte válida|fallback seguro/i,
          "mensagem deve mencionar ausência de fonte de reveal");
        assert.equal(v[0].source_issue, "#2438");
      } finally {
        rmSync(fixture3, { recursive: true, force: true });
      }
    });

    it("#2438 caso 3: com reveal field preenchido → sem violation (não é caso 3)", () => {
      // Se o campo reveal está preenchido com prosa válida, não há caso 3.
      const fixture4 = makeFixtureEdition();
      try {
        writeFileSync(
          join(fixture4, "02-reviewed.md"),
          [
            "---",
            "intentional_error:",
            '  description: "DESTAQUE 2 lista o Spotify"',
            '  reveal: "Na última edição, listei o Spotify como assistente de IA, o correto é Perplexity."',
            '  location: "DESTAQUE 2"',
            "---",
            "",
            "**ERRO INTENCIONAL**",
            "",
            "Na última edição, foo.",
            "",
            "---",
          ].join("\n"),
        );
        const v = checkNarrativeNotGenericPlaceholder(fixture4);
        assert.equal(v.length, 0,
          "com reveal field válido não deve haver violation de caso 3");
      } finally {
        rmSync(fixture4, { recursive: true, force: true });
      }
    });

    it("#2438 caso 3: sem ERRO INTENCIONAL block → sem violation (feature não declarada)", () => {
      // Se o MD não tem o bloco ERRO INTENCIONAL, o editor não está usando a feature
      // nessa edição → não emitir caso 3 warning.
      const fixture5 = makeFixtureEdition();
      try {
        writeFileSync(
          join(fixture5, "02-reviewed.md"),
          [
            "OUTRAS NOTÍCIAS",
            "",
            "Item sem ERRO INTENCIONAL.",
            "",
            "---",
            "",
            "**ASSINE**",
            "",
          ].join("\n"),
        );
        const v = checkNarrativeNotGenericPlaceholder(fixture5);
        assert.equal(v.length, 0,
          "sem bloco ERRO INTENCIONAL → sem violation de caso 3");
      } finally {
        rmSync(fixture5, { recursive: true, force: true });
      }
    });
  });

  describe("e2e: check-invariants --stage 4 use-melhor-tempo é gate-blocking + narrative-not-generic-placeholder (#2447/#2377)", () => {
    // #2447 (opção a): use-melhor-tempo promovida para error (gate-blocking).
    // stitch injeta (X min) automaticamente — item sem tempo no Stage 4 = edição manual removeu.
    // narrative-not-generic-placeholder permanece warning (não bloqueia).
    it("exit 1 quando única violation é use-melhor-tempo (error, gate-blocking — #2447)", () => {
      const fixture2 = makeFixtureEdition();
      // Escrever 02-reviewed.md com item USE MELHOR sem tempo (dispara a regra)
      // e sem narrative genérica (para isolar o caso de use-melhor-tempo).
      writeFileSync(
        join(fixture2, "02-reviewed.md"),
        `**🛠️ USE MELHOR**\n\n**[Tutorial](https://x.com/t)**\nComo usar ChatGPT no trabalho\n\n---\n`,
      );
      // Invocar checkUseMelhorTempoConsistent via a regra registrada
      const rule = getRulesForStage(4).find((r) => r.id === "use-melhor-tempo")!;
      const v = rule.run(fixture2);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "error", "use-melhor-tempo deve ser error (gate-blocking) → causa exit 1 — #2447");
      rmSync(fixture2, { recursive: true, force: true });
    });

    it("exit 0 quando única violation é narrative-not-generic-placeholder (warning, não error)", () => {
      const fixture2 = makeFixtureEdition();
      const genericNarrative = "responda este e-mail com a correção para concorrer ao sorteio mensal";
      writeFileSync(
        join(fixture2, "02-reviewed.md"),
        `**ERRO INTENCIONAL**\n\nNessa edição, ${genericNarrative}.\n\n---\n`,
      );
      const rule = getRulesForStage(4).find((r) => r.id === "narrative-not-generic-placeholder")!;
      const v = rule.run(fixture2);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning", "narrative-not-generic-placeholder deve ser warning → não causa exit 1");
      rmSync(fixture2, { recursive: true, force: true });
    });
  });

});

describe("Stage 5 invariants (pós-publicação)", () => {
  let fixture: string;

  beforeEach(() => {
    fixture = makeFixtureEdition();
  });

  // --- #2172: checkLinkedinWorkerUrlSet + checkLinkedinWorkerUrlHttps (Stage 5) ---

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

  it("linkedin-worker-url-set ok (0 violations) quando URL é HTTP — esquema verificado pela função separada", () => {
    // #2172: após o split, checkLinkedinWorkerUrlSet NÃO emite mais linkedin-worker-url-https.
    // Checar que a função de presença não polui a de esquema.
    const original = process.env.DIARIA_LINKEDIN_CRON_URL;
    process.env.DIARIA_LINKEDIN_CRON_URL = "http://insecure.example/fire";
    try {
      const v = checkLinkedinWorkerUrlSet();
      assert.equal(v.length, 0, `checkLinkedinWorkerUrlSet não deve emitir nada quando URL presente (mesmo HTTP): ${JSON.stringify(v)}`);
    } finally {
      if (original !== undefined) process.env.DIARIA_LINKEDIN_CRON_URL = original;
      else delete process.env.DIARIA_LINKEDIN_CRON_URL;
    }
  });

  // --- #2172: checkLinkedinWorkerUrlHttps — regressão + novos casos (findings 1/2/3) ---

  it("#2172 URL HTTP presente → exatamente 1 violation linkedin-worker-url-https (era 2, o bug)", () => {
    const original = process.env.DIARIA_LINKEDIN_CRON_URL;
    process.env.DIARIA_LINKEDIN_CRON_URL = "http://insecure.example/fire";
    try {
      const v = checkLinkedinWorkerUrlHttps();
      assert.equal(v.length, 1, `esperava 1 violation, recebeu ${JSON.stringify(v)}`);
      assert.equal(v[0].rule, "linkedin-worker-url-https");
      assert.equal(v[0].severity, "error");
    } finally {
      if (original !== undefined) process.env.DIARIA_LINKEDIN_CRON_URL = original;
      else delete process.env.DIARIA_LINKEDIN_CRON_URL;
    }
  });

  it("#2172 URL ausente → 0 violations de linkedin-worker-url-https (checkLinkedinWorkerUrlHttps não duplica o ausente)", () => {
    const original = process.env.DIARIA_LINKEDIN_CRON_URL;
    delete process.env.DIARIA_LINKEDIN_CRON_URL;
    try {
      const v = checkLinkedinWorkerUrlHttps();
      assert.equal(v.length, 0, `esperava 0 violations de -https quando URL ausente: ${JSON.stringify(v)}`);
    } finally {
      if (original !== undefined) process.env.DIARIA_LINKEDIN_CRON_URL = original;
    }
  });

  it("#2172 URL HTTPS válida → 0 violations", () => {
    const original = process.env.DIARIA_LINKEDIN_CRON_URL;
    process.env.DIARIA_LINKEDIN_CRON_URL = "https://worker.example.com/queue";
    try {
      const vSet = checkLinkedinWorkerUrlSet();
      const vHttps = checkLinkedinWorkerUrlHttps();
      assert.equal(vSet.length, 0, `checkLinkedinWorkerUrlSet deve ser 0 com HTTPS: ${JSON.stringify(vSet)}`);
      assert.equal(vHttps.length, 0, `checkLinkedinWorkerUrlHttps deve ser 0 com HTTPS: ${JSON.stringify(vHttps)}`);
    } finally {
      if (original !== undefined) process.env.DIARIA_LINKEDIN_CRON_URL = original;
      else delete process.env.DIARIA_LINKEDIN_CRON_URL;
    }
  });

  it("#2172 finding 1: URL com espaço à esquerda não dá falso-positivo (trim antes do regex)", () => {
    // " https://worker.example.com" — passa o guard de vazio mas sem trim falha ^https://
    const original = process.env.DIARIA_LINKEDIN_CRON_URL;
    process.env.DIARIA_LINKEDIN_CRON_URL = "  https://worker.example.com/queue";
    try {
      const v = checkLinkedinWorkerUrlHttps();
      assert.equal(v.length, 0, `URL com espaço à esquerda não deve gerar violation: ${JSON.stringify(v)}`);
    } finally {
      if (original !== undefined) process.env.DIARIA_LINKEDIN_CRON_URL = original;
      else delete process.env.DIARIA_LINKEDIN_CRON_URL;
    }
  });

  it("#2172 finding 2: HTTPS:// maiúsculo não dá falso-positivo (regex case-insensitive)", () => {
    // RFC 3986: scheme é case-insensitive — HTTPS:// é equivalente a https://
    const original = process.env.DIARIA_LINKEDIN_CRON_URL;
    process.env.DIARIA_LINKEDIN_CRON_URL = "HTTPS://worker.example.com/queue";
    try {
      const v = checkLinkedinWorkerUrlHttps();
      assert.equal(v.length, 0, `HTTPS:// maiúsculo não deve gerar violation: ${JSON.stringify(v)}`);
    } finally {
      if (original !== undefined) process.env.DIARIA_LINKEDIN_CRON_URL = original;
      else delete process.env.DIARIA_LINKEDIN_CRON_URL;
    }
  });

  it("#2172 finding 3: credencial inline não vaza na mensagem de erro", () => {
    // http://user:token@host/path — esquema HTTP deve gerar violation, mas msg não inclui credencial
    const original = process.env.DIARIA_LINKEDIN_CRON_URL;
    process.env.DIARIA_LINKEDIN_CRON_URL = "http://user:supersecrettoken@worker.example.com/queue";
    try {
      const v = checkLinkedinWorkerUrlHttps();
      assert.equal(v.length, 1, `deve detectar HTTP: ${JSON.stringify(v)}`);
      assert.ok(
        !v[0].message.includes("supersecrettoken"),
        `mensagem de erro não deve conter credencial: ${v[0].message}`,
      );
    } finally {
      if (original !== undefined) process.env.DIARIA_LINKEDIN_CRON_URL = original;
      else delete process.env.DIARIA_LINKEDIN_CRON_URL;
    }
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

// ─── #2487: checkEditionUrlFile — severity ordering ─────────────────────────
// Regressão: placeholder `{edition_url}` deve produzir severity=error ANTES
// do check genérico de https:// (que produzia severity=warning e tornava o
// check específico do placeholder inalcançável).

describe("checkEditionUrlFile — severity ordering (#2487)", () => {
  let fixture: string;
  before(() => {
    fixture = mkdtempSync(join(tmpdir(), "diaria-edition-url-"));
    mkdirSync(join(fixture, "_internal"), { recursive: true });
  });
  after(() => { rmSync(fixture, { recursive: true, force: true }); });

  it("placeholder {edition_url} → severity=error (não warning)", () => {
    writeFileSync(
      join(fixture, "_internal", "05-edition-url.txt"),
      "{edition_url}",
    );
    const v = checkEditionUrlFile(fixture);
    assert.equal(v.length, 1, "deve emitir exatamente 1 violation");
    assert.equal(v[0].rule, "edition-url-file-valid");
    assert.equal(v[0].severity, "error",
      "placeholder {edition_url} deve ser severity=error, não warning");
    assert.ok(v[0].message.includes("{edition_url}"),
      "mensagem deve mencionar o placeholder literal");
  });

  it("valor sem https:// (não placeholder) → severity=warning", () => {
    writeFileSync(
      join(fixture, "_internal", "05-edition-url.txt"),
      "http://diar.ia.br/p/teste",
    );
    const v = checkEditionUrlFile(fixture);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning",
      "URL com esquema inválido (mas não placeholder) deve ser warning");
  });

  it("URL HTTPS válida → sem violation", () => {
    writeFileSync(
      join(fixture, "_internal", "05-edition-url.txt"),
      "https://diar.ia.br/p/titulo-da-edicao",
    );
    const v = checkEditionUrlFile(fixture);
    assert.equal(v.length, 0, "URL HTTPS válida não deve emitir violation");
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
