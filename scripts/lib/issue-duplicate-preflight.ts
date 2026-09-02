/**
 * scripts/lib/issue-duplicate-preflight.ts (#7020)
 *
 * Preflight de duplicidade do lado do COORDENADOR (overnight/develop/
 * continuo) — não do subagente implementador, que já tem o próprio
 * preflight (item 14 de `context/overnight-dispatch-rules.md`), mas só
 * DEPOIS do dispatch já ter custado um subagente inteiro. Quatro issues da
 * rodada 260901b já estavam resolvidas em `master` quando foram
 * despachadas — o subagente descobriu certo (item 14 funcionou), mas no
 * lugar errado: caro (~0,5–0,8M tokens desperdiçados na rodada).
 *
 * Este módulo dá ao COORDENADOR um veredito ANTES do dispatch, a partir de
 * três sinais determinísticos:
 *
 *   1. `git log origin/master --grep "#N"` — algum commit em master já cita
 *      a issue? (**sempre `origin/master`, NUNCA `--all`** — `--all` inclui
 *      refs de PR fechada/branch nunca mergeada, reproduzindo exatamente o
 *      erro que este preflight existe pra evitar: ver
 *      `scripts/lib/master-commit-fetch.ts`.)
 *   2. Se sim: o commit (corpo de squash-merge, que carrega o corpo da PR
 *      inteiro) usou `Closes #N` ou `REFS #N, NÃO CLOSES`? `Closes` sem a
 *      issue estar fechada é sinal forte de "deveria ter fechado e não
 *      fechou"; `Refs` é resíduo DECLARADO — parte do escopo ficou de fora
 *      de propósito (#5010).
 *   3. A data do commit mais recente que cita a issue é POSTERIOR ao
 *      `updatedAt` da issue? Sinal de "resolvida DEPOIS, ninguém
 *      reavaliou" — o padrão exato do #6852/#6858/#6879 (PR que fechou o
 *      resto do escopo chegou depois da última vez que alguém tocou a
 *      issue original).
 *
 * Três vereditos exclusivos (`DuplicatePreflightVerdict`) — o coordenador
 * decide entre uma unidade de CLOSEOUT barata (confirmar e fechar) ou
 * dispatch com escopo reduzido ao resíduo real. O item 14 do subagente
 * continua como rede de segurança, não como primeira linha de defesa.
 *
 * Puro: recebe os commits já buscados (`MasterCommitInfo[]`) — sem I/O, sem
 * `git`, sem rede. `scripts/lib/master-commit-fetch.ts` é quem busca.
 *
 * @see scripts/lib/master-commit-fetch.ts (fetch real via `git log`)
 * @see scripts/check-issue-duplicate-preflight.ts (CLI)
 * @see context/overnight-dispatch-rules.md item 14 (rede de segurança no subagente)
 */

/** Marcador de fechamento encontrado no corpo do commit — `unknown` quando
 * nenhum dos dois padrões aparece (commit anterior à convenção do #5010,
 * ou citação incidental sem marcador formal). Tratado como resíduo
 * DECLARADO (conservador: nunca assume "deveria estar fechada" sem o
 * marcador `Closes` explícito). */
export type CommitCloseMarker = "closes" | "refs" | "unknown";

/** `#N` sem dígito colado antes/depois — evita `#N` casar como substring de
 * `#N0`/`#1N`/`#N1` (ex: `#42` não deve casar dentro de `#420` nem `#142`). */
function numberBoundary(issueNumber: number): string {
  return `(?<!\\d)#${issueNumber}(?!\\d)`;
}

/** `Closes #N`/`closes #N` (case-insensitive, `#N` com boundary de dígito). */
function buildClosesRe(issueNumber: number): RegExp {
  return new RegExp(`\\bcloses\\s+${numberBoundary(issueNumber)}`, "i");
}

/** `REFS #N` — case-insensitive; o `, NÃO CLOSES (...)` que sempre acompanha
 * na convenção do repo (#5010) não precisa casar, só o `REFS #N` basta pra
 * distinguir do `Closes` acima. */
function buildRefsRe(issueNumber: number): RegExp {
  return new RegExp(`\\brefs\\s+${numberBoundary(issueNumber)}`, "i");
}

/** Verdadeiro se a mensagem cita `#issueNumber` em QUALQUER lugar (não só
 * via `Closes`/`Refs`) — usado por `master-commit-fetch.ts` pra filtrar,
 * com precisão de boundary de dígito, o resultado (propositalmente amplo)
 * de `git --grep`, que não suporta `\b` de forma portável entre motores de
 * regex do `git`. */
export function citesIssueNumber(commitMessage: string, issueNumber: number): boolean {
  return new RegExp(numberBoundary(issueNumber)).test(commitMessage);
}

/** Extrai o marcador de fechamento (`closes`/`refs`/`unknown`) de um corpo
 * de commit para uma issue específica. `Closes` vence se ambos aparecerem
 * (não deveria acontecer na convenção do repo, mas `Closes` é o sinal mais
 * forte dos dois — mais seguro assumir "deveria estar fechada" do que
 * "resíduo declarado" quando o texto é ambíguo). */
export function parseCommitCloseMarker(commitMessage: string, issueNumber: number): CommitCloseMarker {
  if (buildClosesRe(issueNumber).test(commitMessage)) return "closes";
  if (buildRefsRe(issueNumber).test(commitMessage)) return "refs";
  return "unknown";
}

