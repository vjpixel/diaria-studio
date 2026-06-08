/**
 * fetch-drive-docs.ts (one-off) — exporta múltiplos Docs como markdown
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { gFetch } from "./google-auth.ts";
import { unescapeMarkdown } from "./lib/markdown-unescape.ts";

const ids = process.argv.slice(2);
if (!ids.length) { console.error("usage: tsx fetch-drive-docs.ts <id1> <id2> ..."); process.exit(2); }

mkdirSync("/tmp/drive-docs", { recursive: true });
for (const id of ids) {
  console.error(`fetching ${id}...`);
  const res = await gFetch(`https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text/markdown`);
  if (!res.ok) { console.error(`  FAIL ${res.status}: ${(await res.text()).slice(0, 200)}`); continue; }
  const md = unescapeMarkdown(await res.text());
  // also get title
  const meta = await gFetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=name,modifiedTime`);
  const { name, modifiedTime } = await meta.json() as { name: string; modifiedTime: string };
  const path = `/tmp/drive-docs/${id}.md`;
  writeFileSync(path, `# ${name}\n_modifiedTime: ${modifiedTime}_\n\n${md}`, "utf8");
  console.error(`  → "${name}" (${md.length}b) → ${path}`);
}
