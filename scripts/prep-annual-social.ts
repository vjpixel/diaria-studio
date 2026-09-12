#!/usr/bin/env npx tsx
/**
 * prep-annual-social.ts — Etapa 6 da `/diaria-anual` (posts em mídias sociais).
 *
 * Lê `data/annual/{slug}/social/03-social.md` (um post por tema + previsões)
 * e planeja um post por dia, em dias seguidos, sempre no mesmo horário
 * (`planAnnualSocialDays`). Os posts são agrupados em lotes de 2–3 — o que os
 * publicadores da diária aceitam — e cada lote vira um diretório
 * `social/{AAMMDD}/` com a forma de uma edição diária: `02-reviewed.md`
 * mínimo, `03-social.md` com `## d1..d3`, as imagens `04-d{N}-2x1.jpg`,
 * `_internal/01-approved-capped.json` (contagem de destaques e `outros_count`
 * que os publicadores exigem), `_internal/05-edition-url.txt` (URL da
 * retrospectiva, a que os textos curtos citam) e `_internal/social-slots.json`
 * (data e hora de cada post — os publicadores o leem via
 * `DIARIA_SOCIAL_SLOTS_FILE`, ver `compute-social-schedule.ts`).
 *
 * Não publica nada. Imprime o plano em JSON e grava `social/plan.json`.
 *
 * Uso:
 *   npx tsx scripts/prep-annual-social.ts --slug 2026-aniversario [--start 260913] [--time 09:00]
 *
 * `--start` (AAMMDD): dia do 1º post; default = amanhã no horário de
 * Brasília. `--time` (HH:MM, Brasília): horário de todos os posts; default 09:00.
 *
 * Imagem das previsões: a anual não gera imagem para elas na Etapa 3, então
 * este script exige `social/previsoes-2x1.jpg` (Etapa 6b da SKILL) — sem
 * ela, falha em vez de publicar o post das previsões sem imagem.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import { parseAnnualDraft } from "./lib/anual/annual-parse.ts";
import { tipoFromSlug } from "./lib/anual/annual-window.ts";
import { anualPathFromSlug } from "./lib/shared/retrospectiva-path.ts";
import { DIARIA_RETROSPECTIVA_URL } from "./lib/canonical-urls.ts";
import {
  buildDayApprovedStub,
  buildDayReviewedMd,
  buildDaySocialMd,
  orderAnnualSocialKeys,
  parseAAMMDD,
  parseAnnualSocialMd,
  planAnnualSocialDays,
  socialCardCategory,
  themeImageFile,
} from "./lib/anual/annual-social-plan.ts";

const PREVISOES_TITLE = "Previsões para o próximo ano";

export function prepAnnualSocial(
  dir: string,
  start: Date,
  time = "09:00",
): { days: { date: string; keys: string[]; slots: Record<string, string>; dir: string }[] } {
  const slug = basename(dir);
  const socialDir = join(dir, "social");
  const texts = parseAnnualSocialMd(readFileSync(join(socialDir, "03-social.md"), "utf8"));
  const draft = parseAnnualDraft(readFileSync(join(dir, "draft.md"), "utf8"));
  const publicImages: Record<string, string> = JSON.parse(
    readFileSync(join(dir, "_internal", "public-images.json"), "utf8"),
  );

  const keys = orderAnnualSocialKeys(Object.keys(texts.social));
  const presentes = new Set<string>(keys);
  const faltando = draft.themes.map((t) => `t${t.index}`).filter((k) => !presentes.has(k));
  if (faltando.length) throw new Error(`03-social.md sem post para: ${faltando.join(", ")}`);

  const category = socialCardCategory(tipoFromSlug(slug), slug.slice(0, 4));
  const pagePath = anualPathFromSlug(slug);
  const pageUrl = pagePath ? `${DIARIA_RETROSPECTIVA_URL}/${pagePath}` : null;

  const titleOf = (k: string) =>
    k === "previsoes" ? PREVISOES_TITLE : (draft.themes.find((t) => `t${t.index}` === k)?.title ?? k);
  const imageOf = (k: string) => {
    if (k === "previsoes") return join(socialDir, "previsoes-2x1.jpg");
    const file = themeImageFile(publicImages, Number(k.slice(1)));
    if (!file) throw new Error(`sem imagem pública do tema ${k} em _internal/public-images.json`);
    return join(dir, file);
  };

  const days = planAnnualSocialDays(keys, start, time);
  const out = days.map((day) => {
    const dayDir = join(socialDir, day.date);
    const titles = day.keys.map(titleOf);
    mkdirSync(join(dayDir, "_internal"), { recursive: true });
    writeFileSync(join(dayDir, "02-reviewed.md"), buildDayReviewedMd(titles, category));
    writeFileSync(join(dayDir, "03-social.md"), buildDaySocialMd(day, texts));
    writeFileSync(join(dayDir, "_internal", "01-approved-capped.json"), buildDayApprovedStub(titles));
    if (pageUrl) writeFileSync(join(dayDir, "_internal", "05-edition-url.txt"), `${pageUrl}\n`);
    writeFileSync(
      join(dayDir, "_internal", "social-slots.json"),
      JSON.stringify({ edition: day.date, slots: day.slots }, null, 2),
    );
    day.keys.forEach((k, i) => {
      const src = imageOf(k);
      if (!existsSync(src)) throw new Error(`imagem ausente para ${k}: ${src}`);
      copyFileSync(src, join(dayDir, `04-d${i + 1}-2x1.jpg`));
    });
    return { date: day.date, keys: day.keys, slots: day.slots, dir: dayDir };
  });
  writeFileSync(join(socialDir, "plan.json"), JSON.stringify({ days: out }, null, 2));
  return { days: out };
}

/** Amanhã no calendário de Brasília (o Git Bash e o CI rodam em UTC). */
function tomorrowBrt(): Date {
  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  const [y, m, d] = hoje.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1));
}

if (isMainModule(import.meta.url)) {
  const args = parseArgsSimple(process.argv.slice(2));
  const slug = args.slug as string | undefined;
  if (!slug) {
    console.error("uso: --slug 2026-aniversario [--start AAMMDD] [--time HH:MM]");
    process.exit(1);
  }
  try {
    const start = args.start ? parseAAMMDD(String(args.start)) : tomorrowBrt();
    const time = args.time ? String(args.time) : "09:00";
    console.log(JSON.stringify(prepAnnualSocial(resolve("data/annual", slug), start, time), null, 2));
  } catch (e) {
    console.error(`prep-annual-social: ${(e as Error).message}`);
    process.exit(1);
  }
}
