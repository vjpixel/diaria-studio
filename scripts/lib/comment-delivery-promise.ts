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

const DELIVERY_PROMISE_PATTERNS: RegExp[] = [
  /receber/i,
  /te\s+mand[ao]/i,
  /te\s+envi[ao]/i,
  /vou\s+(?:te\s+)?(?:mandar|enviar)/i,
  /(?:mando|envio|mandamos|enviamos)\s+(?:o|a|pra|para|pro)/i,
  /link\s+da\s+edi[cç][aã]o/i,
  /edi[cç][aã]o\s+do\s+dia/i,
  /link\s+completo/i,
  /material\s+completo/i,
  /te\s+passo/i,
];

export interface CommentDeliveryPromiseResult {
  promise: boolean;
  match?: string;
}

/**
 * Detecta, em pt-BR, um texto que pede comentário EM TROCA de uma entrega
 * (link/edição/material) — algo que este projeto não tem como cumprir.
 * Pura: sem I/O, sem estado.
 *
 * Co-ocorrência é checada por SEGMENTO (split só em `.`/quebra de linha —
 * de propósito NÃO em `?`/`!`, que costumam separar a pergunta-gancho da
 * CTA dentro do MESMO pedido, como no caso real "Quer receber o link? ...
 * comente 'quero'"), não no texto inteiro — uma legenda pode legitimamente
 * ter uma frase de captação de newsletter ("receber a edição no e-mail")
 * seguida de outra frase com um CTA neutro de comentário ("comenta o que
 * achou"); sem essa restrição as duas se combinariam num falso positivo
 * (achado no code-review do PR do #8681).
 */
export function detectCommentDeliveryPromise(text: string | null | undefined): CommentDeliveryPromiseResult {
  if (!text || !text.trim()) return { promise: false };

  const sentences = text.split(/(?<=\.)\s+|\n+/).filter((s) => s.trim());
  // Fallback: se o split não separar nada (texto sem pontuação/quebra de
  // linha), trata o texto inteiro como 1 sentença — não deixa a checagem
  // vazia.
  const segments = sentences.length > 0 ? sentences : [text];

  for (const segment of segments) {
    const commentMatch = COMMENT_ACTION_PATTERNS.map((re) => segment.match(re)).find(
      (m): m is RegExpMatchArray => !!m,
    );
    if (!commentMatch) continue;

    const deliveryMatch = DELIVERY_PROMISE_PATTERNS.map((re) => segment.match(re)).find(
      (m): m is RegExpMatchArray => !!m,
    );
    if (!deliveryMatch) continue;

    return {
      promise: true,
      match: `"${commentMatch[0]}" + "${deliveryMatch[0]}"`,
    };
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
