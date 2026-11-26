/**
 * test/use-melhor-post-off-13976-13977.test.ts
 *
 * #13976 — edição 261126: o 4º post foi trocado para o guia do n8n
 * "Production AI Playbook: Audit & trace for AI agents", que tem 5 exercícios,
 * cada um com a sua lista numerada. `extractUseMelhorSteps` ficou com os 8 passos
 * do Exercício 5 e o invariante `use-melhor-um-shape` passou a exigir lista
 * numerada no `## um`. Página com 2+ cabeçalhos "Exercise N" → sem `steps`.
 *
 * #13977 — na mesma edição o editor desligou o 4º post só dela à mão (estado com
 * `item: null`, `## um` removidos de `# Social` e `# Curto`, chaves
 * `um_carousel_*` de `06-public-images.json`, selo do humanizador). Uma nova
 * seleção desfazia a decisão. `refresh-use-melhor-post.ts --off` faz os quatro
 * passos de uma vez e grava `editor_off: true`, que toda seleção respeita até `--on`.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import {
  countSubExerciseHeadings,
  enrichUseMelhorItem,
  extractUseMelhorSteps,
  readUseMelhorPostState,
  removeUseMelhorUmSections,
  useMelhorUmFormat,
  USE_MELHOR_OFF_SELECTED_FROM,
  type UseMelhorPostConfigState,
} from "../scripts/lib/use-melhor-post.ts";
import { computeSectionHashes } from "../scripts/lib/social-lint-rules.ts";
import { PickError, runSelection, runSelectionWithSteps } from "../scripts/select-use-melhor-post.ts";
import { clearUseMelhorPostOff, turnUseMelhorPostOff } from "../scripts/refresh-use-melhor-post.ts";
import { checkSentinel, writeSentinel } from "../scripts/check-humanizer-social.ts";

// ── #13976 ───────────────────────────────────────────────────────────────────

/** Recorte do `pool-sources` da URL do n8n (edição 261126), no formato de `htmlToText`. */
const N8N_PLAYBOOK = [
  "Production AI Playbook: Audit & trace for AI agents",
  "This guide walks through five exercises.",
  "Exercise 1: Silent Failure Forensics",
  "1. Import the Exercise 1 template using the download below.",
  "2. Connect your credentials to OpenRouter - Support .",
  "3. Open Webhook - Support Request and replace YOUR_WEBHOOK_TEST_URL.",
  "Exercise 2: Searchable Executions",
  "1. Import the Exercise 2 template.",
  "2. Connect credentials to OpenRouter - Support , as in Exercise 1.",
  "3. Copy the Webhook Test URL, select Execute workflow , and send:",
  "Exercise 3: Your First Trace",
  "1. Run cloudflared tunnel --url http://localhost:4318 in another terminal.",
  "2. Open Jaeger at http://localhost:16686 and find the test trace.",
  "Exercise 5: Trace an Approval",
  "1. Import, save, and publish the Exercise 5 enrichment sub-workflow first.",
  "2. Connect credentials to OpenRouter - Approval and keep tracing enabled.",
  "3. Send this request.",
  "4. Save the returned executionId and the complete resumeUrl.",
  "5. In Jaeger, paste the trace ID into the Lookup by Trace ID box.",
  "6. Submit the approval to the resume URL.",
  "7. Confirm approved: true in Record Approval.",
  "8. Start a separate run and submit approved: false.",
].join("\n");

const N8N_ITEM = {
  url: "https://blog.n8n.io/production-ai-playbook-audit-trace-for-ai-agents/",
  title: "Production AI Playbook: Audit & trace for AI agents",
  summary: "Guia com cinco exercícios de auditoria e trace.",
  score: 60,
};

