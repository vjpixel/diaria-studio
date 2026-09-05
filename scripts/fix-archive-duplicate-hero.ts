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

/** Há `<img>` com asset antes do marcador do corpo? (usado só para relatar) */
function hasHeroCandidate(html: string): boolean {
  const at = html.indexOf("id='content-blocks'");
  if (at < 0) return false;
  return /<img\b[^>]*asset\/file\//.test(html.slice(0, at));
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
export interface RunByHashOptions {
  /** Injetável para teste; default é `fetch` com timeout. */
  fetchImpl?: (url: string) => Promise<{ ok: boolean; bytes: Buffer } | null>;
  /** Raiz do acervo; default `workers/site/public/p`. */
  root?: string;
  /** Timeout por download, em ms. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function runByHash(
  apply: boolean,
  opts: RunByHashOptions = {},
): Promise<{ outcomes: Outcome[]; fixed: number }> {
  const root = opts.root ?? ARCHIVE_ROOT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outcomes: Outcome[] = [];
  let fixed = 0;
  const hashes = new Map<string, string | null>();

  const doFetch =
    opts.fetchImpl ??
    (async (url: string) => {
      // Sem timeout, uma requisição pendurada trava o script inteiro — os
      // downloads são sequenciais e não há nada que a interrompa.
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { ok: res.ok, bytes: Buffer.from(await res.arrayBuffer()) };
    });

  /** `null` = não foi possível determinar (rede/HTTP), nunca "conteúdo vazio". */
  async function hashOf(url: string): Promise<string | null> {
    if (hashes.has(url)) return hashes.get(url)!;
    let h: string | null = null;
    try {
      const r = await doFetch(url);
      if (r && r.ok) h = createHash("sha256").update(r.bytes).digest("hex");
    } catch {
      h = null;
    }
    hashes.set(url, h);
    return h;
  }

  for (const slug of readdirSync(root).sort()) {
    const file = join(root, slug, "index.html");
    if (!existsSync(file)) continue;

    const html = readFileSync(file, "utf8");
    const hero = findHeroLayout(html);
    if (!hero) {
      // Só vale relatar quando HÁ imagem no topo mas a estrutura não bate —
      // aí é caso de olho humano, como no modo por asset id. Página sem hero
      // nenhum é o caso normal e não vira ruído.
      if (hasHeroCandidate(html)) {
        outcomes.push({ slug, status: "skipped", detail: "estrutura do topo inesperada — conferir" });
      }
      continue;
    }
    if (hero.bodySrcs.length === 0) {
      outcomes.push({ slug, status: "skipped", detail: "hero e a unica imagem — nao remover" });
      continue;
    }

    const heroSrc = srcOf(hero.heroTag);
    if (!heroSrc) continue;

    const heroHash = await hashOf(heroSrc);
    if (heroHash === null) {
      outcomes.push({ slug, status: "skipped", detail: "falha ao baixar o hero — nao decidido" });
      continue;
    }

    let dup = false;
    let algumaFalhou = false;
    for (const src of hero.bodySrcs) {
      const h = await hashOf(src);
      if (h === null) {
        algumaFalhou = true;
        continue;
      }
      if (h === heroHash) {
        dup = true;
        break;
      }
    }
    if (!dup) {
      // Sem match E com download falho: "não é duplicata" e "não deu pra
      // saber" seriam indistinguíveis no relatório. Sinalizar em vez de calar.
      if (algumaFalhou) {
        outcomes.push({
          slug,
          status: "skipped",
          detail: "imagem do corpo nao pôde ser baixada — nao decidido",
        });
      }
      continue;
    }

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
