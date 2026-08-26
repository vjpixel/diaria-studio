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
  // #4574: orchestrator-stage-6.md nunca tinha sido incluído aqui (gap
  // pré-existente, não introduzido pela PR que fechou o gap — ver stage-6.ts
  // e o achado do review consolidado #4574) — o Stage 6 tem o mecanismo mais
  // crítico do pipeline (guard GATE-BLOCKING de slug do bloco WhatsApp,
  // #4570) e não tinha NENHUMA cobertura de snapshot/invariante-de-conteúdo.
  "orchestrator-stage-6.md",
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
      // #5415: +75 linhas líquidas (91 inserções, 16 remoções — cutover pro
      // runner determinístico `scripts/stage-0-run.ts`: bloco novo "Runner
      // determinístico" no topo do Stage 0 documentando o protocolo de 2
      // fases + interpretação do JSON de saída, e um marcador "(→ coberto
      // por stage-0-run.ts; referência/fallback)" em cada header de
      // subseção que o script cobre). A prosa detalhada de cada subseção
      // foi preservada de propósito — é o fallback se o script
      // faltar/falhar, e a documentação do que o script faz e por quê (a
      // issue #5415 pede explicitamente "não apagar a documentação").
      // Arquivo foi a 610 linhas (contagem de `content.split("\n").length`,
      // igual à usada por este teste). Teto bumped de 535→625 com headroom
      // pequeno.
      "orchestrator-stage-0-preflight.md": 625,
      // #4846: +9 linhas (novo passo 1y-bis — dispatch opcional/desligado
      // por padrão de scripts/experiment-d3-radar.ts logo após os invariants
      // pós-gate-apply, antes do sentinel do Stage 1). Teto bumped de
      // 810→825 com headroom (era 813 medido pós-#4846).
      // #4988/#4985/#4986: +2 linhas líquidas (contrato explícito da
      // transformação pool-flatten em §1g-ter + 2 checkpoints determinísticos
      // de integridade de `summary`, 1m-bis e 1q.3-bis — detalhe completo
      // movido pro histórico pra caber no budget). Teto bumped de 825→835
      // com headroom (era 826 medido pós-#4988/#4985/#4986).
      "orchestrator-stage-1-research.md": 835,
      // #3929: +11 linhas (snapshot pós-humanizador/pré-Clarice + diff legível
      // do social em §2c, 4º arg opcional de pré-Humanizador no clarice-diff.ts
      // da newsletter em §2b, e menção ao novo diff no gate §2d — decorrelaciona
      // o check humanizer-section-coverage de reversões legítimas da Clarice).
      // Teto bumped de 548→575 com headroom (era 559 medido pós-#3929).
      // #5414: +1 linha líquida — leitura de `CLARICE_REST` do
      // `preflight-state.json` (persistência em disco dos sinais do Stage 0,
      // em vez de memória de sessão — premissa de rodar stages com contexto
      // limpo) logo após a resolução de `{EDITION_DIR}`, substituindo o
      // consumo por variável de sessão em §3b. Arquivo foi a 576 linhas.
      // Teto bumped de 575→580 com headroom pequeno.
      "orchestrator-stage-2.md": 580,
      // #4258 item 3: +9 linhas (novo §3a-bis — passo de humanizador+Clarice
      // sobre a frase de descrição do É IA?, único texto da edição que não
      // passava por esse fluxo). Teto bumped de 135→150 com headroom (era
      // 142 medido pós-#4258).
      "orchestrator-stage-3.md": 150,
      // #3947: +14 linhas (snapshot pós-humanizador/pré-Clarice em §4d.1
      // passos 6.3 e 6.2' + fallback/uso desse snapshot no check
      // humanizer-section-coverage do passo 6.7 — mesmo padrão do #3929,
      // adaptado pro fluxo scoped/full-file de re-humanização do Stage 4).
      // Teto bumped de 648→665 com headroom (era 649 medido pós-#3947).
      // #4076: +18 linhas (chamada do novo lint `snippet-staleness` em §4c.2
      // + doc WARN-ONLY do check — guard de staleness de snippets/boxes de
      // divulgação pós-Stage-2). Teto bumped de 665→670 com headroom pequeno
      // (era 667 medido pós-#4076 — #4140 apertou de 685 pra 670: subir 20
      // pra cobrir 2 linhas de crescimento real pré-autorizava 18 linhas de
      // bloat futuro sem revisão).
      // #4361/#4352: +4 linhas (`--check-blocking` no fact-checker §4c.6 +
      // exit code 2 GATE-BLOCKING para NOT_FOUND_IN_SOURCE não-superlativo;
      // re-audit de no-antithesis-reveal/no-trailing-editorial-hook em §4c.6c
      // pós-autofix, promovidos de WARN-ONLY a GATE-BLOCKING em §4c.2b sem
      // linhas novas). Teto bumped de 670→674 com headroom pequeno (era 672
      // medido pós-#4361/#4352).
      // #4354 (merge subsequente): +15 linhas (nova §4c.7 — roda
      // `box-click-report.ts` e apresenta o ranking de boxes de divulgação
      // por clique no gate, seção `━━━ BOXES DE DIVULGAÇÃO` + regra de
      // apresentação do `{box_click_report_block}`). Já condensado (de ~22
      // linhas brutas pra 15) antes de bumpar. Teto bumped de 674→690 com
      // headroom pequeno pra cobrir os dois PRs combinados.
      // #4505 itens 2/3: +~32 linhas — item 2 (re-auditoria sistemática)
      // acrescenta as 2 chamadas GATE-BLOCKING de no-antithesis-reveal/
      // no-trailing-editorial-hook no passo 6.7 do loop "ajustar" (§4d.1),
      // fechando a lacuna que a recorrência ao vivo 260803 expôs (essas 2
      // chamadas já rodavam em §4c.2b/§4c.6c, mas não no loop de ajuste
      // inline); item 3 (critic pass opcional) acrescenta a nova §4c.6d
      // (dispatch condicional do subagente `social-critic` via
      // `run-social-critic.ts`, gated por `platform.config.json` →
      // `social_critic_pass.enabled`) + `{social_critic_block}` no template
      // do gate + nota no passo 7 do loop "ajustar" pra re-rodar quando
      // habilitado. Arquivo tinha 690 linhas (teto já saturado pelo #4354).
      // Teto bumped de 690→735 com headroom pequeno (era 721 medido pós-#4505).
      // #4636: +8 linhas — backstop `no-xml-artifacts` GATE-BLOCKING no
      // próprio loop "ajustar" (§4d.1): passo 2 re-audita 02-reviewed.md
      // logo após a edição inline via `Edit`, e o passo 6.7 ganha a mesma
      // chamada para 03-social.md, ao lado dos outros tic-lints re-auditados
      // (#4505 item 2). O lint GATE-BLOCKING de §4c.2/§4c.2b só rodava uma
      // vez, na montagem inicial do resumo — nenhum passo do loop "ajustar"
      // o re-executava, então uma tag vazada pela própria escrita do
      // orchestrator sobrevivia até a aprovação (caso real #4636, edição
      // 260805: só um mecanismo de auto-detecção em runtime achou e
      // corrigiu, nenhum lint determinístico). Arquivo tinha 743 linhas.
      // Teto bumped de 735→760 com headroom pequeno.
      // #5083: +2 linhas — fallback de ENOENT sob a junction OneDrive ao
      // gravar `_internal/fact-check.json` (subagente reporta path no
      // scratchpad, orchestrator copia pra `{EDITION_DIR}/_internal/` antes
      // de prosseguir). Arquivo foi a 762 linhas. Teto bumped de 760→765 com
      // headroom pequeno.
      // #5101: +12 linhas — §4c.1c, sugestão de meta description do D1
      // (`buildMetaDescriptionSuggestion`, pura/determinística, sem LLM) +
      // captura de `{meta_description_suggestion}` no gate (§4d) + nota no
      // glossário de variáveis. Puramente informativo, nunca bloqueia — o
      // editor decide se cola a sugestão (trade-off contra taxa de abertura
      // do e-mail). Arquivo foi a 777 linhas. Teto bumped de 765→780 com
      // headroom pequeno.
      // #5414: +11 linhas líquidas — persistência em disco (#5414) de
      // `{whatsapp_url}` (§4c.1b) e `{meta_description_suggestion}`
      // (§4c.1c) em `stage4-capture-state.json`, lidas de volta no início
      // do gate (§4d) em vez de "capturadas em sessão". Stage 4 é o mais
      // longo do pipeline (587 turnos medidos na auditoria do #5414) — o
      // objetivo é sobreviver a corte de contexto DENTRO do próprio stage,
      // não só entre stages. Arquivo foi a 791 linhas. Teto bumped de
      // 780→800 com headroom pequeno.
      "orchestrator-stage-4.md": 800,
      // #464 (PR #6096): +53 linhas (wiring do dispatch por backend —
      // `publishing.newsletter.backend`, #461: passo 5c-1-kit inteiro
      // [Newsletter Kit via `publish-newsletter-kit.ts`, sem browser
      // automation], branch condicional antes do 5c-1 Beehiiv, e o loop de
      // review §5f ganhou o branch Kit — `review-test-email` com
      // `platform: "kit"` e sem fix-mode automático nesse backend, mais o
      // guard do §5c-2 evitando o fallback de URL Beehiiv-específico
      // quando o backend é Kit). Arquivo foi a 508 linhas. Teto bumped de
      // 455→525 com headroom pequeno.
      "orchestrator-stage-5.md": 525,
      // #4574: 1º teto registrado pra este arquivo (nunca tinha entry —
      // ORCHESTRATOR_FILES não o incluía até esta PR). Arquivo tinha 491
      // linhas pós-fix do #4574 (guard de slug ganhou --out + log-event +
      // fail-closed de get_post + comando exato de halt banner + nota em
      // §6g). Teto com headroom pequeno, mesmo padrão dos demais.
      // #4966: +34 linhas (§6b2 — revisão de pedidos editoriais registrados
      // no gate 6, novo passo entre §6b e §6c). Arquivo foi a 545 linhas.
      // Teto bumped de 510→560 com headroom pequeno.
      // #5772: +33 linhas (agendamento do canal Brevo diária dentro do
      // MESMO gate humano do Schedule Beehiiv — leitura de
      // brevo-diaria-published.json em §6a, linha no resumo §6b, bloco no
      // prompt do gate §6c, e a seção nova §6d-brevo que invoca
      // schedule-daily-brevo.ts fail-soft após o Schedule Beehiiv
      // confirmado). Arquivo foi a 593 linhas. Teto bumped de 560→600 com
      // headroom pequeno.
      // #464 (PR #6096): +60 linhas (mesmo wiring por backend do lado do
      // Stage 6 — §6a lê `publishing.newsletter.backend` e ramifica de
      // onde vêm os campos do resumo; §6d ganhou a nota "só roda com
      // beehiiv"; §6d-kit inteiro, nova seção espelhando §6d-brevo, que
      // invoca `schedule-newsletter-kit.ts`; §6e ganhou o skip pra backend
      // kit; e a Pre-condição de sentinel Stage 5 ganhou a explicação de
      // por que `assertSentinel` já lê o path certo automaticamente).
      // Arquivo foi a 653 linhas. Teto bumped de 600→675 com headroom pequeno.
      // #6098 (26/08): +28 linhas do clique automatizado em Schedule — a
      // sequência de 3 cliques, o fallback manual obrigatório e o exit 3 novo
      // de `verify-scheduled-post.ts`. Teto 675→700. Cabe no prompt porque é
      // o passo que o orchestrator EXECUTA; virar link externo o tornaria
      // invisível justamente pra quem precisa segui-lo.
      // #6202 (26/08): +16 linhas do §6d-site (passo que publica a página da
      // edição no Worker `diaria-site`) — teto 700. O passo é o que
      // destrava a janela de cutover do #467, então cabe no prompt em vez de
      // virar link externo que o orchestrator não lê.
      "orchestrator-stage-6.md": 700,
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

