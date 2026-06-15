/**
 * clarice-drop-a-rebalance.ts (one-off — ciclo 2605-06)
 *
 * Remove a variante A do teste A/B/C de assunto (d04–d07) SEM orfanar a
 * audiência: redistribui cada terço-A 50/50 nas células B e C, estratificado
 * por TIER, mutando o estado da Brevo (add nas listas B/C + suspende as
 * campanhas A + esvazia as listas A) E atualizando os CSVs locais.
 *
 * DELETE de campanha agendada é proibido pela Brevo ("once scheduled can not
 * be deleted") — por isso PUT status=suspended.
 *
 * IMPORTANTE (corrigido 2026-06-12, verificado no UI): a Brevo CONGELA os
 * destinatários no momento do AGENDAMENTO, não no envio. Adicionar contatos à
 * lista depois de a campanha já estar agendada NÃO os inclui no envio. Por isso
 * não basta mutar a lista — é preciso RE-AGENDAR cada campanha B/C (suspend →
 * re-set scheduledAt = re-queue) DEPOIS de aumentar a lista, pra forçar um novo
 * snapshot. É o que o passo `resnapshot()` faz. (As campanhas ficam intactas em
 * subject/HTML/guard É IA?; só o snapshot de destinatários é refeito.)
 *
 * Ordem por dia: Brevo PRIMEIRO (add/suspend/remove — todas idempotentes),
 * local POR ÚLTIMO. Se crashar antes do passo local, o re-run reprocessa o dia
 * (A ainda populada localmente) sem orfanar ninguém na Brevo. Janela residual:
 * crash no meio do bloco local pode duplicar o append local — Brevo é a fonte
 * de verdade; confira os CSVs à mão nesse caso raro.
 *
 * Após --apply, escreve o sentinel cells/.a-dropped.json que faz o
 * clarice-split-cells abortar um re-split (não recria a A nem clobbera os CSVs).
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
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Papa from "papaparse";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { withBrevo429Retry, throwBrevo429 } from "./lib/brevo-client.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CELLS_DIR = resolve(ROOT, "data/clarice-subscribers/2605-06/sends/cells");

// campanha A (suspensa) + listas/campanhas B/C (destino, re-snapshotadas)
const ALL_DAYS = [
  { day: "d04", aCamp: 47, aList: 46, bCamp: 48, bList: 47, cCamp: 49, cList: 48 },
  { day: "d05", aCamp: 50, aList: 49, bCamp: 51, bList: 50, cCamp: 52, cList: 51 },
  { day: "d06", aCamp: 53, aList: 52, bCamp: 54, bList: 53, cCamp: 55, cList: 54 },
  { day: "d07", aCamp: 56, aList: 55, bCamp: 57, bList: 56, cCamp: 58, cList: 57 },
];

export type Row = { email: string; NOME: string; TIER: string };

export function readCells(path: string): Row[] {
  const txt = readFileSync(path, "utf8");
  const out = Papa.parse<Row>(txt, { header: true, skipEmptyLines: true, delimiter: "," });
  // FieldMismatch/etc. são não-fatais no papaparse; só abortamos em erro de delimitador.
  const fatal = out.errors.find((e) => e.type === "Delimiter");
  if (fatal) throw new Error(`CSV parse ${path}: ${JSON.stringify(fatal)}`);
  return out.data;
}

export function writeCells(path: string, rows: Row[]): void {
  // newline:"\n" + trailing "\n": evita CRLF/LF misturado, que faria o
  // papaparse ler o TIER da última linha como "T2\n" (corrupção de bucket).
  const csv = Papa.unparse(rows, { columns: ["email", "NOME", "TIER"], newline: "\n" });
  writeFileAtomic(path, csv + "\n");
}

/** Split estratificado por TIER: round-robin dentro de cada tier (par→B, ímpar→C). */
export function stratSplit(rows: Row[]): { toB: Row[]; toC: Row[] } {
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

// #2275: bf() agora retenta em 429 via withBrevo429Retry (importado de brevo-client.ts).
async function bf(apiKey: string, path: string, opts: RequestInit = {}): Promise<any> {
  return withBrevo429Retry(async () => {
    const res = await fetch(`https://api.brevo.com/v3${path}`, {
      ...opts,
      headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json", ...(opts.headers ?? {}) },
    });
    if (res.status === 429) throwBrevo429(res);
    const text = await res.text();
    if (!res.ok) throw new Error(`Brevo ${opts.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  });
}

async function addToList(apiKey: string, listId: number, rows: Row[]): Promise<void> {
  const emails = rows.map((r) => r.email.toLowerCase());
  for (let i = 0; i < emails.length; i += 150) {
    const batch = emails.slice(i, i + 150);
    const r = await bf(apiKey, `/contacts/lists/${listId}/contacts/add`, { method: "POST", body: JSON.stringify({ emails: batch }) });
    const ok = r?.contacts?.success?.length ?? 0;
    const failed = r?.contacts?.failure?.length ?? 0;
    const already = batch.length - ok - failed;
    console.log(`      + lista ${listId}: ${ok} novos, ${already} já presentes${failed ? `, ${failed} FALHAS` : ""} (lote ${batch.length})`);
    if (failed) throw new Error(`Brevo add lista ${listId}: ${failed} contato(s) falharam: ${JSON.stringify(r.contacts.failure).slice(0, 300)}`);
  }
}

async function removeFromList(apiKey: string, listId: number, rows: Row[]): Promise<void> {
  const emails = rows.map((r) => r.email.toLowerCase());
  for (let i = 0; i < emails.length; i += 150) {
    const batch = emails.slice(i, i + 150);
    await bf(apiKey, `/contacts/lists/${listId}/contacts/remove`, { method: "POST", body: JSON.stringify({ emails: batch }) });
  }
  console.log(`      − lista ${listId}: ${emails.length} removidos`);
}

/**
 * Re-snapshot de uma campanha agendada: suspende e re-agenda para o MESMO
 * horário. A transição suspended→queued faz a Brevo recomputar os
 * destinatários a partir da membership atual da lista — sem isso, os contatos
 * adicionados após o agendamento original não recebem. (Validado 2026-06-12; o
 * re-snapshot vem da re-fila, não da mudança de horário.)
 */
async function resnapshot(apiKey: string, campId: number): Promise<void> {
  const c = await bf(apiKey, `/emailCampaigns/${campId}`);
  if (c.status !== "queued") { console.log(`      ↻ camp #${campId} status=${c.status} — pulando re-snapshot`); return; }
  await bf(apiKey, `/emailCampaigns/${campId}/status`, { method: "PUT", body: JSON.stringify({ status: "suspended" }) });
  await bf(apiKey, `/emailCampaigns/${campId}`, { method: "PUT", body: JSON.stringify({ scheduledAt: c.scheduledAt }) });
  console.log(`      ↻ camp #${campId} re-snapshot (re-agendada @ ${c.scheduledAt})`);
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const apply = argv.includes("--apply");
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
  if (onlyIdx >= 0 && (!only || only.startsWith("--"))) {
    console.error("--only requer um dia (ex: --only d04).");
    process.exit(2);
  }
  const days = ALL_DAYS.filter((d) => !only || d.day === only);
  if (only && days.length === 0) {
    console.error(`--only ${only} não corresponde a nenhum dia conhecido (${ALL_DAYS.map((d) => d.day).join(", ")}).`);
    process.exit(2);
  }

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) { console.error("BREVO_CLARICE_API_KEY missing (.env)"); process.exit(2); }

  console.log(`\n=== clarice-drop-a-rebalance — MODO: ${apply ? "APPLY" : "DRY-RUN"}${only ? ` (só ${only})` : ""} ===\n`);

  const summaryPath = resolve(CELLS_DIR, "cells-summary.json");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  const byList: Record<number, { count: number }> = {};
  for (const r of summary.results) byList[r.listId] = r;

  const tierTally = (rows: Row[]) => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.TIER] = (m[r.TIER] ?? 0) + 1;
    return Object.entries(m).map(([t, n]) => `${t}:${n}`).join(" ");
  };

  for (const d of days) {
    const aPath = resolve(CELLS_DIR, `${d.day}-A.csv`);
    const bPath = resolve(CELLS_DIR, `${d.day}-B.csv`);
    const cPath = resolve(CELLS_DIR, `${d.day}-C.csv`);

    const aRows = readCells(aPath);
    if (aRows.length === 0) { console.log(`${d.day}: A já vazia — pulando`); continue; }
    const { toB, toC } = stratSplit(aRows);

    const camp = await bf(apiKey, `/emailCampaigns/${d.aCamp}`);
    const bBase = byList[d.bList]?.count ?? "?";
    const cBase = byList[d.cList]?.count ?? "?";
    console.log(`${d.day}: campA #${d.aCamp} status=${camp.status}`);
    console.log(`   A=${aRows.length} → B(+${toB.length}) C(+${toC.length})`);
    console.log(`   split B por tier: ${tierTally(toB)}`);
    console.log(`   split C por tier: ${tierTally(toC)}`);
    console.log(`   destino: lista ${d.bList} ${bBase}→${typeof bBase === "number" ? bBase + toB.length : "?"}, lista ${d.cList} ${cBase}→${typeof cBase === "number" ? cBase + toC.length : "?"}`);

    if (camp.status !== "queued") { console.log(`   ⚠ campA não está 'queued' (${camp.status}) — PULANDO ${d.day}`); continue; }
    if (!apply) { console.log(`   [dry-run] sem escrita\n`); continue; }

    // Brevo PRIMEIRO (idempotente): add B/C, suspende A, esvazia lista A.
    await addToList(apiKey, d.bList, toB);
    await addToList(apiKey, d.cList, toC);
    await bf(apiKey, `/emailCampaigns/${d.aCamp}/status`, { method: "PUT", body: JSON.stringify({ status: "suspended" }) });
    await removeFromList(apiKey, d.aList, aRows);
    console.log(`   ✓ camp A #${d.aCamp} suspensa + lista A esvaziada`);

    // re-snapshot OBRIGATÓRIO das B/C: a Brevo congelou os destinatários no
    // agendamento original; sem re-agendar, os contatos recém-adicionados não
    // recebem. Ver docstring + sessão 2026-06-12.
    await resnapshot(apiKey, d.bCamp);
    await resnapshot(apiKey, d.cCamp);

    // local POR ÚLTIMO: append em B/C, esvazia A.
    writeCells(bPath, [...readCells(bPath), ...toB]);
    writeCells(cPath, [...readCells(cPath), ...toC]);
    writeCells(aPath, []);
    console.log(`   ✓ ${d.day} local atualizado\n`);
  }

  if (apply) {
    // recomputa cells-summary.json a partir dos CSVs reais (robusto a runs parciais)
    for (const d of days) {
      for (const [cell, listId] of [["A", d.aList], ["B", d.bList], ["C", d.cList]] as const) {
        const n = readCells(resolve(CELLS_DIR, `${d.day}-${cell}.csv`)).length;
        if (byList[listId]) byList[listId].count = n;
      }
    }
    writeFileAtomic(summaryPath, JSON.stringify(summary, null, 2) + "\n");
    // sentinel: faz clarice-split-cells abortar um re-split (assertCellsNotDropped).
    writeFileAtomic(resolve(CELLS_DIR, ".a-dropped.json"), JSON.stringify({
      reason: "Variante A do teste A/B/C dropada — terços-A redistribuídos 50/50 em B/C.",
      cycle: "2605-06",
      days: days.map((d) => d.day),
      script: "scripts/clarice-drop-a-rebalance.ts",
      note: "Remova este arquivo só pra forçar um re-split completo (recria a A).",
    }, null, 2) + "\n");
    console.log("cells-summary.json recomputado + sentinel .a-dropped.json escrito.");
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  main().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
}
