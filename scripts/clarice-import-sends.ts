#!/usr/bin/env node
/**
 * clarice-import-sends.ts (ciclo 2605-06 / Plano de Envio Edição Maio)
 *
 * Importa pro Brevo os 21 envios diários gerados por clarice-build-edition-sends.ts:
 * cria 1 lista por envio (dNN) e sobe os contatos do CSV correspondente. NÃO cria
 * campanhas — o agendamento depende do template/edição, que é uma etapa posterior.
 *
 * Listas rotuladas por NÚMERO do envio (dNN) + dia-da-semana PLANEJADO, não por
 * data de calendário — assim a importação é segura mesmo se a data de início
 * escorregar (a edição ainda pode não estar pronta). O agendamento real (depois)
 * é que fixa as datas.
 *
 * SEGURANÇA: dry-run por padrão. `--execute` cria listas + importa contatos na
 * conta de PRODUÇÃO da Clarice. Idempotente: recusa se alguma lista já existe.
 *
 * Uso:
 *   npx tsx scripts/clarice-import-sends.ts --cycle 2605-06 --label "Jun/2026"            # dry-run
 *   npx tsx scripts/clarice-import-sends.ts --cycle 2605-06 --label "Jun/2026" --execute  # cria + importa
 *   [--folder-id N]     folder Brevo (default 1)
 *   [--only 1,2,3]      importa só esses envios (default: todos os 21)
 *
 * Env: BREVO_CLARICE_API_KEY (só usado em --execute)
 * Inputs: data/clarice-subscribers/{ciclo}/sends/dNN-*.csv (colunas email,NOME,TIER)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { brevoPost } from "./lib/brevo-client.ts";
import { clariceCycleDir, parseCycleArg } from "./lib/clarice-paths.ts";
import { normalizeImportCsv, findExistingConflicts } from "./clarice-import-waves.ts";
import { SENDS } from "./clarice-build-edition-sends.ts";

loadProjectEnv();

type Row = Record<string, string>;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Nome determinístico da lista. Ex: "Clarice Jun/2026 d01 (qua)". dNN + dia
 *  PLANEJADO (sem data de calendário) → import independente do slip da edição. */
export function sendListName(n: number, day: string, label: string): string {
  return `Clarice ${label} d${String(n).padStart(2, "0")} (${day})`;
}

/**
 * Merge de `{n → listId}` no objeto `sends-summary.json`.
 *
 * Pure: recebe o objeto parsed e o mapa de resultados; devolve cópia com
 * `listId` injetado em cada entry cujo `n` consta nos resultados.
 * Cirúrgico: preserva todos os campos existentes de cada send (file, day, week, comp…).
 *
 * Exportado pra testabilidade (#633): o roundtrip import→summary→schedule
 * depende desta função; se ela for revertida, os testes de roundtrip quebram.
 */
export function mergeSendsSummaryWithListIds(
  summary: { sends: ({ n: number } & Record<string, unknown>)[] },
  results: { n: number; listId: number }[],
): { sends: ({ n: number } & Record<string, unknown>)[] } {
  const listIdByN = new Map(results.map((r) => [r.n, r.listId]));
  return {
    ...summary,
    sends: summary.sends.map((s) => ({
      ...s,
      ...(listIdByN.has(s.n) ? { listId: listIdByN.get(s.n) } : {}),
    })),
  };
}

/** Reduz o CSV do envio a email + NOME (descarta TIER — é metadado de análise
 *  local, não vira atributo Brevo) e normaliza o header de email -> EMAIL. */
export function toImportCsv(raw: string): { csv: string; count: number } {
  const parsed = Papa.parse<Row>(raw, { header: true, skipEmptyLines: true });
  const rows = parsed.data;
  const emailKey = (parsed.meta.fields ?? []).find((f) => /e-?mail/i.test(f.trim())) ?? "email";
  const data = rows.map((r) => ({ email: (r[emailKey] ?? "").trim(), NOME: r["NOME"] ?? "" }));
  const csv = normalizeImportCsv(Papa.unparse({ fields: ["email", "NOME"], data }));
  return { csv, count: data.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  execute: boolean;
  label: string;
  folderId: number;
  cycle: string;
  only: number[] | null;
}

export function parseArgs(argv: string[]): Args {
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    return v && !v.startsWith("--") ? v : undefined;
  };
  const folder = parseInt(get("--folder-id") ?? "1", 10);
  const onlyRaw = get("--only");
  const only = onlyRaw
    ? onlyRaw.split(",").map((x) => parseInt(x.trim(), 10)).filter((x) => Number.isFinite(x))
    : null;
  return {
    execute: argv.includes("--execute"),
    label: get("--label") ?? "Jun/2026",
    folderId: Number.isFinite(folder) && folder > 0 ? folder : 1,
    cycle: parseCycleArg(argv),
    only: only && only.length ? only : null,
  };
}

interface Plan {
  n: number;
  day: string;
  listName: string;
  count: number;
  csv: string;
}

