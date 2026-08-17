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
 *   2. Varredura do `PATH` do processo — cobre o shell do editor sem
 *      hardcode. NÃO cobre o CI: `ubuntu-latest` não tem o CLI instalado
 *      (`package.json` traz `@anthropic-ai/claude-agent-sdk`, não o
 *      `claude-code`), então lá esta função lança por construção — daí a
 *      resolução ser injetável em quem a consome, nunca chamada direto de
 *      dentro de código exercitado por teste.
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
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve as resolvePath } from "node:path";

/**
 * Predicado default: o candidato é um ARQUIVO com bit de execução?
 *
 * `existsSync` não basta — um diretório chamado `claude` no PATH, ou um
 * arquivo sem `+x`, passariam como "resolvido" e explodiriam depois no
 * `execFileSync` com `EISDIR`/`EACCES`, mensagens bem menos acionáveis que o
 * erro enumerado que esta função lança quando nada serve.
 */
export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

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
  /** Predicado de "serve como binário" — injetável pra testar sem tocar o disco.
   * Default: `isExecutableFile` (arquivo + bit de execução, não mera existência). */
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
  const fileExists = options.fileExists ?? isExecutableFile;
  const tried: string[] = [];

  // `resolvePath` e não `join`: entrada RELATIVA no PATH (`.`, `bin` — raro,
  // mas típico de ambiente mal configurado, que é o terreno desta função)
  // produziria um caminho relativo ao cwd, contradizendo o contrato de
  // devolver sempre absoluto. `resolvePath` absolutiza contra o cwd.
  const explicit = env.CLAUDE_BIN?.trim();
  if (explicit) {
    const candidate = resolvePath(explicit);
    if (fileExists(candidate)) return candidate;
    tried.push(`${candidate} (CLAUDE_BIN)`);
  }

  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = resolvePath(dir, "claude");
    if (fileExists(candidate)) return candidate;
    tried.push(candidate);
  }

  const home = env.HOME?.trim();
  if (home) {
    for (const relative of CLAUDE_BIN_HOME_CANDIDATES) {
      const candidate = resolvePath(home, relative);
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
