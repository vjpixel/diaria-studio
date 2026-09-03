/**
 * coordinator-territory.ts (#6957)
 *
 * Lógica PURA/testável do protocolo de duas coordenadoras com território
 * disjunto (§"Divisão de território" e §"Protocolo entre as duas" da issue
 * #6957, decisão do editor 01/09/2026).
 *
 * O protocolo em prosa não sobrevive entre sessões (memória morre); esta
 * biblioteca é a representação dele que as duas coordenadoras podem reler
 * sem depender de quem estava presente. Cada função é PURA — recebe os
 * dados já coletados (registros de sessão ativa + paths + branch) e devolve
 * um veredito. O I/O (ler os records, rodar `git`) fica no CLI
 * `scripts/check-coordinator-territory.ts`, mesmo padrão de
 * `scripts/lib/session-registry.ts` (lógica no `lib/`, CLI no `scripts/`).
 *
 * ## O que isto resolve que o registry já não resolve
 *
 * `findSessionConflicts` (#6168) responde "quem mais está mexendo nisto
 * AGORA?" — é um CONSULTA, não uma concessão. O #6957 pede mais: uma
 * coordenadora concedendo um grant de merge a outra deve CHECAR, antes de
 * conceder, que o território do beneficiário é disjunto do seu. Hoje
 * `grantMergeWindow` recusa concessão a outra coordenadora de forma
 * absoluta (#6303) — o que é certo pro caso de "duas coordenadoras
 * concorrentes no mesmo território", mas trava o caso legítimo do #6957:
 * coordenadora A (esteira/hermes) concedendo a coordenadora B (infra de
 * repo/máquina) que trabalha em paths diferentes.
 *
 * O #6957 §"Protocolo" item 2 é explícito: "Nunca conceder grant sem checar
 * colisão de path. Enquanto o guard não fizer isso sozinho, é verificação
 * manual". Esta biblioteca é o guard.
 *
 * ## Critério de território
 *
 * Árvore de arquivo disjunta, não hierarquia. Dois territórios colidem
 * quando um path de um toca o outro — o mesmo critério que
 * `findSessionConflicts` usa pra `path-overlap`, aplicado entre os DOIS
 * conjuntos de paths declarados (não só contra o que o peer já tocou).
 * `dirty_paths` (não-commitado) conta como `touched_paths` — trabalho em
 * voo é o sinal mais forte e o protocolo não distingue.
 *
 * ## Contrato
 *
 * `isTerritoryDisjoint` é PURA — recebe os paths já normalizados, nunca
 * toca filesystem. O CLI resolve os paths reais e chama esta função.
 */

export interface Territory {
  /** Nome curto do território, p/ log/relatório (ex: "esteira-hermes", "infra-repo"). */
  readonly name: string;
  /** Paths declarados deste território — normalizados (sem `./`, sem
   *  trailing slash, sem duplicate). */
  readonly paths: readonly string[];
}

export interface TerritoryCheckResult {
  readonly disjoint: boolean;
  readonly overlappingPaths: string[];
  readonly reason: string;
}

/**
 * Dois territórios são disjuntos quando NENHUM path de um bate com qualquer
 * path do outro. "Bate" é o mesmo critério de `beaconPathsOverlap`
 * (#6168): substring de path não basta — `scripts/foo.ts` não colide com
 * `scripts/foobar.ts`; a coincidência precisa ser de prefixo de
 * diretório ou arquivo igual.
 *
 * Território sem paths declarados é tratado como **indeterminado**, nunca
 * como livre: sem o que o peer declarou não há como afirmar disjunção, e o
 * #6957 diz "conceder no escuro entre pares é absolvição mútua, não guard".
 * O CLI chama esta função só quando ambos os territórios têm paths.
 */
export function isTerritoryDisjoint(a: Territory, b: Territory): TerritoryCheckResult {
  const aPaths = a.paths;
  const bPaths = b.paths;
  if (aPaths.length === 0 || bPaths.length === 0) {
    return {
      disjoint: false,
      overlappingPaths: [],
      reason: `território "${a.name}" ou "${b.name}" não declarou paths — território indeterminado, não é seguro conceder grant sem checagem (#6957 §protocolo item 2)`,
    };
  }
  const hits: string[] = [];
  for (const mine of aPaths) {
    for (const theirs of bPaths) {
      if (pathsOverlap(mine, theirs)) hits.push(theirs);
    }
  }
  const unique = [...new Set(hits)].sort();
  if (unique.length > 0) {
    return {
      disjoint: false,
      overlappingPaths: unique,
      reason: `territórios "${a.name}" e "${b.name}" colidem em ${unique.length} caminho(s): ${unique.join(", ")}`,
    };
  }
  return {
    disjoint: true,
    overlappingPaths: [],
    reason: `territórios "${a.name}" e "${b.name}" são disjuntos — ${aPaths.length} path(s) × ${bPaths.length} path(s), nenhuma coincidência`,
  };
}

/**
 * `pathsOverlap` — mesmo critério de `beaconPathsOverlap` (#6168), aqui
 * re-implementado (não importado) pra este módulo não depender do registry
 * internalizar o protocolo do #6957. Overlap é CONTENÇÃO de diretório, não
 * prefixo de nome:
 *   - `scripts/lib/foo.ts` sobrepõe `scripts/lib/foo.ts` (arquivo igual)
 *   - `scripts/lib/foo.ts` sobrepõe `scripts/lib/`        (arquivo dentro do dir)
 *   - `scripts/lib/foo.ts` NÃO sobrepõe `scripts/lib2/foo.ts`
 *   - `scripts/foo.ts`       NÃO sobrepõe `scripts/foobar.ts`
 *   - `scripts/foo.ts`       NÃO sobrepõe `scripts/bar.ts`  (irmãos, mesmo dir-pai)
 *
 * Só um path com trailing-slash (`scripts/lib/`) conta como diretório
 * contenedor — `scripts/lib` (sem slash) é um arquivo chamado "lib", não um
 * diretório. Dois arquivos no mesmo diretório pai NÃO se sobrepõem: isso
 * faria qualquer file `touched_paths` colidir com o `dirty_paths` do peer
 * só por estarem no mesmo diretório, sem conteúdo compartilhado — a regra do
 * #6957 é de árvore disjunta, não de diretório compartilhado.
 *
 * Paths são normalizados pelo CLI antes de chegar aqui; esta função não
 * normaliza (não toca filesystem, contratora de pureza).
 */
export function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  // Contenção: a diretório contém b, ou b diretório contém a.
  // Só trailing-slash conta como diretório — prefixo de nome não basta.
  if (a.endsWith("/") && b.startsWith(a)) return true;
  if (b.endsWith("/") && a.startsWith(b)) return true;
  return false;
}
