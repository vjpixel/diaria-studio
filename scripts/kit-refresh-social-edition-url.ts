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
 *   2. Reescreve `03-social.md`. Achado do code-reviewer (#7405): a Etapa 5
 *      (§5c-2 de `orchestrator-stage-5.md`) já roda
 *      `resolve-edition-url.ts --validate-social` ANTES do Stage 6 —
 *      `{edition_url}` já não existe mais como placeholder literal em
 *      `03-social.md` nesse ponto, foi substituído pelo valor que
 *      `05-edition-url.txt` tinha na Etapa 5 (o stub Kit sem slug). Por
 *      isso este passo cobre os DOIS casos: (a) placeholder `{edition_url}`
 *      ainda literal (via `substituteEditionUrl`, mesma lógica de
 *      `resolve-edition-url.ts --validate-social`, não duplicada) — cobre
 *      resume/edge cases onde a Etapa 5 não chegou a rodar o guard; (b) o
 *      stub ANTIGO já embutido no texto (caso real observado) — replace
 *      direto da string antiga (lida de `05-edition-url.txt` ANTES de
 *      sobrescrever) pela nova.
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
 * Guard anti-placeholder não-fatal (mesmo desenho do #3277 em
 * `resolve-edition-url.ts`): se sobrar algum `{placeholder}` em `03-social.md`
 * mesmo APÓS a substituição de `{edition_url}`, este script avisa (stderr +
 * `data/run-log.jsonl` via `logEvent`, nível warn) mas NÃO bloqueia — pode
 * ser um bug real (writer/stitch esqueceu de resolver um campo) ou prosa
 * legítima citando um exemplo entre chaves. `unresolvedPlaceholders` no JSON
 * de saída também carrega essa lista pra quem consumir o resultado
 * programaticamente.
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
 *   3 — `_internal/newsletter-kit-published.json` ausente/sem `broadcast_id`,
 *       OU falha ao ler esse arquivo (JSON corrompido/parcialmente escrito —
 *       `readPublishedState` não tem try/catch próprio; capturado aqui pra
 *       nunca propagar como exceção não-tratada)
 *   4 — GET `/broadcasts/{id}` falhou (erro de API/rede)
 */
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, isMainModule } from "./lib/cli-args.ts";
import { getBroadcast } from "./lib/kit-client.ts";
import { readPublishedState } from "./publish-newsletter-kit.ts";
import {
  substituteEditionUrl,
  findUnresolvedPlaceholders,
  PLACEHOLDER_GUARD_LOG_MESSAGE_PREFIX,
} from "./lib/edition-url.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { logEvent } from "./lib/run-log.ts";

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
  let published: { broadcast_id: number } | null;
  try {
    published = deps.readPublished(editionDir);
  } catch (e) {
    // #7405 finding do silent-failure-hunter: readPublishedState faz
    // JSON.parse(readFileSync(...)) sem try/catch próprio — um arquivo
    // corrompido/parcialmente escrito lançaria aqui sem tratamento,
    // propagando como exceção não-capturada até o `.catch` de main() (exit 1,
    // sem JSON estruturado). Capturar aqui devolve o mesmo contrato {ok,code,reason}
    // que todo consumidor deste script já espera.
    return {
      ok: false,
      code: 3,
      reason: `Falha lendo _internal/newsletter-kit-published.json: ${(e as Error).message}`,
    };
  }
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
  // etapa entre chamadas; comparar em vez de assumir). Lida ANTES de
  // sobrescrever — é o valor ANTIGO (`previousEditionUrl`) que o passo
  // abaixo precisa pra corrigir `03-social.md`.
  const previousEditionUrl = deps.readEditionUrlFile(editionDir);
  if (previousEditionUrl === publicUrl) {
    return { ok: true, resolved: false, reason: "already_resolved", editionUrl: publicUrl };
  }

  // #7405 achado do code-reviewer (crash-safety): `03-social.md` é escrito
  // ANTES de `05-edition-url.txt` de propósito — é a leitura DESTE último
  // (linha acima) que decide `already_resolved` na próxima invocação. Se o
  // processo morrer (crash/OOM/kill) entre os dois writes na ordem inversa,
  // uma chamada seguinte veria `05-edition-url.txt` já com a URL nova,
  // tomaria o atalho `already_resolved` e NUNCA chegaria a corrigir
  // `03-social.md` — bug permanente e silencioso. Nesta ordem, o pior caso
  // de interrupção é reescrever `03-social.md` de novo na próxima chamada
  // (idempotente: `updated !== socialMd` vira `false` na 2ª vez) antes de
  // finalmente gravar `05-edition-url.txt` — sempre convergente, nunca
  // travado num estado parcial.
  const socialMd = deps.readSocialMd(editionDir);
  let unresolvedPlaceholders: string[] = [];
  if (socialMd !== null) {
    // No fluxo real, `03-social.md` chega aqui SEM o placeholder literal
    // `{edition_url}` — o guard §5c-2 da Etapa 5
    // (`resolve-edition-url.ts --validate-social`) já rodou e substituiu
    // `{edition_url}` pelo valor que `05-edition-url.txt` tinha NAQUELE
    // momento, que pro backend Kit é o stub sem slug (`.../posts/`).
    // `substituteEditionUrl` sozinho (busca só o placeholder `{edition_url}`)
    // é um no-op nesse caso — o texto errado ficaria gravado pra sempre sem
    // este 2º passo. Corrigir os DOIS casos: (a) o stub ANTIGO já embutido
    // no texto (caso real) via replace direto da string —
    // `previousEditionUrl` é exatamente o valor que o guard usou pra
    // substituir da última vez; (b) placeholder `{edition_url}` ainda
    // literal (edição nunca passou pelo guard da Etapa 5, ou resume
    // incomum) via `substituteEditionUrl`.
    //
    // ORDEM importa (achado do code-reviewer, 2ª rodada): (a) precisa rodar
    // ANTES de (b). Como o stub Kit é sempre PREFIXO da URL resolvida
    // (`.../posts/` → `.../posts/{slug}`), se (b) rodasse primeiro ela
    // insere `publicUrl` no texto — que contém `previousEditionUrl` como
    // substring própria — e (a) rodando DEPOIS re-escanearia esse trecho
    // recém-inserido, duplicando o slug
    // (`.../posts/{slug}{slug}`). Rodar (a) primeiro elimina toda ocorrência
    // do stub ANTES de `publicUrl` entrar no texto, então (b) nunca tem
    // conteúdo novo pra re-corromper.
    let updated = socialMd;
    if (previousEditionUrl && previousEditionUrl !== publicUrl) {
      updated = updated.split(previousEditionUrl).join(publicUrl);
    }
    updated = substituteEditionUrl(updated, publicUrl);
    if (updated !== socialMd) {
      deps.writeSocialMd(editionDir, updated);
    }
    unresolvedPlaceholders = findUnresolvedPlaceholders(updated);
  }

  deps.writeEditionUrlFile(editionDir, publicUrl);

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

