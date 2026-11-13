#!/usr/bin/env tsx
/**
 * add-pool-item.ts (#12945)
 *
 * Inclui um item NOVO numa seção do pool (LANÇAMENTOS, RADAR, USE MELHOR,
 * VÍDEOS) no gate do Stage 4 — o terceiro do trio com `move-pool-item.ts`
 * (#9680, mudar de seção) e `remove-pool-item.ts` (#10598, cortar).
 *
 * Por que existe: na edição 261113 o editor pediu "Introducing Claude
 * Meetings" (URL oficial, vinda do refresh tardio `04-late-refresh.json`) em
 * LANÇAMENTOS. Nada inseria item novo: o `url-bucket` (gate-blocking)
 * reprovou com `found_in_bucket: "missing"` e foi preciso patchar
 * `01-approved.json` e `01-approved-capped.json` à mão.
 *
 * O que ESTE script faz (mecânico, num lote verificado — #9188):
 *   1. `02-reviewed.md`: anexa o bloco `**[Título](url)**` + descrição (linhas
 *      adjacentes, formato do template) ao fim da seção de destino; header
 *      singular/plural ajustado (LANÇAMENTO → LANÇAMENTOS);
 *   2. USE MELHOR exige tempo de leitura: sem "(N min)" na descrição, exige
 *      `--tempo N` e anexa " (N min)" (lint use-melhor-tempo, #2372);
 *   3. intro "selecionei os N": recalculada pela contagem real;
 *   4. `_internal/01-approved.json` e `01-approved-capped.json`: item FLAT no
 *      bucket de destino, com `flag: "editor_added_at_gate"` (mesma forma do
 *      patch à mão de 261113). Se a URL já estava noutro bucket do approved (item
 *      cortado do MD antes), é movida pro destino em vez de duplicada.
 *
 * Título e descrição: `--title`/`--summary`; o que faltar vem do candidato
 * com a mesma URL em `_internal/04-late-refresh.json` (#9370). Sem nenhum dos
 * dois, recusa — o script não inventa texto. Descrição em inglês sai como
 * está: o lint `no-untranslated-summary` acusa no gate (traduzir à mão).
 *
 * O que NÃO faz (sai em `next_steps`):
 *   - criar uma seção que não existe em `02-reviewed.md` (posição é editorial,
 *     recusa com exit 2 — mesmo contrato do move);
 *   - validar link oficial em LANÇAMENTOS (`validate-lancamentos.ts`);
 *   - re-render do HTML e a auditoria do intake (`audit-newsletter-intake.ts`,
 *     invariante "Intake desatualizado").
 *
 * Recusa (exit 2, nada gravado): URL já presente no `02-reviewed.md`
 * (destaque ou pool — use move-pool-item.ts), URL que é destaque no approved,
 * `--to` inválido.
 *
 * Uso:
 *   npx tsx scripts/add-pool-item.ts --edition-dir data/editions/2611/261113 \
 *     --url https://claude.com/resources/articles/claude-meetings --to lancamento \
 *     [--title "..."] [--summary "..."] [--tempo N] [--dry-run]
 *
 * Exit: 0 ok; 2 uso errado ou inclusão recusada (nada gravado).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsWithTrueDefault, isMainModule } from "./lib/cli-args.ts";
import { writeFilesVerified, type VerifiedWrite } from "./lib/write-files-verified.ts";
import { SECTIONS, type SectionBucket } from "./lib/section-naming.ts";
import { USE_MELHOR_TEMPO_RE } from "./lib/lint-checks/use-melhor-tempo.ts";
import { lintNewsletter, type ApprovedJson } from "./lib/lint-checks/url-bucket.ts";
import { editionFromDir } from "./lib/diaria/d1-video-hero.ts";
import {
  POOL_BUCKETS,
  findSections,
  fixSectionHeaderPlurals,
  moveInApprovedJson,
  normalizeUrl,
  reconcileIntroCount,
  sameUrl,
} from "./move-pool-item.ts";

/** `category` gravado no item novo, pela convenção dos buckets do approved (261113). */
const BUCKET_CATEGORY: Record<SectionBucket, string> = {
  lancamento: "lancamento",
  radar: "noticias",
  use_melhor: "tutorial",
  video: "video",
};

export interface NewPoolItem {
  url: string;
  title: string;
  summary: string;
  source?: string;
  published_at?: string | null;
}

