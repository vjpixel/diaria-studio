/**
 * test/lint-checks-cli-md-prologue-14063.test.ts
 *
 * Caracterização do prólogo de leitura de `--md` dos handlers de
 * `scripts/lib/lint-checks/cli/` (#14063). Escrito ANTES da fatoração em
 * `readMdArg`/`resolveMdArg` (`cli/_shared.ts`) e mantido depois: trava a
 * mensagem exata e o exit code dos dois erros de uso (sem `--md`, arquivo
 * inexistente) e confere que um arquivo vazio passa pelo prólogo.
 *
 * Fora daqui, de propósito (prólogo diferente, não unificado no #14063):
 * `eia-answer` e `intentional-error-flagged` (sem `existsSync`, o check
 * trata a ausência), `section-counts` e `secondary-item-coherence` (exigem
 * também `--approved`, mensagem "Arquivo não encontrado"), e
 * `agradecimento-hardcoded` (lê `--snippet`, não `--md`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Handler = (args: Record<string, string>, root: string) => void;

class ExitCalled extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

interface RunOutcome {
  exitCode: number | undefined | "no-exit";
  errors: string[];
  thrown?: unknown;
}

function runCaptured(handler: Handler, args: Record<string, string>, root: string): RunOutcome {
  const errors: string[] = [];
  const origExit = process.exit;
  const origError = console.error;
  const origLog = console.log;
  const origWarn = console.warn;
  let exitCode: RunOutcome["exitCode"] = "no-exit";
  let thrown: unknown;
  process.exit = ((code?: number) => {
    throw new ExitCalled(code);
  }) as typeof process.exit;
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  };
  console.log = () => {};
  console.warn = () => {};
  try {
    handler(args, root);
  } catch (e) {
    if (e instanceof ExitCalled) exitCode = e.code;
    else thrown = e;
  } finally {
    process.exit = origExit;
    console.error = origError;
    console.log = origLog;
    console.warn = origWarn;
  }
  return { exitCode, errors, thrown };
}

const CLI = "../scripts/lib/lint-checks/cli";

// [nome do check, módulo, export]
const HANDLERS: Array<[string, string, string]> = [
  ["titles-per-highlight", "titles-per-highlight", "runCli"],
  ["title-length", "title-length", "runCli"],
  ["title-card-4x5", "title-length", "runCardCli"],
  ["title-email-subject", "title-length", "runSubjectCli"],
  ["why-matters-format", "why-matters-format", "runCli"],
  ["eai-section", "eai-section", "runCli"],
  ["erro-intencional-placeholder", "erro-intencional-placeholder", "runCli"],
  ["erro-intencional-narrative-generico", "erro-intencional-narrative-generico", "runCli"],
  ["destaque-min-chars", "destaque-min-chars", "runCli"],
  ["destaque-max-chars", "destaque-max-chars", "runCli"],
  ["why-matters-length", "why-matters-length", "runCli"],
  ["section-item-format", "section-item-format", "runCli"],
  ["intro-count", "intro-count", "runCli"],
  ["coverage-line-format", "coverage-line-format", "runCli"],
  ["multiline-links", "multiline-links", "runCli"],
  ["relative-time", "relative-time", "runCli"],
  ["use-melhor-tempo", "use-melhor-tempo", "runCli"],
  ["secondary-items-have-summary", "secondary-items-have-summary", "runCli"],
  ["title-publisher-suffix", "title-publisher-suffix", "runCli"],
  ["title-trailing-period", "title-trailing-period", "runCli"],
  ["title-mentions-ia", "title-mentions-ia", "runCli"],
  ["title-clickbait-vulgar", "title-clickbait-vulgar", "runCli"],
  ["title-ia-as-agent", "title-ia-as-agent", "runCli"],
  ["title-shorts-front-load", "title-shorts-front-load", "runCli"],
  ["no-trailing-ellipsis", "no-trailing-ellipsis", "runCli"],
  ["radar-summary-matches-title", "radar-summary-matches-title", "runCli"],
  ["mid-sentence-ellipsis", "mid-sentence-ellipsis", "runCli"],
  ["no-untranslated-summary", "no-untranslated-summary", "runCli"],
  ["pool-summary-quality", "pool-summary-quality", "runCli"],
  ["video-links-are-youtube", "video-links-are-youtube", "runCli"],
  ["section-links-resolve", "section-links-resolve", "runCli"],
  ["aprofunde-format", "aprofunde-format", "runCli"],
  ["callout-placement", "callout-placement", "runCli"],
  ["stacked-intro-callouts", "stacked-intro-callouts", "runCli"],
  ["orphan-box-in-gap", "orphan-box-in-gap", "runCli"],
  ["no-xml-artifacts", "no-xml-artifacts", "runCli"],
  ["banned-lexicon", "banned-lexicon", "runCli"],
  ["destaque-category-noticias", "destaque-category-noticias", "runCli"],
  ["snippet-staleness", "snippet-staleness", "runCli"],
];

async function loadHandler(mod: string, exp: string): Promise<Handler> {
  const m = (await import(`${CLI}/${mod}.ts`)) as Record<string, unknown>;
  const fn = m[exp];
  assert.equal(typeof fn, "function", `${mod}.ts não exporta ${exp}`);
  return fn as Handler;
}

for (const [check, mod, exp] of HANDLERS) {
  test(`#14063 ${check}: sem --md sai 2 com a mensagem de uso`, async () => {
    const handler = await loadHandler(mod, exp);
    const root = mkdtempSync(join(tmpdir(), "md-prologue-14063-"));
    try {
      const usage = `Uso: lint-newsletter-md.ts --check ${check} --md <md-path>`;
      const cases: Array<Record<string, string>> = [{}, { md: "" }];
      for (const args of cases) {
        const out = runCaptured(handler, args, root);
        assert.equal(out.exitCode, 2);
        assert.deepEqual(out.errors, [usage]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`#14063 ${check}: arquivo inexistente sai 2 com o caminho resolvido`, async () => {
    const handler = await loadHandler(mod, exp);
    const root = mkdtempSync(join(tmpdir(), "md-prologue-14063-"));
    try {
      const out = runCaptured(handler, { md: "nao-existe/02-reviewed.md" }, root);
      assert.equal(out.exitCode, 2);
      assert.deepEqual(out.errors, [
        `Arquivo não existe: ${resolve(root, "nao-existe/02-reviewed.md")}`,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`#14063 ${check}: arquivo vazio passa pelo prólogo`, async () => {
    const handler = await loadHandler(mod, exp);
    const root = mkdtempSync(join(tmpdir(), "md-prologue-14063-"));
    try {
      writeFileSync(join(root, "vazio.md"), "");
      const out = runCaptured(handler, { md: "vazio.md" }, root);
      for (const e of out.errors) {
        assert.doesNotMatch(e, /^Uso: lint-newsletter-md\.ts/);
        assert.doesNotMatch(e, /^Arquivo não existe:/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
