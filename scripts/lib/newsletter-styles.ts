/**
 * newsletter-styles.ts (#2635) — CSS base compartilhado pelos renderers de email
 * diário (newsletter-render-html.ts) e mensal (monthly-render.ts).
 *
 * Arquitetura de dois níveis:
 *   1. BASE (emailBaseRules) — reset body/img/table, idêntico em ambos os renderers.
 *   2. OVERRIDES por renderer:
 *      - Diária: a.headline:hover + @media .container/.pad/.hero
 *      - Mensal:  @media .mob-stack (imagens A/B do É IA? em telas estreitas, #1918)
 *
 * Design-tokens (cores/fontes) vêm de ./design-tokens.ts — este módulo NUNCA
 * define valores visuais próprios. Importa COLORS.brand para o hover da diária.
 *
 * Clientes de email não suportam var() CSS; os valores são inline (via tokens TS).
 *
 * Separação base + override é infraestrutura — não altera nenhum pixel renderizado.
 * Diferenças visuais entre diária e mensal permanecem como overrides explícitos;
 * a decisão de eliminar divergências "acidentais" é follow-up editorial (#2635).
 */
import { COLORS } from "./design-tokens.ts";

/**
 * Regras CSS base compartilhadas pelos dois renderers de email Diar.ia.
 * Reset de body/img/table — comportamento padrão esperado em clientes de email.
 *
 * Retorna as regras SEM a tag <style> envolvente; o caller (buildDiariaStyleBlock /
 * buildMensalStyleBlock) embute em seu próprio bloco.
 *
 * Nota de indentação: a primeira linha NÃO carrega espaço líder — o caller adiciona
 * via `  ${emailBaseRules(...)}` na template literal. As linhas seguintes já têm
 * 2 espaços de indent para alinhamento ao padrão do bloco <style>.
 *
 * @param pageBg — cor de fundo da página. Ambos os renderers passam "#FFFFFF" hoje
 *   (#1943 diária, #1955 mensal). Parametrizado para extensibilidade futura.
 */
export function emailBaseRules(pageBg: string): string {
  return `body { margin:0; padding:0; width:100% !important; background:${pageBg}; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  table { border-collapse:collapse; }`;
}

/**
 * Bloco <style> completo do renderer DIÁRIO (newsletter-render-html.ts).
 *
 * Combina emailBaseRules + overrides específicos da diária:
 *   - a.headline:hover { color:brand } — progressive enhancement (hover de manchete)
 *   - @media max-width:480px: .container (width), .pad (padding lateral), .hero (height)
 *
 * Produz output byte-idêntico ao DS_STYLE_BLOCK anterior — o snapshot de hash em
 * ds-golden-full-render.test.ts não muda.
 *
 * @param pageBg     — cor de fundo da página (#FFFFFF canonical após #1943).
 * @param brandColor — cor de acento do hover (#00A0A0 = COLORS.brand).
 */
export function buildDiariaStyleBlock(pageBg: string, brandColor: string): string {
  return `<style>
  ${emailBaseRules(pageBg)}
  a.headline:hover { color:${brandColor} !important; }
  @media only screen and (max-width:480px) {
    .container { width:100% !important; }
    .pad { padding-left:12px !important; padding-right:12px !important; }
    .hero { height:auto !important; }
  }
</style>`;
}

/**
 * Bloco <style> completo do renderer MENSAL (monthly-render.ts wrapEmail).
 *
 * Combina emailBaseRules + override específico da mensal:
 *   - @media max-width:480px: .mob-stack — empilha imagens A/B do É IA? em telas
 *     estreitas (#1918, espelho do diário).
 *
 * Diferenças visuais entre diária e mensal (hover de manchete, .container/.pad/.hero)
 * são intencionais — preservadas como overrides explícitos, não eliminadas (#2635).
 * A decisão de unificar diferenças "acidentais" é follow-up editorial.
 *
 * @param pageBg — cor de fundo da página (#FFFFFF canonical após #1955).
 */
export function buildMensalStyleBlock(pageBg: string): string {
  return `<style>
  ${emailBaseRules(pageBg)}
  /* #1918: empilha as imagens A/B do É IA? em telas estreitas, como na diária. */
  @media only screen and (max-width: 480px) {
    .mob-stack { display:block !important; width:100% !important; padding:0 0 12px 0 !important; }
  }
</style>`;
}

// Re-export COLORS.brand para uso por callers que constroem o bloco da diária.
// Evita que newsletter-render-html.ts precise expor TEAL só pra passar pro buildDiariaStyleBlock.
export const BRAND_COLOR = COLORS.brand;
