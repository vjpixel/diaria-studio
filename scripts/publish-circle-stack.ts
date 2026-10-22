#!/usr/bin/env tsx
/**
 * publish-circle-stack.ts (#10904)
 *
 * Publica o resumo semanal da diar.ia.br no espaço "Radar de Notícias Stack"
 * da comunidade Circle da Stack (`plataforma.stack.com.br/c/radar-de-noticias-stack`),
 * toda segunda, como a conta diar.ia.br.
 *
 * Conteúdo = a seleção semanal do LinkedIn já existente
 * (`data/weekly/{cycle}/_internal/ln-selection.json`). Se ela ainda não
 * existir pro ciclo, rode antes:
 *   npx tsx scripts/select-linkedin-weekly.ts --publish-monday AAMMDD
 *
 * **Dry-run por padrão**: grava o HTML e o payload em `data/weekly/{cycle}/`
 * e não chama a API. `--publish` cria o post de verdade, com o status de
 * `platform.config.json` → `circle_stack.status` (default `draft`) ou o de
 * `--status`. Idempotente por ciclo: `_internal/circle-stack-published.json`
 * registra o post criado e uma 2ª chamada aborta (`--force` sobrepõe).
 *
 * `--list-spaces` lista os espaços visíveis ao token — use uma vez pra achar
 * o `space_id` do Radar e gravar em `circle_stack.space_id`.
 *
 * Token: `CIRCLE_STACK_API_TOKEN` (Doppler/.env).
 *
 * Uso:
 *   npx tsx scripts/publish-circle-stack.ts --publish-monday 261026
 *   npx tsx scripts/publish-circle-stack.ts --cycle 26w43 --publish [--status published]
 *   npx tsx scripts/publish-circle-stack.ts --list-spaces
 *   (opcionais: --selection <path>, --opening-file <path>, --closing-file <path>, --force)
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { isValidWeeklyCycle, resolveWeeklyLinkedinCycle, weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import {
  createCirclePost,
  listCircleSpaces,
  buildCreatePostPayload,
  type CircleAuthScheme,
  type CirclePostStatus,
} from "./lib/circle-api.ts";
import { renderCircleStackPost, type CircleStackSelection } from "./lib/circle-stack-render.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CIRCLE_STACK_TOKEN_ENV = "CIRCLE_STACK_API_TOKEN";

export interface CircleStackConfig {
  enabled: boolean;
  baseUrl?: string;
  authScheme: CircleAuthScheme;
  spaceId: number | null;
  authorEmail: string | null;
  status: CirclePostStatus;
  isCommentsEnabled: boolean;
  skipNotifications: boolean;
  subscribeUrl: string | null;
}

const VALID_STATUS: CirclePostStatus[] = ["draft", "published"];

/** Pure: lê o bloco `circle_stack` do config, com defaults conservadores (rascunho). */
export function resolveCircleStackConfig(platformConfig: Record<string, unknown>): CircleStackConfig {
  const raw = (platformConfig.circle_stack ?? {}) as Record<string, unknown>;
  const status = (raw.status ?? "draft") as CirclePostStatus;
  if (!VALID_STATUS.includes(status)) throw new Error(`circle_stack.status inválido: ${String(raw.status)}`);
  const scheme = (raw.auth_scheme ?? "auto") as CircleAuthScheme;
  if (!["auto", "Token", "Bearer"].includes(scheme)) throw new Error(`circle_stack.auth_scheme inválido: ${String(raw.auth_scheme)}`);
  return {
    enabled: raw.enabled !== false,
    baseUrl: typeof raw.base_url === "string" ? raw.base_url : undefined,
    authScheme: scheme,
    spaceId: typeof raw.space_id === "number" ? raw.space_id : null,
    authorEmail: typeof raw.author_email === "string" && raw.author_email ? raw.author_email : null,
    status,
    isCommentsEnabled: raw.is_comments_enabled !== false,
    skipNotifications: raw.skip_notifications === true,
    subscribeUrl: typeof raw.subscribe_url === "string" && raw.subscribe_url ? raw.subscribe_url : null,
  };
}

/** Pure: resolve o ciclo a partir de `--cycle` ou `--publish-monday`. */
export function resolveCycleArg(cycleArg: string | undefined, publishMondayArg: string | undefined): string {
  if (cycleArg) {
    if (!isValidWeeklyCycle(cycleArg)) throw new Error(`--cycle inválido: ${cycleArg} (esperado YYwWW, ex: 26w43)`);
    return cycleArg;
  }
  if (publishMondayArg) {
    const r = resolveWeeklyLinkedinCycle(publishMondayArg);
    if (!r) throw new Error(`--publish-monday inválido: ${publishMondayArg} (esperado AAMMDD)`);
    return r.cycle;
  }
  throw new Error("Passe --cycle YYwWW ou --publish-monday AAMMDD");
}

