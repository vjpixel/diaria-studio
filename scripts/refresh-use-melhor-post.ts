/**
 * refresh-use-melhor-post.ts (#10469)
 *
 * Comando único pro editor mexer no USE MELHOR no gate 4: re-seleciona o item
 * do 4º post contra o `02-reviewed.md` (preserva o escolhido se ele segue
 * renderizado, #9610), compara com o que estava gravado e imprime o plano do
 * que falta refazer (texto `## um`, carrossel de N slides, preview) com os
 * comandos exatos. Idempotente: rodar de novo sem mudança → plano vazio.
 *
 * Só a re-seleção grava (`_internal/use-melhor-post.json`); social-writer /
 * social-curto / humanizador são agents/skills — ficam como passos do plano.
 *
 * Uso: npx tsx scripts/refresh-use-melhor-post.ts --edition-dir data/editions/AAMMDD/ [--force | --url <url>] [--json] | --done
 *      npx tsx scripts/refresh-use-melhor-post.ts --edition-dir ... --off "<motivo>" | --on
 * `--url <url>` (sinônimo `--pick`, #13849): o editor escolhe o item do 4º post
 * (qualquer item do USE MELHOR final). URL fora do USE MELHOR → exit 2, nada gravado.
 * (--done limpa a pendência gravada em _internal/use-melhor-refresh-pending.json)
 * Exit 0 sempre (fail-soft, como o select), exceto uso errado (2).
 *
 * `--off "<motivo>"` (#13977): desliga o 4º post SÓ desta edição, num passo:
 *   1. `_internal/use-melhor-post.json` com `item: null`, `reason` e `editor_off: true`;
 *   2. tira os `## um` de `# Social` e `# Curto` em `03-social.md`;
 *   3. tira as chaves `um_carousel_*` de `06-public-images.json`;
 *   4. refaz o selo do humanizador (`check-humanizer-social.ts --write --bypass-reason`)
 *      quando ele batia com o `03-social.md` antes da remoção. Selo já defasado ou
 *      ausente fica como estava (refazer esconderia a edição sem humanizar) e a saída
 *      diz isso. Remover seção não exige prova do humanizador: nenhum texto novo.
 * Os 3 arquivos vão num lote verificado com rollback (`writeFilesVerified`); falha
 * no selo desfaz o lote. Idempotente: rodar de novo só regrava o estado. O
 * `.social-source-hash.json` não muda: ele é o hash dos destaques do
 * `01-approved.json`, que o `--off` não toca. Nenhuma seleção posterior religa
 * (`runSelection` preserva `editor_off`); `--on` limpa a marca e re-seleciona.
 * Exit 1 se o `--off` falhou (nada fica gravado).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import {
  loadUseMelhorPostConfigState,
  readUseMelhorPostState,
  removeUseMelhorUmSections,
  useMelhorPostStatePath,
  writeUseMelhorPostState,
  USE_MELHOR_OFF_SELECTED_FROM,
  type UseMelhorPostConfigState,
  type UseMelhorPostState,
} from "./lib/use-melhor-post.ts";
import { useMelhorSlotFromImageKey } from "./lib/use-melhor-slide-files.ts";
import { writeFilesVerified, type VerifiedWrite } from "./lib/write-files-verified.ts";
import { checkSentinel, writeSentinelDetailed } from "./check-humanizer-social.ts";
import { gatherUseMelhorStatusInput } from "./lib/use-melhor-status.ts";
import { buildUseMelhorRefreshPlan } from "./lib/use-melhor-refresh-plan.ts";
import { PickError, pickIgnoredWarning, runSelectionWithSteps } from "./select-use-melhor-post.ts";

const PENDING_REL = "_internal/use-melhor-refresh-pending.json";

const ROOT = resolve(import.meta.dirname, "..");

export interface UseMelhorOffResult {
  state_path: string;
  /** Blocos `## um` tirados de `03-social.md` (0 quando já não havia). */
  removed_sections: number;
  removed_image_keys: string[];
  /** `resealed`: selo refeito; `unchanged`: social não mudou; os outros dois: selo deixado como estava. */
  seal: "resealed" | "unchanged" | "skipped-no-seal" | "skipped-stale-seal";
}

/** Funções injetáveis para teste (#13977): o rollback quando o selo falha. */
export interface UseMelhorOffDeps {
  writeSeal: (editionDir: string, reason: string) => void;
}

const defaultOffDeps: UseMelhorOffDeps = {
  writeSeal: (dir, reason) => {
    writeSentinelDetailed(dir, reason);
  },
};

