#!/usr/bin/env node
/**
 * clarice-import-waves.ts
 *
 * Importa pro Brevo as waves geradas por clarice-build-waves.ts: cria uma lista
 * por wave e sobe os contatos do CSV correspondente. Terça-feira vira 1 comando
 * em vez de import manual na UI.
 *
 * SEGURANÇA: dry-run por padrão (só imprime o plano). `--execute` é que de fato
 * cria listas e importa contatos na conta de PRODUÇÃO da Clarice.
 *
 * Uso:
 *   npx tsx scripts/clarice-import-waves.ts --label "Jun/2026"            # dry-run
 *   npx tsx scripts/clarice-import-waves.ts --label "Jun/2026" --execute  # cria + importa
 *   [--folder-id N]   folder Brevo onde criar as listas (default 1)
 *
 * Env:
 *   BREVO_CLARICE_API_KEY   obrigatório (só usado em --execute)
 *
 * Inputs (em data/clarice-subscribers/waves/, gerados por clarice-build-waves.ts):
 *   t1-openers.csv · t1-non-openers.csv · t2-w3.csv · t2-w4.csv
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { brevoPost } from "./lib/brevo-client.ts";

loadProjectEnv();

const ROOT = resolve(import.meta.dirname, "..");
const WAVES_DIR = resolve(ROOT, "data/clarice-subscribers/waves");

// ---------------------------------------------------------------------------
// Definição das waves (ordem de envio = ordem do warm-up)
// ---------------------------------------------------------------------------

export interface WaveDef {
  key: string;
  file: string;
  /** Rótulo curto pro nome da lista. */
  desc: string;
}

export const WAVES: WaveDef[] = [
  { key: "W1", file: "t1-openers.csv", desc: "T1 abriu" },
  { key: "W2", file: "t1-non-openers.csv", desc: "T1 nao-abriu" },
  { key: "W3", file: "t2-w3.csv", desc: "T2 parte1" },
  { key: "W4", file: "t2-w4.csv", desc: "T2 parte2" },
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Nome determinístico da lista Brevo. Ex: "Clarice Jun/2026 W1 — T1 abriu". */
export function listNameFor(wave: WaveDef, label: string): string {
  return `Clarice ${label} ${wave.key} — ${wave.desc}`;
}

/** Conta as linhas de dados (sem header) de um CSV. Usa Papa pra não quebrar
 *  em campos quotados com newline/vírgula embutidos (split ingênuo inflava). */
export function countRows(csv: string): number {
  return Papa.parse(csv, { header: true, skipEmptyLines: true }).data.length;
}

/**
 * Normaliza o CSV pro import Brevo: o header da coluna de email vira `EMAIL`
 * (Brevo identifica o contato por esse header). Demais colunas (NOME →
 * firstname, OPEN_PROBABILITY, RECENCY_QUARTIL…) já batem com os atributos.
 */
export function normalizeImportCsv(csv: string): string {
  const nl = csv.indexOf("\n");
  if (nl < 0) return csv;
  const header = csv.slice(0, nl);
  const rest = csv.slice(nl);
  const newHeader = header
    .split(",")
    .map((h) => (/^\s*e-?mail\s*$/i.test(h) ? "EMAIL" : h.trim()))
    .join(",");
  return newHeader + rest;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  execute: boolean;
  label: string;
  folderId: number;
}

export function parseArgs(argv: string[]): Args {
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const folder = parseInt(get("--folder-id") ?? "1", 10);
  return {
    execute: argv.includes("--execute"),
    label: get("--label") ?? "edição atual",
    folderId: Number.isFinite(folder) && folder > 0 ? folder : 1,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface Plan {
  wave: WaveDef;
  listName: string;
  count: number;
  csv: string;
  columns: string[];
}

function buildPlan(label: string): Plan[] {
  const plans: Plan[] = [];
  for (const wave of WAVES) {
    const path = resolve(WAVES_DIR, wave.file);
    if (!existsSync(path)) {
      throw new Error(`wave faltando: ${path} — rode clarice-build-waves.ts antes.`);
    }
    const raw = readFileSync(path, "utf-8");
    const csv = normalizeImportCsv(raw);
    const columns = (csv.split(/\r?\n/)[0] ?? "").split(",");
    plans.push({ wave, listName: listNameFor(wave, label), count: countRows(raw), csv, columns });
  }
  return plans;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const plans = buildPlan(args.label);

  // --- Plano (sempre imprime) ---
  console.error(`\n📋 Plano de import — folder ${args.folderId} — modo ${args.execute ? "EXECUTE 🔴" : "DRY-RUN"}`);
  let total = 0;
  for (const p of plans) {
    console.error(`  ${p.wave.key}: "${p.listName}"  ←  ${p.wave.file}  (${p.count} contatos)`);
    console.error(`       colunas: ${p.columns.join(", ")}`);
    total += p.count;
  }
  console.error(`  TOTAL: ${total} contatos em ${plans.length} listas`);

  if (!args.execute) {
    console.error(`\nℹ️  dry-run — nada foi criado. Re-rode com --execute pra criar listas + importar.`);
    console.log(JSON.stringify({ mode: "dry-run", folder_id: args.folderId, label: args.label, waves: plans.map((p) => ({ wave: p.wave.key, list: p.listName, count: p.count })), total }, null, 2));
    return;
  }

  // --- Execute ---
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida (necessária pra --execute).");
    process.exit(1);
  }

  const results: { wave: string; listId: number; processId: unknown; count: number }[] = [];
  for (const p of plans) {
    console.error(`\n→ ${p.wave.key}: criando lista "${p.listName}"…`);
    const list = (await brevoPost(apiKey, "/contacts/lists", {
      name: p.listName,
      folderId: args.folderId,
    })) as { id: number };
    console.error(`   list #${list.id} criada · importando ${p.count} contatos…`);
    const imp = (await brevoPost(apiKey, "/contacts/import", {
      fileBody: p.csv,
      listIds: [list.id],
      updateExistingContacts: true,
      emptyContactsAttributes: false,
    })) as { processId?: unknown };
    console.error(`   import disparado (processId=${imp.processId ?? "?"})`);
    results.push({ wave: p.wave.key, listId: list.id, processId: imp.processId, count: p.count });
  }

  console.error(`\n✅ ${results.length} listas criadas + imports disparados (assíncronos na Brevo).`);
  console.log(JSON.stringify({ mode: "execute", folder_id: args.folderId, label: args.label, results }, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
