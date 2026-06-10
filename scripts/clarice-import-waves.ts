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
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2605-06 --label "Mai→Jun/2026"            # dry-run
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2605-06 --label "Mai→Jun/2026" --execute  # cria + importa
 *   --cycle {conteúdo}-{envio}   OBRIGATÓRIO — ciclo do envio (casa com clarice-build-waves --cycle)
 *   [--folder-id N]              folder Brevo onde criar as listas (default 1)
 *
 * Env:
 *   BREVO_CLARICE_API_KEY   obrigatório (só usado em --execute)
 *
 * Inputs (em data/clarice-subscribers/{conteúdo}-{envio}/waves/):
 *   w1-brevo-export-t1-openers.csv · w2-brevo-export-t1-non-openers.csv ·
 *   w3-mv-export-t2.csv · w4-mv-export-t2.csv (gerados por clarice-build-waves) ·
 *   w5-mv-export-maio.csv (opcional — cohort de maio, pulado se ausente)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { brevoPost, brevoListAllLists } from "./lib/brevo-client.ts"; // #2018: brevoListAllLists
import { clariceWavesDir, parseCycleArg } from "./lib/clarice-paths.ts"; // #1961

loadProjectEnv();

// ---------------------------------------------------------------------------
// Definição das waves (ordem de envio = ordem do warm-up)
// ---------------------------------------------------------------------------

export interface WaveDef {
  key: string;
  file: string;
  /** Rótulo curto pro nome da lista. */
  desc: string;
  /** Opcional: pula sem erro se o arquivo não existir (wave específica do ciclo,
   *  ex: leads de maio). As W1–W4 são obrigatórias (faltar = build-waves falhou). */
  optional?: boolean;
}

// Nome = wX + ferramenta que segmentou + tier (#provenance): T1 via opens da Brevo,
// T2/maio via MV-verified. W1–W4 são geradas pelo build-waves (toda edição); W5
// (leads frescos de maio) é cohort específico do ciclo → opcional.
export const WAVES: WaveDef[] = [
  { key: "W1", file: "w1-brevo-export-t1-openers.csv", desc: "T1 abriu" },
  { key: "W2", file: "w2-brevo-export-t1-non-openers.csv", desc: "T1 nao-abriu" },
  { key: "W3", file: "w3-mv-export-t2.csv", desc: "T2 parte1" },
  { key: "W4", file: "w4-mv-export-t2.csv", desc: "T2 parte2" },
  { key: "W5", file: "w5-mv-export-maio.csv", desc: "Leads maio (fresh)", optional: true },
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

/**
 * Idempotência: nomes planejados que JÁ existem no Brevo. Re-rodar --execute
 * sem isso criaria listas duplicadas (Brevo permite nomes iguais), e o editor
 * poderia mandar pra lista errada / em dobro.
 */
export function findExistingConflicts(
  plannedNames: string[],
  existing: { id: number; name: string }[],
): { name: string; id: number }[] {
  const byName = new Map(existing.map((l) => [l.name, l.id]));
  const out: { name: string; id: number }[] = [];
  for (const n of plannedNames) {
    const id = byName.get(n);
    if (id !== undefined) out.push({ name: n, id });
  }
  return out;
}

// #2018: fetchExistingLists triplicada → lib/brevo-client.brevoListAllLists.
// Alias local pra manter a chamada interna legível sem renomear os call-sites.
const fetchExistingLists = brevoListAllLists;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  execute: boolean;
  label: string;
  folderId: number;
  cycle: string;
}

export function parseArgs(argv: string[]): Args {
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    // Não engole a flag seguinte: `--label --execute` não pode virar label="--execute"
    // (criaria listas "Clarice --execute …" em produção e ainda executaria).
    return v && !v.startsWith("--") ? v : undefined;
  };
  const folder = parseInt(get("--folder-id") ?? "1", 10);
  // #1961: lê as waves do ciclo em {conteúdo}-{envio}/waves/. OBRIGATÓRIO (sem
  // default): parseCycleArg devolve "" quando ausente/inválido; main aborta.
  const cycle = parseCycleArg(argv);
  return {
    execute: argv.includes("--execute"),
    label: get("--label") ?? "edição atual",
    folderId: Number.isFinite(folder) && folder > 0 ? folder : 1,
    cycle,
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

// `wavesDir` é injetável pra teste (default = dir do ciclo). #provenance
export function buildPlan(label: string, cycle: string, wavesDir: string = clariceWavesDir(cycle)): Plan[] {
  const plans: Plan[] = [];
  for (const wave of WAVES) {
    const path = resolve(wavesDir, wave.file);
    if (!existsSync(path)) {
      // Opcional (ex: W5 maio) ausente → pula com aviso. Obrigatória ausente →
      // erro (build-waves falhou; não importar parcial sem o editor saber).
      if (wave.optional) {
        console.error(`ℹ️  wave opcional ausente, pulando: ${wave.key} (${wave.file})`);
        continue;
      }
      throw new Error(`wave faltando: ${path} — rode 'clarice-build-waves.ts --cycle ${cycle}' antes.`);
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
  if (!args.cycle) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2605-06).");
    process.exit(1);
  }
  const plans = buildPlan(args.label, args.cycle);

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

  // Pré-flight de idempotência: recusa se alguma lista planejada já existe.
  const conflicts = findExistingConflicts(
    plans.map((p) => p.listName),
    await fetchExistingLists(apiKey),
  );
  if (conflicts.length) {
    console.error(`\n❌ ${conflicts.length} lista(s) com esses nomes JÁ existem no Brevo:`);
    for (const c of conflicts) console.error(`   #${c.id} "${c.name}"`);
    console.error(
      `Re-importar criaria duplicatas (Brevo permite nomes iguais). Delete-as no Brevo, ` +
        `ou use --label diferente.`,
    );
    process.exit(1);
  }

  const results: { wave: string; listId: number; processId: unknown; count: number }[] = [];
  try {
    for (const p of plans) {
      console.error(`\n→ ${p.wave.key}: criando lista "${p.listName}"…`);
      const list = (await brevoPost(apiKey, "/contacts/lists", {
        name: p.listName,
        folderId: args.folderId,
      })) as { id?: number };
      if (typeof list?.id !== "number") {
        throw new Error(`Brevo /contacts/lists retornou shape inesperado: ${JSON.stringify(list)}`);
      }
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
  } catch (e) {
    // Falha parcial: reporta as listas JÁ criadas pro editor limpar antes de re-rodar
    // (senão o pré-flight de idempotência barra o retry).
    if (results.length) {
      console.error(`\n⚠️  erro no meio — ${results.length} lista(s) JÁ criada(s), limpe antes de re-rodar:`);
      for (const r of results) console.error(`   #${r.listId} (${r.wave})`);
    }
    throw e;
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
