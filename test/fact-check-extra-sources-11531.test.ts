/**
 * Regressão #11531 — fato de fonte adicional do mesmo destaque virava
 * NOT_FOUND_IN_SOURCE bloqueante.
 *
 * Caso real (edição 261029): o D1 tinha a CNN como fonte do link do título e
 * citava o Plano Brasileiro de IA (R$ 23 bilhões, 2024 a 2028), fato que só o
 * Poder360 (bloco "Aprofunde:" / cluster) trazia. O fact-checker só recebia
 * `d1.txt` (CNN). Agora o pré-download também baixa as fontes adicionais para
 * `d{N}-extra-{k}.txt` + `extras.json`, o editor registra fonte extra com
 * `add-destaque-source.ts`, e o resumo do gate diz de qual fonte veio cada
 * claim sustentado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  addEditorExtraSource,
  collectAutoExtraCandidates,
  MAX_AUTO_EXTRAS_PER_DESTAQUE,
  readExtrasManifest,
  syncExtraSources,
} from "../scripts/lib/fact-check-extra-sources.ts";
import { refreshDestaqueSources } from "../scripts/refresh-destaque-sources.ts";
import { formatGateSummary, formatSourceAttribution, notConfirmedInPrimary, primaryCaveat, type FactCheckResult, type FactClaim } from "../scripts/run-fact-checker.ts";

const CNN = "https://www.cnnbrasil.com.br/tecnologia/plano-ia";
const PODER = "https://www.poder360.com.br/governo/plano-brasileiro-de-ia-23-bilhoes";
const CLUSTER = "https://g1.globo.com/tecnologia/plano-ia";

function fakeFetch(calls: string[], failing: Set<string> = new Set()): typeof fetch {
  return (async (input: string | URL) => {
    const u = String(input);
    calls.push(u);
    if (failing.has(u)) return new Response("no", { status: 403, headers: { "content-type": "text/html" } });
    const body = u === PODER ? "<p>Plano Brasileiro de IA: R$ 23 bilhões de 2024 a 2028.</p>" : `<p>TEXTO DE ${u}</p>`;
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
}

function approvedWith(urls: string[], clusters: string[][] = []) {
  return {
    highlights: urls.map((url, i) => ({
      rank: i + 1,
      url,
      article: { url, title: `t${i}`, cluster_sources: (clusters[i] ?? []).map((u) => ({ url: u })) },
    })),
    radar: [],
  };
}

function reviewedMd(aprofundeD1: string[]): string {
  const items = aprofundeD1.map((u, i) => `* [Fonte ${i}](${u}) - Veículo`).join("\n");
  return [
    "DESTAQUE 1 | BRASIL",
    "",
    `[Governo lança plano de IA](${CNN})`,
    "",
    "O plano prevê R$ 23 bilhões entre 2024 e 2028.",
    "",
    "Por que isso importa:",
    "",
    "Porque define o investimento público.",
    ...(aprofundeD1.length ? ["", "Aprofunde:", "", items] : []),
    "",
    "---",
  ].join("\n");
}

function setupEdition(approved: unknown, md?: string): string {
  const ed = mkdtempSync(join(tmpdir(), "fc-extra-11531-"));
  mkdirSync(join(ed, "_internal"), { recursive: true });
  writeFileSync(join(ed, "_internal", "01-approved.json"), JSON.stringify(approved), "utf8");
  if (md !== undefined) writeFileSync(join(ed, "02-reviewed.md"), md, "utf8");
  return ed;
}

const srcDir = (ed: string) => join(ed, "_internal", "fact-check-sources");

describe("collectAutoExtraCandidates (#11531)", () => {
  it("junta Aprofunde + cluster_sources, sem a primária e sem duplicata", () => {
    const approved = approvedWith([CNN], [[CLUSTER, PODER, CNN]]);
    const c = collectAutoExtraCandidates(approved, [CNN], reviewedMd([PODER]));
    assert.deepEqual(
      c.map((x) => [x.destaque, x.url, x.origin]),
      [
        [1, PODER, "aprofunde"],
        [1, CLUSTER, "cluster"],
      ],
    );
  });

  it("corta em MAX_AUTO_EXTRAS_PER_DESTAQUE por destaque", () => {
    const many = Array.from({ length: 10 }, (_, i) => `https://ex${i}.com/x`);
    const c = collectAutoExtraCandidates(approvedWith([CNN], [many]), [CNN]);
    assert.equal(c.length, MAX_AUTO_EXTRAS_PER_DESTAQUE);
  });

  it("sem cluster e sem MD não há candidata", () => {
    assert.deepEqual(collectAutoExtraCandidates(approvedWith([CNN]), [CNN]), []);
  });
});

describe("syncExtraSources (#11531)", () => {
  it("caso 261029: o texto do Poder360 fica disponível ao fact-checker como fonte do D1", async () => {
    const approved = approvedWith([CNN]);
    const ed = setupEdition(approved, reviewedMd([PODER]));
    try {
      const calls: string[] = [];
      const r = await refreshDestaqueSources(ed, { fetchImpl: fakeFetch(calls) });
      assert.ok(r.extra_sources, "refresh devolve as fontes adicionais");
      const extra = r.extra_sources!.find((x) => x.url === PODER)!;
      assert.equal(extra.status, "ok");
      assert.equal(extra.destaque, 1);
      assert.equal(extra.primary_url, CNN);
      assert.match(readFileSync(join(srcDir(ed), "d1-extra-1.txt"), "utf8"), /23 bilhões/);
      // a primária segue intacta e separada
      assert.doesNotMatch(readFileSync(join(srcDir(ed), "d1.txt"), "utf8"), /23 bilhões/);
      const manifest = JSON.parse(readFileSync(join(srcDir(ed), "manifest.json"), "utf8"));
      assert.equal(manifest.length, 1, "manifest principal não ganha entrada de extra");
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("reusa as extras já baixadas sem rede e re-tenta as que falharam", async () => {
    const approved = approvedWith([CNN], [[CLUSTER]]);
    const md = reviewedMd([PODER]);
    const ed = setupEdition(approved, md);
    try {
      const calls: string[] = [];
      await syncExtraSources(approved, [CNN], join(ed, "_internal"), {
        reviewedMd: md,
        fetchImpl: fakeFetch(calls, new Set([CLUSTER])),
      });
      assert.equal(readExtrasManifest(srcDir(ed)).find((e) => e.url === CLUSTER)?.status, "blocked");
      calls.length = 0;
      const second = await syncExtraSources(approved, [CNN], join(ed, "_internal"), {
        reviewedMd: md,
        fetchImpl: fakeFetch(calls),
      });
      assert.deepEqual(calls, [CLUSTER], "só a falha é re-baixada");
      assert.ok(second.every((e) => e.status === "ok"));
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("troca da URL primária do destaque descarta as extras do slot (inclusive as do editor)", async () => {
    const approved = approvedWith([CNN]);
    const md = reviewedMd([PODER]);
    const ed = setupEdition(approved, md);
    const internal = join(ed, "_internal");
    try {
      const calls: string[] = [];
      await syncExtraSources(approved, [CNN], internal, { reviewedMd: md, fetchImpl: fakeFetch(calls) });
      await addEditorExtraSource([CNN], internal, 1, "https://editor.example.org/fonte", fakeFetch(calls));
      assert.equal(readExtrasManifest(srcDir(ed)).length, 2);

      const novo = "https://outra.com/historia-nova";
      const after = await syncExtraSources(approvedWith([novo]), [novo], internal, { fetchImpl: fakeFetch(calls) });
      assert.deepEqual(after, []);
      assert.equal(existsSync(join(srcDir(ed), "d1-extra-1.txt")), false, "texto da história antiga apagado");
      assert.equal(existsSync(join(srcDir(ed), "d1-extra-2.txt")), false);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("fonte do editor sobrevive a uma re-sincronização com o mesmo destaque", async () => {
    const approved = approvedWith([CNN]);
    const ed = setupEdition(approved);
    const internal = join(ed, "_internal");
    try {
      const calls: string[] = [];
      const e = await addEditorExtraSource([CNN], internal, 1, PODER, fakeFetch(calls));
      assert.equal(e.origin, "editor");
      assert.equal(e.k, 1);
      const after = await syncExtraSources(approved, [CNN], internal, { fetchImpl: fakeFetch(calls) });
      assert.deepEqual(after.map((x) => [x.url, x.origin]), [[PODER, "editor"]]);
      assert.equal(calls.length, 1, "sem novo download");
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });
});

describe("addEditorExtraSource (#11531)", () => {
  it("recusa destaque inexistente e a própria URL primária", async () => {
    const ed = setupEdition(approvedWith([CNN]));
    const internal = join(ed, "_internal");
    try {
      await assert.rejects(addEditorExtraSource([CNN], internal, 2, PODER, fakeFetch([])), /destaque 2 não existe/);
      await assert.rejects(addEditorExtraSource([CNN], internal, 1, `${CNN}/`, fakeFetch([])), /fonte primária/);
    } finally {
      rmSync(ed, { recursive: true, force: true });
    }
  });

  it("CLI sai 1 sem args válidos", () => {
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", resolve("scripts/add-destaque-source.ts"), "--destaque", "9"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Uso:/);
  });
});

describe("formatSourceAttribution (#11531)", () => {
  const result: FactCheckResult = {
    edition: "261029",
    checked_at: "2026-10-28T12:00:00Z",
    claims: [
      { destaque: 1, claim_type: "number", text: "40 empresas", context: "", sources: ["newsletter"], verdict: "SUSTAINED", source_url: CNN },
      { destaque: 1, claim_type: "price", text: "R$ 23 bilhões", context: "", sources: ["newsletter"], verdict: "SUSTAINED", source_url: PODER },
      { destaque: 1, claim_type: "date", text: "2028", context: "", sources: ["social"], verdict: "DIVERGENT", source_url: PODER },
    ],
    summary: { total: 3, sustained: 2, divergent: 1, not_found_in_source: 0, source_unreachable: 0, inferred: 0, attention_items: 1 },
  };

  it("conta por host e nomeia o claim sustentado por fonte adicional", () => {
    const lines = formatSourceAttribution(result.claims, [CNN]).join("\n");
    assert.match(lines, /D1: cnnbrasil\.com\.br 1, poder360\.com\.br \(adicional\) 1/);
    assert.match(lines, /"R\$ 23 bilhões" ← https:\/\/www\.poder360/);
    assert.doesNotMatch(lines, /"2028"/, "DIVERGENT não entra na atribuição de sustentados");
  });

  it("sem primaryUrls o resumo do gate fica como antes", () => {
    assert.deepEqual(formatSourceAttribution(result.claims, undefined), []);
    assert.doesNotMatch(formatGateSummary(result), /Fonte dos claims sustentados/);
    assert.match(formatGateSummary(result, { primaryUrls: [CNN] }), /Fonte dos claims sustentados/);
  });
});

describe("fonte adicional sem confirmação na principal (#11691)", () => {
  const mk = (note: string | undefined, url: string) => ({
    destaque: 1, claim_type: "number" as const, text: "270 mil mensagens", context: "",
    sources: ["newsletter" as const], verdict: "SUSTAINED" as const, source_url: url, note,
  });

  it("claim só da fonte adicional com ressalva do agente sai com ⚠️ e a nota", () => {
    const out = formatSourceAttribution(
      [mk("não confirmado na fonte principal; consta na matéria do Poder360", PODER)],
      [CNN],
    ).join("\n");
    assert.match(out, /⚠️ D1 \[number\] "270 mil mensagens"/);
    assert.match(out, /→ \[li a fonte principal e não achei o claim\] não confirmado na fonte principal/);
    assert.match(out, /1 claim\(s\) sem confirmação na fonte principal/);
  });

  it("fonte adicional sem ressalva não gera alarme falso", () => {
    const out = formatSourceAttribution([mk("confirmado na matéria", PODER)], [CNN]).join("\n");
    assert.match(out, /ADICIONAL/);
    assert.doesNotMatch(out, /⚠️/);
  });

  it("nota que apenas cita a fonte principal sem ressalva não gera ⚠️", () => {
    const out = formatSourceAttribution([mk("não encontrei divergência com a fonte principal", PODER)], [CNN]).join("\n");
    assert.doesNotMatch(out, /⚠️/);
  });

  it("fonte do título nunca é marcada, mesmo com a frase na nota", () => {
    const out = formatSourceAttribution(
      [mk("não confirmado na fonte principal", CNN)],
      [CNN],
    ).join("\n");
    assert.doesNotMatch(out, /⚠️/);
  });

  it("não vira divergente nem atenção no resumo", () => {
    const r: FactCheckResult = {
      edition: "261030", checked_at: "2026-10-30T12:00:00Z",
      claims: [mk("não confirmado na fonte principal", PODER)],
      summary: { total: 1, sustained: 1, divergent: 0, not_found_in_source: 0, source_unreachable: 0, inferred: 0, attention_items: 0 },
    };
    const out = formatGateSummary(r, { primaryUrls: [CNN] });
    assert.match(out, /✅ 0 divergentes/);
    assert.match(out, /⚠️  1 claim\(s\) sem confirmação/);
  });
});

describe("gate sem falso verde e sinal estruturado (#11691 review)", () => {
  const mk = (over: Record<string, unknown>) => ({
    destaque: 1, claim_type: "number" as const, text: "270 mil mensagens", context: "",
    sources: ["newsletter" as const], verdict: "SUSTAINED" as const, source_url: PODER, ...over,
  });
  const res = (claims: FactClaim[]): FactCheckResult => ({
    edition: "261030", checked_at: "2026-10-30T12:00:00Z", claims,
    summary: { total: claims.length, sustained: claims.length, divergent: 0, not_found_in_source: 0, source_unreachable: 0, inferred: 0, attention_items: 0 },
  });

  it("com ressalva, NÃO imprime o ✅ 'Todos os claims verificados'", () => {
    const out = formatGateSummary(res([mk({ primary_status: "not_found" })]), { primaryUrls: [CNN] });
    assert.doesNotMatch(out, /✅ Todos os claims verificados/);
    assert.match(out, /não é verde pleno/);
  });

  it("sem ressalva mantém o ✅", () => {
    const out = formatGateSummary(res([mk({ note: "confirmado" })]), { primaryUrls: [CNN] });
    assert.match(out, /✅ Todos os claims verificados/);
  });

  it("campo estruturado funciona sem texto na nota", () => {
    assert.equal(notConfirmedInPrimary({ primary_status: "not_found" }), true);
    assert.equal(notConfirmedInPrimary({ note: undefined }), false);
  });

  for (const note of [
    "não consta na fonte principal",
    "não aparece na fonte principal",
    "não localizado na fonte principal",
    "a fonte principal não confirma o número",
    "não confirmado no texto da fonte principal",
    "não confirmado na fonte nova",
    "Não foi encontrado no link do título",
  ]) {
    it(`variante de texto livre: ${note}`, () => {
      assert.equal(notConfirmedInPrimary({ note }), true);
    });
  }

  it("nota com 'divergência' + fonte principal não gera alarme", () => {
    assert.equal(notConfirmedInPrimary({ note: "não encontrei divergência com a fonte principal" }), false);
  });

  it("principal indisponível é distinguida de 'li e não achei'", () => {
    assert.equal(primaryCaveat({ primary_status: "unavailable" }), "unavailable");
    assert.equal(primaryCaveat({ note: "fonte principal indisponível (451); consta na matéria X" }), "unavailable");
    const out = formatSourceAttribution([mk({ primary_status: "unavailable", note: "x" }) as FactClaim], [CNN]).join("\n");
    assert.match(out, /fonte principal indisponível\] x/);
    assert.match(out, /1 com a principal indisponível/);
  });

  it("nota longa não é truncada", () => {
    const long = "não confirmado na fonte principal; " + "a".repeat(400) + " FIM";
    const out = formatSourceAttribution([mk({ note: long }) as FactClaim], [CNN]).join("\n");
    assert.match(out, /a FIM/);
  });
});
