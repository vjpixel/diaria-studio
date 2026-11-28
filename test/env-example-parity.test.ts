/**
 * Paridade entre `.env.example` e as variáveis que o código lê (#14065).
 *
 * Duas direções:
 *   1. Toda var lida por `process.env.X` / `process.env["X"]` em `scripts/` e
 *      `hermes/` (fora de teste) consta no `.env.example` ou em
 *      `NOT_IN_ENV_EXAMPLE`, com o motivo de não pertencer ao `.env`.
 *   2. Toda var declarada no `.env.example` tem leitor: o nome aparece numa
 *      linha de código (não-comentário) de `scripts/`, `hermes/` ou `workers/`,
 *      ou está em `DECLARED_WITHOUT_READER` com o motivo.
 *
 * Limite conhecido da direção 1: só pega o acesso LÉXICO `process.env`. Var
 * lida por `env.X` de um objeto carregado, ou por nome guardado numa constante
 * (`process.env[NOME]`), não entra na varredura. A direção 2 é deliberadamente
 * frouxa (qualquer menção em código conta) pelo mesmo motivo.
 *
 * O teste lê só o `.env.example` e o código-fonte: nunca o `.env` real, nunca rede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Lidas pelo código, mas fora do `.env` de propósito. */
const NOT_IN_ENV_EXAMPLE: Record<string, string> = {
  // Sinal interno hook → CLI do preflight do `gh pr create` (#14216), nunca no .env.
  DIARIA_PREFLIGHT_BODY_UNKNOWN: "sinal interno do hook block-pr-create-preflight",
  // Sistema operacional / terminal / Node.
  PATH: "sistema",
  COMSPEC: "sistema (Windows)",
  FORCE_COLOR: "terminal",
  NO_COLOR: "terminal",
  NODE_TEST_CONTEXT: "setada pelo runner do node --test",
  CODEX_HOME: "variável do próprio Codex CLI (default ~/.codex)",
  // Harness do Claude Code e hooks deste repo.
  CLAUDE_CODE_EXECPATH: "harness do Claude Code",
  CLAUDE_CODE_SESSION_ID: "harness do Claude Code",
  CLAUDE_SESSION_ID: "harness do Claude Code",
  DIARIA_INJECTED_SESSION_ID: "injetada pelo hook inject-session-id",
  // GitHub Actions.
  BASE_SHA: "CI (workflow do PR)",
  HEAD_SHA: "CI (workflow do PR)",
  PR_BODY: "CI (workflow do PR)",
  PR_NUMBER: "CI (workflow do PR)",
  PR_TITLE: "CI (workflow do PR)",
  CF_TOKEN_CHECK_SKIP: "CI sem wrangler auth",
  INDEXNOW_KEY: "secret do GitHub e do Worker (docs/seo-notes.md), não do .env",
  RUN_TESTS_BATCH_TIMEOUT_MS: "ajuste do scripts/run-tests.ts (CI)",
  RUN_TESTS_BISECT_BUDGET_MS: "ajuste do scripts/run-tests.ts (CI)",
  RUN_TESTS_BISECT_TIMEOUT_MS: "ajuste do scripts/run-tests.ts (CI)",
  RUN_TESTS_RETRY_DELAY_MS: "ajuste do scripts/run-tests.ts (CI)",
  RUN_TESTS_WORKERS: "ajuste do scripts/run-tests.ts (CI)",
  // Passadas de processo pai para filho, nunca configuradas à mão.
  NM_INTEGRITY_PKG: "check-node-modules-integrity.ts passa ao filho que sonda o import",
  DIARIA_WORKER_PID_FILE: "o dispatch Brevo passa ao preload record-worker-pid.mjs (#14037)",
  DIARIA_BRUTO_PATHS: "video-bruto-local.ts passa ao filho/PowerShell que lê o bruto (#13740)",
  DIARIA_BRUTO_READER: "video-bruto-local.ts passa ao filho que lê o bruto (#13740)",
  DIARIA_BRUTO_TIMEOUT_MS: "video-bruto-local.ts passa ao filho que lê o bruto (#13740)",
  DIARIA_BRUTO_READER_ARGS: "video-bruto-local.ts passa ao filho que lê o bruto (#13740, #14405)",
  // Overrides de teste.
  DIARIA_PROJECT_ROOT: "override de raiz para teste e2e (check-invariants)",
  DIARIA_QUIET_SCHEDULE_LOG: "silencia log em CI/teste (compute-social-schedule)",
  DIARIA_DISABLE_PASTSLOT_SHIFT: "CI/testes legados (compute-social-schedule, #2565)",
  DIARIA_SOCIAL_ROTATION_LOG: "path do log de rotação apontado por teste",
  PMAX_SWAP_PLAN_OUT: "path do plano apontado por teste",
  CONTINUO_MODEL_PROMOTION_FABRICATION_CMD: "comando fabricado pelos testes do write-hermes-config",
};

/** Declaradas no `.env.example` sem leitor no código, de propósito. */
const DECLARED_WITHOUT_READER: Record<string, string> = {
  GOOGLE_PROJECT_ID: "anotação de qual projeto GCP é dono do developer token (#6450); o .env.example já diz que nada lê",
};

const READ_DIRS = ["scripts", "hermes"];
const READER_DIRS = ["scripts", "hermes", "workers"];
const CODE_EXT = /\.(ts|mts|mjs|js|cjs)$/;
const READER_EXT = /\.(ts|mts|mjs|js|cjs|sh|py)$/;
const TEST_FILE = /\.test\.(ts|mts|mjs|js)$/;

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "test" || name === "__tests__") continue;
      walk(p, ext, out);
    } else if (ext.test(name) && !TEST_FILE.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function parseEnvExampleNames(text: string): Set<string> {
  // `NOME=` ou `# NOME=` (opcional comentado) no início da linha.
  return new Set([...text.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
}

const PROCESS_ENV_RE = /process\.env(?:\.([A-Z][A-Z0-9_]+)|\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\])/g;

function processEnvReads(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(PROCESS_ENV_RE)) out.add(m[1] ?? m[2]);
  return out;
}

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("#");
}

