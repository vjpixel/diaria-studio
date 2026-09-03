#!/usr/bin/env npx tsx
/**
 * scripts/check-claude-binary-layout.ts (#7189)
 *
 * Ferramenta de investigação ad-hoc pra confirmar/diagnosticar a classe de
 * erro `Error: claude native binary not installed.` — ver o docblock de
 * `scripts/lib/claude-binary-layout.ts` pro histórico completo e o
 * mecanismo que a rodada `/diaria-overnight` 260902 descobriu.
 *
 * ─── Achado adicional (investigação desta issue, 03/09/2026) ───────────────
 *
 * A mensagem não sai só de rodar `claude` explicitamente — o Claude Code
 * instala, na sessão de shell interativa, FUNÇÕES que substituem `grep` e
 * `find` por chamadas ao próprio binário nativo (`ugrep`/`bfs` embutidos,
 * via `$CLAUDE_CODE_EXECPATH` ou `~/.local/bin/claude`, `exec -a ugrep
 * "$_cc_bin" ...`). Quando esse binário está com o layout de plataforma
 * ERRADO (ex: `$CLAUDE_CODE_EXECPATH` apontando pra `bin/claude.exe` numa
 * máquina Linux — reproduzido ao vivo durante esta investigação), QUALQUER
 * comando Bash que rode `grep`/`find` internamente — inclusive dentro de um
 * pipe (`algo | grep ...`) — falha com esse texto no lugar do resultado.
 * `cat`/`ls`/`sed`/`awk`/`head`/`tail` NÃO são wrapped (confirmado via
 * `type` na mesma investigação) — só `grep`/`find`. Isso explica a
 * intermitência relatada na issue (a variável de ambiente é fixada quando a
 * sessão do harness inicia; se o layout global mudar DEPOIS, sessões
 * antigas continuam vendo o valor velho até reabrir) e por que o erro não
 * está em nenhum script deste repo pra "consertar por dentro" — é
 * comportamento do PRÓPRIO shell wrapper do Claude Code, fora do repo.
 *
 * **Caracterização do gatilho, corroborada por uma 2ª sessão na mesma
 * investigação (#7189):** o modo de falha é PIOR do que "erro no lugar do
 * resultado" — num pipeline com MAIS DE UM `grep` (ex: `... | grep -E "^[+-]"
 * | grep -v "^[+-][+-]"`), a mensagem de erro sai DUAS VEZES, intercalada
 * linha a linha consigo mesma. Não é um hook reentrando — são 2 processos
 * `grep`-função distintos na mesma pipeline, cada um fazendo `exec -a ugrep
 * "$_cc_bin" ...` concorrentemente, cada um imprimindo o mesmo erro ao mesmo
 * tempo; a saída entrelaçada é 2 streams concorrentes na mesma pipe, não
 * corrupção. Mais importante: como cada `grep`/`find` wrapped roda `exec`
 * (substitui o processo, não empilha um fallback), a saída LEGÍTIMA do grep
 * real nunca chega a rodar — o comando não "falha alto" de forma inequívoca
 * pra quem só olha stdout; um consumidor que faça parsing programático pode
 * ler isso como "0 resultados" em vez de "erro de infraestrutura". Nenhum
 * script deste repo intercepta isso (é anterior a qualquer `node` rodar) —
 * mas *qualquer* script/subagente que precise de um resultado confiável de
 * `grep`/`find` dentro de um pipe, nesta classe de ambiente, deveria preferir
 * `Grep`/`Glob` (ferramentas do harness, que não passam pelo shell wrapped)
 * ou `readdirSync`/regex em Node em vez de `child_process` chamando
 * `grep`/`find` via shell interativo.
 *
 * ─── O que este script faz ───────────────────────────────────────────────
 *
 * Localiza o install do `@anthropic-ai/claude-code` (via `$CLAUDE_CODE_EXECPATH`
 * ou `--exec-path`), lista `bin/` e chama `diagnoseClaudeBinaryLayout` (pura,
 * testada em `test/claude-binary-layout.test.ts`) pra confirmar se o layout
 * bate com a plataforma corrente. Não conserta nada — só nomeia a causa e
 * imprime o comando de correção com o caminho GLOBAL certo.
 *
 * Uso:
 *   npx tsx scripts/check-claude-binary-layout.ts [--exec-path <path>]
 *
 * Exit codes:
 *   0 = ok (layout bate com a plataforma corrente)
 *   1 = wrong-platform-layout (achado da #7189 — nomeia a causa real)
 *   2 = missing (postinstall genuinamente não rodou)
 *   3 = unknown-platform / não foi possível localizar o install
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { arch, platform } from "node:os";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { diagnoseClaudeBinaryLayout, type ClaudeBinaryLayoutInput } from "./lib/claude-binary-layout.ts";

/** Espelha `getPlatformKey()` de `cli-wrapper.cjs` do pacote instalado — só
 * a parte relevante pro diagnóstico (nome do binário depende só do prefixo
 * `win32-`, ver `expectedBinaryName` em `claude-binary-layout.ts`); não
 * precisa da distinção musl/android pra decidir `claude` vs `claude.exe`. */
