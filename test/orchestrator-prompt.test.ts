/**
 * orchestrator-prompt.test.ts (#634 frente C)
 *
 * Snapshot test do conteúdo dos arquivos orchestrator.md + sub-arquivos.
 * Objetivo: detectar remoção acidental de seções ou invariantes críticos
 * durante refactors. Não testa comportamento — testa presença de conteúdo.
 *
 * Para atualizar snapshot intencionalmente após refactor legítimo:
 *   npm test -- --test-name-pattern "orchestrator-prompt" --update-snapshots
 *
 * Ou via node-test built-in snapshot update (Node 22):
 *   NODE_TEST_SNAPSHOTS=1 npm test
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = resolve(ROOT, ".claude/agents");
const SNAPSHOT_PATH = resolve(ROOT, "test/__snapshots__/orchestrator-prompt.snap.json");

const ORCHESTRATOR_FILES = [
  "orchestrator.md",
  "orchestrator-stage-0-preflight.md",
  "orchestrator-stage-1-research.md",
  "orchestrator-stage-2.md",
  "orchestrator-stage-3.md",
  "orchestrator-stage-4.md",
  "orchestrator-stage-5.md",
];

/** Invariants that must be present in the combined orchestrator content. */
const REQUIRED_INVARIANTS = [
  // Cross-file structural requirements
  "Stage 0",
  "Stage 1",
  "## Stage 0",
  "## Stage 1",
  "Etapa 2",
  "Etapa 3",
  "Etapa 4",
  "Etapa 5",
  // Critical operational invariants
  "GATE HUMANO",
  "drive-sync.ts",
  "01-categorized.md",
  "01-approved.json",
  // Anti-skip guards
  "validate-pool",                         // inject-inbox-urls sentinel
  "drive_sync",                            // Stage 1w anti-skip
  // Stage 5 publication safety
  "confirmação explícita",
  // Smoke-compatible sections
  "inbox-drain",
  "scorer",
  "render-categorized-md",
  // #1783: marks de status que fecham a duração de S0/S4/S5 no relatório
  "--stage 0 --status running",
  "--stage 0 --status done",
  "--stage 4 --status running",
  "--stage 5 --status running",
  "mark-done canônico do Stage 5 é o §5i",
  // #2145: lint de consistência post_pixel↔D1 no gate do Stage 4
  "post_pixel-matches-d1",
];

function readOrchestratorFiles(): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const file of ORCHESTRATOR_FILES) {
    const path = resolve(AGENTS_DIR, file);
    assert.ok(existsSync(path), `Orchestrator file missing: ${file}`);
    contents[file] = readFileSync(path, "utf8");
  }
  return contents;
}

