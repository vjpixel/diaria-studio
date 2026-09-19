/**
 * scripts/lib/gh-pr-checks-json-loop-guard.ts (#8425)
 *
 * Detecção PURA (sem I/O) do padrão que causou o incidente da issue: um
 * laço de espera (`until`/`while`) escrito à mão em torno de `gh pr checks
 * ... --json ...` — a combinação que produziu 5h+ de laço órfão no `300`
 * batendo na API do GitHub, porque `--json` não existe em `gh pr checks`
 * na versão instalada ali (#6225) e a condição de saída do laço nunca
 * podia ser satisfeita.
 *
 * `scripts/check-pr-checks-gate.ts`/`scripts/lib/wait-pr-checks.sh` já
 * evitam esse comando específico — este módulo é a camada de AUTORIA: uma
 * varredura em `test/gh-pr-checks-json-loop-guard.test.ts` sobre os
 * arquivos rastreados do repo (SKILL.md, docs, scripts) reprova qualquer
 * PR que introduza esse padrão de volta, apontando pro helper único
 * (`scripts/lib/wait-pr-checks.sh`) — a única defesa possível contra a
 * classe inteira, já que o laço travado em si só é visível depois, via
 * SSH numa sessão peer.
 *
 * ─── Por que não flagra a documentação que já cita o padrão ──────────────
 *
 * `context/overnight-dispatch-rules.md`, os `SKILL.md` do overnight/develop
 * e este próprio módulo/issue mencionam `gh pr checks --json` em PROSA,
 * pra explicar por que ele é evitado (#6225) — nunca dentro de um laço
 * `until`/`while` de verdade. A varredura evita 2 classes de falso-positivo:
 *
 *   1. Em Markdown, só o conteúdo de blocos de código CERCADOS
 *      (```...```) é examinado — prosa e spans inline de citação (ex:
 *      `` `gh pr checks {N} --json bucket --jq '...'` `` usado como
 *      referência) nunca contam.
 *   2. Em shell (`.sh`), linhas cujo primeiro caractere não-espaço é `#`
 *      são removidas ANTES da varredura — um comentário/docstring que cita
 *      o comando pra explicar o incidente (como o cabeçalho de
 *      `wait-pr-checks.sh` faz, citando literalmente o comando desta
 *      issue) não é código executável.
 *
 * O sinal que de fato importa é a CO-OCORRÊNCIA, numa janela pequena de
 * texto EXECUTÁVEL, de uma palavra de laço (`until`/`while`) com `gh pr
 * checks ... --json` — isso não acontece em nenhuma citação documental
 * hoje no repo (só em código real, que é exatamente o caso a barrar).
 */

/**
 * Janela (em caracteres) de tolerância entre a palavra de laço e o
 * comando — generosa o bastante pra cobrir `until gh pr checks 8397
 * --json bucket --jq 'all(.bucket != "pending")' | grep -q true; do sleep
 * 30; done` (comando real da issue, ~100 chars) com folga, mas pequena o
 * bastante pra não colidir "until"/"while" e "gh pr checks --json"
 * citados em pontos DIFERENTES e não relacionados do mesmo arquivo.
 */
const LOOP_KEYWORD = "(?:until|while)";
const GH_CHECKS_JSON = "gh\\s+pr\\s+checks\\b[\\s\\S]{0,150}?--json\\b";

const VIOLATION_RE = new RegExp(
  `\\b${LOOP_KEYWORD}\\b[\\s\\S]{0,300}?\\b${GH_CHECKS_JSON}|\\b${GH_CHECKS_JSON}[\\s\\S]{0,300}?\\b${LOOP_KEYWORD}\\b`,
  "gi",
);

/** Comentário opt-out — presente em QUALQUER lugar do texto escaneado
 *  (bloco de código / arquivo .sh já sem comentários) suprime o achado
 *  daquela unidade inteira. Existe pro caso hipotético de um exemplo
 *  didático precisar mostrar o padrão ruim dentro de um bloco cercado
 *  (ex: um post-mortem com o comando literal como código, não como prosa
 *  inline) — não usado por nenhum arquivo hoje. */
const OPT_OUT_MARKER = /guard-allow:\s*gh-pr-checks-json-loop/i;

export interface GhLoopViolation {
  /** Trecho flagrado, truncado pra legibilidade em mensagem de teste. */
  snippet: string;
}

/** Acha violações num texto já isolado como "unidade escaneável" (um
 *  bloco de código Markdown, ou um arquivo .sh inteiro com comentários
 *  removidos). Nunca lança. */
export function findGhPrChecksJsonLoopInScannedUnit(text: string): GhLoopViolation[] {
  if (OPT_OUT_MARKER.test(text)) return [];
  const out: GhLoopViolation[] = [];
  for (const m of text.matchAll(VIOLATION_RE)) {
    out.push({ snippet: m[0].length > 200 ? `${m[0].slice(0, 200)}…` : m[0] });
  }
  return out;
}

/** Extrai o conteúdo de todo bloco de código CERCADO (```...```, qualquer
 *  linguagem) de um documento Markdown — nunca prosa nem spans inline
 *  (ver docstring do módulo, item 1). */
export function extractFencedCodeBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  for (const m of markdown.matchAll(/```[a-zA-Z]*\r?\n([\s\S]*?)```/g)) {
    blocks.push(m[1]);
  }
  return blocks;
}

/** Remove linhas de comentário shell puras (1º caractere não-espaço é
 *  `#`) — preserva número de linhas (linha removida vira string vazia)
 *  porque não precisamos do número aqui, só do texto residual pra varrer
 *  (ver docstring do módulo, item 2). Código real após um `#` inline
 *  (`cmd # nota`) É preservado — só a linha 100% comentário é zerada. */
export function stripShellCommentOnlyLines(shellSource: string): string {
  return shellSource
    .split(/\r?\n/)
    .map((line) => (/^\s*#/.test(line) ? "" : line))
    .join("\n");
}

/** Varre um `.md` (fenced code blocks) ou `.sh` (arquivo inteiro, sem
 *  comentários puros) e devolve toda violação encontrada. `kind` decide
 *  qual extração aplicar. */
export function findGhPrChecksJsonLoopViolations(
  content: string,
  kind: "markdown" | "shell",
): GhLoopViolation[] {
  const units = kind === "markdown" ? extractFencedCodeBlocks(content) : [stripShellCommentOnlyLines(content)];
  const out: GhLoopViolation[] = [];
  for (const unit of units) {
    out.push(...findGhPrChecksJsonLoopInScannedUnit(unit));
  }
  return out;
}
