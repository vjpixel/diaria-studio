/**
 * scripts/lib/issue-file-collisions.ts (#7137, item 3)
 *
 * Lógica PURA da "versão de tempo-de-plano" de `findSessionConflicts`
 * (`scripts/lib/session-registry.ts`, `conflicts --paths`): aquele responde
 * "quem mais está mexendo nisto AGORA" pra sessões em voo; este responde
 * "quais issues ABERTAS do backlog vão colidir se as duas forem
 * implementadas" — derivado, não declarado, a partir dos paths que as
 * próprias issues já listam na seção "Escopo" (convenção do #7112: issues-
 * filhas listam caminhos concretos de arquivo).
 *
 * Reusa `normalizeBeaconPath`/`beaconPathsOverlap` de `session-registry.ts`
 * — mesma semântica de overlap (path idêntico OU um é prefixo de diretório
 * do outro), pra não divergir do mecanismo irmão.
 *
 * **Extração de paths do corpo:** regex sobre trechos entre crases
 * (inline code, ` `caminho`) — cobre tanto crase simples quanto blocos de
 * código cercados (que markdown também delimita com crase tripla, mas o
 * conteúdo interno já cai no mesmo padrão linha a linha). Exige pelo menos
 * 1 "/" e uma extensão reconhecida de arquivo de código/config deste repo —
 * sem isso, qualquer palavra com ponto (ex: "v1.2", "gpt-4.1") viraria falso
 * positivo.
 *
 * **Filtro de falso-positivo (paths genéricos demais):** um path como
 * `package.json` ou `CLAUDE.md` sozinho aparece em dezenas de issues sem
 * que isso signifique colisão real de trabalho — é citado como contexto,
 * não como alvo de edição. Regra adotada: a interseção entre 2 issues só
 * vira `IssueFileCollision` se tiver PELO MENOS 1 path fora da
 * `GENERIC_PATH_DENYLIST`. Paths genéricos que também colidem entram no
 * relatório (contexto), mas nunca sozinhos disparam um achado.
 */

import { normalizeBeaconPath, beaconPathsOverlap } from "./session-registry.ts";

export interface IssueWithPaths {
  number: number;
  title?: string;
  paths: string[];
}

export interface IssueFileCollision {
  a: { number: number; title?: string };
  b: { number: number; title?: string };
  /** Paths em comum (normalizados, ordenados) — inclui genéricos quando
   * coexistem com pelo menos 1 path específico. */
  paths: string[];
}

/** Extensões reconhecidas como "arquivo de código/config deste repo" — path
 * sem uma destas nunca é extraído (evita casar "v1.2", "gpt-4.1", etc). */
const RECOGNIZED_EXTENSIONS = [
  "ts",
  "tsx",
  "js",
  "mjs",
  "cjs",
  "md",
  "json",
  "yml",
  "yaml",
  "sh",
  "ps1",
  "csv",
  "html",
  "css",
];

const EXT_ALTERNATION = RECOGNIZED_EXTENSIONS.join("|");

// Caminho relativo de repo entre crases: começa com um segmento de
// diretório/arquivo (letras, dígitos, _.-), tem pelo menos 1 "/", e termina
// numa extensão reconhecida. Ex: `scripts/foo.ts`, `.claude/skills/bar/SKILL.md`,
// `test/baz.test.ts`, `context/editorial-rules.md`.
const BACKTICK_PATH_RE = new RegExp(
  "`([\\w.\\-]+(?:/[\\w.\\-]+)+\\.(?:" + EXT_ALTERNATION + "))`",
  "g",
);

/** Paths comuns demais pra sinalizar colisão sozinhos — citados como
 * contexto em quase qualquer issue, não como alvo específico de edição. */
export const GENERIC_PATH_DENYLIST = new Set(
  [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "CLAUDE.md",
    "README.md",
    "platform.config.json",
    ".gitignore",
    "docs/scheduled-tasks-registry.md",
  ].map(normalizeBeaconPath),
);

/**
 * Extrai paths de arquivo do corpo de uma issue — só trechos entre crase
 * simples (cobre inline code e, linha a linha, o conteúdo de blocos
 * cercados). Dedup + normalizado + ordenado.
 */
export function extractFilePathsFromIssueBody(body: string | null | undefined): string[] {
  if (!body) return [];
  const found = new Set<string>();
  for (const m of body.matchAll(BACKTICK_PATH_RE)) {
    const normalized = normalizeBeaconPath(m[1]);
    if (normalized) found.add(normalized);
  }
  return [...found].sort();
}

/** Duas issues colidem por path se pelo menos 1 par de paths se sobrepõe
 * (idêntico ou prefixo de diretório) via `beaconPathsOverlap`. */
function overlappingPaths(a: readonly string[], b: readonly string[]): string[] {
  const hits = new Set<string>();
  for (const pa of a) {
    for (const pb of b) {
      if (beaconPathsOverlap(pa, pb)) {
        hits.add(pa);
        hits.add(pb);
      }
    }
  }
  return [...hits].sort();
}

/**
 * Computa colisões par-a-par entre issues abertas, a partir dos paths que
 * cada uma já lista no corpo. Só reporta um par se a interseção tiver pelo
 * menos 1 path fora de `GENERIC_PATH_DENYLIST` (ver docstring do módulo).
 *
 * O(n²) nos pares de issues — aceitável pro volume do backlog aberto deste
 * repo (dezenas, não milhares).
 */
export function computeIssueFileCollisions(issues: readonly IssueWithPaths[]): IssueFileCollision[] {
  const collisions: IssueFileCollision[] = [];
  for (let i = 0; i < issues.length; i++) {
    for (let j = i + 1; j < issues.length; j++) {
      const a = issues[i];
      const b = issues[j];
      if (a.number === b.number) continue; // defesa: nunca colide consigo mesma
      const hits = overlappingPaths(a.paths, b.paths);
      if (hits.length === 0) continue;
      const hasSignal = hits.some((p) => !GENERIC_PATH_DENYLIST.has(p));
      if (!hasSignal) continue;
      collisions.push({
        a: { number: a.number, title: a.title },
        b: { number: b.number, title: b.title },
        paths: hits,
      });
    }
  }
  return collisions;
}
