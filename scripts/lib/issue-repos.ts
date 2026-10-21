/**
 * Identidade de issue multi-repo (#10618).
 *
 * Decisão do editor (20/10/2026, registrada na própria #10618): a identidade
 * de uma issue é `owner/repo#N` em todo lugar — plan.json, claims, marcadores,
 * relatórios. O número sozinho colide entre repos (o #21 existe tanto no
 * `vjpixel/diaria-studio` quanto no `vjpixel/diaria-design`).
 *
 * **Compatibilidade com dado legado (invariante deste módulo):** todo número
 * "pelado" já gravado (`claimed_issues: [123]`, `--issue 123`, `#123` num
 * plan.json antigo) continua significando `vjpixel/diaria-studio#123` — é o
 * que ele sempre significou. `parseIssueRef(123)` devolve exatamente isso, e
 * `legacyIssueNumber` faz o caminho inverso: só devolve um número quando a
 * ref é do repo default, porque é o único caso em que um consumidor legado
 * (que só entende número) interpreta certo.
 *
 * **Lista de repos num lugar só:** `platform.config.json → issue_repos`. O 1º
 * item é o repo default (o `diaria-studio`, onde as rodadas rodam). Nenhum
 * script deve hardcodar a lista — use `readIssueRepos`.
 *
 * Os hooks (`.claude/hooks/*.mjs`) são self-contained e não importam `.ts`
 * (ver docblock de `pr-create-review.mjs`); a parte deles — descobrir de qual
 * repo é o PR de um `gh pr create`/`gh pr merge` — vive em
 * `.claude/hooks/lib/gh-target-repo.mjs`. As duas cópias da constante do repo
 * default e do nome do arquivo de lock são travadas por paridade em
 * `test/issue-repos-10618.test.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Repo onde as rodadas rodam e cujo número "pelado" é o significado legado. */
export const DEFAULT_ISSUE_REPO = "vjpixel/diaria-studio";

export interface IssueRef {
  /** `owner/name`, sempre em minúsculas (GitHub trata owner/repo sem caixa). */
  repo: string;
  number: number;
}

const REPO_SLUG_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/;

/**
 * Normaliza `owner/name` (aceita também `github.com/owner/name`, URL https e
 * sufixo `.git`). `null` quando não é um slug reconhecível — nunca adivinha.
 */
