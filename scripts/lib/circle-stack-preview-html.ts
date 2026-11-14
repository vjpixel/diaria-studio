/**
 * circle-stack-preview-html.ts (#12555)
 *
 * Prévia HTML do post semanal da Stack (`_internal/circle-stack-preview.html`),
 * a página que o Passo 5 de `/diaria-stack` publica como Artifact. Antes ela era
 * escrita à mão a cada sessão e ficou várias vezes diferente do que seria
 * enviado (período errado, vídeo sem link). Agora sai do mesmo dry-run que grava
 * a prévia em Markdown e o payload, a partir da mesma seleção.
 *
 * Mostra: título que vai ao webhook, estado do ciclo na Stack, os avisos atuais
 * (#12553), o texto escrito para a Stack (abertura e `stackNote`) em destaque,
 * o título original ao lado do traduzido, os itens descartados (#12557), o link
 * do post quando o webhook o devolveu (#12556) e o comando de envio com o aviso
 * de que `--publish` publica NA HORA, sem rascunho.
 *
 * Estrutura das seções e "Outros destaques" vêm das funções do render do post
 * (`resolveCircleStackOpening`, `circleStackOtherHighlights`), para a prévia não
 * divergir do que o webhook recebe. Página sem script, documento completo
 * (doctype, charset, viewport: #13055 — sem doctype o Artifact renderizava em
 * quirks mode). O número de views do vídeo não aparece (decisão do editor,
 * #13050): `video.views` segue só como critério de escolha.
 */
import {
  buildCircleStackUrl,
  circleStackOtherHighlights,
  ddmm,
  resolveCircleStackOpening,
  type CircleStackExclusion,
  type CircleStackItem,
  type CircleStackSelection,
} from "./circle-stack-render.ts";
import { buildHtmlDocument } from "./shared/html-document.ts";

export interface CircleStackPreviewHtmlInput {
  /** Seleção com as exclusões já aplicadas (a mesma que o render recebe). */
  selection: CircleStackSelection;
  /** Itens descartados (`excluded` da seleção gravada). */
  excluded?: readonly CircleStackExclusion[];
  /** Título que vai ao webhook (`payload.titulo`, com o aviso de escape quando houver). */
  previewTitle: string;
  publishMonday: string;
  /** Estado normalizado do ciclo na Stack (`draft`/`published`/`unknown`). */
  publishState: string;
  warnings: readonly string[];
  /** Conteúdo de `--opening-file`, se passado. */
  openingOverride?: string;
  /** Link do post, quando o webhook o devolveu (#12556). */
  postUrl?: string | null;
  /** Caminho (relativo à raiz) da prévia em Markdown. */
  mdPath: string;
}

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function safeHref(u: string): string | null {
  return /^https?:\/\//i.test(u.trim()) ? esc(u.trim()) : null;
}

function a(href: string, label: string): string {
  const h = safeHref(href);
  return h ? `<a href="${h}">${esc(label)}</a>` : esc(label);
}

/** Pure: Markdown de linha (link `[x](url)` e negrito `**x**`) em HTML escapado. */
export function inlineMarkdownToHtml(s: string): string {
  const out: string[] = [];
  const re = /\[([^\]]*)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const bold = (t: string) => esc(t).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  while ((m = re.exec(s)) !== null) {
    out.push(bold(s.slice(last, m.index)));
    const h = safeHref(m[2]);
    out.push(h ? `<a href="${h}">${bold(m[1])}</a>` : bold(m[0]));
    last = m.index + m[0].length;
  }
  out.push(bold(s.slice(last)));
  return out.join("");
}

