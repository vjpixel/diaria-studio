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
 * 7 sub-propostas; a PR #6854 implementou só o MECANISMO da allowlist (item
 * 1) e o guard de auto-modificação (item 4), com as 2 raízes novas nascendo
 * `enabled: false` (ver "Ativação" abaixo). Uma PR seguinte (residual de
 * #6817) fecha os itens 2 (leitura redigida — `scripts/read-hermes-session-
 * status.ts`), 3 (verbo único de escrita — `scripts/write-hermes-config.ts`)
 * e 5 (`scripts/lib/hermes-runtime-sensitive-paths.ts`, irmão deste módulo:
 * `sensitive-path-guard.ts` tem um invariante próprio — toda regra precisa
 * casar com um arquivo RASTREADO deste repo — que os paths de runtime do
 * Hermes, fora do git, quebrariam por construção; por isso NÃO entraram lá)
 * e ATIVA as 2 raízes (decisão do editor registrada na issue em 04/09/2026:
 * "implementar como especificado. Sem redução de escopo"). Itens 6 e 7
 * seguem residuais — ver a seção "Itens 6/7" no `SKILL.md`.
 *
 * ## Ativação das 2 raízes novas (04/09/2026)
 *
 * Nasceram `enabled: false` na PR #6854 (31/08/2026) por causa de um achado
 * concreto: sessão ATIVA em `~/hermes-agent` (fork #9, PR #13 aberta) e em
 * `~/.hermes` (config sob medição para a #6712) no mesmo dia — habilitar o
 * contínuo a escrever ali ENQUANTO isso corria reproduziria a colisão do
 * #6802. O editor decidiu ativar em 04/09/2026, depois dos guards dos itens
 * 2/5 estarem no lugar (nunca ativar com as raízes ligadas e o auth.json/
 * sessions.json sem proteção, ou o verbo de escrita sem o gate de path
 * sensível). `enabled: false` era o default seguro; ativar é decisão do
 * editor, documentada e reversível (1 campo) — o campo virou realidade.
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

/** Raízes default (#6817). As 3 nascem `enabled: true` desde 04/09/2026 —
 * decisão do editor registrada na issue ("implementar como especificado.
 * Sem redução de escopo"), tomada depois que os guards dos itens 2
 * (`read-hermes-session-status.ts`, `HARD_DENIED_SUFFIXES`) e 5
 * (`hermes-runtime-sensitive-paths.ts`) entraram no repo. Caller injeta os
 * paths reais (resolvidos, sem `~`) — este módulo não conhece `$HOME`. */
export function defaultWorkdirRoots(homeDir: string, diariaStudioPath: string): WorkdirRoot[] {
  return [
    { name: "diaria-studio", path: diariaStudioPath, enabled: true, mode: "read-write" },
    { name: "hermes-agent", path: `${homeDir}/hermes-agent`, enabled: true, mode: "read-write" },
    { name: "dot-hermes", path: `${homeDir}/.hermes`, enabled: true, mode: "read-write" },
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
