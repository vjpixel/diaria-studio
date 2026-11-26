/**
 * scripts/lib/sessions/conflicts.ts (#14004)
 *
 * Beacon de caminhos tocados (`touched_paths`) e a consulta `conflicts`
 * (`findSessionConflicts`): quem mais está mexendo nestes arquivos.
 *
 * Parte de `scripts/lib/session-registry.ts`, dividido em módulos no #14004 sem
 * mudar comportamento. Fora de `scripts/lib/sessions/`, importe sempre de
 * `session-registry.ts`, que reexporta a API pública inteira e segue sendo a
 * entrada do CLI. O docstring de topo de `session-registry.ts` continua sendo o
 * mapa do registro.
 */

import { type ActiveSessionRecord, type SessionRecord, TOUCHED_PATHS_CAP } from "./types.ts";

// ─── Beacon: caminhos tocados (#6168 Parte A) ──────────────────────────────

/**
 * Normaliza um caminho pra comparação entre sessões: separadores POSIX, sem
 * `./` inicial, sem barra final. `data/` é compartilhado entre Windows
 * (`Neo`) e Linux (`300`), então um caminho gravado com `\` por uma máquina
 * precisa casar com o mesmo caminho gravado com `/` pela outra — sem isto, a
 * detecção de sobreposição seria cega justamente no cenário cross-máquina que
 * a issue chama de caso normal.
 */
export function normalizeBeaconPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * Aplica o teto de `TOUCHED_PATHS_CAP` colapsando caminhos pra prefixo de
 * DIRETÓRIO em vez de truncar. Truncar perderia a informação de que a sessão
 * mexeu naquela área; o prefixo preserva o sinal de sobreposição (que é o que
 * `findSessionConflicts` consome) num espaço menor.
 *
 * Colapsa um nível por passada, do mais fundo pro mais raso, até caber ou até
 * não haver mais o que colapsar. Pura, determinística (saída sempre ordenada).
 */
export function collapseTouchedPaths(paths: readonly string[], cap: number = TOUCHED_PATHS_CAP): string[] {
  let current = [...new Set(paths.map(normalizeBeaconPath))].filter((p) => p !== "");
  if (current.length <= cap) return current.sort();

  // Colapsa progressivamente: a cada passada, todo caminho com mais de `depth`
  // segmentos vira o prefixo de `depth` segmentos.
  const maxDepth = Math.max(...current.map((p) => p.split("/").length));
  for (let depth = maxDepth - 1; depth >= 1; depth--) {
    current = [
      ...new Set(
        current.map((p) => {
          const parts = p.split("/");
          return parts.length > depth ? parts.slice(0, depth).join("/") : p;
        }),
      ),
    ];
    if (current.length <= cap) break;
  }
  // Ainda acima do teto mesmo colapsado ao 1º segmento (repo com muitos
  // diretórios de topo): corta, mas de forma determinística e ordenada.
  return current.sort().slice(0, cap);
}

/**
 * `true` quando dois caminhos se sobrepõem — iguais, ou um é prefixo de
 * DIRETÓRIO do outro. O teste de prefixo exige a barra (`a/b` cobre `a/b/c`,
 * mas `a/b` NÃO cobre `a/bc`) — sem isso, o colapso de `collapseTouchedPaths`
 * geraria falso positivo entre diretórios de nome parecido.
 */