describe("#3947: fluxo scoped/full-file de re-humanização social (§4d.1) não repete o falso-positivo do #3929", () => {
  // Follow-up do #3929 (PR #3946, Stage 2): o check humanizer-section-coverage
  // não pode comparar contra o `03-social.md` FINAL (pós-Clarice) — uma
  // reversão legítima da Clarice (ela desfaz uma edição de estilo do
  // Humanizador) faria a seção parecer "não coberta pelo humanizador". O
  // Stage 4 (§4d.1 passo 6, re-humanização scoped/full-file no loop "ajustar")
  // roda humanizador → Clarice na MESMA sequência do Stage 2 e tinha a mesma
  // vulnerabilidade (#3947) — o fix é gravar `03-social-post-humanizador.md`
  // ANTES de invocar a Clarice, em ambos os fluxos, e usar esse snapshot (não
  // o arquivo final) no passo 6.7.
  const stage4 = readFileSync(resolve(AGENTS_DIR, "orchestrator-stage-4.md"), "utf8");
  const section4d1 = stage4.slice(stage4.indexOf("### 4d.1"));

  it("fluxo SCOPED (passo 6.3): snapshot pós-humanizador é gravado ANTES da chamada à Clarice", () => {
    const snapshotIdx = section4d1.indexOf("03-social-post-humanizador.md");
    const clariceIdx = section4d1.indexOf("mcp__clarice__correct_text");
    assert.ok(snapshotIdx !== -1, "§4d.1 não menciona 03-social-post-humanizador.md — snapshot #3947 ausente");
    assert.ok(clariceIdx !== -1, "§4d.1 não menciona mcp__clarice__correct_text");
    assert.ok(
      snapshotIdx < clariceIdx,
      "#3947: snapshot pós-humanizador deve ser gravado ANTES da 1ª chamada à Clarice no fluxo SCOPED (6.3) — senão a Clarice já rodou quando o snapshot é tirado e ele deixa de refletir o estado pré-Clarice",
    );
  });

  it("fluxo FULL-FILE (passo 6.2'): snapshot pós-humanizador também é gravado ANTES da chamada à Clarice", () => {
    const fullFileIdx = section4d1.indexOf("Fluxo FULL-FILE");
    assert.ok(fullFileIdx !== -1, "§4d.1 não tem o fluxo FULL-FILE (6.2')");
    const afterFullFile = section4d1.slice(fullFileIdx);
    const snapshotIdx = afterFullFile.indexOf("03-social-post-humanizador.md");
    const clariceIdx = afterFullFile.indexOf("mcp__clarice__correct_text");
    assert.ok(snapshotIdx !== -1, "fluxo FULL-FILE não grava o snapshot 03-social-post-humanizador.md");
    assert.ok(clariceIdx !== -1, "fluxo FULL-FILE não menciona mcp__clarice__correct_text");
    assert.ok(
      snapshotIdx < clariceIdx,
      "#3947: no fluxo FULL-FILE (6.2') o snapshot também precisa ser gravado ANTES da Clarice",
    );
  });

  it("passo 6.7: humanizer-section-coverage usa o snapshot pós-humanizador (com fallback), não o 03-social.md final direto", () => {
    const step67Idx = section4d1.indexOf("**6.7**");
    assert.ok(step67Idx !== -1, "§4d.1 não tem o passo 6.7");
    const step67 = section4d1.slice(step67Idx, section4d1.indexOf("**6.8**"));
    assert.ok(
      step67.includes("COVERAGE_MD={EDITION_DIR}/_internal/03-social-post-humanizador.md"),
      "#3947: passo 6.7 deve resolver COVERAGE_MD para o snapshot pós-humanizador por default",
    );
    assert.ok(
      /\[\s*-f\s*"\$COVERAGE_MD"\s*\]/.test(step67),
      "#3947: passo 6.7 deve ter fallback condicional (existsSync equivalente) pro 03-social.md final quando o snapshot não existir (edições/checkpoints anteriores ao fix)",
    );
    assert.ok(
      step67.includes('--md "$COVERAGE_MD"'),
      "#3947: a chamada humanizer-section-coverage deve usar $COVERAGE_MD (resolvido acima), não {EDITION_DIR}/03-social.md hardcoded",
    );
  });
});

