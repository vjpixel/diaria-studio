/**
 * scripts/lib/renumber-edition.ts (#12616)
 *
 * Miolo de `scripts/renumber-edition.ts`: troca o AAMMDD de uma edição
 * (`data/editions/{AAMM}/{de}` → `.../{para}`) e monta a lista ordenada dos
 * passos remotos que precisam rodar depois (re-upload das imagens, poll, Kit,
 * página do site, semanal de frio).
 *
 * Em 10/11/2026 duas edições foram renumeradas à mão (261110 → 261111 e
 * 261109 → 261110). As armadilhas da troca manual que este módulo fixa:
 *
 * - **Borda numérica.** O ID só é trocado quando não tem dígito colado dos
 *   dois lados: `20261109_150417.mp4` (nome do bruto no Drive) e
 *   `2026-11-09` ficam como estão.
 * - **`img-{de}-…` não é trocado.** É o nome do objeto já publicado no R2
 *   (`upload-images-public.ts`): trocar o texto apontaria pra uma imagem que
 *   não existe. Quem gera as URLs novas é o re-upload (passo remoto 1-2).
 * - **`06-public-images.json` sai do caminho.** Vai pra
 *   `_internal/_forensic/06-public-images.{de}.json`, como na troca manual:
 *   com o cache no lugar, o re-upload reaproveitaria as URLs antigas.
 * - **`_internal/_forensic/` não é tocado.** É registro histórico.
 * - **Destino existente ⇒ recusa.** Nunca mescla duas edições.
 *
 * Idempotente: a pasta nova guarda `_internal/renumber-edition.json`; rodar de
 * novo com a origem já movida e esse relatório no destino retoma (pula a parte
 * local, segue nos passos remotos ainda não concluídos).
 *
 * Tudo aqui é síncrono e de sistema de arquivos local. Nada chama rede: os
 * passos remotos são só DESCRITOS (argv), e quem os executa é o CLI.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { editionDir } from "./edition-paths.ts";

export const RENUMBER_REPORT_FILENAME = "renumber-edition.json";
const FORENSIC_DIR = join("_internal", "_forensic");
const PUBLIC_IMAGES_FILENAME = "06-public-images.json";
/** Acima disso o arquivo não é lido como texto (vídeo, áudio, dump). */
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".mp4", ".mov", ".mkv", ".webm",
  ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".pdf", ".zip", ".gz", ".prproj", ".psd",
]);

/** AAMMDD com mês 01-12 e dia 01-31. */
export function isValidEditionId(id: string): boolean {
  if (!/^\d{6}$/.test(id)) return false;
  const mm = Number(id.slice(2, 4));
  const dd = Number(id.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** Regex do ID com borda numérica (sem dígito colado de nenhum lado). */
function idRegex(id: string): RegExp {
  return new RegExp(`(?<![0-9])${id}(?![0-9])`, "g");
}

/**
 * Troca `from` por `to` com borda numérica, preservando `img-{from}-…`
 * (objeto já publicado no R2). Devolve o texto novo e quantas trocas fez.
 */
export function replaceEditionId(text: string, from: string, to: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(idRegex(from), (match, offset: number, whole: string) => {
    if (whole.slice(Math.max(0, offset - 4), offset) === "img-") return match;
    count += 1;
    return to;
  });
  return { text: out, count };
}

/** Nome de arquivo/pasta com o ID trocado (mesma regra de borda), ou `null` se não muda. */
export function renamedSegment(name: string, from: string, to: string): string | null {
  const r = replaceEditionId(name, from, to);
  return r.count > 0 ? r.text : null;
}

export type RemoteStepId =
  | "upload-images-newsletter"
  | "upload-images-social"
  | "close-poll"
  | "kit-newsletter"
  | "site-page"
  | "kit-semanal-frio";

export interface RemoteStep {
  id: RemoteStepId;
  /** argv depois de `npx tsx` (o primeiro item é o script). */
  argv: string[];
  why: string;
}

export interface RemoteStepState {
  id: RemoteStepId;
  status: "pending" | "done" | "failed" | "skipped";
  exit_code?: number;
  at?: string;
  reason?: string;
}

export interface RenumberReport {
  from: string;
  to: string;
  from_dir: string;
  to_dir: string;
  renumbered_at: string;
  rewritten_files: Array<{ path: string; count: number }>;
  renamed_paths: Array<{ from: string; to: string }>;
  /** `img-{de}-…` deixados como estão (o re-upload gera os novos). */
  preserved_img_refs: number;
  public_images_moved_to: string | null;
  remote_steps: RemoteStepState[];
}

export type RenumberPlanResult =
  | { ok: true; resume: boolean; fromDir: string; toDir: string }
  | { ok: false; code: 2; reason: string };

/** Valida a troca e decide entre execução nova e retomada. Não escreve nada. */
export function planRenumber(root: string, from: string, to: string): RenumberPlanResult {
  if (!isValidEditionId(from)) return { ok: false, code: 2, reason: `--from inválido: ${JSON.stringify(from)} (esperado AAMMDD).` };
  if (!isValidEditionId(to)) return { ok: false, code: 2, reason: `--to inválido: ${JSON.stringify(to)} (esperado AAMMDD).` };
  if (from === to) return { ok: false, code: 2, reason: "--from e --to iguais: nada a renumerar." };
  const fromDir = resolve(root, editionDir(from));
  const toDir = resolve(root, editionDir(to));
  const fromExists = existsSync(fromDir);
  const toExists = existsSync(toDir);
  if (fromExists && toExists) {
    return { ok: false, code: 2, reason: `destino ${relative(root, toDir)} já existe — recusado (nunca mescla duas edições).` };
  }
  if (!fromExists && toExists) {
    const report = readRenumberReport(toDir);
    if (report && report.from === from && report.to === to) return { ok: true, resume: true, fromDir, toDir };
    return {
      ok: false,
      code: 2,
      reason: `origem ${relative(root, fromDir)} não existe e o destino ${relative(root, toDir)} já existe sem relatório de ${from} → ${to} — recusado.`,
    };
  }
  if (!fromExists) return { ok: false, code: 2, reason: `origem ${relative(root, fromDir)} não existe.` };
  return { ok: true, resume: false, fromDir, toDir };
}

export function readRenumberReport(dir: string): RenumberReport | null {
  const p = join(dir, "_internal", RENUMBER_REPORT_FILENAME);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RenumberReport;
  } catch {
    return null;
  }
}

export function writeRenumberReport(dir: string, report: RenumberReport): void {
  const p = join(dir, "_internal", RENUMBER_REPORT_FILENAME);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(report, null, 2) + "\n");
}