function paras(text: string, cls = ""): string {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p${cls ? ` class="${cls}"` : ""}>${inlineMarkdownToHtml(p)}</p>`)
    .join("\n");
}

function originalLine(it: CircleStackItem): string {
  const orig = it.titleOriginal?.trim();
  if (!orig || orig === it.title.trim()) return "";
  return `<div class="orig">Original: ${esc(orig)}${it.titleReviewed ? " · revisado" : ""}</div>`;
}

function stackBlock(text: string, label = "Texto para a Stack"): string {
  return `<div class="stack"><span class="label">${esc(label)}</span>${paras(text)}</div>`;
}

function listSection(heading: string, items: readonly CircleStackItem[]): string {
  if (items.length === 0) return "";
  const lis = items
    .map((it) => {
      const note = it.stackNote?.trim();
      const desc = note ? stackBlock(note) : paras(it.body);
      return `<li><h3>${a(it.url, it.title)}</h3>${originalLine(it)}<div class="small">Edição de ${esc(ddmm(it.editionDate))}</div>${desc}</li>`;
    })
    .join("\n");
  return `<section class="box"><h2>${esc(heading)}</h2><ul class="items">\n${lis}\n</ul></section>`;
}

const STATE_LABEL: Record<string, string> = {
  draft: "não publicado",
  published: "publicado",
  unknown: "ambíguo (conferir no Radar)",
};

/** Pure: a página inteira, documento completo (#13055). */
export function renderCircleStackPreviewHtml(input: CircleStackPreviewHtmlInput): string {
  const sel = input.selection;
  const opening = resolveCircleStackOpening(sel, input.openingOverride);
  const notes = [...sel.lancamentos, ...sel.useMelhor, ...sel.radar].filter((it) => it.stackNote?.trim()).length;
  const ownOpening = opening.source === "selecao" || opening.source === "arquivo";
  const weekRange = sel.contentWindow.length > 0 ? `${ddmm(sel.contentWindow[0])} a ${ddmm(sel.contentWindow[sel.contentWindow.length - 1])}` : "";
  const editions = sel.weeklyEditions.map((e) => ddmm(e.editionDate)).join(", ");

  const parts: string[] = [];
  parts.push("<main>");
  parts.push(
    `<header><h1>${esc(input.previewTitle)}</h1>` +
      `<p class="meta">Prévia do post semanal no Radar de Notícias Stack. Ciclo ${esc(sel.cycle)}, segunda ${esc(ddmm(input.publishMonday))}. ` +
      `Gerada por publish-circle-stack.ts a partir de ${esc(input.mdPath)} e da seleção do ciclo (não editar à mão).</p>` +
      `<div class="bar"><span class="pill">Estado na Stack: ${esc(STATE_LABEL[input.publishState] ?? input.publishState)}</span>` +
      `<span class="pill">Texto próprio: ${ownOpening ? "abertura + " : ""}${notes} descrição(ões)</span>` +
      (weekRange ? `<span class="pill">Semana: ${esc(weekRange)}</span>` : "") +
      (editions ? `<span class="pill">Edições lidas: ${esc(editions)}</span>` : "") +
      `</div></header>`,
  );
  if (input.postUrl) parts.push(`<section class="box"><strong>Post publicado:</strong> ${a(input.postUrl, input.postUrl)}</section>`);

  if (input.warnings.length > 0) {
    parts.push(
      `<section class="box warn"><strong>Avisos da seleção (revisar antes de publicar)</strong><ul>${input.warnings
        .map((w) => `<li>${esc(w)}</li>`)
        .join("")}</ul></section>`,
    );
  } else {
    parts.push(`<section class="box ok">Sem avisos na seleção.</section>`);
  }

  parts.push(
    `<section class="box"><h2>Abertura</h2>${ownOpening ? stackBlock(opening.text, "Abertura escrita para a Stack") : paras(opening.text)}` +
      (ownOpening ? "" : `<p class="small">Abertura automática (${opening.source === "resumo" ? "resumo dos destaques" : "texto de reserva"}): a seleção não tem o campo opening.</p>`) +
      `</section>`,
  );

  if (sel.video && sel.video.url.trim() && sel.video.title.trim()) {
    parts.push(
      `<section class="box"><h2>Principal vídeo da semana</h2><h3>${a(buildCircleStackUrl(sel.video.url, sel.cycle, "video"), sel.video.title)}</h3>` +
        `<div class="small">Edição de ${esc(ddmm(sel.video.editionDate))}</div>` +
        (sel.video.description?.trim() ? stackBlock(sel.video.description, "Descrição do vídeo") : "") +
        `</section>`,
    );
  }

  const destaques = sel.destaques
    .map(
      (h) =>
        `<li><h3>${a(h.url, h.title)}</h3>${originalLine(h)}<div class="small">Edição de ${esc(ddmm(h.editionDate))}</div>${paras(h.body)}` +
        (h.why.trim() ? `<p><strong>Por que isso importa:</strong></p>${paras(h.why)}` : "") +
        `</li>`,
    )
    .join("\n");
  parts.push(`<section class="box"><h2>Destaques da semana</h2><p class="small">Iguais aos da diária.</p><ul class="items">\n${destaques}\n</ul></section>`);
  parts.push(listSection("Lançamentos", sel.lancamentos));
  parts.push(listSection("Use melhor", sel.useMelhor));
  parts.push(listSection("Radar", sel.radar));

  const others = circleStackOtherHighlights(sel);
  if (others.length > 0) {
    parts.push(
      `<section class="box"><h2>Outros destaques da semana</h2>${others
        .map(
          ({ edition, titles }) =>
            `<h3>${a(buildCircleStackUrl(edition.url, sel.cycle, "edicao"), ddmm(edition.editionDate))}</h3><ul>${titles.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`,
        )
        .join("")}<p class="small">Só no Circle: o e-mail aos apoiadores Núcleo não leva esta seção.</p></section>`,
    );
  }

  const excluded = (input.excluded ?? []).filter((e) => e.url?.trim() || e.title?.trim());
  if (excluded.length > 0) {
    parts.push(
      `<section class="box"><h2>Descartados pelo editor</h2><p class="small">Campo excluded da seleção: não saem em seção nenhuma nem em Outros destaques.</p><ul>${excluded
        .map((e) => `<li>${esc(e.title?.trim() || e.url?.trim() || "")}${e.note?.trim() ? ` <span class="small">(${esc(e.note.trim())})</span>` : ""}</li>`)
        .join("")}</ul></section>`,
    );
  }

  parts.push(
    `<section class="box"><h2>Envio</h2>` +
      `<p>Aprovar para o envio automático de segunda 06:00 BRT:</p><code>npx tsx scripts/publish-circle-stack-scheduled.ts --approve --publish-monday ${esc(input.publishMonday)}</code>` +
      `<p>Envio na hora (o post sai PUBLICADO, sem rascunho):</p><code>npx tsx scripts/publish-circle-stack.ts --publish-monday ${esc(input.publishMonday)} --publish</code>` +
      `</section>`,
  );
  parts.push("</main>");
  return buildHtmlDocument({ head: `<title>Stack ${esc(sel.cycle)}</title>\n<style>${CSS}</style>`, body: parts.join("\n") });
}

const CSS = [
  ':root{--bg:#f6f7f6;--fg:#1c2321;--muted:#5b6662;--line:#d9dedb;--panel:#ffffff;--accent:#0b7a6e;--mark:#e3f2ee;--warn:#8a5a00;--warnbg:#fff4dc;--okfg:#1f5d3a;--okbg:#e4f3ea}',
  '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121615;--fg:#e6ebe8;--muted:#9aa7a2;--line:#2b3431;--panel:#1a201e;--accent:#4fc2b2;--mark:#173530;--warn:#f0c36a;--warnbg:#3a2f12;--okfg:#9fdcb6;--okbg:#16301f;color-scheme:dark}}',
  ':root[data-theme="dark"]{--bg:#121615;--fg:#e6ebe8;--muted:#9aa7a2;--line:#2b3431;--panel:#1a201e;--accent:#4fc2b2;--mark:#173530;--warn:#f0c36a;--warnbg:#3a2f12;--okfg:#9fdcb6;--okbg:#16301f;color-scheme:dark}',
  'body{background:var(--bg);color:var(--fg);font:16px/1.55 Georgia,"Times New Roman",serif;margin:0;padding:24px 16px}',
  "main{max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:20px;min-width:0}",
  "h1{font-size:1.5rem;line-height:1.25;margin:0 0 6px;text-wrap:balance}",
  "h2{font-size:1.15rem;margin:0 0 8px}",
  "h3{font-size:1rem;margin:0 0 4px}",
  "a{color:var(--accent);overflow-wrap:anywhere}",
  ".meta,.small,.orig{font:13px/1.45 system-ui,sans-serif;color:var(--muted)}",
  ".bar{display:flex;flex-wrap:wrap;gap:8px;font:13px system-ui,sans-serif;margin-top:8px}",
  ".pill{border:1px solid var(--line);background:var(--panel);border-radius:999px;padding:3px 10px}",
  ".box{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:14px 16px;min-width:0}",
  ".warn{background:var(--warnbg);color:var(--warn);border-color:transparent;font:14px/1.5 system-ui,sans-serif}",
  ".warn ul{margin:6px 0 0;padding-left:18px}",
  ".ok{background:var(--okbg);color:var(--okfg);border-color:transparent;font:14px/1.5 system-ui,sans-serif}",
  ".stack{background:var(--mark);border-left:3px solid var(--accent);padding:8px 12px;margin:8px 0;border-radius:0 4px 4px 0}",
  ".label{font:600 11px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);display:block;margin-bottom:2px}",
  "ul.items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}",
  "code{display:block;font:13px ui-monospace,Consolas,monospace;background:var(--mark);padding:6px 8px;border-radius:3px;overflow-wrap:anywhere;margin-bottom:8px}",
  "p{margin:0 0 8px}",
].join("\n");