describe("#3953: passo 6.4 (verify-scoped-humanization.ts --post) usa o snapshot pós-humanizador, não o 03-social.md final", () => {
  // Follow-up do #3947 (PR #3952) — aquela PR corrigiu o passo 6.7
  // (humanizer-section-coverage) mas deixou o passo 6.4, ANTERIOR na mesma
  // seção, com o mesmo bug: --post apontava pro `03-social.md` FINAL
  // (pós-Clarice), quando o próprio docstring de verify-scoped-humanization.ts
  // documenta que --post deve ser o estado logo após o humanizador rodar
  // NESTA rodada scoped, antes da Clarice tocar `## post_pixel`. Fix #3953:
  // reusar o snapshot `03-social-post-humanizador.md` (já gravado no passo
  // 6.3/6.2' pelo #3947) como --post do passo 6.4, com o mesmo fallback
  // condicional usado no passo 6.7.
  const stage4 = readFileSync(resolve(AGENTS_DIR, "orchestrator-stage-4.md"), "utf8");
  const section4d1 = stage4.slice(stage4.indexOf("### 4d.1"));

  it("passo 6.4: verify-scoped-humanization.ts --post usa o snapshot pós-humanizador (com fallback), não {EDITION_DIR}/03-social.md hardcoded", () => {
    const step64Idx = section4d1.indexOf("**6.4**");
    assert.ok(step64Idx !== -1, "§4d.1 não tem o passo 6.4");
    const nextStepIdx = section4d1.indexOf("**Fluxo FULL-FILE", step64Idx);
    assert.ok(nextStepIdx !== -1, "§4d.1 não tem a seção 'Fluxo FULL-FILE' logo após o passo 6.4");
    const step64 = section4d1.slice(step64Idx, nextStepIdx);

    assert.ok(
      step64.includes("VERIFY_POST_MD={EDITION_DIR}/_internal/03-social-post-humanizador.md"),
      "#3953: passo 6.4 deve resolver VERIFY_POST_MD para o snapshot pós-humanizador por default",
    );
    assert.ok(
      /\[\s*-f\s*"\$VERIFY_POST_MD"\s*\]/.test(step64),
      "#3953: passo 6.4 deve ter fallback condicional pro 03-social.md final quando o snapshot não existir (edições/checkpoints anteriores ao #3947)",
    );
    assert.ok(
      step64.includes('--post "$VERIFY_POST_MD"'),
      "#3953: a chamada verify-scoped-humanization.ts deve usar $VERIFY_POST_MD (resolvido acima), não {EDITION_DIR}/03-social.md hardcoded",
    );
    assert.ok(
      !/--post\s+\{EDITION_DIR\}\/03-social\.md/.test(step64),
      "#3953 regressão: passo 6.4 não pode voltar a apontar --post direto pro {EDITION_DIR}/03-social.md (arquivo final, pós-Clarice)",
    );
  });

  it("passo 6.4 vem DEPOIS do snapshot pós-humanizador/pré-Clarice gravado no passo 6.3 (ordem já garantida pelo #3947)", () => {
    const snapshotIdx = section4d1.indexOf("03-social-post-humanizador.md");
    const step64Idx = section4d1.indexOf("**6.4**");
    assert.ok(snapshotIdx !== -1 && step64Idx !== -1);
    assert.ok(
      snapshotIdx < step64Idx,
      "#3953: o snapshot pós-humanizador (6.3) precisa existir ANTES do passo 6.4 tentar usá-lo como --post",
    );
  });
});

