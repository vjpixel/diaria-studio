/**
 * reserve-destaque.ts (#13331) — reserva um destaque pronto de uma edição
 * para outra.
 *
 * Caso de origem: no gate 4 da 261117 o editor pediu que "Brasil vai precisar
 * de licença dos EUA para chips" (D2 da 261117) fosse o D1 da 261118.
 *
 * Uso:
 *   npx tsx scripts/reserve-destaque.ts --from 261117 --dest d2 --to 261118 --position 1
 *     [--editions-root data/editions] [--dry-run]
 *
 * O que faz:
 *   - lê o destaque `--dest` da edição `--from` (`02-reviewed.md`; sem ele,
 *     `_internal/01-approved.json`);
 *   - copia o pacote para `{to}/_internal/reserved-destaques/{from}-{dest}/`:
 *     `destaque.md` (bloco do 02-reviewed), `destaque.json` (campos
 *     parseados), `social.md` (blocos `## dN`/`## dN-cards` do 03-social),
 *     `highlight.json` (entrada do 01-approved, com as fontes) e as imagens
 *     `04-{dest}*` (raiz e `_internal/`). A pasta da edição de destino é
 *     criada se ainda não existe;
 *   - grava a reserva em `{to}/_internal/reserved-destaques.json`. O Stage 1
 *     do destino (`inject-inbox-urls.ts`, passo 1h) injeta o link no pool com
 *     `editor_destaque_request` = `d{position}`, e o invariante
 *     `editor-destaque-request` (#12193) avisa no gate 4 se ele não sair
 *     nessa posição.
 *
 * Não mexe na edição de origem: tirar o destaque dela é edição do editor no
 * gate 4 (o script só lembra disso na saída).
 *
 * Saída: JSON no stdout. Exit 1 em erro (destaque ausente, posição já
 * reservada para outro link, origem = destino).
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts";
import { editionsRoot } from "./lib/edition-paths.ts";
import { parseDestaques } from "./extract-destaques.ts";
import { canonicalize } from "./lib/url-utils.ts";
import {
  RESERVED_DESTAQUES_FILE,
  RESERVED_PACKAGES_DIR,
  extractRawDestaqueBlock,
  extractSocialPackage,
  findSlotConflicts,
  isDestaqueAssetName,
  parseDestaqueSlot,
  readReservedDestaques,
  upsertReservation,
  type DestaqueSlot,
  type ReservedDestaque,
} from "./lib/reserved-destaques.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface ReserveOptions {
  from: string;
  dest: DestaqueSlot;
  to: string;
  position: DestaqueSlot;
  /** Raiz das edições (absoluta ou relativa ao cwd). */
  editionsRootDir: string;
  dryRun?: boolean;
  now?: () => Date;
}

export interface ReserveResult {
  reservation: ReservedDestaque;
  target_dir: string;
  target_created: boolean;
  package_files: string[];
  warnings: string[];
  dry_run: boolean;
}

type ApprovedHighlight = { url?: string; title?: string; article?: { url?: string; title?: string; [k: string]: unknown }; [k: string]: unknown };

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function highlightUrl(h: ApprovedHighlight | undefined): string | undefined {
  if (!h) return undefined;
  return typeof h.url === "string" ? h.url : typeof h.article?.url === "string" ? h.article.url : undefined;
}

