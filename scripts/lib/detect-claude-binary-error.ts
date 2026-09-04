/**
 * scripts/lib/detect-claude-binary-error.ts (#7189)
 *
 * ─── O que este módulo existe pra impedir ────────────────────────────────
 *
 * Rodada `/diaria-overnight` 260902: **4 ocorrências** na mesma sessão de
 *
 * ```
 * Error: claude native binary not installed.
 *
 * Either postinstall did not run (--ignore-scripts, some pnpm configs)
 * or the platform-native optional dependency was not downloaded
 * (--omit=optional).
 * ```
 *
 * saindo **no lugar** do resultado de comandos `npx tsx …` — inclusive de
 * `scripts/check-pr-checks-gate.ts`, cujo veredito decide se um PR pode
 * mergear. Uma leitura automatizada (ou apressada) desse texto no lugar do
 * output esperado pode ler "erro de instalação" como "check reprovado" —
 * convertendo um PR verde num vermelho, ou o inverso (retry cego até o
 * texto de erro "sumir" sem que ninguém entenda o que mudou). Mesma família
 * de risco da #7140: a ferramenta responde algo que não é o resultado da
 * pergunta feita, e a resposta errada é plausível o bastante para ser
 * aceita sem checagem.
 *
 * `scripts/lib/claude-binary-layout.ts` (#7189, PR #7226) já investiga a
 * CAUSA (layout de plataforma cruzada no install global) — esse é o item 1
 * da correção sugerida na issue, fora do escopo deste módulo. Este arquivo
 * cobre o item 2, independente da causa raiz: **reconhecer a assinatura do
 * erro em qualquer texto capturado (stdout, stderr, mensagem de exceção de
 * `spawnSync`) e permitir que o chamador saia com um código de exit
 * DEDICADO** — nunca confundido com "0 achados"/"check reprovado". Mesmo
 * espírito do veredito `"error"` que `scripts/lib/pr-checks-gate.ts` já usa
 * pra "comando/payload malformado" — aqui o motivo é mais específico
 * (ambiente corrompido, não payload malformado), por isso merece seu
 * próprio veredito/exit code no lugar de cair dentro de `"error"` genérico.
 *
 * ─── Uso ──────────────────────────────────────────────────────────────────
 *
 * Puro — nenhuma leitura de disco/rede, nenhum I/O. Qualquer `check-*.ts`
 * que shell-e pra fora (via `spawnSync`/`execSync`) pode importar
 * `findClaudeBinaryErrorSignature` e checar `stdout`/`stderr`/mensagem de
 * erro do subprocesso ANTES de tratar o resultado como um veredito real —
 * mesmo padrão já adotado por `scripts/check-pr-checks-gate.ts`.
 */

/**
 * Substring exata que identifica a classe de erro — a 1ª linha da mensagem
 * que o `cli-wrapper.cjs`/`install.cjs` do pacote `@anthropic-ai/claude-code`
 * imprime quando o binário nativo da plataforma corrente não está presente
 * (ausente OU layout de outra plataforma — as duas causas emitem o mesmo
 * texto; `claude-binary-layout.ts` é quem distingue qual das duas é, quando
 * o chamador tem acesso ao install global pra investigar). Sem normalizar
 * espaço/maiúsculas de propósito: é a mensagem literal do pacote, estável
 * o bastante pra casar por substring simples — normalizar introduziria
 * superfície pra falso-negativo sem ganho real (o texto nunca varia por
 * runtime/locale, é uma string fixa do pacote).
 */
export const CLAUDE_BINARY_ERROR_SIGNATURE = "claude native binary not installed";

/**
 * `true` quando `text` é uma string contendo a assinatura do erro. Aceita
 * qualquer tipo em `text` (nunca lança) porque o chamador típico está
 * checando campos como `spawnSync(...).stdout`/`.stderr`, que podem ser
 * `null`, `Buffer`, ou ausentes conforme as opções passadas ao `spawnSync` —
 * nenhum desses formatos deveria decidir "não detectado" por acidente de
 * tipo; só `string` é considerado (chamador que passa `Buffer` deve
 * `.toString()` antes, como o resto deste repo já faz ao redor de
 * `spawnSync` com `encoding: "utf8"`).
 */
export function containsClaudeBinaryErrorSignature(text: unknown): boolean {
  return typeof text === "string" && text.includes(CLAUDE_BINARY_ERROR_SIGNATURE);
}

/**
 * Varre múltiplas fontes de texto capturado (tipicamente `stdout`, `stderr`,
 * e a mensagem de um `Error` de `spawnSync`) e devolve o RÓTULO da 1ª fonte
 * em que a assinatura aparece — `null` se nenhuma contém. O rótulo (não só
 * um booleano) existe pra que a mensagem de erro do chamador possa dizer
 * ONDE a corrupção apareceu (ex: `"detectada em stderr do subprocesso gh pr
 * view"`), útil pra quem for investigar depois.
 *
 * Ordem de iteração de `sources` é a ordem de inserção do objeto — o
 * chamador decide a prioridade passando `stdout` antes de `stderr` (ou o
 * que fizer sentido), não este módulo.
 */
export function findClaudeBinaryErrorSignature(
  sources: Record<string, unknown>,
): string | null {
  for (const [label, value] of Object.entries(sources)) {
    if (containsClaudeBinaryErrorSignature(value)) return label;
  }
  return null;
}
