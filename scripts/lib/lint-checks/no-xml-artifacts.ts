/**
 * lint-checks/no-xml-artifacts.ts (#4077)
 *
 * Detecta tag(s) de tool-call crua(s) (`</content>`, `</invoke>`,
 * `</function_calls>`) grudada(s) no FIM do documento — sintoma de um
 * payload de tool-call vazando no caminho de escrita de um fluxo assistido
 * (ex: chat drawer do Studio, `studio-chat.ts`, que edita
 * `02-reviewed.md`/`03-social.md`/etc. via `Edit`/`Write` de um agente LLM).
 *
 * Caso real (#4077, edição 260727): `02-reviewed.md` apareceu com 21 bytes
 * de `</content>\n</invoke>` grudados após o último parágrafo do PARA
 * ENCERRAR. Esse texto teria ido pro e-mail publicado — nenhum dos 15
 * invariantes do Stage 4 nem dos 10 lints de newsletter pré-existentes olha
 * pro fim cru do documento, então o gate ficou VERDE com a corrupção
 * presente.
 *
 * Duas redes de segurança compartilham esta MESMA definição de padrão:
 *   1. `saveReviewFile` (`scripts/studio-ui/studio-review.ts`) — strippa o
 *      artefato ANTES de escrever em disco (guard na origem, #4077 item 3).
 *   2. `checkNoXmlArtifacts` abaixo — lint GATE-BLOCKING no Stage 4 (#4077
 *      item 4), rede de segurança independente da origem da corrupção
 *      (Studio, edição manual, merge malformado, etc.).
 *
 * Escopo deliberadamente estreito — mira SÓ no padrão real observado (tag(s)
 * de tool-call ANCORADAS no fim do documento, opcionalmente separadas por
 * espaço em branco) pra não confundir HTML/exemplo legítimo que apareça no
 * MEIO do texto editorial (ex: "a API retorna um bloco `<content>...
 * </content>`" como trecho explicativo, ou comparações "X < Y > Z"). Nunca
 * dispara em conteúdo markdown normal, mesmo que contenha `<`/`>` em outro
 * lugar do arquivo — só quando uma dessas tags é literalmente o que sobra
 * depois de aparar espaço em branco no fim da string.
 */

const TOOL_CALL_CLOSING_TAGS = ["content", "invoke", "function_calls"] as const;

// Uma ou mais repetições de "<espaço-opcional></tag>" ancoradas no FIM da
// string — cobre tanto uma tag solta quanto o padrão real observado (2 tags
// empilhadas: `</content>\n</invoke>`).
const TRAILING_ARTIFACT_RE = new RegExp(
  `(?:\\s*</(?:${TOOL_CALL_CLOSING_TAGS.join("|")})>)+\\s*$`,
);

export interface TrailingToolCallArtifact {
  /** Texto exato do artefato encontrado no fim do documento (inclui o
   * espaço em branco que o precede, não aparado). */
  artifact: string;
}

/**
 * Detecta o artefato de tool-call no fim de `content`, se houver. Retorna
 * `null` quando não há match — usado tanto pelo lint (`checkNoXmlArtifacts`)
 * quanto pelo guard de escrita (`saveReviewFile`) pra compartilhar a MESMA
 * definição do padrão perigoso, sem duplicar a regex em dois lugares.
 */
export function detectTrailingToolCallArtifact(content: string): TrailingToolCallArtifact | null {
  const match = TRAILING_ARTIFACT_RE.exec(content);
  if (!match || match[0].trim() === "") return null;
  return { artifact: match[0] };
}

export interface StripTrailingToolCallArtifactResult {
  content: string;
  /** Texto removido, ou `null` quando nada foi encontrado (conteúdo
   * retornado inalterado — idempotente). */
  stripped: string | null;
}

/**
 * Remove o artefato de tool-call do fim de `content`, se houver — usado
 * pelo guard de escrita server-side (#4077 item 3) pra strippar em vez de
 * recusar o save inteiro (o conteúdo editorial legítimo antes do artefato
 * continua sendo gravado normalmente).
 */
export function stripTrailingToolCallArtifact(content: string): StripTrailingToolCallArtifactResult {
  const found = detectTrailingToolCallArtifact(content);
  if (!found) return { content, stripped: null };
  return { content: content.slice(0, content.length - found.artifact.length), stripped: found.artifact };
}

export interface NoXmlArtifactsError {
  artifact: string;
}

export interface NoXmlArtifactsReport {
  ok: boolean;
  errors: NoXmlArtifactsError[];
}

