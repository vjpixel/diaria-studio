#!/usr/bin/env node
/**
 * clarice-split-cells.ts (teste A/B/C de assunto — Edição Maio, ciclo 2605-06)
 *
 * Divide cada envio da SEMANA 1 (d01–d07) em 3 células estratificadas (A/B/C)
 * para o teste de assunto same-time: 3 campanhas por dia, mesmo horário, cada
 * uma com 1/3 do público daquele dia — mesma mistura de tiers em cada célula
 * (amostragem sistemática via stratify; os CSVs de send vêm agrupados por tier,
 * e o passo-a-passo round-robin preserva as proporções).
 *
 * Leitura do teste: agregado da SEMANA (≈1.867/variante) — célula diária é ruído.
 * Vencedor trava para S2-S3 (assunto único).
 *
 * Uso:
 *   npx tsx scripts/clarice-split-cells.ts --cycle 2605-06            # split + dry-run do plano
 *   npx tsx scripts/clarice-split-cells.ts --cycle 2605-06 --execute  # split + cria listas + importa no Brevo
 *
 * Inputs:  {ciclo}/sends/d01-*.csv … d07-*.csv (gerados por clarice-build-edition-sends)
 * Outputs: {ciclo}/sends/cells/d0N-{A,B,C}.csv + listas Brevo "Clarice {label} d0N-{A|B|C} ({dia})"
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { brevoPost, brevoListAllLists } from "./lib/brevo-client.ts"; // #2018: brevoListAllLists
import { clariceCycleDir, ensureDir, parseCycleArg } from "./lib/clarice-paths.ts";
import { SENDS, stratify, apportion } from "./clarice-build-edition-sends.ts";
import { toImportCsv } from "./clarice-import-sends.ts";

loadProjectEnv();

type Row = Record<string, string>;
export const CELLS = ["A", "B", "C"] as const;

/** Nome determinístico da lista-célula. Ex: "Clarice Jun/2026 d01-A (qua)". */
export function cellListName(n: number, cell: string, day: string, label: string): string {
  return `Clarice ${label} d${String(n).padStart(2, "0")}-${cell} (${day})`;
}

// #2018: fetchExistingLists triplicada → lib/brevo-client.brevoListAllLists.
// Alias local pra manter a chamada interna legível sem renomear os call-sites.
const fetchExistingLists = brevoListAllLists;

/**
 * Guarda contra re-split que clobberaria uma edição cujas células foram
 * editadas manualmente — ex: variante A dropada no meio do teste A/B/C
 * (sessão 2026-06-12, ciclo 2605-06). O passo 1 (split local) roda sempre e
 * incondicionalmente; sem este guard, re-rodar (mesmo dry-run) sobrescreveria
 * os CSVs `cells/d0N-*.csv` e recriaria a A. O sentinel `cells/.a-dropped.json`
 * sinaliza "não toque". Remova o sentinel pra forçar um re-split completo.
 */
