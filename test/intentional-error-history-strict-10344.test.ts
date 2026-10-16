/**
 * Regressão do #10344: o #10292 tornou estrita a leitura do histórico só na CLI
 * do proposer do Stage 4. O planter do Stage 2 (`plant-intentional-error.ts`) e
 * o invariante `intentional-error-not-recent-repeat` (backstop Stage 2/4)
 * seguiam com `loadIntentionalErrors`, que devolve `[]` em silêncio quando
 * `data/intentional-errors.jsonl` existe mas não pode ser lido (lock do
 * OneDrive) — o planter plantava um erro repetido e o invariante passava.
 *
 * "Arquivo ilegível" é simulado com um DIRETÓRIO no lugar do JSONL
 * (`readFileSync` lança EISDIR), mesmo truque de
 * `intentional-error-guards-10292-10293.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readIntentionalErrorsHistoryStrict } from "../scripts/lib/intentional-errors.ts";
import { checkIntentionalErrorNotRecentRepeat } from "../scripts/lib/intentional-error-repeat.ts";
import { main as plantMain } from "../scripts/plant-intentional-error.ts";

const REPEAT_ENTRY = {
  edition: "260928",
  error_type: "ortografico",
  is_feature: true,
  wrong_value: "Anthropik",
  correct_value: "Anthropic",
};
const ANTHROPIK = {
  description: "x",
  location: "RADAR",
  category: "ortografico",
  correct_value: "Anthropic",
  wrong_value: "Anthropik",
  reveal: "Na última edição, escrevi Anthropik no RADAR, o certo é Anthropic.",
};

/** `{root}/data/editions/2609/260930/` + JSONL irmão de `editions/`. */
function tree(jsonl: string | "dir" | null, record: object | null = ANTHROPIK): { dir: string; jsonlPath: string } {
  const root = mkdtempSync(join(tmpdir(), "ie-10344-"));
  const dir = join(root, "data", "editions", "2609", "260930");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  if (record) writeFileSync(join(dir, "_internal", "intentional-error.json"), JSON.stringify(record));
  const jsonlPath = join(root, "data", "intentional-errors.jsonl");
  if (jsonl === "dir") mkdirSync(jsonlPath);
  else if (jsonl !== null) writeFileSync(jsonlPath, jsonl);
  return { dir, jsonlPath };
}

describe("#10344 readIntentionalErrorsHistoryStrict", () => {
  it("path nulo ou arquivo ausente → histórico vazio legítimo", () => {
    assert.deepEqual(readIntentionalErrorsHistoryStrict(null), { ok: true, entries: [] });
    assert.deepEqual(readIntentionalErrorsHistoryStrict(tree(null).jsonlPath), { ok: true, entries: [] });
  });
  it("arquivo existente mas ilegível → ok:false nomeando a falha", () => {
    const r = readIntentionalErrorsHistoryStrict(tree("dir").jsonlPath);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /não pôde ser lido/);
  });
  it("linhas e nenhuma parseia → ok:false", () => {
    const r = readIntentionalErrorsHistoryStrict(tree("{lixo\nlixo\n").jsonlPath);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /nenhuma parseia/);
  });
  it("parcialmente corrompido → ok com warning e as entries válidas", () => {
    const r = readIntentionalErrorsHistoryStrict(tree(JSON.stringify(REPEAT_ENTRY) + "\n{lixo\n").jsonlPath);
    assert.ok(r.ok);
    assert.equal(r.ok && r.entries.length, 1);
    assert.match((r.ok && r.warning) || "", /WARN 1 linha/);
  });
});

