/**
 * image-tool-name.ts (#10783)
 *
 * Fonte única do NOME da ferramenta de imagem citada ao leitor da diária, nos
 * dois lugares onde ela aparece:
 *   - a legenda do hero de cada destaque ("Criada com ChatGPT",
 *     `imageGeneratorCredit` em `newsletter-render-html.ts`);
 *   - o parágrafo de ferramentas do PARA ENCERRAR ("…, ChatGPT para criar
 *     imagens e …"), que vinha de texto fixo (`data/snippets/
 *     encerramento-social-apoio.md` + `FIXED_BLOCKS.para_encerrar_tools`) e
 *     continuou dizendo "Gemini" depois que `image_generator` virou `codex`.
 *     O leitor via as duas afirmações, contraditórias, na mesma edição.
 *
 * As duas saídas derivam do MESMO slug de `image_generator` (ou do sidecar
 * `_internal/04-d{N}-generator.json`, #9095), então não divergem mais.
 *
 * O mensal tem o mapa próprio (`GENERATOR_LABELS` em `mensal/monthly-render.ts`)
 * com rótulos diferentes pra `openai`/`cloudflare`; fica fora do escopo aqui
 * (a diária é o que a issue mediu).
 *
 * Genérico, sem import de diaria/ nem mensal/ → `lib/shared/` (#2747).
 */

/** Slug de `image_generator` → nome da ferramenta, como o leitor o lê. */
export const IMAGE_TOOL_NAMES: Readonly<Record<string, string>> = {
  gemini: "Gemini",
  openai: "gpt-image-2",
  codex: "ChatGPT",
  cloudflare: "Cloudflare FLUX",
  comfyui: "ComfyUI",
};

/** Nome usado quando o gerador é desconhecido ou misto (destaques divergem). */
export const GENERIC_IMAGE_TOOL = "IA";

/** Nome da ferramenta pro slug, ou `GENERIC_IMAGE_TOOL` (desconhecido/`mixed`/vazio). */
export function imageToolName(generator: string | null | undefined): string {
  if (!generator) return GENERIC_IMAGE_TOOL;
  return IMAGE_TOOL_NAMES[generator.toLowerCase()] ?? GENERIC_IMAGE_TOOL;
}

/** Legenda do hero: "Criada com {ferramenta}". */
export function imageCreditCaption(generator: string | null | undefined): string {
  return `Criada com ${imageToolName(generator)}`;
}

/** Placeholder aceito no snippet de encerramento (opcional, além do texto legado). */
export const IMAGE_TOOL_PLACEHOLDER = "{{IMAGE_TOOL}}";

const KNOWN_TOOL_ALTERNATION = [...new Set([...Object.values(IMAGE_TOOL_NAMES), GENERIC_IMAGE_TOOL])]
  .sort((a, b) => b.length - a.length) // nome mais longo primeiro ("Cloudflare FLUX" antes de "IA")
  .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

/**
 * Casa o nome de uma ferramenta conhecida imediatamente antes de
 * " para criar imagens" (a redação do parágrafo de ferramentas). Ancorado
 * nessa expressão pra nunca trocar uma menção a "Gemini"/"ChatGPT" em outro
 * contexto do texto.
 */
const TOOL_BEFORE_PURPOSE_RE = new RegExp(`(^|[\\s,(])(${KNOWN_TOOL_ALTERNATION})(?= para criar imagens)`, "g");

/**
 * Alinha o parágrafo de ferramentas do PARA ENCERRAR com o gerador real:
 * substitui `{{IMAGE_TOOL}}` e o nome de ferramenta conhecido antes de
 * " para criar imagens" pelo nome derivado de `generator`. Texto que não cita
 * ferramenta de imagem sai intacto (idempotente).
 */
export function applyImageToolToCredits(text: string, generator: string | null | undefined): string {
  const name = imageToolName(generator);
  return text
    .split(IMAGE_TOOL_PLACEHOLDER).join(name)
    .replace(TOOL_BEFORE_PURPOSE_RE, (_m, pre: string) => `${pre}${name}`);
}
