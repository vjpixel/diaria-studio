/** Editorial pool selection (#10794). Pure; rejected candidates remain reviewable in reserve. */
import { decodeHtmlEntities } from "./clean-summary.ts";
import { canonicalize } from "./url-utils.ts";
import { findSameFactDemotionMatch, type PublishedDestaque } from "./same-fact-demotion.ts";
import { sameStorySignal } from "./story-grouping.ts";
import { createStoryIndex, type IntraEditionItem } from "./fact-recurrence.ts";
import type { ApprovedJson, StageArticle } from "./apply-stage2-caps.ts";

export const POOL_PAST_WINDOW = 7;

/**
 * #9785: item pinado pelo editor — nunca sai do pool por corte automático
 * (teto global do Stage 2, curadoria #10794). Cobre a submissão por e-mail
 * (`flag: "editor_submitted"`, `editor_submitted: true`) e o item incluído à
 * mão no gate (`flag: "editor_added"`, `source: "editor: incluído no gate"`,
 * visto na 261007 sem `score`). Re-exportado por `apply-stage2-caps.ts`.
 */
export function isEditorPinned(a: StageArticle): boolean {
  const flag = typeof a.flag === "string" ? a.flag : "";
  const source = typeof a.source === "string" ? a.source : "";
  return a.editor_submitted === true || flag.startsWith("editor") || /^editor\b/i.test(source);
}

export function lowSignalFormat(a: StageArticle): string | null {
  if (isEditorPinned(a)) return null;
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
  // #10987: toda alternativa ancorada em \b — sem isso `work` casava
  // "framework"/"network"/"workspace", `agent` casava "agentes" e `texts?`
  // casava "context"/"texto", e qualquer item "Gemini … Workspace" fechava a
  // assinatura sozinho. Prefixos de flexão (golp-, advoga-, restructur-) só
  // levam o \b inicial.
  const signatures: Array<[string, RegExp, RegExp, RegExp]> = [
    ["legal-practice", /\benter\b/, /\boab(?:-sp)?\b/, /\b(?:advoca|advogad|lawyer|process|judici)/],
    ["android-message-scams", /\bgoogle\b|\bcircle to search\b/, /\b(?:mensage(?:m|ns)|messages?|texts?)\b/, /\b(?:golp|scam)/],
    ["public-benefit-shares", /\banthropic\b/, /\b(?:public benefit|beneficio publico)\b/, /\b(?:shares|acoes|fundos?|funds?)\b/],
    ["gemini-work-apps", /\bgemini\b/, /\b(?:work|trabalho|copiloto)\b/, /\b(?:apps?|gmail|workspace|agents?)\b/],
    ["state-child-lawsuit", /\bopenai\b/, /\b(?:states|estados|estaduais)\b/, /\b(?:kids|children|criancas|minors|menores)\b/],
    ["employment-restructure", /\banthropic\b/, /\b(?:workforce|employment|forca de trabalho)\b/, /\b(?:junior|meetings|restructur|hiring|contratac|reorganiz)/],
    ["claude-explainers", /\bclaude\b/, /\b(?:explainers|videos explicativos)\b/, /\b(?:dashboards|motion)\b|\bdados da\b.*\bempresa\b/],
  ];
  return new Set(signatures.filter(([, entity, detail, other]) => entity.test(t) && detail.test(t) && other.test(t)).map(([key]) => key));
}

function storyItem(a: StageArticle, label: string): IntraEditionItem {
  return { title: decodeHtmlEntities(String(a.title ?? "")), summary: decodeHtmlEntities(String(a.summary ?? "")), url: String(a.url ?? ""), label };
}

export function curatePool(approved: ApprovedJson, past: PublishedDestaque[] = []): ApprovedJson {
  const references: PublishedDestaque[] = (approved.highlights ?? []).map((h, i) => {
    const a = h.article ?? h;
    return { aammdd: "current", n: i + 1, url: String(a.url ?? h.url ?? ""), title: String(a.title ?? ""), text: String(a.summary ?? "") };
  });
  references.push(...past);
  // #11116/#11244: MESMA HISTÓRIA de incidente dentro da edição (pool × destaque,
  // pool × pool anterior). Mesma regra do aviso do Stage 4 (#11173), aqui
  // aplicada antes do writer: o item vai pra reserva e o próximo do bucket ocupa
  // a vaga. Medido nos pools renderizados de 260801-261027: 6 itens sinalizados,
  // 5 cortados pelo editor no gate 4. Destaque de edição ANTERIOR não entra
  // (2 de 5 cortados na mesma régua): segue só como aviso (#11083).
  const allPool: IntraEditionItem[] = (["lancamento", "radar", "use_melhor", "video"] as const)
    .flatMap(b => (approved[b] ?? []).map(a => storyItem(a, b)));
  const storyIndex = createStoryIndex(
    (approved.highlights ?? []).map((h, i) => storyItem(h.article ?? h, `D${i + 1}`)),
    allPool,
  );
  const out = { ...approved };
  const reserve: Array<{ bucket: string; article: StageArticle; reason: string; matched_url?: string }> = [];
  // Preserve the gate's ranking, including its cross-bucket tie order.
  for (const bucket of ["lancamento", "radar", "use_melhor", "video"] as const) {
    if (!approved[bucket]) continue;
    const kept: StageArticle[] = [];
    for (const a of approved[bucket]!) {
      // #10987: pinado pelo editor nunca vai pra reserva — nem por formato,
      // nem por mesmo fato/história (#9785). Fica de fora das referências:
      // escolha do editor não derruba outro item do pool.
      if (isEditorPinned(a)) {
        kept.push(a);
        continue;
      }
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
      const recurrence = exactHighlight || format || match || story ? null : storyIndex.match(storyItem(a, bucket));
      if (format || match || story) {
        reserve.push({ bucket, article: a, reason: format ?? "same-fact", matched_url: match?.matched_url ?? story?.url });
      } else if (recurrence) {
        reserve.push({ bucket, article: a, reason: "same-story", matched_url: recurrence.matched_url });
      } else {
        kept.push(a);
        if (!exactHighlight) {
          references.push({ aammdd: "current", n: 0, url: candidate.url, title: candidate.title, text: candidate.text });
          storyIndex.add(storyItem(a, bucket));
        }
      }
    }
    out[bucket] = kept;
  }
  out.pool_reserve = [...(Array.isArray(approved.pool_reserve) ? approved.pool_reserve : []), ...reserve];
  return out;
}
