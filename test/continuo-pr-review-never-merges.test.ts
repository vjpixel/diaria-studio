/**
 * test/continuo-pr-review-never-merges.test.ts (#6865, escopo revisto #6926)
 *
 * Até o #6926, `continuo-pr-review.sh` NUNCA mergeava — só o pickup de PR
 * órfã (`hermes-diaria-continuo/SKILL.md` §3 passo 3, #6823) tinha
 * autoridade de merge. O #6926 muda isso (PR #6901: 10h29 parada, único
 * merger sem agendador), mas preserva a propriedade mecânica central: **o
 * MODELO nunca mergeia nada** — `--allowedTools` da sessão `claude -p`
 * continua sem qualquer pattern que permita `gh pr merge` (verificado
 * abaixo). O que muda é que o SCRIPT BASH, depois que a sessão do modelo já
 * saiu, agora PODE chamar `gh pr merge` de verdade — mas só atrás do
 * portão determinístico de `scripts/check-continuo-merge-gate.ts`
 * (`GATE_RC -eq 0`), nunca incondicional. Este arquivo trava as DUAS
 * metades: o modelo continua sem a ferramenta (nunca regride pro estado
 * pré-#6926), e o merge que o bash ganhou está estruturalmente gated, não
 * solto em algum canto do script.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = resolve(ROOT, "hermes/scripts/continuo-pr-review.sh");

function readScript(): string {
  return readFileSync(SCRIPT_PATH, "utf8");
}

/** Achado do review da PR #6871 (P2, confiança alta): checar só a AUSÊNCIA
 *  da substring "gh pr merge" é frágil — um `Bash(gh:*)` ou `Bash(*)` futuro
 *  daria merge sem conter esse literal. Extrai os patterns `Bash(...)`
 *  individuais de dentro de `--allowedTools "..."` e valida cada um contra
 *  uma ALLOWLIST POSITIVA de patterns conhecidos-seguros — qualquer pattern
 *  fora da lista (inclusive um genérico demais tipo `Bash(gh:*)`) falha o
 *  teste, não só os que citam merge literalmente. */
const SAFE_BASH_PATTERNS = new Set([
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(gh pr view:*)",
  "Bash(gh pr diff:*)",
  "Bash(gh pr comment:*)",
]);

function extractAllowedToolsValue(src: string): string {
  const m = src.match(/--allowedTools\s+"([^"]+)"/);
  assert.ok(m, "não encontrou --allowedTools \"...\" no script");
  return m![1];
}

