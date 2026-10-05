/**
 * test/use-melhor-steps-9585.test.ts (#9585)
 * Passos do tutorial extraídos da fonte chegam ao social-writer via use-melhor-post.json.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractUseMelhorSteps, enrichUseMelhorItem } from "../scripts/lib/use-melhor-post.ts";
import { runSelectionWithSteps } from "../scripts/select-use-melhor-post.ts";

const ON = { enabled: true, time: "08:00" } as never;
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function edition(): string {
  const d = mkdtempSync(join(tmpdir(), "um9585-"));
  dirs.push(d);
  mkdirSync(join(d, "_internal"), { recursive: true });
  writeFileSync(join(d, "_internal", "01-approved.json"), JSON.stringify({
    use_melhor: [{ url: "https://example.com/tut", title: "T", summary: "S", score: 80 }],
  }));
  return d;
}
const html = (body: string) => async () =>
  new Response(`<html><body>${body}</body></html>`, { status: 200, headers: { "content-type": "text/html" } });

describe("extractUseMelhorSteps", () => {
  it("extrai Passo N e 'N.' na ordem", () => {
    assert.deepEqual(extractUseMelhorSteps("Intro\nPasso 1: Crie o form\nPasso 2: Ligue o GPT"), ["Crie o form", "Ligue o GPT"]);
    assert.deepEqual(extractUseMelhorSteps("1. Abra o jotform aqui\n2. Copie o link do form"), ["Abra o jotform aqui", "Copie o link do form"]);
  });
  it("sem passos / numeração solta / sequência quebrada → []", () => {
    assert.deepEqual(extractUseMelhorSteps("Um ensaio sem lista."), []);
    assert.deepEqual(extractUseMelhorSteps("2025. Um ano importante para IA"), []);
    assert.deepEqual(extractUseMelhorSteps("1. Só um passo sozinho aqui"), []);
    assert.deepEqual(extractUseMelhorSteps("1. Primeiro passo aqui\n3. Terceiro passo aqui"), []);
  });
  it("enrich só põe steps quando há", () => {
    const base = { url: "u", title: "t", summary: "s", score: 1 };
    assert.equal(enrichUseMelhorItem(base, "texto").steps, undefined);
    assert.equal(enrichUseMelhorItem(base, "texto").body, "texto");
  });
});

describe("runSelectionWithSteps", () => {
  it("grava steps/body no use-melhor-post.json", async () => {
    const d = edition();
    const { written } = await runSelectionWithSteps(d, ON, {
      fetchImpl: html("<p>Passo 1: Crie o formulário</p><p>Passo 2: Conecte ao GPT</p>") as never,
    });
    const st = JSON.parse(readFileSync(written!, "utf8"));
    assert.deepEqual(st.item.steps, ["Crie o formulário", "Conecte ao GPT"]);
    assert.ok(st.item.body.includes("Passo 1"));
  });
  it("fonte sem passos → item sem steps", async () => {
    const d = edition();
    const { state } = await runSelectionWithSteps(d, ON, { fetchImpl: html("<p>Ensaio longo sem lista.</p>") as never });
    assert.equal(state.item!.steps, undefined);
  });
  it("fetch falho é fail-soft e mantém o item", async () => {
    const d = edition();
    const { state } = await runSelectionWithSteps(d, ON, { fetchImpl: (async () => { throw new Error("rede"); }) as never });
    assert.equal(state.item!.url, "https://example.com/tut");
    assert.equal(state.item!.steps, undefined);
  });
});
