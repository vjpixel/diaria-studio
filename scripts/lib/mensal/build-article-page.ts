/**
 * build-article-page.ts (#3940)
 *
 * Constrói o HTML público do artigo mensal — servido pelo worker
 * `artigo-mensal` atrás do paywall de apoiador R$10+/mês (ver
 * `workers/artigo-mensal/`) — a partir do `draft.md` do ciclo.
 *
 * PURO: reusa o MESMO pipeline de render já testado do envio Brevo mensal
 * (`draftToEmail`, `monthly-render.ts`) — o artigo público e o e-mail
 * mensal compartilham a MESMA renderização de seções (DESTAQUE, INTRO,
 * PARA ENCERRAR etc.), sem duplicar lógica de parsing de markdown.
 * `draftToEmail` já devolve o documento HTML COMPLETO (`wrapEmail` é
 * chamado internamente) — nenhum wrap adicional é feito aqui.
 *
 * O que diverge entre o HTML do e-mail e o da web são três coisas, todas
 * consequência de reaproveitar um render de e-mail numa página (#7580):
 *
 *   1. `stripEmailOnlyFooter` — tira o rodapé de descadastro, que carrega
 *      `{{ unsubscribe }}`: o provedor resolve no envio, na web ninguém resolve.
 *   2. `stripReplyByEmailSentence` — tira "responda a este e-mail", que não faz
 *      sentido para quem abriu uma página, preservando o link de cadastro que
 *      divide o mesmo parágrafo.
 *   3. `retagWebUtmMedium` — troca `utm_medium=email` por `artigo-web`, senão
 *      o clique na página é contado como clique de e-mail.
 *
 * `verifyNoMergeTagsInArticle` fecha, recusando qualquer tag remanescente. As
 * três vivem no caminho de RENDER, então valem para os ciclos existentes e para
 * todos os futuros, sem passo manual por ciclo. O caminho de e-mail não passa
 * por nenhuma delas.
 *
 * Sem imagens geradas (destaqueImageUrls/eiaImageUrl*) nesta 1ª versão —
 * `renderDestaque`/`renderEia` toleram `undefined` (renderizam sem `<img>`).
 * Plugar as imagens reais do ciclo é fast-follow explícito (ver PR #3940) —
 * o dado (URLs já hospedadas no KV do worker `poll`/`draft` por
 * `monthly-image-upload.ts`) existe, só não foi plugado nesta unidade por
 * escopo.
 */
import { cycleToYymm, isValidMonthlyCycle } from "./monthly-paths.ts";
import { draftToEmail } from "./monthly-render.ts";

/**
 * Erro do guard de merge tag na versão WEB do artigo (#7580).
 *
 * Gêmeo de `UnresolvedMergeTagError` (`site-archive-pages.ts`, #6210), que faz
 * o mesmo pelas páginas de edição. Aqui a origem é outra — não é a Beehiiv
 * deixando tag crua, é o render de E-MAIL sendo reaproveitado para a web — mas
 * a consequência é idêntica: a página publica o template como texto.
 */
export class UnresolvedMergeTagInArticleError extends Error {
  constructor(
    readonly cycle: string,
    readonly tags: string[],
  ) {
    super(
      `artigo do ciclo "${cycle}" contém merge tag não resolvida no HTML web: ${tags.join(", ")}. ` +
        `O render vem de \`draftToEmail\`, então toda tag que o provedor de e-mail resolveria precisa ser ` +
        `tratada em \`stripEmailOnlyFooter\` antes de publicar — na web ninguém as resolve.`,
    );
    this.name = "UnresolvedMergeTagInArticleError";
  }
}

/**
 * Remove do HTML os parágrafos que só fazem sentido por e-mail.
 *
 * Hoje é um: o rodapé de descadastro, que traz `{{ unsubscribe }}` — merge tag
 * que o provedor de e-mail resolve no envio e que na web **ninguém resolve**.
 * Publicada crua, o leitor vê o literal `{{ unsubscribe }}` e um link para uma
 * URL inválida (medido em 07/09/2026: 1 ocorrência em cada um dos 5 ciclos com
 * `draft.md`).
 *
 * Remove o parágrafo INTEIRO, não só a tag, porque o texto também não se
 * sustenta fora do e-mail: "Você está recebendo esse e-mail porque se cadastrou
 * na Clarice. Caso não queira receber a newsletter, pode se descadastrar" fala
 * de um envio que não existe para quem abriu uma página. Trocar só o `href`
 * deixaria a frase mentindo em vez de quebrada.
 *
 * O caminho de E-MAIL não passa por aqui e continua intacto: `draftToEmail`
 * segue emitindo a tag, e é o provedor que a resolve. A remoção é exclusiva da
 * versão web.
 */