describe("#4258 item 3: §3a-bis (humanizador+Clarice na descrição do É IA?) preserva as invariantes operacionais", () => {
  // Achado do review consolidado (pr-test-analyzer): a única cobertura desta
  // seção era o teto de linhas + hash do snapshot — nenhum dos dois protege
  // linguagem semântica específica (ex: uma edição futura poderia remover o
  // "retry 3x + abort" e só quebraria via --update-snapshots, que é
  // exatamente o caminho sancionado pra mudanças intencionais).
  const stage3 = readFileSync(resolve(AGENTS_DIR, "orchestrator-stage-3.md"), "utf8");
  const section3aBis = stage3.slice(stage3.indexOf("### 3a-bis"), stage3.indexOf("### 3b."));

  it("existe e cobre os 4 passos (extract → humanizador → Clarice → apply)", () => {
    assert.ok(section3aBis.includes("extract-eia-description.ts"), "§3a-bis não menciona extract-eia-description.ts");
    assert.ok(section3aBis.includes('Skill("humanizador"'), "§3a-bis não invoca a skill humanizador");
    assert.ok(section3aBis.includes("mcp__clarice__correct_text"), "§3a-bis não menciona a Clarice");
    assert.ok(section3aBis.includes("apply-eia-description.ts"), "§3a-bis não menciona apply-eia-description.ts");
  });

  it("passo 2 (humanizador) E passo 3 (Clarice) exigem retry 3x + abort Stage 3 — nenhum dos dois pode falhar em silêncio (#1072)", () => {
    const step2Idx = section3aBis.indexOf("Skill(\"humanizador\"");
    const step3Idx = section3aBis.indexOf("Clarice inline");
    assert.ok(step2Idx !== -1 && step3Idx !== -1);
    const step2Text = section3aBis.slice(step2Idx, step3Idx);
    const step4Idx = section3aBis.indexOf("apply-eia-description.ts", step3Idx);
    const step3Text = section3aBis.slice(step3Idx, step4Idx);
    assert.ok(
      /retry 3x.*abort stage 3/i.test(step2Text),
      "#4258 item 3: passo 2 (humanizador) precisa do mandato explícito 'retry 3x + abort Stage 3' (#1072)",
    );
    assert.ok(
      /retry 3x.*abort stage 3/i.test(step3Text),
      "#4258 item 3 (achado do review consolidado): passo 3 (Clarice) precisa do MESMO mandato do passo 2 — sem isso, uma falha da Clarice (MCP + fallback REST) cai no exit 2/3 de apply-eia-description.ts sem o orchestrator saber que deveria abortar em vez de prosseguir",
    );
  });

  it("instrui a rejeitar sugestões de formalização da Clarice, preservando a voz casual do produto", () => {
    assert.ok(
      /formaliza|"pra".*"para"/.test(section3aBis),
      "#4258 item 3: §3a-bis precisa instruir explicitamente a rejeitar formalização da Clarice (decisão do editor nesta sessão — a voz do produto é deliberadamente casual)",
    );
  });

  it("passo 1 (extract-eia-description.ts) distingue exit 2 (skip benigno) de exit 3 (erro de verdade) — não conflar os dois", () => {
    const step1Idx = section3aBis.indexOf("extract-eia-description.ts");
    const step2Idx = section3aBis.indexOf("Skill(\"humanizador\"");
    const step1Text = section3aBis.slice(step1Idx, step2Idx);
    assert.ok(/exit `2`/i.test(step1Text) && /exit `3`/i.test(step1Text), "passo 1 precisa documentar exit 2 E exit 3 distintos");
    assert.ok(
      /skip pra 3b/i.test(step1Text) && /halt banner/i.test(step1Text),
      "#4258 item 3 (achado do review consolidado): exit 2 (skip benigno) e exit 3 (halt banner, erro de verdade) do passo 1 não podem ser conflados na mesma ação",
    );
  });

  it("#4281: passo 4 (apply-eia-description.ts) NÃO tem mais skip benigno — todo erro (inclusive compose-context.json ausente) é halt banner", () => {
    // Antes do #4281, passo 4 tinha exit 2 (skip benigno, "sem abortar") pra
    // 01-eia-compose-context.json ausente, sob a premissa de que só acontecia
    // em edições pré-#4258. Post-mortem 260729 provou a premissa falsa — o
    // skip silencioso deixou a descrição em inglês numa edição pós-#4258. A
    // prosa agora documenta só exit 3 (sempre halt), nunca mais "sem abortar".
    const step4Idx = section3aBis.indexOf("apply-eia-description.ts", section3aBis.indexOf("Clarice inline"));
    const step4Text = section3aBis.slice(step4Idx);
    assert.ok(/exit `3`/i.test(step4Text), "passo 4 precisa documentar exit 3");
    assert.ok(!/exit `2`/i.test(step4Text), "#4281: passo 4 não deve mais documentar um exit 2 benigno pra apply-eia-description.ts");
    assert.ok(!/sem abortar/i.test(step4Text), "#4281: passo 4 não deve mais ter caminho 'sem abortar' — todo erro é halt banner");
    assert.ok(/halt banner/i.test(step4Text), "#4281: passo 4 precisa manter o halt banner pra qualquer erro");
  });
});

