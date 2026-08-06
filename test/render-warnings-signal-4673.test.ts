/**
 * test/render-warnings-signal-4673.test.ts (#4673, regressão #633)
 *
 * Cobertura de PONTA-A-PONTA (subprocess real via spawnSync, mesmo padrão de
 * test/render-newsletter-html-cli-esp-4266.test.ts) do sinal persistido que o
 * CLI `render-newsletter-html.ts` agora grava em `_internal/render-warnings.json`
 * a cada chamada de `renderHTML()` — o pedaço que os testes de lib
 * (test/render-newsletter-html.test.ts, test/whatsapp-share-4486.test.ts)
 * não cobrem, porque eles chamam `renderHTML`/`getRenderWarnings` direto, sem
 * passar pelo CLI real nem pelo write em disco.
 *
 * Critério de pronto da issue:
 *   - caixa de divulgação sem lacuna → sinal consumível (não só stderr).
 *   - WhatsApp sem D1 → idem (coberto em teste de lib, whatsapp-share-4486;
 *     não reproduzido aqui porque uma edição sem D1 quebra outros invariantes
 *     do parser antes de chegar em renderHTML — cenário "nunca deveria
 *     acontecer" mesmo no nível do CLI).
 *   - edição normal (nada perdido) → não produz ruído (arquivo escrito com
 *     `warnings: []`, nunca ausente — sempre fresco, nunca stale).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(PROJECT_ROOT, "scripts", "render-newsletter-html.ts");

function d(n: number, cat: string, url: string): string {
  return `**DESTAQUE ${n} | ${cat}**

**[Título D${n}](${url})**

Corpo do destaque ${n} com contexto suficiente pra render.

Por que isso importa:

Why do D${n}.
`;
}

/**
 * Edição de 3 destaques + até 3 caixas de divulgação (slot1 entre D1/D2,
 * slot2 entre D2/D3, slot3 após D3) — mesmo esqueleto de
 * test/box-divulgacao-marker-agnostic.test.ts. Com D1 presente, o bloco
 * WhatsApp (permanente, #4570) ocupa a lacuna D1/D2; com as 3 caixas
 * presentes, sobram só 2 lacunas livres pras 3 caixas (mesmo cenário
 * exercitado por `fixt3()` em test/render-newsletter-html.test.ts) — o slot 3
 * fica sem lacuna e é dropped.
 */
function buildReviewed(boxes: { box1?: string | null; box2?: string | null; box3?: string | null }): string {
  const { box1 = null, box2 = null, box3 = null } = boxes;
  const sep = (block: string | null) => (block ? `${block}\n\n---\n\n` : "");
  return `Para esta edição, selecionamos 12 itens.

---

${d(1, "🚀 LANÇAMENTO", "https://example.com/d1")}

---

${sep(box1)}${d(2, "💼 MERCADO", "https://example.com/d2")}

---

${sep(box2)}${d(3, "💼 TRABALHO", "https://example.com/d3")}

---

${box3 ?? ""}
`;
}

const BOX1 = "📚 Confira nossa curadoria. [Link](https://example.com/box1).";
const BOX2 = "📚 Confira nossos livros. [Link](https://example.com/box2).";
const BOX3 = "🔧 Apoie a curadoria. [Link](https://example.com/box3).";

/** Mesmo padrão de makeEditionDir() em render-newsletter-html-cli-esp-4266.test.ts
 * — subpasta "260999" pra que `content.eia.edition` (extraído do NOME do
 * diretório) não fique vazio. */
function makeEditionDir(reviewed: string): string {
  const base = mkdtempSync(join(tmpdir(), "diaria-render-warnings-"));
  const dir = join(base, "260999");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), reviewed, "utf8");
  writeFileSync(join(dir, "01-eia.md"), "Foto: Author / CC BY-SA 4.0.", "utf8");
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function run(dirAndArgs: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...dirAndArgs], {
    encoding: "utf8",
    cwd: PROJECT_ROOT,
  });
}

