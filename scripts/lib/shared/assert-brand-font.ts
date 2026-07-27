/**
 * assert-brand-font.ts (#4090)
 *
 * Guard de fonte para os scripts que RASTERIZAM arte de marca.
 *
 * Contexto da decisão do editor (260727): `FONTS.serif` é
 * `"Georgia, 'Times New Roman', serif"` e **fica como está**. Mas ele é
 * consumido por dois grupos com problemas diferentes:
 *
 *   - **CSS** (e-mail `newsletter-render-html.ts`, web `workers/poll/*`,
 *     mensal, curadoria): quem renderiza é o dispositivo do LEITOR. Georgia é
 *     email-safe justamente por estar em praticamente todo Windows/Mac, e a
 *     cadeia de fallback existe pra fazer esse trabalho. Correto como está.
 *
 *   - **RASTER** (`gen-social-card-4x5`, `gen-story-card`,
 *     `gen-default-thumbnail`, `gen-parceria-clarice-image`): a fonte precisa
 *     existir na máquina que GERA. Sem Georgia, o `sharp`/librsvg cai no
 *     fallback e o card sai **fora da marca, em silêncio** — ninguém percebe
 *     até alguém olhar a arte publicada.
 *
 * Georgia é proprietária da Microsoft e não é redistribuível, então embutir no
 * repo não é opção. A decisão foi manter Georgia e **travar a geração na
 * máquina do editor**, convertendo a degradação silenciosa em erro visível.
 *
 * ## Por que sondar comportamento em vez de checar caminho de arquivo
 *
 * Checar `C:\Windows\Fonts\georgia.ttf` seria específico de OS e mentiria em
 * qualquer cenário de fontconfig customizado. A sonda aqui renderiza o MESMO
 * texto duas vezes — uma com a fonte de marca, outra com um nome de fonte
 * garantidamente inexistente — e compara os bytes. Rasters idênticos ⇒ a fonte
 * de marca não resolveu e as duas caíram no mesmo fallback.
 *
 * Isso testa o que de fato importa (o resultado do pipeline de render), não uma
 * proxy dele.
 */
import sharp from "sharp";

/** Família de marca sondada. Só o primeiro nome da stack — é o que importa. */
export const BRAND_SERIF_PRIMARY = "Georgia";

/**
 * Nome garantidamente ausente. Serve de linha de base do fallback: se a fonte
 * de marca produzir o MESMO raster que este, ela também não resolveu.
 */
const SENTINEL_ABSENT_FONT = "__diaria_sentinel_absent_font__";

/**
 * Escape hatch explícito. Existe porque bloquear sem saída numa ferramenta
 * pessoal é hostil — se o editor quiser gerar num ambiente sem Georgia
 * sabendo do trade-off, ele consegue. Exige ação deliberada (variável de
 * ambiente), então não é bypass silencioso, que é o que o guard combate.
 */
export const ALLOW_FALLBACK_ENV = "DIARIA_ALLOW_FONT_FALLBACK";

function probeSvg(fontFamily: string): Buffer {
  // Texto com ascendente, descendente e dígitos — maximiza diferença de métrica
  // entre famílias, reduzindo chance de dois rasters coincidirem por acaso.
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="60">` +
      `<text x="4" y="42" font-family="${fontFamily}" font-size="34">Handgloves 123</text>` +
      `</svg>`,
  );
}

/**
 * `true` se a fonte de marca resolve de fato no renderer desta máquina.
 * Não lança — use `assertBrandSerifAvailable` quando quiser abortar.
 */
export async function isBrandSerifAvailable(): Promise<boolean> {
  const [brand, sentinel] = await Promise.all([
    sharp(probeSvg(BRAND_SERIF_PRIMARY)).png().toBuffer(),
    sharp(probeSvg(SENTINEL_ABSENT_FONT)).png().toBuffer(),
  ]);
  return !brand.equals(sentinel);
}

/**
 * Aborta se a fonte de marca não resolve nesta máquina.
 *
 * `scriptName` entra na mensagem pra o editor saber qual geração parou sem ter
 * que rastrear stack trace.
 */
export async function assertBrandSerifAvailable(scriptName: string): Promise<void> {
  if (process.env[ALLOW_FALLBACK_ENV] === "1") {
    console.warn(
      `[${scriptName}] AVISO: ${ALLOW_FALLBACK_ENV}=1 — gerando com fallback de fonte.\n` +
        `  A arte NÃO vai parecer da marca (${BRAND_SERIF_PRIMARY} ausente nesta máquina).`,
    );
    return;
  }
  if (await isBrandSerifAvailable()) return;

  throw new Error(
    `[${scriptName}] ${BRAND_SERIF_PRIMARY} não está disponível nesta máquina — a arte sairia ` +
      `fora da marca, em silêncio.\n` +
      `\n` +
      `  Geração de arte de marca é LOCAL por decisão do editor (#4090): ${BRAND_SERIF_PRIMARY} ` +
      `é proprietária da Microsoft e não pode ser embutida no repo.\n` +
      `\n` +
      `  Rode este script numa máquina com ${BRAND_SERIF_PRIMARY} instalada (Windows/macOS), ou\n` +
      `  defina ${ALLOW_FALLBACK_ENV}=1 se quiser a arte com fallback mesmo assim.`,
  );
}
