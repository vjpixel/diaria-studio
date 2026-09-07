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
  const ignoradas: string[] = [];
  for (const linha of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!linha.trim()) continue;
    try {
      out.push(JSON.parse(linha));
    } catch {
      // JSONL append-only escrito por várias sessões — uma linha truncada não
      // pode derrubar o relatório do dia, e nenhum número de CAC depende dela.
      // Mas o efeito de ignorá-la NÃO é inofensivo: se a única edição em voo
      // de um braço estiver na linha perdida, `descreverEstabilidade` afirma
      // "janela sem edição em voo — estado estável" — o oposto da verdade,
      // sobre a frase que diz ao editor se pode confiar na comparação. Por
      // isso é fail-soft, mas nunca silenciosa.
      ignoradas.push(linha.slice(0, 100));
    }
  }
  for (const l of ignoradas) {
    console.warn(`[ads-rolling-cac] linha ilegível em ${path}, ignorada: ${l}`);
  }
  if (ignoradas.length > 0) {
    console.warn(
      `[ads-rolling-cac] ${ignoradas.length} linha(s) de edições ilegível(is) — a frase de estabilidade ` +
        `pode subestimar refinamentos recentes.`,
    );
  }
  return out;
}

/**
 * Lista de braços do relatório.
 *
 * O fallback são os canais DERIVADOS do CSV, e por isso as duas causas de
 * "não consegui ler o run-state" não podem ser tratadas igual: arquivo ausente
 * é benigno, arquivo presente e ilegível é corrupção — e nesse segundo caso um
 * braço registrado que ainda não tem nenhuma linha no CSV (recém-ligado, ou
 * com o feed de gasto quebrado) simplesmente NÃO APARECERIA no relatório, sem
 * nenhuma linha dizendo que sumiu. Some em silêncio é pior que aparecer vazio.
 */
function lerBracos(path: string, fallback: string[]): string[] {
  if (!existsSync(path)) {
    console.warn(`[ads-rolling-cac] ${path} ausente — usando os braços presentes no CSV.`);
    return fallback;
  }
  try {
    const st = JSON.parse(readFileSync(path, "utf8")) as { bracos?: string[] };
    if (st.bracos?.length) return st.bracos;
    console.error(`[ads-rolling-cac] ${path} não declara \`bracos\` — usando os presentes no CSV. Conferir o arquivo.`);
    return fallback;
  } catch (e) {
    console.error(
      `[ads-rolling-cac] ${path} ilegível (${e instanceof Error ? e.message : e}) — usando os braços presentes no ` +
        `CSV. Um braço registrado e ainda sem linha no CSV NÃO aparecerá no relatório até isto ser corrigido.`,
    );
    return fallback;
  }
}

function fmtBRL(v: number): string {
  return `R$ ${v.toFixed(2).replace(".", ",")}`;
}

/**
 * Uma linha da tabela.
 *
 * `null` NUNCA é renderizado como `0` (§3.5): "não medido" e "zero cadastros"
 * exigem ações opostas do editor, e num alinhamento à direita os dois se leem
 * igual. Coluna sem dado sai como `—`, do mesmo jeito que a de CAC.
 */
function linhaTabela(r: RollingWindowResult): string {
  const cac = r.custoPorCadastro === null ? "—" : fmtBRL(r.custoPorCadastro);
  const acum = r.cadastrosAcumulado;
  const cacAcum = acum != null && acum > 0 ? fmtBRL(r.gastoAcumulado / acum) : "—";
  // Sem numerador conhecido, `cadastrosJanela` é 0 por construção — mostrar
  // esse 0 afirmaria "nenhum cadastro na janela", que não foi medido.
  const cadJanela = r.cadastrosAcumulado == null ? "—" : String(r.cadastrosJanela);
  return (
    `${r.canal.padEnd(30)} ${fmtBRL(r.gastoJanela).padStart(11)} ${cadJanela.padStart(4)} ` +
    `${cac.padStart(11)} | ${fmtBRL(r.gastoAcumulado).padStart(11)} ${(acum == null ? "—" : String(acum)).padStart(4)} ${cacAcum.padStart(11)}`
  );
}

export function main(argv = process.argv.slice(2)): number {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  // `Number("abc")` é NaN, e NaN atravessa `shiftDate` até `toISOString`
  // lançar `RangeError` — um typo de flag viraria stack trace em vez de um
  // exit code do contrato documentado, num script que roda desassistido.
  const dias = Number(get("--dias") ?? DEFAULT_WINDOW_DAYS);
  if (!Number.isInteger(dias) || dias < 1) {
    console.error(`[ads-rolling-cac] --dias precisa ser inteiro >= 1; recebi "${get("--dias")}".`);
    return 1;
  }
  // Default: ontem em BRT. O dia em curso nunca entra — gasto parcial sobre
  // cadastros parciais dá um CAC que varia com a hora da leitura.
  const ate = get("--ate") ?? shiftDate(brtDateOf(new Date()), -1);
  // `ate` entra em comparação de STRING contra `data_apuracao`. Um formato
  // diferente não lança: compara errado e devolve uma janela silenciosamente
  // vazia ou torta — pior que um erro.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ate) || Number.isNaN(Date.parse(`${ate}T00:00:00Z`))) {
    console.error(`[ads-rolling-cac] --ate precisa ser uma data AAAA-MM-DD válida; recebi "${ate}".`);
    return 1;
  }
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
    // `comparacaoPossivel` no topo em vez de deixar cada consumidor
    // re-derivar de `resultados[].comparavel` — é a mesma disciplina de não
    // reconstruir um julgamento a partir de saída ad-hoc.
    const comparacaoPossivel = resultados.filter((r) => r.comparavel).length >= 2;
    console.log(JSON.stringify({ ate, dias, comparacaoPossivel, resultados }, null, 2));
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