export function buildPlan(label: string, cycle: string, only: number[] | null): Plan[] {
  const sendsDir = resolve(clariceCycleDir(cycle), "sends");
  const plans: Plan[] = [];
  for (const s of SENDS) {
    if (only && !only.includes(s.n)) continue;
    const file = `d${String(s.n).padStart(2, "0")}-${s.date}.csv`;
    const path = resolve(sendsDir, file);
    if (!existsSync(path)) {
      throw new Error(`envio faltando: ${path} — rode 'clarice-build-edition-sends.ts --cycle ${cycle}' antes.`);
    }
    const { csv, count } = toImportCsv(readFileSync(path, "utf-8"));
    plans.push({ n: s.n, day: s.day, listName: sendListName(s.n, s.day, label), count, csv });
  }
  return plans;
}

/** Lista todas as listas Brevo (paginado) — id + nome, pro check de duplicata. */
async function fetchExistingLists(apiKey: string): Promise<{ id: number; name: string }[]> {
  const out: { id: number; name: string }[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`https://api.brevo.com/v3/contacts/lists?limit=50&offset=${offset}`, {
      headers: { "api-key": apiKey, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Brevo GET /contacts/lists falhou (${res.status})`);
    const body = (await res.json()) as { lists?: { id: number; name: string }[] };
    const lists = body.lists ?? [];
    out.push(...lists.map((l) => ({ id: l.id, name: l.name })));
    if (lists.length < 50) break;
    offset += 50;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (!args.cycle) {
    console.error("--cycle {conteúdo}-{envio} é obrigatório (ex: --cycle 2605-06).");
    process.exit(1);
  }
  const plans = buildPlan(args.label, args.cycle, args.only);

  console.error(`\n📋 Import de envios — folder ${args.folderId} — modo ${args.execute ? "EXECUTE 🔴" : "DRY-RUN"}`);
  let total = 0;
  for (const p of plans) {
    console.error(`  d${String(p.n).padStart(2, "0")} (${p.day}): "${p.listName}"  (${p.count} contatos)`);
    total += p.count;
  }
  console.error(`  TOTAL: ${total} contatos em ${plans.length} listas`);

  if (!args.execute) {
    console.error(`\nℹ️  dry-run — nada criado. Re-rode com --execute pra criar listas + importar.`);
    console.log(JSON.stringify({ mode: "dry-run", folder_id: args.folderId, label: args.label, lists: plans.map((p) => ({ n: p.n, list: p.listName, count: p.count })), total }, null, 2));
    return;
  }

  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) {
    console.error("BREVO_CLARICE_API_KEY não definida (necessária pra --execute).");
    process.exit(1);
  }

  const conflicts = findExistingConflicts(plans.map((p) => p.listName), await fetchExistingLists(apiKey));
  if (conflicts.length) {
    console.error(`\n❌ ${conflicts.length} lista(s) com esses nomes JÁ existem no Brevo:`);
    for (const c of conflicts) console.error(`   #${c.id} "${c.name}"`);
    console.error(`Re-importar criaria duplicatas. Delete-as no Brevo ou use --label/--only diferente.`);
    process.exit(1);
  }

  const results: { n: number; listId: number; processId: unknown; count: number }[] = [];
  try {
    for (const p of plans) {
      console.error(`\n→ d${String(p.n).padStart(2, "0")}: criando lista "${p.listName}"…`);
      const list = (await brevoPost(apiKey, "/contacts/lists", { name: p.listName, folderId: args.folderId })) as { id?: number };
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
      results.push({ n: p.n, listId: list.id, processId: imp.processId, count: p.count });
    }
  } catch (e) {
    if (results.length) {
      console.error(`\n⚠️  erro no meio — ${results.length} lista(s) JÁ criada(s), limpe antes de re-rodar:`);
      for (const r of results) console.error(`   #${r.listId} (d${String(r.n).padStart(2, "0")})`);
    }
    throw e;
  }

  console.error(`\n✅ ${results.length} listas criadas + imports disparados (assíncronos na Brevo).`);

  // Persiste {n → listId} em sends-summary.json para que clarice-schedule-sends
  // possa ler os IDs Brevo das listas S2/S3 sem depender do stdout desta invocação.
  const summaryPath = resolve(clariceCycleDir(args.cycle), "sends", "sends-summary.json");
  if (existsSync(summaryPath)) {
    const rawSummary = readFileSync(summaryPath, "utf-8");
    let summary: { sends: ({ n: number } & Record<string, unknown>)[] };
    try {
      summary = JSON.parse(rawSummary);
    } catch (e) {
      throw new Error(`sends-summary.json corrompido (JSON inválido): ${summaryPath}\n${String(e)}`);
    }
    const merged = mergeSendsSummaryWithListIds(summary, results);
    writeFileAtomic(summaryPath, JSON.stringify(merged, null, 2));
    console.error(`↳ listId gravado em sends-summary.json para ${results.length} envio(s).`);
  } else {
    console.error(`⚠️  sends-summary.json não encontrado — listId não persistido. Rode clarice-build-edition-sends.ts antes.`);
  }

  console.log(JSON.stringify({ mode: "execute", folder_id: args.folderId, label: args.label, results }, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
