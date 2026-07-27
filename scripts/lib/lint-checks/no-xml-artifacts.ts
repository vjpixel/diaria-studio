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
