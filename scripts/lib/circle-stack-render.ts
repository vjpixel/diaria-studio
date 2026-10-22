/**
 * circle-stack-render.ts (#10904)
 *
 * Monta o post semanal do espaço "Radar de Notícias Stack" (Circle da Stack)
 * a partir da MESMA seleção semanal do LinkedIn
 * (`data/weekly/{cycle}/_internal/ln-selection.json`, gerada por
 * `select-linkedin-weekly.ts`). Reusar a seleção é deliberado: o ranking por
 * clique da semana já está feito e revisado ali — o Circle é só mais uma
 * saída do mesmo conteúdo, não uma curadoria nova.
 *
 * Regras herdadas da newsletter (context/editorial-rules.md):
 *   - "Por que isso importa:" em parágrafo próprio.
 *   - Nunca seta (→/←) em link ou CTA (#9721).
 *   - Título do destaque entra literal.
 *
 * UTM própria do canal: `utm_source=stack&utm_medium=circle&
 * utm_campaign=stack-{cycle}&utm_content=edicao|cta-fim` — só nos links
 * para a diar.ia.br. Link de fonte (matéria original) sai sem UTM, como
 * na newsletter.
 */

export const CIRCLE_STACK_UTM_SOURCE = "stack";
export const CIRCLE_STACK_UTM_MEDIUM = "circle";
export const CIRCLE_STACK_SUBSCRIBE_BASE_URL = "https://diar.ia.br";

export type CircleStackUtmContent = "edicao" | "cta-fim";

export const DEFAULT_CIRCLE_STACK_OPENING =
  "Os destaques de IA da semana, escolhidos pela curadoria da diar.ia.br a partir do que os leitores mais leram na edição diária.";

export const DEFAULT_CIRCLE_STACK_CLOSING =
  "A diar.ia.br sai de segunda a sexta, de graça, no seu e-mail.";

const CTA_FIM_LABEL = "Assinar a diar.ia.br";

export interface CircleStackHeadline {
  editionDate: string;
  url: string;
  title: string;
  body: string;
  why: string;
}

export interface CircleStackUseMelhor {
  editionDate: string;
  url: string;
  title: string;
  body: string;
}

export interface CircleStackEdition {
  editionDate: string;
  url: string;
  destaques: string[];
}

/** Subconjunto de `ln-selection.json` que o render consome. */
export interface CircleStackSelection {
  cycle: string;
  contentWindow: string[];
  headlines: CircleStackHeadline[];
  useMelhor?: CircleStackUseMelhor | null;
  weeklyEditions: CircleStackEdition[];
}

export interface CircleStackRenderOptions {
  opening?: string;
  closing?: string;
  /** Link de assinatura alternativo (ex: link rastreado da própria Stack). Sem UTM adicionada se informado. */
  subscribeUrl?: string;
}

export interface CircleStackRendered {
  title: string;
  html: string;
}

export function circleStackCampaign(cycle: string): string {
  return `stack-${cycle}`;
}

/** Pure: adiciona o triplo UTM do canal + `utm_content`. */
export function buildCircleStackUrl(baseUrl: string, cycle: string, content: CircleStackUtmContent): string {
  const u = new URL(baseUrl);
  u.searchParams.set("utm_source", CIRCLE_STACK_UTM_SOURCE);
  u.searchParams.set("utm_medium", CIRCLE_STACK_UTM_MEDIUM);
  u.searchParams.set("utm_campaign", circleStackCampaign(cycle));
  u.searchParams.set("utm_content", content);
  return u.toString();
}

/** Pure: `AAMMDD` → `DD/MM`. */
export function ddmm(aammdd: string): string {
  if (!/^\d{6}$/.test(aammdd)) throw new Error(`AAMMDD inválido: ${aammdd}`);
  return `${aammdd.slice(4, 6)}/${aammdd.slice(2, 4)}`;
}

/** Pure: título do post — "Radar de Notícias Stack — semana de DD/MM a DD/MM". */
export function circleStackTitle(contentWindow: string[]): string {
  if (contentWindow.length === 0) throw new Error("contentWindow vazio");
  return `Radar de Notícias Stack — semana de ${ddmm(contentWindow[0])} a ${ddmm(contentWindow[contentWindow.length - 1])}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`);
}

function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

/** Pure: monta título + HTML do post. */
export function renderCircleStackPost(sel: CircleStackSelection, opts: CircleStackRenderOptions = {}): CircleStackRendered {
  if (sel.headlines.length === 0) throw new Error(`Seleção ${sel.cycle} sem manchetes — nada a publicar`);

  const editionUrlByDate = new Map(sel.weeklyEditions.map((e) => [e.editionDate, e.url]));
  const out: string[] = [];

  out.push(...paragraphs(opts.opening?.trim() || DEFAULT_CIRCLE_STACK_OPENING));

  for (const h of sel.headlines) {
    out.push(`<h2>${escapeHtml(h.title)}</h2>`);
    out.push(...paragraphs(h.body));
    if (h.why.trim()) out.push(`<p><strong>Por que isso importa:</strong></p>`, ...paragraphs(h.why));
    const editionUrl = editionUrlByDate.get(h.editionDate);
    const links = [link(h.url, "Leia na fonte")];
    if (editionUrl) {
      links.push(link(buildCircleStackUrl(editionUrl, sel.cycle, "edicao"), `Na edição de ${ddmm(h.editionDate)}`));
    }
    out.push(`<p>${links.join(" | ")}</p>`);
  }

  if (sel.useMelhor) {
    out.push(`<h2>Use melhor</h2>`);
    out.push(`<p>${link(sel.useMelhor.url, sel.useMelhor.title)}</p>`);
    out.push(...paragraphs(sel.useMelhor.body));
  }

  if (sel.weeklyEditions.length > 0) {
    out.push(`<h2>Edições da semana</h2>`);
    const items = sel.weeklyEditions.map(
      (e) =>
        `<li>${link(buildCircleStackUrl(e.url, sel.cycle, "edicao"), ddmm(e.editionDate))}: ${escapeHtml(e.destaques.join(" · "))}</li>`,
    );
    out.push(`<ul>\n${items.join("\n")}\n</ul>`);
  }

  out.push(...paragraphs(opts.closing?.trim() || DEFAULT_CIRCLE_STACK_CLOSING));
  const subscribeHref = opts.subscribeUrl?.trim() || buildCircleStackUrl(CIRCLE_STACK_SUBSCRIBE_BASE_URL, sel.cycle, "cta-fim");
  out.push(`<p>${link(subscribeHref, CTA_FIM_LABEL)}</p>`);

  return { title: circleStackTitle(sel.contentWindow), html: out.join("\n") };
}
