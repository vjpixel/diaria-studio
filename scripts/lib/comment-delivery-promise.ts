/**
 * comment-delivery-promise.ts (#8681)
 *
 * Guard contra a "promessa" — decisão do editor. O repo NÃO tem nenhum
 * mecanismo que responda a comentários do Instagram (nem via API oficial,
 * nem via automação — e automação de resposta a comentário entraria na
 * proibição de risco de ToS do CLAUDE.md de qualquer forma). Uma legenda ou
 * CTA de override (`_internal/instagram-test.json`, ver
 * `instagram-test-override.ts`) que promete entregar algo (link, edição,
 * material) a quem comentar uma palavra fica sem cumprimento — ninguém do
 * lado do projeto lê nem responde esses comentários.
 *
 * Caso real que motivou (edição 260922): a legenda de teste dizia
 * "Quer receber o link da edição do dia? Siga @diar.ia.br e comente “quero”
 * neste post." — pedido de comentário + promessa de entrega, sem nenhum
 * mecanismo do lado do projeto pra cumprir.
 *
 * Detecção: heurística por padrões em pt-BR, não NLP. Dispara quando o
 * texto tem (a) um pedido de comentário/ação em comentário E (b) uma
 * promessa de ENTREGA de algo em troca (receber/mandar/enviar + link/
 * edição/material) — as duas condições precisam coexistir; um CTA neutro
 * pra comentar ("comente o que achou", "conta nos comentários") não tem a
 * promessa de entrega e passa livre.
 */

const COMMENT_ACTION_PATTERNS: RegExp[] = [
  /coment[ae](?:m|i)?\b/i, // comente, comenta, comentem, comentei
  /deixe\s+(?:um\s+)?coment[aá]rio/i,
  /deix[ae]\s+nos\s+coment[aá]rios/i,
  /nos\s+coment[aá]rios/i,
];

// Todos os padrões abaixo exigem que a promessa seja DIRIGIDA AO LEITOR
// ("te", "você", "pra você") OU que nomeie explicitamente o objeto de
// entrega (link/edição/material) — não basta "mando"/"envio" solto, que
// também aparece em contextos sem relação com o pedido de comentário (ex:
// "mando o resumo pro grupo", "envio a pauta pro pessoal do escritório",
// #8846 — 2ª correção do #8844, que ainda deixava "mando o"/"envio a"
// passarem sem leitor nenhum). "receber" sozinho (sem objeto de entrega
// nomeado) é promessa FRACA/ambígua e não dispara sozinho — só a forma
// forte "quer receber" (pergunta-gancho, #8846) conta.
const DELIVERY_PROMISE_PATTERNS: RegExp[] = [
  /te\s+mand[ao]/i,
  /te\s+envi[ao]/i,
  /vou\s+te\s+(?:mandar|enviar)/i,
  /(?:mando|envio|mandamos|enviamos)\s+(?:pra\s+voc[eê]|para\s+voc[eê])/i,
  /quer\s+receber/i,
  /link\s+da\s+edi[cç][aã]o/i,
  /edi[cç][aã]o\s+do\s+dia/i,
  /link\s+completo/i,
  /material\s+completo/i,
  /te\s+passo/i,
];

// Distância máxima (em palavras) entre o pedido de comentário e a promessa
// de entrega dentro do mesmo segmento pra contar como relacionados. Alto e
// generoso, só como sanidade (#8846) — o filtro real de "relacionados" já é
// exigir uma promessa FORTE (dirigida ao leitor, ou objeto de entrega
// nomeado, ou pergunta-gancho "quer receber"), não mais a distância entre os
// dois matches: um teto curto (10, #8844) deixava escapar a pergunta-gancho
// real ("Quer receber o link da edição do dia? Siga a gente ... e comente
// 'quero' aqui embaixo", #8846) só porque o CTA de seguir/ativar notificação
// no meio empurra o pedido de comentário pra mais de 10 palavras de
// distância — sem relação nenhuma com o #8844 original ("vou mandar pro
// grupo" + "Comenta", que já é descartado por não ter leitor, não pelo gap).
const MAX_WORD_GAP = 30;

export interface CommentDeliveryPromiseResult {
  promise: boolean;
  match?: string;
}

