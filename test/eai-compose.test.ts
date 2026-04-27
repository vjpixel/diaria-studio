import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findEligiblePotd,
  chooseSides,
  buildEaiMd,
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