function readWarnings(dir: string): { generated_at?: string; warnings: Array<{ event: string; edition: string; slot?: number }> } {
  const path = join(dir, "_internal", "render-warnings.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("render-newsletter-html CLI — _internal/render-warnings.json (#4673)", () => {
  it("caixa de divulgação sem lacuna (slot3 dropped) → sinal consumível em render-warnings.json", () => {
    const dir = makeEditionDir(buildReviewed({ box1: BOX1, box2: BOX2, box3: BOX3 }));
    try {
      const outPath = join(dir, "_internal", "out.html");
      const r = run([dir, "--full", "--out", outPath]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);

      const path = join(dir, "_internal", "render-warnings.json");
      assert.ok(existsSync(path), "render-warnings.json deveria ter sido gravado");
      const data = readWarnings(dir);
      assert.equal(data.warnings.length, 1, `esperado 1 evento, obtido: ${JSON.stringify(data.warnings)}`);
      assert.equal(data.warnings[0].event, "divulgacao_box_dropped_no_gap");
      assert.equal(data.warnings[0].slot, 3, "o slot 3 (última caixa configurada) é o que não coube");

      // Confirma que o conteúdo da caixa dropped de fato não aparece no HTML
      // final — o sinal reflete um sumiço real, não um falso positivo.
      const html = readFileSync(outPath, "utf8");
      assert.ok(!html.includes("Apoie a curadoria"), "conteúdo da caixa dropped não deve aparecer no HTML");
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true });
    }
  });

  it("edição normal (nada perdido) — render-warnings.json existe mas warnings: [] (sem ruído)", () => {
    const dir = makeEditionDir(buildReviewed({ box1: BOX1 })); // só 1 caixa — cabe folgado
    try {
      const outPath = join(dir, "_internal", "out.html");
      const r = run([dir, "--full", "--out", outPath]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);

      const data = readWarnings(dir);
      assert.deepEqual(data.warnings, [], "edição sem conteúdo perdido não deve produzir nenhum warning");
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true });
    }
  });

  it("re-render após corrigir a causa (menos caixas) sobrescreve o arquivo — nunca fica um warning STALE de uma rodada anterior", () => {
    const dir = makeEditionDir(buildReviewed({ box1: BOX1, box2: BOX2, box3: BOX3 }));
    try {
      const outPath = join(dir, "_internal", "out.html");

      // 1ª rodada: 3 caixas — slot3 dropped, warning gravado.
      const r1 = run([dir, "--full", "--out", outPath]);
      assert.equal(r1.status, 0, `stderr: ${r1.stderr}`);
      assert.equal(readWarnings(dir).warnings.length, 1);

      // Editor corrige (remove a caixa excedente) e re-roda o Stage 4 pre-render
      // — mesmo fluxo de retomada do orchestrator (§4b/§4c.6b).
      writeFileSync(join(dir, "02-reviewed.md"), buildReviewed({ box1: BOX1, box2: BOX2 }), "utf8");
      const r2 = run([dir, "--full", "--out", outPath]);
      assert.equal(r2.status, 0, `stderr: ${r2.stderr}`);
      assert.deepEqual(readWarnings(dir).warnings, [], "arquivo deve refletir o estado FRESCO desta chamada, não a rodada anterior");
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true });
    }
  });

  it("modo --split também grava render-warnings.json (só 1 chamada de renderHTML nesse modo)", () => {
    const dir = makeEditionDir(buildReviewed({ box1: BOX1, box2: BOX2, box3: BOX3 }));
    try {
      const r = run([dir, "--split"]);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const data = readWarnings(dir);
      assert.equal(data.warnings.length, 1);
      assert.equal(data.warnings[0].event, "divulgacao_box_dropped_no_gap");
    } finally {
      rmSync(resolve(dir, ".."), { recursive: true, force: true });
    }
  });
});
