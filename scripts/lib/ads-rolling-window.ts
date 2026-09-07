/**
 * scripts/lib/ads-rolling-window.ts (#7577)
 *
 * Janela móvel de 3 dias do teste de canais pagos 2608.
 *
 * ## Por que existe
 *
 * O teste nasceu como "3 braços congelados por 15 dias, comparados no fim"
 * (§3.4 do `data/aquisicao/campanhas-260816/00-PROTOCOLO.md`). Em 07/09/2026 o
 * editor mudou o objetivo:
 *
 * > "meu objetivo com o teste abc é ir fazendo refinamentos nas 3 contas e
 * > comparar o custo de aquisição nos últimos 3 dias."
 *
 * Isso troca a unidade de leitura. O ACUMULADO desde o D0 passa a misturar
 * estados diferentes do mesmo braço — um canal recém-corrigido carrega para
 * sempre o custo do período em que estava quebrado, e o número nunca reflete
 * o que a conta faz HOJE. A janela móvel responde a pergunta que o editor
 * passou a fazer; o acumulado continua reportado ao lado, para as condições
 * de morte da §3.2, que seguem ancoradas nele.
 *
 * ## O CSV é acumulado, então a janela é uma DIFERENÇA
 *
 * `data/aquisicao/clicks-2608.csv` guarda `gasto_acumulado` e
 * `cadastros_acumulado` — valores que só crescem, reconciliados à mão todo dia
 * (§8.3). O gasto da janela é `último − linha imediatamente ANTERIOR à janela`,
 * nunca a soma de nada. Sem essa linha-base (braço que começou dentro da
 * janela), o acumulado do último dia JÁ é o total do período.
 *
 * ## Fuso: BRT, um só, dos dois lados (decisão desta issue)
 *
 * `clicks-2608.csv` é reconciliado em dias BRT — é o que o painel do Google e
 * o do Microsoft mostram (GMT-03:00), e é o dia que o editor enxerga. O
 * `created_at` do Kit vem em UTC, e contar cadastro por fronteira UTC desloca
 * ~3h de cadastros entre dias adjacentes: um cadastro das 22h de segunda em
 * BRT cai na terça em UTC. Numa janela de 3 dias isso é ruído sobre um
 * denominador pequeno.
 *
 * Hoje o número de cadastros vem da coluna `cadastros_acumulado`, reconciliada
 * à mão contra o painel do Kit — não de uma consulta à API. Se algum dia passar
 * a vir de `created_at` direto do Kit, a conversão é `brtDateOf`, nunca
 * `toISOString().slice(0,10)`: é aí que o deslocamento apareceria.
 *
 * ## O que este módulo deliberadamente NÃO faz
 *
 * Não ranqueia e não decide nada. Devolve os números e os motivos pelos quais
 * um braço não é comparável (`comparavel: false` + `motivo`); quem escreve o
 * relatório decide o texto. Mesma separação de responsabilidade do #5304, num
 * domínio diferente: quem mede não ranqueia.
 */
import type { ClicksCsvRow } from "./ads-test-watch.ts";

/**
 * BRT (America/Sao_Paulo) não tem horário de verão desde 2019 — offset fixo.
 *
 * O repo tem os dois padrões: `next-edition-date.ts` e `scheduled-task-status.ts`
 * convertem via `Intl` com `timeZone: "America/Sao_Paulo"` (sobrevive a uma
 * mudança futura de política de DST, que já mudou duas vezes por decreto);
 * `studio-metrics.ts` faz a mesma aritmética de offset fixo daqui. A escolha
 * aqui é a mais simples de propósito — só é preciso TRUNCAR para o dia, nunca
 * decompor hora/minuto —, mas é a menos durável das duas. Se a política mudar,
 * este é um dos lugares a corrigir.
 */
export const BRT_UTC_OFFSET_HOURS = -3;

/** Tamanho padrão da janela, em dias fechados. Decisão do editor (#7577). */
export const DEFAULT_WINDOW_DAYS = 3;