export function beaconPathsOverlap(a: string, b: string): boolean {
  const x = normalizeBeaconPath(a);
  const y = normalizeBeaconPath(b);
  if (x === "" || y === "") return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

// ─── `conflicts`: consulta, nunca aquisição (#6168 Parte C) ────────────────

/**
 * Union DISCRIMINADA por `kind` — a correlação entre o tipo do conflito e os
 * campos que ele carrega é garantia de compilador, não convenção:
 *
 *   - `branch-drift` NUNCA tem `peer` (é sobre o próprio registro);
 *   - `branch-shared` e `path-overlap` SEMPRE têm;
 *   - só `path-overlap` carrega `paths`.
 *
 * Declarar isso como um shape único com campos opcionais deixaria
 * `{ kind: "path-overlap", peer: undefined }` representável — semanticamente
 * absurdo, e o consumidor precisaria re-checar `kind` antes de tocar `peer`.
 * A Parte D da #6168 prevê consumidores que vão querer `conflict.peer.sessionId`
 * pra abrir conversa com quem colidiu; a union dá exhaustiveness a eles de graça.
 */
export type SessionConflict =
  | { kind: "branch-drift"; detail: string }
  | { kind: "branch-shared"; peer: ActiveSessionRecord; detail: string }
  | { kind: "path-overlap"; peer: ActiveSessionRecord; detail: string; paths: string[] };

export interface FindSessionConflictsOptions {
  /** `sessionId` de quem pergunta — sempre excluído dos peers. */
  sessionId: string;
  /** Caminhos que esta sessão está prestes a tocar. */
  paths?: readonly string[];
  /** Branch atual do checkout de quem pergunta (`git branch --show-current`). */
  branch?: string;
  /** Registro da PRÓPRIA sessão, quando disponível — habilita `branch-drift`. */
  ownRecord?: SessionRecord | null;
  /** Tag da máquina de quem pergunta — `branch-shared` só compara peers da MESMA máquina. */
  machineTag?: string;
}

/**
 * Consulta PURA: "quem mais está mexendo nisto agora?" (#6168 Parte C).
 *
 * **Não adquire nada e não cria arquivo nenhum** — é o critério de aceite
 * explícito da issue ("nenhum arquivo de lock NOVO"). Responde e devolve o
 * peer; o que fazer com a resposta é decisão de quem chamou (Parte D:
 * conversar; Parte F: ordenar o merge).
 *
 * Três conflitos, e o primeiro é o que a evidência 5 da issue pedia:
 *
 * - **`branch-drift`** — a branch registrada por ESTA sessão no beacon não é
 *   mais a branch do checkout. Significa que outra sessão trocou o checkout
 *   embaixo (`sync-code.ts` faz `git checkout master` quando `branch !=
 *   master`, e é o Passo 0 de toda edição/rodada). Não envolve peer: é a
 *   checagem barata de "a branch ainda é minha?" antes de um `git commit`,
 *   que teria pego no ato o incidente em que `commit`/`push` reportaram
 *   sucesso e o commit foi parar em `master`.
 * - **`branch-shared`** — um peer vivo da MESMA máquina declara a mesma
 *   branch. Só faz sentido intra-máquina: máquinas diferentes têm checkouts
 *   diferentes, e homônimos de branch ali não colidem.
 * - **`path-overlap`** — caminhos desta sessão sobrepõem `touched_paths`/
 *   `dirty_paths` de um peer vivo. `dirty_paths` (não-commitado) é reportado
 *   à parte porque é o sinal mais forte: trabalho em voo, sem branch ainda.
 *
 * **Sessão `stale` nunca conflita** — usa `session.stale` (janela por kind,
 * #6168 — uma sessão interativa morta há 15 min já não bloqueia), a mesma
 * janela CURTA que `isIssueClaimedByOther` usava até o #7227. As duas
 * divergem desde então: conflito de PATH é sobre edição concorrente de
 * arquivo (silêncio curto já é sinal suficiente pra não bloquear alguém de
 * editar o mesmo arquivo), enquanto liberar uma CLAIM autoriza terceiro a
 * assumir o trabalho inteiro de outra sessão — blast radius maior, exige a
 * janela mais longa de `claimReleaseMsForKind` (ver sua docstring).
 */
export function findSessionConflicts(
  sessions: readonly ActiveSessionRecord[],
  opts: FindSessionConflictsOptions,
): SessionConflict[] {
  const conflicts: SessionConflict[] = [];
  const myPaths = (opts.paths ?? []).map(normalizeBeaconPath).filter((p) => p !== "");

  // 1. branch-drift — sobre o PRÓPRIO registro, não sobre peer.
  const knownBranch = opts.ownRecord?.branch;
  if (opts.branch && knownBranch && knownBranch !== opts.branch) {
    conflicts.push({
      kind: "branch-drift",
      detail:
        `a branch registrada por esta sessão era "${knownBranch}" e o checkout está agora em "${opts.branch}" — ` +
        "outra sessão provavelmente trocou o checkout no meio (sync-code.ts faz `git checkout master` quando a " +
        "branch não é master). Commitar agora pode cair na branch errada, com `commit`/`push` reportando sucesso.",
    });
  }

  for (const peer of sessions) {
    if (peer.sessionId === opts.sessionId) continue;
    if (peer.stale) continue;

    // 2. branch-shared — só intra-máquina (ver docstring).
    if (
      opts.branch &&
      peer.branch === opts.branch &&
      (opts.machineTag === undefined || peer.machineTag === opts.machineTag)
    ) {
      conflicts.push({
        kind: "branch-shared",
        peer,
        detail: `${peer.kind}@${peer.machineTag} declara a MESMA branch "${opts.branch}" no mesmo checkout`,
      });
    }

    // 3. path-overlap — dirty (não-commitado) é o sinal mais forte.
    if (myPaths.length > 0) {
      const peerDirty = (peer.dirty_paths ?? []).map(normalizeBeaconPath);
      const peerTouched = (peer.touched_paths ?? []).map(normalizeBeaconPath);
      const hitsDirty = myPaths.filter((mine) => peerDirty.some((theirs) => beaconPathsOverlap(mine, theirs)));
      const hitsTouched = myPaths.filter((mine) => peerTouched.some((theirs) => beaconPathsOverlap(mine, theirs)));
      const hits = [...new Set([...hitsDirty, ...hitsTouched])].sort();
      if (hits.length > 0) {
        conflicts.push({
          kind: "path-overlap",
          peer,
          paths: hits,
          detail:
            `${peer.kind}@${peer.machineTag} já tocou ${hits.length} caminho(s) em comum` +
            (hitsDirty.length > 0
              ? ` — ${hitsDirty.length} deles com edição NÃO COMMITADA (${hitsDirty.slice(0, 5).join(", ")})`
              : ""),
        });
      }
    }
  }

  return conflicts;
}
