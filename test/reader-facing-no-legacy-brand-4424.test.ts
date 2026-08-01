/**
 * test/reader-facing-no-legacy-brand-4424.test.ts (#4424)
 *
 * Guard anti-regressão: a marca se chama `diar.ia.br` (sempre minúsculo,
 * inclusive início de frase/título — decisão do editor 260801), nunca
 * `Diar.ia`. #4424 encontrou 892 ocorrências da forma velha em 341 arquivos e
 * corrigiu a Fatia 1 (superfície do leitor — o que um assinante/visitante lê:
 * workers públicos, `context/templates/`, `context/publishers/`, os agentes de
 * escrita/copy, e os módulos `scripts/lib/` que geram esse texto). Fatias 2
 * (superfície do editor: Studio, dashboards) e 3 (interno: comentários soltos,
 * docs, CLAUDE.md) ficam pra rodadas futuras — este guard cobre só a Fatia 1,
 * gate de repo mesmo lugar dos outros gates transversais (`knip-clean.test.ts`,
 * `lib-boundary.test.ts`).
 *
 * Escopo estático (grep de conteúdo, não comportamental): a lista de arquivos
 * abaixo É a Fatia 1 tal como fechada no PR #4424 — arquivo novo que deveria
 * entrar na Fatia 1 precisa ser adicionado aqui manualmente (mesmo padrão do
 * `lib-boundary.test.ts`: a fronteira é curada, não inferida).
 *
 * Exceções deliberadas (NÃO cobertas por este guard, ver corpo do PR #4424):
 *   - `context/publishers/linkedin.md` e `context/publishers/facebook.md`:
 *     o texto "Diar.ia"/"página Diar.ia" ali referencia o NOME REAL configurado
 *     hoje na LinkedIn Company Page / Facebook Page (ativo externo, fora do
 *     repo) que o playbook de browser automation usa pra SELECIONAR a página
 *     certa por texto visível — não é copy nossa. Renomear só o texto do doc
 *     sem renomear o ativo de verdade faria o agente procurar por
 *     "diar.ia.br" numa UI que ainda mostra "Diar.ia" e falhar a seleção
 *     (ou, pior, publicar no contexto errado). Corrigir isso é ação externa
 *     do editor (renomear a Page), não deste PR — mesma categoria do "Sender
 *     name / og:title fora do repo" já listado como exceção no corpo do #4424.
 *   - `context/publishers/beehiiv-playbook.md` linha ~298 ("Selecionar
 *     workspace Diar.ia se houver seletor"): mesma categoria — nome do
 *     workspace Beehiiv configurado hoje, usado pra seleção visual na UI.
 *   - `test/__snapshots__/ds-golden-full-render.snap.json`: regenerado via
 *     `NODE_TEST_SNAPSHOTS=1 npx tsx --test test/ds-golden-full-render.test.ts`,
 *     nunca editado à mão — não faz sentido um guard estático aqui (o próprio
 *     teste de snapshot já falha se o HTML gerado divergir).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const LEGACY_BRAND_RE = /Diar\.ia/;

/** Arquivos individuais da Fatia 1 (fora de diretório varrido por inteiro abaixo). */
const PROTECTED_FILES: string[] = [
  // Workers públicos — cada um listado individualmente (não o worker inteiro:
  // arquivos *.generated.ts / titles-cache.json / wrangler.toml / README.md
  // ficam de fora de propósito — comentário de build tool ou dado histórico
  // publicado, não copy nova, ver corpo do #4424).
  "workers/livros/public/index.html",
  "workers/cursos/public/index.html",
  "workers/cursos/src/gate-page.ts",
  "workers/cursos/src/courses-full.generated.ts",
  "workers/arquivo/src/index.ts",
  "workers/arquivo/src/render-archive.ts",
  "workers/artigo-mensal/src/render.ts",
  "workers/draft/src/index.ts",
  "workers/artigos/public/2026/o-agente/index.html",
  "workers/poll/src/jogar.ts",
  "workers/poll/src/lib.ts",
  "workers/poll/src/web-gate.ts",
  "workers/poll/src/share.ts",
  "workers/poll/src/leaderboard-routes.ts",
  "workers/poll/src/vote.ts",
  "workers/poll/src/index.ts",
  "workers/poll/src/embed.ts",
  "workers/poll/src/magic-link.ts",
  "workers/poll/src/identify.ts",

  // context/ curado (docs gerais + os que a issue #4424 nomeou explicitamente).
  "context/editorial-rules.md",
  "context/invariants.md",
  "context/audience-profile.md",
  "context/sources.md",

  // scripts/lib/ que geram o texto acima (a fonte de verdade das strings,
  // não só o output já renderizado).
  "scripts/lib/newsletter-render-html.ts",
  "scripts/lib/social-cta-lines.ts",
  "scripts/lib/editor-copy.ts",
  "scripts/lib/shared/curadoria-page.ts",
  "scripts/lib/shared/seo-meta.ts",
  "scripts/lib/mensal/monthly-render.ts",
  "scripts/build-cursos-page.ts",
  "scripts/build-livros-page.ts",
  "scripts/sync-coverage-line.ts",
  "scripts/overnight-statusline.ts",
];

