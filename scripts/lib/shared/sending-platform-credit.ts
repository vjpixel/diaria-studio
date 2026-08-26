/**
 * scripts/lib/shared/sending-platform-credit.ts (#6195)
 *
 * O rodapé "Para encerrar" credita a plataforma de envio:
 *
 *   "...dei o toque final e enviei via Beehiiv ([oferta](link de afiliado))."
 *
 * Esse texto é escrito uma vez, no markdown stitchado do Stage 2, e o MESMO
 * markdown alimenta os dois canais. Numa edição enviada pelo **Kit** ele fica
 * factualmente errado — e pior que errado: carrega um **link de afiliado da
 * concorrente** dentro da edição que a nova plataforma entregou.
 *
 * ## Por que a troca acontece no RENDER, não no stitch
 *
 * O stitch não sabe por qual canal a edição vai (nem deveria: o canal é
 * decidido na Etapa 5, muito depois). Mas `buildKitHtml` **re-renderiza** o
 * markdown com `esp: "kit"` em vez de reusar o HTML da Beehiiv — então o
 * render já é o ponto onde o canal existe, e é onde o
 * `KIT_FOOTER_STYLE_BLOCK` (#6183) já mora.
 *
 * A alternativa considerada e descartada era um placeholder (`{{ENVIO}}`) no
 * snippet `data/snippets/encerramento-social-apoio.md`. Descartada porque
 * `data/` sincroniza por OneDrive e o código por git: uma máquina com o
 * snippet novo e o código velho publicaria `{{ENVIO}}` **literal** para os
 * leitores. Substituir no render mantém os dois lados no mesmo artefato
 * versionado.
 *
 * ## Comissão do Kit — verificado em 26/08/2026
 *
 * O Kit tem programa de afiliado (PartnerStack, 50% recorrente nos 12
 * primeiros meses, cookie de 90 dias) e **paga no Brasil** (PayPal, Stripe e
 * depósito direto via AirWallex). Por isso a saída escolhida foi a
 * condicional por canal, e não neutralizar o crédito nos dois.
 *
 * Enquanto o link do Kit não existir (o editor precisa se cadastrar no
 * PartnerStack), a edição Kit cai no texto **neutro** — some a imprecisão
 * sem depender do cadastro, e o link entra depois numa linha de config.
 */

/** Trecho do markdown stitchado que credita a Beehiiv, incluindo a oferta. */
export const CREDITO_BEEHIIV_MARKDOWN =
  "enviei via Beehiiv ([ganhe um mês grátis e 20% de desconto por 3 meses](https://www.beehiiv.com?via=Diaria))";

/** Texto usado quando o canal é Kit e não há link de afiliado configurado. */
export const CREDITO_NEUTRO = "enviei por e-mail";

export interface CreditoOptions {
  /**
   * Link de afiliado do Kit (PartnerStack). Vazio/ausente ⇒ texto neutro.
   * Config, não constante: entra sem mudança de código quando o editor tiver
   * a URL.
   */
  kitAffiliateUrl?: string;
  /** Copy da oferta, se houver link. Default espelha o formato da Beehiiv. */
  kitOfferText?: string;
}

/** Monta o crédito para o canal Kit. */
export function buildCreditoKit(opts: CreditoOptions = {}): string {
  const url = opts.kitAffiliateUrl?.trim();
  if (!url) return CREDITO_NEUTRO;
  const oferta = opts.kitOfferText?.trim() || "conheça o Kit";
  return `enviei via Kit ([${oferta}](${url}))`;
}

export interface AplicarCreditoResult {
  markdown: string;
  /**
   * `false` quando o trecho da Beehiiv NÃO foi encontrado — a copy mudou e
   * esta substituição virou no-op silencioso. O caller emite warning; não
   * lançamos aqui porque um crédito impreciso **não** justifica derrubar a
   * edição (diferente de `loadDivulgacaoSnippet`, onde o box some por
   * inteiro).
   */
  substituido: boolean;
}

/**
 * Troca o crédito da Beehiiv pelo do Kit no markdown já stitchado.
 *
 * Idempotente: rodar duas vezes não duplica nem corrompe — a segunda
 * chamada não acha o trecho da Beehiiv e devolve `substituido: false`.
 */
export function aplicarCreditoKit(markdown: string, opts: CreditoOptions = {}): AplicarCreditoResult {
  if (!markdown.includes(CREDITO_BEEHIIV_MARKDOWN)) {
    return { markdown, substituido: false };
  }
  return {
    markdown: markdown.split(CREDITO_BEEHIIV_MARKDOWN).join(buildCreditoKit(opts)),
    substituido: true,
  };
}