export function assertCellsNotDropped(cellsDir: string): void {
  const sentinel = resolve(cellsDir, ".a-dropped.json");
  if (existsSync(sentinel)) {
    throw new Error(
      `células foram editadas manualmente neste ciclo (sentinel ${sentinel}) — ` +
        `re-split abortado pra não clobberar os CSVs locais nem recriar a variante dropada. ` +
        `Remova o sentinel pra forçar um re-split completo.`,
    );
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cycle = parseCycleArg(argv);
  if (!cycle) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2605-06).");
    process.exit(1);
  }
  const execute = argv.includes("--execute");
  const labelIdx = argv.indexOf("--label");
  const label = labelIdx >= 0 && argv[labelIdx + 1] && !argv[labelIdx + 1].startsWith("--")
    ? argv[labelIdx + 1]
    : "Jun/2026";

  const sendsDir = resolve(clariceCycleDir(cycle), "sends");
  const cellsDir = ensureDir(resolve(sendsDir, "cells"));
  assertCellsNotDropped(cellsDir); // não clobberar edição com células editadas à mão
  const week1 = SENDS.filter((s) => s.week === 1);

  // 1) Split estratificado de cada dia em 3 células (sempre roda; determinístico).
  const plan: { n: number; day: string; cell: string; file: string; count: number; csv: string }[] = [];
  for (const s of week1) {
    const file = `d${String(s.n).padStart(2, "0")}-${s.date}.csv`;
    const path = resolve(sendsDir, file);
    if (!existsSync(path)) throw new Error(`envio faltando: ${path} — rode clarice-build-edition-sends antes.`);
    const rows = Papa.parse<Row>(readFileSync(path, "utf-8"), { header: true, skipEmptyLines: true }).data;
    const caps = apportion(rows.length, [1 / 3, 1 / 3, 1 / 3]);
    const cells = stratify(rows, caps);
    cells.forEach((cellRows: Row[], ci: number) => {
      const cellFile = `d${String(s.n).padStart(2, "0")}-${CELLS[ci]}.csv`;
      const raw = Papa.unparse({ fields: ["email", "NOME", "TIER"], data: cellRows });
      writeFileAtomic(resolve(cellsDir, cellFile), raw);
      const { csv, count } = toImportCsv(raw);
      plan.push({ n: s.n, day: s.day, cell: CELLS[ci], file: cellFile, count, csv });
    });
    // composição por célula (audit no stderr)
    const comp = (rs: Row[]): string => {
      const c: Record<string, number> = {};
      for (const r of rs) c[r.TIER] = (c[r.TIER] ?? 0) + 1;
      return JSON.stringify(c);
    };
    console.error(`d${String(s.n).padStart(2, "0")} (${s.day}, ${rows.length}): A=${comp(cells[0])} B=${comp(cells[1])} C=${comp(cells[2])}`);
  }
  const total = plan.reduce((a, p) => a + p.count, 0);
  const perCell: Record<string, number> = {};
  for (const p of plan) perCell[p.cell] = (perCell[p.cell] ?? 0) + p.count;
  console.error(`\n21 células escritas em ${cellsDir} · total ${total} · por variante: ${JSON.stringify(perCell)}`);

  if (!execute) {
    console.error("dry-run — listas NÃO criadas. Re-rode com --execute pra importar no Brevo.");
    console.log(JSON.stringify({ mode: "dry-run", total, perCell }, null, 2));
    return;
  }

  // 2) Import no Brevo: 1 lista por célula, idempotente.
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida.");
    process.exit(1);
  }
  const existing = await fetchExistingLists(apiKey);
  const byName = new Map(existing.map((l) => [l.name, l.id]));
  const conflicts = plan.map((p) => cellListName(p.n, p.cell, p.day, label)).filter((n) => byName.has(n));
  if (conflicts.length) {
    console.error(`❌ ${conflicts.length} lista(s)-célula já existem (ex: "${conflicts[0]}"). Delete-as ou use --label diferente.`);
    process.exit(1);
  }
  const results: { list: string; listId: number; count: number }[] = [];
  for (const p of plan) {
    const name = cellListName(p.n, p.cell, p.day, label);
    const list = (await brevoPost(apiKey, "/contacts/lists", { name, folderId: 1 })) as { id?: number };
    if (typeof list?.id !== "number") throw new Error(`/contacts/lists shape inesperado: ${JSON.stringify(list)}`);
    await brevoPost(apiKey, "/contacts/import", {
      fileBody: p.csv,
      listIds: [list.id],
      updateExistingContacts: true,
      emptyContactsAttributes: false,
    });
    console.error(`✓ ${name} → list #${list.id} (${p.count})`);
    results.push({ list: name, listId: list.id, count: p.count });
  }
  writeFileAtomic(resolve(cellsDir, "cells-summary.json"), JSON.stringify({ label, results }, null, 2));
  console.log(JSON.stringify({ mode: "execute", lists: results.length, total }, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  main().catch((e) => {
    console.error(String(e?.stack || e));
    process.exit(1);
  });
}