function readText(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/**
 * #13977: desliga o 4º post desta edição (ver docblock do arquivo). Lança com o
 * lote revertido em qualquer falha.
 */
export function turnUseMelhorPostOff(
  editionDir: string,
  reason: string,
  config: Pick<UseMelhorPostConfigState, "enabled" | "time">,
  opts: { now?: Date; deps?: UseMelhorOffDeps } = {},
): UseMelhorOffResult {
  const motivo = reason.trim();
  if (!motivo) throw new Error("--off exige o motivo do editor");
  const deps = opts.deps ?? defaultOffDeps;
  const statePath = useMelhorPostStatePath(editionDir);
  const socialPath = resolve(editionDir, "03-social.md");
  const imagesPath = resolve(editionDir, "06-public-images.json");

  const prev = readUseMelhorPostState(editionDir);
  const prevStateText = readText(statePath);
  const socialText = readText(socialPath);
  const imagesText = readText(imagesPath);

  const sealBefore = socialText === null ? null : checkSentinel(editionDir);

  const state: UseMelhorPostState = {
    enabled: prev?.enabled ?? config.enabled,
    time: prev?.time ?? config.time,
    item: null,
    reason: `editor: ${motivo} (4º post desligado nesta edição com refresh-use-melhor-post.ts --off; religar com --on)`,
    selected_from: USE_MELHOR_OFF_SELECTED_FROM,
    editor_off: true,
    generated_at: (opts.now ?? new Date()).toISOString(),
  };
  const offItemUrl = prev?.item?.url ?? prev?.off_item_url;
  if (offItemUrl) state.off_item_url = offItemUrl;

  const writes: VerifiedWrite[] = [{ path: statePath, content: JSON.stringify(state, null, 2) + "\n" }];
  let removedSections = 0;
  if (socialText !== null) {
    const r = removeUseMelhorUmSections(socialText);
    removedSections = r.removed;
    if (r.removed > 0) writes.push({ path: socialPath, content: r.md });
  }
  let removedImageKeys: string[] = [];
  if (imagesText !== null) {
    // JSON ilegível: falha aqui, antes de qualquer escrita (nunca reescreve um cache corrompido).
    const data = JSON.parse(imagesText) as { images?: Record<string, unknown> };
    const images = data?.images;
    if (images && typeof images === "object") {
      removedImageKeys = Object.keys(images).filter((k) => useMelhorSlotFromImageKey(k) !== null);
      if (removedImageKeys.length > 0) {
        for (const k of removedImageKeys) delete images[k];
        writes.push({ path: imagesPath, content: JSON.stringify(data, null, 2) + "\n" });
      }
    }
  }

  mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
  writeFilesVerified(writes, "refresh-use-melhor-post --off");

  let seal: UseMelhorOffResult["seal"] = "unchanged";
  if (removedSections > 0) {
    if (sealBefore === null || (!sealBefore.ok && sealBefore.reason === "sentinel_missing")) seal = "skipped-no-seal";
    else if (!sealBefore.ok) seal = "skipped-stale-seal";
    else {
      try {
        deps.writeSeal(editionDir, `4º post desligado pelo editor (refresh-use-melhor-post.ts --off): ${motivo}`);
        seal = "resealed";
      } catch (e) {
        // Rollback do lote: o selo não pode ficar apontando pro social antigo
        // nem o social sem `## um` ficar sem selo.
        const restore: VerifiedWrite[] = [];
        if (socialText !== null) restore.push({ path: socialPath, content: socialText });
        if (imagesText !== null) restore.push({ path: imagesPath, content: imagesText });
        if (prevStateText !== null) restore.push({ path: statePath, content: prevStateText });
        writeFilesVerified(restore, "refresh-use-melhor-post --off (rollback)");
        if (prevStateText === null) unlinkSync(statePath);
        throw new Error(`selo do humanizador recusou (${(e as Error).message}) — nada gravado`);
      }
    }
  }
  // A pendência de reescrita do `## um` deixou de valer.
  rmSync(resolve(editionDir, PENDING_REL), { force: true });
  return { state_path: statePath, removed_sections: removedSections, removed_image_keys: removedImageKeys, seal };
}

/**
 * #13977: `--on` — tira a marca `editor_off` do estado (item continua `null`;
 * a seleção que vem depois escolhe o item de novo). `false` se não estava desligado.
 */
export function clearUseMelhorPostOff(editionDir: string, now: Date = new Date()): boolean {
  const prev = readUseMelhorPostState(editionDir);
  if (prev?.editor_off !== true) return false;
  const { editor_off: _off, off_item_url: _url, ...rest } = prev;
  writeUseMelhorPostState(editionDir, {
    ...rest,
    item: null,
    reason: "religado pelo editor (refresh-use-melhor-post.ts --on) — re-selecionar",
    selected_from: "reviewed",
    generated_at: now.toISOString(),
  });
  return true;
}

async function main(): Promise<number | void> {
  const args = parseCliArgs(process.argv.slice(2));
  const editionDir = args.values["edition-dir"];
  if (!editionDir) {
    console.error("uso: refresh-use-melhor-post.ts --edition-dir <dir> [--force | --url <url>] [--json]");
    return 2;
  }
  const pickUrl = args.values["url"] ?? args.values["pick"];
  if ((args.flags.has("url") || args.flags.has("pick") || pickUrl === "") && !pickUrl) {
    console.error("refresh-use-melhor-post: --url/--pick exige a URL do item do USE MELHOR");
    return 2;
  }
  const pendingAbs = resolve(editionDir, PENDING_REL);
  // #13977: `--off` sem valor vira flag (parseCliArgs) → uso errado.
  const offReason = args.values["off"];
  if (args.flags.has("off") || offReason !== undefined) {
    if (!offReason || !offReason.trim()) {
      console.error('refresh-use-melhor-post: --off exige o motivo ("--off \"<motivo>\"")');
      return 2;
    }
    if (args.flags.has("on") || pickUrl) {
      console.error("refresh-use-melhor-post: --off não combina com --on/--url");
      return 2;
    }
    try {
      const r = turnUseMelhorPostOff(editionDir, offReason, loadUseMelhorPostConfigState(ROOT, basename(resolve(editionDir))));
      console.log(JSON.stringify(r, null, 2));
      if (r.seal === "skipped-stale-seal") {
        console.error(
          "refresh-use-melhor-post: selo do humanizador já estava defasado antes do --off — mantido; re-humanizar o social como de costume.",
        );
      }
    } catch (e) {
      console.error(`refresh-use-melhor-post: --off falhou — ${(e as Error).message}`);
      return 1;
    }
    return;
  }
  if (args.flags.has("on")) {
    const cleared = clearUseMelhorPostOff(editionDir);
    console.error(
      cleared
        ? "refresh-use-melhor-post: 4º post religado nesta edição — re-selecionando o item."
        : "refresh-use-melhor-post: --on sem efeito (o 4º post não estava desligado pelo editor).",
    );
  }
  if (args.flags.has("done")) {
    rmSync(pendingAbs, { force: true });
    console.log("pendência do 4º post limpa");
    return;
  }
  const config = loadUseMelhorPostConfigState(ROOT, basename(resolve(editionDir)));
  const previous = config.enabled ? readUseMelhorPostState(editionDir) : null;
  try {
    const { state } = await runSelectionWithSteps(editionDir, config, {
      useReviewed: true,
      forceReselect: args.flags.has("force"),
      pickUrl,
    });
    const ignoredPick = pickIgnoredWarning(pickUrl, state);
    if (ignoredPick) console.error(`refresh-use-melhor-post: ${ignoredPick}`);
  } catch (e) {
    if (e instanceof PickError) {
      console.error(`refresh-use-melhor-post: --url recusado — ${e.message}. Nada gravado.`);
      return 2;
    }
    throw e;
  }
  const statusConfig = loadUseMelhorPostConfigState(ROOT, basename(resolve(editionDir)));
  const status = gatherUseMelhorStatusInput(editionDir, statusConfig);
  let pendingUrl: string | null = null;
  if (existsSync(pendingAbs)) {
    try {
      pendingUrl = JSON.parse(readFileSync(pendingAbs, "utf8")).url ?? null;
    } catch {
      pendingUrl = null;
    }
  }
  const plan = buildUseMelhorRefreshPlan({ previousUrl: previous?.item?.url ?? null, pendingUrl, status }, editionDir);
  const itemUrl = status.state?.item?.url;
  if (plan.rewrite_text && itemUrl) {
    mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
    writeFileSync(pendingAbs, JSON.stringify({ url: itemUrl }), "utf8");
  }
  if (args.flags.has("json")) console.log(JSON.stringify(plan, null, 2));
  else console.log([...plan.reasons.map((r) => `- ${r}`), ...plan.steps].join("\n"));
}

if (isMainModule(import.meta.url)) {
  try {
    const code = await main();
    if (typeof code === "number") process.exitCode = code;
  } catch (e) {
    console.error(`refresh-use-melhor-post: erro — ${(e as Error).message}`);
  }
}
