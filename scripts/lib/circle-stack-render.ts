/**
 * circle-stack-render.ts (#10904)
 *
 * Monta (em Markdown) o post da edição semanal da diar.ia.br para o espaço "Radar de
 * Notícias Stack" (Circle da Stack) a partir da seleção por interesse dos
 * alunos (`circle-stack-select.ts`, gravada em
 * `data/weekly/{cycle}/_internal/circle-stack-selection.json`).
 *
 * Estrutura (#11186): título = título do D1 · abertura (resumo da semana com
 * a 1ª frase de cada destaque, ver `circleStackSummaryOpening`) · Destaques da semana (título com link da fonte, corpo e
 * "Por que isso importa:" iguais aos da edição diária) · Lançamentos · Use melhor · Radar ·
 * Outros destaques da semana (só o que não apareceu acima) · última linha ("Assine a diar.ia.br. Chega de segunda a
 * sexta...", link e fecho na mesma linha).
 *
 * Sem capa por destaque: o contrato do webhook da Stack não aceita imagem no
 * texto (`buildStackPostPayload` recusa `![](...)`, `stack-webhook.ts`). A capa
 * 2:1 da estrutura alvo do #11186 depende de a Stack aceitar imagem.
 *
 * `stackNote` (opcional, por item): texto escrito para o público da Stack
 * (o ângulo de quem constrói). Nos itens de lista, SUBSTITUI a descrição
 * (`body`). Nos destaques é ignorado: título, corpo e "Por que isso importa"
 * saem iguais aos da diária (pedido do editor, 23/10/2026 — poupa revisão).
 * Nunca é gerado aqui — vem preenchido na seleção.
 *
 * Regras herdadas da newsletter (context/editorial-rules.md):
 *   - "Por que isso importa:" em parágrafo próprio.
 *   - Nunca seta (→/←) em link ou CTA (#9721).
 *   - Título do item entra literal, exceto colchetes (viram parênteses) e barra
 *     invertida (escapada), para não quebrar o rótulo do link.
 *
 * UTM do canal: `utm_source=stack&utm_medium=circle&
 * utm_campaign=stack-{cycle}&utm_content=edicao|cta-fim` — só nos links
 * para a diar.ia.br. Link de fonte sai sem UTM, como na newsletter.
 */

export const CIRCLE_STACK_UTM_SOURCE = "stack";
export const CIRCLE_STACK_UTM_MEDIUM = "circle";
export const CIRCLE_STACK_SUBSCRIBE_BASE_URL = "https://diar.ia.br";

export type CircleStackUtmContent = "edicao" | "cta-fim";

/**
 * Abertura de reserva: só entra quando nenhum destaque rende uma frase de
 * resumo (`circleStackSummaryOpening` devolve null).
 */
export const DEFAULT_CIRCLE_STACK_OPENING =
  "A edição semanal da diar.ia.br para quem constrói com IA: o que saiu na semana sobre ferramentas, agentes, automação e produto.";

/** Fecho fixo do parágrafo de resumo da semana (#11186). */
export const CIRCLE_STACK_SUMMARY_TAIL = "Abaixo, o que importa para quem constrói com IA.";

/** Teto de uma frase de resumo; acima disso o destaque fica fora da abertura. */
export const CIRCLE_STACK_SUMMARY_SENTENCE_MAX = 280;

/** Cauda da última linha, logo depois de "[Assine a diar.ia.br](url). " — não é parágrafo solto. */
export const DEFAULT_CIRCLE_STACK_CLOSING =
  "Chega de segunda a sexta, de graça, no seu e-mail.";

/** Rótulo do link de assinatura; abre a última linha: "[Assine a diar.ia.br](url). {closing}". */
const CTA_FIM_LABEL = "Assine a diar.ia.br";

export interface CircleStackItem {
  editionDate: string;
  url: string;
  title: string;
  /** Título como veio da edição (#11005), para auditoria quando `title` foi traduzido. */
  titleOriginal?: string;
  /**
   * O editor confirmou o `title` como está mesmo sem sinal de português (nome
   * de produto, #11161). Sem isso, o `--publish` recusa título sem acento nem
   * palavra funcional do português ("Codex Launch Notes").
   */
  titleReviewed?: boolean;
  body: string;
  why: string;
  stackNote?: string;
  /**
   * Posição do destaque na edição de origem (1..3). Quando presente, o link
   * "Na edição de DD/MM" vai direto ao destaque (`/p/{slug}#dN`, #11003) em
   * vez do topo da página. Ausente (seleção antiga, item de seção) = topo.
   */
  destaqueN?: number;
}

export interface CircleStackEdition {
  editionDate: string;
  url: string;
  destaques: string[];
}

