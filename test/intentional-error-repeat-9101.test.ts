/**
 * test/intentional-error-repeat-9101.test.ts (#9101)
 *
 * Regressão: 260930 declarou "Anthropik" (mesmo erro de 260928) e o proposer
 * sugeriu "Craude", já usado 3x em `data/intentional-errors.jsonl`. Fixtures
 * próprias — `data/` é gitignored e pode estar ausente no clone.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractWrongValue,
  findRecentRepeats,
  normalizeErrorValue,
  intentionalErrorsJsonlPathForEditionDir,
  checkIntentionalErrorNotRecentRepeat,
} from "../scripts/lib/intentional-error-repeat.ts";
import { proposeIntentionalErrorCandidate } from "../scripts/lib/propose-intentional-error-candidate.ts";
import type { IntentionalError } from "../scripts/lib/intentional-errors.ts";
import { STAGE_2_RULES } from "../scripts/lib/invariant-checks/stage-2.ts";
import { STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

// Recorte real de data/intentional-errors.jsonl (formatos de reveal variados, sem wrong_value).
const HISTORY: IntentionalError[] = [
  { edition: "260721", error_type: "ortografico", is_feature: true, correct_value: "Claude Opus 4.8", reveal: 'escrevi "Craude Opus 4.8" em vez de Claude Opus 4.8 — typo bobo, mas passou.' },
  { edition: "260730", error_type: "ortografico", is_feature: true, correct_value: "Claude Code", reveal: 'Na última edição, escrevi "Craude Code" onde o correto era "Claude Code".' },
  { edition: "260827", error_type: "ortografico", is_feature: true, correct_value: "Claude Cowork", reveal: "Na última edição, escrevi Craude Cowork onde o correto é Claude Cowork, no item do LANÇAMENTOS." },
  { edition: "260924", error_type: "none", is_feature: false, no_error: true },
  { edition: "260925", error_type: "ortografico", is_feature: true, correct_value: "OpenAI", reveal: "Na última edição, escrevi OppenAI no Radar, duplicando uma letra, o certo é OpenAI." },
  { edition: "260928", error_type: "ortografico", is_feature: true, correct_value: "Anthropic", reveal: "Na última edição, escrevi Anthropik no Destaque 3, o certo é Anthropic." },
];

const MD_WITH = (entities: string) => `
**DESTAQUE 1 | 🚀 LANÇAMENTO**
[Algo](https://example.com/a)
A Anthropic e o Claude aparecem aqui, mas é destaque.

**RADAR**
[Notícia lateral](https://example.com/b)
${entities}
`;

describe("#9101: extractWrongValue / normalize", () => {
  it("extrai a grafia errada de reveals antigos sem wrong_value", () => {
    assert.equal(extractWrongValue(HISTORY[0]), "Craude Opus 4.8");
    assert.equal(extractWrongValue(HISTORY[1]), "Craude Code");
    assert.equal(extractWrongValue(HISTORY[2]), "Craude Cowork");
    assert.equal(extractWrongValue(HISTORY[4]), "OppenAI");
    assert.equal(extractWrongValue(HISTORY[5]), "Anthropik");
  });
  it("wrong_value explícito vence o reveal", () => {
    assert.equal(extractWrongValue({ wrong_value: "Deloite", reveal: "escrevi X no Y" }), "Deloite");
  });
  it("normaliza aspas, caixa e acento", () => {
    assert.equal(normalizeErrorValue('"Anthrópik"'), "anthropik");
  });
});

describe("#9101: findRecentRepeats", () => {
  it("Anthropik (260928) é rejeitado em 260930 — wrong_value e correct_value", () => {
    const m = findRecentRepeats({ wrong_value: "Anthropik", correct_value: "Anthropic" }, HISTORY, "260930");
    assert.deepEqual(m.map((x) => [x.field, x.edition]).sort(), [["correct_value", "260928"], ["wrong_value", "260928"]]);
  });
  it("Craude (3 ocorrências) é rejeitado quando dentro da janela", () => {
    const m = findRecentRepeats({ wrong_value: "Craude" }, HISTORY, "260828");
    assert.deepEqual(m.map((x) => x.edition).sort(), ["260730", "260827"]);
    const all = findRecentRepeats({ wrong_value: "Craude" }, HISTORY, "260930", { windowDays: Infinity });
    assert.equal(all.length, 3);
  });
  it("fora da janela de 30 dias não acusa; a própria edição e no_error são ignoradas", () => {
    assert.equal(findRecentRepeats({ wrong_value: "Craude" }, HISTORY, "260930").length, 0);
    assert.equal(findRecentRepeats({ wrong_value: "Anthropik" }, HISTORY, "260928").length, 0);
  });
  it("janela injetável", () => {
    assert.equal(findRecentRepeats({ wrong_value: "Anthropik" }, HISTORY, "260930", { windowDays: 1 }).length, 0);
  });
  it("histórico vazio (jsonl ausente) → sem repetição", () => {
    assert.equal(findRecentRepeats({ wrong_value: "Anthropik" }, [], "260930").length, 0);
  });
});

describe("#9101: proposer pula grafias/entidades já usadas", () => {
  it("sem histórico mantém o comportamento #8592 (Craude primeiro)", () => {
    const c = proposeIntentionalErrorCandidate(MD_WITH("O Claude e a Anthropic e o Gemini."));
    assert.equal(c?.wrong_value, "Craude");
  });
  it("com histórico: não propõe Craude (usado 3x) nem Anthropik (260928) — cai no Gemini inédito", () => {
    const c = proposeIntentionalErrorCandidate(MD_WITH("O Claude e a Anthropic e o Gemini."), {
      history: HISTORY,
      edition: "260930",
    });
    assert.equal(c?.wrong_value, "Gemine");
  });
  it("só entidades já usadas → null em vez de repetir", () => {
    const c = proposeIntentionalErrorCandidate(MD_WITH("O Claude e a Anthropic."), { history: HISTORY, edition: "260930" });
    assert.equal(c, null);
  });
  it("prefere entidade inédita mesmo aparecendo depois no documento", () => {
    const history: IntentionalError[] = [
      { edition: "260601", error_type: "ortografico", is_feature: true, correct_value: "ChatGPT", reveal: "escrevi ChatGBT no Radar" },
    ];
    const c = proposeIntentionalErrorCandidate(MD_WITH("O ChatGPT e depois o Mistral."), { history, edition: "260930" });
    assert.equal(c?.correct_value, "Mistral");
    // sem inédita, aceita entidade usada fora da janela com grafia nova
    const c2 = proposeIntentionalErrorCandidate(MD_WITH("Só o ChatGPT."), { history, edition: "260930" });
    assert.equal(c2?.wrong_value, "ChatGTP");
  });
});

describe("#9101: invariante Stage 2/Stage 4", () => {
  function fixture(record: object | null, jsonl: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "ie-9101-"));
    const dir = join(root, "data", "editions", "2609", "260930");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    if (record) writeFileSync(join(dir, "_internal", "intentional-error.json"), JSON.stringify(record));
    if (jsonl !== null) writeFileSync(join(root, "data", "intentional-errors.jsonl"), jsonl);
    return dir;
  }
  const JSONL = HISTORY.map((h) => JSON.stringify(h)).join("\n") + "\n";
  const ANTHROPIK = {
    description: "x",
    location: "RADAR",
    category: "ortografico",
    correct_value: "Anthropic",
    reveal: "Na última edição, escrevi Anthropik no RADAR, o certo é Anthropic.",
  };

  it("deriva o jsonl a partir do diretório nested da edição", () => {
    assert.equal(intentionalErrorsJsonlPathForEditionDir("/r/data/editions/2609/260930"), "/r/data/intentional-errors.jsonl");
    assert.equal(intentionalErrorsJsonlPathForEditionDir("/r/data/editions/260930"), "/r/data/intentional-errors.jsonl");
  });
  it("Anthropik em 260930 → violação error (caso real)", () => {
    const v = checkIntentionalErrorNotRecentRepeat(fixture(ANTHROPIK, JSONL));
    assert.ok(v.length >= 1);
    assert.ok(v.every((x) => x.severity === "error" && x.rule === "intentional-error-not-recent-repeat"));
    assert.match(v[0].message, /260928/);
  });
  it("valor inédito → sem violação", () => {
    const rec = { ...ANTHROPIK, correct_value: "Deloitte", wrong_value: "Deloite", reveal: "escrevi Deloite no RADAR" };
    assert.deepEqual(checkIntentionalErrorNotRecentRepeat(fixture(rec, JSONL)), []);
  });
  it("fail-soft: jsonl ausente, JSON ausente, placeholder ou no_error → sem violação", () => {
    assert.deepEqual(checkIntentionalErrorNotRecentRepeat(fixture(ANTHROPIK, null)), []);
    assert.deepEqual(checkIntentionalErrorNotRecentRepeat(fixture(null, JSONL)), []);
    assert.deepEqual(
      checkIntentionalErrorNotRecentRepeat(fixture({ correct_value: "{PREENCHER}", reveal: "{PREENCHER}" }, JSONL)),
      [],
    );
    assert.deepEqual(checkIntentionalErrorNotRecentRepeat(fixture({ no_error: true }, JSONL)), []);
  });
  it("registrado no Stage 2 e no Stage 4", () => {
    const s2 = STAGE_2_RULES.find((r) => r.id === "intentional-error-not-recent-repeat");
    const s4 = STAGE_4_RULES.find((r) => r.id === "intentional-error-not-recent-repeat-final");
    assert.ok(s2 && s4);
    const dir = fixture(ANTHROPIK, JSONL);
    assert.ok(s2.run(dir).length > 0);
    assert.ok(s4.run(dir).every((x) => x.rule === "intentional-error-not-recent-repeat-final"));
    assert.ok(s4.run(dir).length > 0);
  });
});

describe("#9101: CLI propose-intentional-error-candidate --jsonl", () => {
  it("lê o histórico e não repete Craude/Anthropik", async () => {
    const { main } = await import("../scripts/propose-intentional-error-candidate.ts");
    const root = mkdtempSync(join(tmpdir(), "ie-9101-cli-"));
    const md = join(root, "02-reviewed.md");
    writeFileSync(md, MD_WITH("O Claude e a Anthropic e o Gemini."));
    const jsonl = join(root, "ie.jsonl");
    writeFileSync(jsonl, HISTORY.map((h) => JSON.stringify(h)).join("\n") + "\n");
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: string) => logs.push(s);
    try {
      assert.equal(main(["--md", md, "--jsonl", jsonl, "--edition", "260930"]), 0);
    } finally {
      console.log = orig;
    }
    assert.equal(JSON.parse(logs.join("")).candidate.wrong_value, "Gemine");
  });
});
