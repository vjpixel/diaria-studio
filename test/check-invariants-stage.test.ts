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
  checkLinkedinWorkerUrlSet,
  checkFbPageIdSet,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import {
  checkStep4Sentinel,
  checkSocialPublishedComplete,
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
    assert.equal(v.length, 2); // linkedin-schema + relative-time
    assert.ok(v.every((x) => x.rule.endsWith("-file-exists")));
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
    assert.equal(v.length, 6); // 6 imagens obrigatórias
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

  it("public-images-populated passa com shape real (images.d{N}.url)", () => {
    writeFileSync(
      join(fixture, "06-public-images.json"),
      JSON.stringify({
        images: {
          d1: { url: "https://drive.example/d1", file_id: "a" },
          d2: { url: "https://drive.example/d2", file_id: "b" },
          d3: { url: "https://drive.example/d3", file_id: "c" },
        },
      }),
    );
    const v = checkPublicImagesPopulated(fixture);
    assert.equal(v.length, 0, JSON.stringify(v));
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
