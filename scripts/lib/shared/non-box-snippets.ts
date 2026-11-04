/**
 * scripts/lib/shared/non-box-snippets.ts (#12202, #10832)
 *
 * Critério EM CÓDIGO de "este arquivo de `data/snippets/` não é box de
 * divulgação da newsletter". `data/snippets/` é gitignored e sincronizado por
 * OneDrive (#5227), então o critério não pode depender de alguém editar o
 * arquivo pra acrescentar um marcador: o nome e o próprio conteúdo já dizem.
 *
 * Incidente que motivou (#12202, edição 261105): `onboarding-2.md` (e-mail de
 * boas-vindas da automação, HTML cru) entrou no pool da seleção por cliques
 * (`select-boxes-by-clicks.ts`) e foi escolhido pro slot 1. O render trata o
 * corpo do box como markdown e escapa o HTML, então o leitor veria
 * `<p>Três coisas ...<a target="_blank" ...>` como texto. Ele pontuava porque
 * compartilha a URL do canal do YouTube com o box do YouTube e "roubava" os
 * cliques daquele box no match de histórico.
 *
 * Sinais (qualquer um basta):
 * - nome na lista explícita `NON_BOX_SNIPPET_FILES` (hub rotativo, #10832);
 * - nome casa um padrão de `NON_BOX_SNIPPET_FILE_PATTERNS` (e-mails do
 *   onboarding, intros dos envios da Brevo);
 * - corpo com tag HTML crua (`findRawHtmlTag`) — o render escaparia;
 * - `runtime: false` no header (documentação/referência, #4500/#4504).
 *
 * Os dois últimos são lidos do conteúdo por `parseSnippetContent`
 * (`box-click-report.ts`) e chegam aqui como flags de `NonBoxSignals`.
 */

/** #10832: arquivos que nunca saem como box, por nome exato. */
export const NON_BOX_SNIPPET_FILES: ReadonlySet<string> = new Set(["hub-divulgacao-rotativo.md"]);

/**
 * #12202: famílias de arquivo que não são box de divulgação da newsletter:
 * - `onboarding-N.md`: e-mails da sequência de boas-vindas (#5908);
 * - `brevo-*-intro.md`: bloco de topo dos envios da Brevo (#4266, #10437,
 *   #11226), conteúdo de compliance de outro canal.
 */
export const NON_BOX_SNIPPET_FILE_PATTERNS: readonly RegExp[] = [
  /^onboarding-\d+\.md$/i,
  /^brevo-.+-intro\.md$/i,
];

/** `true` quando o NOME do arquivo já basta pra dizer que não é box. */
export function isNonBoxSnippetFileName(file: string): boolean {
  if (NON_BOX_SNIPPET_FILES.has(file)) return true;
  return NON_BOX_SNIPPET_FILE_PATTERNS.some((re) => re.test(file));
}

/**
 * Tag HTML de bloco/inline que o render de box escaparia e o leitor veria
 * como texto. Exige o nome da tag seguido de espaço, `>` ou `/` — `a < b` ou
 * `<https://url>` (autolink markdown) não casam.
 */
const RAW_HTML_TAG_RE = /<\/?(?:p|a|div|span|br|strong|b|em|i|u|ul|ol|li|h[1-6]|img|table|tr|td)(?=[\s>/])[^>]*>?/i;

/** Primeira tag HTML crua encontrada em `text` (trecho literal), ou `null`. */
export function findRawHtmlTag(text: string): string | null {
  const m = RAW_HTML_TAG_RE.exec(text);
  if (!m) return null;
  return m[0].length > 60 ? `${m[0].slice(0, 57)}...` : m[0];
}

export interface NonBoxSignals {
  /** `runtime: false` no header do snippet. */
  runtimeExcluded?: boolean;
  /** Corpo (sem o header) com tag HTML crua. */
  rawHtmlBody?: boolean;
}

/** Combina nome + sinais de conteúdo. Snippet ausente = só o nome decide. */
export function isNonBoxSnippet(file: string, signals?: NonBoxSignals | null): boolean {
  if (isNonBoxSnippetFileName(file)) return true;
  return signals?.runtimeExcluded === true || signals?.rawHtmlBody === true;
}
