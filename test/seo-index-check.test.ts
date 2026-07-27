/**
 * test/seo-index-check.test.ts (#4105)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseInspection, summarize, filterPosts, mapLimit, renderMd, DEFAULT_SITE, type IndexStatus } from "../scripts/seo-index-check.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Resposta real da API (recortada) pra uma URL indexada. */
const INDEXED = {
  inspectionResult: {
    indexStatusResult: {
      verdict: "PASS",
      coverageState: "Enviada e indexada",
      robotsTxtState: "ALLOWED",
      indexingState: "INDEXING_ALLOWED",
      lastCrawlTime: "2026-07-26T03:40:18Z",
      googleCanonical: "https://diar.ia.br/",
      referringUrls: ["https://diar.ia.br/archive"],
    },
  },
};

/** Caso real de 260727: post detectado via sitemap, nunca rastreado, sem referrer. */
const DISCOVERED = {
  inspectionResult: {
    indexStatusResult: {
      verdict: "NEUTRAL",
      coverageState: "Detectada, mas não indexada no momento",
      referringUrls: [],
    },
  },
};

describe("parseInspection (#4105)", () => {
  it("achata a resposta da URL Inspection API", () => {
    const s = parseInspection("https://diar.ia.br/", INDEXED);
    assert.equal(s.verdict, "PASS");
    assert.equal(s.coverageState, "Enviada e indexada");
    assert.equal(s.lastCrawlTime, "2026-07-26T03:40:18Z");
    assert.deepEqual(s.referringUrls, ["https://diar.ia.br/archive"]);
    assert.equal(s.error, undefined);
  });

  it("resposta sem indexStatusResult vira error, não status falso-negativo", () => {
    const s = parseInspection("https://diar.ia.br/x", {});
    assert.equal(s.error, "resposta sem indexStatusResult");
    assert.equal(s.verdict, undefined);
  });

  it("referringUrls ausente → array vazio (órfã), nunca undefined", () => {
    const s = parseInspection("https://diar.ia.br/x", {
      inspectionResult: { indexStatusResult: { verdict: "NEUTRAL" } },
    });
    assert.deepEqual(s.referringUrls, []);
  });
});

describe("summarize (#4105)", () => {
  it("conta indexadas por verdict PASS, não pelo texto localizado de coverageState", () => {
    // Regressão do #573: coverageState é pt-BR na conta do editor e muda de
    // idioma/redação; comparar por string daria contagem errada.
    const rows: IndexStatus[] = [
      { url: "a", verdict: "PASS", coverageState: "Submitted and indexed", referringUrls: ["x"] },
      { url: "b", verdict: "PASS", coverageState: "Enviada e indexada", referringUrls: ["x"] },
      { url: "c", verdict: "NEUTRAL", coverageState: "Detectada, mas não indexada no momento", referringUrls: [] },
    ];
    const s = summarize(rows);
    assert.equal(s.indexed, 2);
    assert.equal(s.not_indexed, 1);
    assert.equal(s.coverage_pct, 66.7);
  });

  it("erros não contam como não-indexadas (não poluem o denominador)", () => {
    const rows: IndexStatus[] = [
      { url: "a", verdict: "PASS", referringUrls: ["x"] },
      { url: "b", error: "429 — quota estourada" },
    ];
    const s = summarize(rows);
    assert.equal(s.errors, 1);
    assert.equal(s.total, 2);
    assert.equal(s.indexed, 1);
    assert.equal(s.not_indexed, 0);
    assert.equal(s.coverage_pct, 100); // 1/1 avaliada, não 1/2
  });

  it("conta órfãs (sem página de referência) — o achado estrutural de 260727", () => {
    const rows = [
      parseInspection("https://diar.ia.br/p/x", DISCOVERED),
      parseInspection("https://diar.ia.br/", INDEXED),
    ];
    const s = summarize(rows);
    assert.equal(s.orphan_count, 1);
    assert.equal(s.by_coverage_state["Detectada, mas não indexada no momento"], 1);
  });

  it("lista vazia não divide por zero", () => {
    const s = summarize([]);
    assert.equal(s.coverage_pct, 0);
    assert.equal(s.total, 0);
  });

  it("todas com erro → coverage 0 sem NaN", () => {
    const s = summarize([{ url: "a", error: "boom" }]);
    assert.equal(s.coverage_pct, 0);
    assert.equal(s.errors, 1);
  });
});

