/**
 * test/stage-4-box-divulgacao-runtime-invariant.test.ts (#4504)
 *
 * Cobre o registro do guard `box-divulgacao-runtime-excluded` em
 * `invariant-checks/stage-4.ts` — mesmo padrão de
 * test/stage-4-box-divulgacao-alt-invariant.test.ts (#4086).
 *
 * checkBoxDivulgacaoRuntimeExcluded dispara (error, diferente do #4086 que é
 * warning-only) quando algum slot de boxes_divulgacao (0-3) em
 * platform.config.json aponta pra um snippet com `runtime: false` no header
 * — o mesmo cenário que causou o incidente original do #4500
 * (`intro-campeoes-sorteio.md` injetado verbatim como box de divulgação).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkBoxDivulgacaoRuntimeExcluded,
  STAGE_4_RULES,
} from "../scripts/lib/invariant-checks/stage-4.ts";

function makeRoot(boxesDivulgacao: Record<string, string>, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "stage4-box-runtime-root-"));
  mkdirSync(join(root, "data", "snippets"), { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(root, "data", "snippets", filename), content);
  }
  writeFileSync(
    join(root, "platform.config.json"),
    JSON.stringify({ boxes_divulgacao: boxesDivulgacao }),
  );
  return root;
}

describe("checkBoxDivulgacaoRuntimeExcluded (#4504)", () => {
  it("retorna [] quando platform.config.json não existe", () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-box-runtime-missing-config-"));
    try {
      assert.deepEqual(checkBoxDivulgacaoRuntimeExcluded("unused-edition-dir", root), []);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("retorna [] quando nenhum slot aponta pra snippet runtime:false", () => {
    const root = makeRoot(
      { slot1: "livros-divulgacao.md" },
      { "livros-divulgacao.md": "<!--\nnome: Livros\n-->\n\nConteúdo real." },
    );
    try {
      assert.deepEqual(checkBoxDivulgacaoRuntimeExcluded("unused-edition-dir", root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("error quando slot1 aponta pra snippet runtime:false (cenário do #4500)", () => {
    const root = makeRoot(
      { slot1: "intro-campeoes-sorteio.md" },
      { "intro-campeoes-sorteio.md": "<!--\nruntime: false\n-->\n\nDoc de referência, não é conteúdo real." },
    );
    try {
      const v = checkBoxDivulgacaoRuntimeExcluded("unused-edition-dir", root);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "box-divulgacao-runtime-excluded");
      assert.equal(v[0].source_issue, "#4504");
      assert.equal(v[0].severity, "error");
      assert.match(v[0].message, /slot1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("case-insensitive: runtime: FALSE também dispara", () => {
    const root = makeRoot(
      { slot0: "doc.md" },
      { "doc.md": "<!--\nruntime: FALSE\n-->\n\nDoc." },
    );
    try {
      const v = checkBoxDivulgacaoRuntimeExcluded("unused-edition-dir", root);
      assert.equal(v.length, 1);
      assert.match(v[0].message, /slot0/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detecta múltiplos slots simultaneamente", () => {
    const root = makeRoot(
      { slot1: "doc1.md", slot2: "doc2.md", slot3: "real.md" },
      {
        "doc1.md": "<!--\nruntime: false\n-->\n\nDoc 1.",
        "doc2.md": "<!--\nruntime: false\n-->\n\nDoc 2.",
        "real.md": "<!--\nnome: Real\n-->\n\nConteúdo real.",
      },
    );
    try {
      const v = checkBoxDivulgacaoRuntimeExcluded("unused-edition-dir", root);
      assert.equal(v.length, 2);
      const slots = v.map((x) => (x.message.match(/slot(\d)/) ?? [])[1]).sort();
      assert.deepEqual(slots, ["1", "2"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retorna [] quando runtime: true (continua incluído)", () => {
    const root = makeRoot(
      { slot1: "doc.md" },
      { "doc.md": "<!--\nruntime: true\n-->\n\nConteúdo." },
    );
    try {
      assert.deepEqual(checkBoxDivulgacaoRuntimeExcluded("unused-edition-dir", root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("STAGE_4_RULES registry (#4504)", () => {
  it("inclui box-divulgacao-runtime-excluded", () => {
    const ids = STAGE_4_RULES.map((r) => r.id);
    assert.ok(ids.includes("box-divulgacao-runtime-excluded"));
  });

  it("box-divulgacao-runtime-excluded está registrado no stage 4, source_issue #4504", () => {
    const entry = STAGE_4_RULES.find((r) => r.id === "box-divulgacao-runtime-excluded");
    assert.ok(entry);
    assert.equal(entry!.stage, 4);
    assert.equal(entry!.source_issue, "#4504");
  });
});
