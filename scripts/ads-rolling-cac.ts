/**
 * scripts/ads-rolling-cac.ts (#7577)
 *
 * Imprime o CAC da janela móvel de 3 dias por braço do teste 2608, ao lado do
 * acumulado. É o passo que a task agendada `relatorio-diario-teste-2608` chama
 * em vez de refazer a conta em prosa toda manhã.
 *
 * Miolo puro (e o porquê de cada regra) em `scripts/lib/ads-rolling-window.ts`.
 *
 * ## Por que uma CLI, e não só a lib
 *
 * O relatório é escrito por um agente lendo um SKILL.md. Deixar a aritmética
 * para ele significa recalculá-la a cada manhã a partir da prosa — e a prosa
 * não trava a linha-base (o CSV é acumulado, então a janela é uma diferença,
 * não uma soma), nem o piso de amostra, nem a distinção entre "sem dado" e
 * "zero". Cada uma dessas já apareceu errada em relatório antes. Aqui elas são
 * determinísticas e testadas; o agente narra o resultado.
 *
 * Uso:
 *   npx tsx scripts/ads-rolling-cac.ts
 *   npx tsx scripts/ads-rolling-cac.ts --ate 2026-09-06 --dias 3
 *   npx tsx scripts/ads-rolling-cac.ts --json
 *
 * `--ate` default: ontem em BRT (o último dia FECHADO — o dia em curso nunca
 * entra, ver docstring da lib).
 *
 * Exit codes:
 *   0 — calculou (mesmo com braços não-comparáveis: isso é resultado, não erro)
 *   1 — CSV ausente, ilegível, ou com erro de parsing
 */
import { existsSync, readFileSync } from "node:fs";
import { parseClicksCsv } from "./lib/ads-test-watch.ts";
import {
  DEFAULT_WINDOW_DAYS,
  brtDateOf,
  computeRollingWindow,
  descreverEstabilidade,
  shiftDate,
  type EdicaoEmVoo,
  type RollingWindowResult,
} from "./lib/ads-rolling-window.ts";

const CLICKS_CSV = "data/aquisicao/clicks-2608.csv";
const EDICOES_JSONL = "data/aquisicao/teste-2608/edicoes.jsonl";
const RUN_STATE = "data/aquisicao/teste-2608/run-state.json";

function lerEdicoes(path: string): EdicaoEmVoo[] {
  if (!existsSync(path)) return [];
  const out: EdicaoEmVoo[] = [];
  for (const linha of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!linha.trim()) continue;
    try {
      out.push(JSON.parse(linha));
    } catch {
      // JSONL append-only escrito por várias sessões — uma linha truncada não
      // pode derrubar o relatório do dia. O efeito de ignorá-la é uma janela
      // marcada como mais estável do que é, nunca um número de CAC errado.
    }
  }
  return out;
}

function lerBracos(path: string, fallback: string[]): string[] {
  if (!existsSync(path)) return fallback;
  try {
    const st = JSON.parse(readFileSync(path, "utf8")) as { bracos?: string[] };
    return st.bracos?.length ? st.bracos : fallback;
  } catch {
    return fallback;
  }
}

function fmtBRL(v: number): string {
  return `R$ ${v.toFixed(2).replace(".", ",")}`;
}

function linhaTabela(r: RollingWindowResult): string {
  const cac = r.custoPorCadastro === null ? "—" : fmtBRL(r.custoPorCadastro);
  const acum = r.cadastrosAcumulado ?? 0;
  const cacAcum = acum > 0 ? fmtBRL(r.gastoAcumulado / acum) : "—";
  return (
    `${r.canal.padEnd(30)} ${fmtBRL(r.gastoJanela).padStart(11)} ${String(r.cadastrosJanela).padStart(4)} ` +
    `${cac.padStart(11)} | ${fmtBRL(r.gastoAcumulado).padStart(11)} ${String(acum).padStart(4)} ${cacAcum.padStart(11)}`
  );
}

export function main(argv = process.argv.slice(2)): number {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dias = Number(get("--dias") ?? DEFAULT_WINDOW_DAYS);
  // Default: ontem em BRT. O dia em curso nunca entra — gasto parcial sobre
  // cadastros parciais dá um CAC que varia com a hora da leitura.
  const ate = get("--ate") ?? shiftDate(brtDateOf(new Date()), -1);
  const csvPath = get("--csv") ?? CLICKS_CSV;

  if (!existsSync(csvPath)) {
    console.error(`[ads-rolling-cac] CSV ausente: ${csvPath}`);
    return 1;
  }
  const { rows, errors } = parseClicksCsv(readFileSync(csvPath, "utf8"));
  if (errors.length > 0) {
    // Nunca calcular sobre um CSV que não parseou inteiro: o parser engole
    // linhas em silêncio quando a quebra de linha não bate (CRLF vs LF), e o
    // resultado seria uma janela silenciosamente incompleta.
    console.error(`[ads-rolling-cac] ${errors.length} erro(s) de parsing em ${csvPath} — não é seguro calcular:`);
    for (const e of errors) console.error(`  linha ${e.line}: ${e.reason}`);
    return 1;
  }

  const bracos = lerBracos(RUN_STATE, [...new Set(rows.map((r) => r.canal))]);
  const edicoes = lerEdicoes(EDICOES_JSONL);
  const resultados = bracos.map((canal) => computeRollingWindow(rows, { canal, ate, dias, edicoes }));

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ ate, dias, resultados }, null, 2));
    return 0;
  }

  console.log(`Janela móvel de ${dias} dias (BRT), até ${ate} — último dia fechado.\n`);
  console.log(
    `${"braço".padEnd(30)} ${"gasto".padStart(11)} ${"cad".padStart(4)} ${"CAC".padStart(11)} | ` +
      `${"gasto acum".padStart(11)} ${"cad".padStart(4)} ${"CAC acum".padStart(11)}`,
  );
  for (const r of resultados) console.log(linhaTabela(r));

  console.log("");
  for (const r of resultados) {
    console.log(`${r.canal}: ${descreverEstabilidade(r)}`);
    if (!r.comparavel) console.log(`  fora da comparação — ${r.motivo}`);
  }

  const comparaveis = resultados.filter((r) => r.comparavel);
  if (comparaveis.length < 2) {
    console.log(
      `\nSem comparação possível: ${comparaveis.length} braço(s) atingem o piso de amostra. ` +
        `Reportar gasto e números absolutos, sem ranquear.`,
    );
  }
  return 0;
}

if (process.argv[1]?.endsWith("ads-rolling-cac.ts")) {
  process.exit(main());
}
