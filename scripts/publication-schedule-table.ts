/** #12748: tabela local dos registros da edição e reservas do vertical. Sem rede. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule } from "./lib/cli-args.ts";
import { configuredVerticalGrid } from "./lib/diaria/vertical-schedule-grid.ts";
import { gridFromSocialPublished, gridFromShortsPublished, slotAccounts } from "./lib/social-slot-planner.ts";
import { loadShortsConfig } from "./lib/diaria/short-video.ts";

const NAMES: Record<string, string> = {
  "linkedin:diaria": "LinkedIn página", "facebook:diaria": "Facebook diar.ia.br",
  "instagram:diaria": "Instagram diar.ia.br (collab)", "threads:diaria": "Threads diar.ia.br",
  "twitter:diaria": "X", "youtube_shorts:diaria": "YouTube Shorts", "tiktok:diaria": "TikTok",
  "linkedin:pessoal": "LinkedIn perfil", "threads:pessoal": "Threads pessoal",
};
const time = (iso: string) => new Date(Date.parse(iso) - 3 * 3600_000).toISOString().slice(11, 16);

export function publicationScheduleTable(config: unknown, edition: string, social: unknown, shorts: unknown): string {
  const cfg = loadShortsConfig(config);
  const rows = new Map<string, Record<string, string>>();
  function put(account: string, col: string, value: string) {
    if (!rows.has(account)) rows.set(account, {});
    rows.get(account)![col] = value;
  }
  for (const s of gridFromSocialPublished(social)) {
    const type = s.label?.split(" ").at(-1);
    if (type && ["um", "d1", "d2", "d3"].includes(type)) put(s.account, type, time(s.at));
  }
  for (const s of configuredVerticalGrid(config, edition)) {
    for (const account of slotAccounts(s)) put(account, "vertical", `${time(s.at)} (previsto)`);
  }
  for (const s of gridFromShortsPublished(shorts, cfg.instagramAuthorPage ?? "diaria", cfg.instagramCollaborators)) {
    for (const account of slotAccounts(s)) put(account, "vertical", time(s.at));
  }
  const lines = ["| Rede / conta | Use Melhor | D1 | D2 | D3 | Vertical |", "|---|---|---|---|---|---|"];
  for (const [account, cols] of rows) {
    lines.push(`| ${NAMES[account] ?? account} | ${["um", "d1", "d2", "d3", "vertical"].map((c) => cols[c] ?? "—").join(" | ")} |`);
  }
  return lines.join("\n");
}

if (isMainModule(import.meta.url)) {
  const edition = process.argv[2];
  if (!/^\d{6}$/.test(edition ?? "")) throw new Error("Uso: publication-schedule-table.ts AAMMDD");
  const root = resolve(import.meta.dirname, "..");
  const dir = resolve(root, "data/editions", edition, "_internal");
  const readStore = (file: string) => {
    try { return JSON.parse(readFileSync(resolve(dir, file), "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  };
  console.log(publicationScheduleTable(JSON.parse(readFileSync(resolve(root, "platform.config.json"), "utf8")), edition,
    readStore("06-social-published.json"), readStore("06-shorts-published.json")));
}
