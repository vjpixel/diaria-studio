/**
 * design-tokens.ts (#1936) — tokens canônicos do design system Diar.ia.
 *
 * Espelho fiel de github.com/vjpixel/diaria-design/tokens/{colors,fonts,typography}.css
 * (a FONTE DA VERDADE da marca). Os renderers de email (diária via
 * render-newsletter-html.ts, mensal via monthly-render.ts) consomem estes
 * VALORES inline — clients de email (Beehiiv/Brevo) não suportam `@import`/`var()`
 * CSS de forma confiável. As páginas web do worker do É IA? espelham os mesmos
 * valores inline (bundle Cloudflare separado).
 *
 * Paleta editorial reduzida a 4 cores-base: ink · bege · papel · teal. O texto é
 * SEMPRE ink — a hierarquia vem de tamanho/peso, não de cor (DS consolidou
 * ink-soft/ink-faint → ink; não há cinzas na paleta).
 *
 * Fontes: Georgia (serif, email-safe — system font) carrega o tom editorial;
 * Geist (sans, web font → cai pra system sans em email) é o utilitário de UI.
 */
export const COLORS = {
  /** --brand · teal #00A0A0, único acento: links, kickers, marcas. */
  brand: "#00A0A0",
  /** --ink · todo o texto, rodapé, botões cheios. */
  ink: "#171411",
  /** --paper · fundo principal / cards — quase-branco quente. */
  paper: "#FBFAF6",
  /** --paper-alt / --brand-tint · molduras, boxes cheios, seções recuadas, shell (bege). */
  paperAlt: "#EBE5D0",
  /** --rule · fios e bordas hairline (bege). */
  rule: "#EBE5D0",
  /** --rule-strong · régua editorial pesada / bordas de placeholder (tinta). */
  ruleStrong: "#171411",
  /** --on-ink · texto sobre tinta. */
  onInk: "#FBFAF6",
} as const;

export const FONTS = {
  /** --font-serif · MANCHETES/títulos (só). Georgia = system/email-safe. */
  serif: "Georgia, 'Times New Roman', serif",
  /** --font-sans · CORPO + UI + labels/kickers. Geist = web font; cai pra system sans em email. */
  sans: "'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  /** --font-mono · meta/dados. */
  mono: "'Geist Mono', 'JetBrains Mono', ui-monospace, monospace",
} as const;

/**
 * Sistema de boxes do DS (guidelines/boxes.html) — exatamente 2 variantes, sem
 * bordas/barras teal em lugar nenhum (teal é SÓ texto: links/kickers/marca●):
 *   - contorno: fundo `paper` (#FBFAF6) + borda `1px rule` (#EBE5D0 bege).
 *     Usado em "Por que isso importa", callouts/CTA.
 *   - painel:   fundo `paperAlt` (#EBE5D0 bege preenchido), sem borda.
 *     Usado no É IA?, seções recuadas.
 * Réguas/separadores = `rule` (#EBE5D0) hairline; `ruleStrong` (#171411) só pra
 * régua pesada 2px. Fontes: serif Georgia em TÍTULOS, sans Geist no CORPO.
 */
export const BOX = {
  contornoBg: COLORS.paper,
  contornoBorder: COLORS.rule,
  painelBg: COLORS.paperAlt,
} as const;
