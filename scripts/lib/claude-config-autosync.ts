/**
 * claude-config-autosync.ts (#6310)
 *
 * Lógica PURA por trás do hook `SessionStart` que auto-arma o sync do repo
 * `claude-config` (`github.com/vjpixel/claude-config`) em qualquer máquina
 * que abra o `diaria-studio` — sem depender de alguém lembrar de rodar
 * `bootstrap.sh`/`bootstrap.ps1` à mão (#4804 documentou o mecanismo
 * original; #6310 é a issue "nada puxa isso automaticamente").
 *
 * ## Por que este módulo existe separado do hook
 *
 * O hook em si (`.claude/hooks/session-start-claude-config-sync.mjs`) é
 * **self-contained** — não importa `.ts` (mesmo motivo documentado nos hooks
 * irmãos: um import estático de `.ts` quebra o hook inteiro, silenciosamente,
 * num Node sem type-stripping nativo). A decisão em si — "dado o estado atual
 * da máquina, o que fazer?" — é pura e determinística o bastante pra merecer
 * teste isolado, então vive aqui e é DUPLICADA (não importada) no hook, no
 * mesmo padrão já usado por `block-branch-checkout-main.mjs` (duplica de
 * `session-registry.ts`) e `session-beacon.mjs`.
 *
 * Este módulo não roda `git clone`/`git pull`/o bootstrap de verdade — isso é
 * efeito de rede e IO, testado manualmente em runtime real (não é o objetivo
 * do teste automatizado deste PR; ver `context/overnight-dispatch-rules.md`
 * item do dispatch: "não precisa testar o git clone/bootstrap.ps1 de
 * verdade"). O que É testável isoladamente, e é o que vive aqui:
 *
 *   - `resolvePlatformKind` — Linux/macOS (`bootstrap.sh`) vs Windows
 *     (`bootstrap.ps1`), a partir de `process.platform`.
 *   - `decideClaudeConfigAutosyncAction` — clonar, rodar bootstrap, ou não
 *     fazer nada, a partir do estado observado (repo existe? já está
 *     armado/symlinkado? debounce recente?).
 *   - `shouldDebounce` — evita reclonar/rebootstrap a cada sessão nova
 *     quando várias sessões abrem em sequência rápida (requisito 3 do
 *     dispatch: "não é obrigatório" ter lock, mas ajuda).
 *
 * ## Contrato de segurança (espelha `sync-check.cjs`, já em produção)
 *
 * O HOOK que consome este módulo precisa, sempre:
 *   - nunca bloquear o início da sessão (auto-destacamento — spawn detached +
 *     `process.exit(0)` imediato no pai, mesmo padrão de `sync-check.cjs`);
 *   - nunca lançar uma exceção não capturada até o runtime do hook (try/catch
 *     em volta de TUDO, sempre `exit 0`);
 *   - nunca fazer merge/rebase/stash automático — só `clone` (repo ausente) e
 *     o bootstrap oficial do `claude-config` (que por sua vez faz
 *     `git pull --ff-only`, nunca força).
 *
 * Este módulo, por ser puro, não tem esse cuidado embutido — é
 * responsabilidade do CALLER (o hook) envolver toda chamada em try/catch.
 * As funções aqui não lançam por design em nenhum input válido do seu
 * próprio tipo, mas isso não substitui o try/catch no hook (defesa em
 * profundidade — não confiar só em "a função não deveria lançar").
 *
 * @see docs/claude-config-sync.md — mecanismo completo, painel por máquina
 * @see CLAUDE.md § Setup item 8
 */

export type Platform = "windows" | "unix";

/** Deriva o "kind" de plataforma relevante pra escolha do script de
 * bootstrap — só duas categorias importam aqui (Windows usa `.ps1`, todo o
 * resto usa `.sh`), então não expõe o `process.platform` bruto. Aceita
 * string solta (não só `NodeJS.Platform`) pra não acoplar teste/hook ao tipo
 * do Node — o hook `.mjs` passa `process.platform` direto. */
export function resolvePlatformKind(rawPlatform: string): Platform {
  return rawPlatform === "win32" ? "windows" : "unix";
}

