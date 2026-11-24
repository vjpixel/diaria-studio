/**
 * Regressão #13884 — itens de pool (LANÇAMENTOS/RADAR/USE MELHOR/VÍDEOS)
 * entravam na edição sem ninguém ler a página. Caso real (edição 261124): o
 * item de LANÇAMENTOS "Seven new world-class models at scalable
 * price-performance" (microsoft.ai) chegou ao texto só com título e resumo.
 *
 * Cobre a fatia mecânica:
 *   - Stage 2 (`refresh-destaque-sources --record-writer-inputs`) baixa o
 *     texto de cada item de pool para `_internal/pool-sources/`, em paralelo,
 *     reusando o cache por URL;
 *   - download falho fica marcado com o motivo e aparece no gate 4
 *     (`source-not-read`) mesmo quando o resumo do Stage 1 era longo;
 *   - item com texto da página em disco não é acusado;
 *   - promover item a destaque herda o texto já lido (sem rede).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  poolSourceItems,
  poolSourceFileName,
  poolSourceTextPath,
  prefetchPoolSources,
  readPoolSourcesManifest,
  isYouTubeUrl,
} from "../scripts/lib/diaria/pool-sources.ts";
import { checkSourceNotRead, findUnreadItemsInEdition, readSourceDownloads } from "../scripts/lib/diaria/source-readability.ts";
import { refreshDestaqueSources } from "../scripts/refresh-destaque-sources.ts";
import { prefetchHighlightSources } from "../scripts/run-fact-checker.ts";

const LONG = "Um resumo de verdade, com o fato, quem fez, quanto e por que importa para o leitor.";
const MS = "https://microsoft.ai/news/seven-new-world-class-models-at-scalable-price-performance/";
const BLOCKED = "https://blocked.example.com/post";
const OK = "https://ok.example.com/tutorial";
const YT = "https://www.youtube.com/watch?v=abc";
const HL = ["https://ex.com/d1", "https://ex.com/d2"];

function approvedFixture() {
  return {
    highlights: HL.map((url, i) => ({ rank: i + 1, url, article: { url, title: `d${i + 1}`, summary: LONG } })),
    // Resumo LONGO: pela regra antiga (#12258) este item passava como lido.
    lancamento: [{ url: MS, title: "Seven new world-class models at scalable price-performance", verify_verdict: "accessible", summary: LONG }],
    radar: [
      { url: BLOCKED, title: "Bloqueado", verify_verdict: "accessible", summary: LONG },
      // Duplicado de destaque: não baixa de novo.
      { url: HL[0], title: "dup", summary: LONG },
    ],
    // Resumo curto: pela regra antiga, acusado; com a página lida, não.
    use_melhor: [{ article: { url: OK, title: "Tutorial", verify_verdict: "accessible", summary: "Curto." } }],
    video: [{ url: YT, title: "Vídeo", verify_verdict: "video", summary: LONG }],
  };
}

function fakeFetch(calls: string[], blocked: Set<string> = new Set()): typeof fetch {
  return (async (input: string | URL) => {
    const u = String(input);
    calls.push(u);
    if (blocked.has(u)) return new Response("forbidden", { status: 403 });
    return new Response(`<p>TEXTO DA PAGINA ${u}</p>`, { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
}

function setup(approved: unknown = approvedFixture()): string {
  const ed = mkdtempSync(join(tmpdir(), "pool-src-13884-"));
  mkdirSync(join(ed, "_internal"), { recursive: true });
  writeFileSync(join(ed, "_internal", "01-approved.json"), JSON.stringify(approved), "utf8");
  return ed;
}

describe("poolSourceItems (#13884)", () => {
  it("lista os itens de pool uma vez por URL, sem os destaques", () => {
    assert.deepEqual(
      poolSourceItems(approvedFixture()).map((i) => [i.bucket, i.url]),
      [["lancamento", MS], ["radar", BLOCKED], ["use_melhor", OK], ["video", YT]],
    );
    assert.deepEqual(poolSourceItems(null), []);
  });

  it("isYouTubeUrl", () => {
    assert.equal(isYouTubeUrl(YT), true);
    assert.equal(isYouTubeUrl("https://youtu.be/x"), true);
    assert.equal(isYouTubeUrl("https://m.youtube.com/watch?v=x"), true);
    assert.equal(isYouTubeUrl(MS), false);
    assert.equal(isYouTubeUrl("not a url"), false);
  });
});

describe("prefetchPoolSources (#13884)", () => {
  it("baixa o texto de cada item, marca o 403 e pula o YouTube; 2ª execução reusa o ok e tenta de novo a falha", async () => {
    const ed = setup();
    const internal = join(ed, "_internal");
    try {
      const calls: string[] = [];
      const r = await prefetchPoolSources(approvedFixture(), internal, { fetchImpl: fakeFetch(calls, new Set([BLOCKED])) });
      assert.deepEqual([...calls].sort(), [BLOCKED, MS, OK].sort(), "YouTube e destaque não vão à rede");
      assert.equal(r.ok, 2);
      assert.equal(r.fetched, 3);
      assert.deepEqual(r.unread.map((u) => [u.url, u.status]), [[BLOCKED, "blocked"]]);
      assert.match(r.unread[0].erro!, /HTTP 403/);

      const text = readFileSync(join(internal, "pool-sources", poolSourceFileName(MS)), "utf8");
      assert.match(text, /TEXTO DA PAGINA https:\/\/microsoft\.ai/);
      const manifest = readPoolSourcesManifest(internal);
      assert.equal(manifest.find((e) => e.url === YT)?.status, "skipped");
      assert.equal(poolSourceTextPath(internal, MS), join(internal, "pool-sources", poolSourceFileName(MS)));
      assert.equal(poolSourceTextPath(internal, BLOCKED), null);

      const calls2: string[] = [];
      const r2 = await prefetchPoolSources(approvedFixture(), internal, { fetchImpl: fakeFetch(calls2) });
      assert.deepEqual(calls2, [BLOCKED], "ok reusado do cache; só a falha volta à rede");
      assert.equal(r2.reused, 2);
      assert.equal(r2.unread.length, 0);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("respeita o teto de downloads simultâneos", async () => {
    const ed = setup();
    try {
      const radar = Array.from({ length: 9 }, (_, i) => ({ url: `https://p.example.com/${i}`, title: `p${i}`, summary: LONG }));
      let active = 0;
      let peak = 0;
      const slow = (async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((res) => setTimeout(res, 5));
        active--;
        return new Response("<p>ok</p>", { status: 200, headers: { "content-type": "text/html" } });
      }) as unknown as typeof fetch;
      const r = await prefetchPoolSources({ radar }, join(ed, "_internal"), { fetchImpl: slow, concurrency: 3 });
      assert.equal(r.ok, 9);
      assert.ok(peak <= 3 && peak > 1, `pico de ${peak} downloads`);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });
});

describe("refresh-destaque-sources no Stage 2 (#13884)", () => {
  it("--record-writer-inputs baixa também o pool; sem a flag, não", async () => {
    const ed = setup();
    try {
      const calls: string[] = [];
      const plain = await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(calls) });
      assert.equal(plain.pool_sources, undefined);
      assert.equal(existsSync(join(ed, "_internal", "pool-sources")), false);

      const s2 = await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(calls, new Set([BLOCKED])), recordWriterInputs: true });
      assert.ok(s2.pool_sources, "pool baixado no passo 0 do Stage 2");
      assert.equal(s2.pool_sources!.manifest_path, join(ed, "_internal", "pool-sources", "manifest.json"));
      assert.deepEqual(s2.pool_sources!.unread.map((u) => u.url), [BLOCKED]);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });
});

describe("gate 4: source-not-read com o download do pool (#13884)", () => {
  const md = `**DESTAQUE 1 | X**\n\n[d1](${HL[0]})\n\n**LANÇAMENTOS**\n\n[MS](${MS})\n\n**RADAR**\n\n[B](${BLOCKED})\n\n**USE MELHOR**\n\n[T](${OK})\n`;

  it("item de pool com download falho é acusado mesmo com resumo longo; página lida não é acusada", async () => {
    const ed = setup();
    try {
      writeFileSync(join(ed, "02-reviewed.md"), md, "utf8");
      // Sem manifest (edição anterior ao #13884): regra do resumo — só o tutorial de resumo curto.
      assert.match(checkSourceNotRead(ed)[0].message, /"Tutorial"/);
      assert.doesNotMatch(checkSourceNotRead(ed)[0].message, /Bloqueado/);

      await prefetchPoolSources(approvedFixture(), join(ed, "_internal"), { fetchImpl: fakeFetch([], new Set([BLOCKED, MS])) });
      const v = checkSourceNotRead(ed);
      assert.equal(v.length, 1);
      assert.equal(v[0].severity, "warning");
      assert.match(v[0].message, /fonte não lida: 2 item/);
      assert.match(v[0].message, /"Seven new world-class models at scalable price-performance" \(download da página falhou: HTTP 403/);
      assert.match(v[0].message, /"Bloqueado" \(download da página falhou/);
      assert.doesNotMatch(v[0].message, /Tutorial/, "página lida em disco vence o resumo curto");
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("destaque com download falho em fact-check-sources é acusado com o motivo", () => {
    const ed = setup();
    try {
      mkdirSync(join(ed, "_internal", "fact-check-sources"), { recursive: true });
      writeFileSync(
        join(ed, "_internal", "fact-check-sources", "manifest.json"),
        JSON.stringify([{ destaque: 1, url: HL[0], status: "blocked", erro: "HTTP 403: fonte bloqueada; tente equivalente", bytes: 0, fetched_at: "x" }]),
      );
      const items = findUnreadItemsInEdition(approvedFixture(), md, readSourceDownloads(join(ed, "_internal")));
      const d1 = items.find((i) => i.url === HL[0]);
      assert.ok(d1?.highlight);
      assert.match(d1!.reason, /download da página falhou: HTTP 403/);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });
});

describe("promoção a destaque herda o texto do pool (#13884 item 4)", () => {
  it("prefetchHighlightSources usa o texto já lido, sem rede, para o item promovido", async () => {
    const ed = setup();
    const internal = join(ed, "_internal");
    try {
      await prefetchPoolSources(approvedFixture(), internal, { fetchImpl: fakeFetch([]) });
      const promoted = { highlights: [{ url: HL[0], article: { url: HL[0] } }, { url: MS, article: { url: MS } }] };
      const calls: string[] = [];
      const out = await prefetchHighlightSources(promoted, internal, fakeFetch(calls));
      assert.deepEqual(calls, [HL[0]], "só o D1 vai à rede");
      const d2 = out.find((s) => s.destaque === 2);
      assert.equal(d2?.path, join(internal, "fact-check-sources", "d2.txt"));
      assert.match(readFileSync(d2!.path!, "utf8"), /microsoft\.ai/);
      const manifest = JSON.parse(readFileSync(join(internal, "fact-check-sources", "manifest.json"), "utf8"));
      assert.equal(manifest[1].status, "ok");
      assert.equal(manifest[1].url, MS);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });
});
