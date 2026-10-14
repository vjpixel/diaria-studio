/**
 * test/clarice-novos-preflight-10157.test.ts (#10157)
 *
 * Pré-conferência do HTML dos envios Clarice `novos`. Todos os casos usam
 * fixtures em diretório temporário (`os.tmpdir()`) via `--html`, e
 * `resolveCycle`/`fetchFn` injetados — nunca lê `data/monthly/` real, nunca
 * chama rede.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPreflight, collectRepeatedArg } from "../scripts/clarice-novos-preflight.ts";
import {
  analyzePreviewHtml,
  diffSummaries,
  evaluatePreflight,
  isKvImageUrl,
  pickLastSentNovosCampaign,
  summarizePreviewHtml,
} from "../scripts/lib/clarice-novos-preflight.ts";

function html(opts: {
  title?: string;
  body?: string;
  imgs?: string[];
  boxes?: string[];
  headlines?: string[];
  links?: string[];
} = {}): string {
  const imgs = (opts.imgs ?? ["https://eia.diar.ia.br/img/img-2609-10-04-d1-2x1.jpg"])
    .map((src, i) => `<img src="${src}" alt="Legenda ${i + 1}" />`)
    .join("\n");
  const links = (opts.links ?? ["https://diar.ia.br/?utm_source=clarice&amp;utm_medium=email"])
    .map((h) => `<a href="${h}">link</a>`)
    .join("\n");
  const h2 = (opts.headlines ?? ["Agentes saem do teste"]).map((h) => `<h2 style="x">${h}</h2>`).join("\n");
  const h3 = (opts.boxes ?? ["Escreva melhor com a Clarice"]).map((h) => `<h3>${h}</h3>`).join("\n");
  return `<!doctype html><html><head><title>${opts.title ?? "Notícias do mês"}</title></head><body>
${h2}
${imgs}
${h3}
<p>${opts.body ?? ""}</p>
${links}
</body></html>`;
}

const NEW_BODY = 'Responda dizendo &quot;quero&quot; e clique em <a href="https://clarice.ai/?via=diaria">Garantir meu ingresso</a>';
const OLD_BODY = "Responda este e-mail para saber mais.";

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "clarice-preflight-10157-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function run(argv: string[], overrides: Parameters<typeof runPreflight>[1] = {}) {
  const out: string[] = [];
  const errs: string[] = [];
  const code = await runPreflight(argv, {
    log: (l) => out.push(l),
    err: (l) => errs.push(l),
    fetchFn: (async () => {
      throw new Error("rede não deveria ser chamada neste teste");
    }) as unknown as typeof fetch,
    ...overrides,
  });
  return { code, out, errs };
}

const EXPECT = ["--expect", 'dizendo "quero"', "--expect", "Garantir meu ingresso"];

// ── Critério de pronto da issue: arquivo velho → exit 1; novo → exit 0 ─────

test("arquivo VELHO (sem o marcador esperado) devolve exit 1", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "cloudflare-preview.html");
    writeFileSync(p, html({ body: OLD_BODY }));
    const { code, out, errs } = await run(["--cycle", "2609-10", "--html", p, ...EXPECT]);
    assert.equal(code, 1);
    assert.match(out.at(-1)!, /^clarice-novos preflight 2609-10: FALHA/);
    assert.match(out.at(-1)!, /expect 0\/2/);
    assert.ok(errs.some((e) => /marcador\(es\) esperado\(s\) ausente\(s\)/.test(e)));
  });
});

test("arquivo NOVO (com os marcadores) devolve exit 0 e linha pronta pro relatório", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "cloudflare-preview.html");
    writeFileSync(p, html({ body: NEW_BODY }));
    const { code, out } = await run(["--cycle", "2609-10", "--html", p, ...EXPECT]);
    assert.equal(code, 0);
    const line = out.at(-1)!;
    assert.match(line, /^clarice-novos preflight 2609-10: OK — sha256 [0-9a-f]{12}… \d+B mtime \d{4}-/);
    assert.match(line, /1 img \(KV ok\)/);
    assert.match(line, /0 seta/);
    assert.match(line, /1 link utm_source=clarice/);
    assert.match(line, /expect 2\/2/);
  });
});

test("arquivo ausente devolve exit 1", async () => {
  await withTmp(async (dir) => {
    const { code, out } = await run(["--cycle", "2609-10", "--html", join(dir, "nao-existe.html")]);
    assert.equal(code, 1);
    assert.match(out.at(-1)!, /FALHA — HTML ausente/);
  });
});

test("sem nenhuma <img> devolve exit 1", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "x.html");
    writeFileSync(p, html({ imgs: [] }));
    const { code, errs } = await run(["--cycle", "2609-10", "--html", p]);
    assert.equal(code, 1);
    assert.ok(errs.some((e) => /nenhuma <img>/.test(e)));
  });
});

test("imagem fora do KV, seta e falta de utm_source=clarice falham", async () => {
  const r = evaluatePreflight({
    cycle: "2609-10",
    htmlPath: "x",
    html: html({
      imgs: ["https://eia.diar.ia.br/img/a.jpg", "file:///C:/data/editions/x.jpg"],
      body: "Leia mais →",
      links: ["https://diar.ia.br/"],
    }),
    mtime: new Date(),
    expectMarkers: [],
  });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some((f) => /1 imagem\(ns\) fora do KV: file:/.test(f)));
  assert.ok(r.failures.some((f) => /seta/.test(f)));
  assert.ok(r.failures.some((f) => /nenhum link com utm_source=clarice/.test(f)));
  assert.ok(r.warnings.some((w) => /sem utm_source=clarice/.test(w)));
});

test("seta como entidade HTML (&rarr; / &#8594;) também conta", () => {
  assert.equal(analyzePreviewHtml("<p>a &#8594; b &#x2190; c</p>").arrows, 2);
});

test("--expect-sha divergente (sync atrasado) devolve exit 1; igual devolve 0", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "x.html");
    const content = html({ body: NEW_BODY });
    writeFileSync(p, content);
    const sha = analyzePreviewHtml(content).sha256;
    assert.equal((await run(["--cycle", "2609-10", "--html", p, "--expect-sha", sha])).code, 0);
    const bad = await run(["--cycle", "2609-10", "--html", p, "--expect-sha", "0".repeat(64)]);
    assert.equal(bad.code, 1);
    assert.ok(bad.errs.some((e) => /sha256 diverge/.test(e)));
  });
});

test("--newer-than: mtime anterior devolve exit 1", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "x.html");
    writeFileSync(p, html());
    const old = new Date("2026-10-13T12:00:00Z");
    utimesSync(p, old, old);
    const r = await run(["--cycle", "2609-10", "--html", p, "--newer-than", "2026-10-14T06:00:00Z"]);
    assert.equal(r.code, 1);
    assert.ok(r.errs.some((e) => /desatualizado/.test(e)));
    assert.equal((await run(["--cycle", "2609-10", "--html", p, "--newer-than", "2026-10-13T00:00:00Z"])).code, 0);
    assert.equal((await run(["--cycle", "2609-10", "--html", p, "--newer-than", "ontem"])).code, 1);
  });
});

test("--baseline lista título, caixas e legendas que mudaram (não decide o exit)", async () => {
  await withTmp(async (dir) => {
    const cur = join(dir, "cur.html");
    const base = join(dir, "base.html");
    writeFileSync(base, html({ title: "Antigo", boxes: ["Caixa velha"] }));
    writeFileSync(cur, html({ title: "Novo", boxes: ["Caixa nova"] }));
    const r = await run(["--cycle", "2609-10", "--html", cur, "--baseline", base]);
    assert.equal(r.code, 0);
    assert.ok(r.errs.some((e) => /título: "Antigo" → "Novo"/.test(e)));
    assert.ok(r.errs.some((e) => /- caixas: Caixa velha/.test(e)));
    assert.ok(r.errs.some((e) => /\+ caixas: Caixa nova/.test(e)));
    assert.match(r.out.at(-1)!, /mudou vs referência/);
  });
});

test("sem --cycle: resolve o ciclo como o envio resolve e lê o HTML desse ciclo", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "x.html");
    writeFileSync(p, html());
    let called = false;
    const r = await run(["--html", p], {
      resolveCycle: () => {
        called = true;
        return { cycle: "2609-10", subject: "Assunto", fallback: false, checked: [] };
      },
      activityDeps: { listCyclesWithClariceDir: () => [], cycleHasActivity: () => false },
    });
    assert.ok(called);
    assert.equal(r.code, 0);
    assert.match(r.out.at(-1)!, /preflight 2609-10: OK/);
  });
});

test("sem --cycle e nenhum ciclo pronto: exit 1", async () => {
  const r = await run([], { resolveCycle: () => ({ cycle: null, subject: null, fallback: false, checked: [] }) });
  assert.equal(r.code, 1);
  assert.match(r.out.at(-1)!, /nenhum ciclo mensal pronto/);
});

test("--compare-last-sent lê o dashboard (só GET) e avisa assunto/ciclo divergentes sem mudar o exit", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "x.html");
    writeFileSync(p, html());
    const calls: { url: string; method?: string }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return new Response(
        JSON.stringify({
          campaigns: [
            { id: 1, name: "Clarice 2608 grupo:novos-0910", subject: "Anterior", status: "sent", sentDate: "2026-10-09T12:00:00Z" },
            { id: 2, name: "Clarice 2608 grupo:novos-1010", subject: "Velho", status: "sent", sentDate: "2026-10-10T12:00:00Z" },
            { id: 3, name: "Clarice 2609 grupo:t1-w1", subject: "Outro grupo", status: "sent", sentDate: "2026-10-12T12:00:00Z" },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await run(["--html", p, "--compare-last-sent"], {
      fetchFn,
      resolveCycle: () => ({ cycle: "2609-10", subject: "Novo assunto", fallback: false, checked: [] }),
      activityDeps: { listCyclesWithClariceDir: () => [], cycleHasActivity: () => false },
    });
    assert.equal(r.code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, undefined); // GET padrão
    assert.match(calls[0].url, /\/api\/campaigns\?limit=50$/);
    assert.ok(r.errs.some((e) => /Clarice 2608 grupo:novos-1010/.test(e)));
    assert.ok(r.errs.some((e) => /conteúdo 2608; o próximo envio usa 2609/.test(e)));
    assert.ok(r.errs.some((e) => /assunto mudou/.test(e)));
  });
});

test("--compare-last-sent com dashboard fora do ar é fail-soft", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "x.html");
    writeFileSync(p, html());
    const r = await run(["--cycle", "2609-10", "--html", p, "--compare-last-sent"]);
    assert.equal(r.code, 0);
    assert.ok(r.errs.some((e) => /dashboard indisponível/.test(e)));
  });
});

test("sem --compare-last-sent nunca chama a rede", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "x.html");
    writeFileSync(p, html());
    // fetchFn default do helper `run` lança — se fosse chamado, haveria aviso de dashboard.
    const r = await run(["--cycle", "2609-10", "--html", p]);
    assert.equal(r.code, 0);
    assert.ok(!r.errs.some((e) => /dashboard/.test(e)));
  });
});

test("--json imprime o resultado completo antes da linha do relatório", async () => {
  await withTmp(async (dir) => {
    const p = join(dir, "x.html");
    writeFileSync(p, html());
    const r = await run(["--cycle", "2609-10", "--html", p, "--json"]);
    const parsed = JSON.parse(r.out[0]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.cycle, "2609-10");
    assert.match(parsed.analysis.sha256, /^[0-9a-f]{64}$/);
  });
});

// ── Unidades puras ─────────────────────────────────────────────────────────

test("collectRepeatedArg aceita repetição e rejeita valor ausente/vazio", () => {
  assert.deepEqual(collectRepeatedArg(["--expect", "a", "--expect=b", "--x", "y"], "expect"), ["a", "b"]);
  assert.throws(() => collectRepeatedArg(["--expect"], "expect"), /sem valor/);
  assert.throws(() => collectRepeatedArg(["--expect", "--json"], "expect"), /sem valor/);
  assert.throws(() => collectRepeatedArg(["--expect="], "expect"), /vazio/);
});

test("--expect sem valor faz a CLI sair 1 (não ignora em silêncio)", async () => {
  const r = await run(["--cycle", "2609-10", "--html", "x", "--expect"]);
  assert.equal(r.code, 1);
});

test("isKvImageUrl: hosts do KV aceitos, resto recusado", () => {
  assert.ok(isKvImageUrl("https://eia.diar.ia.br/img/img-2609-10-04-d1-2x1.jpg"));
  assert.ok(isKvImageUrl("https://diar.ia.br/img/x.jpg"));
  assert.ok(isKvImageUrl("https://poll.diaria.workers.dev/img/x.jpg"));
  assert.ok(!isKvImageUrl("https://drive.google.com/uc?id=1"));
  assert.ok(!isKvImageUrl("04-d1-2x1.jpg"));
  assert.ok(!isKvImageUrl("data:image/png;base64,AAA"));
});

test("marcador casa contra aspas tipográficas e entidades", () => {
  const a = analyzePreviewHtml("<p>Responda dizendo \u201Cquero\u201D</p><p>A &amp; B</p>", ['dizendo "quero"', "A & B"]);
  assert.deepEqual(a.expect.map((e) => e.found), [true, true]);
});

test("summarize + diff: legenda (alt) que mudou aparece", () => {
  const a = summarizePreviewHtml('<img src="x" alt="Velha">');
  const b = summarizePreviewHtml('<img src="x" alt="Nova">');
  const d = diffSummaries(a, b);
  assert.equal(d.changed, true);
  assert.deepEqual(d.captions, { added: ["Nova"], removed: ["Velha"] });
  assert.equal(diffSummaries(a, a).changed, false);
});

test("pickLastSentNovosCampaign ignora agendada/sem sentDate e outros grupos", () => {
  assert.equal(
    pickLastSentNovosCampaign([
      { id: 1, name: "Clarice 2609 grupo:novos-1410", status: "queued", sentDate: null },
      { id: 2, name: "Clarice 2609 grupo:t1-w1", status: "sent", sentDate: "2026-10-13T00:00:00Z" },
    ]),
    null,
  );
});
