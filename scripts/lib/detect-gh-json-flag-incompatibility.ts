/**
 * scripts/lib/detect-gh-json-flag-incompatibility.ts (#8425)
 *
 * ─── O que este módulo existe pra impedir ────────────────────────────────
 *
 * Achado ao vivo (#8425): uma sessão peer no `300` ficou travada 5h+ num
 * laço `until gh pr checks {N} --json bucket --jq '...'; do sleep 30;
 * done`. O `gh` 2.46.0 instalado ali (apt do Ubuntu) não suporta `--json`
 * em `gh pr checks` (#6225) — o comando falha, não escreve nada em stdout,
 * `grep -q true` nunca casa, e o `until` repete PRA SEMPRE, independente do
 * estado real do PR (que já tinha mergeado 4h30 antes da medição).
 *
 * `scripts/check-pr-checks-gate.ts` já evita esse comando específico (usa
 * `gh pr view --json statusCheckRollup,mergeable,commits`, que roda na
 * versão instalada no `300`) — mas nada impedia, ATÉ este módulo, que uma
 * versão futura desse mesmo comando (ou um `gh` ainda mais antigo) falhasse
 * pelo MESMO motivo (flag/campo `--json` não suportado) e caísse só no
 * veredito `"error"` genérico, que já tem uma via de recuperação (retry até
 * `MAX_ERROR_STREAK`, `scripts/lib/wait-pr-checks.sh`) pensada pra falha
 * TRANSITÓRIA (rate-limit, blip de rede) — nunca pra uma incompatibilidade
 * PERMANENTE de versão, que 5 retries com `poll_secs` de intervalo não
 * resolve (o comando vai falhar a 6ª vez do mesmo jeito que falhou a 1ª).
 *
 * Este módulo reconhece a assinatura de erro do próprio `gh` (Cobra —
 * "unknown flag: --json" — e o erro específico de `gh pr view`/`gh pr
 * checks --json` sobre um CAMPO json não suportado, "Unknown JSON field")
 * em qualquer texto capturado (stdout, stderr, mensagem de exceção de
 * `spawnSync`), pra que o chamador saia com um veredito DEDICADO — nunca
 * confundido com "erro transitório, retry" nem, pior, com "0 achados,
 * pass". Mesmo espírito de `scripts/lib/detect-claude-binary-error.ts`
 * (#7189): reconhecer a assinatura de uma classe de erro de AMBIENTE, não
 * um veredito sobre o conteúdo checado, e permitir sair ALTO em vez de
 * mascarar como resultado real.
 *
 * ─── Uso ──────────────────────────────────────────────────────────────────
 *
 * Puro — nenhuma leitura de disco/rede, nenhum I/O. Qualquer `check-*.ts`
 * que shell-e pra um subcomando `gh ... --json ...` pode importar
 * `findGhJsonFlagIncompatibilitySignature` e checar `stdout`/`stderr`/
 * mensagem de erro do subprocesso ANTES de tratar o resultado como um
 * veredito real (mesmo padrão adotado por `scripts/check-pr-checks-gate.ts`
 * pra `findClaudeBinaryErrorSignature`).
 */

/**
 * Padrões que o `gh` (via biblioteca Cobra, e via validação própria de
 * campos `--json`) emite quando a flag/campo não existe na versão
 * instalada. Case-insensitive porque a caixa exata não é garantida entre
 * versões/locales do `gh`; sem normalizar espaço porque as 2 mensagens
 * conhecidas nunca variam nisso.
 *
 * - `unknown flag: --json` — erro genérico do Cobra quando o subcomando
 *   (ex: `gh pr checks`, versões antigas) não registrou `--json` como flag
 *   válida.
 * - `unknown json field` — erro específico do `gh` quando `--json` é
 *   suportado pelo subcomando, mas um dos CAMPOS pedidos (ex:
 *   `statusCheckRollup,mergeable,commits`) não existe na versão instalada.
 */
const GH_JSON_INCOMPATIBILITY_PATTERNS: RegExp[] = [
  /unknown flag:\s*--json/i,
  /unknown json field/i,
];

/**
 * `true` quando `text` é uma string contendo alguma das assinaturas de
 * incompatibilidade de `--json` do `gh`. Aceita qualquer tipo em `text`
 * (nunca lança) pelo mesmo motivo de `containsClaudeBinaryErrorSignature`:
 * o chamador típico está inspecionando campos de `spawnSync(...)` que podem
 * ser `null`/`Buffer`/ausentes conforme as opções passadas.
 */
export function containsGhJsonFlagIncompatibilitySignature(text: unknown): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return GH_JSON_INCOMPATIBILITY_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Varre múltiplas fontes de texto capturado (tipicamente `stdout`, `stderr`,
 * e a mensagem de um `Error` de `spawnSync`) e devolve o RÓTULO da 1ª fonte
 * em que a assinatura aparece — `null` se nenhuma contém. Ordem de
 * iteração é a ordem de inserção do objeto — o chamador decide a
 * prioridade (mesma convenção de `findClaudeBinaryErrorSignature`).
 */
export function findGhJsonFlagIncompatibilitySignature(
  sources: Record<string, unknown>,
): string | null {
  for (const [label, value] of Object.entries(sources)) {
    if (containsGhJsonFlagIncompatibilitySignature(value)) return label;
  }
  return null;
}