describe("#4505 item 2: re-auditoria sistemática dos tic-lints no loop 'ajustar' (§4d.1 passo 6.7)", () => {
  // A #4352 promoveu no-antithesis-reveal/no-trailing-editorial-hook pra
  // GATE-BLOCKING e os chamou incondicionalmente em §4c.2b + de novo em
  // §4c.6c (pós autofix de fact-check) — mas o loop "ajustar" (§4d.1, edição
  // inline no chat) tinha seu PRÓPRIO conjunto de re-lints no passo 6.7 que
  // não incluía os 2 tic-lints. Recorrência ao vivo na edição 260803 (#4505):
  // uma correção mecânica de travessão→pontuação aplicada via "ajustar"
  // reintroduziu antítese-revelação 3x seguidas na mesma sessão, cada uma só
  // pega porque o EDITOR notou e pediu "passa o humanizador de novo" — sem
  // re-auditoria automática no passo 6.7, nada fechava esse loop sozinho.
  const stage4 = readFileSync(resolve(AGENTS_DIR, "orchestrator-stage-4.md"), "utf8");
  const section4d1 = stage4.slice(stage4.indexOf("### 4d.1"));

  function step67Text(): string {
    const step67Idx = section4d1.indexOf("**6.7**");
    const step68Idx = section4d1.indexOf("**6.8**");
    assert.ok(step67Idx !== -1 && step68Idx !== -1, "§4d.1 precisa ter os passos 6.7 e 6.8");
    return section4d1.slice(step67Idx, step68Idx);
  }

  it("passo 6.7 roda no-antithesis-reveal E no-trailing-editorial-hook sobre 03-social.md", () => {
    const step67 = step67Text();
    assert.ok(
      step67.includes("--check no-antithesis-reveal --md {EDITION_DIR}/03-social.md"),
      "#4505 item 2: passo 6.7 precisa re-rodar no-antithesis-reveal — mesmo tic-lint GATE-BLOCKING de §4c.2b/§4c.6c, agora também no loop 'ajustar'",
    );
    assert.ok(
      step67.includes("--check no-trailing-editorial-hook --md {EDITION_DIR}/03-social.md"),
      "#4505 item 2: passo 6.7 precisa re-rodar no-trailing-editorial-hook — mesmo tic-lint GATE-BLOCKING de §4c.2b/§4c.6c, agora também no loop 'ajustar'",
    );
  });

  it("passo 6.7 documenta os 2 tic-lints como GATE-BLOCKING (não apenas informativo)", () => {
    const step67 = step67Text();
    const ticLintsIdx = step67.indexOf("no-trailing-editorial-hook --md {EDITION_DIR}/03-social.md");
    assert.ok(ticLintsIdx !== -1);
    const afterTicLints = step67.slice(ticLintsIdx);
    assert.ok(
      /\*\*GATE-BLOCKING\*\*/.test(afterTicLints),
      "#4505 item 2: a re-auditoria dos tic-lints no passo 6.7 precisa ser GATE-BLOCKING, não apenas um warning — senão o loop 'ajustar' reabre exatamente a lacuna que a recorrência ao vivo 260803 expôs",
    );
    assert.ok(
      /4505/.test(afterTicLints),
      "passo 6.7 deve referenciar #4505 — rastreabilidade do porquê da re-auditoria explícita aqui",
    );
  });

  it("os 2 tic-lints do passo 6.7 vêm ANTES do passo 6.8 (re-confirmação do sentinel)", () => {
    const step67Idx = section4d1.indexOf("**6.7**");
    const ticLintIdx = section4d1.indexOf("--check no-antithesis-reveal --md {EDITION_DIR}/03-social.md", step67Idx);
    const step68Idx = section4d1.indexOf("**6.8**");
    assert.ok(step67Idx !== -1 && ticLintIdx !== -1 && step68Idx !== -1);
    assert.ok(
      step67Idx < ticLintIdx && ticLintIdx < step68Idx,
      "#4505 item 2: os tic-lints devem rodar DENTRO do passo 6.7, antes do passo 6.8 voltar ao gate",
    );
  });
});

