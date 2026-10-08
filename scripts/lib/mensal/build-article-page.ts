/**
 * build-article-page.ts (#3940)
 *
 * Constrói o HTML público do artigo mensal — servido pelo worker
 * `artigo-mensal` atrás do paywall de apoiador R$10+/mês (ver
 * `workers/artigo-mensal/`) — a partir do `draft.md` do ciclo.
 *
 * PURO. Desde o #9872 a página é HTML web semântico (`monthly-web-render.ts`,
 * no estilo do Artigo Especial), não mais o documento do e-mail
 * (`wrapEmail`, tabelas de 600px). O PARSING das seções continua sendo o do
 * e-mail — os parsers vivem em `monthly-render.ts` e os dois renders os
 * consomem —, então o texto da página é o texto do e-mail; só a marcação muda.
 * O e-mail sai byte a byte igual (golden em `test/fixtures/retrospectiva-web-9872/`).
 *
 * #9496: a entrada é a do e-mail dos APOIADORES (`filterDraftForApoiadores`
 * + o perfil de UTM do canal, `APOIADORES_KIT_UTM_PROFILE`), não a do envio
 * Clarice. A página fica atrás
 * do gate de apoiador e é a versão web do e-mail que ele recebe: sem
 * APRESENTAÇÃO/`CLARICE — *`, com a legenda do É IA? do `01-eia.md` e o relink
 * das diárias (os dois insumos de I/O chegam por `ArticleBuildOptions`).
 * Nos drafts reais o `{{ unsubscribe }}` e o "responda a este e-mail" moravam
 * na APRESENTAÇÃO, que o filtro já corta — os passos 1 e 2 abaixo seguem como
 * defesa em profundidade para um template que os traga em outra seção.
 *
 * Três transformações de texto, todas vindas do tempo em que a página era o
 * render do e-mail (#7580), seguem aplicadas ao corpo web:
 *
 *   1. `stripEmailOnlyFooter` — tira o rodapé de descadastro, que carrega
 *      `{{ unsubscribe }}`: o provedor resolve no envio, na web ninguém resolve.
 *   2. `stripReplyByEmailSentence` — tira "responda a este e-mail", que não faz
 *      sentido para quem abriu uma página, preservando o link de cadastro que
 *      divide o mesmo parágrafo.
 *   3. `retagWebUtmMedium` — troca `utm_medium=email` por `artigo-web`, senão
 *      o clique na página é contado como clique de e-mail.
 *
 * O CSS responsivo (#9492) é o da própria página (`MONTHLY_WEB_STYLE`): sem
 * tabela de largura fixa, não há mais o que "soltar" no celular.
 *
 * `verifyNoMergeTagsInArticle` fecha, recusando qualquer tag remanescente. As
 * três vivem no caminho de RENDER, então valem para os ciclos existentes e para
 * todos os futuros sem mudança de código por ciclo — mas o Worker serve o HTML
 * JÁ GRAVADO no KV, então um ciclo publicado antes de uma mudança aqui só a
 * recebe quando é reconstruído e re-enviado (`build-article-page.ts --push`).
 * O caminho de e-mail não passa por nenhuma delas.
 *
 * Só as fotos do É IA? (#9864) entram; destaqueImageUrls seguem de fora — o
 * render web tolera `undefined` (sai sem `<figure>`).
 * Plugar as imagens reais do ciclo é fast-follow explícito (ver PR #3940) —
 * o dado (URLs já hospedadas no KV do worker `poll`/`draft` por
 * `monthly-image-upload.ts`) existe, só não foi plugado nesta unidade por
 * escopo.
 */
import { cycleToYymm, isValidMonthlyCycle } from "./monthly-paths.ts";
import { APOIADORES_KIT_UTM_PROFILE, deriveApoiadoresKitSubject, extractDestaqueTitle } from "./monthly-apoiadores-kit-render.ts";
import { filterDraftForApoiadores } from "./monthly-draft-filter.ts";
import { isSectionLabel } from "./monthly-render.ts";
import { draftToWebArticle, monthLabelFromYymm, renderMonthlyWebPage } from "./monthly-web-render.ts";
import { DIARIA_RETROSPECTIVA_URL } from "../canonical-urls.ts";
import { mensalPathFromCycle } from "../shared/retrospectiva-path.ts";
import { deriveDescription } from "../shared/retrospectiva-seo.ts";
import type { Brand } from "../../../workers/poll/src/lib.ts";
import { assertNoLegacyBrand, checkLegacyBrand } from "../shared/legacy-brand-guard.ts";