function isForensic(rel: string): boolean {
  return rel === FORENSIC_DIR || rel.startsWith(FORENSIC_DIR + sep);
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Lista recursiva (arquivos e pastas), filhos antes dos pais, fora de `_forensic/`. */
function walk(dir: string, base: string = dir): Array<{ abs: string; rel: string; isDir: boolean }> {
  const out: Array<{ abs: string; rel: string; isDir: boolean }> = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = relative(base, abs);
    if (isForensic(rel)) continue;
    const isDir = statSync(abs).isDirectory();
    if (isDir) out.push(...walk(abs, base));
    out.push({ abs, rel, isDir });
  }
  return out;
}

export interface LocalScan {
  rewritten: Array<{ path: string; count: number }>;
  renames: Array<{ from: string; to: string }>;
  preserved: number;
  publicImages: boolean;
}

/** O que a parte local faria, sem escrever nada (dry-run e base do `renumberLocal`). */
export function scanLocal(fromDir: string, from: string, to: string): LocalScan {
  const rewritten: Array<{ path: string; count: number }> = [];
  const renames: Array<{ from: string; to: string }> = [];
  let preserved = 0;
  for (const e of walk(fromDir)) {
    const rel = e.rel.split(sep).join("/");
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    const next = renamedSegment(name, from, to);
    if (next) renames.push({ from: rel, to: rel.slice(0, rel.length - name.length) + next });
    if (e.isDir || rel === PUBLIC_IMAGES_FILENAME) continue;
    const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".")).toLowerCase() : "";
    if (BINARY_EXTENSIONS.has(ext)) continue;
    if (statSync(e.abs).size > MAX_TEXT_BYTES) continue;
    const buf = readFileSync(e.abs);
    if (looksBinary(buf)) continue;
    const text = buf.toString("utf8");
    preserved += (text.match(new RegExp(`img-${from}(?![0-9])`, "g")) ?? []).length;
    const r = replaceEditionId(text, from, to);
    if (r.count > 0) rewritten.push({ path: rel, count: r.count });
  }
  return { rewritten, renames, preserved, publicImages: existsSync(join(fromDir, PUBLIC_IMAGES_FILENAME)) };
}

/**
 * Parte local, na pasta de ORIGEM (antes do `mv`, pra uma falha no meio deixar
 * tudo debaixo de um único caminho): tira o `06-public-images.json` do
 * caminho, reescreve o conteúdo dos arquivos de texto, renomeia arquivos e
 * pastas com o ID (filhos antes dos pais) e por fim move a pasta pra
 * `editionDir(to)`. Colisão de nome em qualquer ponto ⇒ lança ANTES de
 * escrever (a varredura confere todas primeiro).
 */