/** Shape de `circle-stack-selection.json` que o render consome. */
export interface CircleStackSelection {
  cycle: string;
  contentWindow: string[];
  destaques: CircleStackItem[];
  lancamentos: CircleStackItem[];
  useMelhor: CircleStackItem[];
  radar: CircleStackItem[];
  weeklyEditions: CircleStackEdition[];
  /**
   * Abertura escrita à mão na seleção (#11186). Vence o resumo automático;
   * perde para `--opening-file`. Ausente/vazia = resumo automático.
   */
  opening?: string;
}

export interface CircleStackRenderOptions {
  opening?: string;
  closing?: string;
  /** Link de assinatura alternativo (ex: link rastreado da própria Stack). Sem UTM adicionada se informado. */
  subscribeUrl?: string;
}

export interface CircleStackRendered {
  title: string;
  /** Corpo em Markdown — o webhook da Stack remove HTML. */
  markdown: string;
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

/**
 * Pure: aponta a URL da edição para o destaque N (`#dN`, âncora gravada por
 * `site-destaque-anchors.ts`, #11003). Fora de 1..3 devolve a URL intacta —
 * âncora inexistente só deixaria o leitor no topo, mas não há por que gravar
 * um fragmento que a página não tem.
 */
export function withDestaqueAnchor(url: string, destaqueN: number | undefined): string {
  if (destaqueN === undefined || !Number.isInteger(destaqueN) || destaqueN < 1 || destaqueN > 3) return url;
  const u = new URL(url);
  u.hash = `d${destaqueN}`;
  return u.toString();
}

/** Pure: `AAMMDD` → `DD/MM`. */
export function ddmm(aammdd: string): string {
  if (!/^\d{6}$/.test(aammdd)) throw new Error(`AAMMDD inválido: ${aammdd}`);
  return `${aammdd.slice(4, 6)}/${aammdd.slice(2, 4)}`;
}

/**
 * Pure: título do post — repete o título do 1º destaque do post (`sel.destaques[0]`, ordem da seleção;
 * não é o `destaqueN === 1` da diária). Pedido do editor 26/10/2026, antes era "Semana de DD/MM".
 * Título vazio cai no "Semana de DD/MM" da segunda da semana de conteúdo.
 */
export function circleStackTitle(contentWindow: string[], d1Title?: string): string {
  if (contentWindow.length === 0) throw new Error("contentWindow vazio");
  const d1 = d1Title?.replace(/\s+/g, " ").trim();
  if (d1) return d1;
  return `Semana de ${ddmm(contentWindow[0])}`;
}

/** Pure: rótulo de link sem colchetes (quebrariam a sintaxe `[rótulo](url)`). */
function mdLabel(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim();
}

/** Pure: URL segura dentro de `( )` do Markdown. */
function mdUrl(u: string): string {
  return u.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s/g, "%20");
}

function link(href: string, label: string): string {
  return `[${mdLabel(label)}](${mdUrl(href)})`;
}