describe("#4636: backstop no-xml-artifacts no próprio loop 'ajustar' (§4d.1)", () => {
  // O #4077 tinha corrigido o vazamento de tag de tool-call crua
  // (</content>, </invoke>, </function_calls>) na fonte conhecida na época
  // (chat drawer do Studio, saveReviewFile) + backstop via lint GATE-BLOCKING
  // no Stage 4 (§4c.2/§4c.2b). Mas esse lint roda só UMA VEZ, na montagem
  // inicial do resumo consolidado, ANTES do primeiro gate — o loop "ajustar"
  // (§4d.1) faz o PRÓPRIO orchestrator aplicar `Edit` diretamente em
  // `02-reviewed.md` (passo 2) e, às vezes, em `03-social.md` (passo 4/6),
  // sem nunca re-rodar esse lint depois. Recorrência ao vivo (#4636, edição
  // 260805): uma tag vazou por essa via e só foi pega por um mecanismo de
  // auto-detecção em runtime do próprio orchestrator — não por nenhum lint
  // determinístico. Este teste garante que o loop "ajustar" agora re-audita
  // os dois arquivos que ele pode escrever.
  const stage4 = readFileSync(resolve(AGENTS_DIR, "orchestrator-stage-4.md"), "utf8");
  const section4d1 = stage4.slice(stage4.indexOf("### 4d.1"));

  it("passo 2 roda no-xml-artifacts sobre 02-reviewed.md logo após a edição inline, como GATE-BLOCKING", () => {
    const step2Idx = section4d1.indexOf("**Aplicar edição cirúrgica**");
    const step3Idx = section4d1.indexOf("**Cascata de título");
    assert.ok(step2Idx !== -1 && step3Idx !== -1, "§4d.1 precisa ter os passos 2 e 3");
    const step2Text = section4d1.slice(step2Idx, step3Idx);
    assert.ok(
      step2Text.includes("--check no-xml-artifacts --md {EDITION_DIR}/02-reviewed.md"),
      "#4636: passo 2 do loop 'ajustar' precisa re-rodar no-xml-artifacts sobre 02-reviewed.md — o lint de §4c.2 só roda uma vez, antes do primeiro gate, e não cobre edições inline aplicadas depois",
    );
    assert.ok(
      /\*\*GATE-BLOCKING\*\*/.test(step2Text),
      "#4636: a verificação no passo 2 precisa ser GATE-BLOCKING, não apenas informativa",
    );
    assert.ok(/4636/.test(step2Text), "passo 2 deve referenciar #4636 — rastreabilidade da recorrência");
  });

  it("passo 6.7 roda no-xml-artifacts sobre 03-social.md, no mesmo bloco dos outros tic-lints re-auditados", () => {
    const step67Idx = section4d1.indexOf("**6.7**");
    const step68Idx = section4d1.indexOf("**6.8**");
    assert.ok(step67Idx !== -1 && step68Idx !== -1, "§4d.1 precisa ter os passos 6.7 e 6.8");
    const step67Text = section4d1.slice(step67Idx, step68Idx);
    assert.ok(
      step67Text.includes("--check no-xml-artifacts --md {EDITION_DIR}/03-social.md"),
      "#4636: passo 6.7 precisa re-rodar no-xml-artifacts sobre 03-social.md — o mesmo risco de tag vazada existe quando o orchestrator reescreve ## post_pixel ou re-humaniza dentro do loop 'ajustar'",
    );
    assert.ok(
      /\*\*GATE-BLOCKING\*\*/.test(step67Text),
      "#4636: a verificação no passo 6.7 precisa ser GATE-BLOCKING, não apenas informativa — mesmo padrão do passo 2 (linha acima)",
    );
    assert.ok(/4636/.test(step67Text), "passo 6.7 deve referenciar #4636 — rastreabilidade da recorrência");
  });
});

describe("#4505 item 3: critic pass social opcional (§4c.6d)", () => {
  // Item 3 da issue #4505 — um subagente dedicado, OPCIONAL (flag em
  // platform.config.json), que faz 1 leitura holística final perguntando
  // "isso ainda soa como IA?" (passos 6-7 do rubric de 9 passos da skill
  // humanizador) sobre 03-social.md já com todas as correções mecânicas
  // aplicadas — cobre tiques que os 2 tic-lints determinísticos (regex) não
  // reconhecem.
  const stage4 = readFileSync(resolve(AGENTS_DIR, "orchestrator-stage-4.md"), "utf8");
  const section4c6d = stage4.slice(stage4.indexOf("**4c.6d"), stage4.indexOf("**4c.7"));

  it("§4c.6d existe e referencia o flag opt-in social_critic_pass.enabled", () => {
    assert.ok(section4c6d.length > 0, "§4c.6d não encontrada em orchestrator-stage-4.md");
    assert.ok(
      section4c6d.includes("social_critic_pass.enabled"),
      "§4c.6d precisa checar platform.config.json → social_critic_pass.enabled (opt-in, #4505 item 3)",
    );
    assert.ok(
      /default `false`/.test(section4c6d) || /default.*false/.test(section4c6d),
      "§4c.6d precisa deixar explícito que o default é desligado (custo extra por edição)",
    );
  });

  it("§4c.6d dispatcha run-social-critic.ts em modo descoberta e trata exit 2 como skip (não erro)", () => {
    assert.ok(section4c6d.includes("run-social-critic.ts --edition-dir"), "§4c.6d precisa chamar run-social-critic.ts");
    assert.ok(
      /`2`.*desabilitado/.test(section4c6d) || /desabilitado.*pular/i.test(section4c6d),
      "§4c.6d precisa tratar exit 2 (desabilitado) como skip silencioso, nunca como falha",
    );
  });

  it("§4c.6d dispatcha o subagente social-critic via Agent tool", () => {
    assert.ok(
      section4c6d.includes('Agent("social-critic"'),
      "§4c.6d precisa dispatchar Agent(\"social-critic\", {...})",
    );
  });

  it("§4c.6d é warning-only — nunca bloqueia o gate", () => {
    assert.ok(
      /nunca bloqueia/i.test(section4c6d),
      "§4c.6d precisa deixar explícito que o critic pass é warning-only (não-bloqueante), análogo ao image-crop-reviewer #3951",
    );
  });

  it("o template do gate (§4d) referencia {social_critic_block} logo após {fact_check_block}", () => {
    const gateTemplateIdx = stage4.indexOf("{fact_check_block}");
    const boxesIdx = stage4.indexOf("━━━ BOXES DE DIVULGAÇÃO");
    assert.ok(gateTemplateIdx !== -1 && boxesIdx !== -1);
    const between = stage4.slice(gateTemplateIdx, boxesIdx);
    assert.ok(
      between.includes("{social_critic_block}"),
      "o template do gate precisa incluir {social_critic_block} entre {fact_check_block} e a seção de BOXES DE DIVULGAÇÃO",
    );
  });

  it("'Regras de apresentação' documenta {social_critic_block} (presente só quando habilitado)", () => {
    const regrasIdx = stage4.indexOf("Regras de apresentação:");
    assert.ok(regrasIdx !== -1);
    const regrasSection = stage4.slice(regrasIdx, regrasIdx + 2000);
    assert.ok(
      regrasSection.includes("{social_critic_block}"),
      "'Regras de apresentação' precisa documentar a regra de {social_critic_block}",
    );
  });

  it("o passo 7 do loop 'ajustar' (§4d.1) menciona re-rodar o critic pass quando habilitado", () => {
    const section4d1 = stage4.slice(stage4.indexOf("### 4d.1"));
    const step7Idx = section4d1.indexOf("7. **Voltar ao §4d**");
    assert.ok(step7Idx !== -1, "§4d.1 precisa ter o passo 7 (voltar ao gate)");
    const step7Text = section4d1.slice(step7Idx, step7Idx + 600);
    assert.ok(
      /social_critic_pass\.enabled/.test(step7Text),
      "#4505 item 3: passo 7 do loop 'ajustar' precisa mencionar que o critic pass é re-rodado quando social_critic_pass.enabled — um ajuste pode reintroduzir um tique que uma rodada anterior não tinha",
    );
  });
});