/** Pure: candidato do refresh tardio com a mesma URL (`candidates[]`), ou null. */
export function findLateRefreshCandidate(report: unknown, url: string): Partial<NewPoolItem> | null {
  const list = (report as { candidates?: unknown })?.candidates;
  if (!Array.isArray(list)) return null;
  const hit = list.find((c) => sameUrl((c as { url?: unknown })?.url, url)) as Record<string, unknown> | undefined;
  if (!hit) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
  return {
    url: str(hit.url),
    title: str(hit.title),
    summary: str(hit.summary),
    source: str(hit.source),
    published_at: str(hit.published_at) ?? null,
  };
}

/** Pure: item FLAT gravado em `01-approved*.json`. */
export function buildApprovedItem(item: NewPoolItem, to: SectionBucket): Record<string, unknown> {
  const date = item.published_at ? item.published_at.slice(0, 10) : undefined;
  return {
    url: item.url,
    title: item.title,
    summary: item.summary,
    ...(item.source ? { source: item.source } : {}),
    ...(item.published_at ? { published_at: item.published_at } : {}),
    ...(date ? { date } : {}),
    category: BUCKET_CATEGORY[to],
    flag: "editor_added_at_gate",
  };
}

export interface MdAddResult {
  md: string;
  tempo_added: string | null;
  intro_count: { before: number; after: number } | null;
}

/**
 * Pure: anexa o item ao fim da seção `to`. Lança (sem efeito) se a URL já está
 * no MD, a seção não existe, ou vai pro USE MELHOR sem tempo e sem `tempo`.
 */
export function addItemToReviewedMd(
  md: string,
  item: NewPoolItem,
  to: SectionBucket,
  opts: { tempo?: number } = {},
): MdAddResult {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  const target = normalizeUrl(item.url);
  const urlsInMd = [...md.matchAll(/\]\((https?:\/\/[^\s)]*(?:\([^\s)]*\)[^\s)]*)*)\)/g)].map((m) => normalizeUrl(m[1]));
  if (urlsInMd.includes(target)) {
    throw new Error(
      `a URL já está em 02-reviewed.md — para mudar de seção use move-pool-item.ts: ${item.url}`,
    );
  }

  const sec = findSections(lines).find((s) => s.bucket === to);
  if (!sec) {
    const label = SECTIONS.find((s) => s.bucket === to && !s.legacy)?.label ?? to;
    throw new Error(
      `a seção ${label} não existe em 02-reviewed.md — o script não cria seções (posição é editorial). ` +
        `Crie o header **${label}** no lugar certo e re-rode.`,
    );
  }

  const title = item.title.replace(/\s+/g, " ").trim().replace(/[[\]]/g, "");
  let summary = item.summary.replace(/\s+/g, " ").trim();
  let tempoAdded: string | null = null;
  if (to === "use_melhor" && !USE_MELHOR_TEMPO_RE.test(summary)) {
    if (opts.tempo === undefined) {
      throw new Error(
        `o item vai pro USE MELHOR sem tempo de leitura na descrição — passe --tempo N (minutos) (lint use-melhor-tempo, #2372).`,
      );
    }
    tempoAdded = `(${opts.tempo} min)`;
    summary = `${summary} ${tempoAdded}`;
  }

  let lastNonBlank = sec.end - 1;
  while (lastNonBlank > sec.header && lines[lastNonBlank].trim() === "") lastNonBlank--;
  lines.splice(lastNonBlank + 1, 0, "", `**[${title}](${item.url})**`, summary);

  fixSectionHeaderPlurals(lines, [to]);
  const { md: out, intro_count } = reconcileIntroCount(lines.join("\n"));
  return { md: eol === "\r\n" ? out.replace(/\n/g, "\r\n") : out, tempo_added: tempoAdded, intro_count };
}

export interface AddPoolItemResult {
  url: string;
  to: SectionBucket;
  title: string;
  dry_run: boolean;
  from_late_refresh: boolean;
  rewritten: string[];
  tempo_added: string | null;
  intro_count: { before: number; after: number } | null;
  warnings: string[];
  next_steps: string[];
}

