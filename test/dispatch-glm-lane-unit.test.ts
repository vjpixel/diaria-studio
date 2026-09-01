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

/**
 * #6953: o script agora define DUAS strings `--tools` literais — uma pro
 * modo padrão (1ª rodada, abre PR nova) e uma pro modo `--pr N` (2ª+
 * rodada, itera sobre PR existente, `gh pr create` OMITIDO de propósito).
 * Extrai as DUAS (via a atribuição `TOOLS="..."`, não `--tools "..."`,
 * que na invocação real é só `--tools "$TOOLS"` — a variável) pra checar
 * cada uma nas propriedades que lhe cabem.
 */
function extractToolsValues(src: string): string[] {
  const matches = [...src.matchAll(/TOOLS="([^"]+)"/g)];
  assert.ok(matches.length >= 2, `esperava >= 2 definições de TOOLS="..." no script (modo padrão + --pr), achou ${matches.length}`);
  return matches.map((m) => m[1]);
}

const FORBIDDEN_TOOL_SUBSTRINGS = ["gh pr merge", "gh pr review", "gh issue close", "gh issue edit"];

describe("dispatch-glm-lane-unit.sh — condição (b) do docs/lane-glm.md, produtor apenas", () => {
  it("nenhuma das --tools (padrão ou --pr) contém gh pr merge/review nem gh issue close/edit", () => {
    for (const value of extractToolsValues(readScript())) {
      for (const forbidden of FORBIDDEN_TOOL_SUBSTRINGS) {
        assert.ok(!value.includes(forbidden), `--tools contém '${forbidden}' — condição (b) do lane-glm.md violada`);
      }
    }
  });

  it("nenhuma --tools usa 'Bash' genérico/irrestrito (teria que ser Bash(cmd:*) escopado)", () => {
    for (const value of extractToolsValues(readScript())) {
      const parts = value.split(",");
      assert.ok(!parts.includes("Bash"), "--tools inclui 'Bash' sem escopo — reabre exatamente o que o #6864 fechou");
    }
  });

  it("#6941 P0: nenhuma --tools contém Bash(git:*) genérico — permitiria 'git push origin HEAD:master'", () => {
    for (const value of extractToolsValues(readScript())) {
      const parts = value.split(",");
      assert.ok(!parts.includes("Bash(git:*)"), "--tools contém Bash(git:*) sem escopo — permite push direto pra master");
    }
  });

  it("#6941 P0: nenhuma --tools contém Bash(npm:*) genérico — permitiria 'npm exec -- gh pr merge'", () => {
    for (const value of extractToolsValues(readScript())) {
      const parts = value.split(",");
      assert.ok(!parts.includes("Bash(npm:*)"), "--tools contém Bash(npm:*) sem escopo — permite 'npm exec -- gh ...'");
    }
  });

  it("#6941 P0: nenhuma --tools contém Bash(npx:*) genérico — permitiria rodar qualquer pacote/binário via npx", () => {
    for (const value of extractToolsValues(readScript())) {
      const parts = value.split(",");
      assert.ok(!parts.includes("Bash(npx:*)"), "--tools contém Bash(npx:*) sem escopo");
    }
  });

  it("#6941: cada pattern Bash(git ...) presente, nas DUAS --tools, é um subcomando de escrita local seguro escopado à branch", () => {
    const SAFE_GIT_PREFIXES = [
      "Bash(git add:",
      "Bash(git commit:",
      "Bash(git status:",
      "Bash(git diff:",
      "Bash(git log:",
      "Bash(git branch:",
      "Bash(git push -u origin ",
      "Bash(git push origin ",
    ];
    for (const value of extractToolsValues(readScript())) {
      const gitPatterns = value.split(",").filter((p) => p.startsWith("Bash(git "));
      assert.ok(gitPatterns.length > 0, "esperava pelo menos 1 pattern Bash(git ...)");
      for (const pattern of gitPatterns) {
        assert.ok(
          SAFE_GIT_PREFIXES.some((prefix) => pattern.startsWith(prefix)),
          `pattern git '${pattern}' não está na allowlist de prefixos seguros conhecidos`,
        );
      }
    }
  });

  it("#6941: git push é escopado à branch EXATA desta unidade ($BRANCH interpolado), nunca uma branch arbitrária, nas DUAS --tools", () => {
    for (const value of extractToolsValues(readScript())) {
      assert.match(
        value,
        /Bash\(git push(?: -u)? origin \$\{BRANCH\}:\*\)/,
        "git push deveria ser escopado a ${BRANCH}, a variável da branch desta unidade",
      );
    }
  });

  it("--tools do modo PADRÃO inclui gh pr create (o produtor PRECISA poder abrir PR na 1ª rodada)", () => {
    const [defaultTools] = extractToolsValues(readScript()).filter((v) => v.includes("git push -u origin"));
    assert.ok(defaultTools, "não achei a --tools do modo padrão (git push -u origin)");
    assert.ok(defaultTools.includes("gh pr create"), "--tools do modo padrão deveria permitir 'gh pr create'");
  });

  it("#6953: --tools do modo --pr OMITE gh pr create — mecanicamente impossível abrir PR duplicada", () => {
    const [prTools] = extractToolsValues(readScript()).filter((v) => !v.includes("git push -u origin"));
    assert.ok(prTools, "não achei a --tools do modo --pr");
    assert.ok(!prTools.includes("gh pr create"), "--tools do modo --pr NÃO deveria permitir 'gh pr create' — instrução de prompt não basta (#6864/#6849)");
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

describe("dispatch-glm-lane-unit.sh — modo --pr N, segunda rodada (#6953)", () => {
  it("aceita --pr como segundo argumento posicional/flag e resolve a branch HEAD via gh pr view", () => {
    const src = readScript();
    assert.match(src, /EXISTING_PR="\$\{2:\?uso: --pr requer um número de PR\}"/);
    assert.match(src, /gh pr view "\$EXISTING_PR" --json headRefName -q \.headRefName/);
  });

  it("worktree do modo --pr usa -B (reset idempotente) em cima de origin/<branch existente>, nunca -b (criar do zero)", () => {
    const src = readScript();
    assert.match(src, /git worktree add -B "\$BRANCH" "\$WORKTREE_DIR" "origin\/\$BRANCH"/);
  });

  it("injeta os comentários de review já postados via gh pr view --json comments", () => {
    const src = readScript();
    assert.match(src, /gh pr view "\$EXISTING_PR" --json comments/);
    assert.match(src, /REVIEW_COMMENTS=/);
  });

  it("o prompt do modo --pr diz explicitamente para NÃO chamar gh pr create", () => {
    const src = readScript();
    const promptIdx = src.indexOf('PROMPT="Esta é uma ITERAÇÃO');
    assert.ok(promptIdx !== -1, "não achei o prompt do modo --pr");
    assert.match(src.slice(promptIdx, promptIdx + 400), /NÃO chame 'gh pr create'/);
  });

  it("#6953: guard de CI-wait presente nos DOIS prompts (padrão e --pr) — nunca esperar CI dentro da unidade", () => {
    const src = readScript();
    const guardCount = (src.match(/NUNCA rode 'gh pr checks', 'gh run watch'/g) ?? []).length;
    // A string CI_WAIT_GUARD é definida 1x e interpolada nos 2 prompts —
    // basta achar a definição + as 2 interpolações via $CI_WAIT_GUARD.
    assert.ok(guardCount >= 1, "guard de CI-wait não encontrado no script");
    const interpolations = (src.match(/\$CI_WAIT_GUARD/g) ?? []).length;
    assert.equal(interpolations, 2, "guard de CI-wait deveria ser interpolado nos 2 prompts (padrão e --pr)");
  });

  it("PR_NUMBER no modo --pr é o EXISTING_PR direto, não uma nova busca via gh pr list", () => {
    const src = readScript();
    assert.match(src, /if \[ -n "\$EXISTING_PR" \]; then\s*\n\s*PR_NUMBER="\$EXISTING_PR"/);
  });

  it("#6953: mensagem final de infra-error NUNCA diz 'considere retentar' quando já existe uma PR — diria 'revise-a' / '--pr'", () => {
    const src = readScript();
    const tailIdx = src.lastIndexOf('if [ "$CLAUDE_RC" -ne 0 ]; then');
    const tail = src.slice(tailIdx);
    assert.match(tail, /PR_NUMBER.*revise-a/s, "quando PR_NUMBER existe, a mensagem deveria mandar revisar a PR, não retentar");
    assert.match(tail, /considere retentar do zero \(sem --pr\)/, "só quando NÃO há PR ainda é que 'considere retentar' é seguro");
  });
});
