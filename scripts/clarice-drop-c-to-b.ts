#!/usr/bin/env npx tsx
/**
 * clarice-drop-c-to-b.ts (one-off — ciclo 2605-06, #2182 follow-up)
 *
 * O teste A/B/C de subject encerrou: **B venceu**. Encerra o B/C e consolida
 * TODA a audiência da célula C na B, pros 2 dias ainda agendados (d06 seg 15/jun,
 * d07 ter 16/jun). Análogo ao clarice-drop-a-rebalance, mas movendo 100% da C
 * pra B (sem split) — todo contato VÁLIDO recebe o digest com o assunto B
 * vencedor (emails inválidos que a Brevo rejeita no add ficam de fora, como
 * ficariam de qualquer jeito; o script aborta nesse caso pra inspeção).
 *
 * Mesmas pegadinhas/garantias do drop-a (#2182):
 *  - DELETE de campanha agendada é proibido → `PUT status=suspended` na C.
 *  - A Brevo CONGELA os destinatários no AGENDAMENTO, não no envio → depois de
 *    adicionar a C na lista da B é OBRIGATÓRIO RE-AGENDAR a B (suspend →
 *    re-set scheduledAt = re-queue) pra forçar novo snapshot. É o resnapshot().
 *  - Ordem por dia: Brevo PRIMEIRO (add B → suspend C → esvazia lista C →
 *    re-snapshot B), local POR ÚLTIMO. Re-run é idempotente (add/suspend/remove
 *    toleram repetição; C local vazia faz o dia ser pulado).
 *
 * Uso:
 *   npx tsx scripts/clarice-drop-c-to-b.ts            # dry-run (default)
 *   npx tsx scripts/clarice-drop-c-to-b.ts --apply    # Brevo + local
 *   npx tsx scripts/clarice-drop-c-to-b.ts --apply --only d06
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { readCells, writeCells, type Row } from "./clarice-drop-a-rebalance.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CELLS_DIR = resolve(ROOT, "data/clarice-subscribers/2605-06/sends/cells");

// campanha/lista C (origem, suspensa+esvaziada) → B (destino, re-snapshotada).
// IDs: mesmos do clarice-drop-a-rebalance (ALL_DAYS). d04/d05 já foram enviados.
const ALL_DAYS = [
  { day: "d06", bCamp: 54, bList: 53, cCamp: 55, cList: 54 },
  { day: "d07", bCamp: 57, bList: 56, cCamp: 58, cList: 57 },
];

async function bf(apiKey: string, path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    ...opts,
    headers: { "api-key": apiKey, "Content-Type": "application/json", Accept: "application/json", ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Brevo ${opts.method ?? "GET"} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
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
    if (failed) throw new Error(`Brevo add lista ${listId}: ${failed} falha(s): ${JSON.stringify(r.contacts.failure).slice(0, 300)}`);
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

/** Re-snapshot: suspend → re-set scheduledAt = re-queue força novo snapshot da membership atual. */
async function resnapshot(apiKey: string, campId: number): Promise<void> {
  const c = await bf(apiKey, `/emailCampaigns/${campId}`);
  // #2272 (review): aceita 'suspended' TAMBÉM. Se um crash anterior parou ENTRE o
  // suspend e o re-set scheduledAt, a B fica `suspended` — re-rodar precisa
  // RE-AGENDAR (re-queue), NÃO pular (senão a B nunca volta pra fila e não envia).
  // Só pula estados terminais (sent/in_process/etc).
  if (c.status !== "queued" && c.status !== "suspended") {
    console.log(`      ↻ camp #${campId} status=${c.status} — pulando re-snapshot`);
    return;
  }
  if (c.status === "queued") {
    await bf(apiKey, `/emailCampaigns/${campId}/status`, { method: "PUT", body: JSON.stringify({ status: "suspended" }) });
  }
  await bf(apiKey, `/emailCampaigns/${campId}`, { method: "PUT", body: JSON.stringify({ scheduledAt: c.scheduledAt }) });
  console.log(`      ↻ camp B #${campId} re-snapshot/re-queue (@ ${c.scheduledAt})`);
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const apply = argv.includes("--apply");
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
  const days = ALL_DAYS.filter((d) => !only || d.day === only);
  if (only && days.length === 0) { console.error(`--only ${only} não corresponde (${ALL_DAYS.map((d) => d.day).join(", ")})`); process.exit(2); }

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) { console.error("BREVO_CLARICE_API_KEY missing (.env)"); process.exit(2); }

  console.log(`\n=== clarice-drop-c-to-b — MODO: ${apply ? "APPLY" : "DRY-RUN"}${only ? ` (só ${only})` : ""} ===`);
  console.log("Teste A/B/C encerrado — B venceu. Consolidando C→B em d06/d07.\n");

  for (const d of days) {
    const bPath = resolve(CELLS_DIR, `${d.day}-B.csv`);
    const cPath = resolve(CELLS_DIR, `${d.day}-C.csv`);
    const cRows = readCells(cPath);
    if (cRows.length === 0) { console.log(`${d.day}: C já vazia — pulando`); continue; }

    const camp = await bf(apiKey, `/emailCampaigns/${d.cCamp}`);
    const bBefore = readCells(bPath).length;
    console.log(`${d.day}: campC #${d.cCamp} status=${camp.status}`);
    console.log(`   C=${cRows.length} → B (lista ${d.bList}: ${bBefore} → ${bBefore + cRows.length})`);

    if (camp.status !== "queued") { console.log(`   ⚠ campC não está 'queued' (${camp.status}) — PULANDO ${d.day}`); continue; }
    if (!apply) { console.log(`   [dry-run] sem escrita\n`); continue; }

    // Brevo PRIMEIRO (idempotente): add C→B, suspende C, esvazia lista C, re-snapshot B.
    await addToList(apiKey, d.bList, cRows);
    await bf(apiKey, `/emailCampaigns/${d.cCamp}/status`, { method: "PUT", body: JSON.stringify({ status: "suspended" }) });
    await removeFromList(apiKey, d.cList, cRows);
    console.log(`   ✓ camp C #${d.cCamp} suspensa + lista C ${d.cList} esvaziada`);
    await resnapshot(apiKey, d.bCamp);

    // local POR ÚLTIMO: append C em B, esvazia C.
    writeCells(bPath, [...readCells(bPath), ...cRows]);
    writeCells(cPath, []);
    console.log(`   ✓ ${d.day} local atualizado\n`);
  }

  if (apply) {
    writeFileAtomic(resolve(CELLS_DIR, ".c-dropped.json"), JSON.stringify({
      reason: "Teste A/B/C encerrado — B venceu. Célula C consolidada 100% na B (d06/d07).",
      cycle: "2605-06",
      days: days.map((d) => d.day),
      script: "scripts/clarice-drop-c-to-b.ts",
    }, null, 2) + "\n");
    console.log("sentinel .c-dropped.json escrito.");
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  main().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
}
