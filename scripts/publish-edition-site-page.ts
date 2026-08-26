#!/usr/bin/env node
/**
 * scripts/publish-edition-site-page.ts (#6202, fatia do #467)
 *
 * Publica a página da edição recém-agendada no Worker `diaria-site`.
 *
 * ## Por que existe
 *
 * O Worker já serve `/p/{slug}` para as 253 páginas do acervo (#6167), mas o
 * acervo é **estático**: sem este passo, as edições novas nunca entram, e o
 * site que o cutover vai colocar no apex nasce parado no tempo.
 *
 * O editor amarrou o greenlight da janela de cutover a este passo
 * (comentário de 26/08 no #467) — enquanto ele não roda, a janela não abre.
 *
 * ## Onde roda, e por que ali
 *
 * Etapa 6, **depois** do agendamento confirmado. Não antes: publicar a página
 * de uma edição que ainda pode mudar no gate criaria divergência entre o que
 * o leitor vê no site e o que recebe por e-mail.
 *
 * ## O slug vem de `--slug`, nunca de `post_url` sozinho (#6202 review, problema 1)
 *
 * `_internal/05-published.json` nunca tem `post_url` populado no momento em
 * que este passo roda no Stage 6 — Stage 5 grava `draft_url`/`post_id`,
 * `verify-scheduled-post.ts` grava `status`/`published_at`, e o único
 * escritor de `post_url` é `refresh-dedup.ts:autoStampPublishedJson()`, que
 * exige `post.published_at` no cache da Beehiiv — só disponível no dia
 * seguinte. Sem `--slug`, toda execução normal caía no "nada a publicar",
 * em silêncio, permanentemente.
 *
 * O dado já está na mão: §6d do orchestrator (que roda ANTES deste passo)
 * já busca `mcp__claude_ai_Beehiiv__get_post({ post_id })` →
 * `web_settings.slug` e, desde #4570, esse slug é GATE-BLOCKING (o guard do
 * bloco WhatsApp já para o Stage 6 se ele não bater) — então quando este
 * passo roda, o slug real já foi confirmado. §6d-site recebe esse MESMO
 * valor via `--slug`.
 *
 * `--slug` ausente ainda é suportado (invocação ad-hoc pós-`refresh-dedup`,
 * quando `post_url` já foi carimbado) — mas dentro do Stage 6 normal, sempre
 * passar `--slug`.
 *
 * ## Fail-soft, sempre
 *
 * Publicar no site é ACESSÓRIO ao envio. Nenhuma falha aqui pode derrubar a
 * edição — todos os caminhos ruins viram exit != 0 com motivo, e a Etapa 6
 * trata como warning. É a mesma disciplina do canal Brevo (#5772) e do canal
 * Kit (#6126).
 *
 * ## Mecanismo de publicação: commit + push, não `wrangler deploy` (#6202 review, problema 3)
 *
 * `.github/workflows/deploy-site.yml` documenta que `workers/site/public/p/**`
 * é COMMITADO no repo — o deploy real dispara por push a master tocando
 * `workers/site/**`, não por invocação local de `wrangler`. Publicar via
 * `wrangler deploy` local publicaria estado NÃO-commitado e faria o worker em
 * produção divergir do que está no repo, todo dia, sem sinal. Este script
 * escreve a página e, se não pedido `--skip-publish`, faz `git add` + `git
 * commit` + `git push` da pasta da página — nada mais. Fail-soft: falha de
 * commit/push nunca lança, vira `code: 3` com o motivo; a página já está
 * escrita (e, se o commit teve sucesso antes do push falhar, já commitada)
 * localmente — a próxima rodada/push manual a leva junto.
 *
 * ## Idempotência
 *
 * Escrever a mesma página duas vezes é inofensivo (mesmo conteúdo, mesmo
 * caminho). `commitAndPushSitePage` não gera commit vazio: se `git status
 * --porcelain` não acusar mudança no caminho da página, pula commit/push —
 * por isso `--skip-publish` existe pra quando só a escrita local importa, e o
 * resultado informa se algo mudou de fato (`published`).
 *
 * Exit codes:
 *   0 — página escrita (e publicada — commit+push — se pedido)
 *   1 — uso
 *   2 — pré-requisito AUSENTE: `_internal/newsletter-final.html` ou
 *       `_internal/05-published.json` ainda não existem. NÃO é erro, é "esta
 *       edição não tem o que publicar ainda".
 *   3 — falha ao escrever, comitar ou dar push
 *   4 — artefato PRESENTE porém inválido/inesperado (html vazio, título
 *       ausente, slug não-extraível de `post_url`, ou `post_url` ausente sem
 *       `--slug`) — diferente do `2`, isto é sintoma de bug num stage
 *       anterior e merece atenção, não silêncio.
 *
 * Uso:
 *   npx tsx scripts/publish-edition-site-page.ts --edition-dir data/editions/AAMMDD --slug o-slug-do-post
 *   npx tsx scripts/publish-edition-site-page.ts --edition-dir ... --slug ... --skip-publish
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { buildArchivePageHtml } from "./lib/site-archive-pages.ts";
import { buildEditionArchivePost, type EditionPageInputs } from "./lib/edition-site-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_PAGES_DIR = resolve(ROOT, "workers", "site", "public", "p");

/** Sinaliza "artefato PRESENTE mas com conteúdo inválido" — vira `code: 4`. */
export class EditionInputsInvalid extends Error {}

