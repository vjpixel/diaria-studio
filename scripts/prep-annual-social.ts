#!/usr/bin/env npx tsx
/**
 * prep-annual-social.ts — Etapa 6 da `/diaria-anual` (posts em mídias sociais).
 *
 * Lê `data/annual/{slug}/social/03-social.md` (um post por tema + previsões),
 * reparte os posts em dias de fim de semana com 2–3 posts cada
 * (`planAnnualSocialDays`) e monta, para cada dia, um diretório
 * `social/{AAMMDD}/` com a forma de uma edição diária — `02-reviewed.md`
 * mínimo, `03-social.md` com `## d1..d3` e as imagens `04-d{N}-2x1.jpg` —
 * para que os publicadores da diária rodem sobre ele sem modificação.
 *
 * Não publica nada. Imprime o plano em JSON e grava `social/plan.json`.
 *
 * Uso:
 *   npx tsx scripts/prep-annual-social.ts --slug 2026-aniversario [--start 260913]
 *
 * `--start` (AAMMDD): primeiro dia possível; default = amanhã. Os dias
 * efetivos são os sábados e domingos a partir dele.
 *
 * Imagem das previsões: a anual não gera imagem para elas na Etapa 3, então
 * este script exige `social/previsoes-2x1.jpg` (gerar antes com
 * `image-generate.ts`, ver SKILL.md) — sem ela, falha em vez de publicar o
 * post das previsões sem imagem.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import { parseAnnualDraft } from "./lib/anual/annual-parse.ts";
import {
  buildDayReviewedMd,
  buildDaySocialMd,
  orderAnnualSocialKeys,
  parseAAMMDD,
  parseAnnualSocialMd,
  planAnnualSocialDays,
  themeImageFile,
} from "./lib/anual/annual-social-plan.ts";

const PREVISOES_TITLE = "Previsões para o próximo ano";

export function prepAnnualSocial(dir: string, start: Date): { days: { date: string; keys: string[]; dir: string }[] } {
  const socialDir = join(dir, "social");
  const texts = parseAnnualSocialMd(readFileSync(join(socialDir, "03-social.md"), "utf8"));
  const draft = parseAnnualDraft(readFileSync(join(dir, "draft.md"), "utf8"));
  const publicImages: Record<string, string> = JSON.parse(
    readFileSync(join(dir, "_internal", "public-images.json"), "utf8"),
  );

  const keys = orderAnnualSocialKeys(Object.keys(texts.social));
  const faltando = draft.themes.map((t) => `t${t.index}`).filter((k) => !keys.includes(k as never));
  if (faltando.length) throw new Error(`03-social.md sem post para: ${faltando.join(", ")}`);

  const titleOf = (k: string) =>
    k === "previsoes" ? PREVISOES_TITLE : (draft.themes.find((t) => `t${t.index}` === k)?.title ?? k);
  const imageOf = (k: string) => {
    if (k === "previsoes") return join(socialDir, "previsoes-2x1.jpg");
    const file = themeImageFile(publicImages, Number(k.slice(1)));
    if (!file) throw new Error(`sem imagem pública do tema ${k} em _internal/public-images.json`);
    return join(dir, file);
  };

  const days = planAnnualSocialDays(keys, start);
  const out = days.map((day) => {
    const dayDir = join(socialDir, day.date);
    mkdirSync(join(dayDir, "_internal"), { recursive: true });
    writeFileSync(join(dayDir, "02-reviewed.md"), buildDayReviewedMd(day.keys.map(titleOf)));
    writeFileSync(join(dayDir, "03-social.md"), buildDaySocialMd(day, texts));
    day.keys.forEach((k, i) => {
      const src = imageOf(k);
      if (!existsSync(src)) throw new Error(`imagem ausente para ${k}: ${src}`);
      copyFileSync(src, join(dayDir, `04-d${i + 1}-2x1.jpg`));
    });
    return { date: day.date, keys: day.keys, dir: dayDir };
  });
  writeFileSync(join(socialDir, "plan.json"), JSON.stringify({ days: out }, null, 2));
  return { days: out };
}

if (isMainModule(import.meta.url)) {
  const args = parseArgsSimple(process.argv.slice(2));
  const slug = args.slug as string | undefined;
  if (!slug) {
    console.error("uso: --slug 2026-aniversario [--start AAMMDD]");
    process.exit(1);
  }
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const start = args.start ? parseAAMMDD(String(args.start)) : new Date(Date.UTC(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth(), tomorrow.getUTCDate()));
  try {
    console.log(JSON.stringify(prepAnnualSocial(resolve("data/annual", slug), start), null, 2));
  } catch (e) {
    console.error(`prep-annual-social: ${(e as Error).message}`);
    process.exit(1);
  }
}