function readTextArg(argv: string[], key: string): string | undefined {
  const p = getStringArg(argv, key, { example: "caminho/arquivo.txt" });
  return p ? readFileSync(resolve(p), "utf8") : undefined;
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const platformConfig = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const cfg = resolveCircleStackConfig(platformConfig);
  const token = process.env[CIRCLE_STACK_TOKEN_ENV] ?? "";
  const client = { token, baseUrl: cfg.baseUrl, authScheme: cfg.authScheme };

  if (hasFlag(argv, "list-spaces")) {
    if (!token) throw new Error(`${CIRCLE_STACK_TOKEN_ENV} ausente`);
    const spaces = await listCircleSpaces(client);
    for (const s of spaces) console.log(`${s.id}\t${s.slug}\t${s.name}`);
    if (spaces.length === 0) console.log("Nenhum espaço visível para este token.");
    return;
  }

  const cycle = resolveCycleArg(getStringArg(argv, "cycle"), getStringArg(argv, "publish-monday"));
  const cycleDir = join(ROOT, weeklyLinkedinRelDir(cycle));
  const selectionPath = resolve(getStringArg(argv, "selection") ?? join(cycleDir, "_internal", "ln-selection.json"));
  if (!existsSync(selectionPath)) {
    throw new Error(
      `Seleção semanal não encontrada: ${selectionPath}\n` +
        `Rode antes: npx tsx scripts/select-linkedin-weekly.ts --publish-monday AAMMDD`,
    );
  }
  const selection = JSON.parse(readFileSync(selectionPath, "utf8")) as CircleStackSelection & { pendingGroup?: unknown };
  if (Array.isArray(selection.pendingGroup) && selection.pendingGroup.length > 0) {
    throw new Error(`Seleção ${cycle} tem empate pendente (pendingGroup) — resolva com select-linkedin-weekly.ts --picks antes`);
  }

  const rendered = renderCircleStackPost(selection, {
    opening: readTextArg(argv, "opening-file"),
    closing: readTextArg(argv, "closing-file"),
    subscribeUrl: cfg.subscribeUrl ?? undefined,
  });

  const statusArg = getStringArg(argv, "status") as CirclePostStatus | undefined;
  if (statusArg && !VALID_STATUS.includes(statusArg)) throw new Error(`--status inválido: ${statusArg}`);
  const status = statusArg ?? cfg.status;

  mkdirSync(join(cycleDir, "_internal"), { recursive: true });
  const htmlPath = join(cycleDir, `circle-stack-${cycle}.html`);
  writeFileAtomic(htmlPath, rendered.html);

  const publish = hasFlag(argv, "publish");
  const postInput = {
    spaceId: cfg.spaceId ?? 0,
    name: rendered.title,
    html: rendered.html,
    status,
    userEmail: cfg.authorEmail ?? undefined,
    isCommentsEnabled: cfg.isCommentsEnabled,
    skipNotifications: cfg.skipNotifications,
  };

  if (!publish) {
    const preview = cfg.spaceId ? buildCreatePostPayload(postInput) : { ...postInput, spaceId: "(circle_stack.space_id não configurado)" };
    writeFileAtomic(join(cycleDir, "_internal", "circle-stack-payload.json"), JSON.stringify(preview, null, 2));
    console.log(`[dry-run] ${rendered.title}`);
    console.log(`[dry-run] HTML: ${htmlPath}`);
    console.log(`[dry-run] status que seria usado: ${status}. Passe --publish para criar o post.`);
    return;
  }

  if (!cfg.enabled) throw new Error("circle_stack.enabled = false — publicação desligada no config");
  if (!token) throw new Error(`${CIRCLE_STACK_TOKEN_ENV} ausente (Doppler/.env)`);
  if (!cfg.spaceId) throw new Error("circle_stack.space_id não configurado — rode --list-spaces e grave o id no platform.config.json");

  const statePath = join(cycleDir, "_internal", "circle-stack-published.json");
  if (existsSync(statePath) && !hasFlag(argv, "force")) {
    throw new Error(`Ciclo ${cycle} já publicado no Circle (${statePath}). Use --force para publicar de novo.`);
  }

  const result = await createCirclePost(client, postInput);
  writeFileAtomic(
    statePath,
    JSON.stringify(
      { cycle, post_id: result.id, url: result.url, status: result.status ?? status, title: rendered.title, created_at: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log(`Post criado no Circle: id=${result.id ?? "?"} status=${result.status ?? status} ${result.url ?? ""}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
