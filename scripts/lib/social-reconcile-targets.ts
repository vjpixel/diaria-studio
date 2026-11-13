/**
 * scripts/lib/social-reconcile-targets.ts (#13009) — QUAIS arquivos de
 * registro de posts sociais a reconciliação pós-disparo confere.
 *
 * A PR #13016 conferia só o `06-social-published.json` das edições diárias.
 * Os outros registros com o mesmo formato (`{ posts: PostEntry[] }`) ficavam
 * com `scheduled` vencido e `url: null` para sempre:
 *
 *   - carrossel semanal: `data/weekly/{AAMMDD}/06-weekly-published.json`;
 *   - divulgação da Retrospectiva mensal:
 *     `data/monthly/{ciclo}/_internal/divulgacao-social-d{N}-published.json`;
 *   - posts da edição anual:
 *     `data/annual/{edição}/social/{post}/_internal/06-social-published.json`.
 *
 * `discoverExtraSocialStores` acha esses arquivos e devolve só os que têm
 * alguma entrada pendente (pelo predicado do chamador) agendada dentro da
 * janela — arquivo antigo, já reconciliado ou sem nada vencido não gera
 * leitura de API. O registro de Shorts (`06-shorts-published*.json`) tem outro
 * formato (`entries`/`destination`) e fica fora daqui.
 *
 * Também mora aqui `lookbackEditions` (antes em `reconcile-social-permalinks.ts`),
 * que o `verify-facebook-posts.ts` passou a usar: o Stage 0 roda no dia da
 * edição anterior, quando os posts das 15:00/19:00 dela ainda não venceram, e
 * só olhar a edição anterior deixava esses posts `scheduled` para sempre.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { PostEntry } from "./social-published-store.ts";

/**
 * AAMMDD da edição e das `n - 1` anteriores, do mais recente ao mais antigo.
 * `n < 1` vale 1; AAMMDD inválido devolve `[]`. @pure
 */
export function lookbackEditions(aammdd: string, n: number): string[] {
  if (!/^\d{6}$/.test(aammdd)) return [];
  const base = Date.UTC(2000 + Number(aammdd.slice(0, 2)), Number(aammdd.slice(2, 4)) - 1, Number(aammdd.slice(4, 6)));
  const out: string[] = [];
  for (let i = 0; i < Math.max(1, n); i++) {
    const d = new Date(base - i * 86_400_000);
    out.push(
      `${String(d.getUTCFullYear() % 100).padStart(2, "0")}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
    );
  }
  return out;
}

/** Leitura mínima de disco, injetável nos testes. */
export interface StoreFs {
  exists(p: string): boolean;
  isDir(p: string): boolean;
  list(dir: string): string[];
  readJson(p: string): unknown;
}

export const NODE_STORE_FS: StoreFs = {
  exists: (p) => existsSync(p),
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  readJson: (p) => JSON.parse(readFileSync(p, "utf8")),
};

const DIVULGACAO_RE = /^divulgacao-social-d\d+-published\.json$/;

/** Todos os arquivos de registro extras que existem sob `dataDir`, em ordem estável. */
export function listExtraSocialStores(dataDir: string, fs: StoreFs = NODE_STORE_FS): string[] {
  const out: string[] = [];
  const subdirs = (dir: string) => fs.list(dir).filter((n) => fs.isDir(join(dir, n))).sort();

  const weekly = join(dataDir, "weekly");
  for (const d of subdirs(weekly)) {
    const f = join(weekly, d, "06-weekly-published.json");
    if (fs.exists(f)) out.push(f);
  }

  const monthly = join(dataDir, "monthly");
  for (const d of subdirs(monthly)) {
    const internal = join(monthly, d, "_internal");
    for (const n of fs.list(internal).filter((x) => DIVULGACAO_RE.test(x)).sort()) out.push(join(internal, n));
  }

  const annual = join(dataDir, "annual");
  for (const a of subdirs(annual)) {
    const social = join(annual, a, "social");
    for (const p of subdirs(social)) {
      const f = join(social, p, "_internal", "06-social-published.json");
      if (fs.exists(f)) out.push(f);
    }
  }
  return out;
}

/**
 * Entrada pendente agendada dentro da janela `[now - windowDays, now]`.
 * Entrada no futuro não conta (ainda não venceu); muito antiga também não
 * (já teve as rodadas dela). @pure
 */
export function isPendingInWindow(
  entry: PostEntry,
  pending: (e: PostEntry) => boolean,
  now: Date,
  windowDays: number,
): boolean {
  if (!pending(entry)) return false;
  const ms = Date.parse(entry.scheduled_at ?? "");
  if (!Number.isFinite(ms)) return false;
  return ms <= now.getTime() && ms >= now.getTime() - windowDays * 86_400_000;
}

/**
 * Arquivos extras com ao menos uma entrada pendente na janela. Arquivo
 * ilegível é pulado (fail-soft: nunca derruba a reconciliação dos outros).
 */
export function discoverExtraSocialStores(
  dataDir: string,
  pending: (e: PostEntry) => boolean,
  now: Date,
  windowDays: number,
  fs: StoreFs = NODE_STORE_FS,
): string[] {
  return listExtraSocialStores(dataDir, fs).filter((f) => {
    let posts: unknown;
    try {
      posts = (fs.readJson(f) as { posts?: unknown } | null)?.posts;
    } catch {
      return false;
    }
    if (!Array.isArray(posts)) return false;
    return (posts as PostEntry[]).some((p) => p && typeof p === "object" && isPendingInWindow(p, pending, now, windowDays));
  });
}
