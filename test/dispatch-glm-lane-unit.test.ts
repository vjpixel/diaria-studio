/**
 * test/dispatch-glm-lane-unit.test.ts (#6930/#6941)
 *
 * Trava as propriedades MECÂNICAS que `docs/lane-glm.md` exige da condição
 * (b) — produtor apenas, imposto por `--tools`, nunca por instrução de
 * prompt (mesma disciplina do #6864/#6849 já aplicada a
 * `continuo-pr-review.sh`) — e (c) — `--model z-ai/glm-5.3-flash` sempre
 * explícito. Lê o SOURCE do script (mesmo padrão de
 * `test/continuo-pr-review-never-merges.test.ts`), não o executa.
 *
 * #6941 (achado de review, code-reviewer, P0, confiança alta, demonstrado
 * AO VIVO no sandbox): `Bash(git:*)` permite `git push origin
 * HEAD:master`; `Bash(npm:*)`/`Bash(npx:*)` permitem `npm exec -- gh pr
 * merge ...`, executando o `gh` real por uma invocação que não começa com
 * `gh` — driblando o allowlist inteiro. As checagens de "sem Bash
 * genérico" abaixo cobrem ESSA classe específica, não só a ausência
 * textual de `gh pr merge`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = resolve(ROOT, "scripts/dispatch-glm-lane-unit.sh");

function readScript(): string {
  return readFileSync(SCRIPT_PATH, "utf8");
}

function extractToolsValue(src: string): string {
  const m = src.match(/--tools\s+"([^"]+)"/);
  assert.ok(m, 'não encontrou --tools "..." no script');
  return m![1];
}

const FORBIDDEN_TOOL_SUBSTRINGS = ["gh pr merge", "gh pr review", "gh issue close", "gh issue edit"];

describe("dispatch-glm-lane-unit.sh — condição (b) do docs/lane-glm.md, produtor apenas", () => {
  it("--tools nunca contém gh pr merge/review nem gh issue close/edit", () => {
    const value = extractToolsValue(readScript());
    for (const forbidden of FORBIDDEN_TOOL_SUBSTRINGS) {
      assert.ok(!value.includes(forbidden), `--tools contém '${forbidden}' — condição (b) do lane-glm.md violada`);
    }
  });

  it("--tools não usa 'Bash' genérico/irrestrito (teria que ser Bash(cmd:*) escopado)", () => {
    const value = extractToolsValue(readScript());
    const parts = value.split(",");
    assert.ok(!parts.includes("Bash"), "--tools inclui 'Bash' sem escopo — reabre exatamente o que o #6864 fechou");
  });

  it("#6941 P0: --tools nunca contém Bash(git:*) genérico — permitiria 'git push origin HEAD:master'", () => {
    const value = extractToolsValue(readScript());
    const parts = value.split(",");
    assert.ok(!parts.includes("Bash(git:*)"), "--tools contém Bash(git:*) sem escopo — permite push direto pra master");
  });

  it("#6941 P0: --tools nunca contém Bash(npm:*) genérico — permitiria 'npm exec -- gh pr merge'", () => {
    const value = extractToolsValue(readScript());
    const parts = value.split(",");
    assert.ok(!parts.includes("Bash(npm:*)"), "--tools contém Bash(npm:*) sem escopo — permite 'npm exec -- gh ...'");
  });

  it("#6941 P0: --tools nunca contém Bash(npx:*) genérico — permitiria rodar qualquer pacote/binário via npx", () => {
    const value = extractToolsValue(readScript());
    const parts = value.split(",");
    assert.ok(!parts.includes("Bash(npx:*)"), "--tools contém Bash(npx:*) sem escopo");
  });

  it("#6941: cada pattern Bash(git ...) presente é um subcomando de escrita local seguro (add/commit/status/diff/log/branch/push escopado à branch)", () => {
    const value = extractToolsValue(readScript());
    const gitPatterns = value.split(",").filter((p) => p.startsWith("Bash(git "));
    assert.ok(gitPatterns.length > 0, "esperava pelo menos 1 pattern Bash(git ...)");
    const SAFE_GIT_PREFIXES = ["Bash(git add:", "Bash(git commit:", "Bash(git status:", "Bash(git diff:", "Bash(git log:", "Bash(git branch:", "Bash(git push -u origin "];
    for (const pattern of gitPatterns) {
      assert.ok(
        SAFE_GIT_PREFIXES.some((prefix) => pattern.startsWith(prefix)),
        `pattern git '${pattern}' não está na allowlist de prefixos seguros conhecidos`,
      );
    }
  });

  it("#6941: git push é escopado à branch EXATA desta unidade ($BRANCH interpolado), nunca uma branch arbitrária", () => {
    const src = readScript();
    const value = extractToolsValue(src);
    assert.match(value, /Bash\(git push -u origin \$\{BRANCH\}:\*\)/, "git push deveria ser escopado a ${BRANCH}, a variável da branch desta unidade");
  });

  it("--tools inclui gh pr create (o produtor PRECISA poder abrir PR)", () => {
    const value = extractToolsValue(readScript());
    assert.ok(value.includes("gh pr create"), "--tools deveria permitir 'gh pr create' — sem isso o lane não produz nada");
  });
});

describe("dispatch-glm-lane-unit.sh — condição (c), --model sempre explícito", () => {
  it("invocação do claude-openrouter.sh sempre passa --model z-ai/glm-5.3-flash", () => {
    const src = readScript();
    assert.match(src, /--model\s+z-ai\/glm-5\.3-flash/);
  });
});

describe("dispatch-glm-lane-unit.sh — claim-issue é responsabilidade do COORDENADOR, nunca deste script (#6941)", () => {
  // #6941 (achado ao vivo nesta sessão): --session-id só é injetado
  // automaticamente numa chamada de TOPO da ferramenta Bash — nunca numa
  // chamada enterrada dentro de um script. Um `claim-issue` invocado
  // DAQUI sempre falharia com "--session-id ausente". O script correto
  // só CONFERE a claim (is-claimed, leitura pura, sem session_id) e
  // recusa se não achar.
  it("o script NUNCA invoca claim-issue como comando real (só menciona em comentário/mensagem, ou chama is-claimed)", () => {
    const src = readScript();
    const lines = src.split("\n");
    const realInvocation = lines.find((l) => /^\s*npx tsx scripts\/lib\/session-registry\.ts claim-issue/.test(l));
    assert.ok(!realInvocation, `encontrou uma invocação REAL de claim-issue (não comentário/echo): ${realInvocation}`);
  });

  it("o script chama is-claimed ANTES do gate de critérios de morte", () => {
    const src = readScript();
    const isClaimedIdx = src.indexOf("IS_CLAIMED_OUT=$(npx tsx scripts/lib/session-registry.ts is-claimed");
    const gateIdx = src.indexOf("GATE_JSON=$(npx tsx scripts/check-glm-lane-gate.ts");
    assert.ok(isClaimedIdx !== -1, "script deveria chamar is-claimed");
    assert.ok(gateIdx !== -1, "script deveria chamar check-glm-lane-gate.ts");
    assert.ok(isClaimedIdx < gateIdx, "is-claimed deveria ser checado ANTES do gate");
  });

  it("is-claimed recusado sai o script com erro (exit 1)", () => {
    const src = readScript();
    const isClaimedIdx = src.indexOf("IS_CLAIMED_OUT=$(npx tsx scripts/lib/session-registry.ts is-claimed");
    const gateIdx = src.indexOf("GATE_JSON=$(npx tsx scripts/check-glm-lane-gate.ts");
    const between = src.slice(isClaimedIdx, gateIdx);
    assert.match(between, /IS_CLAIMED_RC.*-ne 0/);
    assert.match(between, /exit 1/);
  });

  it("#6941: NÃO confia só no exit code do is-claimed (ele SEMPRE sai 0) — lê o campo 'claimed' do JSON", () => {
    // Achado ao vivo desta mesma revisão: is-claimed do session-registry.ts
    // sempre retorna exit 0 (a resposta é o JSON, não o rc). Um script que
    // checasse só IS_CLAIMED_RC concluiria "reivindicada" pra QUALQUER
    // issue, sempre — o pré-requisito inteiro viraria um no-op.
    const src = readScript();
    const isClaimedIdx = src.indexOf("IS_CLAIMED_OUT=$(npx tsx scripts/lib/session-registry.ts is-claimed");
    const gateIdx = src.indexOf("GATE_JSON=$(npx tsx scripts/check-glm-lane-gate.ts");
    const between = src.slice(isClaimedIdx, gateIdx);
    assert.match(between, /\.claimed/, "deveria ler o campo .claimed do JSON de is-claimed, não só o exit code");
    assert.match(between, /CLAIMED.*!=\s*"true"/, "deveria recusar quando claimed != true, não só quando o comando falha");
  });
});

describe("dispatch-glm-lane-unit.sh — ordem de operações", () => {
  it("o gate de critérios de morte é checado ANTES de criar o worktree", () => {
    const src = readScript();
    const gateIdx = src.indexOf("GATE_JSON=$(npx tsx scripts/check-glm-lane-gate.ts");
    const worktreeIdx = src.indexOf("git worktree add -b");
    assert.ok(gateIdx !== -1, "script deveria chamar check-glm-lane-gate.ts");
    assert.ok(worktreeIdx !== -1, "script deveria chamar 'git worktree add'");
    assert.ok(gateIdx < worktreeIdx, "o gate deveria ser checado ANTES do worktree");
  });

  it("gate recusado (rc=1) sai o script com erro ANTES do worktree (exit 1 na condicional)", () => {
    const src = readScript();
    const gateIdx = src.indexOf("GATE_JSON=$(npx tsx scripts/check-glm-lane-gate.ts");
    const worktreeIdx = src.indexOf("git worktree add -b");
    const afterGate = src.slice(gateIdx, worktreeIdx);
    assert.match(afterGate, /GATE_RC.*-eq 1/);
    assert.match(afterGate, /exit 1/);
  });

  it("gate com erro de invocação (rc=2, uso inválido) é distinguido de recusa de política (#6941 P2)", () => {
    const src = readScript();
    const gateIdx = src.indexOf("GATE_JSON=$(npx tsx scripts/check-glm-lane-gate.ts");
    const worktreeIdx = src.indexOf("git worktree add -b");
    const afterGate = src.slice(gateIdx, worktreeIdx);
    assert.match(afterGate, /ERRO DE INVOCAÇÃO DO GATE/, "deveria distinguir rc=2 (erro de uso) de rc=1 (recusa de política)");
    assert.match(afterGate, /exit 2/);
  });
});

describe("dispatch-glm-lane-unit.sh — worktree é sempre limpo ao sair (#6941 P2)", () => {
  it("worktree dir inclui um timestamp único por execução (retry da mesma issue não colide)", () => {
    const src = readScript();
    assert.match(src, /WORKTREE_DIR="\$REPO\/\.claude\/worktrees\/glm-\$\{ISSUE\}-\$\{RUN_TAG\}"/);
  });

  it("há um trap de limpeza do worktree no EXIT (sucesso ou falha)", () => {
    const src = readScript();
    assert.match(src, /trap\s+cleanup_worktree\s+EXIT/);
    assert.match(src, /git worktree remove/);
  });
});

describe("dispatch-glm-lane-unit.sh — snapshot de custo por unidade (condição (d))", () => {
  it("snapshot de crédito é tirado ANTES e DEPOIS da chamada ao claude-openrouter.sh", () => {
    const src = readScript();
    const beforeIdx = src.indexOf("CREDITS_BEFORE_JSON=");
    // busca a invocação REAL (com aspas do path), não a menção em comentário
    const dispatchIdx = src.indexOf('"$REPO/hermes/scripts/claude-openrouter.sh"');
    const afterIdx = src.indexOf("CREDITS_AFTER_JSON=");
    assert.ok(beforeIdx !== -1 && dispatchIdx !== -1 && afterIdx !== -1, "não encontrou um dos 3 marcadores no script");
    assert.ok(beforeIdx < dispatchIdx, "snapshot 'before' deveria vir antes do dispatch");
    assert.ok(dispatchIdx < afterIdx, "snapshot 'after' deveria vir depois do dispatch");
  });

  it("#6941 P3: snapshots de crédito capturam stdout e stderr em streams SEPARADOS (nunca 2>&1 misturado)", () => {
    const src = readScript();
    assert.ok(!src.includes("glm-lane-credits.ts 2>&1"), "snapshot de crédito não deveria misturar stdout/stderr — corrompe o JSON");
    assert.match(src, /glm-lane-credits\.ts 2>"\$CREDITS_STDERR_TMP"/);
  });

  it("registra a unidade via record-glm-lane-unit.ts (append-only, nunca sobrescreve)", () => {
    const src = readScript();
    assert.match(src, /record-glm-lane-unit\.ts/);
  });

  it("#6941 P0/P1: o rc da invocação do claude-openrouter.sh é propagado como --status completed|infra-error, nunca só logado", () => {
    const src = readScript();
    assert.match(src, /CLAUDE_RC.*-ne 0/);
    assert.match(src, /STATUS="infra-error"/);
    assert.match(src, /--status "\$STATUS"/);
  });

  it("#6941: o script sai com código != 0 se a invocação do modelo falhou (CLAUDE_RC != 0), mesmo depois de registrar", () => {
    const src = readScript();
    // a última checagem do arquivo deve sair não-zero em caso de infra-error
    const lastClaudeRcCheck = src.lastIndexOf("CLAUDE_RC");
    const tail = src.slice(lastClaudeRcCheck);
    assert.match(tail, /exit 1/);
  });
});
