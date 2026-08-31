/**
 * scripts/lib/continuo-workdir-allowlist.ts (#6817)
 *
 * Responde, de forma DETERMINÍSTICA, a pergunta que hoje é respondida pela
 * linha em prosa "Workdir: `/home/vjpixel/diaria-studio`. Nunca operar fora
 * dele" no `hermes-diaria-continuo/SKILL.md`: "este caminho é permitido pro
 * contínuo ler/escrever?"
 *
 * ## Por que existe (#6817)
 *
 * Pedido do editor: trocar workdir único por allowlist de raízes, pra o
 * contínuo poder trabalhar issues sobre ele mesmo (fork `vjpixel/hermes` em
 * `~/hermes-agent`, config de runtime em `~/.hermes`). A issue #6817 lista
 * 7 sub-propostas; este módulo implementa só o MECANISMO da allowlist (item
 * 1) e o guard de auto-modificação (item 4) — decisão explícita de escopo
 * desta PR, não da issue inteira:
 *
 *   - Item 2 (redação de `~/.hermes/auth.json`), item 3 (verbo de escrita
 *     de config), item 5 (extensão do `sensitive-path-guard.ts`), item 6
 *     (gate de review no fork) e item 7 (2 trackers) exigem OPERAR dentro
 *     de `~/hermes-agent`/`~/.hermes` pra fazer sentido — e as duas raízes
 *     nascem `enabled: false` nesta PR (ver `DEFAULT_WORKDIR_ROOTS`
 *     abaixo). Implementá-los contra raízes desligadas seria código morto
 *     não-testável contra o sistema real. Ficam documentados como
 *     deferidos, não implementados.
 *
 * ## Por que as 2 raízes novas nascem desligadas
 *
 * Achado concreto, não teórico (sessão de 31/08/2026, coordenação entre
 * duas sessões Claude Code): uma sessão trabalhando ATIVAMENTE em
 * `~/hermes-agent` (fork #9, PR #13 aberta, config viva sob medição para a
 * issue #6712) — habilitar o contínuo a escrever nessas raízes ENQUANTO
 * isso está em curso reproduziria a mesma classe de colisão que já
 * aconteceu neste mesmo dia (duas sessões pegando a mesma issue #6802).
 * Blast radius de colidir em `~/.hermes/config.yaml` (config de produção
 * do próprio orquestrador) ou num checkout com trabalho não commitado é
 * maior que colidir numa issue do diaria-studio. `enabled: false` é o
 * default seguro; ativar é decisão do editor, documentada e reversível
 * (1 campo).
 *
 * ## Contrato
 *
 * `isPathAllowed`/`classifySelfModification` são PUROS — recebem o path e
 * a allowlist/lista de arquivos ativos já resolvidos, nunca tocam
 * filesystem. O CLI (`scripts/check-continuo-workdir.ts`) resolve paths
 * reais e chama estas funções.
 */

export type WorkdirMode = "read-write" | "read-only" | "denied";

export interface WorkdirRoot {
  /** Nome curto pra log/relatório (ex: "diaria-studio", "hermes-agent"). */
  readonly name: string;
  /** Path absoluto da raiz (sem trailing slash), resolvido (sem `~`). */
  readonly path: string;
  /** `false` = raiz DEFINIDA mas o contínuo nunca opera nela — path sob
   * essa raiz cai no fallback "fora de qualquer raiz habilitada" (mesmo
   * resultado de um path que não bate com NENHUMA raiz da lista). Existir
   * como entry desabilitada (em vez de simplesmente ausente da lista) é
   * o que torna a decisão "ligar depois" barata — 1 campo, não uma
   * reescrita da allowlist. */
  readonly enabled: boolean;
  readonly mode: WorkdirMode;
}

/** Sub-paths NEGADOS mesmo dentro de uma raiz `enabled: true`/`read-write`
 * — checados ANTES de qualquer match de raiz, nunca dependem de nenhuma
 * raiz estar ligada. `~/.hermes/auth.json` (#6817 item 2): tokens OAuth
 * do Codex + chaves OpenRouter em claro — leitura livre por um agente
 * autônomo cujo log vai pro Telegram é vazamento a um `echo` de distância. */
