/**
 * curadoria-data.ts (#3118 item 13)
 *
 * Camada de dados/validação comum entre os builders das páginas de curadoria
 * estática Cursos (`build-cursos-page.ts` #1745) e Livros
 * (`build-livros-page.ts` #1744). Complementa `curadoria-page.ts` (#3113 —
 * CSS/template) com o layer de leitura+validação+filtro de temas que também
 * estava duplicado quase byte-a-byte entre os dois builders:
 *
 *   - `isSafeUrl` — idêntico nos dois arquivos.
 *   - `ValidationResult` — mesma shape `{ ok, errors, warnings }`.
 *   - `availableThemes`/`distinctThemes` — mesma lógica (filtro por
 *     language/level + Set de temas), parametrizada aqui sobre qualquer item
 *     com `{ language, level, themes }`.
 *   - `loadSeedItems` — mesmo padrão "lê JSON, extrai array por chave top-level,
 *     valida, lança em erro" — só a chave (`courses` vs `books`) e a função de
 *     validação divergem entre os dois builders.
 *
 * `esc()` NÃO está aqui — já existe uma única fonte canônica em
 * `scripts/lib/html-escape.ts` (`escHtml`), que `curadoria-page.ts` já usa;
 * os builders passam a importar de lá também (era uma 3ª cópia idêntica).
 *
 * Cada builder mantém LOCAL o que é estruturalmente distinto: schema
 * (`Course` vs `Book`), regras de validação específicas de campo
 * (`validateCourses`/`validateBooks`), `distinctPlatforms` (só cursos),
 * `fmtDuration`/`fmtRating` (formatos diferentes por domínio) — nada disso é
 * duplicação, é lógica de domínio genuinamente distinta.
 */
import { readFileSync, existsSync } from "node:fs";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** URL aceita só se http(s) — defense-in-depth. Pure. */
export function isSafeUrl(u: string | undefined): boolean {
  return !!u && /^https?:\/\//i.test(u);
}

/** Shape mínimo que `availableThemes`/`distinctThemes` precisam de cada item. */
export interface ThemedItem {
  language: string;
  level: string;
  themes: string[];
}

/**
 * Temas distintos (ordenados) entre os itens que casam com `lang`/`level`
 * (vazios = sem restrição). Pure. Usado pra montar o dropdown de Tema — só
 * temas com ≥1 item no recorte atual, pra nenhuma opção zerar a lista.
 */
export function availableThemes<T extends ThemedItem>(items: T[], lang = "", level = ""): string[] {
  const set = new Set<string>();
  for (const item of items) {
    if (lang && item.language !== lang) continue;
    if (level && item.level !== level) continue;
    for (const t of item.themes ?? []) if (t) set.add(t);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

/** Todos os temas distintos (sem recorte). Pure. */
export function distinctThemes<T extends ThemedItem>(items: T[]): string[] {
  return availableThemes(items);
}

/**
 * Lê + valida um arquivo seed JSON com 1 chave top-level de array
 * (`{ "courses": [...] }` / `{ "books": [...] }`). Lança em JSON
 * inválido/ausente ou erros de schema (mesmas mensagens que os builders já
 * emitiam antes desta extração — nenhum teste depende do texto exato, mas
 * mantido por continuidade de UX de CLI).
 */
export function loadSeedItems<T>(
  seedPath: string,
  key: string,
  validate: (items: T[]) => ValidationResult,
): T[] {
  if (!existsSync(seedPath)) throw new Error(`seed não encontrado: ${seedPath}`);
  const parsed = JSON.parse(readFileSync(seedPath, "utf8")) as Record<string, T[] | undefined>;
  const items = parsed[key] ?? [];
  const v = validate(items);
  if (!v.ok) throw new Error(`seed inválido:\n  ${v.errors.join("\n  ")}`);
  return items;
}