/** Faz a reserva. Lança `Error` com mensagem legível em qualquer recusa. */
export function reserveDestaque(opts: ReserveOptions): ReserveResult {
  if (!/^\d{6}$/.test(opts.from) || !/^\d{6}$/.test(opts.to)) {
    throw new Error(`--from e --to precisam ser AAMMDD (recebido: ${opts.from}, ${opts.to})`);
  }
  if (opts.from === opts.to) throw new Error("--from e --to são a mesma edição");

  const n = Number(opts.dest.slice(1)) as 1 | 2 | 3;
  const srcDir = resolveEditionDir(opts.editionsRootDir, opts.from);
  if (!existsSync(srcDir)) throw new Error(`edição de origem não encontrada: ${srcDir}`);
  const srcInternal = join(srcDir, "_internal");
  const warnings: string[] = [];

  // Texto: 02-reviewed.md é o que o editor revisou no gate 4.
  const reviewedPath = join(srcDir, "02-reviewed.md");
  const reviewed = existsSync(reviewedPath) ? readFileSync(reviewedPath, "utf8") : null;
  const parsed = reviewed ? parseDestaques(reviewed).find((d) => d.n === n) : undefined;
  const rawBlock = reviewed ? extractRawDestaqueBlock(reviewed, n) : null;

  // Fontes: 01-approved.json.
  const approvedPath = join(srcInternal, "01-approved.json");
  let highlights: ApprovedHighlight[] = [];
  if (existsSync(approvedPath)) {
    const j = readJson(approvedPath) as { highlights?: ApprovedHighlight[] };
    highlights = Array.isArray(j.highlights) ? j.highlights : [];
  }

  const url = parsed?.url || highlightUrl(highlights[n - 1]);
  if (!url) {
    throw new Error(
      `${opts.dest.toUpperCase()} não encontrado em ${opts.from} (sem 02-reviewed.md com DESTAQUE ${n} nem highlights[${n - 1}] em 01-approved.json)`,
    );
  }
  if (!parsed) warnings.push(`02-reviewed.md sem DESTAQUE ${n}: texto do destaque não copiado, só as fontes do 01-approved.json`);
  const canon = canonicalize(url);
  const highlight =
    highlights.find((h) => {
      const u = highlightUrl(h);
      return u ? canonicalize(u) === canon : false;
    }) ?? undefined;
  if (!highlight) warnings.push(`URL do ${opts.dest.toUpperCase()} não está nos highlights do 01-approved.json: highlight.json não copiado`);
  const title =
    parsed?.title ||
    (typeof highlight?.title === "string" ? highlight.title : undefined) ||
    (typeof highlight?.article?.title === "string" ? highlight.article.title : undefined) ||
    "";

  // Destino (pode não existir ainda).
  const targetDir = resolveEditionDir(opts.editionsRootDir, opts.to);
  const targetCreated = !existsSync(targetDir);
  const targetInternal = join(targetDir, "_internal");
  const packageRel = join("_internal", RESERVED_PACKAGES_DIR, `${opts.from}-${opts.dest}`);
  const packageAbs = join(targetDir, packageRel);

  const existing = readReservedDestaques(targetInternal);
  const reservation: ReservedDestaque = {
    url: canon,
    title,
    request: opts.position,
    from_edition: opts.from,
    from_destaque: opts.dest,
    package_dir: packageRel.split("\\").join("/"),
    reserved_at: (opts.now ?? (() => new Date()))().toISOString(),
    ...(parsed?.category ? { category: parsed.category } : {}),
  };
  const conflicts = findSlotConflicts(existing, reservation);
  if (conflicts.length > 0) {
    throw new Error(
      `${opts.position.toUpperCase()} de ${opts.to} já está reservado para ${conflicts[0].url} (de ${conflicts[0].from_edition}/${conflicts[0].from_destaque}). ` +
        `Edite ou apague ${join(targetInternal, RESERVED_DESTAQUES_FILE)} antes de reservar outro link na mesma posição.`,
    );
  }
  if (existsSync(join(targetInternal, "01-approved.json"))) {
    warnings.push(`o Stage 1 de ${opts.to} já rodou (01-approved.json existe): a reserva só entra no pool se o Stage 1 rodar de novo`);
  }

  // Pacote.
  const files: Array<{ name: string; content?: string; copyFrom?: string }> = [];
  if (rawBlock) files.push({ name: "destaque.md", content: rawBlock });
  if (parsed) files.push({ name: "destaque.json", content: JSON.stringify(parsed, null, 2) + "\n" });
  if (highlight) files.push({ name: "highlight.json", content: JSON.stringify(highlight, null, 2) + "\n" });
  const socialPath = join(srcDir, "03-social.md");
  if (existsSync(socialPath)) {
    const social = extractSocialPackage(readFileSync(socialPath, "utf8"), opts.dest);
    if (social) files.push({ name: "social.md", content: social });
    else warnings.push(`03-social.md sem ## ${opts.dest}: social não copiado`);
  } else {
    warnings.push("03-social.md ausente na origem: social não copiado");
  }
  for (const dir of [srcDir, srcInternal]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!isDestaqueAssetName(name, opts.dest)) continue;
      const abs = join(dir, name);
      if (!statSync(abs).isFile()) continue;
      if (files.some((f) => f.name === name)) continue;
      files.push({ name, copyFrom: abs });
    }
  }

  const packageFiles = files.map((f) => `${reservation.package_dir}/${f.name}`);
  if (!opts.dryRun) {
    mkdirSync(packageAbs, { recursive: true });
    for (const f of files) {
      const dest = join(packageAbs, f.name);
      if (f.copyFrom) copyFileSync(f.copyFrom, dest);
      else writeFileSync(dest, f.content ?? "", "utf8");
    }
    const listPath = join(targetInternal, RESERVED_DESTAQUES_FILE);
    const tmp = listPath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ reservations: upsertReservation(existing, reservation) }, null, 2) + "\n", "utf8");
    renameSync(tmp, listPath);
  }

  warnings.push(`${opts.from} não foi alterada: tire o ${opts.dest.toUpperCase()} dela no gate 4 se ele não deve sair lá`);
  return {
    reservation,
    target_dir: targetDir,
    target_created: targetCreated,
    package_files: packageFiles,
    warnings,
    dry_run: !!opts.dryRun,
  };
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const dest = parseDestaqueSlot(values["dest"]);
  const position = parseDestaqueSlot(values["position"]);
  if (!values["from"] || !values["to"] || !dest || !position) {
    console.error(
      "Uso: reserve-destaque.ts --from AAMMDD --dest d1|d2|d3 --to AAMMDD --position 1|2|3 [--editions-root data/editions] [--dry-run]",
    );
    process.exit(1);
  }
  const rootArg = values["editions-root"] ?? editionsRoot();
  try {
    const result = reserveDestaque({
      from: values["from"],
      dest,
      to: values["to"],
      position,
      editionsRootDir: resolve(ROOT, rootArg),
      dryRun: flags.has("dry-run"),
    });
    console.log(JSON.stringify({ ...result, target_dir: relative(ROOT, result.target_dir).split("\\").join("/") }, null, 2));
    for (const w of result.warnings) console.error(`[reserve-destaque] ${w}`);
  } catch (e) {
    console.error(`[reserve-destaque] erro: ${(e as Error).message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();
