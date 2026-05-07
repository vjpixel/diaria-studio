/**
 * gate-banner.ts (#751)
 *
 * Helper para renderizar banners de gate com alinhamento correto para
 * terminais que exibem emoji como caracteres de 2 células visuais.
 *
 * O LLM (orchestrator) costuma contar codepoints em vez de células visuais,
 * o que quebra o alinhamento da borda direita em banners com `█`. Este módulo
 * calcula a largura visual real e preenche corretamente.
 */

/**
 * Visual width of a string in terminal cells.
 * Emoji are 2 cells; most other chars are 1.
 */
export function visualWidth(s: string): number {
  let w = 0;
  for (const char of [...s]) {
    const cp = char.codePointAt(0)!;
    // Emoji ranges (simplified — covers common emoji)
    if (
      (cp >= 0x1f300 && cp <= 0x1faff) || // Misc symbols, emoticons, transport
      (cp >= 0x2600 && cp <= 0x27bf) ||   // Misc symbols
      (cp >= 0xfe00 && cp <= 0xfe0f)      // Variation selectors (skin tones etc)
    ) {
      w += 2;
    } else if (cp > 0x7f && cp < 0xff00) {
      // CJK and other wide chars — conservative: treat as 1 unless clearly wide
      w += 1;
    } else {
      w += 1;
    }
  }
  return w;
}

/**
 * Pad string to target visual width using fill character.
 */
export function padRightVisual(s: string, target: number, fill = " "): string {
  const w = visualWidth(s);
  const needed = Math.max(0, target - w);
  return s + fill.repeat(needed);
}

/**
 * Render a bordered gate banner with correct emoji-aware alignment.
 *
 * @param title   Title line (may contain emoji)
 * @param lines   Content lines (may contain emoji)
 * @param width   Total box width in terminal cells (default 50)
 */
export function renderGateBanner(
  title: string,
  lines: string[],
  width = 50,
): string {
  const inner = width - 2; // inside border chars
  const border = "█".repeat(width);
  const empty = "█" + " ".repeat(inner) + "█";

  function bodyLine(text: string): string {
    const padded = padRightVisual(text, inner);
    return "█" + padded + "█";
  }

  const rows = [
    border,
    empty,
    bodyLine("  " + title),
    empty,
    ...lines.map((l) => bodyLine("  " + l)),
    empty,
    border,
  ];

  return rows.join("\n");
}

/**
 * Render a halt banner — used when the pipeline cannot proceed (MCP
 * disconnect, subagent error, exception, ratelimit). Distinct from the
 * gate banner: the gate is an *expected* pause for editor approval; the
 * halt is an *unexpected* pause that the editor needs to notice fast.
 *
 * Differences vs `renderGateBanner` (#737):
 * - Title is hard-coded "🛑 PIPELINE PAROU 🛑" — quickly distinguishable
 *   from gate banners (yellow / `🟡 GATE`).
 * - Three structured fields (STAGE, MOTIVO, AÇÃO) — every halt explains
 *   what stopped and what the editor can do.
 * - No color codes embedded — caller (`scripts/render-halt-banner.ts`)
 *   wraps with ANSI red on TTY only, so this lib stays pure.
 */
export function renderHaltBanner(opts: {
  stage: string;
  reason: string;
  action: string;
  width?: number;
}): string {
  return renderGateBanner(
    "🛑  PIPELINE PAROU  🛑",
    [
      `STAGE:  ${opts.stage}`,
      `MOTIVO: ${opts.reason}`,
      `AÇÃO:   ${opts.action}`,
    ],
    opts.width ?? 60,
  );
}
