/**
 * scripts/lib/circle-stack-email-render.ts (#12538)
 *
 * Render PURO do e-mail do post semanal da Stack aos apoiadores Núcleo:
 * assunto, preview e HTML a partir da MESMA seleção aprovada que vai ao
 * Circle (`circle-stack-selection.json`).
 *
 * Uma fonte de conteúdo só: o post é montado por `renderCircleStackPost`
 * (o render do Circle), só com outro canal de UTM e sem a linha "Assine a
 * diar.ia.br" (quem recebe já assina e apoia). Este módulo converte o
 * Markdown daquele render — um subconjunto pequeno e fixo: parágrafo, `##`,
 * `###`, lista com `- `, link `[rótulo](url)` e negrito `**…**` — em HTML de
 * e-mail. Escrever um 2º render em HTML duplicaria as regras do post (abertura,
 * vídeo da semana) e as duas versões divergiriam.
 *
 * Regras de e-mail, as mesmas de `artigo-especial-email-render.ts`: tudo
 * inline, tabela externa 100% + interna 600, `paperEmail` e não `paper`, sem
 * `<style>` no head.
 */
import { COLORS } from "./shared/design-tokens.ts";
import { STACK_EMAIL_UTM_MEDIUM, STACK_EMAIL_UTM_SOURCE } from "./shared/utm-registry.ts";
import { APOIO_EXCLUSIVE_PREVIEW_TEXT } from "./shared/apoio-preview-text.ts";
import { renderCircleStackPost, type CircleStackSelection } from "./circle-stack-render.ts";

const { brand: TEAL, ink: INK, paperEmail: PAPER, paperAlt: BEGE } = COLORS;

const SANS = "-apple-system,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

export interface RenderedStackEmail {
  subject: string;
  previewText: string;
  html: string;
}

/** Pure: assunto. Prefixo diz por que o e-mail chegou (envio fora da cadência diária). */
export function buildStackEmailSubject(title: string): string {
  return `Stack da semana: ${title.replace(/\s+/g, " ").trim()}`;
}

/**
 * Escape de HTML + chaves. As chaves viram entidade porque o Kit interpreta o
 * conteúdo como Liquid: um `{{ $json.x }}` citado num texto sobre n8n
 * sumiria (ou quebraria o render) no e-mail. A entidade aparece igual ao leitor
 * e não forma `{{`/`{%` no template.
 */
function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

/**
 * Pure: instante ISO em horário de Brasília, para mensagens ao editor
 * ("16/11 06:05 BRT"). ISO cru em UTC fazia o prazo de cancelamento parecer 3h
 * mais longo do que é.
 *
 * @pure
 */
export function formatStackEmailBrt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")}/${get("month")} ${get("hour")}:${get("minute")} BRT`;
}

/**
 * Pure: inline Markdown (link e negrito) → HTML, com tudo escapado. O rótulo
 * de link do render da Stack nunca tem `]` (vira `)`) e escapa `\` como `\\`;
 * a URL nunca tem `(`/`)`/espaço (viram `%28`/`%29`/`%20`). É isso que permite
 * um regex simples aqui sem ambiguidade.
 *
 * @pure
 */
export function inlineMarkdownToHtml(text: string): string {
  const out: string[] = [];
  const re = /\[([^\]]*)\]\(([^)\s]*)\)/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push(boldToHtml(escHtml(text.slice(last, m.index))));
    const label = m[1].replace(/\\\\/g, "\\");
    out.push(
      `<a href="${escHtml(m[2])}" style="color:${TEAL};text-decoration:underline;">${boldToHtml(escHtml(label))}</a>`,
    );
    last = m.index + m[0].length;
  }
  out.push(boldToHtml(escHtml(text.slice(last))));
  return out.join("");
}

function boldToHtml(escaped: string): string {
  return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

const P_STYLE = `margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.6;color:${INK};`;

/**
 * Pure: blocos do Markdown do post (separados por linha em branco) → HTML.
 * Bloco fora do subconjunto conhecido vira parágrafo (nunca some).
 *
 * @pure
 */
export function stackMarkdownToHtml(markdown: string): string {
  const blocks = markdown
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  return blocks
    .map((b) => {
      if (b.startsWith("### ")) {
        return `<h3 style="margin:24px 0 10px;font-family:${SERIF};font-size:19px;line-height:1.3;color:${INK};">${inlineMarkdownToHtml(b.slice(4))}</h3>`;
      }
      if (b.startsWith("## ")) {
        return `<h2 style="margin:32px 0 12px;padding-top:16px;border-top:1px solid ${BEGE};font-family:${SANS};font-size:13px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:${INK};">${inlineMarkdownToHtml(b.slice(3))}</h2>`;
      }
      const lines = b.split("\n").map((l) => l.trim());
      if (lines.every((l) => l.startsWith("- "))) {
        const items = lines
          .map((l) => `<li style="margin:0 0 10px;">${inlineMarkdownToHtml(l.slice(2))}</li>`)
          .join("");
        return `<ul style="margin:0 0 16px;padding-left:20px;font-family:${SANS};font-size:16px;line-height:1.6;color:${INK};">${items}</ul>`;
      }
      return `<p style="${P_STYLE}">${inlineMarkdownToHtml(lines.join(" "))}</p>`;
    })
    .join("\n");
}

/**
 * Pure: e-mail completo a partir da seleção do ciclo. Lança se a seleção não
 * tem destaque (mesma recusa do render do Circle).
 *
 * @pure
 */
export function renderStackEmail(sel: CircleStackSelection): RenderedStackEmail {
  const post = renderCircleStackPost(sel, {
    channel: { utmSource: STACK_EMAIL_UTM_SOURCE, utmMedium: STACK_EMAIL_UTM_MEDIUM, omitSubscribeCta: true, omitOtherHighlights: true },
  });
  const html = `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:0;background:${BEGE};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escHtml(APOIO_EXCLUSIVE_PREVIEW_TEXT)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BEGE};">
    <tr><td align="center" style="padding:32px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;background:${PAPER};border-radius:12px;overflow:hidden;">
        <tr><td style="padding:36px 32px 32px;">
          <h1 style="margin:0 0 20px;font-family:${SERIF};font-size:26px;line-height:1.25;color:${INK};">${escHtml(post.title)}</h1>
${stackMarkdownToHtml(post.markdown)}
          <p style="margin:28px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${INK};opacity:.7;">Voc&ecirc; recebe este e-mail porque apoia a diar.ia.br no n&iacute;vel N&uacute;cleo. Obrigado por sustentar o projeto.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
  return { subject: buildStackEmailSubject(post.title), previewText: APOIO_EXCLUSIVE_PREVIEW_TEXT, html };
}