/**
 * Piso de amostra para um braço entrar em comparação.
 *
 * A §3.6 proibia ranquear com menos de 59 leitores-v1 na janela INTEIRA do
 * teste — gatilho que não se aplica a uma janela de 3 dias. O piso operacional
 * da Emenda 07/09: abaixo disto o braço reporta gasto e número absoluto, sem
 * CAC e sem posição. Não é "o pior canal"; é ausência de dado (§3.5).
 */
export const MIN_CADASTROS_PARA_COMPARAR = 3;

/** Dia BRT (`YYYY-MM-DD`) de um instante. Ver "Fuso" na docstring do módulo. */
export function brtDateOf(instant: Date | string): string {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  return new Date(d.getTime() + BRT_UTC_OFFSET_HOURS * 3600_000).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` − `n` dias. Puro, sem fuso: opera sobre a data civil. */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export interface RollingWindowResult {
  canal: string;
  /**
   * Datas BRT que TÊM linha de apuração dentro da janela — não o calendário da
   * janela.
   *
   * A distinção importa quando falta um dia no CSV (reconciliação manual, §8.3,
   * é um processo humano que escapa): a aritmética de gasto/cadastros continua
   * correta, porque é `último − linha anterior à janela` e independe de buracos
   * no meio; mas `dias.length` fica menor que `janelaDias`, e ler os dois como
   * sinônimos faz uma janela de 3 dias parecer de 1.
   */
  dias: string[];
  /** Tamanho pedido da janela, em dias de calendário. Compare com `dias.length`. */
  janelaDias: number;
  gastoJanela: number;
  cadastrosJanela: number;
  /**
   * `gastoJanela / cadastrosJanela`, ou `null` quando o braço não atinge
   * `MIN_CADASTROS_PARA_COMPARAR`.
   *
   * `null` significa **sem dado**, nunca "o pior" (§3.5) — a célula sai vazia
   * no relatório e o braço sai do ranking, em vez de ir para o fim dele.
   */
  custoPorCadastro: number | null;
  comparavel: boolean;
  /** Por que não é comparável. `null` quando é. */
  motivo: string | null;
  gastoAcumulado: number;
  cadastrosAcumulado: number | null;
  /**
   * Quantos dos dias da janela são POSTERIORES à última edição em voo deste
   * braço. Ver `contarDiasAposUltimaEdicao`.
   */
  diasAposUltimaEdicao: number | null;
  /** Data da última edição em voo do braço (BRT), se houve alguma. */
  ultimaEdicao: string | null;
}

/**
 * Registro mínimo de `data/aquisicao/teste-2608/edicoes.jsonl` que interessa
 * aqui. O arquivo tem muito mais campos; só estes dois importam para a janela.
 */
export interface EdicaoEmVoo {
  braco?: string;
  registrado_em_utc?: string;
  tipo?: string;
}

/**
 * Quantos dias da janela vieram DEPOIS da última edição em voo do braço.
 *
 * Todo refinamento pode reiniciar a fase de aprendizado do algoritmo (§3.4,
 * D5/#5524 — continua verdade mesmo com o congelamento revogado), e um braço
 * recém-editado tende a piorar antes de melhorar. Uma janela de 3 dias que
 * CRUZA uma edição não é estado estável e não deve ser lida como tal.
 *
 * Só conta `tipo: "edicao-em-voo"`: `investigacao` e `edicao-nao-executada`
 * registram que algo foi OLHADO ou TENTADO, não que a conta mudou — contá-las
 * marcaria como instável uma janela em que nada foi alterado.
 */
export function contarDiasAposUltimaEdicao(
  edicoes: EdicaoEmVoo[],
  canal: string,
  dias: string[],
): { diasApos: number | null; ultimaEdicao: string | null } {
  const datas = edicoes
    .filter((e) => e.braco === canal && e.tipo === "edicao-em-voo" && e.registrado_em_utc)
    .map((e) => brtDateOf(e.registrado_em_utc!))
    .sort();
  const ultimaEdicao = datas.at(-1) ?? null;
  if (!ultimaEdicao) return { diasApos: null, ultimaEdicao: null };
  return { diasApos: dias.filter((d) => d > ultimaEdicao).length, ultimaEdicao };
}

/**
 * Calcula a janela móvel de um braço.
 *
 * `ate` é o último dia FECHADO a considerar (BRT). O dia em curso nunca entra:
 * gasto parcial dividido por cadastros parciais produz um CAC que oscila com a
 * hora da leitura, não com a performance.
 */
export function computeRollingWindow(
  rows: ClicksCsvRow[],
  opts: { canal: string; ate: string; dias?: number; edicoes?: EdicaoEmVoo[] },
): RollingWindowResult {
  const dias = opts.dias ?? DEFAULT_WINDOW_DAYS;
  const doCanal = rows
    .filter((r) => r.canal === opts.canal && r.data_apuracao <= opts.ate)
    .sort((a, b) => a.data_apuracao.localeCompare(b.data_apuracao));

  const inicio = shiftDate(opts.ate, -(dias - 1));
  const naJanela = doCanal.filter((r) => r.data_apuracao >= inicio);
  // Linha-base: a última ANTES da janela. Ausente = o braço começou dentro
  // dela, e o acumulado do último dia já É o total do período.
  const base = doCanal.filter((r) => r.data_apuracao < inicio).at(-1);
  const ultima = naJanela.at(-1);

  const diasCobertos = naJanela.map((r) => r.data_apuracao);
  const { diasApos, ultimaEdicao } = contarDiasAposUltimaEdicao(opts.edicoes ?? [], opts.canal, diasCobertos);

  if (!ultima) {
    return {
      canal: opts.canal,
      dias: diasCobertos,
      janelaDias: dias,
      gastoJanela: 0,
      cadastrosJanela: 0,
      custoPorCadastro: null,
      comparavel: false,
      motivo: `sem nenhuma linha de apuração entre ${inicio} e ${opts.ate}`,
      gastoAcumulado: doCanal.at(-1)?.gasto_acumulado ?? 0,
      cadastrosAcumulado: doCanal.at(-1)?.cadastrosAcumulado ?? null,
      diasAposUltimaEdicao: diasApos,
      ultimaEdicao,
    };
  }

  const gastoJanela = ultima.gasto_acumulado - (base?.gasto_acumulado ?? 0);
  const cadUltima = ultima.cadastrosAcumulado;
  // `base` AUSENTE e `base` com a coluna VAZIA são coisas diferentes, e tratar
  // as duas como 0 foi o achado P0 do review desta PR:
  //
  //   - base ausente  → o braço começou dentro da janela; 0 é o valor certo.
  //   - base presente com a coluna vazia → a linha-base EXISTE e não sabemos
  //     seu acumulado. Usar 0 faz `cadUltima − 0` devolver o HISTÓRICO INTEIRO
  //     do braço como se tudo tivesse acontecido nos 3 dias — numerador
  //     inflado, CAC artificialmente barato, `comparavel: true` e nenhum
  //     aviso. É o pior formato de erro possível aqui: um número errado que
  //     parece certo e sustenta a decisão de continuar financiando um canal.
  //
  // O caso do ÚLTIMO dia vazio já era tratado; a assimetria era o bug.
  const baseSemCadastros = base !== undefined && base.cadastrosAcumulado == null;
  const cadBase = base?.cadastrosAcumulado ?? 0;
  // Cadastro só é calculável quando o ÚLTIMO dia tem a coluna preenchida. Sem
  // ela não há numerador — e reportar 0 seria afirmar "nenhum cadastro", que é
  // diferente de "não medido" (§3.5).
  const cadastrosJanela = cadUltima == null ? 0 : cadUltima - cadBase;

  // Acumulado que DIMINUI entre dois dias não é uma janela pequena — é dado
  // inconsistente. Já aconteceu neste dataset: em 07/09/2026 a mesma consulta
  // devolveu 47 cadastros para 05/09 onde no dia anterior tinha devolvido 48
  // (um contato saiu da base). Sem esta guarda, uma correção para baixo produz
  // `gastoJanela` ou `cadastrosJanela` negativo; um CAC negativo passa como
  // `comparavel: true` e é renderizado como "R$ -12,34", que num alinhamento à
  // direita se lê de relance como um número comum.
  const gastoCaiu = base !== undefined && ultima.gasto_acumulado < base.gasto_acumulado;
  const cadastrosCairam =
    base !== undefined && cadUltima != null && base.cadastrosAcumulado != null && cadUltima < base.cadastrosAcumulado;

  let comparavel = true;
  let motivo: string | null = null;
  if (gastoCaiu || cadastrosCairam) {
    comparavel = false;
    const qual = [gastoCaiu ? "gasto_acumulado" : null, cadastrosCairam ? "cadastros_acumulado" : null]
      .filter(Boolean)
      .join(" e ");
    motivo =
      `${qual} DIMINUIU entre ${base!.data_apuracao} e ${ultima.data_apuracao} — acumulado não pode cair. ` +
      `Correção manual ou reconciliação inconsistente; a janela não é calculável até o CSV ser conferido`;
  } else if (cadUltima == null) {
    comparavel = false;
    motivo = `coluna cadastros_acumulado vazia em ${ultima.data_apuracao} — sem numerador para o CAC`;
  } else if (baseSemCadastros) {
    comparavel = false;
    motivo =
      `coluna cadastros_acumulado vazia na linha-base (${base!.data_apuracao}) — sem denominador de partida. ` +
      `Descontar 0 reportaria o acumulado histórico do braço como se fosse da janela`;
  } else if (cadastrosJanela < MIN_CADASTROS_PARA_COMPARAR) {
    comparavel = false;
    motivo = `${cadastrosJanela} cadastro(s) na janela, abaixo do piso de ${MIN_CADASTROS_PARA_COMPARAR}`;
  }

  return {
    canal: opts.canal,
    dias: diasCobertos,
    janelaDias: dias,
    gastoJanela,
    cadastrosJanela,
    custoPorCadastro: comparavel && cadastrosJanela > 0 ? gastoJanela / cadastrosJanela : null,
    comparavel,
    motivo,
    gastoAcumulado: ultima.gasto_acumulado,
    cadastrosAcumulado: cadUltima ?? null,
    diasAposUltimaEdicao: diasApos,
    ultimaEdicao,
  };
}

/**
 * Frase pronta sobre a estabilidade da janela, para o relatório não ter que
 * re-derivar a regra em prosa toda vez (e não ter que lembrar dela).
 */
export function descreverEstabilidade(r: RollingWindowResult): string {
  const faltando = r.janelaDias - r.dias.length;
  const gap =
    faltando > 0
      ? ` (atenção: ${faltando} de ${r.janelaDias} dias sem linha de apuração — o CAC segue correto, mas a janela tem buraco)`
      : "";
  if (r.ultimaEdicao === null) return `janela sem edição em voo — estado estável${gap}`;
  if (r.diasAposUltimaEdicao === 0) {
    return `TODOS os ${r.dias.length} dias com apuração são anteriores ou iguais à última edição (${r.ultimaEdicao}) — não é estado estável${gap}`;
  }
  if (r.diasAposUltimaEdicao !== null && r.diasAposUltimaEdicao < r.dias.length) {
    return `${r.diasAposUltimaEdicao} de ${r.dias.length} dias com apuração são posteriores à última edição (${r.ultimaEdicao}) — janela cruza refinamento${gap}`;
  }
  return `todos os ${r.dias.length} dias com apuração são posteriores à última edição (${r.ultimaEdicao}) — estado estável${gap}`;
}