describe("#13976 — passos de sub-exercício não viram steps", () => {
  it("guia com vários 'Exercise N', cada um com lista numerada → sem steps, formato prosa (caso 261126)", () => {
    assert.equal(countSubExerciseHeadings(N8N_PLAYBOOK), 4);
    assert.deepEqual(extractUseMelhorSteps(N8N_PLAYBOOK), []);
    const item = enrichUseMelhorItem(N8N_ITEM, N8N_PLAYBOOK);
    assert.equal(item.steps, undefined);
    assert.equal(useMelhorUmFormat(item), "prosa");
  });

  it("guia com UMA lista que cobre o tutorial inteiro → steps preenchido como antes", () => {
    const t = [
      "Como agendar um alerta de preço no Gemini",
      "Passo a passo",
      "1. Abra o Gemini e toque em Agendado",
      "2. Digite o produto e o valor que aceita pagar",
      "3. Ative as notificações",
    ].join("\n");
    assert.deepEqual(extractUseMelhorSteps(t), [
      "Abra o Gemini e toque em Agendado",
      "Digite o produto e o valor que aceita pagar",
      "Ative as notificações",
    ]);
    assert.equal(useMelhorUmFormat(enrichUseMelhorItem(N8N_ITEM, t)), "lista");
  });

  it("menção a 'Exercise 1' no corpo de um passo não conta como cabeçalho", () => {
    const t = "Tutorial\n1. Import the Exercise 1 template\n2. Import the Exercise 2 template\n3. Open the workflow";
    assert.equal(countSubExerciseHeadings(t), 0);
    assert.equal(extractUseMelhorSteps(t).length, 3);
  });

  it("um único cabeçalho 'Exercício 1' não descarta a lista (guia de um exercício só)", () => {
    const t = "Exercício 1: configure o agente\n1. Abra o painel\n2. Clique em Novo agente\n3. Salve";
    assert.equal(countSubExerciseHeadings(t), 1);
    assert.equal(extractUseMelhorSteps(t).length, 3);
  });

  it("'Módulo N' em português também conta", () => {
    const t = "Módulo 1 — Básico\n1. Abra o app\n2. Crie a conta\nMódulo 2 — Avançado\n1. Abra o painel\n2. Ative o modo";
    assert.deepEqual(extractUseMelhorSteps(t), []);
  });
});

// ── #13977 ───────────────────────────────────────────────────────────────────

const ON: UseMelhorPostConfigState = { enabled: true, time: "09:00" };

const ITEM_A = { url: "https://exemplo.com/gemini-preco", title: "Gemini vigia o preço", summary: "Alerta de preço.", score: 70 };
const ITEM_B = { url: "https://exemplo.com/claude-code", title: "Claude Code no negócio", summary: "Sete usos.", score: 60 };

const SOCIAL = [
  "# Social",
  "",
  "## d1",
  "",
  "Texto do D1 no LinkedIn.",
  "",
  "## d1-cards",
  "",
  "Card 1.",
  "",
  "Card 2.",
  "",
  "Card 3.",
  "",
  "## um",
  "",
  "Na Black Friday, o Gemini vigia o preço por você.",
  "",
  "#Gemini #BlackFriday",
  "",
  "# Curto",
  "",
  "## d1",
  "",
  "Curto do D1.",
  "",
  "## um",
  "",
  "Curto do 4º post.",
  "#Gemini",
  "",
].join("\n");

const IMAGES = {
  images: {
    cover: { url: "https://eia.diar.ia.br/img/cover.jpg" },
    d1_4x5: { url: "https://eia.diar.ia.br/img/d1.jpg" },
    um_carousel_cover: { url: "https://eia.diar.ia.br/img/um-cover.jpg" },
    um_carousel_p1: { url: "https://eia.diar.ia.br/img/um-p1.jpg" },
    um_carousel_cta: { url: "https://eia.diar.ia.br/img/um-cta.jpg" },
  },
};

const REVIEWED = [
  "**🛠️ USE MELHOR**",
  "",
  `**[${ITEM_A.title}](${ITEM_A.url})**`,
  `${ITEM_A.summary} (5 min)`,
  "",
  `**[${ITEM_B.title}](${ITEM_B.url})**`,
  `${ITEM_B.summary} (10 min)`,
  "",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkEdition(opts: { social?: boolean; images?: boolean; state?: boolean; seal?: boolean } = {}): string {
  const { social = true, images = true, state = true, seal = true } = opts;
  const dir = mkdtempSync(join(tmpdir(), "um-off-13977-"));
  dirs.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  const approved = { use_melhor: [ITEM_A, ITEM_B], highlights: [] };
  writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved));
  writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify(approved));
  writeFileSync(join(dir, "02-reviewed.md"), REVIEWED);
  if (social) writeFileSync(join(dir, "03-social.md"), SOCIAL);
  if (images) writeFileSync(join(dir, "06-public-images.json"), JSON.stringify(IMAGES, null, 2) + "\n");
  if (state) {
    writeFileSync(
      join(dir, "_internal", "use-melhor-post.json"),
      JSON.stringify({ enabled: true, time: "09:00", item: ITEM_A, selected_from: "approved", generated_at: "2026-11-25T20:00:00Z" }),
    );
  }
  if (social && seal) writeSentinel(dir);
  return dir;
}

