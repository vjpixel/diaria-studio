import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findEligiblePotd,
  chooseSides,
  buildEaiMd,
  isStage4Complete,
  buildPrevResultLine,
  readPrevPollStats,
} from "../scripts/eai-compose.ts";

interface MockImage {
  title?: string;
  image?: { width?: number; height?: number; source?: string };
  thumbnail?: { width?: number; height?: number };
}

function makeImage(width: number, height: number, title = "File:Test.jpg"): MockImage {
  return {
    title,
    image: { width, height, source: "https://example/x.jpg" },
  };
}

describe("findEligiblePotd", () => {
  it("retorna primeira imagem elegível (horizontal + não usada)", async () => {
    const fetcher = async (_iso: string) =>
      makeImage(1600, 900, "File:Mountain.jpg") as never;
    const used = new Set<string>();
    const r = await findEligiblePotd("2026-04-26", used, 7, fetcher);
    assert.equal(r.image.title, "File:Mountain.jpg");
    assert.equal(r.imageDate, "2026-04-26");
    assert.equal(r.rejections.length, 0);
  });

  it("rejeita imagem vertical, tenta dia anterior", async () => {
    const responses: Record<string, MockImage> = {
      "2026-04-26": makeImage(800, 1200, "File:Tall.jpg"),
      "2026-04-25": makeImage(1600, 900, "File:Wide.jpg"),
    };
    const fetcher = async (iso: string) => (responses[iso] ?? null) as never;
    const used = new Set<string>();
    const r = await findEligiblePotd("2026-04-26", used, 7, fetcher);
    assert.equal(r.image.title, "File:Wide.jpg");
    assert.equal(r.imageDate, "2026-04-25");
    assert.equal(r.rejections.length, 1);
    assert.equal(r.rejections[0].reason, "vertical");
    assert.equal(r.rejections[0].height, 1200);
  });

  it("rejeita imagem já usada (case-insensitive)", async () => {
    const responses: Record<string, MockImage> = {
      "2026-04-26": makeImage(1600, 900, "File:Used.jpg"),
      "2026-04-25": makeImage(1600, 900, "File:Fresh.jpg"),
    };
    const fetcher = async (iso: string) => (responses[iso] ?? null) as never;
    const used = new Set(["file:used.jpg"]);
    const r = await findEligiblePotd("2026-04-26", used, 7, fetcher);
    assert.equal(r.image.title, "File:Fresh.jpg");
    assert.equal(r.rejections[0].reason, "already_used");
  });

  it("rejeita resposta nula da API, tenta dia anterior", async () => {
    const responses: Record<string, MockImage> = {
      "2026-04-25": makeImage(1600, 900, "File:Found.jpg"),
    };
    const fetcher = async (iso: string) => (responses[iso] ?? null) as never;
    const used = new Set<string>();
    const r = await findEligiblePotd("2026-04-26", used, 7, fetcher);
    assert.equal(r.image.title, "File:Found.jpg");
    assert.equal(r.rejections[0].reason, "api_no_image");
  });

  it("dispara erro após max attempts sem encontrar elegível", async () => {
    const fetcher = async (_iso: string) =>
      makeImage(800, 1200, "File:Vertical.jpg") as never;
    const used = new Set<string>();
    await assert.rejects(
      () => findEligiblePotd("2026-04-26", used, 3, fetcher),
      /no_eligible_potd/,
    );
  });

  it("imagem quadrada (w=h) é aceita", async () => {
    const fetcher = async (_iso: string) =>
      makeImage(1000, 1000, "File:Square.jpg") as never;
    const used = new Set<string>();
    const r = await findEligiblePotd("2026-04-26", used, 7, fetcher);
    assert.equal(r.image.title, "File:Square.jpg");
  });
});

describe("chooseSides (#192)", () => {
  it("rand < 0.5 → real=A, ai=B", () => {
    assert.deepEqual(chooseSides(0), { realSide: "A", aiSide: "B" });
    assert.deepEqual(chooseSides(0.4), { realSide: "A", aiSide: "B" });
    assert.deepEqual(chooseSides(0.4999), { realSide: "A", aiSide: "B" });
  });

  it("rand >= 0.5 → real=B, ai=A", () => {
    assert.deepEqual(chooseSides(0.5), { realSide: "B", aiSide: "A" });
    assert.deepEqual(chooseSides(0.7), { realSide: "B", aiSide: "A" });
    assert.deepEqual(chooseSides(0.9999), { realSide: "B", aiSide: "A" });
  });

  it("realSide e aiSide são sempre opostos", () => {
    for (const r of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      const s = chooseSides(r);
      assert.notEqual(s.realSide, s.aiSide);
    }
  });
});

describe("buildEaiMd (#192)", () => {
  it("escreve frontmatter com mapping A:real, B:ia quando realSide=A", () => {
    const md = buildEaiMd({ realSide: "A", aiSide: "B" }, "Credit line.");
    assert.match(md, /^---\n/, "começa com delimitador de frontmatter");
    assert.match(md, /eai_answer:/);
    assert.match(md, /A: real/);
    assert.match(md, /B: ia/);
    assert.match(md, /---\n\nÉ IA\?\n/, "frontmatter fecha antes do header");
    assert.match(md, /Credit line\./);
  });

  it("escreve frontmatter com mapping A:ia, B:real quando realSide=B", () => {
    const md = buildEaiMd({ realSide: "B", aiSide: "A" }, "Credit line.");
    assert.match(md, /A: ia/);
    assert.match(md, /B: real/);
  });

  it("frontmatter pode ser parseado por regex (compatível com render-newsletter-html)", () => {
    const md = buildEaiMd({ realSide: "A", aiSide: "B" }, "Credit line.");
    const fmMatch = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    assert.ok(fmMatch, "frontmatter encontrado");
    assert.match(fmMatch![1], /A: real/);
    assert.match(fmMatch![2], /Credit line\./);
  });
});

