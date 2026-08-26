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
 * ## Fail-soft, sempre
 *
 * Publicar no site é ACESSÓRIO ao envio. Nenhuma falha aqui pode derrubar a
 * edição — todos os caminhos ruins viram exit != 0 com motivo, e a Etapa 6
 * trata como warning. É a mesma disciplina do canal Brevo (#5772) e do canal
 * Kit (#6126).
 *
 * ## Idempotência
 *
 * Escrever a mesma página duas vezes é inofensivo (mesmo conteúdo, mesmo
 * caminho). O deploy é que custa — por isso `--skip-deploy` existe e o
 * resultado informa se algo mudou de fato.
 *
 * Exit codes:
 *   0 — página escrita (e deploy feito, se pedido)
 *   1 — uso
 *   2 — pré-requisito ausente (edição sem HTML final / sem post_url): NÃO é
 *       erro, é "esta edição não tem o que publicar ainda"
 *   3 — falha ao escrever ou ao deployar
 *
 * Uso:
 *   npx tsx scripts/publish-edition-site-page.ts --edition-dir data/editions/AAMMDD
 *   npx tsx scripts/publish-edition-site-page.ts --edition-dir ... --skip-deploy
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

export interface PublishPageDeps {
  readEditionInputs(editionDir: string): EditionPageInputs | null;
  writePage(slug: string, html: string): void;
  deploy(): void;
  log(line: string): void;
}

export type PublishPageResult =
  | { code: 0; slug: string; bytes: number; deployed: boolean }
  | { code: 2; reason: string }
  | { code: 3; reason: string };

/** Lê os artefatos da edição. `null` quando a edição não tem o que publicar. */
export function readEditionInputs(editionDir: string): EditionPageInputs | null {
  const htmlPath = join(editionDir, "_internal", "newsletter-final.html");
  const publishedPath = join(editionDir, "_internal", "05-published.json");
  if (!existsSync(htmlPath) || !existsSync(publishedPath)) return null;

  const published = JSON.parse(readFileSync(publishedPath, "utf8")) as {
    post_url?: string;
    scheduled_at?: string;
    published_at?: string;
  };
  const postUrl = published.post_url;
  if (!postUrl) return null;

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

export function productionDeps(rootDir: string = ROOT): PublishPageDeps {
  return {
    readEditionInputs,
    writePage: (slug, html) => {
      const dir = join(resolve(rootDir, "workers", "site", "public", "p"), slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "index.html"), html, "utf8");
    },
    deploy: () => {
      execFileSync("npx", ["wrangler", "deploy"], {
        cwd: resolve(rootDir, "workers", "site"),
        stdio: "pipe",
      });
    },
    log: (line) => process.stderr.write(`[site-page] ${line}\n`),
  };
}

export function publishEditionSitePage(
  editionDir: string,
  deps: PublishPageDeps,
  opts: { skipDeploy?: boolean } = {},
): PublishPageResult {
  let inputs: EditionPageInputs | null;
  try {
    inputs = deps.readEditionInputs(editionDir);
  } catch (e) {
    return { code: 3, reason: `artefatos da edição ilegíveis: ${(e as Error).message}` };
  }
  if (!inputs) {
    return { code: 2, reason: "edição sem newsletter-final.html ou sem post_url — nada a publicar ainda" };
  }

  const built = buildEditionArchivePost(inputs);
  if (!built.ok) return { code: 2, reason: built.reason };

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

  if (opts.skipDeploy) {
    deps.log("deploy pulado (--skip-deploy) — a página só existe localmente.");
    return { code: 0, slug: built.post.slug, bytes: html.length, deployed: false };
  }

  try {
    deps.deploy();
  } catch (e) {
    // A página JÁ está escrita — a próxima regeneração/deploy a leva junto.
    // Por isso deploy falho não invalida o trabalho, só adia a publicação.
    return { code: 3, reason: `deploy falhou (a página ficou escrita localmente): ${(e as Error).message}` };
  }
  deps.log(`deploy ok — https://diaria-site.diaria.workers.dev/p/${built.post.slug}`);
  return { code: 0, slug: built.post.slug, bytes: html.length, deployed: true };
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const editionDir = getArg(argv, "edition-dir");
  if (!editionDir) {
    console.error("uso: npx tsx scripts/publish-edition-site-page.ts --edition-dir <dir> [--skip-deploy]");
    process.exitCode = 1;
    return;
  }
  let result: PublishPageResult;
  try {
    result = publishEditionSitePage(resolve(ROOT, editionDir), productionDeps(), {
      skipDeploy: hasFlag(argv, "skip-deploy"),
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