export function renumberLocal(
  root: string,
  from: string,
  to: string,
  nowIso: string,
  remoteSteps: RemoteStep[] = [],
): RenumberReport {
  const plan = planRenumber(root, from, to);
  if (!plan.ok) throw new Error(plan.reason);
  if (plan.resume) throw new Error("renumberLocal chamado numa retomada — a parte local já foi feita.");
  const { fromDir, toDir } = plan;
  const scan = scanLocal(fromDir, from, to);

  const forensicTarget = join(fromDir, FORENSIC_DIR, `06-public-images.${from}.json`);
  if (scan.publicImages && existsSync(forensicTarget)) {
    throw new Error(`${relative(root, forensicTarget)} já existe — recusado (não sobrescreve forense).`);
  }
  for (const r of scan.renames) {
    if (existsSync(join(fromDir, r.to))) throw new Error(`${r.to} já existe na edição — recusado (renomear sobrescreveria).`);
  }

  let publicImagesMovedTo: string | null = null;
  if (scan.publicImages) {
    mkdirSync(dirname(forensicTarget), { recursive: true });
    renameSync(join(fromDir, PUBLIC_IMAGES_FILENAME), forensicTarget);
    publicImagesMovedTo = relative(fromDir, forensicTarget).split(sep).join("/");
  }
  for (const f of scan.rewritten) {
    const abs = join(fromDir, f.path);
    writeFileSync(abs, replaceEditionId(readFileSync(abs, "utf8"), from, to).text);
  }
  // `walk` lista filhos antes dos pais: renomear nessa ordem mantém válidos os
  // caminhos ainda não renomeados.
  for (const r of scan.renames) renameSync(join(fromDir, r.from), join(fromDir, r.to));

  mkdirSync(dirname(toDir), { recursive: true });
  renameSync(fromDir, toDir);

  const report: RenumberReport = {
    from,
    to,
    from_dir: relative(root, fromDir).split(sep).join("/"),
    to_dir: relative(root, toDir).split(sep).join("/"),
    renumbered_at: nowIso,
    rewritten_files: scan.rewritten,
    renamed_paths: scan.renames,
    preserved_img_refs: scan.preserved,
    public_images_moved_to: publicImagesMovedTo,
    remote_steps: remoteSteps.map((s) => ({ id: s.id, status: "pending" })),
  };
  writeRenumberReport(toDir, report);
  return report;
}

function readJson(p: string): Record<string, unknown> | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Passos remotos, na ordem da troca manual de 10/11/2026. Os que dependem de
 * algo já publicado só entram se o estado local mostrar que foi publicado
 * (broadcast do Kit, página do site, semanal de frio). `dir` é a pasta NOVA,
 * relativa à raiz do repo.
 */
export function buildRemoteSteps(root: string, dir: string, to: string): RemoteStep[] {
  const abs = resolve(root, dir);
  const steps: RemoteStep[] = [
    {
      id: "upload-images-newsletter",
      argv: ["scripts/upload-images-public.ts", "--edition-dir", dir, "--mode", "newsletter"],
      why: `imagens re-publicadas como img-${to}-… (06-public-images.json novo).`,
    },
    {
      id: "upload-images-social",
      argv: ["scripts/upload-images-public.ts", "--edition-dir", dir, "--mode", "social"],
      why: "idem, imagens das redes.",
    },
    {
      id: "close-poll",
      argv: ["scripts/close-poll.ts", "--edition", to],
      why: `gabarito do É IA? gravado sob o ID ${to}.`,
    },
  ];
  if (existsSync(join(abs, "_internal", "newsletter-kit-published.json"))) {
    steps.push({
      id: "kit-newsletter",
      argv: ["scripts/publish-newsletter-kit.ts", dir],
      why: "broadcast já existente no Kit atualizado (UTMs, /vote/, imagens).",
    });
  }
  const site = readJson(join(abs, "_internal", "site-page-published.json"));
  if (site) {
    const slug = typeof site.slug === "string" && site.slug.trim() !== "" ? site.slug : null;
    steps.push({
      id: "site-page",
      argv: slug
        ? ["scripts/publish-edition-site-page.ts", "--edition-dir", dir, "--slug", slug]
        : ["scripts/publish-edition-site-page.ts", "--edition-dir", dir, "--slug-from-d1"],
      why: "página da edição republicada (datePublished, UTMs, jogar?edition=).",
    });
  }
  if (existsSync(join(abs, "_internal", "kit-semanal-frio-published.json"))) {
    steps.push({
      id: "kit-semanal-frio",
      argv: ["scripts/publish-kit-semanal-frio.ts", "--edition-dir", dir, "--push"],
      why: "semanal de frio já agendada re-sincronizada com o principal, mesmo fora de segunda (#12616).",
    });
  }
  return steps;
}

/** Alinha o estado dos passos do relatório com a lista atual (passo novo entra `pending`). */
export function mergeStepStates(steps: RemoteStep[], prior: RemoteStepState[]): RemoteStepState[] {
  const byId = new Map(prior.map((s) => [s.id, s]));
  return steps.map((s) => byId.get(s.id) ?? { id: s.id, status: "pending" });
}
