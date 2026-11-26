/**
 * Regressão #13884 (resíduo da PR #13899): a fatia mecânica baixou o texto do
 * pool só no passo 0 do Stage 2 e acusou a falha só no gate 4. Faltavam:
 *
 *   - item 4 do resíduo: item que entra no pool (ou desce a ele) no gate 4
 *     só ganhava texto se o passo 0 do Stage 2 rodasse de novo. Agora o
 *     `next_steps` de `swap-destaque.ts`/`swap-destaques.ts`/
 *     `promote-to-destaque.ts` e o §4d do playbook rodam
 *     `refresh-destaque-sources.ts --pool-sources`;
 *   - item 2 do resíduo: o gate 1 (`01-categorized.md`) não mostrava a fonte
 *     não lida. Agora `renderLine` marca `📄❌ (fonte não lida: {motivo})`,
 *     com a mesma regra do `source-not-read` e, quando já há download
 *     (re-render depois do Stage 2), o motivo do download.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { renderLine, renderSection, sourceNotReadMarker } from "../scripts/render-categorized-md.ts";
import { parseSections } from "../scripts/apply-gate-edits.ts";
import { readSourceDownloads } from "../scripts/lib/diaria/source-readability.ts";
import { prefetchPoolSources, readPoolSourcesManifest } from "../scripts/lib/diaria/pool-sources.ts";
import { refreshDestaqueSources } from "../scripts/refresh-destaque-sources.ts";
import { buildSwapDestaqueSteps } from "../scripts/swap-destaque.ts";
import { buildSwapNextSteps } from "../scripts/swap-destaques.ts";
import type { Article } from "../scripts/lib/types/article.ts";
import { readStage4Playbook } from "../scripts/lib/stage4-playbook.ts";

const LONG = "Um resumo de verdade, com o fato, quem fez, quanto e por que importa para o leitor.";
const MS = "https://microsoft.ai/news/seven-new-world-class-models-at-scalable-price-performance/";
const OK = "https://ok.example.com/tutorial";
const SHORT = "https://short.example.com/post";

function art(over: Partial<Article> & { url: string }): Article {
  return { title: "Título", date: "2026-11-24", ...over } as Article;
}

function fakeFetch(calls: string[], blocked: Set<string> = new Set()): typeof fetch {
  return (async (input: string | URL) => {
    const u = String(input);
    calls.push(u);
    if (blocked.has(u)) return new Response("forbidden", { status: 403 });
    return new Response(`<p>TEXTO DA PAGINA ${u}</p>`, { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
}

describe("gate 1: marcador de fonte não lida (#13884 resíduo item 2)", () => {
  it("resumo curto marca o item com o motivo; resumo longo não marca", () => {
    const short = renderLine(art({ url: SHORT, summary: "Curto.", verify_verdict: "accessible" } as never), false, false, 1);
    assert.match(short, /📄❌ \(fonte não lida: resumo de 6 caracteres \(mínimo 60\)\)/);
    const long = renderLine(art({ url: OK, summary: LONG, verify_verdict: "accessible" } as never), false, false, 2);
    assert.doesNotMatch(long, /📄❌/);
  });

  it("veredito de acesso ruim (403 no verify) marca o item", () => {
    const line = renderLine(art({ url: MS, summary: LONG, verify_verdict: "anti_bot", verify_note: "GET 403" } as never));
    assert.match(line, /📄❌ \(fonte não lida: verify anti_bot \(GET 403\)\)/);
  });

  it("download registrado decide antes do resumo: página lida tira a marca, download falho põe o motivo do download", () => {
    const downloads = new Map([
      [SHORT, { ok: true }],
      [MS, { ok: false, reason: "download da página falhou: HTTP 403: fonte bloqueada; tente equivalente" }],
    ]);
    assert.equal(sourceNotReadMarker(art({ url: SHORT, summary: "Curto.", verify_verdict: "accessible" } as never), downloads), null);
    assert.equal(
      sourceNotReadMarker(art({ url: MS, summary: LONG, verify_verdict: "accessible" } as never), downloads),
      "📄❌ (fonte não lida: download da página falhou: HTTP 403: fonte bloqueada; tente equivalente)",
    );
  });

  it("motivo com travessão ou URL não quebra o parser do gate (a URL do item continua sendo achada)", () => {
    const downloads = new Map([[MS, { ok: false, reason: "falhou — ver https://outro.example.com/x -- e – mais" }]]);
    const marker = sourceNotReadMarker(art({ url: MS, summary: LONG } as never), downloads)!;
    assert.doesNotMatch(marker, /https?:\/\/|—|–|--/);
    const md = renderSection("Lançamentos", [art({ url: MS, summary: LONG, score: 70 } as never)], new Set(), new Set(), 1, downloads);
    assert.deepEqual(parseSections(md).lancamento, [MS]);
  });

  it("item do inbox com o marcador #778 não repete o veredito sem download registrado", () => {
    const a = art({ url: MS, summary: LONG, editor_submitted: true, verify_verdict: "anti_bot" } as never);
    const line = renderLine(a);
    assert.match(line, /não checado: anti_bot/);
    assert.doesNotMatch(line, /📄❌/);
    const withDl = renderLine(a, false, false, 1, new Map([[MS, { ok: false, reason: "download da página falhou: HTTP 403" }]]));
    assert.match(withDl, /📄❌ \(fonte não lida: download da página falhou: HTTP 403\)/);
  });

  it("re-render depois do Stage 2 lê o manifest do pool em disco", async () => {
    const ed = mkdtempSync(join(tmpdir(), "gate1-13884-"));
    try {
      const internal = join(ed, "_internal");
      mkdirSync(internal, { recursive: true });
      await prefetchPoolSources({ lancamento: [{ url: MS, title: "MS", summary: LONG }], radar: [{ url: SHORT, title: "S", summary: "Curto." }] }, internal, {
        fetchImpl: fakeFetch([], new Set([MS])),
      });
      const downloads = readSourceDownloads(internal);
      assert.match(renderLine(art({ url: MS, summary: LONG } as never), false, false, 1, downloads), /📄❌ \(fonte não lida: download da página falhou: HTTP 403/);
      // #13907: download ok do pool não limpa o resumo curto (nenhum writer lê o texto).
      assert.match(renderLine(art({ url: SHORT, summary: "Curto." } as never), false, false, 2, downloads), /📄❌ \(fonte não lida: resumo de 6 caracteres/);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("a legenda do gate 1 explica o marcador", () => {
    const src = readFileSync(resolve(import.meta.dirname, "..", "scripts", "render-categorized-md.ts"), "utf8");
    assert.match(src, /> Marcador \\`📄❌\\` indica fonte não lida/);
  });
});

describe("gate 4: item que entra no pool ganha texto (#13884 resíduo item 4)", () => {
  it("next_steps de swap-destaque e swap-destaques rodam o refresh com --pool-sources", () => {
    assert.match(buildSwapDestaqueSteps("/ed/261124", 2, "Z")[0], /refresh-destaque-sources\.ts --edition-dir \/ed\/261124 --pool-sources /);
    assert.match(
      buildSwapNextSteps("/ed/261124", [{ position: 1, url: "https://novo.com/x", title: "X" }])[0],
      /refresh-destaque-sources\.ts --edition-dir \/ed\/261124 --pool-sources /,
    );
  });

  it("refresh com --pool-sources fora do Stage 2 baixa o destaque rebaixado ao pool, sem gravar o registro do writer", async () => {
    const ed = mkdtempSync(join(tmpdir(), "gate4-13884-"));
    try {
      const internal = join(ed, "_internal");
      mkdirSync(internal, { recursive: true });
      const demoted = "https://ex.com/ex-d2";
      writeFileSync(
        join(internal, "01-approved.json"),
        JSON.stringify({
          highlights: [{ rank: 1, url: "https://ex.com/d1", article: { url: "https://ex.com/d1", title: "d1", summary: LONG } }],
          radar: [{ url: demoted, title: "ex-D2", summary: LONG }],
        }),
      );
      const calls: string[] = [];
      const r = await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(calls), poolSources: true });
      assert.ok(r.pool_sources);
      assert.equal(readPoolSourcesManifest(internal).find((e) => e.url === demoted)?.status, "ok");
      assert.ok(calls.includes(demoted));
      assert.equal(existsSync(join(internal, "02-writer-inputs.json")), false, "registro do writer é só do Stage 2");
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("playbook do Stage 4 roda --pool-sources no §4d (item que entra no pool e §4d.1b)", () => {
    const pb = readStage4Playbook();
    const i4d = pb.indexOf("### 4d.1 — Edição inline");
    assert.ok(i4d > 0);
    const after = pb.slice(i4d);
    const hits = after.match(/refresh-destaque-sources\.ts --edition-dir \{EDITION_DIR\}\/ --pool-sources/g) ?? [];
    assert.ok(hits.length >= 2, `esperado o refresh com --pool-sources no §4d.1 e no §4d.1b, achado ${hits.length}`);
    assert.match(after, /Item que ENTROU no pool neste ajuste/);
  });
});
