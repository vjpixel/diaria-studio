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
 *
 * #4295: o link cru `https://diar.ia.br` do CTA de Facebook saía SEM UTM —
 * ~3 posts/dia viravam `direct` no Beehiiv (audit 260729, maior fatia dos
 * cadastros não-atribuídos). UTM montado via `new URL()` + `searchParams`
 * (nunca concatenação) a partir do triplo único em
 * `scripts/lib/shared/utm-registry.ts` (`FACEBOOK_CTA_UTM`). O ponto final
 * da frase continua logo após a URL — preservado de propósito
 * (`.claude/agents/social-facebook.md:37`: o Facebook precisa do `https://`
 * pra auto-linkar e o ponto fecha a frase); o linkifier do Facebook para em
 * pontuação terminal comum (`.`, `,`, `;`) que não faz parte da query string,
 * mesmo comportamento já confirmado ao vivo pro CTA de company page do
 * LinkedIn (`utm_source=linkedin&utm_medium=organic_social&utm_campaign=company_page_cta`).
 */

import { FACEBOOK_CTA_UTM } from "./shared/utm-registry.ts";

export type SocialChannel = "linkedin" | "facebook" | "instagram";

/** Monta a URL do CTA de Facebook com UTM (#4295) — `new URL()` + `searchParams.set`,
 * nunca concatenação manual de string. Exportada pra teste (garante que a URL
 * embutida em `FACEBOOK_CTA_LINE` é sempre bem-formada e carrega os 3 params). */
export function buildFacebookCtaUrl(): string {
  const url = new URL("https://diar.ia.br");
  url.searchParams.set("utm_source", FACEBOOK_CTA_UTM.source);
  url.searchParams.set("utm_medium", FACEBOOK_CTA_UTM.medium);
  url.searchParams.set("utm_campaign", FACEBOOK_CTA_UTM.campaign);
  return url.toString();
}

/** Facebook mantém o CTA de e-mail (driver de assinatura) — formato #602/#3486
 * preservado; URL com UTM desde #4295 (ver JSDoc do módulo). */
export const FACEBOOK_CTA_LINE =
  `Receba notícias de IA todo dia por e-mail, assine grátis em ${buildFacebookCtaUrl()}.`;

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

/**
 * Fonte única de verdade dos canais sociais conhecidos pelo projeto — usada
 * pelo preview (`render-social-html.ts`, #4091) pra rotular cada bloco de
 * texto com as redes de destino, sem duplicar a lista em outro módulo.
 *
 * Cobre TODOS os canais que o pipeline publica (`platform.config.json >
 * socials`), não só os 3 que recebem CTA de linha (`CHANNEL_CTA_LINES`
 * acima é um subconjunto — `twitter`/`threads` não têm CTA injetado, mas
 * ainda precisam de rótulo no preview).
 */
export interface ChannelDisplay {
  channel: string;
  /** "" quando o canal não usa emoji no rótulo (ex: Threads). */
  emoji: string;
  label: string;
}

export const KNOWN_SOCIAL_CHANNELS: readonly ChannelDisplay[] = [
  { channel: "linkedin", emoji: "💼", label: "LinkedIn" },
  { channel: "facebook", emoji: "📘", label: "Facebook" },
  { channel: "instagram", emoji: "📷", label: "Instagram" },
  { channel: "twitter", emoji: "𝕏", label: "X (Twitter)" },
  { channel: "threads", emoji: "", label: "Threads" },
];

/** Canais do texto único (LinkedIn/Facebook/Instagram, #3991). */
export const TEXTO_UNICO_CHANNELS = ["linkedin", "facebook", "instagram"] as const;

/** Canais do texto curto (X/Threads, #3992). */
export const CURTO_CHANNELS = ["twitter", "threads"] as const;

/**
 * Formata uma lista de canais (por chave) no rótulo "emoji Label · emoji Label"
 * usado no preview. Lança se algum canal não estiver em `KNOWN_SOCIAL_CHANNELS`
 * — nunca cai num fallback silencioso quando um canal novo aparece sem entrada
 * aqui (#4091).
 */
export function formatChannelLabels(channels: readonly string[]): string {
  return channels
    .map((c) => {
      const entry = KNOWN_SOCIAL_CHANNELS.find((k) => k.channel === c);
      if (!entry) {
        throw new Error(
          `[social-cta-lines] canal desconhecido: "${c}". Canais conhecidos: ` +
            `${KNOWN_SOCIAL_CHANNELS.map((k) => k.channel).join(", ")}. ` +
            `Adicione uma entry em KNOWN_SOCIAL_CHANNELS (scripts/lib/social-cta-lines.ts).`,
        );
      }
      return entry.emoji ? `${entry.emoji} ${entry.label}` : entry.label;
    })
    .join(" · ");
}

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
