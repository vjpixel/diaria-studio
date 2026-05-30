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
import Papa from "papaparse";

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

/**
 * Strip Aprofunde rows (#1564): destaques pré-mar/2026 usavam anchor "Aprofunde"
 * (link secundário com CTR estruturalmente mais alto ~1.5×). Pós-mar/2026 todos
 * usam título como anchor. Misturar os 2 regimes infla CTR de categorias com
 * muitos rows antigos.
 *
 * Pure: retorna true se anchor começa com "Aprofunde" (case-insensitive).
 */
export function isAprofundeAnchor(anchor: string): boolean {
  return /^aprofunde\b/i.test((anchor || "").trim());
}

/**
 * Pure: exponential decay weight com time constant de DECAY_TIME_CONSTANT_DAYS.
 * `weight = exp(-days / T)` onde T=90 → weight cai pra 1/e (~0.37) em 90d;
 * half-life equivalente é ~62d (T × ln(2)). Rows mais recentes pesam mais.
 *
 * Combina audience drift (audiência cresceu 4× ao longo de 2025-2026) +
 * format drift (Aprofunde→Título em mar/2026).
 *
 * Validação empírica em #1564: T entre 45-180 dá rankings quase idênticos
 * → escolha 90 como sweet spot estável.
 */
export const DECAY_TIME_CONSTANT_DAYS = 90;
/** Alias deprecated — mantido para compat. Renomear pra DECAY_TIME_CONSTANT_DAYS. */
export const DECAY_HALF_LIFE_DAYS = DECAY_TIME_CONSTANT_DAYS;

export function decayWeight(rowDate: string, today: Date = new Date()): number {
  const d = new Date(rowDate);
  if (isNaN(d.getTime())) return 1; // fallback: peso 1 se data inválida
  const days = Math.max(0, (today.getTime() - d.getTime()) / 86400000);
  return Math.exp(-days / DECAY_TIME_CONSTANT_DAYS);
}

export interface CtrParseResult {
  byCategory: Map<string, CtrAgg>;
  byCatOrigin: Map<string, CtrAgg>;
  byOrigin: Map<string, CtrAgg>;
  byDomain: Map<string, CtrAgg>;
  totalLinks: number;
  totalEditions: number;
  filteredAprofunde: number;
}

/**
 * Pure: agrega o CTR table (string CSV) por categoria/origem/domínio, aplicando
 * o filtro Aprofunde (#1564) e o exponential decay.
 *
 * Usa papaparse (header) e lê campos por NOME — NÃO faz split posicional. Isso
 * corrige o bug do #1567 audit (finding A): o anchor era lido em `parts[3]`
 * (front-anchored) num `split(",")` ingênuo, mas vírgulas em post_title/
 * section_title deslocam esse índice. Resultado: ~14% das rows Aprofunde (35 de
 * 255 no CTR table real) vazavam pro profile do scorer, reinflando o CTR de
 * categorias com o regime antigo que o filtro existe pra excluir. Ler `rec.anchor`
 * por nome elimina a fragilidade posicional (mesma técnica do build-link-ctr e
 * analyze-scorer-impact).
 */
export function parseCtrFromCsv(csv: string, today: Date = new Date()): CtrParseResult | null {
  const { data } = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
  });
  if (data.length === 0) return null;

  const byCategory = new Map<string, CtrAgg>();
  const byCatOrigin = new Map<string, CtrAgg>();
  const byOrigin = new Map<string, CtrAgg>();
  const byDomain = new Map<string, CtrAgg>();
  const dates = new Set<string>();
  let filteredAprofunde = 0;

  const num = (s: string | undefined): number => {
    const v = parseFloat(s ?? "");
    return Number.isFinite(v) ? v : 0;
  };

  for (const rec of data) {
    const anchor = (rec.anchor ?? "").trim();

    // #1564: skip Aprofunde rows (regime antigo de destaque)
    if (isAprofundeAnchor(anchor)) {
      filteredAprofunde++;
      continue;
    }

    const date = (rec.date ?? "").trim();
    const origin = (rec.origin ?? "").trim();
    const category = (rec.category ?? "").trim();
    const domain = (rec.domain ?? "").trim();
    const uniqueOpens = num(rec.unique_opens);
    const uniqueVerifiedClicks = num(rec.unique_verified_clicks);

    if (date) dates.add(date);

    // #1564: exponential decay (90d time constant) — rows mais recentes pesam mais
    const w = decayWeight(date, today);

    const add = (map: Map<string, CtrAgg>, key: string) => {
      const existing = map.get(key) ?? { count: 0, clicks: 0, opens: 0 };
      existing.count++;
      existing.clicks += uniqueVerifiedClicks * w;
      existing.opens += uniqueOpens * w;
      map.set(key, existing);
    };

    add(byCategory, category);
    add(byCatOrigin, `${category}|${origin}`);
    add(byOrigin, origin);
    if (domain && domain.includes(".")) add(byDomain, domain);
  }

  return {
    byCategory,
    byCatOrigin,
    byOrigin,
    byDomain,
    totalLinks: data.length - filteredAprofunde,
    totalEditions: dates.size,
    filteredAprofunde,
  };
}

