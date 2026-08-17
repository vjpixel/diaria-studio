/**
 * scripts/lib/resolve-claude-bin.ts (#5549)
 *
 * Resolve o caminho ABSOLUTO do binário `claude` para invocação a partir de
 * um contexto que NÃO herda o PATH do shell interativo do editor.
 *
 * Motivo (achado ao vivo 260817): `diaria-edicao-diaria.service` falhou nos 4
 * disparos entre 11 e 16/08/2026 com `spawnSync claude ENOENT`. O
 * `ExecStart=` do unit usa caminho absoluto pro node, mas
 * `run-scheduled-edicao.ts` invocava `execFileSync("claude", ...)` pelo NOME
 * — e o PATH do systemd user manager é o mínimo
 * (`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:...`), sem
 * `~/.npm-global/bin` onde o `claude` está instalado. No shell do editor
 * funciona; sob systemd, nunca funcionou — o cutover pro systemd (#5115)
 * quebrou a task e nada avisou, porque o service falhava em ~1s e o único
 * registro era o `FAIL ... tail=spawnSync claude ENOENT` em
 * `data/overnight-schedule.log`.
 *
 * Ordem de resolução (primeira que existir vence):
 *   1. `CLAUDE_BIN` do ambiente — escotilha de escape explícita (instalação
 *      fora do padrão, teste, outra versão).
 *   2. Varredura do `PATH` do processo — cobre o caso normal (shell do
 *      editor, CI) sem hardcode.
 *   3. Candidatos conhecidos de instalação por usuário — é o que salva sob
 *      systemd, onde (2) falha por construção.
 *
 * Não encontrar o binário é ERRO DURO (lança), nunca um fallback silencioso
 * pro literal `"claude"`: devolver o nome cru só empurraria o mesmo ENOENT
 * pra dentro do `execFileSync`, com a mensagem opaca que custou uma semana
 * de edições não preparadas. A mensagem lançada lista o que foi tentado.
 *
 * @see scripts/overnight/run-scheduled-edicao.ts (consumidor)
 * @see test/resolve-claude-bin.test.ts
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Candidatos de instalação por usuário, tentados quando o PATH não resolve.
 * Relativos a `$HOME` — a varredura de PATH cobre instalação de sistema. */
export const CLAUDE_BIN_HOME_CANDIDATES = [
  ".npm-global/bin/claude",
  ".local/bin/claude",
  ".claude/local/claude",
] as const;

export interface ResolveClaudeBinOptions {
  /** Ambiente consultado (`CLAUDE_BIN`, `PATH`, `HOME`). Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Predicado de existência — injetável pra testar sem tocar o disco. */
  fileExists?: (path: string) => boolean;
}

/**
 * Devolve o caminho absoluto do `claude` executável.
 *
 * @throws {Error} quando nenhum candidato existe — a mensagem enumera o que
 *   foi tentado, pra que a falha seja acionável no journal do systemd.
 */
export function resolveClaudeBin(options: ResolveClaudeBinOptions = {}): string {
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const tried: string[] = [];

  const explicit = env.CLAUDE_BIN?.trim();
  if (explicit) {
    if (fileExists(explicit)) return explicit;
    tried.push(`${explicit} (CLAUDE_BIN)`);
  }

  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "claude");
    if (fileExists(candidate)) return candidate;
    tried.push(candidate);
  }

  const home = env.HOME?.trim();
  if (home) {
    for (const relative of CLAUDE_BIN_HOME_CANDIDATES) {
      const candidate = join(home, relative);
      if (fileExists(candidate)) return candidate;
      tried.push(candidate);
    }
  }

  throw new Error(
    "binário `claude` não encontrado. Sob systemd o PATH é o mínimo do sistema e NÃO " +
      "inclui ~/.npm-global/bin — defina CLAUDE_BIN no .env (ou Environment= no unit) " +
      `apontando pro executável. Tentados: ${tried.join(", ") || "(nenhum candidato)"}`,
  );
}