/** Diretórios varridos por inteiro (todo .md/.html dentro conta). */
const PROTECTED_DIRS: string[] = ["context/templates"];

/**
 * `context/publishers/` varrido por inteiro MENOS os arquivos que referenciam
 * nome de ativo externo (LinkedIn Page / Facebook Page / Beehiiv workspace) —
 * ver exceções documentadas no header do módulo.
 */
const PUBLISHERS_DIR = "context/publishers";
const PUBLISHERS_EXCEPTIONS = new Set(["linkedin.md", "facebook.md", "beehiiv-playbook.md"]);

/**
 * `.claude/agents/` — só os agentes de ESCRITA/copy (#4424: "trocar o prompt
 * dos agentes de copy é o que impede a marca errada de voltar a ser GERADA em
 * toda edição nova"). Prefixos/nomes exatos espelham a lista da issue.
 */
const AGENTS_DIR = ".claude/agents";
function isCopyAgent(filename: string): boolean {
  return (
    filename.startsWith("writer") ||
    filename.startsWith("social-") ||
    filename === "title-picker.md" ||
    filename === "fact-checker.md" ||
    filename === "analyst-monthly.md" ||
    filename.startsWith("scorer")
  );
}

function mdOrHtmlOrTs(filename: string): boolean {
  return filename.endsWith(".md") || filename.endsWith(".html") || filename.endsWith(".ts");
}

function filesUnder(dir: string, filter: (name: string) => boolean): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => filter(f) && statSync(join(abs, f)).isFile())
    .map((f) => join(dir, f));
}

function collectViolations(relFiles: string[]): string[] {
  const found: string[] = [];
  for (const rel of relFiles) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      found.push(`${rel} — arquivo não encontrado (a lista curada ficou desatualizada?)`);
      continue;
    }
    const content = readFileSync(abs, "utf8");
    const m = content.match(LEGACY_BRAND_RE);
    if (m) {
      const line = content.slice(0, m.index).split("\n").length;
      found.push(`${rel}:${line} — "Diar.ia" encontrado (use "diar.ia.br")`);
    }
  }
  return found;
}

describe("Fatia 1 (#4424) — sem a grafia antiga 'Diar.ia' na superfície do leitor", () => {
  it("arquivos individuais protegidos (workers públicos + scripts/lib geradores)", () => {
    const v = collectViolations(PROTECTED_FILES);
    assert.deepEqual(v, [], `Grafia antiga da marca encontrada:\n  ${v.join("\n  ")}`);
  });

  it("context/templates/ (varrido por inteiro)", () => {
    const files = PROTECTED_DIRS.flatMap((d) => filesUnder(d, mdOrHtmlOrTs));
    assert.ok(files.length > 0, "sanity: context/templates/ deve ter pelo menos 1 arquivo .md");
    const v = collectViolations(files);
    assert.deepEqual(v, [], `Grafia antiga da marca encontrada:\n  ${v.join("\n  ")}`);
  });

  it("context/publishers/ (varrido por inteiro, exceto linkedin.md/facebook.md/beehiiv-playbook.md — nome de ativo externo, ver header do módulo)", () => {
    const files = filesUnder(PUBLISHERS_DIR, mdOrHtmlOrTs).filter(
      (rel) => !PUBLISHERS_EXCEPTIONS.has(rel.slice(PUBLISHERS_DIR.length + 1)),
    );
    assert.ok(files.length > 0, "sanity: context/publishers/ deve ter pelo menos 1 arquivo além das exceções");
    const v = collectViolations(files);
    assert.deepEqual(v, [], `Grafia antiga da marca encontrada:\n  ${v.join("\n  ")}`);
  });

  it("agentes de escrita/copy em .claude/agents/ (writer*, social-*, title-picker, fact-checker, analyst-monthly, scorer*)", () => {
    const files = filesUnder(AGENTS_DIR, (f) => f.endsWith(".md") && isCopyAgent(f));
    assert.ok(files.length >= 10, `sanity: esperava >=10 agentes de copy, achou ${files.length}`);
    const v = collectViolations(files);
    assert.deepEqual(v, [], `Grafia antiga da marca encontrada:\n  ${v.join("\n  ")}`);
  });

  it("sanity: as exceções documentadas ainda existem e ainda contêm a forma antiga (senão a exceção virou obsoleta e deve sair da allowlist)", () => {
    for (const filename of PUBLISHERS_EXCEPTIONS) {
      const abs = join(ROOT, PUBLISHERS_DIR, filename);
      assert.ok(existsSync(abs), `exceção ${filename} não existe mais — remover da allowlist`);
      const content = readFileSync(abs, "utf8");
      assert.ok(
        LEGACY_BRAND_RE.test(content),
        `${filename} não tem mais "Diar.ia" — a exceção acabou; remover de PUBLISHERS_EXCEPTIONS pra esse arquivo voltar a ser coberto pelo guard`,
      );
    }
  });
});