describe("#4942: §1x (GATE HUMANO) guarda contra auto_approve", () => {
  // Antes do #4942, §1x nunca mencionava auto_approve — o executor
  // apresentava o gate humano incondicionalmente, inclusive em
  // /diaria-edicao modo pre-gate (#1523, Stages 1-3 sempre
  // auto_approve=true) e em /diaria-1-pesquisa --no-gates isolado. Guard:
  // a nota logo após o header ### 1x precisa instruir explicitamente o
  // skip da seção inteira quando auto_approve=true, no mesmo padrão já
  // usado em §6c (orchestrator-stage-6.md) e no gate de fact-check de
  // orchestrator-stage-4.md.
  const content = readFileSync(resolve(AGENTS_DIR, "orchestrator-stage-1-research.md"), "utf8");
  const section1x = content.slice(
    content.indexOf("### 1x. GATE HUMANO"),
    content.indexOf("### 1y. Pós-gate"),
  );

  it("§1x existe e foi isolada corretamente para o slice do teste", () => {
    assert.ok(section1x.length > 0, "slice de §1x vazio — âncoras de indexOf não bateram");
  });

  it("§1x menciona auto_approve na guarda logo após o header (antes do passo 1 'Apresentar ao usuário')", () => {
    const passo1Idx = section1x.indexOf("1. **Instrução de revisão**");
    assert.ok(passo1Idx !== -1, "§1x deve conter o passo 1 'Instrução de revisão'");
    const guardText = section1x.slice(0, passo1Idx);
    assert.ok(
      /auto_approve\s*=\s*true/.test(guardText),
      "§1x precisa checar 'auto_approve = true' ANTES do passo 1 (apresentação do gate) — senão o executor apresenta o gate incondicionalmente",
    );
  });

  it("a guarda instrui pular a seção inteira e ir direto para §1y via apply-gate-edits.ts --auto", () => {
    const passo1Idx = section1x.indexOf("1. **Instrução de revisão**");
    const guardText = section1x.slice(0, passo1Idx);
    assert.ok(
      /pule esta seção inteira/i.test(guardText),
      "a guarda precisa instruir explicitamente pular a seção inteira (não só 'omitir X')",
    );
    assert.ok(
      guardText.includes("§1y") && guardText.includes("apply-gate-edits.ts --auto"),
      "a guarda precisa apontar pro caminho pós-gate correto (§1y, apply-gate-edits.ts --auto) — não deixar o executor sem próximo passo",
    );
  });
});

describe("#5566: caminho erro-intencional-placeholder do Stage 4 referencia o filtro de segurança do #3808", () => {
  // Achado ao vivo na edição 260818: o Stage 2 pulou a declaração do erro
  // intencional e o Stage 4 precisou propor um candidato sozinho, no gate,
  // sem nenhuma instrução no playbook lembrando de consultar
  // context/editorial-rules.md §10 (Regra 1 — verificável sem sair do
  // e-mail; Regra 2 — não gerar desinformação) nem o mesmo filtro de 3
  // diretrizes já documentado em orchestrator-stage-2.md. Guard: o parágrafo
  // do check `erro-intencional-placeholder` em §4c.2 precisa referenciar
  // explicitamente editorial-rules.md §10 e o filtro de segurança de Stage 2.
  const stage4 = readFileSync(resolve(AGENTS_DIR, "orchestrator-stage-4.md"), "utf8");
  const checkIdx = stage4.indexOf("`erro-intencional-placeholder`");

  it("§4c.2 documenta o check `erro-intencional-placeholder`", () => {
    assert.ok(checkIdx !== -1, "orchestrator-stage-4.md não menciona o check erro-intencional-placeholder");
  });

  it("o parágrafo referencia explicitamente editorial-rules.md §10", () => {
    assert.ok(checkIdx !== -1, "orchestrator-stage-4.md não menciona o check erro-intencional-placeholder (mesma causa-raiz do teste anterior)");
    const nextCheckIdx = stage4.indexOf("`secondary-items-have-summary`", checkIdx + 1);
    assert.ok(nextCheckIdx !== -1 && nextCheckIdx > checkIdx);
    const paragraph = stage4.slice(checkIdx, nextCheckIdx);
    assert.ok(
      /editorial-rules\.md.*§10/.test(paragraph),
      "#5566: o parágrafo de erro-intencional-placeholder precisa referenciar context/editorial-rules.md §10 explicitamente",
    );
    assert.ok(
      /Filtro de segurança ao PROPOR candidatos/.test(paragraph) && /#3808/.test(paragraph),
      "#5566: o parágrafo precisa referenciar o mesmo 'Filtro de segurança ao PROPOR candidatos' (#3808) documentado em orchestrator-stage-2.md",
    );
    assert.ok(
      paragraph.includes("orchestrator-stage-2.md"),
      "#5566: o parágrafo precisa apontar de volta pro orchestrator-stage-2.md, onde o filtro completo vive",
    );
    assert.ok(
      /GATE-BLOCKING/.test(paragraph),
      "o caminho erro-intencional-placeholder precisa continuar documentado como GATE-BLOCKING no Stage 4",
    );
  });

  it("distingue o check de narrativa MD (erro-intencional-placeholder) do check de campos JSON (intentional-error-flagged), sem conflar os dois (achado do review consolidado)", () => {
    assert.ok(checkIdx !== -1);
    const nextCheckIdx = stage4.indexOf("`secondary-items-have-summary`", checkIdx + 1);
    assert.ok(nextCheckIdx !== -1 && nextCheckIdx > checkIdx);
    const paragraph = stage4.slice(checkIdx, nextCheckIdx);
    // erro-intencional-placeholder cobre só a narrativa MD — não deve alegar
    // que valida os campos estruturados do JSON (essa é responsabilidade do
    // check irmão intentional-error-flagged, historicamente só rodado no
    // Stage 5 — ver scripts/lib/lint-checks/intentional-error.ts).
    assert.ok(
      paragraph.includes("intentional-error-flagged"),
      "#5566: o parágrafo precisa citar o check irmão intentional-error-flagged (campos JSON), não só erro-intencional-placeholder (narrativa MD) — os dois são checks distintos em scripts/lint-newsletter-md.ts",
    );
    assert.ok(
      /--check erro-intencional-placeholder --md \{EDITION_DIR\}\/02-reviewed\.md/.test(paragraph) &&
        /--check intentional-error-flagged --md \{EDITION_DIR\}\/02-reviewed\.md/.test(paragraph),
      "#5566: o Stage 4 precisa rodar OS DOIS checks (narrativa MD + campos JSON) antes do gate, GATE-BLOCKING — não basta re-checar só erro-intencional-placeholder, que nunca lê _internal/intentional-error.json",
    );
  });

  it("orchestrator-stage-2.md ainda documenta o filtro de segurança original (fonte da verdade não duplicada)", () => {
    const stage2 = readFileSync(resolve(AGENTS_DIR, "orchestrator-stage-2.md"), "utf8");
    assert.ok(
      stage2.includes("Filtro de segurança ao PROPOR candidatos"),
      "orchestrator-stage-2.md deve seguir sendo a fonte do filtro de segurança referenciado pelo Stage 4",
    );
  });
});