function computeHash(contents: Record<string, string>): string {
  // Normalize CRLF → LF before hashing for cross-platform consistency.
  // Windows writes CRLF, Linux/CI uses LF — without normalization hashes differ.
  const combined = ORCHESTRATOR_FILES
    .map((f) => `=== ${f} ===\n${contents[f].replace(/\r\n/g, "\n")}`)
    .join("\n\n");
  return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

function loadSnapshot(): { hash: string; file_sizes: Record<string, number> } | null {
  if (!existsSync(SNAPSHOT_PATH)) return null;
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveSnapshot(hash: string, fileSizes: Record<string, number>): void {
  writeFileSync(
    SNAPSHOT_PATH,
    JSON.stringify({ hash, file_sizes: fileSizes, updated_at: new Date().toISOString() }, null, 2) + "\n",
    "utf8",
  );
}

describe("orchestrator-prompt (#634)", () => {
  const contents = readOrchestratorFiles();
  const combined = Object.values(contents).join("\n");

  it("todos os arquivos existem e são não-vazios", () => {
    for (const [file, content] of Object.entries(contents)) {
      assert.ok(content.length > 100, `${file} parece vazio (< 100 chars)`);
    }
  });

  it("tamanhos de arquivo dentro dos targets", () => {
    const lines = Object.fromEntries(
      Object.entries(contents).map(([f, c]) => [f, c.split("\n").length]),
    );
    // root orchestrator.md ≤ 200 linhas
    assert.ok(lines["orchestrator.md"] <= 200, `orchestrator.md tem ${lines["orchestrator.md"]} linhas (target ≤200)`);
    // sub-arquivos ≤ 580 linhas (target 250, tolerância para arquivos de pesquisa
    // que acumulam invariantes operacionais — bumped from 450 quando
    // orchestrator-stage-1-research.md cresceu por #791/#716/#789/#790/#780;
    // 500→510 quando #903 adicionou step 1v-early; 510→525 quando #1007 Fase 1
    // adicionou pre-gate invariant checks em todos os stages; 525→540 quando
    // #1091 adicionou warning anti-skip de 1f + passo 1w-quint; 540→555
    // quando #1095 + #1097 documentaram newsletter extraction + coverage line sync;
    // 555→565 quando #1112 adicionou step 1p1 research-review-dates; 565→580
    // quando #1273 adicionou wrapper ensure-research-reviewer-output post-dispatch;
    // 580→620 quando stage-4 cresceu com publish paralelo + resume-aware + halt rules;
    // 620→640 quando #1545 adicionou 4f-ter social preview + #1548 report instruction;
    // 640→700 quando #1571 documentou pre-gate mode + 4a-pre-gate explícito;
    // 700→715 quando #1783 adicionou marks de status S0 (running/done) + S4
    // (mark-done canônico no §4i, fora do §4g que é pulado em pre-gate).
    // 715→745 quando #2073 adicionou step 1w-quint-b (check-highlight-themes)
    // + item 4 no gate de repeat-de-tema.
    // #1694: split Stage 4 (Publicação) → Stage 4 (Revisão) + Stage 5 (Publicação).
    // stage-5.md herda o conteúdo pesado do antigo stage-4.md. Budget mantido
    // em 745 por arquivo — stage-4.md (Revisão) é muito menor (~130 linhas).
    // 745→755 quando #2367 adicionou step 1u-bis (dedup-intra-edition).
    for (const file of ORCHESTRATOR_FILES.slice(1)) {
      assert.ok(
        lines[file] <= 755,
        `${file} tem ${lines[file]} linhas (target ≤755)`,
      );
    }
  });

  it("conteúdo combinado contém todas as invariantes obrigatórias", () => {
    for (const invariant of REQUIRED_INVARIANTS) {
      assert.ok(
        combined.includes(invariant),
        `Invariante ausente no orchestrator: "${invariant}"`,
      );
    }
  });

  it("#1708: resume §0b referencia 05/06-published.json em _internal/ (não na raiz)", () => {
    // Pós-#158 os published.json moram em _internal/. Se o §0b checar a raiz, o
    // resume não detecta Stage 4 completo → re-publica (rascunho Beehiiv duplicado
    // + re-agenda 6 posts). Toda menção deve ser _internal/-prefixada.
    const stage0 = contents["orchestrator-stage-0-preflight.md"];
    // Remove TODAS as refs _internal/-prefixadas; qualquer ocorrência remanescente
    // do filename é, por definição, BARE (raiz) — pega tanto " 05-published.json"
    // (prosa) quanto ".../06-social-published.json" (path no glob inline JS, a
    // forma exata do bug #1708). Mais robusto que um regex de lookbehind frágil.
    const stripped = stage0
      .replace(/_internal\/05-published\.json/g, "")
      .replace(/_internal\/06-social-published\.json/g, "");
    assert.ok(
      !/05-published\.json/.test(stripped),
      "ref bare (raiz) a 05-published.json no stage-0 — deve ser _internal/",
    );
    assert.ok(
      !/06-social-published\.json/.test(stripped),
      "ref bare (raiz) a 06-social-published.json no stage-0 — deve ser _internal/",
    );
    // Sanity: ao menos uma menção _internal/ presente (não foi tudo removido).
    assert.ok(stage0.includes("_internal/05-published.json"), "deve referenciar _internal/05-published.json");
    assert.ok(stage0.includes("_internal/06-social-published.json"), "deve referenciar _internal/06-social-published.json");
  });

  it("sub-arquivos de stage referenciados no orchestrator.md raiz", () => {
    const root = contents["orchestrator.md"];
    assert.ok(root.includes("orchestrator-stage-0-preflight.md"), "orchestrator.md não referencia stage-0-preflight");
    assert.ok(root.includes("orchestrator-stage-1-research.md"), "orchestrator.md não referencia stage-1-research");
    assert.ok(root.includes("orchestrator-stage-2.md"), "orchestrator.md não referencia stage-2");
    assert.ok(root.includes("orchestrator-stage-4.md"), "orchestrator.md não referencia stage-4");
    assert.ok(root.includes("orchestrator-stage-5.md"), "orchestrator.md não referencia stage-5");
  });

  it("#2288: §0-replies condicionado a pre_gate (não auto_approve) — roda no /diaria-edicao pre-gate, pula em --no-gates", () => {
    const stage0 = contents["orchestrator-stage-0-preflight.md"];
    // Condição correta: pre_gate === true (editor presente, gate no Stage 4)
    assert.ok(
      stage0.includes("pre_gate === true"),
      "§0-replies deve usar condição 'pre_gate === true', não 'auto_approve === false'",
    );
    // Condição antiga não deve aparecer no contexto do §0-replies
    // (pode aparecer em outros contextos; estamos buscando especificamente na seção)
    const repliesSection = stage0.slice(stage0.indexOf("### 0-replies"));
    assert.ok(
      !repliesSection.includes("auto_approve === false"),
      "§0-replies não deve mais checar 'auto_approve === false' — já foi migrado para pre_gate (#2288)",
    );
    // Log de skip deve mencionar headless (não auto_approve)
    assert.ok(
      stage0.includes("0-replies skipped: headless --no-gates"),
      "log de skip do §0-replies deve ser 'headless --no-gates', não 'auto_approve=true'",
    );
  });

  it("#2365: stage-3 lint/image-gen/drive-sync/gate são condicionais a destaque_count (não hardcoded d1/d2/d3)", () => {
    const stage3 = contents["orchestrator-stage-3.md"];

    // P2 fix: lint loop NÃO deve instruir "Para cada destaque d1, d2, d3" sem condicional
    assert.ok(
      !stage3.includes("Para cada destaque d1, d2, d3"),
      "stage-3 ainda contém loop hardcoded 'Para cada destaque d1, d2, d3' — deve ser condicional a destaque_count",
    );

    // Condicional presente nos 3 pontos afetados (lint, drive-sync, gate)
    const conditionalMatches = (stage3.match(/destaque_count/g) ?? []).length;
    assert.ok(
      conditionalMatches >= 5,
      `stage-3 deve referenciar destaque_count ≥5× (lint+gen+drive-pull+drive-push+gate+sentinel) — encontrado: ${conditionalMatches}`,
    );

    // P3 fix: drive-sync push NÃO deve ter linha única hardcoded com 04-d3 sem condicional
    // (verificar que 04-d3-2x1.jpg e 04-d3-1x1.jpg aparecem sob comentário "destaque_count=3:")
    const d3Push = stage3.indexOf("04-d3-2x1.jpg");
    assert.ok(d3Push !== -1, "04-d3-2x1.jpg ausente no stage-3 — deve estar no bloco condicional destaque_count=3");
    const contextBefore = stage3.slice(Math.max(0, d3Push - 200), d3Push);
    assert.ok(
      contextBefore.includes("destaque_count=3"),
      "04-d3-2x1.jpg deve aparecer apenas sob comentário '# destaque_count=3:' — sem condicional encontrado no contexto",
    );

    // P3 fix: gate humano NÃO deve listar 6 imagens fixas — deve conter a condicional
    const gateIdx = stage3.indexOf("GATE HUMANO");
    assert.ok(gateIdx !== -1, "GATE HUMANO ausente em stage-3");
    const gateSection = stage3.slice(gateIdx, gateIdx + 600);
    assert.ok(
      gateSection.includes("destaque_count"),
      "GATE HUMANO deve referenciar destaque_count para listar imagens condicionalmente",
    );
    assert.ok(
      !gateSection.includes("8 imagens"),
      "GATE HUMANO não deve mais mencionar '8 imagens' de forma fixa",
    );
  });

  it("snapshot hash — detecta mudanças não-intencionais", () => {
    const hash = computeHash(contents);
    const fileSizes = Object.fromEntries(
      Object.entries(contents).map(([f, c]) => [f, c.split("\n").length]),
    );

    const snap = loadSnapshot();
    if (!snap) {
      // Primeira vez: criar snapshot
      saveSnapshot(hash, fileSizes);
      console.log(`  [snapshot] criado: ${hash}`);
      return;
    }

    // Verificar se hash mudou — se sim, exigir update intencional
    if (snap.hash !== hash) {
      // Check if running with update flag
      const updating = process.env.NODE_TEST_SNAPSHOTS === "1" ||
                       process.argv.includes("--update-snapshots");
      if (updating) {
        saveSnapshot(hash, fileSizes);
        console.log(`  [snapshot] atualizado: ${snap.hash} → ${hash}`);
      } else {
        assert.fail(
          `Orchestrator content changed (${snap.hash} → ${hash}).\n` +
          `Se o refactor é intencional, atualize o snapshot:\n` +
          `  NODE_TEST_SNAPSHOTS=1 npm test`
        );
      }
    }
  });
});
