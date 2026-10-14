/**
 * #10176: replantar o erro intencional quando o item que o carregava saiu do
 * 02-reviewed.md no gate (edição 261014) — grava MD + JSON + JSONL de forma
 * consistente e valida present-in-final / not-recent-repeat.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../scripts/replant-intentional-error.ts";

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

function setup(jsonl?: string) {
  const root = mkdtempSync(join(tmpdir(), "replant-10176-"));
  const dir = join(root, "editions", "261014");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), MD, "utf8");
  writeFileSync(
    join(dir, "_internal", "intentional-error.json"),
    JSON.stringify({ description: "velho", location: "LANÇAMENTOS", category: "ortografico", correct_value: "Foo", wrong_value: "Fooo", reveal: "Na última edição, escrevi Fooo onde o correto é Foo." }),
    "utf8",
  );
  const jsonlPath = join(root, "intentional-errors.jsonl");
  if (jsonl) writeFileSync(jsonlPath, jsonl, "utf8");
  return { root, dir, jsonlPath };
}

function quiet<T>(fn: () => T): T {
  const [l, e] = [console.log, console.error];
  console.log = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = l;
    console.error = e;
  }
}

describe("#10176 replant-intentional-error", () => {
  it("replanta nos 3 lugares de forma consistente", () => {
    const { root, dir, jsonlPath } = setup();
    try {
      assert.equal(quiet(() => main(["--edition-dir", dir, "--jsonl", jsonlPath])), 0);
      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      const json = JSON.parse(readFileSync(join(dir, "_internal", "intentional-error.json"), "utf8"));
      assert.notEqual(json.wrong_value, "Fooo");
      assert.ok(md.includes(json.wrong_value), "wrong_value presente no MD");
      assert.match(md, /Nessa edição, .*seção RADAR\./);
      assert.doesNotMatch(md, /LANÇAMENTOS\./);
      const entries = readFileSync(jsonlPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(entries.length, 1);
      assert.equal(entries[0].edition, "261014");
      assert.equal(entries[0].wrong_value, json.wrong_value);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--dry-run não grava nada", () => {
    const { root, dir, jsonlPath } = setup();
    try {
      assert.equal(quiet(() => main(["--edition-dir", dir, "--jsonl", jsonlPath, "--dry-run"])), 0);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), MD);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem menção plantável → exit 1 e nada gravado", () => {
    const { root, dir, jsonlPath } = setup();
    try {
      const plain = MD.replace(/Claude Code, Cursor e GitHub Copilot/, "Ferramentas").replace("Cursor vs. Claude Code", "Guia");
      writeFileSync(join(dir, "02-reviewed.md"), plain, "utf8");
      assert.equal(quiet(() => main(["--edition-dir", dir, "--jsonl", jsonlPath])), 1);
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), plain);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
