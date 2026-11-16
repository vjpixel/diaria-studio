/**
 * scripts/lib/linkedin-feed-mention-audit.ts (#13261)
 *
 * Confere se a menção "@diar.ia.br" do post de feed do artigo semanal do
 * LinkedIn (`/diaria-linkedin-semanal`, Passo 9) virou menção de verdade à
 * página, e não texto puro.
 *
 * Por que existe: a #13049 resolveu a menção só como passo manual (o editor
 * apaga o "@diar.ia.br" colado e escolhe a página na lista de menções do
 * LinkedIn). O passo é fácil de pular e o texto entregue é idêntico com ou
 * sem a menção real; no ciclo de 16/11/2026 o post saiu com "@diar.ia.br" em
 * texto puro, que o LinkedIn auto-linkou para o site (`diar.ia.br`), não para
 * a página da empresa.
 *
 * Por que não pela API: o post de feed é o campo "Tell your network..." do
 * diálogo de publicação do artigo da newsletter, e artigo de newsletter não
 * tem endpoint de publicação na API do LinkedIn. O token pessoal só tem
 * `w_member_social` (`LINKEDIN_PERSONAL_SCOPES`), sem escopo de leitura de
 * post, então também não há GET do post depois de publicado. A conferência
 * lê o DOM pelo Claude in Chrome (snippet `FEED_MENTION_DOM_SNIPPET`), no
 * diálogo antes de agendar ou no post já publicado, e decide aqui.
 *
 * Módulo puro, sem I/O. CLI: `scripts/weekly-feed-post-mention-audit.ts`.
 */

/** Uma âncora lida do DOM: texto + origem/caminho (nunca a query, que o filtro do `javascript_tool` bloqueia). */
export interface FeedMentionAnchor {
  text: string;
  base?: string;
  href?: string;
}

/** Elemento que o editor do LinkedIn marca como menção (atributo/classe de menção). */
export interface FeedMentionEntity {
  text: string;
  urn?: string | null;
}

/** O que o snippet devolve: texto visível do campo + âncoras + elementos de menção. */
export interface FeedMentionDom {
  text: string;
  anchors?: FeedMentionAnchor[];
  mentions?: FeedMentionEntity[];
}

/** A página a mencionar (de `publishing.shorts.diaria_profiles.linkedin`). */
export interface FeedMentionTarget {
  /** Nome exato da página, ex. "diar.ia.br". */
  name: string;
  /** URN da organização, ex. "urn:li:organization:110742958" (null = desconhecido). */
  urn: string | null;
}

export type FeedMentionStatus =
  /** Texto revisado não pede menção: nada a conferir. */
  | "not-needed"
  /** Menção real (elemento de menção ou link para a página da empresa). */
  | "mention"
  /** "@diar.ia.br" continua digitado: o LinkedIn auto-linka para o site. */
  | "plain-text"
  /** O nome virou link para o site (ou encurtador), não para a página. */
  | "site-link"
  /** O nome da página sumiu do campo. */
  | "missing"
  /** Nome presente sem "@", mas sem sinal de menção no DOM: confirmar à vista. */
  | "unverified";

export interface FeedMentionAudit {
  ok: boolean;
  status: FeedMentionStatus;
  message: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** O texto revisado (`_internal/ln-feed-post.txt`) traz "@{name}"? Só então há menção a conferir. */
export function feedPostWantsMention(sourceText: string, name: string): boolean {
  return new RegExp(`@${escapeRe(name)}(?![\\p{L}\\p{N}_.-]*[\\p{L}\\p{N}_])`, "u").test(sourceText);
}

function hostOf(a: FeedMentionAnchor): { host: string; path: string } | null {
  const raw = a.base ?? a.href;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return { host: u.hostname.toLowerCase().replace(/^www\./, ""), path: u.pathname };
  } catch {
    return null;
  }
}

function orgId(urn: string | null): string | null {
  const m = urn?.match(/^urn:li:organization:(\d+)$/);
  return m ? m[1] : null;
}