function currentPlatformKey(): string {
  return `${platform()}-${arch()}`;
}

/** Resolve o `execPath` a investigar: `--exec-path` explícito >
 * `$CLAUDE_CODE_EXECPATH` > `null` (nada pra investigar). */
function resolveExecPath(argv: string[]): string | null {
  const explicit = getArg(argv, "exec-path");
  if (explicit) return explicit;
  const fromEnv = process.env.CLAUDE_CODE_EXECPATH;
  return fromEnv && fromEnv.trim() !== "" ? fromEnv : null;
}

const EXIT_CODES: Record<ReturnType<typeof diagnoseClaudeBinaryLayout>["verdict"], number> = {
  ok: 0,
  "wrong-platform-layout": 1,
  missing: 2,
  "unknown-platform": 3,
};

export function run(argv: string[]): { exitCode: number; output: string } {
  const execPath = resolveExecPath(argv);
  if (!execPath) {
    return {
      exitCode: 3,
      output:
        "[check-claude-binary-layout] não foi possível localizar o install: " +
        "$CLAUDE_CODE_EXECPATH ausente e --exec-path não foi passado.",
    };
  }

  // execPath aponta pro binário dentro de bin/ (ex: .../claude-code/bin/claude.exe)
  // — installRoot é o diretório pai de bin/.
  const binDir = dirname(execPath);
  const installRoot = dirname(binDir);

  if (!existsSync(binDir)) {
    return {
      exitCode: 3,
      output: `[check-claude-binary-layout] bin/ não existe em ${binDir} (execPath: ${execPath}) — install parece ausente/movido.`,
    };
  }

  let binEntries: string[];
  try {
    binEntries = readdirSync(binDir);
  } catch (e) {
    return {
      exitCode: 3,
      output: `[check-claude-binary-layout] falha lendo ${binDir}: ${(e as Error).message}`,
    };
  }

  const input: ClaudeBinaryLayoutInput = {
    platformKey: currentPlatformKey(),
    binEntries,
    installRoot,
  };
  const diagnosis = diagnoseClaudeBinaryLayout(input);

  const lines = [
    `execPath investigado: ${execPath}`,
    `bin/ (${binDir}): ${binEntries.join(", ") || "(vazio)"}`,
    `plataforma corrente: ${input.platformKey}`,
    `veredito: ${diagnosis.verdict}`,
    diagnosis.message,
  ];
  return { exitCode: EXIT_CODES[diagnosis.verdict], output: lines.join("\n") };
}

if (isMainModule(import.meta.url)) {
  const { exitCode, output } = run(process.argv.slice(2));
  if (exitCode === 0) {
    console.log(output);
  } else {
    console.error(output);
  }
  process.exit(exitCode);
}
