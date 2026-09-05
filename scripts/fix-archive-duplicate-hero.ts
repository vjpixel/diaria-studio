#!/usr/bin/env tsx
/**
 * Remove a imagem de hero duplicada das páginas do acervo (#7412).
 *
 * As páginas em `workers/site/public/p/{slug}/index.html` foram importadas do
 * Beehiiv (#6167). Nas edições cujo toggle "Show thumbnail on top in web"
 * estava ligado, a capa veio como hero full-width no topo — e o corpo logo
 * abaixo já abre o D1 com a MESMA imagem.
 *
 * O pipeline atual não produz isso (a página nova é montada a partir do nosso
 * `newsletter-final.html`), então este script é uma correção de acervo, de
 * uma vez só — não um passo recorrente.
 *
 * Dry-run por padrão. `--apply` grava.
 *
 *   npx tsx scripts/fix-archive-duplicate-hero.ts
 *   npx tsx scripts/fix-archive-duplicate-hero.ts --apply
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isMainModule } from "./lib/cli-args.ts";
import {
  stripDuplicateHeroImage,
  findHeroLayout,
  removeHero,
  srcOf,
} from "./lib/strip-duplicate-hero.ts";

const ARCHIVE_ROOT = "workers/site/public/p";

interface Outcome {
  slug: string;
  status: "fixed" | "skipped";
  detail: string;
}

/** Algum asset do Beehiiv aparece mais de uma vez na página? */
function hasRepeatedAsset(html: string): boolean {
  const seen = new Set<string>();
  for (const m of html.matchAll(/asset\/file\/([0-9a-f-]{36})/g)) {
    if (seen.has(m[1])) return true;
    seen.add(m[1]);
  }
  return false;
}

export function run(apply: boolean): { outcomes: Outcome[]; fixed: number } {
  if (!existsSync(ARCHIVE_ROOT)) {
    throw new Error(`diretorio do acervo nao encontrado: ${ARCHIVE_ROOT}`);
  }

  const outcomes: Outcome[] = [];
  let fixed = 0;

  for (const slug of readdirSync(ARCHIVE_ROOT).sort()) {
    const file = join(ARCHIVE_ROOT, slug, "index.html");
    if (!existsSync(file)) continue;

    const before = readFileSync(file, "utf8");
    const result = stripDuplicateHeroImage(before);

    if (!result.changed) {
      // Só alerta sobre página que TEM asset repetido e mesmo assim não foi
      // corrigida — esse é o caso que exige olho humano. Página sem duplicata
      // é o normal: as geradas pelo pipeline atual não têm o marcador
      // `content-blocks` do acervo importado, e não têm o problema.
      if (hasRepeatedAsset(before)) {
        outcomes.push({ slug, status: "skipped", detail: result.reason });
      }
      continue;
    }

    fixed++;
    outcomes.push({
      slug,
      status: "fixed",
      detail: result.removedWrapper
        ? `hero ${result.assetId.slice(0, 8)} + wrapper`
        : `hero ${result.assetId.slice(0, 8)} (wrapper NAO reconhecido — conferir)`,
    });

    if (apply) writeFileSync(file, result.html, "utf8");
  }

  return { outcomes, fixed };
}

/**
 * Passada por HASH — pega o que a comparação por asset id não pega.
 *
 * O mesmo arquivo reenviado ao Beehiiv ganha asset id novo, então o hero pode
 * ser pixel a pixel idêntico a uma imagem do corpo e mesmo assim ter outro id.
 * O nome do arquivo também não decide: medido no acervo em 05/09/2026, há
 * imagens DISTINTAS com nome igual e cópias IDÊNTICAS com nome diferente. O
 * único critério confiável é baixar e comparar o conteúdo.
 *
 * Compara o hero contra TODAS as imagens do corpo (não só a primeira — houve
 * caso em que a cópia estava numa imagem posterior).
 */
export async function runByHash(apply: boolean): Promise<{ outcomes: Outcome[]; fixed: number }> {
  const outcomes: Outcome[] = [];
  let fixed = 0;
  const hashes = new Map<string, string>();

  async function hashOf(url: string): Promise<string | null> {
    const cached = hashes.get(url);
    if (cached !== undefined) return cached === "" ? null : cached;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) {
        hashes.set(url, "");
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const h = createHash("sha256").update(buf).digest("hex");
      hashes.set(url, h);
      return h;
    } catch {
      hashes.set(url, "");
      return null;
    }
  }

  for (const slug of readdirSync(ARCHIVE_ROOT).sort()) {
    const file = join(ARCHIVE_ROOT, slug, "index.html");
    if (!existsSync(file)) continue;

    const html = readFileSync(file, "utf8");
    const hero = findHeroLayout(html);
    if (!hero || hero.bodySrcs.length === 0) continue;

    const heroSrc = srcOf(hero.heroTag);
    if (!heroSrc) continue;

    const heroHash = await hashOf(heroSrc);
    if (heroHash === null) {
      outcomes.push({ slug, status: "skipped", detail: "falha ao baixar o hero — nao decidido" });
      continue;
    }

    let dup = false;
    for (const src of hero.bodySrcs) {
      if ((await hashOf(src)) === heroHash) {
        dup = true;
        break;
      }
    }
    if (!dup) continue;

    fixed++;
    const out = removeHero(html, hero);
    outcomes.push({
      slug,
      status: "fixed",
      detail: out.removedWrapper
        ? `hero identico a imagem do corpo (hash ${heroHash.slice(0, 8)})`
        : `hero identico (hash ${heroHash.slice(0, 8)}) — wrapper NAO reconhecido, conferir`,
    });
    if (apply) writeFileSync(file, out.html, "utf8");
  }

  return { outcomes, fixed };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  if (process.argv.includes("--by-hash")) {
    const { outcomes, fixed } = await runByHash(apply);
    const skipped = outcomes.filter((o) => o.status === "skipped");
    console.log(`#7412 — hero duplicado POR HASH  [${apply ? "APPLY" : "DRY-RUN"}]`);
    console.log(`  paginas corrigidas : ${fixed}`);
    for (const o of outcomes.filter((x) => x.status === "fixed")) {
      console.log(`      ${o.slug}`);
    }
    if (skipped.length) {
      console.log(`  nao decididas      : ${skipped.length}`);
      for (const o of skipped) console.log(`      ${o.slug}: ${o.detail}`);
    }
    if (!apply && fixed > 0) console.log(`\n  nada foi gravado. rode com --apply para aplicar.`);
    return;
  }

  const { outcomes, fixed } = run(apply);

  const attention = outcomes.filter((o) => o.status === "skipped");
  const noWrapper = outcomes.filter((o) => o.detail.includes("NAO reconhecido"));

  console.log(`#7412 — hero duplicado no acervo  [${apply ? "APPLY" : "DRY-RUN"}]`);
  console.log(`  paginas corrigidas : ${fixed}`);
  if (noWrapper.length) {
    console.log(`  wrapper atipico    : ${noWrapper.length} (so a <img> saiu)`);
    for (const o of noWrapper) console.log(`      ${o.slug}`);
  }
  if (attention.length) {
    console.log(`  puladas com aviso  : ${attention.length}`);
    for (const o of attention) console.log(`      ${o.slug}: ${o.detail}`);
  }
  if (!apply && fixed > 0) {
    console.log(`\n  nada foi gravado. rode com --apply para aplicar.`);
  }
}

if (isMainModule(import.meta.url)) main();
