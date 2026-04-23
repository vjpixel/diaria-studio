/**
 * Regera `context/audience-profile.md` combinando duas fontes:
 *
 *   1. **CTR comportamental** (primário) — `data/link-ctr-table.csv`
 *      Gerado por `build-link-ctr.ts`. Mostra o que a audiência realmente clica.
 *
 *   2. **Survey declarativo** (secundário) — `data/audience-raw.json`
 *      Gerado via Beehiiv MCP (/diaria-atualiza-audiencia). Mostra quem são
 *      e o que dizem preferir.
 *
 * Subscriber count vem de `data/beehiiv-cache/publication.json`.
 *
 * Qualquer fonte pode estar ausente — o script gera o que conseguir.
 *
 * Uso:
 *   npx tsx scripts/update-audience.ts                    # usa fontes cached
 *   npx tsx scripts/update-audience.ts audience-raw.json  # força survey file
 *
 * Roda automaticamente no Stage 0 (após build-link-ctr.ts) e manualmente
 * via /diaria-atualiza-audiencia (quando há survey nova).
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "context/audience-profile.md");
const HISTORY_DIR = resolve(ROOT, "context/audience-history");
const CTR_CSV = resolve(ROOT, "data/link-ctr-table.csv");
const SURVEY_JSON = resolve(ROOT, "data/audience-raw.json");
const PUB_JSON = resolve(ROOT, "data/beehiiv-cache/publication.json");

// ─── Survey helpers ────────────────────────────────────────────────────────────

type BeehiivResponse = {
  id: string;
  status?: string;
  answers: { question_id: string; question_prompt: string; answer: string }[];
};

function countAnswers(responses: BeehiivResponse[], questionMatcher: RegExp) {
  const counts = new Map<string, number>();
  let total = 0;
  for (const r of responses) {
    for (const a of r.answers) {
      if (!questionMatcher.test(a.question_prompt)) continue;
      if (!a.answer) continue;
      counts.set(a.answer, (counts.get(a.answer) || 0) + 1);
      total += 1;
    }
  }
  return [...counts.entries()]
    .map(([label, n]) => ({ label, weight: total ? +(n / total).toFixed(3) : 0, count: n }))
    .sort((a, b) => b.weight - a.weight);
}

// ─── CTR helpers ───────────────────────────────────────────────────────────────

interface CtrAgg {
  count: number;
  clicks: number;
  opens: number;
}

function ctrPct(a: CtrAgg): string {
  return a.opens > 0 ? ((a.clicks / a.opens) * 100).toFixed(2) : "0.00";
}

function parseCtr(): {
  byCategory: Map<string, CtrAgg>;
  byCatOrigin: Map<string, CtrAgg>;
  byOrigin: Map<string, CtrAgg>;
  totalLinks: number;
  totalEditions: number;
} | null {
  if (!existsSync(CTR_CSV)) return null;

  const lines = readFileSync(CTR_CSV, "utf8").split("\n").slice(1).filter(Boolean);
  if (lines.length === 0) return null;

  const byCategory = new Map<string, CtrAgg>();
  const byCatOrigin = new Map<string, CtrAgg>();
  const byOrigin = new Map<string, CtrAgg>();
  const dates = new Set<string>();

  for (const line of lines) {
    // CSV columns: date,post_title,section_title,anchor,base_url,domain,
    //              unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin
    // Text fields (post_title, anchor etc) may contain commas inside quotes,
    // so parse from the END where fields are safe (no commas in numbers/category/origin).
    const parts = line.split(",");
    const origin = parts[parts.length - 1];
    const category = parts[parts.length - 2];
    const uniqueOpens = +parts[parts.length - 6];
    const uniqueVerifiedClicks = +parts[parts.length - 4];
    const date = parts[0];

    dates.add(date);

    const add = (map: Map<string, CtrAgg>, key: string) => {
      const existing = map.get(key) ?? { count: 0, clicks: 0, opens: 0 };
      existing.count++;
      existing.clicks += uniqueVerifiedClicks;
      existing.opens += uniqueOpens;
      map.set(key, existing);
    };

    add(byCategory, category);
    add(byCatOrigin, `${category}|${origin}`);
    add(byOrigin, origin);
  }

  return { byCategory, byCatOrigin, byOrigin, totalLinks: lines.length, totalEditions: dates.size };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const today = new Date().toISOString().slice(0, 10);

  // Subscriber count
  let subscribers = 0;
  if (existsSync(PUB_JSON)) {
    try {
      const pub = JSON.parse(readFileSync(PUB_JSON, "utf8"));
      subscribers = pub.stats?.active_subscriptions ?? 0;
    } catch { /* ignore */ }
  }

  // CTR data (primary)
  const ctr = parseCtr();

  // Survey data (secondary)
  const surveyPath = process.argv[2] ?? (existsSync(SURVEY_JSON) ? SURVEY_JSON : null);
  let surveyResponses: BeehiivResponse[] = [];
  if (surveyPath && existsSync(surveyPath)) {
    try {
      const all: BeehiivResponse[] = JSON.parse(readFileSync(surveyPath, "utf8"));
      surveyResponses = all.filter((r) => !r.status || r.status === "active");
    } catch { /* ignore */ }
  }

  if (!ctr && surveyResponses.length === 0) {
    console.error("Nenhuma fonte disponível (CTR CSV ou survey JSON). Nada a gerar.");
    process.exit(1);
  }

  // Archive existing
  if (existsSync(OUT)) {
    mkdirSync(HISTORY_DIR, { recursive: true });
    copyFileSync(OUT, resolve(HISTORY_DIR, `${today}.md`));
  }

  const lines: string[] = [
    "# Perfil de Audiência — Diar.ia",
    "",
    `**updated_at:** ${today}`,
    ...(subscribers > 0 ? [`**subscribers ativos:** ${subscribers}`] : []),
    ...(surveyResponses.length > 0 ? [`**respondentes survey:** ${surveyResponses.length}`] : []),
    ...(ctr ? [`**links analisados:** ${ctr.totalLinks} (${ctr.totalEditions} edições, 7+ dias de idade)`] : []),
  ];

  // ─── Section 1: CTR (primary) ─────────────────────────────────────────────

  if (ctr) {
    // Compute overall average CTR
    const totalClicks = [...ctr.byCategory.values()].reduce((s, a) => s + a.clicks, 0);
    const totalOpens = [...ctr.byCategory.values()].reduce((s, a) => s + a.opens, 0);
    const avgCtr = totalOpens > 0 ? (totalClicks / totalOpens) * 100 : 0;

    lines.push(
      "",
      "## 1. Engajamento real (CTR por categoria)",
      "",
      `Fonte primária: comportamento de ${subscribers || "N"} subscribers em ${ctr.totalEditions} edições.`,
      `CTR médio geral: ${avgCtr.toFixed(2)}%`,
      "",
    );

    // By category, sorted by CTR desc
    const catEntries = [...ctr.byCategory.entries()].sort((a, b) => {
      const ctrA = a[1].opens > 0 ? a[1].clicks / a[1].opens : 0;
      const ctrB = b[1].opens > 0 ? b[1].clicks / b[1].opens : 0;
      return ctrB - ctrA;
    });

    for (const [cat, agg] of catEntries) {
      const pct = ctrPct(agg);
      const vs = +pct - avgCtr;
      const tag = vs > 0.15 ? " (acima da média)" : vs < -0.15 ? " (abaixo da média)" : "";
      lines.push(`- **${cat}** — CTR ${pct}% | ${agg.count} links${tag}`);
    }

    // By category + origin (top performers)
    lines.push(
      "",
      "### Destaques por categoria + origem",
      "",
      "Top 10 combinações com maior CTR (mínimo 5 links):",
      "",
    );

    const catOrEntries = [...ctr.byCatOrigin.entries()]
      .filter(([, a]) => a.count >= 5)
      .sort((a, b) => {
        const ctrA = a[1].opens > 0 ? a[1].clicks / a[1].opens : 0;
        const ctrB = b[1].opens > 0 ? b[1].clicks / b[1].opens : 0;
        return ctrB - ctrA;
      })
      .slice(0, 10);

    for (const [key, agg] of catOrEntries) {
      const [cat, origin] = key.split("|");
      lines.push(`- **${cat} ${origin}** — CTR ${ctrPct(agg)}% | ${agg.count} links`);
    }

    // By origin
    lines.push("", "### Engajamento por origem", "");

    for (const [origin, agg] of [...ctr.byOrigin.entries()].sort((a, b) => {
      const ctrA = a[1].opens > 0 ? a[1].clicks / a[1].opens : 0;
      const ctrB = b[1].opens > 0 ? b[1].clicks / b[1].opens : 0;
      return ctrB - ctrA;
    })) {
      const pctLinks = ((agg.count / ctr.totalLinks) * 100).toFixed(1);
      lines.push(`- **${origin}** — CTR ${ctrPct(agg)}% | ${agg.count} links (${pctLinks}% do total)`);
    }

    lines.push(
      "",
      "> **Como usar:** categorias com CTR acima da média devem receber bônus de score.",
      "> Conteúdo BR tem engajamento significativamente maior — priorizar quando disponível em qualidade equivalente.",
    );
  }

  // ─── Section 2: Survey (secondary) ────────────────────────────────────────

  if (surveyResponses.length > 0) {
    const contentTypes = countAnswers(surveyResponses, /se[çc][õo]es|tipos? de conte[úu]do/i);
    const sectors = countAnswers(surveyResponses, /setor de atua[çc][ãa]o da organiza/i);
    const areas = countAnswers(surveyResponses, /principal [áa]rea de atua[çc][ãa]o/i);
    const aiLevel = countAnswers(surveyResponses, /n[íi]vel de conhecimento em ia/i);

    lines.push(
      "",
      "## 2. Preferências declaradas (survey)",
      "",
      `Fonte secundária: ${surveyResponses.length} respondentes. Usar para calibrar tom e vocabulário, não para priorizar temas.`,
      "",
      "### Conteúdo preferido",
      "",
      ...contentTypes.map((e) => `- **${e.label}** — weight ${e.weight} (${e.count} respostas)`),
      "",
      "### Nível de conhecimento em IA",
      "",
      ...aiLevel.map((e) => `- **${e.label}** — weight ${e.weight} (${e.count} respostas)`),
      "",
      "> **Como usar:** maioria é uso casual/consciente. Evitar jargão técnico sem explicação.",
      "",
      "## 3. Quem são (demographics)",
      "",
      "### Setores",
      "",
      ...sectors.map((e) => `- **${e.label}** — weight ${e.weight} (${e.count} respostas)`),
      "",
      "### Áreas de atuação",
      "",
      ...areas.map((e) => `- **${e.label}** — weight ${e.weight} (${e.count} respostas)`),
    );
  }

  lines.push(
    "",
    "---",
    "",
    "_Regerado por `scripts/update-audience.ts` a partir de CTR (`data/link-ctr-table.csv`) e survey (`data/audience-raw.json`)._",
  );

  writeFileSync(OUT, lines.join("\n"), "utf8");

  const sources: string[] = [];
  if (ctr) sources.push(`CTR (${ctr.totalLinks} links)`);
  if (surveyResponses.length > 0) sources.push(`survey (${surveyResponses.length} respondentes)`);
  console.log(`Wrote audience profile [${sources.join(" + ")}] → ${OUT}`);
}

main();
