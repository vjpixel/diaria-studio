/**
 * scripts/channel-cohort-funnel.ts (#7918)
 *
 * Comparação de canais por coorte: cadastro aceito → confirmação → entrega
 * → engajamento (`primeiro-clique-14d`, `leitor-v1`), por período de
 * aquisição × origem/campanha/destino, mais custo por confirmado/leitor
 * quando gasto e população são da mesma coorte. Toda a regra vive em
 * `scripts/lib/metrics/channel-cohort-funnel.ts`; esta CLI só lê o store e o
 * CSV de gasto e imprime.
 *
 * COMPLEMENTA o relatório de 3 dias (`scripts/ads-rolling-cac.ts`), que segue
 * sendo a leitura operacional e não é tocado: o gasto aqui é a mesma
 * diferença de acumulados (`computeRollingWindow`), só que dividido pela
 * população da coorte em vez de pelo `cadastros_acumulado` do CSV.
 *
 * Leitura local apenas (SQLite + CSV) — nunca chama API de provedor.
 *
 * Uso:
 *   npx tsx scripts/channel-cohort-funnel.ts
 *   npx tsx scripts/channel-cohort-funnel.ts --granularidade dia --desde 2026-09-01
 *   npx tsx scripts/channel-cohort-funnel.ts --ate 2026-09-20 --dias 7 --json
 *   npx tsx scripts/channel-cohort-funnel.ts --sem-campanha --sem-destino
 *
 * Flags: `--db` (store), `--csv` (clicks-2608.csv), `--ate` (último dia
 * fechado da janela de custo, default ontem BRT), `--dias` (tamanho da
 * janela de custo, default 3 — a mesma do relatório de 3 dias), `--desde`
 * (corta coortes anteriores), `--granularidade dia|semana` (default semana).
 *
 * Exit codes: 0 calculou (estados `sem-dados`/`em-observacao` são resultado,
 * não erro); 1 uso inválido ou store ausente.
 */
import { existsSync, readFileSync } from "node:fs";
import { isMainModule } from "./lib/cli-args.ts";
import { DEFAULT_DB_PATH, openDiariaSubscribersDbSafe } from "./lib/diaria-subscribers-db.ts";
import { parseClicksCsv } from "./lib/ads-test-watch.ts";
import { DEFAULT_WINDOW_DAYS, brtDateOf, shiftDate } from "./lib/ads-rolling-window.ts";
import {
  buildChannelCohortFunnel,
  buildCohortSpendInputs,
  computeCohortCost,
  type CohortCostResult,
  type FunnelCohortRow,
  type FunnelRate,
} from "./lib/metrics/channel-cohort-funnel.ts";
import { loadFunnelInputFromStore } from "./lib/metrics/channel-cohort-funnel-store.ts";

const CLICKS_CSV = "data/aquisicao/clicks-2608.csv";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pct(r: FunnelRate): string {
  if (r.estado === "sem-dados") return "sem dados";
  if (r.estado === "nao-observavel") return "n/obs";
  if (r.taxa == null) return r.estado === "em-observacao" ? `obs. (n=${r.denominador ?? "—"})` : "—";
  const s = `${(r.taxa * 100).toFixed(0)}% (${r.numerador}/${r.denominador})`;
  return r.estado === "em-observacao" ? `${s}*` : s;
}

function brl(v: number | null): string {
  return v == null ? "—" : `R$ ${v.toFixed(2).replace(".", ",")}`;
}

function linha(r: FunnelCohortRow): string {
  const origem = [r.origem ?? "(sem atribuição)", r.campanha, r.destino].filter(Boolean).join(" / ");
  return (
    `${r.periodo} ${origem.slice(0, 42).padEnd(42)} ${r.segmento.padEnd(9)} ${String(r.cadastrosAceitos).padStart(4)} ` +
    `${pct(r.confirmacao).padStart(16)} ${pct(r.entrega).padStart(16)} ${pct(r.primeiroClique14d).padStart(16)} ` +
    `${pct(r.leitorV1).padStart(16)}${r.emObservacao ? "  em observação" : ""}`
  );
}

function linhaCusto(c: CohortCostResult): string {
  return (
    `${c.canal.padEnd(28)} ${c.de}..${c.ate} gasto ${brl(c.gasto)} · população ${c.populacao} · ` +
    `por cadastro ${brl(c.custoPorCadastro)} · por confirmado ${brl(c.custoPorConfirmado)}${c.custoPorConfirmadoQualidade === "teto" ? " (teto)" : ""} · por leitor ${brl(c.custoPorLeitor)}` +
    (c.motivo ? `\n    ${c.motivo}` : "")
  );
}