/**
 * Lint gate-blocking (#4077 item 4) — rede de segurança contra a mesma
 * classe de corrupção que o guard de `saveReviewFile` já mitiga na origem
 * (item 3). Independente da causa, o gate do Stage 4 nunca deveria ficar
 * verde com uma tag de tool-call grudada no fim do `02-reviewed.md`.
 */
export function checkNoXmlArtifacts(md: string): NoXmlArtifactsReport {
  const found = detectTrailingToolCallArtifact(md);
  if (!found) return { ok: true, errors: [] };
  return { ok: false, errors: [{ artifact: found.artifact }] };
}

// ─────────────────────────────────────────────────────────────────────────
// #4987: variante MEIO-DE-DOCUMENTO — tag de tool-call crua ENTRE seções,
// não só ancorada no fim.
//
// Caso real (#4987, edição 260811): `03-social.md` apareceu com tag(s) de
// fechamento de tool-call cruas entre o fim do texto de um post e o header
// `## dN` do próximo — `detectTrailingToolCallArtifact` acima não pega esse
// caso porque está ancorado em `$` (fim absoluto do documento). Além disso,
// nenhum caller do merge (`merge-social-md.ts`) rodava QUALQUER checagem de
// artefato de tool-call antes de escrever o arquivo final — `no-xml-artifacts`
// só existia como lint do Stage 4 (gate humano), depois do arquivo já
// publicável ter sido gravado em disco.
//
// Escopo continua deliberadamente estreito (mesma cautela do #4077 original,
// ver `test/lint-social-md-no-xml-artifacts.test.ts` — "NÃO acusa quando o
// texto menciona <content>/</content> no meio de uma frase"): só dispara
// quando uma tag ocupa uma LINHA INTEIRA sozinha (depois de trim) — o padrão
// estrutural real do vazamento (uma tag de tool-call nunca aparece embutida
// no meio de uma frase de prosa editorial). Cobre tanto tags de fechamento
// quanto de abertura (`<invoke ...>`, `<function_calls>`, `<parameter ...>`)
// porque o vazamento observado inclui o bloco INTEIRO do tool-call, não só
// o fechamento — e também a forma de 1 linha só de `<parameter name="...">
// valor</parameter>`, que é o formato mais comum de um parâmetro simples.
// `parameter` entra na lista aqui (não em `TOOL_CALL_CLOSING_TAGS`, que é o
// contrato já travado por `test/lint-*-no-xml-artifacts.test.ts` para o
// caso trailing) porque um `<invoke>` vazado quase sempre carrega
// `<parameter>` filhos — mesma classe de risco, sem tocar o comportamento
// já testado do detector trailing.
// ─────────────────────────────────────────────────────────────────────────

const STANDALONE_TAG_NAMES = [...TOOL_CALL_CLOSING_TAGS, "parameter"] as const;

const STANDALONE_CLOSING_RE = new RegExp(
  `^</(?:${STANDALONE_TAG_NAMES.join("|")})>$`,
  "i",
);
const STANDALONE_OPENING_RE = new RegExp(
  `^<(?:invoke|function_calls|parameter)(?:\\s[^>]*)?>$`,
  "i",
);
// Forma de 1 linha só: `<parameter name="x">valor</parameter>` — comum para
// parâmetros de string simples (sem quebra de linha no valor).
const STANDALONE_PARAMETER_INLINE_RE = /^<parameter\s+name="[^"]*">.*<\/parameter>$/i;

export interface ToolCallArtifactMatch {
  /** Número da linha (1-based) onde o artefato foi encontrado. */
  line: number;
  /** Conteúdo da linha, já trimada. */
  text: string;
}

/**
 * Varre TODO o documento (não só o fim) em busca de linhas que sejam,
 * sozinhas, uma tag crua de tool-call — abertura, fechamento, ou um
 * `<parameter>` de 1 linha só. Retorna todos os matches (não só o primeiro)
 * pra dar visibilidade completa de onde a corrupção está no documento.
 */
export function detectToolCallArtifactsAnywhere(content: string): ToolCallArtifactMatch[] {
  const lines = content.split(/\r?\n/);
  const matches: ToolCallArtifactMatch[] = [];
  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) return;
    if (
      STANDALONE_CLOSING_RE.test(line) ||
      STANDALONE_OPENING_RE.test(line) ||
      STANDALONE_PARAMETER_INLINE_RE.test(line)
    ) {
      matches.push({ line: idx + 1, text: line });
    }
  });
  return matches;
}