function parseCtr(): CtrParseResult | null {
  if (!existsSync(CTR_CSV)) return null;
  return parseCtrFromCsv(readFileSync(CTR_CSV, "utf8"));
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
    ...(ctr
      ? [
          `**links analisados:** ${ctr.totalLinks} (${ctr.totalEditions} edições, 7+ dias de idade)`,
          `**filtros aplicados (#1564):** ${ctr.filteredAprofunde} rows com anchor "Aprofunde" excluídas (regime pré-mar/2026), exponential decay com time constant ${DECAY_TIME_CONSTANT_DAYS}d aplicado (half-life ~${Math.round(DECAY_TIME_CONSTANT_DAYS * Math.log(2))}d)`,
        ]
      : []),
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

    // #1564: derivar annotation BR vs INT da data atual em vez de hardcoded.
    // Pre-mudança assumia BR > INT (era verdade no regime antigo); pós-mudança
    // o ranking pode ter virado. Annotation derivada evita stale claim.
    const brCtr = (() => {
      const a = ctr.byOrigin.get("BR");
      return a && a.opens > 0 ? (a.clicks / a.opens) * 100 : 0;
    })();
    const intCtr = (() => {
      const a = ctr.byOrigin.get("INT");
      return a && a.opens > 0 ? (a.clicks / a.opens) * 100 : 0;
    })();
    const originHint = (() => {
      if (brCtr === 0 || intCtr === 0) return "Sem dados suficientes pra comparar BR vs INT.";
      const ratio = brCtr / intCtr;
      if (ratio >= 1.15) return `Conteúdo BR tem CTR ${Math.round((ratio - 1) * 100)}% maior — priorizar quando disponível em qualidade equivalente.`;
      if (ratio <= 0.85) return `Conteúdo INT tem CTR ${Math.round((1 / ratio - 1) * 100)}% maior — não há prêmio automático por origem BR; avaliar caso a caso.`;
      return "BR e INT têm CTR comparável — origem não é fator decisivo, focar em relevância editorial.";
    })();
    lines.push(
      "",
      "> **Como usar:** categorias com CTR acima da média devem receber bônus de score.",
      `> ${originHint}`,
    );

    // By domain (source quality)
    const MIN_LINKS_DOMAIN = 3;
    const domainEntries = [...ctr.byDomain.entries()]
      .filter(([, a]) => a.count >= MIN_LINKS_DOMAIN)
      .map(([dom, a]) => ({ dom, ...a, ctr: a.opens > 0 ? (a.clicks / a.opens) * 100 : 0 }))
      .sort((a, b) => b.ctr - a.ctr);

    if (domainEntries.length > 0) {
      lines.push(
        "",
        "### CTR por fonte (mínimo 3 links)",
        "",
        "Top 15 fontes com maior engajamento:",
        "",
      );

      for (const e of domainEntries.slice(0, 15)) {
        lines.push(`- **${e.dom}** — CTR ${e.ctr.toFixed(2)}% | ${e.count} links`);
      }

      const bottom = domainEntries.filter(e => e.ctr === 0 && e.count >= MIN_LINKS_DOMAIN);
      if (bottom.length > 0) {
        lines.push(
          "",
          `Fontes com CTR 0.00% (${bottom.length} fontes, ${MIN_LINKS_DOMAIN}+ links):`,
          "",
        );
        for (const e of bottom) {
          lines.push(`- ${e.dom} (${e.count} links)`);
        }
      }

      lines.push(
        "",
        "> **Como usar:** fontes com CTR alto indicam conteúdo que a audiência valoriza.",
        "> Fontes com CTR 0.00% podem ter paywall ou conteúdo genérico — considerar na curadoria.",
      );
    }
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

// Run main() apenas quando invocado como CLI direto.
// Sem este guard, qualquer test que importe deste arquivo dispara main() →
// `process.exit(1)` quando CTR CSV ausente (CI não tem `data/`).
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
