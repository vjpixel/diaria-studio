/** Editorial pool selection (#10794). Pure; rejected candidates remain reviewable in reserve. */
import { decodeHtmlEntities } from "./clean-summary.ts";
import { canonicalize } from "./url-utils.ts";
import { findSameFactDemotionMatch, type PublishedDestaque } from "./same-fact-demotion.ts";
import { sameStorySignal } from "./story-grouping.ts";
import type { ApprovedJson, StageArticle } from "./apply-stage2-caps.ts";

export const POOL_PAST_WINDOW = 7;

export function lowSignalFormat(a: StageArticle): string | null {
  if (a.editor_submitted === true || a.flag === "editor_submitted") return null;
  try {
    const u = new URL(a.url ?? "");
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (["x.com", "twitter.com"].includes(host) && /^\/[^/]+\/status\/\d+\/?$/.test(u.pathname)) return "social-post";
    if (host === "huggingface.co" && /^\/[^/]+\/[^/]+\/?$/.test(u.pathname) && !/^\/(datasets|spaces|learn|blog|docs|papers|collections)\//.test(u.pathname)) return "model-card";
  } catch { /* Missing/malformed URLs do not prove a low-signal format. */ }
  return /^\s*\d+\s+melhores\b/i.test(a.title ?? "") ? "listicle" : null;
}

/** Narrow bilingual fact anchors for coverage without figures (#10794 fixtures).
 * Each signature needs an entity AND two independent factual details. A company
 * or a product alone is never sufficient; unrelated follow-ups remain eligible.
 */
export function poolFactAnchors(text: string): Set<string> {
  const t = decodeHtmlEntities(text).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const signatures: Array<[string, RegExp, RegExp, RegExp]> = [
    ["legal-practice", /\benter\b/, /\boab(?:-sp)?\b/, /advoca|advogad|lawyer|process|judici/],
    ["android-message-scams", /google|circle to search/, /mensage|messages?|texts?/, /golp|scam/],
    ["public-benefit-shares", /anthropic/, /public benefit|beneficio publico/, /shares|acoes|fundo|fund\b/],
    ["gemini-work-apps", /gemini/, /work|trabalho|copiloto/, /apps|gmail|workspace|agent/],
    ["state-child-lawsuit", /openai/, /states|estados|estaduais/, /kids|children|criancas|minors|menores/],
    ["employment-restructure", /anthropic/, /workforce|employment|forca de trabalho/, /junior|meetings|restructur|hiring|contratac|reorganiz/],
    ["claude-explainers", /claude/, /explainers|videos explicativos/, /dashboards|motion|dados da.*empresa/],
  ];
  return new Set(signatures.filter(([, entity, detail, other]) => entity.test(t) && detail.test(t) && other.test(t)).map(([key]) => key));
}

export function curatePool(approved: ApprovedJson, past: PublishedDestaque[] = []): ApprovedJson {
  const references: PublishedDestaque[] = (approved.highlights ?? []).map((h, i) => {
    const a = h.article ?? h;
    return { aammdd: "current", n: i + 1, url: String(a.url ?? h.url ?? ""), title: String(a.title ?? ""), text: String(a.summary ?? "") };
  });
  references.push(...past);
  const out = { ...approved };
  const reserve: Array<{ bucket: string; article: StageArticle; reason: string; matched_url?: string }> = [];
  // Preserve the gate's ranking, including its cross-bucket tie order.
  for (const bucket of ["lancamento", "radar", "use_melhor", "video"] as const) {
    if (!approved[bucket]) continue;
    const kept: StageArticle[] = [];
    for (const a of approved[bucket]!) {
      const format = bucket === "radar" || bucket === "lancamento" ? lowSignalFormat(a) : null;
      const candidate = { url: a.url ?? "", title: a.title ?? "", text: String(a.summary ?? "") };
      const exactHighlight = (approved.highlights ?? []).some(h => {
        const url = h.article?.url ?? h.url;
        return url && a.url && canonicalize(url) === canonicalize(a.url);
      });
      // Exact overlap is handled by the existing caps report.
      const match = exactHighlight ? null : findSameFactDemotionMatch(candidate, references);
      const anchors = poolFactAnchors(`${candidate.title}\n${candidate.text}`);
      const story = exactHighlight ? undefined : references.find(p => {
        const previous = `${p.title}\n${p.source_title ?? ""}\n${p.text}`;
        return sameStorySignal(candidate.title, p.source_title ?? p.title) ||
          [...poolFactAnchors(previous)].some(key => anchors.has(key));
      });
      if (format || match || story) {
        reserve.push({ bucket, article: a, reason: format ?? "same-fact", matched_url: match?.matched_url ?? story?.url });
      } else {
        kept.push(a);
        if (!exactHighlight) references.push({ aammdd: "current", n: 0, url: candidate.url, title: candidate.title, text: candidate.text });
      }
    }
    out[bucket] = kept;
  }
  out.pool_reserve = [...(Array.isArray(approved.pool_reserve) ? approved.pool_reserve : []), ...reserve];
  return out;
}
