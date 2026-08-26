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
 * decidido na Etapa 5). Mas `buildKitHtml` **re-renderiza** o markdown com
 * `esp: "kit"` em vez de reusar o HTML da Beehiiv — então o render já é o
 * ponto onde o canal existe, e é onde o `KIT_FOOTER_STYLE_BLOCK` (#6183) já
 * mora.
 *
 * A alternativa considerada e descartada era um placeholder (`{{ENVIO}}`) no
 * snippet `data/snippets/encerramento-social-apoio.md`. Descartada porque
 * `data/` sincroniza por OneDrive e o código por git: uma máquina com o
 * snippet novo e o código velho publicaria `{{ENVIO}}` **literal** para os
 * leitores.
 *
 * ## Por que NÃO se casa a copy exata (achado P0 do review da PR #6207)
 *
 * A 1ª versão deste módulo casava a frase inteira, literal. **Isso quebra na
 * própria pipeline que produz o texto:** `content.encerrar` atravessa o
 * humanizador e depois a Clarice (`correct_text`, aplicada
 * incondicionalmente, #4514), ambos reescrevendo o markdown INTEIRO sem
 * exclusão de seção.
 *
 * Não é risco teórico — é precedente registrado: o **#1982** existe porque a
 * Clarice/humanizador já alterou o link de afiliado dos cupons
 * `NEWS25`/`NEWS50`, **no mesmo parágrafo**, e por isso aquele link ganhou um
 * guard de estabilidade pré/pós-LLM. O review reproduziu a falha aqui em
 * segundos trocando "por 3 meses" por "nos primeiros 3 meses": o match falha,
 * `substituido: false`, e `beehiiv.com?via=Diaria` sobrevive intacto na
 * edição Kit.
 *
 * Daí as duas mudanças de desenho:
 *
 * 1. **Âncora pelo LINK, não pela copy.** O que a Clarice reescreve é prosa;
 *    a URL de afiliado é o que precisa sumir e é o que ela não inventa.
 * 2. **O guard verifica o INVARIANTE, não o proxy.** "Achei minha string?" é
 *    proxy. "Sobrou algum `beehiiv` no HTML entregue?" é a pergunta real —
 *    `contemResiduoBeehiiv` responde essa, sobre o HTML final, depois de
 *    tudo. Medido em edição real: um HTML Kit correto tem **zero**
 *    ocorrências de `beehiiv`, então o invariante não gera falso positivo.
 *
 * ## Comissão do Kit — verificado em 26/08/2026
 *
 * O Kit tem programa de afiliado (PartnerStack, 50% recorrente nos 12
 * primeiros meses, cookie de 90 dias) e **paga no Brasil** (PayPal, Stripe e
 * depósito direto via AirWallex). Por isso a saída escolhida foi a
 * condicional por canal, e não neutralizar o crédito nos dois.
 *
 * Enquanto o link do Kit não existir, a edição Kit cai no texto **neutro** —
 * some a imprecisão sem depender do cadastro no PartnerStack.
 */

/**
 * Casa o crédito de envio da Beehiiv em markdown, ancorado na URL.
 *
 * Tolera reescrita de: o verbo/preposição ("enviei via" → "enviada pela"), a
 * copy da oferta dentro dos colchetes, espaçamento, e parâmetros de query
 * diferentes. NÃO tolera a URL sumir — que é justamente o que não pode
 * acontecer sem a frase perder o sentido.
 */
export const CREDITO_BEEHIIV_RE =
  /\b(?:enviei|enviado|enviada|envio)\b[^.\n]{0,40}?\bBeehiiv\b\s*\(\s*\[[^\]]*\]\(\s*https?:\/\/(?:www\.)?beehiiv\.com[^)]*\)\s*\)/gi;

/** Texto usado quando o canal é Kit e não há link de afiliado configurado. */
export const CREDITO_NEUTRO = "enviei por e-mail";

/**
 * Qualquer menção ao domínio da concorrente. Usado no guard de saída sobre o
 * HTML final — ver `contemResiduoBeehiiv`.
 */
export const RESIDUO_BEEHIIV_RE = /beehiiv/i;

export interface CreditoOptions {
  /**
   * Link de afiliado do Kit (PartnerStack). Vazio/ausente ⇒ texto neutro.
   * Config, não constante: entra sem mudança de código quando o editor tiver
   * a URL.
   */
  kitAffiliateUrl?: string;
  /** Copy da oferta, se houver link. */
  kitOfferText?: string;
}

/** Só aceita http(s) — evita embutir lixo de config num link markdown. */
function urlUtilizavel(raw: string | undefined): string | null {
  const url = raw?.trim();
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Monta o crédito para o canal Kit. */
export function buildCreditoKit(opts: CreditoOptions = {}): string {
  const url = urlUtilizavel(opts.kitAffiliateUrl);
  if (!url) return CREDITO_NEUTRO;
  const oferta = opts.kitOfferText?.trim() || "conheça o Kit";
  return `enviei via Kit ([${oferta}](${url}))`;
}

export interface AplicarCreditoResult {
  markdown: string;
  /**
   * `false` quando nenhum crédito da Beehiiv foi achado. **Não é o guard** —
   * é só diagnóstico. O guard de verdade é `contemResiduoBeehiiv` sobre o
   * HTML final, porque é ele que responde a pergunta que importa.
   */
  substituido: boolean;
}

/**
 * Troca o crédito da Beehiiv pelo do Kit no markdown já stitchado.
 *
 * Idempotente: a segunda chamada não acha a URL da Beehiiv e devolve
 * `substituido: false` com o markdown intocado.
 */
export function aplicarCreditoKit(markdown: string, opts: CreditoOptions = {}): AplicarCreditoResult {
  const credito = buildCreditoKit(opts);
  let substituido = false;
  // `replace` com regex `g` — cobre múltiplas ocorrências, se houver.
  const out = markdown.replace(CREDITO_BEEHIIV_RE, () => {
    substituido = true;
    return credito;
  });
  return { markdown: out, substituido };
}

/**
 * O guard real: sobrou menção à concorrente no HTML que vai pelo Kit?
 *
 * Verificado em edição real (260715): um HTML Kit correto tem **zero**
 * ocorrências — o `BEEHIIV_BASE_URL` do bloco "Convide um amigo" resolve pro
 * domínio próprio (`diar.ia.br`), não pro da plataforma. Então `true` aqui é
 * sinal genuíno, não ruído.
 */
export function contemResiduoBeehiiv(html: string): boolean {
  return RESIDUO_BEEHIIV_RE.test(html);
}