export const HARD_DENIED_SUFFIXES: readonly string[] = [".hermes/auth.json"];

/** Raízes default (#6817). `diaria-studio` é a única `enabled: true` —
 * preserva o comportamento atual (workdir único) até o editor decidir
 * ativar as outras duas. Caller injeta os paths reais (resolvidos, sem
 * `~`) — este módulo não conhece `$HOME`. */
export function defaultWorkdirRoots(homeDir: string, diariaStudioPath: string): WorkdirRoot[] {
  return [
    { name: "diaria-studio", path: diariaStudioPath, enabled: true, mode: "read-write" },
    { name: "hermes-agent", path: `${homeDir}/hermes-agent`, enabled: false, mode: "read-write" },
    { name: "dot-hermes", path: `${homeDir}/.hermes`, enabled: false, mode: "read-write" },
  ];
}

export interface WorkdirDecision {
  readonly allowed: boolean;
  readonly reason: string;
  /** Nome da raiz que decidiu, quando aplicável (match hard-denied não
   * tem raiz — é um veto que precede qualquer raiz). */
  readonly root?: string;
}

/** `true` sse `path` está dentro de `rootPath` (mesmo path, ou path/algo)
 * — nunca por prefixo de string cru (evita `/home/x/diaria-studio-old`
 * casar com raiz `/home/x/diaria-studio`). */
function isUnder(path: string, rootPath: string): boolean {
  return path === rootPath || path.startsWith(`${rootPath}/`);
}

/**
 * Pura — decide se `path` (absoluto, já resolvido) é permitido pro
 * `intent` pedido, cruzando contra `roots` (ordem não importa — a
 * primeira raiz cujo path bate decide, mas paths não deveriam colidir
 * entre raízes por construção). `HARD_DENIED_SUFFIXES` sempre vence,
 * mesmo dentro de raiz habilitada.
 */
export function isPathAllowed(
  path: string,
  intent: "read" | "write",
  roots: readonly WorkdirRoot[],
): WorkdirDecision {
  if (HARD_DENIED_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
    return { allowed: false, reason: `path termina em sufixo NEGADO permanentemente (${HARD_DENIED_SUFFIXES.join(", ")}) — nunca lido/escrito, independente de qualquer raiz` };
  }

  const matchingRoot = roots.find((r) => isUnder(path, r.path));
  if (!matchingRoot) {
    return { allowed: false, reason: "path fora de qualquer raiz da allowlist" };
  }
  if (!matchingRoot.enabled) {
    return { allowed: false, reason: `raiz '${matchingRoot.name}' está DEFINIDA mas desabilitada (enabled: false) — ativação é decisão do editor`, root: matchingRoot.name };
  }
  if (matchingRoot.mode === "denied") {
    return { allowed: false, reason: `raiz '${matchingRoot.name}' tem mode: denied`, root: matchingRoot.name };
  }
  if (intent === "write" && matchingRoot.mode === "read-only") {
    return { allowed: false, reason: `raiz '${matchingRoot.name}' é read-only, escrita negada`, root: matchingRoot.name };
  }
  return { allowed: true, reason: `raiz '${matchingRoot.name}' permite ${intent} (mode: ${matchingRoot.mode})`, root: matchingRoot.name };
}

/**
 * Guard de auto-modificação (#6817 item 4) — pura. `activeSkillPaths` é a
 * lista de arquivos que o tick CORRENTE está executando (o job em
 * `~/.hermes/cron/jobs.json`, o SKILL.md sendo lido agora, o wrapper
 * `claude-openrouter.sh` que despachou este processo) — resolvida pelo
 * CLI, não por este módulo. `true` significa "este path é o chão sob os
 * pés do tick corrente — não aplicar a mudança AGORA, abrir PR pra
 * próximo tick/decisão do editor" (achado #6059: contínuo deletando a
 * própria infra no meio do próprio loop, revertido no #6060).
 */
export function isSelfModification(path: string, activeSkillPaths: readonly string[]): boolean {
  return activeSkillPaths.includes(path);
}
