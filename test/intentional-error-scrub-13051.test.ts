/**
 * #13051 — o erro intencional da diária nunca sai da edição em que foi
 * plantado. Caso real (pacote 26w46): a 261111 plantou "Appel" no lugar de
 * "Apple" e o título com o erro foi para a seleção da Stack, o payload do
 * post, o e-mail Kit e as prévias.
 *
 * Cobre: o helper (scrub + guard), a seleção da Stack, o manifest e o
 * agendamento da retro semanal, o artigo LinkedIn semanal, o mensal e o anual.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  findIntentionalErrorLeaks,
  jsonlPathForEditionDir,
  loadIntentionalErrorPair,
  loadWindowIntentionalErrors,
  pairFromRecord,
  readReviewedMdScrubbed,
  scrubIntentionalError,
} from "../scripts/lib/intentional-error-scrub.ts";
import { runCircleStack, type RunCircleStackDeps } from "../scripts/publish-circle-stack.ts";
import { main as weeklySocialMain } from "../scripts/publish-weekly-social.ts";
import { main as renderLinkedinMain } from "../scripts/render-linkedin-weekly.ts";
import { collectMonth } from "../scripts/collect-monthly.ts";
import { destaquesForPost } from "../scripts/collect-annual.ts";
import type { UnifiedCachedPost } from "../scripts/lib/shared/edition-cache-reader.ts";

const ROOT = resolve(import.meta.dirname, "..");
const ERR_261111 = {
  description: "Grafia trocada da marca no título de um item do RADAR",
  location: "RADAR, item 2",
  category: "ortografico",
  wrong_value: "Appel",
  correct_value: "Apple",
  reveal: "Na última edição, escrevi Appel onde o correto é Apple.",
};

function writeErrorJson(editionDir: string, rec: Record<string, unknown> = ERR_261111): void {
  mkdirSync(join(editionDir, "_internal"), { recursive: true });
  writeFileSync(join(editionDir, "_internal", "intentional-error.json"), JSON.stringify(rec, null, 2));
}

const tmpRoots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

describe("#13051 helper: scrub + guard", () => {
  const pair = { edition: "261111", wrong: "Appel", correct: "Apple" };

  it("troca a grafia errada pela correta, palavra inteira", () => {
    assert.equal(scrubIntentionalError("A Appel lança o chip. Appel!", pair), "A Apple lança o chip. Apple!");
    // Não mexe dentro de outra palavra.
    assert.equal(scrubIntentionalError("Appeltree e Appel", pair), "Appeltree e Apple");
  });

  it("nunca mexe dentro de URL (valor numérico não quebra link)", () => {
    const num = { edition: "261111", wrong: "2025", correct: "2026" };
    const text = "[Relatório de 2025](https://exemplo.com/2025/relatorio) saiu em 2025.";
    assert.equal(
      scrubIntentionalError(text, num),
      "[Relatório de 2026](https://exemplo.com/2025/relatorio) saiu em 2026.",
    );
    assert.deepEqual(findIntentionalErrorLeaks("https://exemplo.com/2025/x", [num]), []);
  });

  it("par nulo quando não há o que trocar (no_error, placeholder, igual, ausente)", () => {
    assert.equal(pairFromRecord("261111", { ...ERR_261111, no_error: true }), null);
    assert.equal(pairFromRecord("261111", { wrong_value: "{PREENCHER — grafia}", correct_value: "Apple" }), null);
    assert.equal(pairFromRecord("261111", { wrong_value: "Apple", correct_value: "Apple" }), null);
    assert.equal(pairFromRecord("261111", { correct_value: "Apple" }), null);
    assert.equal(scrubIntentionalError("Appel", null), "Appel");
  });

  it("lê o JSON da edição e cai no data/intentional-errors.jsonl sem ele", () => {
    const root = tmp("ie-13051-jsonl-");
    const editionsRoot = join(root, "data", "editions");
    const withJson = join(editionsRoot, "2611", "261111");
    const legacy = join(editionsRoot, "2605", "260506");
    mkdirSync(withJson, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    writeErrorJson(withJson);
    writeFileSync(
      join(root, "data", "intentional-errors.jsonl"),
      JSON.stringify({ edition: "260506", error_type: "ortografico", is_feature: true, wrong_value: "Gmial", correct_value: "Gmail" }) + "\n",
    );
    assert.equal(jsonlPathForEditionDir(legacy), join(root, "data", "intentional-errors.jsonl"));
    assert.deepEqual(loadIntentionalErrorPair(withJson, "261111"), pair);
    assert.deepEqual(loadIntentionalErrorPair(legacy, "260506"), { edition: "260506", wrong: "Gmial", correct: "Gmail" });
    assert.deepEqual(
      loadWindowIntentionalErrors(editionsRoot, ["260506", "261111", "261112"]).map((p) => p.wrong),
      ["Gmial", "Appel"],
    );
    // JSON com no_error vence o JSONL.
    writeErrorJson(legacy, { no_error: true });
    assert.equal(loadIntentionalErrorPair(legacy, "260506"), null);
  });

  it("guard reprova o texto com Appel e aprova o corrigido", () => {
    const leaks = findIntentionalErrorLeaks("Radar: Appel lança chip; Appel de novo", [pair]);
    assert.equal(leaks.length, 1);
    assert.equal(leaks[0].count, 2);
    assert.deepEqual(findIntentionalErrorLeaks("Radar: Apple lança chip", [pair]), []);
  });
});

// ── Stack ───────────────────────────────────────────────────────────────────

const STACK_MD = [
  "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
  "",
  "**[Appel lança agente de programação no Xcode](https://www.apple.com/newsroom/xcode-agent)**",
  "",
  "A Appel colocou um agente de programação dentro do Xcode.",
  "",
  "Por que isso importa:",
  "",
  "Quem constrói app para iPhone ganha um agente no próprio editor.",
  "",
  "---",
  "",
  "**📡 RADAR**",
  "",
  "**[Appel testa chip próprio para IA em servidores](https://exemplo.com/appel-chip)**",
  "A empresa quer rodar modelos sem depender de GPU de terceiros.",
  "",
].join("\n");

function stackSetup() {
  const dataRoot = tmp("ie-13051-stack-");
  const dir = join(dataRoot, "data", "editions", "2611", "261111");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), STACK_MD, "utf8");
  writeErrorJson(dir);
  const selectionPath = join(dataRoot, "data", "weekly", "26w46", "_internal", "circle-stack-selection.json");
  const deps: RunCircleStackDeps = {
    rootDir: ROOT,
    platformConfig: { circle_stack: { enabled: true } },
    env: {},
    translateCall: () => JSON.stringify({ items: [] }),
    send: async () => {
      throw new Error("não deveria enviar");
    },
    ghRun: () => ({ status: 0, stdout: "[]", stderr: "" }),
    topVideo: async () => null,
  };
  return { dataRoot, selectionPath, deps, base: ["--publish-monday", "261116", "--data-root", dataRoot, "--no-translate"] };
}

async function quiet<T>(fn: () => Promise<T>): Promise<{ warns: string[]; value?: T; error?: unknown }> {
  const warns: string[] = [];
  const ow = console.warn;
  const ol = console.log;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  console.log = () => {};
  try {
    return { warns, value: await fn() };
  } catch (error) {
    return { warns, error };
  } finally {
    console.warn = ow;
    console.log = ol;
  }
}

describe("#13051 Stack: seleção e post sem o erro intencional", () => {
  it("a seleção da 261111 sai com Apple, nunca Appel (cenário real 26w46)", async () => {
    const t = stackSetup();
    const r = await quiet(() => runCircleStack(t.base, t.deps));
    assert.equal(r.error, undefined, String(r.error));
    const raw = readFileSync(t.selectionPath, "utf8");
    assert.doesNotMatch(raw, /\bAppel\b/);
    assert.match(raw, /Apple lança agente de programação no Xcode/);
    // URL com "appel" fica intacta (não é texto).
    const md = readFileSync(join(t.dataRoot, "data", "weekly", "26w46", "circle-stack-26w46.md"), "utf8");
    assert.doesNotMatch(md, /\bAppel\b/);
    assert.ok(!r.warns.some((w) => w.includes("erro intencional")), r.warns.join("\n"));
  });

  it("guard: seleção gravada com Appel avisa na prévia e recusa o --publish", async () => {
    const t = stackSetup();
    await quiet(() => runCircleStack(t.base, t.deps));
    // Simula a seleção montada antes do fix (o que aconteceu no 26w46).
    writeFileSync(t.selectionPath, readFileSync(t.selectionPath, "utf8").replace(/Apple lança/g, "Appel lança"));
    const dry = await quiet(() => runCircleStack(t.base, t.deps));
    assert.equal(dry.error, undefined, String(dry.error));
    assert.ok(dry.warns.some((w) => /"Appel".*261111.*"Apple"/.test(w)), dry.warns.join("\n"));
    const pub = await quiet(() => runCircleStack([...t.base, "--publish"], t.deps));
    assert.ok(pub.error instanceof Error, "deveria recusar o --publish");
    assert.match((pub.error as Error).message, /erro intencional da diária vazou/);
  });
});

// ── Retro semanal ───────────────────────────────────────────────────────────

describe("#13051 retro semanal: manifest e legenda sem o erro intencional", () => {
  // Sábado futuro, mesma convenção do publish-weekly-social.test.ts.
  const saturdayStr = "271225";
  const TITLE = "Appel põe assistente no relógio";
  const URL = "https://exemplo.com/relogio";

  function setup(): { editionsRoot: string; dataRoot: string } {
    const editionsRoot = tmp("ie-13051-weekly-ed-");
    const dataRoot = tmp("ie-13051-weekly-data-");
    const dir = join(editionsRoot, "271220");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "02-reviewed.md"),
      `DESTAQUE 1 | Notícias\n${TITLE}\n${URL}\n\nA Appel lançou o recurso.\n\nPor que isso importa:\nExplicação D1.`,
    );
    writeFileSync(join(dir, "06-public-images.json"), JSON.stringify({ images: { d1: { url: "https://cdn.example.com/d1.jpg" } } }));
    writeErrorJson(dir);
    return { editionsRoot, dataRoot };
  }
  const args = (editionsRoot: string) => ["--saturday", saturdayStr, "--mode", "highlights", "--editions-root", editionsRoot, "--force-incomplete-week"];
  const opts = (dataRoot: string) => ({
    dataRoot,
    flatCardGenerator: async ({ kvKey }: { kvKey: string }) => ({ url: `https://cdn.example.com/flat/${kvKey}` }),
    newsCardGenerator: async ({ kvKey }: { kvKey: string }) => ({ url: `https://cdn.example.com/news/${kvKey}` }),
  });

  async function capture(fn: () => Promise<void>): Promise<{ out: string; err: string; exit: number | null }> {
    let out = "";
    let err = "";
    let exit: number | null = null;
    const ol = console.log;
    const oe = console.error;
    const ox = process.exit;
    console.log = (...a: unknown[]) => void (out += a.map(String).join(" ") + "\n");
    console.error = (...a: unknown[]) => void (err += a.map(String).join(" ") + "\n");
    process.exit = ((code?: number) => {
      exit = code ?? 0;
      throw new Error("__exit__");
    }) as typeof process.exit;
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "__exit__") throw e;
    } finally {
      console.log = ol;
      console.error = oe;
      process.exit = ox;
    }
    return { out, err, exit };
  }

  it("--summary-manifest sai com Apple no título e no corpo", async () => {
    const { editionsRoot, dataRoot } = setup();
    const { out } = await capture(() => weeklySocialMain([...args(editionsRoot), "--summary-manifest"], opts(dataRoot)));
    const json = JSON.parse(out);
    assert.equal(json.items[0].title, "Apple põe assistente no relógio");
    assert.match(json.items[0].body, /A Apple lançou/);
    assert.doesNotMatch(out, /\bAppel\b/);
  });

  it("guard: resumo com Appel aborta o --schedule antes de qualquer envio", async () => {
    const { editionsRoot, dataRoot } = setup();
    const dir = join(dataRoot, "weekly", `${saturdayStr}-highlights`, "_internal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "06-summaries.json"),
      JSON.stringify({ items: [{ url: URL, summary: "A Appel quer vender mais iPhones com a novidade." }] }),
    );
    const r = await capture(() => weeklySocialMain([...args(editionsRoot), "--schedule"], opts(dataRoot)));
    assert.equal(r.exit, 1);
    assert.match(r.err, /"Appel" \(erro intencional da 271220; o correto é "Apple"/);
  });
});

// ── LinkedIn semanal ────────────────────────────────────────────────────────

describe("#13051 LinkedIn semanal: guard no render", () => {
  it("artigo com Appel falha o render (exit 1) sem gravar o HTML", () => {
    const root = tmp("ie-13051-ln-");
    const dir = join(root, "data/weekly/26w46/_internal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "ln-selection.json"),
      JSON.stringify({
        cycle: "26w46",
        headlines: [{ title: "Appel testa chip próprio", body: "Corpo", why: "", editionDate: "261111" }],
        useMelhor: null,
        weeklyEditions: [],
      }),
    );
    writeErrorJson(join(root, "data/editions/2611/261111"));
    const argv = process.argv;
    const ox = process.exit;
    const oe = console.error;
    let exit: number | null = null;
    let err = "";
    process.argv = ["node", "render-linkedin-weekly.ts", "--cycle", "26w46", "--opening", "Abertura.", "--closing", "Fecho."];
    process.exit = ((code?: number) => {
      exit = code ?? 0;
      throw new Error("__exit__");
    }) as typeof process.exit;
    console.error = (...a: unknown[]) => void (err += a.join(" "));
    try {
      assert.throws(() => renderLinkedinMain(root), /__exit__/);
    } finally {
      process.argv = argv;
      process.exit = ox;
      console.error = oe;
    }
    assert.equal(exit, 1);
    assert.match(err, /"Appel"/);
  });
});

// ── Mensal e anual ──────────────────────────────────────────────────────────

const MONTHLY_MD = [
  "**DESTAQUE 1 | 🚀 LANÇAMENTO**",
  "",
  "**[Appel lança agente no Xcode](https://www.apple.com/newsroom/xcode-agent)**",
  "",
  "A Appel colocou um agente dentro do Xcode.",
  "",
  "Por que isso importa:",
  "",
  "Quem constrói app ganha um agente no editor da Appel.",
].join("\n");

describe("#13051 mensal e anual: raw-destaques sem o erro intencional", () => {
  it("collectMonth troca Appel por Apple (JSON da edição e fallback do JSONL)", () => {
    const base = tmp("ie-13051-monthly-");
    const editionsRoot = join(base, "data", "editions");
    const rawPostsRoot = join(base, "cycle");
    mkdirSync(join(rawPostsRoot, "raw-posts"), { recursive: true });
    for (const ed of ["261111", "261112"]) {
      mkdirSync(join(editionsRoot, ed), { recursive: true });
      writeFileSync(join(editionsRoot, ed, "02-reviewed.md"), MONTHLY_MD);
    }
    writeErrorJson(join(editionsRoot, "261111"));
    writeFileSync(
      join(base, "data", "intentional-errors.jsonl"),
      JSON.stringify({ edition: "261112", error_type: "ortografico", is_feature: true, wrong_value: "Appel", correct_value: "Apple" }) + "\n",
    );
    const r = collectMonth("2611", rawPostsRoot, editionsRoot);
    assert.equal(r.destaques.length, 2);
    for (const d of r.destaques) {
      assert.equal(d.title, "Apple lança agente no Xcode");
      assert.doesNotMatch(JSON.stringify(d), /\bAppel\b/);
    }
  });

  it("destaquesForPost (anual) troca Appel por Apple no markdown local", () => {
    const root = tmp("ie-13051-annual-");
    const dir = join(root, "261111");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), MONTHLY_MD.replace("**DESTAQUE 1 | 🚀 LANÇAMENTO**", "**DESTAQUE 1 | CATEGORIA**"));
    writeErrorJson(dir);
    const post: UnifiedCachedPost = { origin: "beehiiv", status: "confirmed", slug: "post-x", content: { free: { web: "<html></html>" } } };
    const r = destaquesForPost(post, "261111", new Map([["261111", dir]]), []);
    assert.equal(r.source, "edicoes-locais");
    assert.equal(r.destaques[0].title, "Apple lança agente no Xcode");
    assert.doesNotMatch(JSON.stringify(r.destaques), /\bAppel\b/);
  });

  it("readReviewedMdScrubbed devolve o markdown sem o erro", () => {
    const root = tmp("ie-13051-read-");
    writeFileSync(join(root, "02-reviewed.md"), MONTHLY_MD);
    writeErrorJson(root);
    assert.doesNotMatch(readReviewedMdScrubbed(root, "261111"), /\bAppel\b/);
  });
});