describe("#10344 invariante intentional-error-not-recent-repeat", () => {
  it("cenário da issue: JSONL travado (EISDIR) → violação error, nunca []", () => {
    const v = checkIntentionalErrorNotRecentRepeat(tree("dir").dir);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
    assert.equal(v[0].rule, "intentional-error-not-recent-repeat");
    assert.match(v[0].message, /não pôde ser lido/);
  });
  it("JSONL só com linhas corrompidas → violação error", () => {
    const v = checkIntentionalErrorNotRecentRepeat(tree("{lixo\n").dir);
    assert.deepEqual(v.map((x) => x.severity), ["error"]);
    assert.match(v[0].message, /nenhuma parseia/);
  });
  it("ruleId customizado (Stage 4) é preservado na violação de leitura", () => {
    const v = checkIntentionalErrorNotRecentRepeat(tree("dir").dir, { ruleId: "intentional-error-not-recent-repeat-final" });
    assert.equal(v[0].rule, "intentional-error-not-recent-repeat-final");
  });
  it("parcialmente corrompido → warning de leitura + a repetição real continua detectada", () => {
    const v = checkIntentionalErrorNotRecentRepeat(tree(JSON.stringify(REPEAT_ENTRY) + "\n{lixo\n").dir);
    assert.equal(v[0].severity, "warning");
    assert.match(v[0].message, /parcial/);
    assert.ok(v.some((x) => x.severity === "error" && /Anthropik/.test(x.message)));
  });
  it("JSONL ausente segue fail-soft (sem violação)", () => {
    assert.deepEqual(checkIntentionalErrorNotRecentRepeat(tree(null).dir), []);
  });
  it("JSON sem erro declarado não lê o histórico (ilegível não importa)", () => {
    assert.deepEqual(checkIntentionalErrorNotRecentRepeat(tree("dir", { no_error: true }).dir), []);
  });
});

const MD = `**DESTAQUE 1 | 🤖 MODELOS**

**[Claude ganha memória](https://www.anthropic.com/news/claude-memory)**

A Anthropic lançou memória no Claude para todos os planos.

---

**📡 RADAR**

**[US trade regulator opens investigation into AI giants including Anthropic and OpenAI](https://www.theguardian.com/us-news/2026/sep/30/ftc-investigation-anthropic-openai)**
A medida da FTC é a primeira ação oficial de fiscalização dos EUA sobre agentes de IA da Anthropic.

---

**ERRO INTENCIONAL**

Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.

---
`;

function runPlant(argv: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const ol = console.log;
  const oe = console.error;
  console.log = (m: string) => out.push(m);
  console.error = (m: string) => err.push(m);
  try {
    return { code: plantMain(argv), out, err };
  } finally {
    console.log = ol;
    console.error = oe;
  }
}

describe("#10344 planter do Stage 2", () => {
  it("cenário da issue: JSONL travado → exit 1 history_unreadable, MD e JSON intocados", () => {
    const { dir } = tree("dir", null);
    writeFileSync(join(dir, "02-reviewed.md"), MD);
    const r = runPlant(["--edition-dir", dir]);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out[0]).action, "history_unreadable");
    assert.ok(r.err.some((l) => /não pôde ser lido/.test(l)));
    assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), MD);
    assert.equal(existsSync(join(dir, "_internal", "intentional-error.json")), false);
  });
  it("--jsonl explícito ilegível também aborta", () => {
    const { dir } = tree(null, null);
    writeFileSync(join(dir, "02-reviewed.md"), MD);
    const locked = mkdtempSync(join(tmpdir(), "ie-10344-locked-"));
    const r = runPlant(["--edition-dir", dir, "--jsonl", locked]);
    assert.equal(r.code, 1);
    assert.equal(JSON.parse(r.out[0]).action, "history_unreadable");
  });
  it("JSONL ausente → planta normalmente (histórico vazio legítimo)", () => {
    const { dir } = tree(null, null);
    writeFileSync(join(dir, "02-reviewed.md"), MD);
    const r = runPlant(["--edition-dir", dir]);
    assert.equal(r.code, 0, r.err.join("\n"));
    assert.equal(JSON.parse(r.out.join("\n")).action, "planted");
  });
});
