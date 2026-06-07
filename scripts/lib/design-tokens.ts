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
  /** --font-serif · manchetes + corpo editorial. Georgia = system/email-safe. */
  serif: "Georgia, 'Times New Roman', serif",
  /** --font-sans · UI / labels / kickers. Geist = web font; cai pra system sans em email. */
  sans: "'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  /** --font-mono · meta/dados. */
  mono: "'Geist Mono', 'JetBrains Mono', ui-monospace, monospace",
} as const;

/**
 * Decisão editorial #1936 (registrada no PR): as réguas/separadores usam o teal
 * da marca (`COLORS.brand`), NÃO o `--rule` bege do DS. O editor pediu explícita
 * e repetidamente o verde nas réguas ("senti falta do verde"). Teal é cor
 * canônica (--brand) aplicada a um papel estrutural — divergência consciente do
 * DS, que concentraria teal só em links/kickers/marcas e deixaria as réguas bege.
 * Centralizado aqui pra a decisão ter um único ponto de reversão.
 */
export const RULE_ACCENT: string = COLORS.brand;
