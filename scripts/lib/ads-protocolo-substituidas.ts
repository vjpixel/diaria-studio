/**
 * scripts/lib/ads-protocolo-substituidas.ts (#8396)
 *
 * Detector puro de **regra morta que continua legível como se fosse vigente**
 * no `data/aquisicao/campanhas-260816/00-PROTOCOLO.md`.
 *
 * O incidente: o §3.4 ("congelamento operacional durante os 15 dias") foi
 * substituído pela Emenda 07/09/2026 — o regime vigente é o OPOSTO
 * (refinamento iterativo, edição em voo permitida). Mas o aviso de
 * substituição tinha 1 linha e o corpo proibitivo inteiro continuava abaixo
 * dele, com a emenda ~900 linhas adiante. Quem lê o protocolo por seção
 * (`grep 3.4`) chega na regra morta, não na viva — e foi o que fez um agente
 * responder ao editor "não aplique, o protocolo congela edição durante a
 * janela".
 *
 * Miolo separado da CLI/teste de propósito: o arquivo alvo vive em `data/`
 * (junction do OneDrive, ausente em clone fresco e no CI), então o teste que
 * o lê precisa degradar para skip — e sem uma função pura o CI não exercitaria
 * a lógica de detecção em NENHUM cenário. Com ela, o CI roda contra fixtures e
 * a máquina do editor roda também contra o arquivo real.
 */

/** Uma seção que declara substituição mas mantém corpo de prosa abaixo. */
export type SecaoComTextoMorto = {
  /** Linha do cabeçalho, 1-based (como um editor mostra). */
  linha: number;
  /** O cabeçalho, sem os `#`. */
  titulo: string;
  /** Quantas linhas de prosa viva sobraram abaixo do aviso. */
  linhasVivas: number;
  /** A primeira delas, para nomear o que remover. */
  primeiraLinhaViva: string;
};

/**
 * Quantas linhas de prosa são toleradas abaixo do aviso antes do próximo
 * cabeçalho. Um ponteiro honesto ("substituído por X; o que sobrevive é Y;
 * texto original em Z") cabe folgado dentro do próprio aviso; o corpo
 * proibitivo original do §3.4 tinha 7 linhas de parágrafo denso.
 */
export const MAX_LINHAS_APOS_AVISO = 3;

/**
 * Qualquer nível de cabeçalho delimita seção, `#` inclusive. O arquivo usa
 * `##`/`###` para as seções e `#` só no título, mas fechar em `{2,4}` faria o
 * corpo de uma seção vazar por cima de um `#` ou `#####` futuro e contar
 * linhas que não são dela (review da #8396, finding 6).
 */
const isCabecalho = (linha: string): boolean => /^#{1,6} /.test(linha);

/**
 * O aviso é, por convenção, a PRIMEIRA coisa do corpo e vem como citação
 * (`>`). Exigir as duas coisas — e não "a palavra aparece em algum lugar da
 * seção" — evita dois falsos positivos reais deste arquivo: uma emenda que
 * menciona em prosa a seção que ela substitui, e uma célula de tabela que usa
 * a palavra no meio de outro assunto. Nenhuma das duas é regra morta com
 * corpo vivo.
 */
const abreComAvisoDeSubstituicao = (corpo: readonly string[]): boolean => {
  const primeira = corpo.find((l) => l.trim() !== "");
  if (primeira === undefined) return false;
  return primeira.trimStart().startsWith(">") && /SUBSTITU[IÍ]D/i.test(primeira);
};

/**
 * Linha "viva" = prosa que um leitor da seção toma como regra. Linha em
 * branco e linha de citação ficam de fora: o aviso pode ser tão longo quanto
 * precisar, desde que seja aviso — é o texto FORA da citação que volta a
 * parecer regra vigente.
 *
 * "Linha de citação" inclui a **continuação preguiçosa** do Markdown: uma
 * linha sem `>` logo abaixo de uma linha com `>`, sem linha em branco entre
 * elas, ainda pertence ao blockquote. Contá-la como viva acusaria um aviso
 * escrito nesse estilo (review da #8396, finding 2) — falso positivo que
 * gastaria o crédito do guard à toa. A linha em branco fecha a citação, que é
 * como o Markdown de fato funciona.
 */
const linhasVivas = (corpo: readonly string[]): string[] => {
  const vivas: string[] = [];
  let dentroDeCitacao = false;

  for (const linha of corpo) {
    if (linha.trim() === "") {
      dentroDeCitacao = false;
      continue;
    }
    if (linha.trimStart().startsWith(">")) {
      dentroDeCitacao = true;
      continue;
    }
    if (dentroDeCitacao) continue;
    vivas.push(linha);
  }

  return vivas;
};

/** Seções que declaram substituição e ainda assim mantêm corpo legível. */
export function findSecoesSubstituidasComTextoMorto(
  markdown: string,
  maxLinhas: number = MAX_LINHAS_APOS_AVISO,
): SecaoComTextoMorto[] {
  const linhas = markdown.split("\n");
  const achados: SecaoComTextoMorto[] = [];

  for (let i = 0; i < linhas.length; i++) {
    if (!isCabecalho(linhas[i])) continue;

    const proximo = linhas.findIndex((l, j) => j > i && isCabecalho(l));
    const corpo = linhas.slice(i + 1, proximo === -1 ? linhas.length : proximo);
    if (!abreComAvisoDeSubstituicao(corpo)) continue;

    const vivas = linhasVivas(corpo);
    if (vivas.length <= maxLinhas) continue;

    achados.push({
      linha: i + 1,
      titulo: linhas[i].replace(/^#+\s*/, "").trim(),
      linhasVivas: vivas.length,
      primeiraLinhaViva: vivas[0].trim(),
    });
  }

  return achados;
}
