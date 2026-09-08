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
 *   npx tsx scripts/ads-rolling-cac.ts --csv ... --run-state ... --edicoes ...
 *
 * `--ate` default: ontem em BRT (o último dia FECHADO — o dia em curso nunca
 * entra, ver docstring da lib).
 *
 * Exit codes:
 *   0 — calculou (mesmo com braços não-comparáveis: isso é resultado, não erro)
 *   1 — uso inválido (--dias/--ate), CSV ausente ou com erro de parsing, ou
 *       algum braço sem linha de apuração no último dia da janela
 */
import { existsSync, readFileSync } from "node:fs";
import { findMissingClicksBracosForDate, parseClicksCsv } from "./lib/ads-test-watch.ts";
import {
  DEFAULT_WINDOW_DAYS,
  brtDateOf,
  computeDailyCacSeries,
  computeRollingWindow,
  descreverEstabilidade,
  shiftDate,
  type DailyCac,
  type EdicaoEmVoo,
  type RollingWindowResult,
} from "./lib/ads-rolling-window.ts";

const CLICKS_CSV = "data/aquisicao/clicks-2608.csv";
const EDICOES_JSONL = "data/aquisicao/teste-2608/edicoes.jsonl";
const RUN_STATE = "data/aquisicao/teste-2608/run-state.json";

/**
 * Quantos dias fechados isolados entram na tabela, além da janela.
 *
 * 2 = ontem e anteontem, o pedido literal do editor (08/09/2026). Não é uma
 * série de tendência: são os dois dias que ele consegue amarrar de cabeça às
 * edições que fez, e mais colunas empurrariam a janela — que segue sendo a
 * métrica de decisão — para fora do campo de visão.
 */
const DIAS_CAC_DIARIO = 2;

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
function linhaTabela(r: RollingWindowResult, diarios: DailyCac[]): string {
  const cac = r.custoPorCadastro === null ? "—" : fmtBRL(r.custoPorCadastro);
  const acum = r.cadastrosAcumulado;
  const cacAcum = acum != null && acum > 0 ? fmtBRL(r.gastoAcumulado / acum) : "—";
  // Sem numerador conhecido, `cadastrosJanela` é 0 por construção — mostrar
  // esse 0 afirmaria "nenhum cadastro na janela", que não foi medido.
  const cadJanela = r.cadastrosAcumulado == null ? "—" : String(r.cadastrosJanela);
  const cols = diarios
    .map((d) => (d.custoPorCadastro === null ? "—" : fmtBRL(d.custoPorCadastro)).padStart(11))
    .join(" ");
  return (
    `${r.canal.padEnd(28)} ${cols} | ${fmtBRL(r.gastoJanela).padStart(11)} ${cadJanela.padStart(4)} ` +
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
  // `--run-state`/`--edicoes` existem pela mesma razão que `--csv`: sem elas o
  // guard de cobertura abaixo leria a lista de braços de PRODUÇÃO mesmo com o
  // CSV apontado para outro lugar, e nenhum teste da CLI seria hermético.
  const runStatePath = get("--run-state") ?? RUN_STATE;
  const edicoesPath = get("--edicoes") ?? EDICOES_JSONL;

  if (!existsSync(csvPath)) {
    console.error(`[ads-rolling-cac] CSV ausente: ${csvPath}`);
    return 1;
  }
  const { rows, errors } = parseClicksCsv(readFileSync(csvPath, "utf8"));
  if (errors.length > 0) {
    // Erro de validação de campo numa linha que PARSEOU. Não calcular sobre um
    // CSV parcialmente inválido.
    console.error(`[ads-rolling-cac] ${errors.length} erro(s) de parsing em ${csvPath} — não é seguro calcular:`);
    for (const e of errors) console.error(`  linha ${e.line}: ${e.reason}`);
    return 1;
  }

  const bracos = lerBracos(runStatePath, [...new Set(rows.map((r) => r.canal))]);

  // Cobertura do último dia — e este guard NÃO é redundante com o de cima.
  //
  // O incidente de 07/09/2026 (memória `clicks-2608-csv-e-crlf`) foi: linhas
  // anexadas com LF num arquivo CRLF sumiram do parse e `errors[]` veio VAZIO.
  // A última coluna (`fonte`) é texto livre entre aspas, e uma quebra de linha
  // solta dentro de um campo citado é conteúdo, não fim de linha — as linhas seguintes são
  // engolidas pelo campo da anterior e nunca chegam a existir como linha, então
  // nunca chegam à validação que alimenta `errors[]`. O guard acima é cego
  // para isso por construção.
  //
  // O que dá para checar é COBERTURA: se um braço registrado não tem linha no
  // último dia da janela, ou a apuração daquele dia não rodou para ele, ou a
  // linha foi engolida. Nos dois casos a janela sai errada e é melhor parar.
  const faltando = findMissingClicksBracosForDate(rows, bracos, ate as never);
  if (faltando.length > 0) {
    console.error(
      `[ads-rolling-cac] sem linha de apuração em ${ate} para: ${faltando.join(", ")}. ` +
        `Ou a apuração do dia não rodou para esse(s) braço(s), ou a linha foi engolida pelo parser ` +
        `(quebra de linha LF num arquivo CRLF some sem erro — ver clicks-2608-csv-e-crlf). ` +
        `Conferir o CSV antes de confiar na janela.`,
    );
    return 1;
  }
  const edicoes = lerEdicoes(edicoesPath);
  const resultados = bracos.map((canal) => computeRollingWindow(rows, { canal, ate, dias, edicoes }));
  // CAC por dia fechado, pedido do editor em 08/09/2026: a média de 3 dias
  // dilui o efeito de um refinamento feito ontem, e é justamente esse efeito
  // que o editor precisa ver quando está editando as contas todo dia.
  const diarios = new Map(
    bracos.map((canal) => [canal, computeDailyCacSeries(rows, { canal, ate, n: DIAS_CAC_DIARIO })]),
  );

  if (argv.includes("--json")) {
    // `comparacaoPossivel` no topo em vez de deixar cada consumidor
    // re-derivar de `resultados[].comparavel` — é a mesma disciplina de não
    // reconstruir um julgamento a partir de saída ad-hoc.
    const comparacaoPossivel = resultados.filter((r) => r.comparavel).length >= 2;
    const comDiarios = resultados.map((r) => ({ ...r, diarios: diarios.get(r.canal) ?? [] }));
    console.log(JSON.stringify({ ate, dias, comparacaoPossivel, resultados: comDiarios }, null, 2));
    return 0;
  }

  console.log(`Janela móvel de ${dias} dias (BRT), até ${ate} — último dia fechado.\n`);
  const diasSerie = Array.from({ length: DIAS_CAC_DIARIO }, (_, i) => shiftDate(ate, -(DIAS_CAC_DIARIO - 1 - i)));
  console.log(
    `${"braço".padEnd(28)} ${diasSerie.map((d) => `CAC ${d.slice(5)}`.padStart(11)).join(" ")} | ` +
      `${"gasto".padStart(11)} ${"cad".padStart(4)} ${"CAC".padStart(11)} | ` +
      `${"gasto acum".padStart(11)} ${"cad".padStart(4)} ${"CAC acum".padStart(11)}`,
  );
  for (const r of resultados) console.log(linhaTabela(r, diarios.get(r.canal) ?? []));

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
