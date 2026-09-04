#!/usr/bin/env node
/**
 * scripts/kit-refresh-social-edition-url.ts (#7405)
 *
 * Fecha o gap achado ao vivo na edição 260904: com
 * `publishing.newsletter.backend === "kit"`, o Kit só atribui slug real ao
 * `public_url` do broadcast depois que ele sai do status `"draft"` de
 * verdade (agendado — `schedule-newsletter-kit.ts`, Stage 6, §6d-kit) —
 * `public: true` sozinho na Etapa 5 NÃO basta (medido ao vivo: broadcast
 * `status: "draft"` com `public: true` devolve `public_url` sem slug,
 * `https://{pub}.kit.com/posts/`). Isso quebra `{edition_url}` inline no
 * texto de Threads/X (únicos 2 canais sociais que precisam do link no corpo
 * do post — Facebook/LinkedIn/Instagram levam o link na imagem/legenda, não
 * inline), então esses 2 canais sempre falham na Etapa 5 quando o backend é
 * Kit, mesmo com `public: true` já setado.
 *
 * Rodar DEPOIS de `schedule-newsletter-kit.ts` confirmar o agendamento
 * (Stage 6, §6d-kit) — nesse ponto o Kit já deve ter atribuído o slug real
 * (confirmado ao vivo: toda edição enviada/agendada auditada teve slug
 * populado em minutos). Refetch do broadcast via API e, se o `public_url`
 * agora tem slug (não é mais o stub `.../posts/` vazio):
 *
 *   1. Grava `_internal/05-edition-url.txt` com a URL real — mesmo artefato
 *      que `resolve-edition-url.ts` grava pro caminho Beehiiv, consumido
 *      pelos mesmos publishers sociais.
 *   2. Reescreve `03-social.md` substituindo `{edition_url}` — reusa
 *      `substituteEditionUrl`/`findUnresolvedPlaceholders` de
 *      `scripts/lib/edition-url.ts` (mesma lógica de
 *      `resolve-edition-url.ts --validate-social`, não duplicada).
 *
 * Depois deste script (exit 0), o orchestrator (Stage 6 §6d-kit) re-dispatcha
 * `publish-threads.ts --schedule` — idempotente por design (`--skip-existing`
 * é o default: só pula entradas já `draft`/`scheduled`/`published`, uma
 * entrada `"failed"` da Etapa 5 não bloqueia o retry) — e a sessão faz o
 * mesmo pro X/Twitter via Buffer MCP (não scriptável — só alcançável de
 * dentro da sessão do agente, mesma nota de `.claude/agents/orchestrator-stage-5.md`
 * sobre o canal Twitter/X).
 *
 * Uso:
 *   npx tsx scripts/kit-refresh-social-edition-url.ts --edition-dir <dir>
 *
 * Exit codes:
 *   0 — backend não é "kit" (nada a fazer — caminho Beehiiv já resolve isso
 *       na Etapa 5 via `resolve-edition-url.ts`), OU `public_url` ainda sem
 *       slug (broadcast provavelmente ainda draft — normal logo após o
 *       `publish-newsletter-kit.ts` da Etapa 5, antes do Stage 6 agendar),
 *       OU já resolvida em invocação anterior para a MESMA URL (idempotente
 *       — não regrava/reescreve à toa). Consultar `resolved` no JSON de
 *       stdout pra distinguir "resolvida agora" de "nada a fazer".
 *   1 — uso/erro genérico (`--edition-dir` ausente)
 *   3 — `_internal/newsletter-kit-published.json` ausente ou sem
 *       `broadcast_id` (Etapa 5 não rodou o publisher Kit ainda)
 *   4 — GET `/broadcasts/{id}` falhou (erro de API/rede)
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { getBroadcast } from "./lib/kit-client.ts";
import { readPublishedState } from "./publish-newsletter-kit.ts";
import { substituteEditionUrl, findUnresolvedPlaceholders } from "./lib/edition-url.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface PlatformConfig {
  publishing?: { newsletter?: { backend?: string } };
}

export type KitRefreshSocialEditionUrlResult =
  | { ok: true; resolved: true; editionUrl: string; unresolvedPlaceholders: string[] }
  | { ok: true; resolved: false; reason: "backend_not_kit" | "no_slug_yet" | "already_resolved"; editionUrl?: string }
  | { ok: false; code: 3 | 4; reason: string };

/**
 * Pura o suficiente pra ser testável — `deps.readPublished`/`deps.getBroadcastPublicUrl`/
 * `deps.readEditionUrlFile`/`deps.writeEditionUrlFile`/`deps.readSocialMd`/
 * `deps.writeSocialMd` são injetáveis (nenhuma chamada de rede/I/O real em
 * teste). Mesmo padrão de `ScheduleNewsletterKitDeps`
 * (`schedule-newsletter-kit.ts`).
 */
