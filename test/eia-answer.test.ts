/**
 * eia-answer.test.ts (#927)
 *
 * Cobre o helper `scripts/lib/eia-answer.ts` — sidecar JSON do gabarito
 * do É IA?, com fallback chain pra meta.json e frontmatter (backward
 * compat) e simulação de Drive round-trip que strippa frontmatter.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeEiaAnswerSidecar,
  readEiaAnswer,
  readEiaAnswerSidecar,
  readEiaAnswerFromMeta,
  readEiaAnswerFromFrontmatter,
  eiaAnswerSidecarPath,
  aiSideFromAnswer,
} from "../scripts/lib/eia-answer.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "diaria-eia-answer-"));
}

describe("writeEiaAnswerSidecar (#927)", () => {
  it("grava sidecar JSON com schema canônico", () => {
    const dir = makeDir();
    try {
      writeEiaAnswerSidecar(dir, "260507", { A: "real", B: "ia" });
      const path = eiaAnswerSidecarPath(dir);
      assert.ok(existsSync(path), "sidecar criado em _internal/");
      const data = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(data.edition, "260507");
      assert.deepEqual(data.answer, { A: "real", B: "ia" });
      assert.equal(data.ai_side, "B", "ai_side derivado de answer.B === 'ia'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ai_side derivado quando A é IA", () => {
    const dir = makeDir();
    try {
      writeEiaAnswerSidecar(dir, "260507", { A: "ia", B: "real" });
      const data = JSON.parse(readFileSync(eiaAnswerSidecarPath(dir), "utf8"));
      assert.equal(data.ai_side, "A");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cria _internal/ se ausente (idempotente)", () => {
    const dir = makeDir();
    try {
      writeEiaAnswerSidecar(dir, "260507", { A: "real", B: "ia" });
      writeEiaAnswerSidecar(dir, "260507", { A: "real", B: "ia" });
      assert.ok(existsSync(eiaAnswerSidecarPath(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readEiaAnswerSidecar (#927)", () => {
  it("lê sidecar gravado", () => {
    const dir = makeDir();
    try {
      writeEiaAnswerSidecar(dir, "260507", { A: "ia", B: "real" });
      const result = readEiaAnswerSidecar(dir);
      assert.deepEqual(result, { A: "ia", B: "real" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null quando sidecar ausente", () => {
    const dir = makeDir();
    try {
      assert.equal(readEiaAnswerSidecar(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null para JSON corrompido", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(eiaAnswerSidecarPath(dir), "{not valid json", "utf8");
      assert.equal(readEiaAnswerSidecar(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null para schema inválido (valores estranhos)", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        eiaAnswerSidecarPath(dir),
        JSON.stringify({ edition: "x", answer: { A: "foo", B: "bar" }, ai_side: "A" }),
        "utf8",
      );
      assert.equal(readEiaAnswerSidecar(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readEiaAnswerFromMeta (#927)", () => {
  it("deriva A/B de ai_side='A'", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal/01-eia-meta.json"),
        JSON.stringify({ ai_side: "A" }),
        "utf8",
      );
      assert.deepEqual(readEiaAnswerFromMeta(dir), { A: "ia", B: "real" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deriva A/B de ai_side='B'", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal/01-eia-meta.json"),
        JSON.stringify({ ai_side: "B" }),
        "utf8",
      );
      assert.deepEqual(readEiaAnswerFromMeta(dir), { A: "real", B: "ia" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null quando ai_side é null", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal/01-eia-meta.json"),
        JSON.stringify({ ai_side: null }),
        "utf8",
      );
      assert.equal(readEiaAnswerFromMeta(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null quando meta.json ausente", () => {
    const dir = makeDir();
    try {
      assert.equal(readEiaAnswerFromMeta(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readEiaAnswerFromFrontmatter (#927)", () => {
  it("extrai mapping A/B de 01-eia.md", () => {
    const dir = makeDir();
    try {
      writeFileSync(
        join(dir, "01-eia.md"),
        "---\neia_answer:\n  A: real\n  B: ia\n---\n\nÉ IA?\nCredit",
        "utf8",
      );
      assert.deepEqual(readEiaAnswerFromFrontmatter(dir), { A: "real", B: "ia" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aceita 01-eai.md legacy", () => {
    const dir = makeDir();
    try {
      writeFileSync(
        join(dir, "01-eai.md"),
        "---\neia_answer:\n  A: ia\n  B: real\n---\nÉ IA?",
        "utf8",
      );
      assert.deepEqual(readEiaAnswerFromFrontmatter(dir), { A: "ia", B: "real" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null quando frontmatter foi strippado (Drive round-trip)", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, "01-eia.md"), "É IA?\n\nFoto: Linha de crédito", "utf8");
      assert.equal(readEiaAnswerFromFrontmatter(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null quando 01-eia.md ausente", () => {
    const dir = makeDir();
    try {
      assert.equal(readEiaAnswerFromFrontmatter(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readEiaAnswer (fallback chain #927)", () => {
  it("sidecar tem precedência sobre meta.json e frontmatter", () => {
    const dir = makeDir();
    try {
      // Sidecar: A=real, B=ia
      writeEiaAnswerSidecar(dir, "260507", { A: "real", B: "ia" });
      // Meta diverge: ai_side=A → derivaria A=ia, B=real
      writeFileSync(
        join(dir, "_internal/01-eia-meta.json"),
        JSON.stringify({ ai_side: "A" }),
        "utf8",
      );
      // Frontmatter também diverge
      writeFileSync(
        join(dir, "01-eia.md"),
        "---\neia_answer:\n  A: ia\n  B: real\n---\n",
        "utf8",
      );
      // Sidecar wins
      assert.deepEqual(readEiaAnswer(dir), { A: "real", B: "ia" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back para meta.json quando sidecar ausente", () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal/01-eia-meta.json"),
        JSON.stringify({ ai_side: "B" }),
        "utf8",
      );
      assert.deepEqual(readEiaAnswer(dir), { A: "real", B: "ia" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back para frontmatter quando sidecar e meta.json ausentes (backward compat)", () => {
    const dir = makeDir();
    try {
      writeFileSync(
        join(dir, "01-eia.md"),
        "---\neia_answer:\n  A: real\n  B: ia\n---\nCredit",
        "utf8",
      );
      assert.deepEqual(readEiaAnswer(dir), { A: "real", B: "ia" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null quando nenhuma source tem dado válido", () => {
    const dir = makeDir();
    try {
      assert.equal(readEiaAnswer(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Drive round-trip: frontmatter strippado, sidecar preserva gabarito (regressão #927)", () => {
    const dir = makeDir();
    try {
      // Estado inicial: ambos presentes
      writeEiaAnswerSidecar(dir, "260507", { A: "ia", B: "real" });
      writeFileSync(
        join(dir, "01-eia.md"),
        "---\neia_answer:\n  A: ia\n  B: real\n---\n\nÉ IA?\nCredit",
        "utf8",
      );
      // Simula Drive round-trip: re-grava 01-eia.md sem frontmatter
      writeFileSync(join(dir, "01-eia.md"), "É IA?\nCredit", "utf8");
      // Gabarito ainda recuperável via sidecar
      const result = readEiaAnswer(dir);
      assert.deepEqual(result, { A: "ia", B: "real" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("aiSideFromAnswer (#927)", () => {
  it("A=ia → ai_side=A", () => {
    assert.equal(aiSideFromAnswer({ A: "ia", B: "real" }), "A");
  });
  it("B=ia → ai_side=B", () => {
    assert.equal(aiSideFromAnswer({ A: "real", B: "ia" }), "B");
  });
});