/** Pure: parágrafos separados por linha em branco (o webhook da Stack trata linha em branco como parágrafo). */
function paragraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Pure: tira a marcação Markdown que não cabe numa frase corrida (negrito, itálico, link). */
function plainText(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pure (#11186): primeira frase do primeiro parágrafo de um texto. Corta no
 * primeiro `.`/`!`/`?`/`…` seguido de espaço e maiúscula (ou do fim do
 * parágrafo); "1.000" e "US$ 0,04" não cortam porque não têm espaço depois do
 * ponto. Acima de `CIRCLE_STACK_SUMMARY_SENTENCE_MAX` devolve null.
 */
export function firstSentence(text: string): string | null {
  const para = plainText(paragraphs(text)[0] ?? "");
  if (!para) return null;
  const m = /[.!?…](?=\s+["“(]?[A-ZÀ-ÖØ-Þ])/u.exec(para);
  let s = m ? para.slice(0, m.index + 1) : para;
  if (!/[.!?…]$/.test(s)) s += ".";
  return s.length <= CIRCLE_STACK_SUMMARY_SENTENCE_MAX ? s : null;
}

/**
 * Pure (#11186): parágrafo de abertura que resume a semana com os fatos dos
 * destaques — a primeira frase do corpo de cada um, na ordem do post, e o
 * fecho fixo. Determinístico de propósito (sem LLM): a frase de abertura do
 * corpo é a que o writer escreve para carregar o fato principal. Nenhum
 * destaque com frase utilizável = null (o render cai na abertura de reserva).
 */
export function circleStackSummaryOpening(destaques: Pick<CircleStackItem, "body">[]): string | null {
  const sentences = destaques.map((d) => firstSentence(d.body)).filter((s): s is string => s !== null);
  if (sentences.length === 0) return null;
  return [...sentences, CIRCLE_STACK_SUMMARY_TAIL].join(" ");
}

function listSection(heading: string, items: CircleStackItem[]): string[] {
  if (items.length === 0) return [];
  const lines = items.map((it) => {
    const desc = (it.stackNote?.trim() || it.body.trim()).replace(/\s*\n+\s*/g, " ");
    return `- ${link(it.url, it.title)}${desc ? `: ${desc}` : ""}`;
  });
  return [`## ${heading}`, lines.join("\n")];
}

/** Pure: monta título + corpo em Markdown do post (formato aceito pelo webhook da Stack). */
export function renderCircleStackPost(sel: CircleStackSelection, opts: CircleStackRenderOptions = {}): CircleStackRendered {
  if (sel.destaques.length === 0) throw new Error(`Seleção ${sel.cycle} sem destaques — nada a publicar`);

  const blocks: string[] = [];

  // #11186: --opening-file > `opening` da seleção > resumo dos destaques > reserva fixa.
  const opening =
    opts.opening?.trim() ||
    (typeof sel.opening === "string" ? sel.opening.trim() : "") ||
    circleStackSummaryOpening(sel.destaques) ||
    DEFAULT_CIRCLE_STACK_OPENING;
  blocks.push(...paragraphs(opening));

  blocks.push(`## Destaques da semana`);
  for (const h of sel.destaques) {
    // Título com link para a fonte, como na newsletter; sem "Leia na fonte"/"Na edição de" (pedido do editor, 23/10/2026).
    blocks.push(`### ${link(h.url, h.title)}`);
    blocks.push(...paragraphs(h.body));
    // #11068 (decisão do editor, 26/10/2026): aqui o `why` vai cru de propósito.
    // Ele aparece ROTULADO ("Por que isso importa:"), e o padrão de resumo da
    // #11062 (weekly-summary-writer) só vale onde o texto aparece sem rótulo,
    // como a legenda da retro semanal (format-weekly-social.ts).
    if (h.why.trim()) blocks.push(`**Por que isso importa:**`, ...paragraphs(h.why));
  }

  blocks.push(...listSection("Lançamentos", sel.lancamentos));
  blocks.push(...listSection("Use melhor", sel.useMelhor));
  blocks.push(...listSection("Radar", sel.radar));

  // "Outros destaques da semana" (pedido do editor, 23/10/2026): só os destaques das edições
  // que NÃO apareceram acima (comparação por título normalizado). Data sem título restante some.
  const norm = (t: string) => String(t).replace(/\s+/g, " ").trim().toLowerCase();
  // #11186: o título da edição (weeklyEditions) é o original; item com `title` traduzido/reescrito
  // na seleção só é reconhecido pelo `titleOriginal` — sem ele, o D1 voltava em "Outros destaques".
  const shown = new Set(
    [...sel.destaques, ...sel.lancamentos, ...sel.useMelhor, ...sel.radar].flatMap((it) =>
      [it.title, it.titleOriginal].filter((t): t is string => typeof t === "string" && t.trim() !== "").map(norm),
    ),
  );
  const others = sel.weeklyEditions
    .map((e) => ({ e, titles: e.destaques.map((t) => String(t).replace(/\s+/g, " ").trim()).filter((t) => t && !shown.has(norm(t))) }))
    .filter((x) => x.titles.length > 0);
  if (others.length > 0) {
    blocks.push(`## Outros destaques da semana`);
    for (const { e, titles } of others) {
      // Sem negrito em volta: o conversor do webhook da Stack não reconhece link dentro de **…**
      // e publica o Markdown cru (achado ao vivo, post de 23/10/2026).
      blocks.push(link(buildCircleStackUrl(e.url, sel.cycle, "edicao"), ddmm(e.editionDate)));
      blocks.push(titles.map((t) => `- ${t}`).join("\n"));
    }
  }


  // Última linha do post: link de assinatura + ÚLTIMO parágrafo do fecho (pedido do editor, 23/10/2026).
  // Parágrafos anteriores do fecho (só com --closing-file de várias linhas) vêm antes, para o CTA
  // continuar sendo a última linha. `paragraphs()` nunca devolve vazio aqui (o default cobre fecho vazio).
  const subscribeHref = opts.subscribeUrl?.trim() || buildCircleStackUrl(CIRCLE_STACK_SUBSCRIBE_BASE_URL, sel.cycle, "cta-fim");
  const closingParas = paragraphs(opts.closing?.trim() || DEFAULT_CIRCLE_STACK_CLOSING);
  const closingLast = closingParas.pop() as string;
  blocks.push(...closingParas, `${link(subscribeHref, CTA_FIM_LABEL)}. ${closingLast}`);

  return { title: circleStackTitle(sel.contentWindow, sel.destaques[0]?.title), markdown: blocks.join("\n\n") };
}
