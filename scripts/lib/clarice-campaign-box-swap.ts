/** Campaign-scoped, snapshotted box overrides (#12249). No network access. */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { renderDivulgacaoBox } from "./mensal/monthly-render.ts";
import { rewriteAmazonAffiliateTagsInText, assertNoAmazonAffiliateTagIssues } from "./amazon-affiliate.ts";
import { stripCtaArrows, normalizeNumericArrows } from "./shared/arrow-glyph.ts";

export interface BoxSwap { position: number; title: string; snippet: string; html: string }
export function boxSwapPath(segmentsDir: string, campaignId: number): string {
  return resolve(segmentsDir, "campaign-box-swaps", campaignId + ".json");
}
const plain = (s: string): string => s.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").trim();

/** Match the monthly renderer's panel tables; balance nested CTA/image tables. */
export function listCampaignBoxes(html: string): { start: number; end: number; title: string }[] {
  const boxes: { start: number; end: number; title: string }[] = [];
  const opening = /<table\b[^>]*style="border-radius:12px;background:[^"]*"[^>]*>/g;
  for (const match of html.matchAll(opening)) {
    const startTable = match.index!;
    const tags = /<\/?table\b[^>]*>/g;
    tags.lastIndex = startTable;
    let depth = 0, end = -1;
    for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
      depth += tag[0].startsWith("</") ? -1 : 1;
      if (depth === 0) { end = tags.lastIndex; break; }
    }
    if (end < 0) throw new Error("Box com table incompleta");
    const before = html.slice(0, startTable);
    const kickerStart = before.lastIndexOf('<table ');
    // Kicker has no nested table and immediately precedes the panel.
    const kicker = before.slice(kickerStart);
    if (kickerStart < 0 || !kicker.includes("text-transform:uppercase") || !kicker.endsWith("</table>")) continue;
    const body = html.slice(startTable, end);
    const heading = body.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/);
    boxes.push({ start: kickerStart, end, title: heading ? plain(heading[1]) : "" });
  }
  return boxes;
}
export function prepareBoxSwap(html: string, selector: string, snippetPath: string): BoxSwap {
  const boxes = listCampaignBoxes(html);
  const matches = /^\d+$/.test(selector)
    ? boxes.filter((_, i) => i + 1 === Number(selector))
    : boxes.filter(b => b.title === selector.trim());
  if (matches.length !== 1) throw new Error("--swap-box deve identificar exatamente um box (posição 1-based entre TODOS os boxes, ou título exato). Disponíveis: " + boxes.map((b,i) => (i+1) + ": " + b.title).join("; "));
  const raw = readFileSync(resolve(snippetPath), "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!raw) throw new Error("Snippet vazio: " + snippetPath);
  const clean = stripCtaArrows(normalizeNumericArrows(raw));
  const rendered = rewriteAmazonAffiliateTagsInText(renderDivulgacaoBox("DIVULGAÇÃO\n\n" + clean), "clarice");
  assertNoAmazonAffiliateTagIssues(rendered, "clarice");
  return { position: boxes.indexOf(matches[0]) + 1, title: matches[0].title, snippet: snippetPath, html: rendered };
}
export function applyBoxSwap(html: string, swap: BoxSwap): string {
  const box = listCampaignBoxes(html)[swap.position - 1];
  if (!box || box.title !== swap.title) throw new Error("Override de box não corresponde ao draft atual; refaça --swap-box explicitamente.");
  return html.slice(0, box.start) + swap.html + html.slice(box.end);
}
export function applyStoredBoxSwap(html: string, segmentsDir: string, campaignId: number): string {
  const path = boxSwapPath(segmentsDir, campaignId);
  if (!existsSync(path)) return html;
  const swap = JSON.parse(readFileSync(path, "utf8")) as BoxSwap;
  if (!Number.isInteger(swap.position) || swap.position < 1 || typeof swap.title !== "string" || typeof swap.html !== "string" || !swap.html) throw new Error("Override de box inválido: " + path);
  return applyBoxSwap(html, swap);
}
export function saveBoxSwap(segmentsDir: string, campaignId: number, swap: BoxSwap): void {
  const path = boxSwapPath(segmentsDir, campaignId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path + ".tmp", JSON.stringify(swap, null, 2) + "\n");
  renameSync(path + ".tmp", path);
}
