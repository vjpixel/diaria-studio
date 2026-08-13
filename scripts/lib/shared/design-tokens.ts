/**
 * design-tokens.ts (#1936) — tokens canônicos do design system diar.ia.br.
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
  /** --paper · fundo principal / cards — quase-branco quente. WEB (site, páginas
   *  É IA?, cursos/livros). NÃO usar em e-mail — ver paperEmail abaixo. */
  paper: "#FBFAF6",
  /** --paper-email · fundo do card e da página dos E-MAILS (diária + mensal) =
   *  #FFFFFF branco puro. Clientes de e-mail renderizam branco de forma previsível;
   *  #FBFAF6 (~cream) pode virar cinza em modo escuro/inversão. --paper (#FBFAF6)
   *  segue como token WEB (site, É IA?, cursos/livros) — são contextos distintos.
   *  Decisão editorial confirmada em 2026-06-09 (#2005 / #1943 diária / #1955 mensal). */
  paperEmail: "#FFFFFF",
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

/**
 * LAYOUT · calibragem #5176 (260812-260813) — parâmetros de espaçamento do
 * e-mail diário, calibrados por descida por coordenadas sobre métricas
 * tipográficas medidas ao vivo (ritmo de parágrafo, hierarquia de seção,
 * caracteres/linha, espaço em branco) comparando o render anterior com a
 * newsletter "the news" (ver issue #5176 pros artefatos/medições completas).
 *
 * Decisões do editor (briefing 260813), aplicadas aqui: container **656px**
 * (não os 640px que a descida por coordenadas escolheu sozinha — 656 fica
 * mais perto da "the news", 74,7 caracteres/linha no desktop) e recuo
 * lateral **16px** (não 8px — bate o alvo de 67 caracteres/linha no
 * desktop; no celular o recuo pesa pouco, quem manda é a largura da
 * viewport). Os demais valores vêm direto do JSON calibrado da issue,
 * EXCETO `radarSize` — ver o comentário do próprio campo, abaixo, pro
 * porquê desse desvio deliberado.
 *
 * `pPad`/`pMarginFactor` (padding/margem de `<p>` de corpo) NÃO estão
 * aqui — são condicionais ao ESP (o Beehiiv injeta `p{padding:12px}` que o
 * Brevo não injeta; aplicar a mesma calibragem nos dois PIORA o Brevo). Ver
 * `newsletter-render-html.ts` (`renderBodyParasInner`).
 */
export const LAYOUT = {
  /** Largura do container do corpo (era 600 — #1936/#1945; o card do
   *  Beehiiv comporta até 662px de folga). */
  containerWidth: 656,
  /** Padding LATERAL das seções `<td class="pad">` (era 32). Emitido
   *  IGUAL em desktop e mobile, nos dois canais (Beehiiv/Brevo) — decisão
   *  do editor #5176: não depender da media query `.pad` (que só o Brevo
   *  de fato executa, porque o Beehiiv remove nosso `<style>` do e-mail
   *  entregue). */
  sidePad: 16,
  /** Padding de TOPO das seções (era 40). */
  sectionTop: 48,
  /** Padding de TOPO do destaque líder D1 (era 36 — preserva o offset de
   *  -4px sobre `sectionTop` que já existia antes desta calibragem). */
  leadTop: 44,
  /** Respiro interno dos boxes "contorno"/"painel" — quadrado, mesmo valor
   *  nos dois eixos (era 24px topo/base × 28px lateral). */
  boxPad: 12,
  /** Margem acima dos boxes/painéis — unificada (era 22-28px, drift entre
   *  call sites sem motivo funcional). */
  boxMargin: 28,
  /** Espaço ANTES de cada item do Radar/Use melhor/Lançamentos, exceto o
   *  1º (era 22). */
  radarPad: 8,
  /** Altura dos divs espaçadores entre itens de lista (era 22). */
  spacer: 12,
  /** Corpo do título de item de lista (Radar/Use melhor/Lançamentos), em px.
   *  DESVIO DELIBERADO do JSON calibrado da issue #5176 (que media 20):
   *  20px conflita com o type-scale do e-mail travado por
   *  `test/email-type-scale-white-shell.test.ts` — decisão de editor
   *  anterior (diaria-design#4) restringe TODO font-size do e-mail a
   *  {12,16,22,26}px, e 20 é um dos valores explicitamente eliminados
   *  ("20→22"). A descida por coordenadas da issue #5176 otimizou só
   *  métricas de ritmo tipográfico (chars/linha, espaço em branco), sem
   *  saber desse invariante — mantido em 22 (valor já aprovado, idêntico
   *  ao que já estava em produção) em vez de reabrir esse invariante sem
   *  decisão nova do editor. */
  radarSize: 22,
} as const;
