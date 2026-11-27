#!/usr/bin/env node
/**
 * scripts/mark-video-liberada.ts (#13630)
 *
 * Marca a edição como LIBERADA para o arquivamento do vídeo tirar do Drive os
 * finais, prévias e editados (`Final/`, `Editado(s)/`, `* - previa *.mp4`).
 * Último passo do `/diaria-publica`: a sessão de publicação só grava o
 * marcador `_internal/05-video-liberada.json`; quem baixa, confere (tamanho +
 * MD5) e apaga é `scripts/archive-video-brutos.ts` no 300. Assim a sessão não
 * fica presa baixando GBs. Desde a #14292 (27/11/2026, plano novo do Google
 * Drive) a task diária `Diaria-Video-Bruto-Archive` foi aposentada: o marcador
 * só tem efeito numa rodada manual do script.
 *
 * Só marca com o horizontal publicado (link no D1 ou `05-youtube-published.json`
 * com `videoId`, o mesmo sinal da rotina; o Studio sobe a partir de `Final/`,
 * #11208, então o final não pode sair antes do link) e o vertical terminal
 * (todo destino publicado, agendado ou pulado por credencial, o mesmo critério
 * que libera apagar o vertical local, #11240). Sem isso, exit 1 e nada gravado.
 * Os cortes extras e o vertical 2 do roteiro (banco de agendamentos) NÃO
 * impedem o marcador: a rotina confere o banco a cada rodada e só recolhe os
 * finais quando nenhum item da edição está pendente.
 *
 * Os brutos não dependem do marcador: seguem a idade mínima de 4 dias e o
 * `source.json` das outras edições (#12602).
 *
 * Uso:
 *   npx tsx scripts/mark-video-liberada.ts 261119           # confere e grava
 *   npx tsx scripts/mark-video-liberada.ts 261119 --dry-run # só confere
 *   npx tsx scripts/mark-video-liberada.ts 261119 --force   # grava sem conferir (o editor decidiu)
 *   npx tsx scripts/mark-video-liberada.ts 261119 --json
 *
 * Exit: 0 marcada (ou já marcada); 1 condição não atendida ou erro de leitura; 2 argumento inválido.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { editionDirUnder, editionVideoPublished } from "./prune-video-montage-cache.ts";
import { shortsVideoTerminal } from "./lib/diaria/published-video-cleanup.ts";
import { loadShortsConfig, type ShortsConfig } from "./lib/diaria/short-video.ts";
import { VIDEO_LIBERADA_FILE, parseVideoLiberada } from "./lib/diaria/video-drive-cleanup.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[mark-video-liberada]";

export interface LiberadaCheck {
  edition: string;
  horizontal: boolean;
  vertical: boolean;
  /** Já estava marcada antes desta execução. */
  already: boolean;
  problems: string[];
}

/** Confere as duas condições do marcador. Nunca grava. */
export function checkLiberada(opts: { dataRoot: string; edition: string; shortsConfig: () => ShortsConfig }): LiberadaCheck {
  const dir = editionDirUnder(opts.dataRoot, opts.edition);
  const out: LiberadaCheck = { edition: opts.edition, horizontal: false, vertical: false, already: false, problems: [] };
  if (!existsSync(dir)) {
    out.problems.push(`pasta da edição ausente: ${dir}`);
    return out;
  }
  try {
    out.already = parseVideoLiberada(JSON.parse(readFileSync(join(dir, VIDEO_LIBERADA_FILE), "utf8")), opts.edition);
  } catch {
    out.already = false;
  }
  const h = editionVideoPublished(dir, opts.edition);
  if (h.warning) out.problems.push(h.warning);
  out.horizontal = h.value === true;
  if (!out.horizontal) out.problems.push("horizontal sem link gravado (05-video-url.txt ou 05-youtube-published.json com videoId)");
  try {
    out.vertical = shortsVideoTerminal(dir, opts.edition, opts.shortsConfig());
  } catch (e) {
    out.problems.push(`vertical: não consegui ler o registro ou a config (${(e as Error).message})`);
    out.vertical = false;
  }
  if (!out.vertical && !out.problems.some((p) => p.startsWith("vertical:"))) {
    out.problems.push("vertical com destino ainda não publicado, agendado nem pulado por credencial");
  }
  return out;
}

/** Grava o marcador (atômico). */
export function writeLiberada(dataRoot: string, edition: string, now: Date, extra: { forced: boolean }): string {
  const path = join(editionDirUnder(dataRoot, edition), VIDEO_LIBERADA_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify({ aammdd: edition, liberada_at: now.toISOString(), forced: extra.forced }, null, 2) + "\n");
  return path;
}

function main(): void {
  const argv = process.argv.slice(2);
  const edition = argv.find((a) => !a.startsWith("--"));
  if (!edition || !/^\d{6}$/.test(edition)) {
    console.error(`${LOG_PREFIX} uso: mark-video-liberada.ts AAMMDD [--dry-run] [--force] [--json]`);
    process.exitCode = 2;
    return;
  }
  const dataRoot = join(ROOT, "data");
  const force = hasFlag(argv, "force");
  const check = checkLiberada({
    dataRoot,
    edition,
    shortsConfig: () => loadShortsConfig(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"))),
  });
  const ok = check.horizontal && check.vertical;
  let written: string | null = null;
  if ((ok || force) && !hasFlag(argv, "dry-run") && !(check.already && !force)) {
    if (!existsSync(editionDirUnder(dataRoot, edition))) {
      console.error(`${LOG_PREFIX} pasta da edição ausente; nada gravado`);
      process.exitCode = 1;
      return;
    }
    written = writeLiberada(dataRoot, edition, new Date(), { forced: force && !ok });
  }
  const result = { ...check, liberada: check.already || written !== null, written };
  if (hasFlag(argv, "json")) console.log(JSON.stringify(result, null, 2));
  else if (result.liberada) {
    console.log(`${LOG_PREFIX} ${edition} liberada${written ? ` (${written})` : " (já estava)"}: uma rodada manual de scripts/archive-video-brutos.ts recolhe os finais (a task diária saiu na #14292).`);
  } else {
    console.log(`${LOG_PREFIX} ${edition} NÃO liberada${hasFlag(argv, "dry-run") ? " (dry-run)" : ""}: ${check.problems.join("; ")}`);
  }
  if (!result.liberada && !hasFlag(argv, "dry-run")) process.exitCode = 1;
  if (hasFlag(argv, "dry-run") && !ok) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) main();