describe("#6003: gate de revisão publica newsletter/social como Artifact, em paralelo ao preview local", () => {
  // Caso real que motivou (sessão 260824): o editor pediu "coloque em
  // artefatos" no meio do gate porque o link 127.0.0.1 não servia pra
  // revisão remota. Guard: os dois pontos de publicação inicial (§4b step
  // 2b / step 3) e os dois pontos de re-render (§4c.6b newsletter / social)
  // precisam chamar a tool Artifact sobre a MESMA variante embedded já
  // usada pelo preview local, com fallback warning-only, e o gate (§4d)
  // precisa expor as duas URLs resultantes.
  const stage4 = readFileSync(resolve(AGENTS_DIR, "orchestrator-stage-4.md"), "utf8");

  it("§4b step 2b publica a variante embedded da newsletter como Artifact", () => {
    assert.ok(
      /Artifact\(file_path: "\{EDITION_DIR\}\/_internal\/newsletter-final-embedded\.html"/.test(stage4),
      "step 2b precisa chamar Artifact() sobre newsletter-final-embedded.html (mesmo arquivo do preview local)",
    );
    assert.ok(
      stage4.includes("newsletter_artifact_url"),
      "a URL do Artifact da newsletter precisa ser persistida como newsletter_artifact_url",
    );
  });

  it("§4b step 3 publica a variante embedded do social como Artifact", () => {
    assert.ok(
      /Artifact\(file_path: "\{EDITION_DIR\}\/_internal\/social-preview-embedded\.html"/.test(stage4),
      "step 3 precisa chamar Artifact() sobre social-preview-embedded.html (mesmo arquivo do preview local)",
    );
    assert.ok(
      stage4.includes("social_artifact_url"),
      "a URL do Artifact do social precisa ser persistida como social_artifact_url",
    );
  });

  it("re-render de §4c.6b (fact-check autofix) re-publica o Artifact da newsletter", () => {
    const reRenderIdx = stage4.indexOf("Re-render obrigatório quando `applied > 0`");
    assert.ok(reRenderIdx !== -1, "§4c.6b (re-render obrigatório) não encontrado");
    const nextIdx = stage4.indexOf("Re-render do social quando", reRenderIdx);
    assert.ok(nextIdx !== -1 && nextIdx > reRenderIdx);
    const slice = stage4.slice(reRenderIdx, nextIdx);
    assert.ok(
      /Re-publicar o Artifact também/.test(slice) && slice.includes("newsletter_artifact_url"),
      "o bloco de re-render pós-autofix da newsletter precisa re-publicar o Artifact (mesmo file_path, redeploy pra mesma URL)",
    );
  });

  it("re-render social (social_modified) re-publica o Artifact do social", () => {
    const reRenderIdx = stage4.indexOf("Re-render do social quando");
    assert.ok(reRenderIdx !== -1, "bloco de re-render do social não encontrado");
    const nextIdx = stage4.indexOf("Confirmar que o sentinel bate", reRenderIdx);
    assert.ok(nextIdx !== -1 && nextIdx > reRenderIdx);
    const slice = stage4.slice(reRenderIdx, nextIdx);
    assert.ok(
      /Re-publicar o Artifact social também/.test(slice) && slice.includes("social_artifact_url"),
      "o bloco de re-render do social precisa re-publicar o Artifact (mesmo file_path, redeploy pra mesma URL)",
    );
  });

  it("o resumo do gate (§4d) expõe as duas URLs de Artifact", () => {
    const gateTemplateIdx = stage4.indexOf("REVISÃO EDITORIAL — Edição");
    assert.ok(gateTemplateIdx !== -1, "template do gate não encontrado");
    const gateEndIdx = stage4.indexOf("Regras de apresentação:", gateTemplateIdx);
    assert.ok(gateEndIdx !== -1 && gateEndIdx > gateTemplateIdx);
    const gateSlice = stage4.slice(gateTemplateIdx, gateEndIdx);
    assert.ok(
      gateSlice.includes("{newsletter_artifact_url}") && gateSlice.includes("{social_artifact_url}"),
      "o template do gate precisa exibir {newsletter_artifact_url} e {social_artifact_url} ao lado dos previews locais",
    );
  });

  it("indisponibilidade da tool Artifact é warning-only, nunca bloqueia o gate", () => {
    assert.ok(
      /warning-only, nunca bloqueia o gate/.test(stage4) && stage4.includes("newsletter_artifact_url"),
      "a falha/indisponibilidade da tool Artifact precisa estar documentada como warning-only (nunca gate-blocking)",
    );
  });

  it("Artifacts publicados não entram no teardown de fim de gate (sobrevivem à sessão, ao contrário do preview local)", () => {
    assert.ok(
      /Artifacts \(#6003\) não fazem parte deste teardown/.test(stage4),
      "o teardown de §4d/§4e precisa deixar explícito que Artifacts publicados não são derrubados (diferente do preview local via --stop-pid)",
    );
  });
});
