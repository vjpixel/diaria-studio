import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectEventOverlap,
  detectSubjectThemeOverlap,
  buildRepeatThemeResult,
  REPEAT_THEME_WARN_THRESHOLD,
} from "../scripts/lib/repeat-theme-check.ts";
import { extractPastDestaqueTitles } from "../scripts/lib/past-editions-extract.ts";
import { flattenCategorized } from "../scripts/check-repeat-theme.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// #8896 — caso real: D1 260928 (Wired: "agente da OpenAI invadiu o sistema
// de saúde australiano") é o mesmo evento do D1 260925 (Guardian: "Agente
// rebelde invade sistema de governo"). Jaccard de título ~0.22 — abaixo do
// threshold de REMOÇÃO do dedup.ts (0.55-0.60), mas o gap era não ter NENHUM
// sinal mais fraco pra avisar o editor.
// ---------------------------------------------------------------------------

const REAL_CASE_CANDIDATE_TITLE = "agente da OpenAI invadiu o sistema de saúde australiano";
const REAL_CASE_PAST_DESTAQUE_TITLE = "Agente rebelde invade sistema de governo";

describe("detectEventOverlap (#8896)", () => {
  it("flagga o caso real (D1 Wired 260928 x D1 Guardian 260925 — mesmo evento, fontes diferentes)", () => {
    const matches = detectEventOverlap(
      [{ title: REAL_CASE_CANDIDATE_TITLE, url: "https://wired.com/agente-saude-australia" }],
      [{ title: REAL_CASE_PAST_DESTAQUE_TITLE, aammdd: "260925", url: "https://theguardian.com/agente-governo" }],
    );
    assert.equal(matches.length, 1, "deveria flagar 1 match para o par real");
    assert.ok(matches[0].jaccard >= REPEAT_THEME_WARN_THRESHOLD, `jaccard ${matches[0].jaccard} deveria estar >= ${REPEAT_THEME_WARN_THRESHOLD}`);
    assert.ok(matches[0].jaccard < 0.55, "jaccard deveria continuar abaixo do threshold de remoção do dedup.ts (0.55) — é warning, não dedup hard");
    assert.equal(matches[0].pastAammdd, "260925");
  });

  it("NÃO flagga duas notícias de IA genuinamente diferentes (caso negativo — evita ruído)", () => {
    const matches = detectEventOverlap(
      [{ title: "OpenAI lança GPT-6 com melhor raciocínio matemático", url: "https://a.com/x" }],
      [{ title: "Google anuncia Gemini 4 para desenvolvedores", aammdd: "260925", url: "https://b.com/y" }],
    );
    assert.equal(matches.length, 0, "títulos sem overlap de conteúdo não devem disparar warning");
  });

  it("não dispara com título vazio/sem token significativo (degeneração segura)", () => {
    const matches = detectEventOverlap(
      [{ title: "", url: "https://a.com/x" }],
      [{ title: REAL_CASE_PAST_DESTAQUE_TITLE, aammdd: "260925" }],
    );
    assert.equal(matches.length, 0);
  });

  it("sem destaques passados, nunca flagga nada (mapa vazio)", () => {
    const matches = detectEventOverlap([{ title: REAL_CASE_CANDIDATE_TITLE }], []);
    assert.equal(matches.length, 0);
  });
});

describe("buildRepeatThemeResult", () => {
  it("flagged=true e theme descreve o melhor match quando há eventMatches", () => {
    const eventMatches = detectEventOverlap(
      [{ title: REAL_CASE_CANDIDATE_TITLE, url: "https://wired.com/x" }],
      [{ title: REAL_CASE_PAST_DESTAQUE_TITLE, aammdd: "260925" }],
    );
    const result = buildRepeatThemeResult(eventMatches, []);
    assert.equal(result.flagged, true);
    assert.ok(result.theme?.includes("260925"), "theme deveria citar a edição passada");
  });

  it("flagged=false e theme=null quando nenhum sinal dispara", () => {
    const result = buildRepeatThemeResult([], []);
    assert.equal(result.flagged, false);
    assert.equal(result.theme, null);
  });

  it("subjectMatches sozinho também flagga (sinal 1, mecanismo original #1475)", () => {
    const subjectMatches = detectSubjectThemeOverlap(
      [{ title: "SoberanIA é o novo destaque do governo", url: "https://x.com" }],
      new Set(["soberania"]),
    );
    const result = buildRepeatThemeResult([], subjectMatches);
    assert.equal(result.flagged, subjectMatches.length > 0);
  });
});

