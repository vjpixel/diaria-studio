/**
 * hotmart-vendas-cruzamento.ts (#10734, item 4a)
 *
 * Relatório: quantas vendas da Hotmart casam com assinante do store unificado
 * (ativo ou ex-assinante), quantas vêm de fora da base, e a origem no store
 * dos compradores que casaram. Lê o espelho `data/hotmart/vendas.jsonl`
 * (`sync-hotmart-vendas.ts`) e o store `data/diaria-subscribers/diaria-subscribers.db`;
 * os e-mails do store são hasheados com a mesma função do Worker
 * (`scripts/lib/hotmart-vendas-cruzamento.ts`). Não grava venda nem e-mail em
 * lugar nenhum e não imprime e-mail nem hash (abrir o store roda as migrações
 * idempotentes de esquema de `openDiariaSubscribersDb`, como qualquer leitor).
 *
 * Uso:
 *   npx tsx scripts/hotmart-vendas-cruzamento.ts
 *   npx tsx scripts/hotmart-vendas-cruzamento.ts --de 2026-10-01 --ate 2026-10-31
 *   npx tsx scripts/hotmart-vendas-cruzamento.ts --json          # relatório completo, por venda
 *   npx tsx scripts/hotmart-vendas-cruzamento.ts --espelho X --db Y
 *
 * Saída: 0 = ok; 2 = espelho ou store ausente/ilegível.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import {
  DEFAULT_DB_PATH,
  getAllAliasesBySubscriber,
  getAllSubscriptionsBySubscriber,
  openDiariaSubscribersDbSafe,
  resolveSubscriberAttribution,
} from "./lib/diaria-subscribers-db.ts";
import { ESPELHO_REL_PATH, lerEspelho } from "./lib/hotmart-vendas-espelho.ts";
import {
  cruzarVendas,
  indexarAssinantesPorHash,
  type AssinanteStore,
  type RelatorioCruzamento,
} from "./lib/hotmart-vendas-cruzamento.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function formatarRelatorio(r: RelatorioCruzamento, periodo: string): string {
  const linhas = [`Vendas Hotmart × store de assinantes (${periodo}): ${r.totalEventos} evento(s)`, ""];
  linhas.push("Compras aprovadas, por situação do comprador:");
  for (const [s, v] of Object.entries(r.aprovadas)) linhas.push(`  ${s.padEnd(16)} ${v.eventos} compra(s), ${v.compradores} comprador(es)`);
  linhas.push("", "Todos os eventos (aprovada, cancelada, reembolsada, chargeback):");
  for (const [s, v] of Object.entries(r.todos)) linhas.push(`  ${s.padEnd(16)} ${v.eventos} evento(s)`);
  if (r.aprovadasPorOrigem.length) {
    linhas.push("", "Compras aprovadas de assinantes, por origem no store:");
    for (const o of r.aprovadasPorOrigem) linhas.push(`  ${o.origem}: ${o.eventos}`);
  }
  return linhas.join("\n");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const de = getStringArg(argv, "de", { example: "2026-10-01" });
  const ate = getStringArg(argv, "ate", { example: "2026-10-31" });
  for (const [k, v] of [["de", de], ["ate", ate]] as const) {
    if (v && !DAY_RE.test(v)) {
      console.error(`hotmart-vendas-cruzamento: --${k} deve ser AAAA-MM-DD, recebido "${v}".`);
      return 2;
    }
  }
  const espelhoPath = resolve(getStringArg(argv, "espelho") ?? join(ROOT, "data", ...ESPELHO_REL_PATH.split("/")));
  const dbPath = resolve(getStringArg(argv, "db") ?? DEFAULT_DB_PATH);

  if (!existsSync(espelhoPath)) {
    console.error(`hotmart-vendas-cruzamento: espelho ${espelhoPath} não existe (rode scripts/sync-hotmart-vendas.ts).`);
    return 2;
  }
  if (!existsSync(dbPath)) {
    console.error(`hotmart-vendas-cruzamento: store ${dbPath} não existe (data/ montado?).`);
    return 2;
  }
  const db = openDiariaSubscribersDbSafe(dbPath);
  if (!db) {
    console.error(`hotmart-vendas-cruzamento: não abriu o store ${dbPath}.`);
    return 2;
  }
  let assinantes: AssinanteStore[];
  try {
    const aliases = getAllAliasesBySubscriber(db);
    const subs = getAllSubscriptionsBySubscriber(db);
    assinantes = [...aliases.entries()].map(([subscriberId, lista]) => {
      const s = subs.get(subscriberId) ?? [];
      return {
        subscriberId,
        emails: lista.map((a) => a.email),
        ativo: s.some((x) => x.status === "active"),
        origem: resolveSubscriberAttribution(s).utmSource,
      };
    });
  } finally {
    db.close();
  }

  const { registros, invalidas } = lerEspelho(readFileSync(espelhoPath, "utf8"));
  const filtrados = registros.filter((r) => (!de || r.dia >= de) && (!ate || r.dia <= ate));
  const relatorio = cruzarVendas(filtrados, await indexarAssinantesPorHash(assinantes));

  if (hasFlag(argv, "json")) {
    console.log(JSON.stringify({ de: de ?? null, ate: ate ?? null, linhas_invalidas_no_espelho: invalidas, ...relatorio }, null, 2));
  } else {
    console.log(formatarRelatorio(relatorio, `${de ?? "início"} a ${ate ?? "hoje"}`));
    if (invalidas) console.log(`\nAviso: ${invalidas} linha(s) inválida(s) no espelho, ignoradas.`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  void runCli(main, {
    onError: (e) => console.error(`hotmart-vendas-cruzamento: ${e instanceof Error ? e.message : String(e)}`),
  });
}