describe("isStage4Complete (#192 resume-aware)", () => {
  function makeDir(): string {
    const root = mkdtempSync(join(tmpdir(), "diaria-eai-stage4-"));
    mkdirSync(join(root, "_internal"), { recursive: true });
    return root;
  }

  function touch(path: string): void {
    writeFileSync(path, "x");
  }

  it("false quando nada existe", () => {
    const dir = makeDir();
    try {
      assert.equal(isStage4Complete(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("true quando todos os 4 outputs (md + meta + A/B) existem", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eai.md"));
      touch(join(dir, "_internal/01-eai-meta.json"));
      touch(join(dir, "01-eai-A.jpg"));
      touch(join(dir, "01-eai-B.jpg"));
      assert.equal(isStage4Complete(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("true para edições legacy com real/ia (backward compat)", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eai.md"));
      touch(join(dir, "_internal/01-eai-meta.json"));
      touch(join(dir, "01-eai-real.jpg"));
      touch(join(dir, "01-eai-ia.jpg"));
      assert.equal(isStage4Complete(dir), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false quando md existe mas par de imagens incompleto", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eai.md"));
      touch(join(dir, "_internal/01-eai-meta.json"));
      touch(join(dir, "01-eai-A.jpg")); // só A, falta B
      assert.equal(isStage4Complete(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("false quando imagens existem mas meta JSON falta", () => {
    const dir = makeDir();
    try {
      touch(join(dir, "01-eai.md"));
      touch(join(dir, "01-eai-A.jpg"));
      touch(join(dir, "01-eai-B.jpg"));
      // sem _internal/01-eai-meta.json
      assert.equal(isStage4Complete(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildPrevResultLine (#107)", () => {
  it("retorna linha formatada com pct válido", () => {
    const line = buildPrevResultLine({
      total_responses: 30,
      pct_correct: 85,
      below_threshold: false,
    });
    assert.equal(line, "Resultado da última edição: 85% das pessoas acertaram.");
  });

  it("retorna null quando stats é null (sem arquivo)", () => {
    assert.equal(buildPrevResultLine(null), null);
  });

  it("retorna null quando skipped (ai_side ausente, no previous edition, etc)", () => {
    assert.equal(
      buildPrevResultLine({ skipped: "no_previous_edition" }),
      null,
    );
    assert.equal(buildPrevResultLine({ skipped: "ai_side_null" }), null);
  });

  it("retorna null quando 0 respostas", () => {
    assert.equal(
      buildPrevResultLine({ total_responses: 0, pct_correct: null }),
      null,
    );
  });

  it("retorna null quando below_threshold (poucos votos)", () => {
    assert.equal(
      buildPrevResultLine({
        total_responses: 3,
        pct_correct: null,
        below_threshold: true,
      }),
      null,
    );
  });

  it("retorna null quando pct_correct é null mesmo com respostas", () => {
    // Cenário: ai_side não foi setado então não dá pra calcular correctChoice
    assert.equal(
      buildPrevResultLine({
        total_responses: 10,
        pct_correct: null,
        below_threshold: false,
      }),
      null,
    );
  });

  it("aceita 0% (todos erraram) como resultado válido", () => {
    const line = buildPrevResultLine({
      total_responses: 30,
      pct_correct: 0,
      below_threshold: false,
    });
    assert.equal(line, "Resultado da última edição: 0% das pessoas acertaram.");
  });

  it("aceita 100% (todos acertaram) como resultado válido", () => {
    const line = buildPrevResultLine({
      total_responses: 30,
      pct_correct: 100,
      below_threshold: false,
    });
    assert.equal(
      line,
      "Resultado da última edição: 100% das pessoas acertaram.",
    );
  });
});

describe("readPrevPollStats (#107)", () => {
  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "diaria-prev-stats-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    return dir;
  }

  it("retorna null quando o arquivo não existe", () => {
    const dir = makeDir();
    try {
      assert.equal(readPrevPollStats(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retorna null quando JSON inválido", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, "_internal/04-eai-poll-stats.json"), "{ not json");
      assert.equal(readPrevPollStats(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parseia stats válidos", () => {
    const dir = makeDir();
    try {
      const stats = {
        total_responses: 42,
        pct_correct: 76,
        below_threshold: false,
      };
      writeFileSync(
        join(dir, "_internal/04-eai-poll-stats.json"),
        JSON.stringify(stats),
      );
      const parsed = readPrevPollStats(dir);
      assert.equal(parsed?.total_responses, 42);
      assert.equal(parsed?.pct_correct, 76);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildEaiMd com prevResultLine (#107)", () => {
  it("inclui linha de resultado após o crédito quando passada", () => {
    const md = buildEaiMd(
      { realSide: "A", aiSide: "B" },
      "Credit line.",
      "Resultado da última edição: 85% das pessoas acertaram.",
    );
    assert.match(md, /Credit line\.\n\nResultado da última edição: 85%/);
  });

  it("omite linha de resultado quando null (default)", () => {
    const md = buildEaiMd(
      { realSide: "A", aiSide: "B" },
      "Credit line.",
    );
    assert.ok(!md.includes("Resultado da última edição"));
  });

  it("omite linha de resultado quando explicitamente null", () => {
    const md = buildEaiMd(
      { realSide: "A", aiSide: "B" },
      "Credit line.",
      null,
    );
    assert.ok(!md.includes("Resultado"));
  });
});
