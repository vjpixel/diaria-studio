/**
 * #8711 — `context/sources.md` (o que os agentes de pesquisa leem) é gerado de
 * `seed/sources.csv` por `npm run sync-sources`. Editar só o CSV (ex: desativar
 * uma fonte) sem regenerar deixava a fonte anunciada ao pipeline. Este guard
 * falha em CI quando os dois divergem no conjunto de fontes ou no total.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { parseSourcesMd } from "../scripts/list-active-sources.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = "rode `npm run sync-sources` e commite context/sources.md";

describe("context/sources.md em sync com seed/sources.csv (#8711)", () => {
  const csvRows = Papa.parse<{ Nome: string; RSS?: string }>(readFileSync(resolve(ROOT, "seed/sources.csv"), "utf8"), {
    header: true,
    skipEmptyLines: true,
  }).data;
  const csv = csvRows.map((r) => r.Nome.trim());
  const md = readFileSync(resolve(ROOT, "context/sources.md"), "utf8");
  const headings = [...md.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim());

  it("mesmo conjunto de fontes", () => {
    const inMdOnly = headings.filter((h) => !csv.includes(h));
    const inCsvOnly = csv.filter((n) => !headings.includes(n));
    assert.deepEqual({ inMdOnly, inCsvOnly }, { inMdOnly: [], inCsvOnly: [] }, FIX);
  });

  // #10240: o sinal source_feed_broken e a coleta do feed leem o RSS de
  // context/sources.md — CSV re-preenchido (ou esvaziado) sem sync divergiria
  // em silêncio.
  it("mesmo RSS por fonte", () => {
    const mdRss = new Map(parseSourcesMd(md).map((s) => [s.name, s.rss?.trim() ?? ""]));
    const diverge = csvRows
      .map((r) => ({ fonte: r.Nome.trim(), csv: r.RSS?.trim() ?? "", md: mdRss.get(r.Nome.trim()) ?? "" }))
      .filter((d) => mdRss.has(d.fonte) && d.csv !== d.md);
    assert.deepEqual(diverge, [], FIX);
  });

  it("header 'Total: N fontes' bate com o CSV", () => {
    const m = md.match(/\*\*Total:\*\* (\d+) fontes/);
    assert.ok(m, "header Total ausente");
    assert.equal(Number(m![1]), csv.length, FIX);
  });
});