export function addPoolItem(
  editionDir: string,
  input: { url: string; title?: string; summary?: string },
  to: SectionBucket,
  opts: { tempo?: number; dryRun?: boolean } = {},
): AddPoolItemResult {
  if (!POOL_BUCKETS.includes(to)) {
    throw new Error(`--to precisa ser um de ${POOL_BUCKETS.join("|")} (recebido: ${to})`);
  }
  const dryRun = opts.dryRun === true;
  const internalDir = resolve(editionDir, "_internal");
  const mdPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(mdPath)) throw new Error(`02-reviewed.md não encontrado em ${editionDir}`);

  const latePath = resolve(internalDir, "04-late-refresh.json");
  let late: Partial<NewPoolItem> | null = null;
  if (existsSync(latePath)) {
    try {
      late = findLateRefreshCandidate(JSON.parse(readFileSync(latePath, "utf8")), input.url);
    } catch {
      late = null; // relatório ilegível: segue só com --title/--summary
    }
  }
  const title = input.title?.trim() || late?.title;
  const summary = input.summary?.trim() || late?.summary;
  if (!title || !summary) {
    throw new Error(
      `faltam ${[!title && "--title", !summary && "--summary"].filter(Boolean).join(" e ")} — ` +
        `a URL não está em _internal/04-late-refresh.json com esse campo; passe o texto explicitamente.`,
    );
  }
  const item: NewPoolItem = {
    url: input.url.trim(),
    title,
    summary,
    source: late?.source,
    published_at: late?.published_at ?? null,
  };

  // 0. Tudo validado em memória antes de gravar.
  const mdResult = addItemToReviewedMd(readFileSync(mdPath, "utf8"), item, to, { tempo: opts.tempo });

  const approvedFiles = ["01-approved.json", "01-approved-capped.json"]
    .map((f) => resolve(internalDir, f))
    .filter((p) => existsSync(p))
    .map((path) => ({ path, data: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> }));
  const warnings: string[] = [];
  if (approvedFiles.length === 0) {
    warnings.push(`nenhum 01-approved*.json em ${internalDir} — só o 02-reviewed.md foi alterado.`);
  }

  const writes: VerifiedWrite[] = [];
  const newItem = buildApprovedItem(item, to);
  for (const f of approvedFiles) {
    // Lança se a URL é destaque; move se já estava noutro bucket; senão insere o item novo.
    const r = moveInApprovedJson(f.data, item.url, to, newItem);
    if (r.from) warnings.push(`${f.path.split("/").pop()}: a URL já estava no bucket ${r.from} — movida para ${to}.`);
    if (r.changed) writes.push({ path: f.path, content: JSON.stringify(f.data, null, 2) + "\n" });
  }
  writes.push({ path: mdPath, content: mdResult.md });
  if (!dryRun) writeFilesVerified(writes, "add-pool-item");

  for (const f of approvedFiles) {
    for (const e of lintNewsletter(mdResult.md, f.data as ApprovedJson).errors) {
      if (sameUrl(e.url, item.url)) warnings.push(`url-bucket (${f.path.split("/").pop()}): ${JSON.stringify(e)}`);
    }
  }

  const dir = editionDir.replace(/\/+$/, "");
  const nextSteps: string[] = [];
  if (to === "lancamento") {
    nextSteps.push(`LANÇAMENTOS só com link oficial (#160): npx tsx scripts/validate-lancamentos.ts ${mdPath}`);
  }
  nextSteps.push(
    `Traduzir/ajustar a descrição ao tom da seção, se preciso (lint no-untranslated-summary acusa descrição em inglês).`,
    `Re-auditar o intake (invariante "Intake desatualizado"): npx tsx scripts/audit-newsletter-intake.ts --edition ${editionFromDir(dir) ?? "AAMMDD"} --edition-dir ${dir}`,
    `Re-render do HTML da newsletter (§4b steps 1-3) e npx tsx scripts/check-invariants.ts --edition-dir ${dir} --stage 4`,
  );

  return {
    url: item.url,
    to,
    title,
    dry_run: dryRun,
    from_late_refresh: late !== null,
    rewritten: writes.map((w) => w.path),
    tempo_added: mdResult.tempo_added,
    intro_count: mdResult.intro_count,
    warnings,
    next_steps: nextSteps,
  };
}

function main(): void {
  const args = parseArgsWithTrueDefault(process.argv.slice(2));
  const editionDir = args["edition-dir"];
  const url = args.url;
  const to = args.to as SectionBucket | undefined;
  if (!editionDir || !url || !to) {
    console.error(
      'Uso: add-pool-item.ts --edition-dir <dir> --url <url> --to <lancamento|radar|use_melhor|video> [--title "..."] [--summary "..."] [--tempo N] [--dry-run]',
    );
    process.exit(2);
  }
  let tempo: number | undefined;
  if (args.tempo !== undefined) {
    tempo = Number(args.tempo);
    if (!Number.isInteger(tempo) || tempo <= 0) {
      console.error(`add-pool-item: --tempo precisa ser inteiro positivo (minutos), recebido: ${args.tempo}`);
      process.exit(2);
    }
  }
  try {
    const result = addPoolItem(resolve(editionDir), { url, title: args.title, summary: args.summary }, to, {
      tempo,
      dryRun: args["dry-run"] === "true",
    });
    for (const w of result.warnings) console.error(`⚠️  ${w}`);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`add-pool-item: ${(e as Error).message}`);
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