describe("extractPastDestaqueTitles (#8896)", () => {
  it("lê só highlights[] (nunca runners_up/buckets) das últimas `window` edições, com aammdd", () => {
    const dir = mkdtempSync(join(tmpdir(), "ed-repeat-theme-"));
    try {
      mkdirSync(join(dir, "260925", "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "260925", "_internal", "01-approved.json"),
        JSON.stringify({
          highlights: [
            { article: { url: "https://theguardian.com/agente-governo", title: REAL_CASE_PAST_DESTAQUE_TITLE } },
          ],
          runners_up: [{ article: { url: "https://x.com/runner", title: "Não deveria aparecer" } }],
          radar: [{ url: "https://x.com/radar", title: "Também não deveria aparecer" }],
        }),
      );
      const titles = extractPastDestaqueTitles(dir, 3);
      assert.equal(titles.length, 1);
      assert.equal(titles[0].title, REAL_CASE_PAST_DESTAQUE_TITLE);
      assert.equal(titles[0].aammdd, "260925");
      assert.ok(!titles.some((t) => t.title.includes("Não deveria")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exclui a edição corrente (self-match, mesmo padrão do #1856)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ed-repeat-theme-self-"));
    try {
      mkdirSync(join(dir, "260928", "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "260928", "_internal", "01-approved.json"),
        JSON.stringify({ highlights: [{ article: { url: "https://wired.com/x", title: REAL_CASE_CANDIDATE_TITLE } }] }),
      );
      const included = extractPastDestaqueTitles(dir, 3);
      assert.ok(included.some((t) => t.title === REAL_CASE_CANDIDATE_TITLE));
      const excluded = extractPastDestaqueTitles(dir, 3, "260928");
      assert.ok(!excluded.some((t) => t.title === REAL_CASE_CANDIDATE_TITLE));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("flattenCategorized", () => {
  it("achata os 4 buckets num array único, preservando bucket de origem", () => {
    const flat = flattenCategorized({
      lancamento: [{ title: "L1", url: "https://x/l1" }],
      radar: [{ title: "R1", url: "https://x/r1" }],
      use_melhor: [{ title: "U1", url: "https://x/u1" }],
      video: [{ title: "V1", url: "https://x/v1" }],
    });
    assert.equal(flat.length, 4);
    assert.ok(flat.some((c) => c.bucket === "lancamento" && c.title === "L1"));
    assert.ok(flat.some((c) => c.bucket === "video" && c.title === "V1"));
  });

  it("bucket ausente/não-array não quebra (fail-soft)", () => {
    const flat = flattenCategorized({ lancamento: [{ title: "L1" }] } as any);
    assert.equal(flat.length, 1);
  });
});

// ---------------------------------------------------------------------------
// End-to-end CLI (#8896) — reproduz o caso real via subprocess, mesmo padrão
// de invocação que `.claude/agents/orchestrator-stage-1-research.md` §1w-quint-b
// documenta.
// ---------------------------------------------------------------------------

describe("check-repeat-theme.ts — CLI e2e (#8896)", () => {
  it("reproduz o caso real: candidato do dia flagado contra destaque de edição recente", () => {
    const dir = mkdtempSync(join(tmpdir(), "ed-repeat-theme-cli-"));
    try {
      // Edição passada (260925) com o D1 do Guardian.
      mkdirSync(join(dir, "260925", "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "260925", "_internal", "01-approved.json"),
        JSON.stringify({
          highlights: [
            { article: { url: "https://theguardian.com/agente-governo", title: REAL_CASE_PAST_DESTAQUE_TITLE } },
          ],
        }),
      );

      // Edição corrente (260928) com o candidato do Wired em tmp-categorized.json.
      mkdirSync(join(dir, "260928", "_internal"), { recursive: true });
      const categorizedPath = join(dir, "260928", "_internal", "tmp-categorized.json");
      writeFileSync(
        categorizedPath,
        JSON.stringify({
          lancamento: [],
          radar: [{ url: "https://wired.com/agente-saude-australia", title: REAL_CASE_CANDIDATE_TITLE, summary: "Um agente de IA acessou dados sensíveis." }],
          use_melhor: [],
          video: [],
        }),
      );

      const pastEditionsPath = join(dir, "past-editions.md");
      writeFileSync(pastEditionsPath, "# Últimas edições publicadas — para dedup\n\n---\n");

      const stdout = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve(ROOT, "scripts/check-repeat-theme.ts"),
          "--categorized",
          categorizedPath,
          "--past-editions",
          pastEditionsPath,
          "--editions-dir",
          dir,
          "--window",
          "3",
        ],
        { encoding: "utf8" },
      );

      const result = JSON.parse(stdout.trim().split("\n").pop()!);
      assert.equal(result.flagged, true, "CLI deveria flagar o caso real end-to-end");
      assert.equal(result.eventMatches.length, 1);
      assert.equal(result.eventMatches[0].pastAammdd, "260925");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nunca lança/bloqueia quando --categorized não existe (fail-soft)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ed-repeat-theme-missing-"));
    try {
      const stdout = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          resolve(ROOT, "scripts/check-repeat-theme.ts"),
          "--categorized",
          join(dir, "nao-existe.json"),
        ],
        { encoding: "utf8" },
      );
      const result = JSON.parse(stdout.trim().split("\n").pop()!);
      assert.equal(result.flagged, false);
      assert.equal(result.theme, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
