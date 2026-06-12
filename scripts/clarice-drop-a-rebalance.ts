/**
 * clarice-drop-a-rebalance.ts (one-off — ciclo 2605-06)
 *
 * Remove a variante A do teste A/B/C de assunto (d04–d07) SEM orfanar a
 * audiência: redistribui cada terço-A 50/50 nas células B e C, estratificado
 * por TIER, atualizando os CSVs locais E o estado da Brevo (add nas listas
 * B/C + delete das campanhas A).
 *
 * Por que assim (e não recriar campanhas): campanha clássica list-based da
 * Brevo resolve destinatários no momento do envio pela membership da lista,
 * então basta mutar a lista — as campanhas B/C ficam intactas (subject/HTML/
 * horário/guard É IA?). Ver discussão em sessão 2026-06-12.
 *
 * Split determinístico: dentro de cada TIER, round-robin (par→B, ímpar→C),
 * preservando a estratificação por tier que o clarice-split-cells criou.
 *
 * Uso:
 *   npx tsx scripts/clarice-drop-a-rebalance.ts             # dry-run (default)
 *   npx tsx scripts/clarice-drop-a-rebalance.ts --apply     # local + Brevo
 *   npx tsx scripts/clarice-drop-a-rebalance.ts --apply --only d04
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";

const API_KEY = process.env.BREVO_CLARICE_API_KEY;
if (!API_KEY) { console.error("BREVO_CLARICE_API_KEY missing (.env)"); process.exit(2); }

const APPLY = process.argv.includes("--apply");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CELLS_DIR = resolve(ROOT, "data/clarice-subscribers/2605-06/sends/cells");

// campanha A → { lista A (origem), listas B/C (destino), campanhas B/C (intactas) }
const DAYS = [
  { day: "d04", aCamp: 47, aList: 46, bList: 47, cList: 48 },
  { day: "d05", aCamp: 50, aList: 49, bList: 50, cList: 51 },
  { day: "d06", aCamp: 53, aList: 52, bList: 53, cList: 54 },
  { day: "d07", aCamp: 56, aList: 55, bList: 56, cList: 57 },
].filter((d) => !ONLY || d.day === ONLY);

type Row = { email: string; NOME: string; TIER: string };

function readCells(path: string): Row[] {
  const txt = readFileSync(path, "utf8");
  const out = Papa.parse<Row>(txt, { header: true, skipEmptyLines: true, delimiter: "," });
  if (out.errors.length) throw new Error(`CSV parse ${path}: ${JSON.stringify(out.errors[0])}`);
  return out.data;
}

function writeCells(path: string, rows: Row[]): void {
  const csv = Papa.unparse(rows, { columns: ["email", "NOME", "TIER"] });
  writeFileSync(path, csv + "\n", "utf8");
}

/** Split estratificado por TIER: round-robin dentro de cada tier (par→B, ímpar→C). */
function stratSplit(rows: Row[]): { toB: Row[]; toC: Row[] } {
  const byTier = new Map<string, Row[]>();
  for (const r of rows) {
    const t = r.TIER ?? "";
    if (!byTier.has(t)) byTier.set(t, []);
    byTier.get(t)!.push(r);
  }
  const toB: Row[] = [], toC: Row[] = [];
  for (const [, group] of byTier) {
    group.forEach((r, i) => (i % 2 === 0 ? toB : toC).push(r));
  }
  return { toB, toC };
}

async function bf(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    ...opts,
    headers: { "api-key": API_KEY!, "Content-Type": "application/json", Accept: "application/json", ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  if (res.status === 404 && (opts.method === "DELETE")) return { _notFound: true };
  if (!res.ok) throw new Error(`Brevo ${opts.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function addToList(listId: number, rows: Row[]): Promise<void> {
  const emails = rows.map((r) => r.email.toLowerCase());
  for (let i = 0; i < emails.length; i += 150) {
    const batch = emails.slice(i, i + 150);
    const r = await bf(`/contacts/lists/${listId}/contacts/add`, { method: "POST", body: JSON.stringify({ emails: batch }) });
    const ok = r?.contacts?.success?.length ?? 0;
    const already = batch.length - ok;
    console.log(`      + lista ${listId}: ${ok} novos${already ? `, ${already} já presentes` : ""} (lote ${batch.length})`);
  }
}

async function main() {
  console.log(`\n=== clarice-drop-a-rebalance — MODO: ${APPLY ? "APPLY" : "DRY-RUN"}${ONLY ? ` (só ${ONLY})` : ""} ===\n`);

  // cells-summary.json (atualizado no fim se APPLY)
  const summaryPath = resolve(CELLS_DIR, "cells-summary.json");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const byList: Record<number, { count: number }> = {};
  for (const r of summary.results) byList[r.listId] = r;

  for (const d of DAYS) {
    const aPath = resolve(CELLS_DIR, `${d.day}-A.csv`);
    const bPath = resolve(CELLS_DIR, `${d.day}-B.csv`);
    const cPath = resolve(CELLS_DIR, `${d.day}-C.csv`);

    const aRows = readCells(aPath);
    if (aRows.length === 0) { console.log(`${d.day}: A já vazia — pulando`); continue; }
    const { toB, toC } = stratSplit(aRows);

    // guard: campanha A ainda em fila?
    const camp = await bf(`/emailCampaigns/${d.aCamp}`);
    const tierTally = (rows: Row[]) => {
      const m: Record<string, number> = {};
      for (const r of rows) m[r.TIER] = (m[r.TIER] ?? 0) + 1;
      return Object.entries(m).map(([t, n]) => `${t}:${n}`).join(" ");
    };

    console.log(`${d.day}: campA #${d.aCamp} status=${camp.status}`);
    console.log(`   A=${aRows.length} → B(+${toB.length}) C(+${toC.length})`);
    console.log(`   split B por tier: ${tierTally(toB)}`);
    console.log(`   split C por tier: ${tierTally(toC)}`);
    console.log(`   destino: lista ${d.bList} ${byList[d.bList].count}→${byList[d.bList].count + toB.length}, lista ${d.cList} ${byList[d.cList].count}→${byList[d.cList].count + toC.length}`);

    if (camp.status !== "queued") { console.log(`   ⚠ campA não está 'queued' (${camp.status}) — PULANDO ${d.day}`); continue; }

    if (!APPLY) { console.log(`   [dry-run] sem escrita\n`); continue; }

    // 1. local: append em B/C, esvazia A
    writeCells(bPath, [...readCells(bPath), ...toB]);
    writeCells(cPath, [...readCells(cPath), ...toC]);
    writeCells(aPath, []);
    // 2. Brevo: add nas listas B/C
    await addToList(d.bList, toB);
    await addToList(d.cList, toC);
    // 3. Brevo: suspende campanha A (DELETE é proibido p/ campanha já agendada)
    await bf(`/emailCampaigns/${d.aCamp}/status`, { method: "PUT", body: JSON.stringify({ status: "suspended" }) });
    console.log(`   ✓ camp A #${d.aCamp} suspensa\n`);
  }

  // recomputa cells-summary.json a partir dos CSVs reais (robusto a runs parciais)
  if (APPLY) {
    for (const d of DAYS) {
      for (const [cell, listId] of [["A", d.aList], ["B", d.bList], ["C", d.cList]] as const) {
        const n = readCells(resolve(CELLS_DIR, `${d.day}-${cell}.csv`)).length;
        if (byList[listId]) byList[listId].count = n;
      }
    }
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
    console.log("cells-summary.json recomputado dos CSVs.");
  }
}

main().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
