/**
 * #10766 — o "É IA?" não é mais publicado nas redes (LinkedIn, Facebook,
 * Instagram, Threads, X). Segue só na newsletter (bloco, crédito, poll, link
 * "Jogar É IA?", sorteio).
 *
 * O `/diaria-5-publicacao` já não o despachava desde o #6169 e a seção
 * `## eia` saiu de `03-social.md` no #7678. O que sobrava era o dispatch
 * avulso (`gen-eia-linkedin-cards.ts` + `publish-eia-social.ts`, lendo
 * `01-eia-social.md`) e o namespace `eia-{AAMMDD}` aceito pela fila do Worker
 * `diaria-linkedin-cron`. Este teste trava os quatro pontos para o caminho
 * não voltar sem uma decisão editorial nova.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Lido do FONTE do Worker (mesmo padrão de test/use-melhor-dispatch-9568.test.ts:
// importar o Worker vaza os tipos do Cloudflare pro typecheck de test/**).
const QUEUE_DESTAQUE_RE: RegExp = (() => {
  const src = readFileSync(resolve(ROOT, "workers/linkedin-cron/src/index.ts"), "utf8");
  const m = src.match(/export const QUEUE_DESTAQUE_RE = \/(.+)\/;/);
  if (!m) throw new Error("QUEUE_DESTAQUE_RE não encontrado em workers/linkedin-cron/src/index.ts");
  return new RegExp(m[1]);
})();

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
    else if (/\.(ts|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe("#10766 — É IA? fora das redes sociais", () => {
  it("os scripts do dispatch avulso não existem mais", () => {
    for (const rel of [
      "scripts/publish-eia-social.ts",
      "scripts/gen-eia-linkedin-cards.ts",
      "scripts/lib/eia-linkedin-card.ts",
    ]) {
      assert.equal(existsSync(resolve(ROOT, rel)), false, `${rel} voltou — o É IA? não sai nas redes (#10766)`);
    }
  });

  it("a fila do Worker recusa destaque eia-{AAMMDD} e segue aceitando os demais", () => {
    for (const d of ["eia-261022", "eia-260826"]) {
      assert.equal(QUEUE_DESTAQUE_RE.test(d), false, `${d} deveria ser recusado no enqueue`);
    }
    for (const d of ["d1", "d2", "d3", "um", "weekly", "weekly-clicked", "especial-retrospectiva"]) {
      assert.ok(QUEUE_DESTAQUE_RE.test(d), `${d} deveria seguir aceito`);
    }
  });

  it("nenhum script lê os artefatos do post social do É IA?", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(resolve(ROOT, "scripts"))) {
      const src = readFileSync(file, "utf8");
      if (/01-eia-social\.md|eia-social-published\.json|01-eia-linkedin-/.test(src)) offenders.push(file);
    }
    assert.deepEqual(offenders, []);
  });

  it("os publicadores sociais diários não tocam nos arquivos do É IA?", () => {
    for (const rel of [
      "scripts/publish-linkedin.ts",
      "scripts/publish-facebook.ts",
      "scripts/publish-instagram.ts",
      "scripts/publish-threads.ts",
      "scripts/prep-twitter-posts.ts",
    ]) {
      const src = readFileSync(resolve(ROOT, rel), "utf8");
      assert.doesNotMatch(src, /01-eia/, `${rel} referencia arquivo do É IA?`);
    }
  });
});
