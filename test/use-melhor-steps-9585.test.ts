/**
 * test/use-melhor-steps-9585.test.ts (#9585)
 * Passos do tutorial extraídos da fonte chegam ao social-writer via use-melhor-post.json.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractUseMelhorSteps, enrichUseMelhorItem } from "../scripts/lib/use-melhor-post.ts";
import { htmlToText } from "../scripts/fetch-source-text.ts";
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
  it("sumário numerado antes dos passos reais: fica com a lista mais longa", () => {
    const t = "1. Introdução geral\n2. Configuração\nPasso 1: Abra o app agora\nPasso 2: Ligue o modo X\nPasso 3: Salve tudo";
    assert.deepEqual(extractUseMelhorSteps(t), ["Abra o app agora", "Ligue o modo X", "Salve tudo"]);
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
  it("<ol><li> sem numeração literal vira passos", async () => {
    const d = edition();
    const { state } = await runSelectionWithSteps(d, ON, {
      fetchImpl: html("<ol><li>Crie o formulário</li><li>Conecte ao GPT</li></ol>") as never,
    });
    assert.deepEqual(state.item!.steps, ["Crie o formulário", "Conecte ao GPT"]);
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

describe("texto completo da fonte do ## um (#9871)", () => {
  it("grava _internal/use-melhor-source.txt sem o corte de 6000 chars e aponta source_text_path", async () => {
    const d = edition();
    const longo = "x".repeat(9000);
    const { state } = await runSelectionWithSteps(d, ON, { fetchImpl: html(`<p>Passo 1: Abra</p><p>${longo}</p>`) as never });
    assert.equal(state.item!.source_text_path, "_internal/use-melhor-source.txt");
    const txt = readFileSync(join(d, state.item!.source_text_path!), "utf8");
    assert.ok(txt.includes(longo), "texto da fonte truncado");
    assert.ok(state.item!.body!.length <= 6000);
    const gravado = JSON.parse(readFileSync(join(d, "_internal", "use-melhor-post.json"), "utf8"));
    assert.equal(gravado.item.source_text_path, "_internal/use-melhor-source.txt");
  });
  it("fetch falho: apaga texto velho de outro item e não aponta source_text_path", async () => {
    const d = edition();
    writeFileSync(join(d, "_internal", "use-melhor-source.txt"), "texto do item anterior");
    const { state } = await runSelectionWithSteps(d, ON, { fetchImpl: (async () => { throw new Error("rede"); }) as never });
    assert.equal(state.item!.source_text_path, undefined);
    assert.equal(existsSync(join(d, "_internal", "use-melhor-source.txt")), false);
  });
});

describe("achados do review #9602", () => {
  it("<ol> aninhado: sub-lista não vira passo nem consome o número do pai", () => {
    const t = htmlToText("<ol><li>Abra o app<ol><li>sub um</li><li>sub dois</li></ol></li><li>Salve tudo</li><li>Envie o link</li></ol>");
    assert.deepEqual(extractUseMelhorSteps(t), ["Abra o app", "Salve tudo", "Envie o link"]);
  });
  it("<ol start> e <li value> respeitados", () => {
    assert.match(htmlToText('<ol start="3"><li>Terceiro</li><li>Quarto</li></ol>'), /3\. Terceiro[\s\S]*4\. Quarto/);
    assert.match(htmlToText('<ol><li value="5">Quinto</li></ol>'), /5\. Quinto/);
  });
  it("passo curto não é descartado nem trunca a lista", () => {
    assert.deepEqual(extractUseMelhorSteps("1. Abra o app agora\n2. Salve\n3. Envie o link"), ["Abra o app agora", "Salve", "Envie o link"]);
  });
});

describe("preserved/forceReselect (#9610)", () => {
  const body = html("<p>Passo 1: Crie o formulário</p><p>Passo 2: Conecte ao GPT</p>");
  const reviewed = "**🛠️ USE MELHOR**\n\n**[T](https://example.com/tut)**\nDescrição (5 min)\n";
  it("item preservado: não rebusca a fonte", async () => {
    const d = edition();
    await runSelectionWithSteps(d, ON, { fetchImpl: body as never });
    writeFileSync(join(d, "02-reviewed.md"), reviewed);
    let calls = 0;
    const spy = (async () => { calls++; return body(); }) as never;
    const r = await runSelectionWithSteps(d, ON, { useReviewed: true, fetchImpl: spy });
    assert.equal(r.preserved, true);
    assert.equal(calls, 0);
  });
  it("forceReselect rebusca", async () => {
    const d = edition();
    await runSelectionWithSteps(d, ON, { fetchImpl: body as never });
    writeFileSync(join(d, "02-reviewed.md"), reviewed);
    let calls = 0;
    const spy = (async () => { calls++; return body(); }) as never;
    await runSelectionWithSteps(d, ON, { useReviewed: true, forceReselect: true, fetchImpl: spy });
    assert.equal(calls, 1);
  });
});
