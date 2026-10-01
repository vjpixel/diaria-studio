/**
 * test/plant-intentional-error-9255.test.ts (#9255)
 *
 * Regressão do cenário real da edição 261001: Stage 2 headless terminou com
 * `Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.` + JSON `{PREENCHER}` porque o
 * playbook mandava perguntar ao editor e não havia ninguém pra responder.
 * Fixture = trecho do 02-reviewed.md real da 261001 no estado pré-plantio.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../scripts/plant-intentional-error.ts";
import { plantIntentionalError, plantWrongValue } from "../scripts/lib/plant-intentional-error.ts";
import { ensureIntentionalErrorJson, extractCurrentDeclarationFromMd } from "../scripts/render-erro-intencional.ts";

const MD_261001 = `**DESTAQUE 1 | 🤖 MODELOS**

**[Claude ganha memória](https://www.anthropic.com/news/claude-memory)**

A Anthropic lançou memória no Claude para todos os planos.

Por que isso importa:
Claude lembra do contexto.

---

**🛠️ USE MELHOR**

**[Local Agentic AI Workflows with Hermes + Ollama](https://machinelearningmastery.com/local-agentic-ai-workflows-with-hermes-ollama/)**
Neste artigo, você aprende a montar um fluxo agêntico local. (15 min)

**[Cursor vs. Claude Code vs. Copilot: qual IA para programar vale mais a pena?](https://exame.com/tecnologia/examelab/cursor-claude-code-e-github-copilot-qual-ia-para-programar-as-startups-adotam/)**
Claude Code, Cursor e GitHub Copilot disputam o mercado de inteligência artificial para programação. (5 min)

---

**📡 RADAR**

**[US trade regulator opens investigation into AI giants including Anthropic and OpenAI](https://www.theguardian.com/us-news/2026/sep/30/ftc-investigation-anthropic-openai)**
A medida da FTC é a primeira ação oficial de fiscalização dos EUA sobre agentes de IA.

---

**ERRO INTENCIONAL**

Na última edição, escrevi Deloite no RADAR, o certo é Deloitte.

Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.

---

**🎁 SORTEIO**
`;

function makeEditionDir(md: string): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "plant-9255-"));
  const dir = join(root, "261001");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), md, "utf8");
  ensureIntentionalErrorJson(join(dir, "_internal", "intentional-error.json"));
  return { root, dir };
}

function quiet<T>(fn: () => T): T {
  const [log, err] = [console.log, console.error];
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
    console.error = err;
  }
}

describe("#9255: plantio determinístico do erro intencional no Stage 2 headless", () => {
  it("cenário 261001: JSON {PREENCHER} + placeholder no MD → planta, e o placeholder gate-blocking some", () => {
    const { root, dir } = makeEditionDir(MD_261001);
    try {
      assert.equal(quiet(() => main(["--edition-dir", dir, "--jsonl", join(root, "none.jsonl")])), 0);
      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      const json = JSON.parse(readFileSync(join(dir, "_internal", "intentional-error.json"), "utf8"));

      // lint gate-blocking do placeholder passa
      assert.doesNotMatch(md, /\{PREENCHER_NARRATIVA_DO_ERRO\}/);
      for (const k of ["description", "location", "category", "correct_value", "wrong_value", "reveal"]) {
        assert.doesNotMatch(String(json[k]), /PREENCHER/, k);
      }
      assert.equal(json.category, "ortografico");
      // erro plantado no texto corrido da seção secundária, nunca no DESTAQUE nem em URL
      assert.ok(md.includes(json.wrong_value), "wrong_value presente no MD");
      assert.match(md, /Por que isso importa:\nClaude lembra/);
      assert.match(md, /https:\/\/exame\.com\/tecnologia\/examelab\/cursor-claude-code-e-github-copilot/);
      assert.match(json.reveal, /^Na última edição/);
      // declaração da edição é reconhecida pelo renderer (rerun idempotente)
      assert.ok(extractCurrentDeclarationFromMd(md));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("idempotente: 2º run com JSON preenchido é no-op", () => {
    const { root, dir } = makeEditionDir(MD_261001);
    try {
      const args = ["--edition-dir", dir, "--jsonl", join(root, "none.jsonl")];
      quiet(() => main(args));
      const md1 = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      assert.equal(quiet(() => main(args)), 0);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), md1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("JSON já preenchido pelo editor → não toca em nada", () => {
    const { root, dir } = makeEditionDir(MD_261001);
    try {
      const jsonPath = join(dir, "_internal", "intentional-error.json");
      const filled = {
        description: "x", location: "RADAR", category: "ortografico",
        correct_value: "FTC", wrong_value: "FCT", reveal: "Na última edição, escrevi FCT.",
      };
      writeFileSync(jsonPath, JSON.stringify(filled), "utf8");
      assert.equal(quiet(() => main(["--edition-dir", dir])), 0);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), MD_261001);
      assert.deepEqual(JSON.parse(readFileSync(jsonPath, "utf8")), filled);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem menção plantável → exit 1 e nada gravado (placeholder segue barrando)", () => {
    const md = MD_261001.replace(/Claude|Copilot|Anthropic/g, "Fulano");
    const { root, dir } = makeEditionDir(md);
    try {
      assert.equal(quiet(() => main(["--edition-dir", dir, "--jsonl", join(root, "none.jsonl")])), 1);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), md);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("plantWrongValue prefere texto corrido ao texto-âncora e nunca toca URL", () => {
    const out = plantWrongValue(MD_261001, "USE MELHOR", "Copilot", "Copilto")!;
    assert.match(out, /GitHub Copilto disputam/);
    assert.match(out, /\[Cursor vs\. Claude Code vs\. Copilot:/);
  });

  it("plantIntentionalError com seção desconhecida → null", () => {
    assert.equal(
      plantIntentionalError(MD_261001, {
        description: "d", location: "DESTAQUE 1", category: "ortografico",
        correct_value: "Claude", wrong_value: "Craude", reveal: "Na última edição, x.",
      }),
      null,
    );
  });
});
