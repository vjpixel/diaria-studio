/**
 * scripts/lib/artigo-especial-email-render.ts (#7659)
 *
 * Render PURO do e-mail do Artigo Especial — assunto, preview text e HTML, a
 * partir do texto de chamada que a skill já gera
 * (`data/artigo-especial/{ano}-{slug}/email.md`) e dos metadados extraídos do
 * artigo publicado (`artigo-especial-meta.ts`).
 *
 * ## Por que um render próprio, e não o da newsletter
 *
 * Este e-mail não tem seções, destaques, poll nem rodapé de edição — é uma
 * carta curta: capa, título, 2 parágrafos de chamada, botão. Passar isso pelo
 * renderer da diária (`newsletter-render-html.ts`) significaria configurar
 * pra ignorar quase tudo que ele faz. O custo de manter ~80 linhas de HTML
 * inline aqui é menor que o de um segundo modo naquele arquivo.
 *
 * ## Regras de e-mail que este arquivo respeita de propósito
 *
 * - **Tudo inline, tabela única, largura fixa 600.** Sem `<style>` no head:
 *   Gmail descarta parte dele (memória do projeto sobre a Beehiiv, e o Kit
 *   injeta o seu por cima do nosso).
 * - **`paperEmail` (#FFFFFF), não `paper`.** Token de e-mail existe
 *   justamente porque o creme (#FBFAF6) vira cinza em inversão/modo escuro
 *   (#2005).
 * - **Nada de imagem obrigatória.** A capa é opcional: `og:image` pode faltar
 *   e o e-mail continua íntegro — a falha desse render nunca pode ser "não
 *   saiu porque não achou a capa".
 */

import { COLORS } from "./shared/design-tokens.ts";
import {
  ARTIGO_ESPECIAL_EMAIL_UTM_SOURCE,
  ARTIGO_ESPECIAL_EMAIL_UTM_MEDIUM,
  buildArtigoEspecialEmailCampaign,
} from "./shared/utm-registry.ts";

const { brand: TEAL, ink: INK, paperEmail: PAPER, paperAlt: BEGE } = COLORS;

/**
 * Acrescenta os UTMs à URL do artigo, preservando query/fragment que já
 * existam. `URL` e não concatenação de string: o `og:url` é conteúdo autoral e
 * já apareceu com `?`/`#` em outras superfícies do projeto.
 *
 * URL inválida volta INALTERADA em vez de lançar — um e-mail sem UTM é uma
 * perda de medição; um e-mail que não sai é uma perda de entrega, e a segunda
 * é pior. O caller loga.
 *
 * @pure
 */
export function withArtigoEspecialEmailUtm(url: string, ano: string, slug: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", ARTIGO_ESPECIAL_EMAIL_UTM_SOURCE);
    u.searchParams.set("utm_medium", ARTIGO_ESPECIAL_EMAIL_UTM_MEDIUM);
    u.searchParams.set("utm_campaign", buildArtigoEspecialEmailCampaign(ano, slug));
    return u.toString();
  } catch {
    return url;
  }
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Pure: quebra o texto de chamada em parágrafos e DESCARTA os que são só a URL
 * do artigo.
 *
 * O descarte não é cosmético: `email.md` é gerado com a mesma regra do
 * `apoiase.md`, que termina com a URL crua porque lá não há botão. Aqui há —
 * deixar as duas produz um e-mail que pede a mesma coisa duas vezes, e uma
 * delas como texto não clicável em parte dos clientes.
 *
 * @pure
 */
export function chamadaParagraphs(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/)
    .map((p) => p.trim().replace(/\s*\n\s*/g, " "))
    .filter(Boolean)
    .filter((p) => !/^<?https?:\/\/\S+>?$/i.test(p));
}

/**
 * Pure: assunto do e-mail. Prefixo fixo porque o assunto sozinho ("A
 * engenharia da ilusão") não diz a quem chega na caixa POR QUE aquilo chegou —
 * e este é um envio raro, fora da cadência diária que o leitor reconhece.
 *
 * @pure
 */
export function buildArtigoEspecialEmailSubject(title: string): string {
  return `Artigo Especial: ${title.trim()}`;
}

export interface ArtigoEspecialEmailInput {
  /** `h1`/`title` do artigo (`artigo-especial-meta.ts`). */
  title: string;
  /** `description` — vira o preview text. */
  description: string;
  /** `og:url` do artigo, SEM UTM (este módulo acrescenta). */
  url: string;
  /** `og:image`, ou `null` — a capa é opcional. */
  image: string | null;
  /** Conteúdo de `email.md` (chamada já humanizada/corrigida pela skill). */
  chamadaMarkdown: string;
  ano: string;
  slug: string;
}

export interface RenderedArtigoEspecialEmail {
  subject: string;
  previewText: string;
  html: string;
}

/**
 * Pure: monta o e-mail completo. Lança se a chamada ficar sem nenhum parágrafo
 * — um e-mail com título e botão e NADA no meio é pior que erro, porque sai
 * parecendo intencional.
 *
 * @pure
 */
export function renderArtigoEspecialEmail(input: ArtigoEspecialEmailInput): RenderedArtigoEspecialEmail {
  const paragraphs = chamadaParagraphs(input.chamadaMarkdown);
  if (paragraphs.length === 0) {
    throw new Error(
      "email.md não tem nenhum parágrafo de chamada (só URL, ou vazio) — o e-mail sairia com título e " +
        "botão e nada no meio. Gere o texto no Passo 1 da skill antes de publicar.",
    );
  }

  const href = withArtigoEspecialEmailUtm(input.url, input.ano, input.slug);
  const capa = input.image
    ? `      <tr><td style="padding:0;"><img src="${escHtml(input.image)}" width="600" alt="" style="display:block;width:100%;max-width:600px;height:auto;border:0;" /></td></tr>\n`
    : "";

  const corpo = paragraphs
    .map(
      (p) =>
        `        <p style="margin:0 0 18px;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:${INK};">${escHtml(p)}</p>`,
    )
    .join("\n");

  const html = `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:0;background:${BEGE};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escHtml(input.description)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BEGE};">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:${PAPER};border-radius:12px;overflow:hidden;">
${capa}        <tr><td style="padding:36px 32px 32px;">
          <p style="margin:0 0 12px;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:${INK};"><span style="color:${TEAL};">&#9679;</span> Artigo Especial</p>
          <h1 style="margin:0 0 20px;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:1.25;color:${INK};">${escHtml(input.title)}</h1>
${corpo}
          <p style="margin:28px 0 0;"><a href="${escHtml(href)}" style="display:inline-block;background:${TEAL};color:#ffffff;text-decoration:none;font-family:-apple-system,Helvetica,Arial,sans-serif;font-weight:bold;font-size:16px;padding:14px 28px;border-radius:8px;">Ler o artigo completo</a></p>
          <p style="margin:24px 0 0;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:${INK};opacity:.7;">Você recebe este e-mail porque apoia a diar.ia.br a partir de R$&nbsp;10/m&ecirc;s. O Artigo Especial &eacute; uma das recompensas desse n&iacute;vel &mdash; obrigado por sustentar o projeto.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return {
    subject: buildArtigoEspecialEmailSubject(input.title),
    previewText: input.description.trim(),
    html,
  };
}