/** Um commit de `master` que cita a issue — antes de anexar o marcador. */
export interface MasterCommitInfo {
  sha: string;
  subject: string;
  /** Corpo completo do commit (mensagem inteira, subject incluso — squash
   * merge carrega o corpo da PR aqui, onde vive o marcador `Closes`/`Refs`). */
  body: string;
  /** ISO 8601, data de autoria do commit (`%aI` do `git log`). */
  authorDateIso: string;
}

/** `MasterCommitInfo` + o marcador já extraído. */
export interface MasterCommitMatch extends MasterCommitInfo {
  closeMarker: CommitCloseMarker;
}

/** Anexa `closeMarker` a cada commit — puro, sem I/O. */
export function classifyMasterCommits(commits: MasterCommitInfo[], issueNumber: number): MasterCommitMatch[] {
  return commits.map((c) => ({ ...c, closeMarker: parseCommitCloseMarker(c.body, issueNumber) }));
}

export type DuplicatePreflightVerdict =
  /** Nenhum commit em `origin/master` cita a issue — sem indício de
   * duplicidade; seguro dispatchar normalmente. */
  | "not-in-master"
  /** Commit com `Closes #N` já em master, mas a issue segue aberta — sinal
   * forte de "deveria ter fechado e não fechou": considerar CLOSEOUT em vez
   * de dispatch. */
  | "closes-should-be-closed"
  /** Commit com `Refs #N` (ou marcador ausente/`unknown`, tratado igual por
   * conservadorismo) — resíduo declarado; dispatch com escopo REDUZIDO ao
   * que ainda falta, não o escopo original inteiro. */
  | "refs-declared-residue";

export interface DuplicatePreflightInput {
  issueNumber: number;
  /** `updatedAt` da issue (ISO 8601), de `gh issue view --json updatedAt`.
   * `null`/ausente desativa o sinal 3 (`resolvedAfterLastUpdate` sempre
   * `false`) sem afetar o veredito principal. */
  issueUpdatedAt?: string | null;
  /** Commits de `origin/master` que já citam `#issueNumber` no grep — ver
   * `scripts/lib/master-commit-fetch.ts`. Vazio = "não está em master". */
  commits: MasterCommitInfo[];
}

export interface DuplicatePreflightResult {
  verdict: DuplicatePreflightVerdict;
  /** Commits classificados, mais recente primeiro. Vazio quando `verdict`
   * é `not-in-master`. */
  matchingCommits: MasterCommitMatch[];
  /** `true` quando o commit mais recente que cita a issue é POSTERIOR ao
   * `issueUpdatedAt` passado — sinal de "resolvida depois, ninguém
   * reavaliou" (#6852/#6858/#6879). `false` quando `issueUpdatedAt` está
   * ausente ou o commit é anterior/simultâneo. */
  resolvedAfterLastUpdate: boolean;
  /** Frase pronta pro coordenador citar no plano/relatório — não é
   * instrução de código, é o texto-fonte único pra não haver 2 formas de
   * descrever o mesmo veredito em pontos diferentes da rodada. */
  recommendation: string;
}

function sortByDateDesc(commits: MasterCommitMatch[]): MasterCommitMatch[] {
  return [...commits].sort((a, b) => new Date(b.authorDateIso).getTime() - new Date(a.authorDateIso).getTime());
}

/**
 * Pure: dado o resultado já buscado de `git log origin/master --grep "#N"`
 * (nunca `--all` — ver docstring do módulo), decide o veredito de
 * duplicidade.
 */
export function assessDuplicatePreflight(input: DuplicatePreflightInput): DuplicatePreflightResult {
  const { issueNumber, issueUpdatedAt, commits } = input;
  const classified = sortByDateDesc(classifyMasterCommits(commits, issueNumber));

  if (classified.length === 0) {
    return {
      verdict: "not-in-master",
      matchingCommits: [],
      resolvedAfterLastUpdate: false,
      recommendation: `Nenhum commit em origin/master cita #${issueNumber} — sem indício de duplicidade, dispatch normal.`,
    };
  }

  const latest = classified[0];
  const updatedAtMs = issueUpdatedAt ? new Date(issueUpdatedAt).getTime() : null;
  const latestMs = new Date(latest.authorDateIso).getTime();
  const resolvedAfterLastUpdate =
    updatedAtMs !== null && Number.isFinite(updatedAtMs) && Number.isFinite(latestMs) && latestMs > updatedAtMs;

  if (latest.closeMarker === "closes") {
    return {
      verdict: "closes-should-be-closed",
      matchingCommits: classified,
      resolvedAfterLastUpdate,
      recommendation:
        `Commit ${latest.sha.slice(0, 8)} em origin/master usa "Closes #${issueNumber}" mas a issue segue aberta — ` +
        `provavelmente já resolvida por completo. Considerar CLOSEOUT (confirmar + fechar) em vez de dispatch.` +
        (resolvedAfterLastUpdate
          ? " O commit é posterior à última atualização da issue — ninguém reavaliou depois do merge."
          : ""),
    };
  }

  return {
    verdict: "refs-declared-residue",
    matchingCommits: classified,
    resolvedAfterLastUpdate,
    recommendation:
      `Commit ${latest.sha.slice(0, 8)} em origin/master cita #${issueNumber} sem "Closes" (marcador: ${latest.closeMarker}) — ` +
      `resíduo declarado ou citação incidental. Revisar o corpo da issue contra o diff do commit antes de dispatch: ` +
      `escopo pode já estar parcial/totalmente coberto — dispatchar só o resíduo real, não o escopo original inteiro.` +
      (resolvedAfterLastUpdate
        ? " O commit é posterior à última atualização da issue — o resíduo pode ter encolhido desde então, checar antes de assumir o texto original."
        : ""),
  };
}
