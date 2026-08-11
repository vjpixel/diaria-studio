/**
 * test/hub-index-coverage.test.ts (#4903)
 *
 * Cobre `scripts/lib/hub-index-coverage.ts` (função pura de cruzamento) e
 * `scripts/hub-index-coverage.ts` (resolução do relatório mais recente).
 *
 * O último teste (dados reais commitados) usa um guard `existsSync` — o
 * worktree deste agente não tem o junction `data/` (não é rastreado pelo
 * git), então `data/seo/index-status-*.json` não existe aqui. O teste roda
 * de verdade só numa sessão/máquina com o junction presente (ver
 * CLAUDE.md §2b). Todos os outros testes deste arquivo são 100% fixture e
 * não dependem de `data/`.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  crossReferenceHubIndexCoverage,
  renderHubIndexCoverageSummary,
  type HubSourceEntry,
  type HubIndexStatusRow,
} from "../scripts/lib/hub-index-coverage.ts";
import { resolveLatestMainIndexStatusFilename } from "../scripts/hub-index-coverage.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function hubEntry(url: string, date: string): HubSourceEntry {
  return { date, editionSlug: url.split("/").pop() ?? url, url, matchedHeadlines: ["x"] };
}

describe("crossReferenceHubIndexCoverage", () => {
  test("hub de 3 URLs contra rows de 4 — casa por URL, ignora rows extras", () => {
    const hub: HubSourceEntry[] = [
      hubEntry("https://diar.ia.br/p/a", "2026-08-01"),
      hubEntry("https://diar.ia.br/p/b", "2026-08-02"),
      hubEntry("https://diar.ia.br/p/c", "2026-08-03"),
    ];
    const rows: HubIndexStatusRow[] = [
      { url: "https://diar.ia.br/p/a", verdict: "PASS", coverageState: "Enviada e indexada", lastCrawlTime: "2026-08-05T00:00:00Z", referringUrls: ["https://diar.ia.br/archive"] },
      { url: "https://diar.ia.br/p/b", coverageState: "Detectada, mas não indexada no momento" },
      { url: "https://diar.ia.br/p/c", coverageState: "O Google não reconhece o URL", referringUrls: [] },
      { url: "https://diar.ia.br/p/nao-do-hub", verdict: "PASS", coverageState: "Enviada e indexada" },
    ];
    const result = crossReferenceHubIndexCoverage(hub, rows, "2026-08-10");
    assert.equal(result.hubTotal, 3);
    assert.equal(result.matchedCount, 3);
    assert.deepEqual(result.missingUrls, []);
    assert.deepEqual(result.tooRecentUrls, []);
    assert.equal(result.indexedCount, 1);
    assert.equal(result.notIndexedCount, 2);
  });

  test("URL do hub ausente do relatório, com date <= reportDate → missingUrls (problema real)", () => {
    const hub: HubSourceEntry[] = [hubEntry("https://diar.ia.br/p/velha", "2026-07-01")];
    const result = crossReferenceHubIndexCoverage(hub, [], "2026-08-10");
    assert.deepEqual(result.missingUrls, ["https://diar.ia.br/p/velha"]);
    assert.deepEqual(result.tooRecentUrls, []);
    assert.equal(result.matchedCount, 0);
  });

  test("URL do hub ausente do relatório, com date > reportDate → tooRecentUrls (informativo, não falha)", () => {
    const hub: HubSourceEntry[] = [hubEntry("https://diar.ia.br/p/nova", "2026-08-11")];
    const result = crossReferenceHubIndexCoverage(hub, [], "2026-08-10");
    assert.deepEqual(result.tooRecentUrls, ["https://diar.ia.br/p/nova"]);
    assert.deepEqual(result.missingUrls, []);
  });

  test("date === reportDate conta como missing (regra é date > reportDate pra tooRecent, não >=)", () => {
    const hub: HubSourceEntry[] = [hubEntry("https://diar.ia.br/p/hoje", "2026-08-10")];
    const result = crossReferenceHubIndexCoverage(hub, [], "2026-08-10");
    assert.deepEqual(result.missingUrls, ["https://diar.ia.br/p/hoje"]);
  });

  test("lastCrawlTime ausente → conta em noLastCrawlTimeCount, só sobre matched", () => {
    const hub: HubSourceEntry[] = [hubEntry("https://diar.ia.br/p/a", "2026-08-01"), hubEntry("https://diar.ia.br/p/b", "2026-08-01")];
    const rows: HubIndexStatusRow[] = [
      { url: "https://diar.ia.br/p/a" }, // sem lastCrawlTime
      { url: "https://diar.ia.br/p/b", lastCrawlTime: "2026-08-05T00:00:00Z" },
    ];
    const result = crossReferenceHubIndexCoverage(hub, rows, "2026-08-10");
    assert.equal(result.noLastCrawlTimeCount, 1);
  });

  test("referringUrls vazio/ausente → conta em noReferringUrlsCount, só sobre matched", () => {
    const hub: HubSourceEntry[] = [
      hubEntry("https://diar.ia.br/p/a", "2026-08-01"),
      hubEntry("https://diar.ia.br/p/b", "2026-08-01"),
      hubEntry("https://diar.ia.br/p/c", "2026-08-01"),
    ];
    const rows: HubIndexStatusRow[] = [
      { url: "https://diar.ia.br/p/a", referringUrls: [] },
      { url: "https://diar.ia.br/p/b" }, // ausente
      { url: "https://diar.ia.br/p/c", referringUrls: ["https://diar.ia.br/archive"] },
    ];
    const result = crossReferenceHubIndexCoverage(hub, rows, "2026-08-10");
    assert.equal(result.noReferringUrlsCount, 2);
  });

  test("coverageState ausente na row → agrupa em '(sem coverageState)'", () => {
    const hub: HubSourceEntry[] = [hubEntry("https://diar.ia.br/p/a", "2026-08-01")];
    const rows: HubIndexStatusRow[] = [{ url: "https://diar.ia.br/p/a" }];
    const result = crossReferenceHubIndexCoverage(hub, rows, "2026-08-10");
    assert.deepEqual(result.byCoverageState, { "(sem coverageState)": 1 });
  });

  test("a soma matched + missing + tooRecent fecha com hubTotal", () => {
    const hub: HubSourceEntry[] = [
      hubEntry("https://diar.ia.br/p/matched", "2026-08-01"),
      hubEntry("https://diar.ia.br/p/missing", "2026-08-01"),
      hubEntry("https://diar.ia.br/p/recente", "2026-08-11"),
    ];
    const rows: HubIndexStatusRow[] = [{ url: "https://diar.ia.br/p/matched", verdict: "PASS", coverageState: "Enviada e indexada" }];
    const result = crossReferenceHubIndexCoverage(hub, rows, "2026-08-10");
    assert.equal(result.matchedCount + result.missingUrls.length + result.tooRecentUrls.length, result.hubTotal);
    assert.equal(result.hubTotal, 3);
  });

  test("hub vazio → resultado zerado, sem lançar", () => {
    const result = crossReferenceHubIndexCoverage([], [], "2026-08-10");
    assert.equal(result.hubTotal, 0);
    assert.equal(result.matchedCount, 0);
    assert.deepEqual(result.missingUrls, []);
    assert.deepEqual(result.byCoverageState, {});
  });

  test("é pure — mesma entrada produz sempre o mesmo resultado", () => {
    const hub: HubSourceEntry[] = [hubEntry("https://diar.ia.br/p/a", "2026-08-01")];
    const rows: HubIndexStatusRow[] = [{ url: "https://diar.ia.br/p/a", verdict: "PASS" }];
    const r1 = crossReferenceHubIndexCoverage(hub, rows, "2026-08-10");
    const r2 = crossReferenceHubIndexCoverage(hub, rows, "2026-08-10");
    assert.deepEqual(r1, r2);
  });
});

describe("renderHubIndexCoverageSummary", () => {
  test("não lança e inclui o slug + números principais", () => {
    const hub: HubSourceEntry[] = [hubEntry("https://diar.ia.br/p/a", "2026-08-01")];
    const rows: HubIndexStatusRow[] = [{ url: "https://diar.ia.br/p/a", verdict: "PASS", coverageState: "Enviada e indexada" }];
    const result = crossReferenceHubIndexCoverage(hub, rows, "2026-08-10");
    const text = renderHubIndexCoverageSummary("anthropic-claude", result);
    assert.match(text, /anthropic-claude/);
    assert.match(text, /1\/1 indexadas/);
  });

  test("inclui as URLs missing/tooRecent quando presentes", () => {
    const hub: HubSourceEntry[] = [hubEntry("https://diar.ia.br/p/velha", "2026-07-01"), hubEntry("https://diar.ia.br/p/nova", "2026-08-11")];
    const result = crossReferenceHubIndexCoverage(hub, [], "2026-08-10");
    const text = renderHubIndexCoverageSummary("anthropic-claude", result);
    assert.match(text, /AUSENTE/);
    assert.match(text, /mais recente/);
    assert.match(text, /diar\.ia\.br\/p\/velha/);
    assert.match(text, /diar\.ia\.br\/p\/nova/);
  });
});

describe("resolveLatestMainIndexStatusFilename", () => {
  test("escolhe a data mais recente entre vários arquivos principais", () => {
    assert.equal(
      resolveLatestMainIndexStatusFilename(["index-status-2026-08-03.json", "index-status-2026-08-10.json", "index-status-2026-07-27.json"]),
      "index-status-2026-08-10.json",
    );
  });

  test("ignora variantes com sufixo (ex: arquivo, #4909)", () => {
    assert.equal(
      resolveLatestMainIndexStatusFilename(["index-status-arquivo-2026-08-11.json", "index-status-2026-08-10.json"]),
      "index-status-2026-08-10.json",
    );
  });

  test("ignora arquivos .md e outros formatos", () => {
    assert.equal(
      resolveLatestMainIndexStatusFilename(["index-status-2026-08-10.md", "index-status-2026-08-10.json", ".seo-weekly.log"]),
      "index-status-2026-08-10.json",
    );
  });

  test("lista vazia ou sem nenhum arquivo principal → null", () => {
    assert.equal(resolveLatestMainIndexStatusFilename([]), null);
    assert.equal(resolveLatestMainIndexStatusFilename(["index-status-arquivo-2026-08-10.json", "random.json"]), null);
  });
});

describe("dados reais commitados (#4903 — trava de regressão)", () => {
  test("as URLs de anthropic-claude-sources.generated.json continuam presentes no index-status mais recente", () => {
    const seoDir = resolve(ROOT, "data", "seo");
    if (!existsSync(seoDir)) {
      console.log(
        "[hub-index-coverage.test] SKIP: data/seo/ ausente neste worktree (sem junction data/ — ver CLAUDE.md §2b). " +
          "Este teste só roda de verdade numa sessão/máquina com o junction presente.",
      );
      return;
    }
    const filename = resolveLatestMainIndexStatusFilename(readdirSync(seoDir));
    if (!filename) {
      console.log("[hub-index-coverage.test] SKIP: nenhum index-status-YYYY-MM-DD.json em data/seo/.");
      return;
    }
    const indexStatus = JSON.parse(readFileSync(resolve(seoDir, filename), "utf8")) as {
      date: string;
      rows: HubIndexStatusRow[];
    };
    const hubEntries = JSON.parse(
      readFileSync(resolve(ROOT, "scripts", "lib", "hubs", "anthropic-claude-sources.generated.json"), "utf8"),
    ) as HubSourceEntry[];
    const result = crossReferenceHubIndexCoverage(hubEntries, indexStatus.rows, indexStatus.date);
    // Trava real: nenhuma URL do hub deveria estar "missing" (ausente e já
    // velha o bastante pra o relatório conhecer) — só "tooRecent" é
    // aceitável (edição mais nova que a última rodada semanal, #4903).
    assert.deepEqual(
      result.missingUrls,
      [],
      `${result.missingUrls.length} URL(s) do hub anthropic-claude sumiram do index-status mais recente (${filename}): ${result.missingUrls.join(", ")}`,
    );
  });
});
