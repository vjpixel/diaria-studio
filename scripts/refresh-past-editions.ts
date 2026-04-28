/**
 * Regera `context/past-editions.md` a partir de `data/past-editions-raw.json`.
 *
 * O raw JSON é a fonte canônica — o markdown é derivado. O orchestrator
 * (via subagente `refresh-dedup-runner`) alimenta este script com:
 *
 *   - modo `full`: substitui o raw JSON pelo input passado (usado no bootstrap).
 *   - modo `merge`: lê o raw JSON existente, une com o input (dedup por `id`),
 *     ordena por `published_at` desc, trunca ao `dedupEditionCount` de
 *     `platform.config.json`. (Usado nos refreshes incrementais do dia a dia.)
 *   - modo `regen-md-only` (#162): regenera apenas o MD a partir do raw
 *     existente, sem precisar de input. Usado quando o raw está atualizado
 *     mas o MD ficou stale (ex: `git pull` resetou o tracked file).
 *
 * Uso:
 *   npx tsx scripts/refresh-past-editions.ts <input.json>              # modo full
 *   npx tsx scripts/refresh-past-editions.ts <input.json> --merge      # modo incremental
 *   npx tsx scripts/refresh-past-editions.ts --regen-md-only           # só regen MD do raw
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "platform.config.json");
const RAW_PATH = resolve(ROOT, "data/past-editions-raw.json");
const MD_PATH = resolve(ROOT, "context/past-editions.md");

type Post = {
  id: string;
  title: string;
  slug?: string;
  web_url?: string;
  published_at: string; // ISO
  html?: string;
  markdown?: string;
  links?: string[];
  themes?: string[];
};

function loadConfig(): { dedupEditionCount: number } {
  if (!existsSync(CONFIG_PATH)) return { dedupEditionCount: 14 };
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return { dedupEditionCount: cfg?.beehiiv?.dedupEditionCount ?? 14 };
}

function extractLinks(content: string): string[] {
  const urls = new Set<string>();
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  for (const m of content.matchAll(re)) {
    const url = m[0].replace(/[.,);]+$/, "");
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      if (host === "diaria.beehiiv.com") continue;
      if (host.endsWith("beehiiv.com")) continue;
      urls.add(url);
    } catch {
      // ignore
    }
  }
  return [...urls];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8"));
}

function mergeById(existing: Post[], incoming: Post[]): Post[] {
  const byId = new Map<string, Post>();
  for (const p of existing) byId.set(p.id, p);
  for (const p of incoming) byId.set(p.id, p); // incoming wins on conflict (fresher data)
  return [...byId.values()];
}

export function renderMarkdown(posts: Post[]): string {
  const lines: string[] = [
    "# Últimas edições publicadas — para dedup",
    "",
    `**atualizado em:** ${new Date().toISOString().slice(0, 10)}`,
    `**edições carregadas:** ${posts.length}`,
    "",
    "Usado por `scripts/dedup.ts` para evitar repetir links ou temas das últimas edições.",
    "",
    "---",
    "",
  ];

  for (const p of posts) {
    const date = p.published_at.slice(0, 10);
    const links =
      p.links?.length
        ? p.links
        : extractLinks([p.html, p.markdown].filter(Boolean).join("\n"));
    lines.push(
      `## ${date} — "${p.title}"`,
      p.web_url ? `URL: ${p.web_url}` : "",
      "",
      "Links usados:",
      ...links.map((u) => `- ${u}`),
      ""
    );
    if (p.themes?.length) {
      lines.push("Temas cobertos:", ...p.themes.map((t) => `- ${t}`), "");
    }
    lines.push("---", "");
  }
  return lines.join("\n");
}

function main() {
  // Modo regen-md-only (#162): regenera o MD a partir do raw existente.
  // Sem input file. Útil quando git resetou o tracked MD mas o raw
  // (gitignored) está atualizado.
  if (process.argv.includes("--regen-md-only")) {
    if (!existsSync(RAW_PATH)) {
      console.error(
        "past-editions-raw.json não existe — rode bootstrap (refresh-dedup-runner em modo full) antes",
      );
      process.exit(1);
    }
    const posts = readJson<Post[]>(RAW_PATH);
    writeFileSync(MD_PATH, renderMarkdown(posts), "utf8");
    console.log(
      `Regen MD-only: regenerated past-editions.md from raw (${posts.length} posts)`,
    );
    return;
  }

  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error(
      "Usage: refresh-past-editions.ts <input.json> [--merge] | --regen-md-only",
    );
    process.exit(1);
  }

  const isMerge = process.argv.includes("--merge");
  const { dedupEditionCount } = loadConfig();

  const incoming = readJson<Post[]>(inputPath);

  let merged: Post[];
  if (isMerge && existsSync(RAW_PATH)) {
    const existing = readJson<Post[]>(RAW_PATH);
    merged = mergeById(existing, incoming);
    console.log(
      `Merge mode: ${existing.length} existing + ${incoming.length} incoming → ${merged.length} unique`
    );
  } else {
    merged = incoming;
    console.log(
      `Full mode: replacing raw store with ${incoming.length} posts` +
        (isMerge ? " (merge requested but no existing raw file — treating as full)" : "")
    );
  }

  merged.sort(
    (a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
  );
  const truncated = merged.slice(0, dedupEditionCount);

  writeFileSync(RAW_PATH, JSON.stringify(truncated, null, 2), "utf8");
  writeFileSync(MD_PATH, renderMarkdown(truncated), "utf8");

  console.log(
    `Wrote ${truncated.length} editions (dedupEditionCount=${dedupEditionCount}) → ${MD_PATH}`
  );
}

// Guard contra import em tests — só rodar main() quando invocado como CLI.
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