interface PatternMatch {
  index: number;
  length: number;
  text: string;
}

function findAllMatches(patterns: RegExp[], segment: string): PatternMatch[] {
  const out: PatternMatch[] = [];
  for (const re of patterns) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    const withGlobal = new RegExp(re.source, flags);
    for (const m of segment.matchAll(withGlobal)) {
      if (m.index === undefined) continue;
      out.push({ index: m.index, length: m[0].length, text: m[0] });
    }
  }
  return out;
}

/** Nº de palavras entre o fim do match que vem primeiro e o início do que vem depois. */
function wordGap(segment: string, a: PatternMatch, b: PatternMatch): number {
  const [first, second] = a.index <= b.index ? [a, b] : [b, a];
  const between = segment.slice(first.index + first.length, second.index);
  return between.split(/\s+/).filter(Boolean).length;
}

/**
 * Detecta, em pt-BR, um texto que pede comentário EM TROCA de uma entrega
 * (link/edição/material) dirigida ao leitor — algo que este projeto não tem
 * como cumprir. Pura: sem I/O, sem estado.
 *
 * Co-ocorrência é checada por SEGMENTO (split só em `.`/quebra de linha —
 * de propósito NÃO em `?`/`!`, que costumam separar a pergunta-gancho da
 * CTA dentro do MESMO pedido, como no caso real "Quer receber o link? ...
 * comente 'quero'"), não no texto inteiro — uma legenda pode legitimamente
 * ter uma frase de captação de newsletter ("receber a edição no e-mail")
 * seguida de outra frase com um CTA neutro de comentário ("comenta o que
 * achou"); sem essa restrição as duas se combinariam num falso positivo
 * (achado no code-review do PR do #8681).
 *
 * Dentro do MESMO segmento, co-ocorrência solta ainda não basta (#8844):
 * exige-se também que o par comentário+entrega mais próximo esteja a no
 * máximo `MAX_WORD_GAP` palavras de distância — pedido e promessa que
 * aparecem em pontos genuinamente distantes da mesma frase longa (ou que só
 * coincidem por acaso, como "vou mandar pro grupo" + "Comenta") não têm
 * relação real entre si.
 */
export function detectCommentDeliveryPromise(text: string | null | undefined): CommentDeliveryPromiseResult {
  if (!text || !text.trim()) return { promise: false };

  const sentences = text.split(/(?<=\.)\s+|\n+/).filter((s) => s.trim());
  // Fallback: se o split não separar nada (texto sem pontuação/quebra de
  // linha), trata o texto inteiro como 1 sentença — não deixa a checagem
  // vazia.
  const segments = sentences.length > 0 ? sentences : [text];

  for (const segment of segments) {
    const commentMatches = findAllMatches(COMMENT_ACTION_PATTERNS, segment);
    if (commentMatches.length === 0) continue;

    const deliveryMatches = findAllMatches(DELIVERY_PROMISE_PATTERNS, segment);
    if (deliveryMatches.length === 0) continue;

    let best: { gap: number; c: PatternMatch; d: PatternMatch } | null = null;
    for (const c of commentMatches) {
      for (const d of deliveryMatches) {
        const gap = wordGap(segment, c, d);
        if (!best || gap < best.gap) best = { gap, c, d };
      }
    }

    if (best && best.gap <= MAX_WORD_GAP) {
      return {
        promise: true,
        match: `"${best.c.text}" + "${best.d.text}"`,
      };
    }
  }

  return { promise: false };
}

/** Mensagem acionável padrão — usada tanto pelo invariante do Stage 4 quanto por publish-instagram.ts. */
export function commentDeliveryPromiseMessage(source: string, match: string | undefined): string {
  return (
    `${source} promete entregar algo (link/edição/material) a quem comentar ` +
    `(${match ?? "padrão de comentário + entrega"}) — o repo NÃO tem nenhum mecanismo que ` +
    `responda a comentários do Instagram (#8681). Corrigir: tirar a promessa de entrega da ` +
    `legenda/CTA (manter um CTA neutro, tipo "comenta o que achou"), ou — se a entrega for de ` +
    `fato desejada — abrir uma issue pedindo o mecanismo de resposta antes de publicar assim.`
  );
}
