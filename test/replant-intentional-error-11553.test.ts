/**
 * #11553: o item que carregava o erro intencional sai do 02-reviewed.md
 * (edição 261029: item duplicado de LANÇAMENTOS levou junto "DeepMinde").
 *   1. `replant-intentional-error.ts --entity/--section` replanta na
 *      grafia/item escolhido pelo editor, nos 4 lugares, rechecando os 30 dias;
 *   2. a mensagem do `intentional-error-present-in-final` aponta a causa
 *      provável e sugere o comando com o `--edition-dir` da edição.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main, candidateMatchesChoice } from "../scripts/replant-intentional-error.ts";
import { checkIntentionalErrorPresentInFinal, replantCommand } from "../scripts/lib/invariant-checks/stage-4.ts";

const MD = `**DESTAQUE 1 | 🤖 MODELOS**

**[Claude ganha memória](https://www.anthropic.com/news/claude-memory)**

A Anthropic lançou memória no Claude.

---

**📡 RADAR**

**[Cursor vs. Claude Code](https://exame.com/tecnologia/cursor-claude-code)**
Claude Code, Cursor e GitHub Copilot disputam o mercado.

---

**ERRO INTENCIONAL**

Nessa edição, uma marca saiu grafada errada na seção LANÇAMENTOS.
`;

const OLD_RECORD = {
  description: "velho",
  location: "LANÇAMENTOS (menção a \"DeepMind\")",
  category: "ortografico",
  correct_value: "DeepMind",
  wrong_value: "DeepMinde",
  reveal: "Na última edição, escrevi DeepMinde onde o correto é DeepMind.",
};

function setup(jsonl?: string) {
  const root = mkdtempSync(join(tmpdir(), "replant-11553-"));
  const dir = join(root, "editions", "261029");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), MD, "utf8");
  writeFileSync(join(dir, "_internal", "intentional-error.json"), JSON.stringify(OLD_RECORD), "utf8");
  const jsonlPath = join(root, "intentional-errors.jsonl");
  if (jsonl) writeFileSync(jsonlPath, jsonl, "utf8");
  return { root, dir, jsonlPath };
}

function captured<T>(fn: () => T): { result: T; stdout: string } {
  const [l, e] = [console.log, console.error];
  const out: string[] = [];
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = () => {};
  try {
    return { result: fn(), stdout: out.join("\n") };
  } finally {
    console.log = l;
    console.error = e;
  }
}

describe("#11553 replant com escolha do editor", () => {
  it("--entity escolhe a marca (sem ela, o 1º candidato seria Claude)", () => {
    const { root, dir, jsonlPath } = setup();
    try {
      assert.equal(captured(() => main(["--edition-dir", dir, "--jsonl", jsonlPath, "--entity", "Copilot"])).result, 0);
      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      const json = JSON.parse(readFileSync(join(dir, "_internal", "intentional-error.json"), "utf8"));
      assert.equal(json.wrong_value, "Copilto");
      assert.equal(json.correct_value, "Copilot");
      assert.ok(md.includes("GitHub Copilto"), "MD com a grafia escolhida");
      assert.ok(md.includes("Claude Code"), "Claude intacto");
      assert.match(md, /Nessa edição, .*seção RADAR\./);
      const entries = readFileSync(jsonlPath, "utf8").trim().split("\n").map((x) => JSON.parse(x));
      assert.equal(entries.length, 1);
      assert.equal(entries[0].edition, "261029");
      assert.equal(entries[0].wrong_value, "Copilto");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--entity aceita a grafia errada e sobrevive a --dry-run antes dela (parse de flags)", () => {
    const { root, dir, jsonlPath } = setup();
    try {
      const { result, stdout } = captured(() => main(["--edition-dir", dir, "--jsonl", jsonlPath, "--dry-run", "--entity", "copilto"]));
      assert.equal(result, 0);
      const out = JSON.parse(stdout);
      assert.equal(out.dry_run, true);
      assert.equal(out.candidate.wrong_value, "Copilto");
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), MD, "dry-run não grava");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("marca sem menção numa seção secundária → no_candidate, nada gravado (não cai pra outra marca)", () => {
    const { root, dir, jsonlPath } = setup();
    try {
      const { result, stdout } = captured(() => main(["--edition-dir", dir, "--jsonl", jsonlPath, "--entity", "Gemini"]));
      assert.equal(result, 1);
      const out = JSON.parse(stdout);
      assert.equal(out.action, "no_candidate");
      assert.equal(out.reason, "fora_do_catalogo_ou_sem_mencao");
      assert.ok(out.available.length > 0, "lista os candidatos disponíveis");
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), MD);
      const json = JSON.parse(readFileSync(join(dir, "_internal", "intentional-error.json"), "utf8"));
      assert.equal(json.wrong_value, "DeepMinde", "record intocado");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("escolha que repete erro dos últimos 30 dias → vetado_pelo_historico", () => {
    const recent = JSON.stringify({
      edition: "261020",
      error_type: "ortografico",
      is_feature: true,
      source: "manual",
      correct_value: "Copilot",
      wrong_value: "Copilto",
    });
    const { root, dir, jsonlPath } = setup(recent + "\n");
    try {
      const { result, stdout } = captured(() => main(["--edition-dir", dir, "--jsonl", jsonlPath, "--entity", "Copilot"]));
      assert.equal(result, 1);
      assert.equal(JSON.parse(stdout).reason, "vetado_pelo_historico");
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), MD);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--section filtra pela seção do candidato", () => {
    const c = { correct_value: "Copilot", wrong_value: "Copilto", location: 'RADAR (menção a "Copilot")' };
    assert.equal(candidateMatchesChoice(c, { section: "radar" }), true);
    assert.equal(candidateMatchesChoice(c, { section: "LANÇAMENTOS" }), false);
    assert.equal(candidateMatchesChoice(c, { entity: "copilot", section: "RADAR" }), true);
    assert.equal(candidateMatchesChoice(c, { entity: "Claude" }), false);
    assert.equal(candidateMatchesChoice(c, {}), true);
  });

  it("flag sem valor → uso inválido (exit 2)", () => {
    const { root, dir } = setup();
    try {
      assert.equal(captured(() => main(["--edition-dir", dir, "--entity"])).result, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#11553 invariante aponta a causa e o comando", () => {
  it("mensagem cita item removido e o replant com o --edition-dir da edição", () => {
    const { root, dir } = setup();
    try {
      const v = checkIntentionalErrorPresentInFinal(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /Causa provável: o item que continha o erro foi removido/);
      assert.ok(v[0].message.includes(replantCommand(dir)), "sugere o comando colável");
      assert.match(v[0].message, /--entity/);
      assert.match(v[0].message, /intentional-errors\.jsonl/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replantCommand normaliza a barra final", () => {
    assert.equal(
      replantCommand("data/editions/261029/"),
      "npx tsx scripts/replant-intentional-error.ts --edition-dir data/editions/261029/",
    );
    assert.equal(replantCommand("data/editions/261029"), replantCommand("data/editions/261029/"));
  });
});