export interface PublishPageDeps {
  readEditionInputs(editionDir: string, slugOverride?: string): EditionPageInputs | null;
  writePage(slug: string, html: string): void;
  /** Commit + push (ou noop se nada mudou). Nunca é `wrangler deploy` — ver docstring do módulo. */
  publish(slug: string): void;
  log(line: string): void;
}

export type PublishPageResult =
  | { code: 0; slug: string; bytes: number; published: boolean }
  | { code: 2; reason: string }
  | { code: 3; reason: string }
  | { code: 4; reason: string };

/**
 * Lê os artefatos da edição.
 *
 * `slugOverride`, quando presente, DETERMINA o slug — não depende de
 * `post_url` estar populado em `05-published.json` (nunca está, no momento
 * em que o Stage 6 chama este passo — ver docstring do módulo). Sem
 * `slugOverride`, mantém o caminho antigo: lê `post_url` de
 * `05-published.json` (invocação ad-hoc pós-`refresh-dedup`).
 *
 * Retorna `null` só quando os ARQUIVOS estão ausentes (`code: 2`, benigno).
 * Lança `EditionInputsInvalid` quando os arquivos existem mas o conteúdo é
 * inválido/inesperado (`code: 4` — ex: sem `post_url` e sem `slugOverride`).
 */
export function readEditionInputs(editionDir: string, slugOverride?: string): EditionPageInputs | null {
  const htmlPath = join(editionDir, "_internal", "newsletter-final.html");
  const publishedPath = join(editionDir, "_internal", "05-published.json");
  if (!existsSync(htmlPath) || !existsSync(publishedPath)) return null;

  const published = JSON.parse(readFileSync(publishedPath, "utf8")) as {
    post_url?: string;
    scheduled_at?: string;
    published_at?: string;
  };

  let postUrl: string;
  if (slugOverride) {
    // URL sintética — só serve pra extractSlugFromPostUrl/web_url; a
    // convenção de domínio é a mesma usada em todo o resto do módulo
    // (ver EditionPageInputs em edition-site-page.ts).
    postUrl = `https://diar.ia.br/p/${slugOverride}`;
  } else if (published.post_url) {
    postUrl = published.post_url;
  } else {
    throw new EditionInputsInvalid(
      "05-published.json existe mas não tem post_url, e nenhum --slug foi passado — " +
        "no Stage 6 normal, §6d-site deve receber --slug com o valor confirmado via " +
        "get_post em §6d (o mesmo slug que o guard do bloco WhatsApp já verificou).",
    );
  }

  // Título/subtítulo saem do bloco TÍTULO/SUBTÍTULO do markdown revisado —
  // a mesma fonte que os publishers já usam pra assunto e preview.
  const reviewedPath = join(editionDir, "02-reviewed.md");
  let title = "";
  let subtitle: string | null = null;
  if (existsSync(reviewedPath)) {
    const md = readFileSync(reviewedPath, "utf8");
    title = extractBloco(md, "TÍTULO") ?? "";
    subtitle = extractBloco(md, "SUBTÍTULO");
  }

  return {
    html: readFileSync(htmlPath, "utf8"),
    postUrl,
    title,
    subtitle,
    publishedAtIso: published.published_at ?? published.scheduled_at ?? null,
  };
}

/** Primeira linha não-vazia após o rótulo — mesmo formato do #916. */
function extractBloco(md: string, rotulo: string): string | null {
  const linhas = md.split("\n");
  const i = linhas.findIndex((l) => l.trim() === rotulo);
  if (i === -1) return null;
  for (let j = i + 1; j < linhas.length; j++) {
    const v = linhas[j].trim();
    if (v) return v;
  }
  return null;
}

