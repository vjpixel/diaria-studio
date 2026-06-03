/**
 * beehiiv-real-click.ts (#1764, #1705)
 *
 * Helpers pra "clique real de ponteiro" no Beehiiv via Chrome MCP.
 *
 * Ações de criação/aplicação no Beehiiv (criar post do template, aplicar
 * thumbnail, Schedule) são gateadas pelo React por **user-activation** —
 * `.click()` sintético via `javascript_tool` NÃO as dispara (#1198 Schedule,
 * #1764 "Use template", #1705 aplicar capa). O caminho correto: localizar o
 * elemento via JS, devolver as coords, e fazer um `computer.left_click` real.
 *
 * ⚠️ Gotcha de coords (#1764): o screenshot do claude-in-chrome pode vir em
 * largura diferente do viewport real (ex.: 1568px de screenshot vs 1910px de
 * viewport). O `computer` clica no espaço do **screenshot**, mas
 * `getBoundingClientRect` dá coords do **viewport** — converter por
 * `factor = screenshotWidth / viewportWidth`.
 */

export interface LocateRect {
  found: boolean;
  label: string;
  /** Coords no espaço do VIEWPORT (getBoundingClientRect). */
  rect?: { left: number; top: number; width: number; height: number; centerX: number; centerY: number };
  /** window.innerWidth no momento da medição (largura do viewport). */
  innerWidth?: number;
  error?: string;
}

export interface ScreenshotPoint {
  x: number;
  y: number;
  factor: number;
}

/** factor = screenshotWidth / viewportWidth. Pure. */
export function screenshotScaleFactor(screenshotWidth: number, viewportWidth: number): number {
  if (!viewportWidth || viewportWidth <= 0) return 1;
  return screenshotWidth / viewportWidth;
}

/**
 * Converte um resultado de locate (rect do viewport + innerWidth) no ponto de
 * clique em espaço de SCREENSHOT, pronto pro `computer.left_click`. Pure.
 * Lança se o locate não achou o elemento.
 */
export function resolveClickPoint(locate: LocateRect, screenshotWidth: number): ScreenshotPoint {
  if (!locate.found || !locate.rect || !locate.innerWidth) {
    throw new Error(`locate '${locate.label}' sem rect (found=${locate.found}): ${locate.error ?? ""}`);
  }
  const factor = screenshotScaleFactor(screenshotWidth, locate.innerWidth);
  return {
    x: Math.round(locate.rect.centerX * factor),
    y: Math.round(locate.rect.centerY * factor),
    factor,
  };
}

/**
 * Gera JS string pra `javascript_tool` que LOCALIZA um elemento (não clica) e
 * devolve seu rect + innerWidth, pro orchestrator fazer o clique real via
 * `computer.left_click` no ponto convertido por `resolveClickPoint`.
 *
 * @param label rótulo de debug
 * @param finderBody corpo JS de uma função sem args que retorna `Element|null`
 *                   (ex.: `return document.querySelector('h3');`).
 */
export function buildLocateRectJs(label: string, finderBody: string): string {
  return `
    (() => {
      const find = () => { ${finderBody} };
      let el = null;
      try { el = find(); } catch (e) { return { found: false, label: ${JSON.stringify(label)}, error: 'finder lançou: ' + e.message }; }
      if (!el) return { found: false, label: ${JSON.stringify(label)}, error: 'elemento não encontrado' };
      const r = el.getBoundingClientRect();
      return {
        found: true,
        label: ${JSON.stringify(label)},
        rect: { left: r.left, top: r.top, width: r.width, height: r.height, centerX: r.left + r.width / 2, centerY: r.top + r.height / 2 },
        innerWidth: window.innerWidth,
      };
    })()
  `;
}