/**
 * #7405 finding do silent-failure-hunter: `unresolvedPlaceholders` era
 * calculado e devolvido no JSON, mas nada avisava sobre ele — a mesma classe
 * de risco que o guard #3277 existe pra cobrir (post social publicado com
 * `{placeholder}` literal, sem trilha de log apontando pra causa). Extraído
 * pra ser testável sem precisar spawnar o CLI inteiro — mesmo padrão de
 * `warnUnresolvedPlaceholders` em `resolve-edition-url.ts` (não importado
 * direto dali pra manter os dois scripts independentes; mesma mensagem/nível
 * de log, então `/diaria-log {edition} warn` encontra os dois).
 */
export function warnUnresolvedPlaceholders(
  unresolved: string[],
  editionId: string | null,
  editionUrl: string,
  socialMdPath: string,
  rootDir?: string,
): void {
  const logHint = editionId
    ? `\`/diaria-log ${editionId} warn\``
    : `\`/diaria-log\` filtrando por agent "kit-refresh-social-edition-url" (edição não detectada a partir de --edition-dir)`;
  console.warn(`AVISO (#3277/#7405 guard anti-placeholder — não-fatal): 03-social.md contém possíveis placeholders não-resolvidos mesmo APÓS a substituição de {edition_url}:
  ${unresolved.join(", ")}

O retry social do Stage 6 (Threads/X) NÃO foi bloqueado — isso pode ser um bug real (writer/stitch
esqueceu de resolver um placeholder) OU prosa legítima citando um exemplo de prompt/campo de API entre
chaves. Revisão humana recomendada antes do post sair — ver ${logHint}.
  → {edition_url} já foi substituído por este script (gravado: ${editionUrl}).`);
  logEvent(
    {
      edition: editionId,
      stage: 6,
      agent: "kit-refresh-social-edition-url",
      level: "warn",
      message: `${PLACEHOLDER_GUARD_LOG_MESSAGE_PREFIX}: placeholder(s) não-resolvido(s) em 03-social.md após refresh do edition_url Kit — revisão humana recomendada`,
      details: { unresolved, edition_url: editionUrl, social_md_path: socialMdPath },
    },
    rootDir,
  );
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

  if (result.ok && result.resolved && result.unresolvedPlaceholders.length > 0) {
    const editionId = basename(editionDir).match(/^\d{6}/)?.[0] ?? null;
    const socialMdPath = resolve(editionDir, "03-social.md");
    warnUnresolvedPlaceholders(result.unresolvedPlaceholders, editionId, result.editionUrl, socialMdPath, rootDir);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(
      `[kit-refresh-social-edition-url] erro fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`,
    );
    process.exitCode = 1;
  });
}