export interface KitRefreshSocialEditionUrlDeps {
  readPublished: (editionDir: string) => { broadcast_id: number } | null;
  getBroadcastPublicUrl: (broadcastId: number) => Promise<string | undefined>;
  readEditionUrlFile: (editionDir: string) => string | null;
  writeEditionUrlFile: (editionDir: string, url: string) => void;
  readSocialMd: (editionDir: string) => string | null;
  writeSocialMd: (editionDir: string, content: string) => void;
}

/** Um `public_url` "resolvido" tem pelo menos um segmento de slug depois de
 * `/posts/` — o stub observado ao vivo (`https://{pub}.kit.com/posts/` ou
 * `.../posts`, sem barra) não tem. Extraída pra ser testável isoladamente. */
export function hasKitSlug(publicUrl: string | undefined): publicUrl is string {
  if (!publicUrl) return false;
  const match = publicUrl.match(/\/posts\/?([^/?#]*)/);
  return !!match && match[1].length > 0;
}

export async function kitRefreshSocialEditionUrl(
  editionDir: string,
  deps: KitRefreshSocialEditionUrlDeps,
): Promise<KitRefreshSocialEditionUrlResult> {
  const published = deps.readPublished(editionDir);
  if (!published || typeof published.broadcast_id !== "number") {
    return {
      ok: false,
      code: 3,
      reason:
        "_internal/newsletter-kit-published.json ausente ou sem broadcast_id — " +
        "Etapa 5 não rodou o publisher Kit pra esta edição ainda.",
    };
  }

  let publicUrl: string | undefined;
  try {
    publicUrl = await deps.getBroadcastPublicUrl(published.broadcast_id);
  } catch (e) {
    return {
      ok: false,
      code: 4,
      reason: `GET /broadcasts/${published.broadcast_id} falhou: ${(e as Error).message}`,
    };
  }

  if (!hasKitSlug(publicUrl)) {
    return { ok: true, resolved: false, reason: "no_slug_yet" };
  }

  // Idempotência: já resolvida pra essa MESMA URL em invocação anterior —
  // não regrava/reescreve à toa (o arquivo pode ter sido tocado por outra
  // etapa entre chamadas; comparar em vez de assumir).
  const existing = deps.readEditionUrlFile(editionDir);
  if (existing === publicUrl) {
    return { ok: true, resolved: false, reason: "already_resolved", editionUrl: publicUrl };
  }

  deps.writeEditionUrlFile(editionDir, publicUrl);

  const socialMd = deps.readSocialMd(editionDir);
  let unresolvedPlaceholders: string[] = [];
  if (socialMd !== null) {
    const substituted = substituteEditionUrl(socialMd, publicUrl);
    if (substituted !== socialMd) {
      deps.writeSocialMd(editionDir, substituted);
    }
    unresolvedPlaceholders = findUnresolvedPlaceholders(substituted);
  }

  return { ok: true, resolved: true, editionUrl: publicUrl, unresolvedPlaceholders };
}

export function productionDeps(): KitRefreshSocialEditionUrlDeps {
  return {
    readPublished: (editionDir) => readPublishedState(editionDir),
    getBroadcastPublicUrl: async (broadcastId) => {
      const broadcast = await getBroadcast(broadcastId);
      return broadcast.public_url;
    },
    readEditionUrlFile: (editionDir) => {
      const path = resolve(editionDir, "_internal", "05-edition-url.txt");
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    },
    writeEditionUrlFile: (editionDir, url) => {
      const path = resolve(editionDir, "_internal", "05-edition-url.txt");
      writeFileAtomic(path, url, { encoding: "utf8" });
    },
    readSocialMd: (editionDir) => {
      const path = resolve(editionDir, "03-social.md");
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    },
    writeSocialMd: (editionDir, content) => {
      const path = resolve(editionDir, "03-social.md");
      writeFileAtomic(path, content, { encoding: "utf8" });
    },
  };
}

export async function main(rootDirOverride?: string): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const editionDirArg = getStringArg(argv, "edition-dir");
  if (!editionDirArg) {
    process.stderr.write("uso: npx tsx scripts/kit-refresh-social-edition-url.ts --edition-dir <dir>\n");
    process.exitCode = 1;
    return;
  }

  const platformConfig = JSON.parse(
    readFileSync(resolve(rootDir, "platform.config.json"), "utf8"),
  ) as PlatformConfig;
  const backend = platformConfig.publishing?.newsletter?.backend ?? "beehiiv";
  if (backend !== "kit") {
    console.log(JSON.stringify({ ok: true, resolved: false, reason: "backend_not_kit" }));
    process.exitCode = 0;
    return;
  }

  const editionDir = resolve(editionDirArg);
  const result = await kitRefreshSocialEditionUrl(editionDir, productionDeps());
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : result.code;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(
      `[kit-refresh-social-edition-url] erro fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`,
    );
    process.exitCode = 1;
  });
}