describe("#13977 — removeUseMelhorUmSections", () => {
  it("tira os dois `## um` e deixa as outras seções byte a byte iguais", () => {
    const r = removeUseMelhorUmSections(SOCIAL);
    assert.equal(r.removed, 2);
    assert.doesNotMatch(r.md, /^## um$/m);
    assert.match(r.md, /Card 3\.\n\n# Curto\n/);
    assert.ok(r.md.endsWith("Curto do D1.\n"));
    const before = computeSectionHashes(SOCIAL);
    const after = computeSectionHashes(r.md);
    for (const [name, h] of Object.entries(after)) assert.equal(h, before[name], name);
  });

  it("sem `## um` → mesmo texto; não confunde `## um-cards`/`## umbrella`", () => {
    const md = "# Social\n\n## d1\n\nX\n\n## umbrella\n\nY\n";
    assert.deepEqual(removeUseMelhorUmSections(md), { md, removed: 0 });
  });

  it("preserva CRLF", () => {
    const r = removeUseMelhorUmSections(SOCIAL.replace(/\n/g, "\r\n"));
    assert.equal(r.removed, 2);
    assert.ok(!/(^|[^\r])\n/.test(r.md));
  });
});

describe("#13977 — refresh-use-melhor-post --off", () => {
  it("--off faz os 4 efeitos: estado, `## um`, `um_carousel_*`, selo", () => {
    const dir = mkEdition();
    writeFileSync(join(dir, "_internal", "use-melhor-refresh-pending.json"), JSON.stringify({ url: ITEM_A.url }));
    const r = turnUseMelhorPostOff(dir, "edição sem USE MELHOR no social", ON);
    assert.equal(r.removed_sections, 2);
    assert.deepEqual(r.removed_image_keys.sort(), ["um_carousel_cover", "um_carousel_cta", "um_carousel_p1"]);
    assert.equal(r.seal, "resealed");

    const state = readUseMelhorPostState(dir)!;
    assert.equal(state.item, null);
    assert.equal(state.editor_off, true);
    assert.equal(state.selected_from, USE_MELHOR_OFF_SELECTED_FROM);
    assert.equal(state.off_item_url, ITEM_A.url);
    assert.match(state.reason!, /edição sem USE MELHOR no social/);

    assert.doesNotMatch(readFileSync(join(dir, "03-social.md"), "utf8"), /^## um$/m);
    const images = JSON.parse(readFileSync(join(dir, "06-public-images.json"), "utf8")).images;
    assert.deepEqual(Object.keys(images), ["cover", "d1_4x5"]);
    assert.deepEqual(checkSentinel(dir), { ok: true });
    assert.equal(existsSync(join(dir, "_internal", "use-melhor-refresh-pending.json")), false);
  });

  it("idempotente: --off duas vezes não quebra e mantém o item que estava escolhido", () => {
    const dir = mkEdition();
    turnUseMelhorPostOff(dir, "motivo", ON);
    const r2 = turnUseMelhorPostOff(dir, "motivo", ON);
    assert.equal(r2.removed_sections, 0);
    assert.deepEqual(r2.removed_image_keys, []);
    assert.equal(r2.seal, "unchanged");
    assert.equal(readUseMelhorPostState(dir)!.off_item_url, ITEM_A.url);
    assert.deepEqual(checkSentinel(dir), { ok: true });
  });

  it("nova seleção depois do --off mantém item: null (Stage 2, --reviewed, --force)", async () => {
    const dir = mkEdition();
    turnUseMelhorPostOff(dir, "motivo", ON);
    for (const opts of [{}, { useReviewed: true }, { useReviewed: true, forceReselect: true }]) {
      const r = runSelection(dir, ON, { ...opts, discontinuationTopics: [] });
      assert.equal(r.state.item, null, JSON.stringify(opts));
      assert.equal(r.state.editor_off, true);
      assert.equal(r.written, null);
    }
    const fetchImpl = (async () => {
      throw new Error("não deveria buscar a fonte");
    }) as unknown as typeof fetch;
    const r = await runSelectionWithSteps(dir, ON, { useReviewed: true, fetchImpl, discontinuationTopics: [] });
    assert.equal(r.state.item, null);
    assert.equal(readUseMelhorPostState(dir)!.editor_off, true);
  });

  it("--url com o 4º post desligado pelo editor é recusado (PickError), nada gravado", () => {
    const dir = mkEdition();
    turnUseMelhorPostOff(dir, "motivo", ON);
    const before = readFileSync(join(dir, "_internal", "use-melhor-post.json"), "utf8");
    assert.throws(
      () => runSelection(dir, ON, { pickUrl: ITEM_B.url, discontinuationTopics: [] }),
      (e: unknown) => e instanceof PickError && /--on/.test((e as Error).message),
    );
    assert.equal(readFileSync(join(dir, "_internal", "use-melhor-post.json"), "utf8"), before);
  });

  it("--on religa: a seleção seguinte escolhe o item de novo", () => {
    const dir = mkEdition();
    turnUseMelhorPostOff(dir, "motivo", ON);
    assert.equal(clearUseMelhorPostOff(dir), true);
    assert.equal(readUseMelhorPostState(dir)!.editor_off, undefined);
    const r = runSelection(dir, ON, { useReviewed: true, discontinuationTopics: [] });
    assert.equal(r.state.item?.url, ITEM_A.url);
    assert.equal(clearUseMelhorPostOff(dir), false, "--on sem --off antes não faz nada");
  });

  it("edição sem 4º post (sem estado, sem social, sem imagens) não quebra", () => {
    const dir = mkEdition({ social: false, images: false, state: false });
    const r = turnUseMelhorPostOff(dir, "motivo", ON);
    assert.equal(r.removed_sections, 0);
    assert.deepEqual(r.removed_image_keys, []);
    assert.equal(r.seal, "unchanged");
    assert.equal(readUseMelhorPostState(dir)!.editor_off, true);
    assert.equal(readUseMelhorPostState(dir)!.off_item_url, undefined);
  });

  it("selo já defasado antes do --off não é refeito (não esconde texto sem humanizar)", () => {
    const dir = mkEdition();
    const p = join(dir, "03-social.md");
    writeFileSync(p, readFileSync(p, "utf8").replace("Texto do D1 no LinkedIn.", "Texto do D1 editado à mão."));
    const r = turnUseMelhorPostOff(dir, "motivo", ON);
    assert.equal(r.seal, "skipped-stale-seal");
    assert.equal(checkSentinel(dir).ok, false);
  });

  it("sem selo anterior: não cria selo", () => {
    const dir = mkEdition({ seal: false });
    const r = turnUseMelhorPostOff(dir, "motivo", ON);
    assert.equal(r.seal, "skipped-no-seal");
    assert.deepEqual(checkSentinel(dir), { ok: false, reason: "sentinel_missing" });
  });

  it("falha no selo desfaz o lote: estado, social e imagens voltam ao que eram", () => {
    const dir = mkEdition();
    const files = ["_internal/use-melhor-post.json", "03-social.md", "06-public-images.json"];
    const before = files.map((f) => readFileSync(join(dir, f), "utf8"));
    assert.throws(
      () =>
        turnUseMelhorPostOff(dir, "motivo", ON, {
          deps: {
            writeSeal: () => {
              throw new Error("selo recusou");
            },
          },
        }),
      /nada gravado/,
    );
    assert.deepEqual(files.map((f) => readFileSync(join(dir, f), "utf8")), before);
    assert.deepEqual(checkSentinel(dir), { ok: true });
  });

  it("falha no selo sem estado anterior: o estado criado é apagado", () => {
    const dir = mkEdition({ state: false });
    assert.throws(() =>
      turnUseMelhorPostOff(dir, "motivo", ON, {
        deps: {
          writeSeal: () => {
            throw new Error("x");
          },
        },
      }),
    );
    assert.equal(existsSync(join(dir, "_internal", "use-melhor-post.json")), false);
  });

  it("motivo vazio é recusado sem gravar nada", () => {
    const dir = mkEdition();
    const before = readFileSync(join(dir, "03-social.md"), "utf8");
    assert.throws(() => turnUseMelhorPostOff(dir, "   ", ON), /motivo/);
    assert.equal(readFileSync(join(dir, "03-social.md"), "utf8"), before);
  });

  it("CLI: --off sem motivo sai exit 2", () => {
    const dir = mkEdition();
    const script = resolve(import.meta.dirname, "..", "scripts", "refresh-use-melhor-post.ts");
    const r = spawnSync(process.execPath, ["--import", "tsx", script, "--edition-dir", dir, "--off"], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /--off exige o motivo/);
    assert.match(readFileSync(join(dir, "03-social.md"), "utf8"), /^## um$/m);
  });
});
