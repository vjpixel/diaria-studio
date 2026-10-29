import { BOX0_SENTINEL } from "../newsletter-parse.ts";

/** #11481: advisory only; never infer or reclassify a box in the renderer. */
export function checkBox0MissingSentinel(md: string) {
  const firstHighlight = /^\*\*DESTAQUE\s+1\b/m.exec(md);
  const warnings: string[] = [];
  if (!firstHighlight) return { ok: true, warnings };
  const intro = md.slice(0, firstHighlight.index).replace(/\r\n/g, "\n");
  for (const block of intro.split(/^[ \t]*---[ \t]*$/m).slice(1)) {
    if (block.includes(BOX0_SENTINEL)) continue;
    const paragraphs = block.trim().split(/\n\s*\n/);
    // A normal bold-wrapped callout has no separate title/body/CTA shape.
    if (paragraphs.length < 3 || !/^\*\*[^*\n]+\*\*$/.test(paragraphs[0])) continue;
    // The monthly champions/draw callout belongs to the intro, not slot 0.
    if (/campe[õo]es|sorteio/i.test(paragraphs[0])) continue;
    if (!/^\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)$/.test(paragraphs.at(-1)!)) continue;
    if (!paragraphs.slice(1, -1).some((p) => /[\p{L}]/u.test(p) && !p.startsWith("**"))) continue;
    warnings.push(`Parece box do slot 0 sem ${BOX0_SENTINEL}: ${paragraphs[0]}. Se for um box, insira o marcador imediatamente antes do título; callouts normais não precisam dele.`);
  }
  return { ok: warnings.length === 0, warnings };
}