/** Roda `git`, síncrono, capturando stdout como string. Injetável pra teste. */
export type GitRunner = (args: string[], cwd: string) => string;

const defaultGitRunner: GitRunner = (args, cwd) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");

/**
 * `git add` + `git commit` + `git push` da pasta da página, sem commit
 * vazio: se `git status --porcelain` não acusar mudança no caminho depois do
 * `add`, o conteúdo já é idêntico ao commitado — pula commit/push (2ª
 * publicação da mesma edição é sempre um noop nesta camada, sem depender de
 * lógica própria pra comparar bytes).
 *
 * `git` injetado — não roda git de verdade fora de `productionDeps`.
 */
export function commitAndPushSitePage(
  rootDir: string,
  slug: string,
  git: GitRunner = defaultGitRunner,
): { changed: boolean } {
  const relPageDir = join("workers", "site", "public", "p", slug);
  git(["add", "--", relPageDir], rootDir);
  const status = git(["status", "--porcelain", "--", relPageDir], rootDir);
  if (!status.trim()) return { changed: false };
  git(
    ["commit", "-m", `chore(site): publica página da edição /p/${slug}\n\nRefs #6202`],
    rootDir,
  );
  git(["push"], rootDir);
  return { changed: true };
}

export function productionDeps(rootDir: string = ROOT): PublishPageDeps {
  return {
    readEditionInputs,
    writePage: (slug, html) => {
      const dir = join(resolve(rootDir, "workers", "site", "public", "p"), slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), html, "utf8");
    },
    publish: (slug) => {
      commitAndPushSitePage(rootDir, slug);
    },
    log: (line) => process.stderr.write(`[site-page] ${line}\n`),
  };
}

export function publishEditionSitePage(
  editionDir: string,
  deps: PublishPageDeps,
  opts: { skipPublish?: boolean; slug?: string } = {},
): PublishPageResult {
  let inputs: EditionPageInputs | null;
  try {
    inputs = deps.readEditionInputs(editionDir, opts.slug);
  } catch (e) {
    if (e instanceof EditionInputsInvalid) {
      return { code: 4, reason: e.message };
    }
    return { code: 3, reason: `artefatos da edição ilegíveis: ${(e as Error).message}` };
  }
  if (!inputs) {
    return { code: 2, reason: "edição sem newsletter-final.html ou sem 05-published.json — nada a publicar ainda" };
  }

  const built = buildEditionArchivePost(inputs);
  if (!built.ok) return { code: 4, reason: built.reason };

  let html: string;
  try {
    html = buildArchivePageHtml(built.post);
  } catch (e) {
    return { code: 3, reason: `render da página falhou: ${(e as Error).message}` };
  }

  try {
    deps.writePage(built.post.slug, html);
  } catch (e) {
    return { code: 3, reason: `escrita da página falhou: ${(e as Error).message}` };
  }
  deps.log(`página escrita: /p/${built.post.slug} (${html.length} bytes)`);

  if (opts.skipPublish) {
    deps.log("publicação pulada (--skip-publish) — a página só existe localmente.");
    return { code: 0, slug: built.post.slug, bytes: html.length, published: false };
  }

  try {
    deps.publish(built.post.slug);
  } catch (e) {
    // A página JÁ está escrita (e pode já estar commitada, se só o push
    // falhou) — a próxima rodada/push manual a leva junto. Por isso a
    // falha de publicação não invalida o trabalho, só adia.
    return { code: 3, reason: `commit/push falhou (a página ficou escrita localmente): ${(e as Error).message}` };
  }
  deps.log(`publicado — git commit+push ok, /p/${built.post.slug} entra no próximo deploy de workers/site`);
  return { code: 0, slug: built.post.slug, bytes: html.length, published: true };
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const editionDir = getArg(argv, "edition-dir");
  if (!editionDir) {
    console.error(
      "uso: npx tsx scripts/publish-edition-site-page.ts --edition-dir <dir> [--slug <slug>] [--skip-publish]",
    );
    process.exitCode = 1;
    return;
  }
  const slug = getArg(argv, "slug") || undefined;
  let result: PublishPageResult;
  try {
    result = publishEditionSitePage(resolve(ROOT, editionDir), productionDeps(), {
      skipPublish: hasFlag(argv, "skip-publish"),
      slug,
    });
  } catch (e) {
    result = { code: 3, reason: `erro inesperado: ${(e as Error).message}` };
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.code;
}

if (isMainModule(import.meta.url)) {
  await main();
}

export { SITE_PAGES_DIR };
