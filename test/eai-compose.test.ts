import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findEligiblePotd } from "../scripts/eai-compose.ts";

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
