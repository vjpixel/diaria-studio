/**
 * social-cta-lines.ts (#3991)
 *
 * Decisão do editor (260724, issue #3991): o texto de social passa a ser
 * ÚNICO — o mesmo corpo + hashtags para LinkedIn, Facebook e Instagram —
 * revertendo a diferenciação por canal introduzida no #3486. A ÚNICA coisa
 * que ainda difere por canal é 1 linha de CTA, injetada DETERMINISTICAMENTE
 * (TS puro, nunca LLM) no MOMENTO DO PUBLISH — nunca em Stage 2.
 * `03-social.md` (a fonte que o editor revisa no gate) NUNCA contém essas
 * linhas: elas são montadas aqui e aplicadas só pelos scripts `publish-*.ts`.
 *
 * Estrutura montada no publish (comentário do editor, issue #3991):
 *   {texto genérico — estilo Instagram}
 *
 *   {linha específica do canal}
 *
 *   {tags}
 *
 * ## LinkedIn é um caso especial — interpretação adotada, a confirmar
 *
 * A decisão do editor pediu "CTA de link (link no post ou 1º comentário,
 * conforme prática atual do canal)" para o LinkedIn. Mas a prática atual REAL
 * do canal — decidida em #595 (2026-05-08) e reafirmada em #3627 — é que o
 * post principal do LinkedIn NUNCA leva URL nem menção a "Diar.ia"/
 * "diar.ia.br" no corpo: o algoritmo do LinkedIn deprioriza posts com link
 * externo, e essa é a razão original do invariante. As duas frases da decisão
 * do editor (#3991) são ambíguas entre si nesse ponto — por isso a
 * interpretação abaixo (a ser confirmada pelo editor, ver PR body):
 *
 *   Preservar o invariante #595/#3627 — `LINKEDIN_CTA_LINE = null`, ou seja,
 *   NENHUMA linha é injetada no post principal do LinkedIn. A estrutura final
 *   do LinkedIn é `{texto genérico}\n\n{tags}`, sem CTA. `## post_pixel`
 *   (post pessoal do Pixel, #1690) continua carregando seu próprio link da
 *   página — isso não muda, é conteúdo gerado à parte com CTA embutido pelo
 *   próprio agent, não por este módulo.
 *
 * Se o editor confirmar que quer reverter #595 (link no corpo do LinkedIn),
 * a única mudança necessária é setar `LINKEDIN_CTA_LINE` para o texto
 * desejado — todo o resto (injectChannelLine, publishers) já está pronto
 * para consumir uma linha não-nula.
 */

export type SocialChannel = "linkedin" | "facebook" | "instagram";

/** Facebook mantém o CTA de e-mail (driver de assinatura) — formato #602/#3486 preservado. */
export const FACEBOOK_CTA_LINE =
  "Receba notícias de IA todo dia por e-mail, assine grátis em https://diar.ia.br.";

/** Instagram: "link na bio" + follow (#3486, preservado). Sem URL crua — IG não linka no corpo. */
export const INSTAGRAM_CTA_LINE =
  "Edição completa no link da bio. Segue @diar.ia pra não perder a próxima.";

/**
 * LinkedIn: `null` por decisão de preservar #595/#3627 — ver JSDoc do módulo
 * acima. `injectChannelLine` trata `null` como "não injetar nenhuma linha".
 */
export const LINKEDIN_CTA_LINE: string | null = null;

/** Mapa canal → linha de CTA (`null` = nenhuma linha injetada para esse canal). */
export const CHANNEL_CTA_LINES: Record<SocialChannel, string | null> = {
  linkedin: LINKEDIN_CTA_LINE,
  facebook: FACEBOOK_CTA_LINE,
  instagram: INSTAGRAM_CTA_LINE,
};

export interface SplitBodyAndTags {
  /** Corpo editorial, sem o bloco de hashtags finais (trim aplicado). */
  body: string;
  /** Bloco de hashtags finais (uma ou mais linhas, trim aplicado); "" se nenhuma. */
  tags: string;
}

/** Linha inteira composta só de tokens `#hashtag` separados por espaço. */
const HASHTAG_LINE_RE = /^(#[\p{L}\w-]+)(\s+#[\p{L}\w-]+)*$/u;

/**
 * Divide um texto em (corpo, tags) — as tags são o bloco CONTÍGUO de linhas
 * finais compostas só de hashtags. Delimitador determinístico pedido pelo
 * editor (#3991, comentário 260724): o publisher precisa saber inequivocamente
 * onde inserir sua linha de canal — entre o corpo e as tags, nunca misturado.
 *
 * Linhas em branco entre corpo e o bloco de hashtags são toleradas. Se não
 * houver bloco de hashtags ao final, `tags` é `""` e `body` é o texto inteiro
 * (trimmed).
 */
export function splitBodyAndTags(text: string): SplitBodyAndTags {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end--;

  let tagsStart = end;
  while (tagsStart > 0 && HASHTAG_LINE_RE.test(lines[tagsStart - 1].trim())) {
    tagsStart--;
  }

  if (tagsStart === end) {
    // Nenhuma linha de hashtag ao final — texto inteiro é corpo.
    return { body: text.trim(), tags: "" };
  }

  const tags = lines.slice(tagsStart, end).join("\n").trim();
  const body = lines.slice(0, tagsStart).join("\n").trim();
  return { body, tags };
}

/**
 * Monta o texto final para um canal: `{corpo}\n\n{linha do canal, se houver}\n\n{tags}`.
 *
 * `genericText` é o texto genérico (estilo Instagram, #3991) lido de
 * `03-social.md` — sem CTA de canal, sem "link na bio", sem menção a e-mail.
 * `channel` decide qual linha (se alguma) é injetada ENTRE corpo e tags.
 */
export function injectChannelLine(genericText: string, channel: SocialChannel): string {
  const { body, tags } = splitBodyAndTags(genericText);
  const ctaLine = CHANNEL_CTA_LINES[channel];
  const parts = [body];
  if (ctaLine) parts.push(ctaLine);
  if (tags) parts.push(tags);
  return parts.join("\n\n");
}