/**
 * Erro do guard de merge tag na versão WEB do artigo (#7580).
 *
 * Gêmeo de `UnresolvedMergeTagError` (`site-archive-pages.ts`, #6210), que faz
 * o mesmo pelas páginas de edição. Aqui a origem é outra — não é a Beehiiv
 * deixando tag crua, é o render de E-MAIL sendo reaproveitado para a web — mas
 * a consequência é idêntica: a página publica o template como texto.
 */
export class UnresolvedMergeTagInArticleError extends Error {
  readonly cycle: string;
  readonly tags: string[];

  constructor(cycle: string, tags: string[]) {
    super(
      `artigo do ciclo "${cycle}" contém merge tag não resolvida no HTML web: ${tags.join(", ")}. ` +
        `O render vem de \`draftToEmail\`, então toda tag que o provedor de e-mail resolveria precisa ser ` +
        `tratada em \`stripEmailOnlyFooter\` antes de publicar — na web ninguém as resolve.`,
    );
    this.name = "UnresolvedMergeTagInArticleError";
    this.cycle = cycle;
    this.tags = tags;
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
 * Desembrulha as fotos do É IA? do link de voto (#9864).
 *
 * No e-mail cada foto é um `<a>` para `/vote/…?email={{ … }}`; na web ninguém
 * resolve a tag, e o voto sem identidade não vale. Mantém a `<img>` e solta só
 * o `<a>` cujo `href` carrega merge tag e que envolve nada além da imagem.
 */
export function unwrapWebVoteLinks(html: string): string {
  return html.replace(
    /<a\b[^>]*href="[^"]*\{\{[^"]*"[^>]*>\s*(<img\b[^>]*>)\s*<\/a>/gi,
    "$1",
  );
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
 * O fim da frase é um limite REAL — ponto seguido de início de outra frase
 * (maiúscula) ou de fim de parágrafo — e não o primeiro ponto que aparecer.
 * A 1ª versão usava `[^.]*?\.` e o review da PR #7592 mostrou o estrago: com
 * uma abreviação no meio ("dizendo ex. \"quero\"") o corte parava em "ex." e a
 * página publicava `"quero". Se quiser…` — um fragmento quebrado, exatamente o
 * que esta docstring dizia que nunca podia acontecer. Um decimal ("3.5x")
 * antes de "responda" fazia a remoção falhar inteira, em silêncio.
 *
 * Se a copy mudar a ponto de a âncora não casar, a frase simplesmente
 * permanece: degradar para "sobrou uma frase estranha" é aceitável; recortar
 * no lugar errado e comer o link, não.
 */
export function stripReplyByEmailSentence(html: string): string {
  return html
    .replace(
      // `(?:a )?(?:este|esse)`: o 2605-06 traz "responda esse e-mail" (#9898).
      /Se você quiser receber(?:(?!<\/p>)[\s\S])*?responda (?:a )?(?:este|esse) e-mail(?:(?!<\/p>)[\s\S])*?\.(?=\s*(?:[A-ZÀ-Ú]|<\/p>))\s*/gi,
      "",
    )
    .replace(REPLY_INVITE_ONLY_P_RE, "")
    .replace(REPLY_INVITE_RE, "");
}

/**
 * 2ª forma da copy (#9898, drafts 2608-09 e 2609-10, bloco PARA ENCERRAR):
 * *"Quer sugerir um tema ou tirar uma dúvida sobre o que está aqui? Responda a
 * este e-mail. Se ainda não recebe…"*. Sai a frase "Responda a este e-mail." e
 * a pergunta que a introduz — sem ela a pergunta ficaria pendurada, sem canal
 * de resposta. A pergunta só é levada junto se começa num limite de frase
 * (início do texto, fim de tag ou pontuação final), para nunca cortar no meio
 * de outra frase. O CTA de cadastro que vem depois fica.
 */
const REPLY_INVITE_RE = /(?:(?<=^|>|[.!?](?:\s|&nbsp;)+)[A-ZÀ-Ú][^<.!?]*\?\s*)?Responda a este e-mail\.(?=\s*(?:[A-ZÀ-Ú]|<\/p>|$))\s*/g;

/** Parágrafo que era SÓ a pergunta + "Responda…" sai inteiro, sem deixar `<p></p>` vazio (#9903 finding 4). */
const REPLY_INVITE_ONLY_P_RE = /<p(?:\s[^>]*)?>\s*(?:[A-ZÀ-Ú][^<.!?]*\?\s*)?Responda a este e-mail\.\s*<\/p>\s*/g;

/**
 * Corrige a atribuição dos links na versão web.
 *
 * O render é o do e-mail, então todo link do rodapé sai com `utm_medium=email`.
 * Servido na web isso carimba um clique de PÁGINA como se fosse de e-mail —
 * mesma classe de erro dos sitelinks sem UTM próprio do #7575, e com o mesmo
 * efeito: o cadastro vindo do artigo público some dentro do balde do envio, e
 * ninguém consegue medir se a página converte.
 *
 * Troca só o `medium`. O `utm_source` (desde #9496 o do canal apoiadores,
 * `mensal-apoiadores-kit`, nos links que o render monta; link com UTM escrita
 * à mão no draft mantém a dele) e o `utm_campaign` do ciclo continuam —
 * manter os dois deixa o clique rastreável até o ciclo exato.
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
  // Casa o FORMATO de merge tag — identificador simples ou caminho pontuado
  // (`{{ unsubscribe }}`, `{{ contact.EMAIL }}`, `{{email}}`) — e não qualquer
  // `{{...}}`. A diferença importa porque esta é uma newsletter SOBRE IA: um
  // destaque pode legitimamente citar sintaxe de template ("prompt com
  // `{{ variável }}`", Jinja, Handlebars). Com o casamento largo, uma linha
  // editorial assim BLOQUEARIA a publicação de um artigo correto — o guard
  // existe para pegar tag de template que vazou, não para censurar o texto.
  // Toda merge tag real de ESP é identificador puro, então o formato separa
  // os dois casos sem escape hatch que ninguém usaria.
  const tags = [...new Set(html.match(/\{\{\s*[A-Za-z_][\w.]*\s*\}\}/g) ?? [])];
  if (tags.length > 0) throw new UnresolvedMergeTagInArticleError(cycle, tags);
}

export interface ArticlePage {
  subject: string;
  previewText: string;
  /** Documento HTML completo (`<!DOCTYPE...` a `</html>`), pronto pra servir. */
  html: string;
}

/**
 * Erro do corte do trecho: o draft não tem a estrutura que o corte pressupõe.
 *
 * Falha ALTO em vez de devolver um trecho torto. Um trecho vazio (ou o artigo
 * inteiro por engano) publicado como "amostra grátis" é pior que não ter
 * trecho: no primeiro caso a página não vende nada, no segundo ela entrega o
 * conteúdo pago. `build-article-page.ts` trata isso como falha do ciclo.
 */
export class TeaserCutError extends Error {
  readonly cycle: string;

  constructor(cycle: string, motivo: string) {
    super(`não foi possível cortar o trecho público do ciclo "${cycle}": ${motivo}`);
    this.name = "TeaserCutError";
    this.cycle = cycle;
  }
}

/**
 * Marcador de seção do draft mensal: `**DESTAQUE 1 | INDÚSTRIA**`, `**LIVROS**`, …
 *
 * Sem letra minúscula (#9897): marcador é sempre caixa-alta, e é isso que o
 * separa do título do destaque quando o título vem em negrito
 * (`**Anthropic vira centro de gravidade da indústria**`, formato do 2604-05).
 * Antes o título casava como marcador e o corte parava logo depois do
 * cabeçalho do DESTAQUE 1 — o trecho saía sem o corpo do destaque.
 */
const SECTION_MARKER = /^\*\*[A-ZÀ-Ú][^*\p{Ll}]*\*\*$/u;

/**
 * Corta o markdown do draft no fim do 1º destaque temático.
 *
 * Decisão do editor (07/09/2026): dos 3 destaques do mensal, o trecho público
 * leva o primeiro INTEIRO. Uma peça completa e coerente convence melhor que
 * três parágrafos picados, e ainda deixa dois terços pagos.
 *
 * O corte é no MARKDOWN, não no HTML. Cortar HTML de e-mail — tabelas
 * aninhadas, estilos inline — por offset produz documento malformado; aqui o
 * limite é uma linha de marcador de seção, e o render depois devolve HTML
 * completo e válido por construção.
 *
 * Corta no PRÓXIMO marcador depois do `DESTAQUE 1`, seja ele qual for
 * (`CLARICE — DIVULGAÇÃO`, `DESTAQUE 2`, …). Deixa o trecho terminando no
 * "fio condutor" do destaque, que é gancho melhor do que terminar num bloco
 * patrocinado — e sobrevive a uma reordenação de seções sem precisar saber o
 * que vem depois.
 */
export function cutDraftAfterFirstDestaque(draftMd: string, cycle: string): string {
  const linhas = draftMd.split(/\r?\n/);
  const iDestaque = linhas.findIndex((l) => /^\*\*DESTAQUE 1\b/.test(l));
  if (iDestaque < 0) {
    throw new TeaserCutError(cycle, "não há marcador `**DESTAQUE 1 ...**` no draft");
  }
  // `.trim()`: espaço à direita num cabeçalho gerado por LLM faria o
  // marcador não casar, e o corte seguiria varrendo — até dentro do DESTAQUE 2.
  // `|| isSectionLabel(l)` (#9903 finding 1): a caixa-alta não pode ser o ÚNICO
  // critério — um marcador futuro com minúscula (`**Destaque 2 | IA generativa**`)
  // deixaria de cortar e o conteúdo pago vazaria pro trecho. O vocabulário que o
  // render usa pra dividir seções corta com qualquer caixa.
  const iCorte = linhas.findIndex((l, i) => i > iDestaque && (SECTION_MARKER.test(l.trim()) || isSectionLabel(l)));
  if (iCorte < 0) {
    throw new TeaserCutError(cycle, "não há seção depois do DESTAQUE 1 — o trecho seria o artigo inteiro");
  }
  const trecho = linhas.slice(0, iCorte).join("\n").trimEnd();
  // Um corte que não deixa corpo nenhum é bug de estrutura, não trecho curto.
  if (trecho.length < 500) {
    throw new TeaserCutError(cycle, `trecho ficou com ${trecho.length} caracteres — estrutura inesperada`);
  }
  return trecho;
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
/**
 * HTML do TRECHO público — o que o não-apoiador recebe.
 *
 * Passa pelo mesmo render e pelas mesmas três transformações web do artigo
 * completo, então herda o guard de merge tag e a correção de UTM sem
 * duplicação. A diferença é só o markdown de entrada, já cortado.
 *
 * O bloco de paywall (fade + CTA) NÃO entra aqui: ele é montado pelo Worker
 * (`workers/artigo-mensal/src/render.ts`), onde o CTA já vive. Assim mudar o
 * texto do convite não exige reconstruir e republicar todos os ciclos.
 */
export function buildArticleTeaserHtml(draftMd: string, cycle: string, opts: ArticleBuildOptions = {}): ArticlePage {
  return buildArticleHtml(cutDraftAfterFirstDestaque(draftMd, cycle), cycle, opts);
}

/**
 * Insumos de I/O que o e-mail dos apoiadores recebe além do `draft.md` (#9496).
 * A lib segue pura: quem lê os arquivos do ciclo é o CLI
 * (`scripts/build-article-page.ts`), pelas MESMAS funções que o render do
 * e-mail usa (`scripts/render-monthly-apoiadores-kit.ts`).
 */
export interface ArticleBuildOptions {
  /** Legenda do `01-eia.md` (crédito da foto + "Resultado da última edição"),
   * que substitui o corpo do bloco É IA? do draft — o `eiaCredit` do e-mail. */
  eiaCredit?: string;
  /** Pós-processo do HTML do corpo ANTES das transformações web — o relink
   * dos destaques para a edição diária de origem (#4048), como no e-mail. O
   * nome é histórico (até o #9872 o corpo era o HTML do e-mail); o relink só
   * reescreve `<a href>`, então vale igual para o corpo web. */
  postProcessEmailHtml?: (html: string) => string;
  /** URLs públicas do par de fotos do É IA? (`eia_a`/`eia_b` do
   * `public-images.json`, #9864). Sem elas o bloco sai com "Imagem A/B". */
  eiaImageUrlA?: string;
  eiaImageUrlB?: string;
}

/**
 * Brand do "Ver ranking" do É IA? na PÁGINA WEB (#9865): o leaderboard
 * `clarice`, o mesmo do e-mail Clarice — decisão do editor no briefing
 * overnight de 08/10/2026. O e-mail dos apoiadores segue com o próprio brand
 * (`APOIADORES_KIT_UTM_PROFILE.pollBrand`), onde os votos dele são contados.
 */
export const WEB_LEADERBOARD_BRAND: Brand = "clarice";

export function buildArticleHtml(draftMd: string, cycle: string, opts: ArticleBuildOptions = {}): ArticlePage {
  if (!isValidMonthlyCycle(cycle)) {
    throw new Error(
      `build-article-page: ciclo inválido "${cycle}" (esperado {conteúdo}-{envio}, ex: 2607-08)`,
    );
  }
  const yymm = cycleToYymm(cycle);
  const path = mensalPathFromCycle(cycle);
  const monthLabel = monthLabelFromYymm(yymm);
  if (!path || !monthLabel) {
    throw new Error(`build-article-page: ciclo "${cycle}" não deriva path/mês da retrospectiva`);
  }
  // #9496: a página é a MESMA versão do e-mail dos apoiadores — mesmo filtro
  // de seções Clarice-only e mesmo perfil de UTM (`APOIADORES_KIT_UTM_PROFILE`),
  // em vez do `draft.md` cru da Clarice. #9872: o corpo sai do render WEB
  // (`draftToWebArticle`), com o mesmo parsing e o mesmo texto do e-mail.
  const { subject, previewText, bodyHtml } = draftToWebArticle({
    draft: filterDraftForApoiadores(draftMd),
    yymm,
    utmProfile: APOIADORES_KIT_UTM_PROFILE,
    leaderboardBrand: WEB_LEADERBOARD_BRAND,
    eiaImageUrlA: opts.eiaImageUrlA,
    eiaImageUrlB: opts.eiaImageUrlB,
    eiaCredit: opts.eiaCredit,
  });
  const relinked = opts.postProcessEmailHtml ? opts.postProcessEmailHtml(bodyHtml) : bodyHtml;
  // Sanitiza o que é só de e-mail, depois GUARDA — a mesma ordem de
  // `buildArchivePageHtml`: primeiro o que se sabe tratar, e só então a recusa
  // do que sobrou, para o guard validar exatamente o HTML que vai ser servido.
  const body = retagWebUtmMedium(stripReplyByEmailSentence(stripEmailOnlyFooter(unwrapWebVoteLinks(relinked))));
  // O `<title>` segue vindo do ASSUNTO do draft (contrato do #3940 e alvo do
  // guard de marca do #7719); o `<h1>` visível é o assunto próprio do e-mail
  // dos apoiadores ("Retrospectiva de {mês}: {título do D1}", #7867), que é o
  // que o apoiador lê na caixa de entrada.
  const heading = headingFor(draftMd, yymm, subject);
  const html = renderMonthlyWebPage({
    title: subject || heading,
    heading,
    description: previewText || deriveDescription(`<body>${body}</body>`),
    canonical: `${DIARIA_RETROSPECTIVA_URL}/${path}`,
    monthLabel,
    bodyHtml: body,
  });
  verifyNoMergeTagsInArticle(html, cycle);
  // Guard de marca legada (#7719) — mesma disciplina do guard de merge tag
  // acima: checa o HTML final, DEPOIS do render, porque é dado que vem do
  // `draft.md` (fora do repo, sem cobertura do guard estático em
  // `test/reader-facing-no-legacy-brand-4424.test.ts`). Cobre título, metas
  // e corpo com uma chamada só.
  assertNoLegacyBrand(checkLegacyBrand(html), `artigo do ciclo "${cycle}"`);
  return { subject, previewText, html };
}

/** `<h1>` da página: o assunto do e-mail dos apoiadores; draft sem DESTAQUE 1
 * (só fixture/ciclo malformado — o corte do trecho já exige um) cai no ASSUNTO. */
function headingFor(draftMd: string, yymm: string, subject: string): string {
  if (extractDestaqueTitle(draftMd, 1)) return deriveApoiadoresKitSubject(draftMd, yymm);
  return subject || "Retrospectiva do mês";
}