/**
 * Decide se a menção do post de feed é real. Ordem: texto puro com "@" ganha
 * de tudo (é a falha do incidente); depois link para o site; depois sinal
 * positivo de menção; o resto é "missing"/"unverified", ambos falha: avisar
 * o editor é melhor que aprovar no escuro.
 */
export function auditFeedPostMention(input: {
  sourceText: string;
  dom: FeedMentionDom;
  target: FeedMentionTarget;
}): FeedMentionAudit {
  const { sourceText, dom, target } = input;
  const name = target.name;
  if (!feedPostWantsMention(sourceText, name)) {
    return { ok: true, status: "not-needed", message: `o texto revisado não tem "@${name}": nada a conferir.` };
  }
  const text = dom.text ?? "";
  if (feedPostWantsMention(text, name)) {
    return {
      ok: false,
      status: "plain-text",
      message:
        `"@${name}" ficou digitado em texto puro: o LinkedIn vai linkar para o site, não para a página. ` +
        `Apagar "@${name}", digitar "@${name.split(".")[0]}" e escolher a página ${name} na lista de menções.`,
    };
  }

  const nameLc = name.toLowerCase();
  const anchorsWithName = (dom.anchors ?? []).filter((a) => (a.text ?? "").toLowerCase().includes(nameLc));
  const id = orgId(target.urn);
  const siteHosts = new Set([nameLc, "lnkd.in"]);
  for (const a of anchorsWithName) {
    const h = hostOf(a);
    if (h && siteHosts.has(h.host)) {
      return {
        ok: false,
        status: "site-link",
        message:
          `"${name}" virou link para ${h.host}, não para a página da empresa. ` +
          `Apagar e escolher a página ${name} na lista de menções do LinkedIn.`,
      };
    }
  }

  const companyLink = anchorsWithName.some((a) => {
    const h = hostOf(a);
    return !!h && h.host.endsWith("linkedin.com") && h.path.startsWith("/company/");
  });
  const entity = (dom.mentions ?? []).some((m) => {
    if (id && m.urn && m.urn.includes(id)) return true;
    return (m.text ?? "").toLowerCase().includes(nameLc);
  });
  if (companyLink || entity) {
    return { ok: true, status: "mention", message: `menção à página ${name} confirmada no DOM.` };
  }

  if (!text.toLowerCase().includes(nameLc)) {
    return {
      ok: false,
      status: "missing",
      message: `"${name}" não aparece no post: a menção foi apagada sem ser escolhida na lista. Digitar "@${name.split(".")[0]}" e escolher a página.`,
    };
  }
  return {
    ok: false,
    status: "unverified",
    message:
      `"${name}" aparece sem "@", mas o DOM não mostra menção nem link para a página. ` +
      `Pedir ao editor que confirme à vista (a menção fica destacada e abre a página da empresa) antes de agendar.`,
  };
}

/**
 * Snippet para o `javascript_tool` do Claude in Chrome. Lê o campo do post
 * de feed (último `contenteditable` dentro do diálogo aberto) ou, sem
 * diálogo, o primeiro `contenteditable` da página. Devolve só origem+caminho
 * das âncoras (a query string volta `[BLOCKED]`, #10386).
 */
export const FEED_MENTION_DOM_SNIPPET = `(() => {
  const inDialog = [...document.querySelectorAll('[role="dialog"] [contenteditable="true"]')];
  const box = inDialog.length ? inDialog[inDialog.length - 1] : document.querySelector('[contenteditable="true"]');
  if (!box) return JSON.stringify({ error: "campo do post nao encontrado" });
  const base = (h) => { try { const u = new URL(h, location.href); return u.origin + u.pathname; } catch { return null; } };
  return JSON.stringify({
    text: box.innerText,
    anchors: [...box.querySelectorAll("a")].map((a) => ({ text: a.textContent, base: base(a.getAttribute("href") || "") })),
    mentions: [...box.querySelectorAll('[data-entity-urn], [data-mention], .ql-mention, [class*="mention"]')].map((e) => ({
      text: e.textContent,
      urn: e.getAttribute("data-entity-urn") || e.getAttribute("data-mention") || null,
    })),
  });
})()`;