describe("continuo-pr-review.sh — modelo nunca mergeia, bash só mergeia atrás do gate (#6865/#6926)", () => {
  it("--allowedTools só contém patterns Bash(...) da allowlist positiva (nunca um pattern genérico demais que vazaria merge)", () => {
    const value = extractAllowedToolsValue(readScript());
    const parts = value.split(",");
    const bashPatterns = parts.filter((p) => p.startsWith("Bash("));
    assert.ok(bashPatterns.length > 0, "esperava pelo menos 1 pattern Bash(...)");
    for (const pattern of bashPatterns) {
      assert.ok(
        SAFE_BASH_PATTERNS.has(pattern),
        `pattern '${pattern}' não está na allowlist positiva de patterns seguros — ` +
          `mesmo sem conter 'pr merge' literal, um pattern genérico (ex: Bash(gh:*)) vazaria capacidade de merge. ` +
          `Patterns permitidos: ${[...SAFE_BASH_PATTERNS].join(", ")}`,
      );
    }
  });

  it("nenhuma menção a `gh pr merge` aparece DENTRO do texto do $PROMPT como instrução positiva (só negação, ou fora do prompt)", () => {
    // #6926: o PROMPT ainda existe e ainda proíbe o MODELO de mergear — mas
    // agora o script TEM um `gh pr merge` real (dentro de try_merge_gate,
    // fora do prompt). Este teste restringe a checagem à faixa de linhas do
    // $PROMPT (entre a atribuição PROMPT="... e a linha que fecha a string
    // com aspas antes do `set +e` que invoca `claude -p`), preservando a
    // garantia original: NENHUMA linha do prompt instrui o modelo a mergear.
    const src = readScript();
    const promptStart = src.indexOf('PROMPT="');
    const promptEnd = src.indexOf('\n\n  set +e\n  echo "$PROMPT"');
    assert.ok(promptStart !== -1 && promptEnd !== -1 && promptEnd > promptStart, "não encontrou os limites do bloco $PROMPT no script");
    const promptBlock = src.slice(promptStart, promptEnd);
    const lines = promptBlock.split("\n");
    const offenders = lines.filter((l) => {
      if (!/gh\s+pr\s+merge/.test(l)) return false;
      // Menção dentro do texto do PROMPT explicando a proibição — sempre
      // acompanhada de negação (não/nunca/NUNCA) na mesma linha.
      return !/n[aã]o|nunca/i.test(l);
    });
    assert.deepEqual(
      offenders,
      [],
      `linha(s) do $PROMPT mencionando 'gh pr merge' sem negação: ${JSON.stringify(offenders)}`,
    );
  });

  it("`gh pr merge` como comando REAL aparece exatamente 1 vez no script inteiro, e é dentro de try_merge_gate", () => {
    // #6926: fora do $PROMPT (testado acima), a única ocorrência de
    // `gh pr merge` executável deve estar dentro da função `try_merge_gate`
    // — nunca solta em outro ponto do script (o que reabriria a corrida do
    // #5716 ou vazaria merge incondicional por engano de um edit futuro).
    const src = readScript();
    const funcStart = src.indexOf("try_merge_gate() {");
    assert.ok(funcStart !== -1, "não encontrou a função try_merge_gate() no script");
    const funcEnd = src.indexOf("\n}\n", funcStart);
    assert.ok(funcEnd !== -1, "não encontrou o fim (\\n}\\n) de try_merge_gate()");
    const funcBody = src.slice(funcStart, funcEnd);

    const realMergeCommandRe = /^\s*gh pr merge /m;
    assert.ok(realMergeCommandRe.test(funcBody), "esperava `gh pr merge ` como comando real dentro de try_merge_gate()");

    const outsideFunc = src.slice(0, funcStart) + src.slice(funcEnd);
    const linesOutside = outsideFunc.split("\n");
    const offendersOutside = linesOutside.filter((l) => {
      const trimmed = l.trim();
      if (!/^gh pr merge /.test(trimmed) && !/^\s*gh pr merge /.test(l)) return false;
      if (trimmed.startsWith("#")) return false;
      // A única exceção fora da função é a menção proibitiva dentro do
      // $PROMPT (já coberta e validada pelo teste anterior).
      return !/n[aã]o|nunca/i.test(trimmed) && !trimmed.includes('\\`gh pr merge\\`');
    });
    assert.deepEqual(
      offendersOutside,
      [],
      `comando 'gh pr merge' real encontrado FORA de try_merge_gate(): ${JSON.stringify(offendersOutside)}`,
    );
  });

  it("`gh pr merge` dentro de try_merge_gate só roda no branch GATE_RC=0 (case \"$GATE_RC\" in 0))", () => {
    // Garante que o merge está estruturalmente atrás do case/switch do
    // veredito do gate — não só "textualmente perto dele" por acidente de
    // formatação. Extrai o branch `0)` ... `;;` do case e confirma que o
    // `gh pr merge` mora exatamente ali.
    const src = readScript();
    const funcStart = src.indexOf("try_merge_gate() {");
    const funcEnd = src.indexOf("\n}\n", funcStart);
    const funcBody = src.slice(funcStart, funcEnd);

    const caseMatch = funcBody.match(/case "\$GATE_RC" in([\s\S]*?)\n\s*esac/);
    assert.ok(caseMatch, "não encontrou `case \"$GATE_RC\" in ... esac` em try_merge_gate()");

    const branch0Match = caseMatch![1].match(/^\s*0\)([\s\S]*?);;/m);
    assert.ok(branch0Match, "não encontrou o branch `0)` dentro do case");
    assert.match(branch0Match![1], /gh pr merge /, "o branch GATE_RC=0 deve conter o `gh pr merge` real");

    // Nos outros branches (1, 2, *) NÃO pode haver `gh pr merge` real.
    const otherBranches = caseMatch![1].replace(branch0Match![0], "");
    assert.doesNotMatch(otherBranches, /^\s*gh pr merge /m, "nenhum outro branch do case (escalate/reject/erro) deve chamar `gh pr merge`");
  });

  it("check-continuo-merge-gate.ts é chamado ANTES de qualquer `gh pr merge` real dentro de try_merge_gate", () => {
    const src = readScript();
    const funcStart = src.indexOf("try_merge_gate() {");
    const funcEnd = src.indexOf("\n}\n", funcStart);
    const funcBody = src.slice(funcStart, funcEnd);

    const gateCallIdx = funcBody.indexOf("check-continuo-merge-gate.ts");
    const mergeCallIdx = funcBody.search(/^\s*gh pr merge /m);
    assert.ok(gateCallIdx !== -1, "try_merge_gate() deve chamar check-continuo-merge-gate.ts");
    assert.ok(mergeCallIdx !== -1, "try_merge_gate() deve conter um `gh pr merge` real");
    assert.ok(gateCallIdx < mergeCallIdx, "check-continuo-merge-gate.ts deve ser chamado ANTES do `gh pr merge`");
  });

  it("o PROMPT enviado ao claude -p instrui explicitamente a NUNCA mergear", () => {
    const src = readScript();
    assert.match(
      src,
      /NUNCA MERGEIA|nunca mergear/i,
      "o prompt deve instruir explicitamente a sessão de review a nunca mergear",
    );
  });

  it("usa --model sonnet (não opus) — papel distinto do review diário consolidado", () => {
    const src = readScript();
    assert.match(src, /--model sonnet/, "continuo-pr-review.sh deve usar Sonnet, não Opus (decisão do editor, #6865)");
  });

  it("AUTH: não seta ANTHROPIC_BASE_URL/AUTH_TOKEN/API_KEY (assinatura claude.ai, mesmo padrão do #5608)", () => {
    const src = readScript();
    assert.ok(
      !src.includes("ANTHROPIC_BASE_URL=") && !src.includes("ANTHROPIC_AUTH_TOKEN=") && !src.includes("ANTHROPIC_API_KEY="),
      "script não deve setar essas env vars — precisa rodar com a assinatura claude.ai, não gateway de terceiro (#5608/#6714)",
    );
  });

  it("checa check-pr-review-authenticity.ts antes de decidir revisar (não revisa PR que já tem review independente)", () => {
    const src = readScript();
    assert.match(src, /check-pr-review-authenticity\.ts/, "script deve consultar o gate de autenticidade antes de revisar");
  });
});