/** Nome do script de bootstrap pra cada plataforma — fonte única, evita
 * `"bootstrap.sh"`/`"bootstrap.ps1"` espalhados como string mágica em mais
 * de um lugar (hook + teste). */
export function bootstrapScriptName(platform: Platform): "bootstrap.sh" | "bootstrap.ps1" {
  return platform === "windows" ? "bootstrap.ps1" : "bootstrap.sh";
}

export interface AutosyncStateInput {
  /** `~/claude-config/.git` existe (clone real, não só um diretório vazio)? */
  repoExists: boolean;
  /** `~/.claude/settings.json` já é symlink APONTANDO pro repo (ou seja, o
   * bootstrap já rodou com sucesso nesta máquina pelo menos 1x)? Uma vez
   * `true`, o próprio `SessionStart` hook vendorado NO `claude-config`
   * (`sync-check.cjs`, já sincronizado por estar dentro do repo) assume o
   * trabalho de manter o repo atualizado — não é preciso rebootstrapar a
   * cada sessão. */
  isArmed: boolean;
  /** Timestamp ISO da última vez que ESTE hook (não o `sync-check.cjs` do
   * `claude-config`) rodou uma ação de clone/bootstrap nesta máquina, ou
   * `null` se nunca rodou / estado ilegível. */
  lastRunAt: string | null;
  /** Agora, injetável pra teste determinístico. */
  now: Date;
  /** Janela de debounce em ms — dentro dela, uma 2ª sessão aberta em
   * sequência não repete clone/bootstrap. Default exportado abaixo. */
  debounceMs: number;
}

export const DEFAULT_AUTOSYNC_DEBOUNCE_MS = 60 * 60 * 1000; // 1h

export type AutosyncAction =
  | { kind: "clone-and-bootstrap"; reason: string }
  | { kind: "bootstrap"; reason: string }
  | { kind: "skip"; reason: string };

/** `true` quando a última execução registrada está dentro da janela de
 * debounce — puro, sem tocar relógio/disco (ambos injetados pelo caller). */
export function shouldDebounce(lastRunAt: string | null, now: Date, debounceMs: number): boolean {
  if (lastRunAt === null) return false;
  const last = Date.parse(lastRunAt);
  if (Number.isNaN(last)) return false; // estado corrompido/ilegível -> não debounce, deixa rodar
  return now.getTime() - last < debounceMs;
}

/**
 * Decide a ação do hook dado o estado observado da máquina. Três saídas
 * possíveis, mutuamente exclusivas (primeira regra que casa vence):
 *
 *   1. Debounce ativo -> `skip` (2ª sessão aberta minutos depois da 1ª não
 *      repete trabalho de rede).
 *   2. Repo ausente -> `clone-and-bootstrap` (clona, depois roda o bootstrap
 *      da plataforma certa pra criar os symlinks).
 *   3. Repo presente mas nunca armado (settings.json ainda não é symlink) ->
 *      `bootstrap` (só roda o bootstrap — o `git pull` já é feito por ele
 *      mesmo, `--ff-only`, ver `bootstrap.sh`).
 *   4. Repo presente E já armado -> `skip` — o `SessionStart` hook do
 *      PRÓPRIO `claude-config` (`sync-check.cjs`) já assumiu o pull
 *      recorrente; rebootstrapar aqui seria trabalho redundante a cada
 *      sessão (requisito de idempotência do dispatch).
 *
 * Nunca lança para nenhuma combinação do input tipado — decisão puramente
 * estrutural, sem IO.
 */
export function decideClaudeConfigAutosyncAction(input: AutosyncStateInput): AutosyncAction {
  if (shouldDebounce(input.lastRunAt, input.now, input.debounceMs)) {
    return { kind: "skip", reason: "debounce-ativo" };
  }
  if (!input.repoExists) {
    return { kind: "clone-and-bootstrap", reason: "repo-ausente" };
  }
  if (!input.isArmed) {
    return { kind: "bootstrap", reason: "repo-existe-mas-nao-armado" };
  }
  return { kind: "skip", reason: "ja-armado-sync-check-cjs-assume" };
}