export function stripEmailOnlyFooter(html: string): string {
  // Ancorado no parágrafo que CONTÉM a tag, não numa frase específica — copy
  // muda, a tag é estrutural.
  return html.replace(/<p[^>]*>(?:(?!<\/p>)[\s\S])*\{\{\s*unsubscribe\s*\}\}(?:(?!<\/p>)[\s\S])*<\/p>/gi, "");
}

/**
 * Remove a frase que pede resposta ao e-mail, preservando o resto do parágrafo.
 *
 * O rodapé traz duas frases num `<p>` só: *"…responda a este e-mail dizendo
 * 'quero'"* e *"…se cadastre gratuitamente aqui"*. A primeira não tem sentido
 * na web — não há e-mail para responder — e a segunda é justamente o CTA que a
 * página quer. Por isso aqui é cirúrgico, e não a remoção do parágrafo inteiro
 * que `stripEmailOnlyFooter` faz: jogar fora o link de cadastro para se livrar
 * de uma frase seria perder a única conversão do rodapé.
 *
 * Ancorado em "responda a este e-mail" e no ponto final da frase. Se a copy
 * mudar, a frase simplesmente permanece — degradar para "sobrou uma frase
 * estranha" é aceitável; recortar no lugar errado e comer o link, não.
 */
export function stripReplyByEmailSentence(html: string): string {
  return html.replace(/Se você quiser receber[^.]*?responda a este e-mail[^.]*?\.\s*/gi, "");
}

/**
 * Corrige a atribuição dos links na versão web.
 *
 * O render é o do e-mail, então todo link do rodapé sai com `utm_medium=email`.
 * Servido na web isso carimba um clique de PÁGINA como se fosse de e-mail —
 * mesma classe de erro dos sitelinks sem UTM próprio do #7575, e com o mesmo
 * efeito: o cadastro vindo do artigo público some dentro do balde do envio, e
 * ninguém consegue medir se a página converte.
 *
 * Troca só o `medium`. `utm_source=clarice` e o `utm_campaign` do ciclo
 * continuam — o conteúdo É o mensal da parceria, e manter os dois deixa o
 * clique rastreável até o ciclo exato.
 */
export function retagWebUtmMedium(html: string): string {
  // Sem classe de caractere antes: no HTML os separadores vêm ESCAPADOS
  // (`&amp;utm_medium=`), então `[?&]` não casava nada — 10 ocorrências
  // sobreviveram silenciosamente à primeira versão. `utm_medium=` já é
  // específico o bastante para ancorar sozinho.
  return html.replace(/utm_medium=email\b/gi, "utm_medium=artigo-web");
}

/**
 * Guard: nenhuma merge tag pode sobreviver no HTML servido na web.
 *
 * Falha ALTO em vez de publicar o literal — mesma disciplina do #6210. Se um
 * template mensal futuro trouxer uma tag nova, o build para e nomeia a tag, em
 * vez de gravá-la no KV e só alguém notar meses depois olhando a página.
 */
export function verifyNoMergeTagsInArticle(html: string, cycle: string): void {
  const tags = [...new Set(html.match(/\{\{[^}]+\}\}/g) ?? [])];
  if (tags.length > 0) throw new UnresolvedMergeTagInArticleError(cycle, tags);
}

export interface ArticlePage {
  subject: string;
  previewText: string;
  /** Documento HTML completo (`<!DOCTYPE...` a `</html>`), pronto pra servir. */
  html: string;
}

/**
 * Pure: converte o markdown do draft mensal no HTML completo do artigo
 * público.
 *
 * @param draftMd conteúdo de `data/monthly/{cycle}/draft.md`
 * @param cycle ciclo no formato `{conteúdo}-{envio}` (ex: `2607-08`) — usado
 *   só pra derivar `yymm` (mês do conteúdo), que `draftToEmail` precisa pro
 *   UTM da seção É IA?/links Beehiiv e pro cálculo interno de edição É IA?.
 * @throws se `cycle` não é um ciclo válido (`{conteúdo}-{envio}`).
 */
export function buildArticleHtml(draftMd: string, cycle: string): ArticlePage {
  if (!isValidMonthlyCycle(cycle)) {
    throw new Error(
      `build-article-page: ciclo inválido "${cycle}" (esperado {conteúdo}-{envio}, ex: 2607-08)`,
    );
  }
  const yymm = cycleToYymm(cycle);
  const { subject, previewText, html } = draftToEmail(draftMd, null, yymm);
  // Sanitiza o que é só de e-mail, depois GUARDA — a mesma ordem de
  // `buildArchivePageHtml`: primeiro o que se sabe tratar, e só então a recusa
  // do que sobrou, para o guard validar exatamente o HTML que vai ser servido.
  const web = retagWebUtmMedium(stripReplyByEmailSentence(stripEmailOnlyFooter(html)));
  verifyNoMergeTagsInArticle(web, cycle);
  return { subject, previewText, html: web };
}