export function main(argv = process.argv.slice(2)): number {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const gran = get("--granularidade") ?? "semana";
  if (gran !== "dia" && gran !== "semana") {
    console.error(`[channel-cohort-funnel] --granularidade precisa ser dia|semana; recebi "${gran}".`);
    return 1;
  }
  const dias = Number(get("--dias") ?? DEFAULT_WINDOW_DAYS);
  if (!Number.isInteger(dias) || dias < 1) {
    console.error(`[channel-cohort-funnel] --dias precisa ser inteiro >= 1; recebi "${get("--dias")}".`);
    return 1;
  }
  const now = new Date();
  const ate = get("--ate") ?? shiftDate(brtDateOf(now), -1);
  const desde = get("--desde");
  for (const [flag, v] of [["--ate", ate], ["--desde", desde]] as const) {
    if (v != null && (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)))) {
      console.error(`[channel-cohort-funnel] ${flag} precisa ser AAAA-MM-DD válida; recebi "${v}".`);
      return 1;
    }
  }
  const dbPath = get("--db") ?? DEFAULT_DB_PATH;
  const csvPath = get("--csv") ?? CLICKS_CSV;

  const db = openDiariaSubscribersDbSafe(dbPath);
  if (!db) {
    console.error(`[channel-cohort-funnel] store indisponível em ${dbPath} — sem dados (não é zero).`);
    return 1;
  }
  let input;
  try {
    input = loadFunnelInputFromStore(db);
  } finally {
    db.close();
  }

  const report = buildChannelCohortFunnel(input.people, {
    now: now.toISOString(),
    granularidade: gran,
    porCampanha: !argv.includes("--sem-campanha"),
    porDestino: !argv.includes("--sem-destino"),
    fontes: input.fontes,
  });
  const rows = desde ? report.rows.filter((r) => r.periodo >= desde) : report.rows;

  const custos: CohortCostResult[] = [];
  const avisos: string[] = [];
  if (!existsSync(csvPath)) {
    avisos.push(`CSV de gasto ausente (${csvPath}) — custo por coorte indisponível.`);
  } else {
    const { rows: csvRows, errors } = parseClicksCsv(readFileSync(csvPath, "utf8"));
    if (errors.length > 0) {
      avisos.push(`${errors.length} erro(s) de parsing em ${csvPath} — custo por coorte não calculado.`);
    } else {
      for (const s of buildCohortSpendInputs(csvRows, { ate, dias, fonte: csvPath })) {
        if (!s.cobreUltimoDia) avisos.push(`${s.canal}: CSV não tem linha em ${ate} — gasto da janela pode estar incompleto.`);
        custos.push(computeCohortCost(input.people, s, { now: now.toISOString(), fontes: input.fontes }));
      }
    }
  }

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ...report, rows, custos, avisos }, null, 2));
    return 0;
  }
  const r = report.resumo;
  console.log(`Coortes por ${gran} (BRT) — gerado ${report.geradoEm}`);
  for (const [k, f] of Object.entries(report.fontes)) {
    console.log(`  fonte ${k}: ${f.fonte} · frescor ${f.frescor ?? "—"}${f.disponivel ? "" : ` · INDISPONÍVEL (${f.motivo})`}`);
  }
  console.log(
    `  pessoas ${r.pessoasRecebidas} · duplicatas fundidas ${r.duplicatasFundidas} · interno/teste ${r.internasOuTesteExcluidas} · sem e-mail ${r.semEmail} · ` +
      `sem data ${r.semDataDeCadastro} · sem atribuição ${r.semAtribuicao} · migrados ${r.migrados} · reativados ${r.reativados}`,
  );
  console.log("\nperíodo    origem / campanha / destino                segmento  cad.     confirmação          entrega       1º clique 14d        leitor-v1");
  for (const row of rows) console.log(linha(row));
  console.log("\n* = coorte em observação (contagem parcial). n/obs = não observável na fonte. — = nada a dividir.");
  console.log(`\nCusto por coorte (janela ${shiftDate(ate, -(dias - 1))}..${ate}, mesma população e janela):`);
  if (custos.length === 0) console.log("  (nenhum canal com gasto no CSV)");
  for (const c of custos) console.log(`  ${linhaCusto(c)}`);
  for (const a of avisos) console.warn(`[channel-cohort-funnel] ${a}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