describe("filterPosts (#4105)", () => {
  it("mantém só URLs de edição", () => {
    const kept = filterPosts([
      "https://diar.ia.br/",
      "https://diar.ia.br/archive",
      "https://diar.ia.br/p/brasil-investe-em-ia",
      "https://diar.ia.br/forms/abc",
    ]);
    assert.deepEqual(kept, ["https://diar.ia.br/p/brasil-investe-em-ia"]);
  });
});

describe("mapLimit (#4105)", () => {
  it("preserva a ordem da entrada mesmo com durações diferentes", async () => {
    const out = await mapLimit([30, 1, 15], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    assert.deepEqual(out, ["0:30", "1:1", "2:15"]);
  });

  it("respeita o teto de concorrência (nunca mais que N em voo)", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return null;
    });
    assert.ok(peak <= 3, `pico ${peak} > 3`);
  });

  it("lista vazia não trava", async () => {
    assert.deepEqual(await mapLimit([], 4, async () => 1), []);
  });
});

describe("renderMd (#4105)", () => {
  it("marca órfãs e mostra a taxa de cobertura", () => {
    const rows = [parseInspection("https://diar.ia.br/p/x", DISCOVERED)];
    const md = renderMd(rows, summarize(rows), DEFAULT_SITE, "2026-07-27");
    assert.match(md, /0\/1 indexadas \(0%\)/);
    assert.match(md, /órfã \(sem link interno\)/);
    assert.match(md, /sc-domain:diar\.ia\.br/);
  });
});

describe("DEFAULT_SITE (#4105)", () => {
  it("é a domain property verificada — o host beehiiv dá 403 (siteUnverifiedUser)", () => {
    assert.equal(DEFAULT_SITE, "sc-domain:diar.ia.br");
  });
});

describe("agendamento semanal .ps1 (#4105)", () => {
  const PS1 = ["scripts/run-seo-weekly.ps1", "scripts/setup-seo-schedule.ps1"];
  const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

  for (const rel of PS1) {
    it(`${rel} tem BOM UTF-8 (PS 5.1 quebra o parse sem ele — #2814)`, () => {
      const head = readFileSync(resolve(ROOT, rel)).subarray(0, 3);
      assert.ok(head.equals(UTF8_BOM), `Esperava EF BB BF no início de ${rel}, achei ${head.toString("hex")}`);
    });
  }

  it("o wrapper chama os DOIS scripts do loop (cobertura + Search Analytics)", () => {
    // Sem o seo-index-check a task viraria só o pull, que hoje retorna 0 linhas
    // — a rodada semanal pareceria saudável sem medir nada.
    const src = readFileSync(resolve(ROOT, "scripts/run-seo-weekly.ps1"), "utf8");
    assert.match(src, /seo-index-check\.ts/);
    assert.match(src, /seo-pull\.ts/);
    assert.match(src, /--only-posts/);
  });

  it("setup registra com Register-ScheduledTask -Force, não Set-ScheduledTask (#3757)", () => {
    const src = readFileSync(resolve(ROOT, "scripts/setup-seo-schedule.ps1"), "utf8");
    assert.match(src, /Register-ScheduledTask/);
    assert.match(src, /-Force/);
    assert.ok(!/Set-ScheduledTask\s+`?\s*-/.test(src), "Set-ScheduledTask não aceita -Description");
  });
});