export function normalizeRepoSlug(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (s === "") return null;
  s = s.replace(/^https?:\/\//i, "").replace(/^(?:www\.)?github\.com\//i, "");
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = REPO_SLUG_RE.exec(s);
  if (!m) return null;
  return `${m[1]}/${m[2]}`.toLowerCase();
}

/** `true` quando `repo` é o repo default (o significado de um número pelado). */
export function isDefaultIssueRepo(repo: string | null | undefined): boolean {
  return normalizeRepoSlug(repo ?? "") === DEFAULT_ISSUE_REPO;
}

/**
 * Lê uma identidade de issue. Formas aceitas:
 *   - `123` (number) / `"123"` / `"#123"` → repo default (legado);
 *   - `"owner/repo#123"`;
 *   - `"https://github.com/owner/repo/issues/123"` (também `/pull/123`).
 *
 * `defaultRepo` só vale pras formas sem repo. `null` em qualquer entrada que
 * não seja inequívoca (número não-inteiro, ≤0, slug inválido) — o caller
 * decide como falhar; este parser nunca chuta.
 */
export function parseIssueRef(
  input: string | number | null | undefined,
  defaultRepo: string = DEFAULT_ISSUE_REPO,
): IssueRef | null {
  const fallbackRepo = normalizeRepoSlug(defaultRepo);
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input) || input <= 0 || !fallbackRepo) return null;
    return { repo: fallbackRepo, number: input };
  }
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (s === "") return null;

  const bare = /^#?(\d+)$/.exec(s);
  if (bare) return parseIssueRef(Number(bare[1]), defaultRepo);

  const url = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/i.exec(s);
  if (url) {
    const repo = normalizeRepoSlug(url[1]);
    const n = Number(url[2]);
    return repo && Number.isSafeInteger(n) && n > 0 ? { repo, number: n } : null;
  }

  const qualified = /^([^#\s]+)#(\d+)$/.exec(s);
  if (qualified) {
    const repo = normalizeRepoSlug(qualified[1]);
    const n = Number(qualified[2]);
    return repo && Number.isSafeInteger(n) && n > 0 ? { repo, number: n } : null;
  }
  return null;
}

/** Forma canônica: `owner/repo#N`, sempre qualificada (decisão do editor). */
export function formatIssueRef(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

/** Atalho: parse + format. `null` quando a entrada não é uma identidade válida. */
export function canonicalIssueKey(
  input: string | number | null | undefined,
  defaultRepo: string = DEFAULT_ISSUE_REPO,
): string | null {
  const ref = parseIssueRef(input, defaultRepo);
  return ref ? formatIssueRef(ref) : null;
}

/** `true` quando as duas entradas apontam pra MESMA issue (mesmo repo e número). */
export function sameIssue(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  defaultRepo: string = DEFAULT_ISSUE_REPO,
): boolean {
  const ka = canonicalIssueKey(a, defaultRepo);
  return ka !== null && ka === canonicalIssueKey(b, defaultRepo);
}

/**
 * Caminho inverso do legado: o número a gravar num campo que só entende
 * número (`claimed_issues: number[]`, `--issue N`) — e só quando a ref é do
 * repo default. Ref de outro repo devolve `null`: gravar o número dela num
 * campo legado faria `#21` do diaria-design virar `#21` do diaria-studio.
 */
export function legacyIssueNumber(ref: IssueRef): number | null {
  return isDefaultIssueRepo(ref.repo) ? ref.number : null;
}

/**
 * Nome do arquivo do merge lock POR REPO (decisão do editor: a linearidade do
 * squash só importa dentro de um mesmo repo, então dois repos nunca se
 * serializam). O repo default mantém o nome histórico `.merge-lock.json` —
 * sessões já rodando, hooks e o painel continuam lendo o mesmo arquivo. Os
 * outros ganham sufixo; o ponto inicial mantém o arquivo fora das varreduras
 * de registro (`readdirSync` filtra dotfiles).
 *
 * Espelhado em `.claude/hooks/lib/gh-target-repo.mjs` (`mergeLockFileName`),
 * paridade travada por teste.
 */
export function mergeLockFileName(repo: string | null | undefined = DEFAULT_ISSUE_REPO): string {
  const slug = normalizeRepoSlug(repo ?? "") ?? DEFAULT_ISSUE_REPO;
  if (slug === DEFAULT_ISSUE_REPO) return ".merge-lock.json";
  return `.merge-lock--${slug.replace("/", "--")}.json`;
}

/**
 * Lista de repos cujas issues as rodadas listam/agem (`platform.config.json →
 * issue_repos`). Sempre começa pelo repo default, mesmo que o config o omita
 * ou o coloque em outra posição; duplicatas e slugs inválidos são descartados.
 * Config ausente/ilegível → só o default (comportamento pré-#10618).
 */
export function readIssueRepos(config?: { issue_repos?: unknown } | null): string[] {
  const out = [DEFAULT_ISSUE_REPO];
  const raw = config?.issue_repos;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const slug = typeof item === "string" ? normalizeRepoSlug(item) : null;
      if (slug && !out.includes(slug)) out.push(slug);
    }
  }
  return out;
}

/** `readIssueRepos` lendo `platform.config.json` de `repoRoot`. Fail-soft. */
export function loadIssueRepos(repoRoot: string): string[] {
  try {
    const config = JSON.parse(readFileSync(join(repoRoot, "platform.config.json"), "utf8")) as {
      issue_repos?: unknown;
    };
    return readIssueRepos(config);
  } catch {
    return readIssueRepos(null);
  }
}