function codeLines(source: string): string {
  return source
    .split("\n")
    .filter((l) => !isCommentLine(l))
    .join("\n");
}

const exampleNames = parseEnvExampleNames(readFileSync(join(ROOT, ".env.example"), "utf8"));

const readsByName = new Map<string, string[]>();
for (const d of READ_DIRS) {
  for (const file of walk(join(ROOT, d), CODE_EXT)) {
    for (const name of processEnvReads(readFileSync(file, "utf8"))) {
      const list = readsByName.get(name) ?? [];
      list.push(relative(ROOT, file));
      readsByName.set(name, list);
    }
  }
}

const readerCorpus = READER_DIRS.flatMap((d) => walk(join(ROOT, d), READER_EXT))
  .map((f) => codeLines(readFileSync(f, "utf8")))
  .join("\n");
const readerTokens = new Set(readerCorpus.match(/\b[A-Z][A-Z0-9_]+\b/g) ?? []);

describe(".env.example x código (#14065)", () => {
  it("a varredura acha leitores (sanidade: não passa por diretório vazio)", () => {
    assert.ok(readsByName.size > 50, `só ${readsByName.size} vars lidas; a varredura quebrou?`);
    assert.ok(exampleNames.size > 50, `só ${exampleNames.size} vars no .env.example`);
  });

  it("toda var lida por process.env consta no .env.example ou na allowlist", () => {
    const missing = [...readsByName.keys()]
      .filter((n) => !exampleNames.has(n) && !(n in NOT_IN_ENV_EXAMPLE))
      .sort()
      .map((n) => `${n} (${readsByName.get(n)!.slice(0, 3).join(", ")})`);
    assert.deepEqual(
      missing,
      [],
      "Var lida pelo código sem entrada no .env.example: declare-a lá (placeholder vazio + comentário curto) " +
        "ou, se não pertence ao .env (sistema, CI, override de teste), ponha em NOT_IN_ENV_EXAMPLE com o motivo.",
    );
  });

  it("toda var do .env.example tem leitor no código ou está na allowlist", () => {
    const dead = [...exampleNames]
      .filter((n) => !readerTokens.has(n) && !(n in DECLARED_WITHOUT_READER))
      .sort();
    assert.deepEqual(
      dead,
      [],
      "Var no .env.example sem leitor em scripts/, hermes/ ou workers/: remova-a ou justifique em DECLARED_WITHOUT_READER.",
    );
  });

  it("NOT_IN_ENV_EXAMPLE não tem entrada velha nem conflito com o .env.example", () => {
    const stale = Object.keys(NOT_IN_ENV_EXAMPLE).filter((n) => !readsByName.has(n));
    assert.deepEqual(stale, [], "entrada da allowlist que nenhum código lê mais: remova");
    const conflict = Object.keys(NOT_IN_ENV_EXAMPLE).filter((n) => exampleNames.has(n));
    assert.deepEqual(conflict, [], "var na allowlist E no .env.example: escolha um lado");
  });

  it("DECLARED_WITHOUT_READER só lista vars declaradas e de fato sem leitor", () => {
    for (const n of Object.keys(DECLARED_WITHOUT_READER)) {
      assert.ok(exampleNames.has(n), `${n} não está mais no .env.example: remova da allowlist`);
      assert.ok(!readsByName.has(n), `${n} ganhou leitor por process.env: remova da allowlist`);
      assert.ok(!readerTokens.has(n), `${n} ganhou leitor no código: remova da allowlist`);
    }
  });

  it("nenhum valor real: toda var não comentada do .env.example é placeholder ou default público", () => {
    // Guarda contra colar segredo aqui. Só estas têm default não vazio (ids e
    // versões públicas); qualquer outro valor preenchido falha.
    const allowedDefaults = new Set([
      "FACEBOOK_API_VERSION",
      "INSTAGRAM_API_VERSION",
      "THREADS_API_VERSION",
      "BEEHIIV_PUBLICATION_ID",
      "WEBSEARCH_BACKEND",
      "APOIA_SE_CAMPAIGN",
      "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
      "GOOGLE_ADS_CUSTOMER_ID",
      "GA4_PROPERTY_ID",
    ]);
    const text = readFileSync(join(ROOT, ".env.example"), "utf8");
    const filled = [...text.matchAll(/^([A-Z][A-Z0-9_]+)=(.+)$/gm)]
      .filter((m) => m[2].trim() !== "" && !allowedDefaults.has(m[1]))
      .map((m) => m[1]);
    assert.deepEqual(filled, [], "var com valor preenchido no .env.example: deixe vazio");
  });

  it("parseEnvExampleNames e processEnvReads cobrem as formas esperadas", () => {
    assert.deepEqual(
      [...parseEnvExampleNames("A_B=\n# OPT_X=http://x\n#  NAO=1\n  NEM=2\nZ_9=v")].sort(),
      ["A_B", "OPT_X", "Z_9"],
    );
    assert.deepEqual(
      [...processEnvReads(`process.env.FOO_1 ?? process.env["BAR"] ?? process.env[ 'BAZ' ] ?? process.env[x]`)].sort(),
      ["BAR", "BAZ", "FOO_1"],
    );
    assert.equal(codeLines("  // FOO\n * BAR\nconst x = 'BAZ';").trim(), "const x = 'BAZ';");
  });
});
