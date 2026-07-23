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
  "01-categorized.md",
  "01-approved.json",
  // Anti-skip guards
  "validate-pool",                         // inject-inbox-urls sentinel
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

    // #3445: teto POR-ARQUIVO (substitui o teto único 790 compartilhado por todos
    // os sub-arquivos, #634→#3202). O teto único era, na prática, um ratchet que
    // só cresceu (450→790 ao longo de ~15 bumps, ver histórico no git blame deste
    // arquivo) e nunca pegou crescimento de um arquivo PEQUENO até perto do dobro
    // do seu tamanho real — ex: stage-3.md (122 linhas) podia sextuplicar antes
    // de falhar. Cada teto abaixo é o tamanho medido em 260713 (pós-auditoria
    // #3445 — stage-1 perdeu a seção morta 1p2/#1553; stage-4 ganhou o fluxo de
    // re-humanização scoped #3446, líquido +15) + ~15 linhas de headroom. Bump
    // exige decisão consciente (igual ao teto único antigo) — só que agora por
    // arquivo, então crescimento de um sub-arquivo pequeno não passa despercebido
    // sob a sombra do teto de um arquivo grande.
    const PER_FILE_LINE_BUDGET: Record<string, number> = {
      // #3530: +6 linhas (resolução de {EDITION_DIR} em §0a + fix nested-aware
      // em §0l + resolução da edição referenciada em §0-replies). Teto bumped
      // de 520→535 com headroom (era 521 medido pós-#3530).
      "orchestrator-stage-0-preflight.md": 535,
      // #3842: +23 linhas (log de decisão de path A/B em §1f — antes desse
      // arquivo tinha 754 linhas, headroom original do teto 795 continua
      // suficiente, sem bump necessário).
      "orchestrator-stage-1-research.md": 795,
      // #3929: +11 linhas (snapshot pós-humanizador/pré-Clarice + diff legível
      // do social em §2c, 4º arg opcional de pré-Humanizador no clarice-diff.ts
      // da newsletter em §2b, e menção ao novo diff no gate §2d — decorrelaciona
      // o check humanizer-section-coverage de reversões legítimas da Clarice).
      // Teto bumped de 548→575 com headroom (era 559 medido pós-#3929).
      "orchestrator-stage-2.md": 575,
      "orchestrator-stage-3.md": 135,
      "orchestrator-stage-4.md": 648,
      "orchestrator-stage-5.md": 455,
    };
    for (const file of ORCHESTRATOR_FILES.slice(1)) {
      const budget = PER_FILE_LINE_BUDGET[file];
      assert.ok(budget !== undefined, `${file} sem teto definido em PER_FILE_LINE_BUDGET (#3445)`);
      assert.ok(
        lines[file] <= budget,
        `${file} tem ${lines[file]} linhas (target ≤${budget} — #3445 per-file budget)`,
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

  it("#2365/#3636: stage-3 lint/image-gen/gate/sentinel são condicionais a destaque_count (não hardcoded d1/d2/d3)", () => {
    const stage3 = contents["orchestrator-stage-3.md"];

    // P2 fix: lint loop NÃO deve instruir "Para cada destaque d1, d2, d3" sem condicional
    assert.ok(
      !stage3.includes("Para cada destaque d1, d2, d3"),
      "stage-3 ainda contém loop hardcoded 'Para cada destaque d1, d2, d3' — deve ser condicional a destaque_count",
    );

    // Condicional presente nos pontos afetados (lint, gen, gate, sentinel — #3636
    // removeu os pontos drive-pull/drive-push que existiam aqui antes)
    const conditionalMatches = (stage3.match(/destaque_count/g) ?? []).length;
    assert.ok(
      conditionalMatches >= 5,
      `stage-3 deve referenciar destaque_count ≥5× (lint+gen+gate+sentinel×2) — encontrado: ${conditionalMatches}`,
    );

    // P3 fix (#3636: sentinel é o único lugar com comentário-condicional
    // "# destaque_count=N:" agora que o bloco drive-sync push foi removido):
    // verificar que 04-d3-2x1.jpg e 04-d3-1x1.jpg aparecem sob comentário
    // "destaque_count=3:" no bloco do sentinel.
    const sentinelIdx = stage3.indexOf("Escrever sentinel de conclusão do Stage 3");
    assert.ok(sentinelIdx !== -1, "seção 'Escrever sentinel de conclusão do Stage 3' ausente no stage-3");
    const sentinelSection = stage3.slice(sentinelIdx);
    const d3Sentinel = sentinelSection.indexOf("04-d3-2x1.jpg");
    assert.ok(d3Sentinel !== -1, "04-d3-2x1.jpg ausente no bloco do sentinel — deve estar no bloco condicional destaque_count=3");
    const contextBefore = sentinelSection.slice(Math.max(0, d3Sentinel - 200), d3Sentinel);
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

describe("#3530: Stages 0-3 usam {EDITION_DIR} resolvido — sem split-brain com layout nested", () => {
  // Guard direto do risco central do #3530: se Stage 0 criasse a edição em
  // nested mas Stages 1-3 continuassem lendo/escrevendo em flat literal
  // (`data/editions/{AAMMDD}/...`), a pipeline quebraria (edição partida
  // entre 2 diretórios). Este teste garante que NENHUM dos 4 arquivos monta
  // mais esse path à mão para a edição CORRENTE — todos devem passar por
  // `{EDITION_DIR}` (resolvido via `find-current-edition.ts --resolve`).
  const STAGE_0_3_FILES = [
    "orchestrator-stage-0-preflight.md",
    "orchestrator-stage-1-research.md",
    "orchestrator-stage-2.md",
    "orchestrator-stage-3.md",
  ];

  // Padrões que representariam o bug antigo: montar o path da edição CORRENTE
  // à mão em vez de usar {EDITION_DIR}. Não cobre `data/editions/*/` (glob
  // multi-edição) nem `--editions-dir data/editions/` (root, scripts próprios
  // já enumeram os 2 layouts internamente via enumerateEditionDirs) — esses
  // permanecem literais de propósito.
  const FORBIDDEN_PATTERNS = [
    /data\/editions\/\{AAMMDD\}/,
    /data\/editions\/\{edition_date\}/,
    /data\/editions\/\{edição\}/,
  ];

  for (const file of STAGE_0_3_FILES) {
    it(`${file} não monta mais data/editions/{AAMMDD} (ou variantes) à mão para a edição corrente`, () => {
      const content = readFileSync(resolve(AGENTS_DIR, file), "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        assert.ok(
          !pattern.test(content),
          `${file} ainda contém ${pattern} — path da edição corrente deve usar {EDITION_DIR}, não ser montado à mão (risco de split-brain #3530)`,
        );
      }
    });
  }

  it("orchestrator-stage-0-preflight.md resolve {EDITION_DIR} ANTES do mkdir de criação da edição", () => {
    const content = readFileSync(resolve(AGENTS_DIR, "orchestrator-stage-0-preflight.md"), "utf8");
    const resolveIdx = content.indexOf("find-current-edition.ts --resolve");
    const mkdirIdx = content.indexOf("mkdir -p {EDITION_DIR}");
    assert.ok(resolveIdx !== -1, "stage-0 não resolve EDITION_DIR via find-current-edition.ts --resolve");
    assert.ok(mkdirIdx !== -1, "stage-0 não usa {EDITION_DIR} no mkdir de criação");
    assert.ok(
      resolveIdx < mkdirIdx,
      "EDITION_DIR deve ser resolvido ANTES do mkdir — senão o mkdir usaria um path não-resolvido",
    );
  });

  it("Stages 1-3 documentam a resolução de {EDITION_DIR} no início do arquivo (idempotente em resume isolado)", () => {
    for (const file of STAGE_0_3_FILES.slice(1)) {
      const content = readFileSync(resolve(AGENTS_DIR, file), "utf8");
      assert.ok(
        content.includes("find-current-edition.ts --resolve"),
        `${file} não documenta a resolução de {EDITION_DIR} — stages são invocáveis isoladamente via skill própria (ex: /diaria-2-escrita), então cada um precisa resolver de novo se não herdar de uma sessão anterior`,
      );
    }
  });
});

describe("orchestrator — sem `\\n` literal em comandos (hotfix 260621)", () => {
  // O orchestrator é executado por um LLM que passa os comandos pro Bash. Um `\n`
  // LITERAL (2 chars: barra-n) no meio de um comando (ex: `resolve-edition-url.ts \n
  // --edition-dir`) chega ao shell como argumento literal e quebra o comando — pego
  // no code-review consolidado (Stage 5). Guard: nenhum arquivo deve ter `\n` literal
  // imediatamente antes de uma flag `--`.
  for (const file of ORCHESTRATOR_FILES) {
    it(`${file} não contém '\\n' literal antes de flag`, () => {
      const content = readFileSync(resolve(AGENTS_DIR, file), "utf8");
      assert.ok(
        !/\\n\s+--/.test(content),
        `${file} tem '\\n' literal antes de uma flag — use comando single-line ou continuação real`,
      );
    });
  }
});

describe("#3727: teardown do fallback 127.0.0.1 exclui explicitamente a porta fixa do Studio", () => {
  // Achado do review consolidado (Fase 1.5, rodada 260719) sobre a PR #3718
  // (fix do #3700): o fallback de varredura `tabs_context_mcp` por abas
  // apontando pra `127.0.0.1` não escopava por porta — o Studio
  // (`scripts/studio-ui/server.ts`, porta fixa default 4174) também roda em
  // loopback e podia ser fechado junto com a aba de preview morta, derrubando
  // a sessão do editor sem aviso. Guard: a instrução de fallback (diário e
  // mensal) precisa mencionar explicitamente a exclusão da porta do Studio
  // perto da menção a `127.0.0.1`.
  const cases: Array<{ label: string; path: string }> = [
    { label: "orchestrator-stage-4.md (diário)", path: resolve(AGENTS_DIR, "orchestrator-stage-4.md") },
    {
      label: "diaria-mensal/SKILL.md (mensal)",
      path: resolve(ROOT, ".claude/skills/diaria-mensal/SKILL.md"),
    },
  ];

  for (const { label, path } of cases) {
    it(`${label}: fallback tabs_context_mcp por 127.0.0.1 exclui a porta 4174 do Studio`, () => {
      const content = readFileSync(path, "utf8");
      // O arquivo pode mencionar 127.0.0.1 em outros contextos (ex: descrição
      // do servidor de preview em si) — o que importa é a instrução do
      // fallback de teardown, identificável pela menção a "tabs_context_mcp"
      // colada à mesma frase.
      const occurrences: number[] = [];
      let searchFrom = 0;
      for (;;) {
        const idx = content.indexOf("127.0.0.1", searchFrom);
        if (idx === -1) break;
        occurrences.push(idx);
        searchFrom = idx + 1;
      }
      assert.ok(occurrences.length > 0, `${label} deve mencionar 127.0.0.1 no teardown do fallback`);

      const fallbackWindow = occurrences
        .map((idx) => content.slice(Math.max(0, idx - 300), idx + 500))
        .find((window) => window.includes("tabs_context_mcp") || window.includes("fallback"));
      assert.ok(
        fallbackWindow,
        `${label}: nenhuma menção a 127.0.0.1 está próxima da instrução de fallback de teardown (tabs_context_mcp)`,
      );
      assert.ok(
        fallbackWindow.includes("4174"),
        `${label}: fallback 127.0.0.1 deve excluir explicitamente a porta 4174 (Studio) — #3727`,
      );
    });
  }
});

describe("#3842: Stage 1 loga qual websearch path (A/B) foi escolhido e por quê", () => {
  // Antes do #3842 o fallback Path A→Path B (BRAVE_API_KEY ausente, ou
  // WEBSEARCH_BACKEND=agents forçando o override) era completamente silencioso
  // — nenhuma entrada em run-log.jsonl. Guard: a seção §1f precisa instruir
  // explicitamente um log-event.ts para os 3 desfechos possíveis, com o nível
  // de severidade correto (info só quando Path A de fato rodou; warn nos dois
  // motivos de cair pro Path B).
  const content = readFileSync(resolve(AGENTS_DIR, "orchestrator-stage-1-research.md"), "utf8");
  const section1f = content.slice(
    content.indexOf("### 1f. Dispatch de researchers e discovery"),
    content.indexOf("### 1g. Registrar saúde"),
  );

  it("§1f existe e foi isolada corretamente para o slice do teste", () => {
    assert.ok(section1f.length > 0, "slice de §1f vazio — âncoras de indexOf não bateram");
  });

  it("cobre os dois motivos de cair pro Path B: key ausente e override explícito", () => {
    assert.ok(
      section1f.includes("brave_key_missing"),
      "§1f não loga o motivo 'brave_key_missing' (BRAVE_API_KEY ausente)",
    );
    assert.ok(
      section1f.includes("WEBSEARCH_BACKEND_agents"),
      "§1f não loga o motivo 'WEBSEARCH_BACKEND_agents' (override explícito que força Path B mesmo com key presente)",
    );
  });

  it("chama scripts/log-event.ts para os 3 desfechos (Path A ok, Path B por key ausente, Path B por override)", () => {
    const logCallCount = (section1f.match(/npx tsx scripts\/log-event\.ts/g) ?? []).length;
    assert.ok(
      logCallCount >= 3,
      `§1f deve conter ≥3 chamadas a log-event.ts (1 por desfecho de path) — encontrado: ${logCallCount}`,
    );
  });

  it("nível de severidade correto: info só para Path A (brave_key_present), warn para os 2 motivos de Path B", () => {
    const reasons: Array<{ reason: string; expectedLevel: "info" | "warn" }> = [
      { reason: "brave_key_present", expectedLevel: "info" },
      { reason: "brave_key_missing", expectedLevel: "warn" },
      { reason: "WEBSEARCH_BACKEND_agents", expectedLevel: "warn" },
    ];
    for (const { reason, expectedLevel } of reasons) {
      const reasonIdx = section1f.indexOf(`"reason":"${reason}"`);
      assert.ok(reasonIdx !== -1, `reason "${reason}" não encontrado em §1f`);
      // A chamada log-event.ts correspondente está a poucas linhas ANTES do
      // --details que carrega esse reason (mesmo bloco bash). Procurar a
      // ocorrência de --level mais próxima antes do --details.
      const beforeDetails = section1f.slice(Math.max(0, reasonIdx - 300), reasonIdx);
      const levelMatch = beforeDetails.match(/--level\s+(\w+)/g);
      assert.ok(levelMatch && levelMatch.length > 0, `nenhum --level encontrado perto do reason "${reason}"`);
      const lastLevel = levelMatch[levelMatch.length - 1];
      assert.ok(
        lastLevel.includes(expectedLevel),
        `reason "${reason}" deveria logar --level ${expectedLevel}, encontrado: "${lastLevel}"`,
      );
    }
  });

  it("checagem de WEBSEARCH_BACKEND=agents acontece ANTES de rodar fetch-websearch-batch.ts (evita gastar Path A quando já sabe que vai descartar)", () => {
    const overrideLogIdx = section1f.indexOf('"WEBSEARCH_BACKEND_agents"');
    const scriptRunIdx = section1f.indexOf("npx tsx scripts/fetch-websearch-batch.ts");
    assert.ok(overrideLogIdx !== -1, "log de WEBSEARCH_BACKEND_agents não encontrado");
    assert.ok(scriptRunIdx !== -1, "chamada a fetch-websearch-batch.ts não encontrada");
    assert.ok(
      overrideLogIdx < scriptRunIdx,
      "checagem/log de WEBSEARCH_BACKEND=agents deve vir ANTES da chamada a fetch-websearch-batch.ts — senão Path A roda à toa mesmo com o override setado",
    );
  });
});
