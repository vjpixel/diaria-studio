/**
 * test/orchestrator-state-guard.test.ts (#5434 item 3)
 *
 * Guard mecânico cruzando os playbooks (`.claude/agents/orchestrator-stage-*.md`
 * — PROMPT, não código executável) contra as chaves conhecidas dos 3 módulos
 * de estado do #5414 (`preflight-state.ts`, `eia-dispatch-state.ts`,
 * `stage4-capture-state.ts`). Sem isso, um typo de flag ali (`--chrome_mcp`
 * em vez de `--chrome-mcp`, ou um nome de campo camelCase errado numa
 * releitura) não quebra build nem teste normal — só aparece numa edição
 * real, silenciosamente, como o P1 original desta issue.
 *
 * Duas checagens, nos dois sentidos (limitação conhecida abaixo):
 *
 *   A. Toda flag `--foo-bar` usada numa linha de invocação de um dos 3
 *      scripts precisa ser uma flag RECONHECIDA por aquele script (mais
 *      `--edition-dir`/`--read`, universais). Uma flag desconhecida não
 *      lançaria erro nenhum no CLI real — ela simplesmente nunca bateria em
 *      `FIELD_BY_FLAG` e o campo pretendido nunca seria escrito, sem
 *      nenhum aviso (a mesma classe do #5434 item 4, mas na CAMADA DE PROSA
 *      em vez da CLI).
 *
 *   B. Todo campo camelCase conhecido de um módulo (`chromeMcp`,
 *      `clariceRest`, `whatsappUrl`, etc.) precisa aparecer mencionado em
 *      ALGUM playbook como leitura (evidência de que alguém de fato
 *      consome o valor gravado) — a menos que esteja no ALLOWLIST abaixo,
 *      com a razão documentada. Sem isso, um campo gravado e nunca lido é
 *      trabalho desperdiçado em toda edição (achado real do #5434 item 3
 *      contra a implementação concorrente do #5430).
 *
 * **Limitação conhecida, registrada de propósito (#5434, mesma nota que a
 * issue já antecipava):** este guard verifica que uma chave tem ALGUM
 * `--set`/uso de flag e ALGUM mention de leitura em QUALQUER lugar dos
 * playbooks — não que cada RAMO de um call site específico seja simétrico
 * (ex: o P1 do item 1 desta mesma issue — resume não regravava
 * `chrome_mcp=true` no ramo de SUCESSO — não seria pego por este guard,
 * porque `chromeMcp` já tinha escrita E leitura em OUTROS pontos do
 * playbook). Checagem de simetria por ramo ficaria pra uma iteração futura
 * se o padrão se repetir.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = resolve(ROOT, ".claude/agents");

const STAGE_FILES = [
  "orchestrator-stage-0-preflight.md",
  "orchestrator-stage-1-research.md",
  "orchestrator-stage-2.md",
  "orchestrator-stage-3.md",
  "orchestrator-stage-4.md",
  "orchestrator-stage-5.md",
  "orchestrator-stage-6.md",
];

interface StateModule {
  /** Nome do arquivo do script (usado pra achar linhas de invocação nos playbooks). */
  script: string;
  /** flag kebab-case -> campo camelCase, espelha FIELD_BY_FLAG (ou equivalente) do módulo. */
  fields: Record<string, string>;
  /**
   * Campos gravados mas intencionalmente sem leitura via disco em nenhum
   * playbook — documentado no próprio módulo (docstring de
   * `readXState`/`writeXState`). Manter esta lista sincronizada com a
   * rationale lá: se um campo sair daqui, o docstring do módulo também
   * precisa parar de dizer "só consumido dentro do próprio Stage 0"/
   * "referência informativa" pro campo em questão.
   */
  writeOnlyAllowlist: string[];
}

const MODULES: StateModule[] = [
  {
    script: "preflight-state.ts",
    fields: {
      "chrome-mcp": "chromeMcp",
      "gmail-mcp": "gmailMcp",
      "beehiiv-mcp": "beehiivMcp",
      "clarice-rest": "clariceRest",
      "cloudflare-token-ok": "cloudflareTokenOk",
    },
    // gmailMcp/beehiivMcp/cloudflareTokenOk: preflight-state.ts docstring —
    // "só são consumidos dentro do próprio Stage 0 hoje, mas são
    // persistidos igual — robustez contra o Stage 0 em si rodar por partes
    // (compaction no meio, resume) e uniformidade dos 5 sinais". Consumidos
    // via variável de sessão (GMAIL_MCP/BEEHIIV_MCP/CLOUDFLARE_TOKEN_OK em
    // caps) dentro do mesmo arquivo, nunca relidos do disco por outro stage.
    writeOnlyAllowlist: ["gmailMcp", "beehiivMcp", "cloudflareTokenOk"],
  },
  {
    script: "eia-dispatch-state.ts",
    fields: {
      "bash-id": "bashId",
      "dispatched-at": "dispatchedAt",
    },
    writeOnlyAllowlist: [],
  },
  {
    script: "stage4-capture-state.ts",
    fields: {
      "whatsapp-url": "whatsappUrl",
      "meta-description-suggestion": "metaDescriptionSuggestion",
    },
    writeOnlyAllowlist: [],
  },
];

/** Flags universais aceitas em qualquer um dos 3 scripts (não são campos de estado). */
const UNIVERSAL_FLAGS = new Set(["edition-dir", "read"]);

function loadCombinedPlaybookText(): { combined: string; perFile: Map<string, string> } {
  const perFile = new Map<string, string>();
  for (const file of STAGE_FILES) {
    perFile.set(file, readFileSync(resolve(AGENTS_DIR, file), "utf8"));
  }
  return { combined: [...perFile.values()].join("\n"), perFile };
}

/**
 * Extrai todos os tokens `--flag` que aparecem dentro de um SPAN DE CÓDIGO
 * (fenced ```bash ... ``` ou inline `...`) que também menciona
 * `scripts/lib/{script}` — a unidade de escopo é o span de código, não a
 * linha nem o bullet inteiro: é exatamente a unidade que corresponde a UMA
 * invocação real e copiável do script (o único jeito como estes 3 scripts
 * são de fato chamados nos playbooks). Antes de escopar por span, um
 * comando VIZINHO de OUTRO script no mesmo parágrafo vazava flags pro
 * conjunto errado (ex: Stage 3 §3a-retry — `` `npx tsx scripts/eia-
 * compose.ts --force` `` e `` `npx tsx scripts/lib/eia-dispatch-state.ts
 * --bash-id ...` `` vivem na MESMA frase, em spans backtick separados).
 *
 * Fenced blocks multi-linha com continuação `\` (ex: o write-all-5 do
 * Stage 0 §0c, script name só na 1ª linha) são normalizados primeiro —
 * substitui `\` + quebra de linha por espaço — pra cair no mesmo caso do
 * span de fence único.
 *
 * Nota: uma menção puramente PROSA (sem span de código, ex: "regravar o
 * sinal (`--chrome-mcp true`)" sem repetir `preflight-state.ts` porque o
 * comando completo já apareceu 2 frases antes) não é tratada como
 * invocação — corretamente: não é uma invocação real, é uma referência
 * abreviada a uma já mostrada, então não teria como o guard distinguir
 * "referência a uma flag já grafada corretamente" de "nova invocação".
 */
function extractUsedFlags(text: string, script: string): Set<string> {
  const normalized = text.replace(/\\\r?\n/g, " ");
  const used = new Set<string>();
  const flagRe = /--([a-z][a-z0-9-]*)/g;
  const spanRe = /```[\s\S]*?```|`[^`\n]+`/g;
  for (const spanMatch of normalized.matchAll(spanRe)) {
    const span = spanMatch[0];
    if (!span.includes(script)) continue;
    for (const m of span.matchAll(flagRe)) {
      used.add(m[1]);
    }
  }
  return used;
}

describe("guard mecânico: playbooks x módulos de estado (#5434 item 3)", () => {
  const { combined } = loadCombinedPlaybookText();

  for (const mod of MODULES) {
    describe(mod.script, () => {
      const usedFlags = extractUsedFlags(combined, mod.script);

      it("toda flag usada nos playbooks é reconhecida pelo script (direção A — typo de escrita)", () => {
        const unknown = [...usedFlags].filter(
          (f) => !UNIVERSAL_FLAGS.has(f) && !(f in mod.fields),
        );
        assert.deepEqual(
          unknown,
          [],
          `${mod.script}: flag(s) desconhecida(s) usada(s) em algum playbook — não bate com ` +
            `nenhuma chave de FIELD_BY_FLAG nem com --edition-dir/--read. Typo provável: o write ` +
            `correspondente nunca escreveria nada (indistinguível de "nunca chamado").`,
        );
      });

      it("toda flag conhecida do script é de fato usada em algum playbook (declarada mas nunca escrita)", () => {
        const declared = Object.keys(mod.fields);
        const neverUsed = declared.filter((f) => !usedFlags.has(f));
        assert.deepEqual(
          neverUsed,
          [],
          `${mod.script}: flag(s) declarada(s) no módulo mas NUNCA usada(s) em nenhum playbook — ` +
            `campo morto (não é necessariamente bug, mas indica dessincronia entre módulo e prosa).`,
        );
      });

      it("todo campo camelCase é mencionado (lido) em algum playbook, exceto allowlist documentada (direção B)", () => {
        const missing = Object.values(mod.fields).filter((camelField) => {
          if (mod.writeOnlyAllowlist.includes(camelField)) return false;
          const readRe = new RegExp(`\\b${camelField}\\b`);
          return !readRe.test(combined);
        });
        assert.deepEqual(
          missing,
          [],
          `${mod.script}: campo(s) gravado(s) mas NUNCA mencionado(s) como leitura em nenhum ` +
            `playbook, e não estão no writeOnlyAllowlist deste teste — trabalho desperdiçado toda ` +
            `edição (achado real do #5434 item 3), ou falta documentar a exceção com rationale.`,
        );
      });

      it("allowlist não tem entrada obsoleta (campo do allowlist que passou a ter leitura)", () => {
        for (const camelField of mod.writeOnlyAllowlist) {
          assert.ok(
            Object.values(mod.fields).includes(camelField),
            `${mod.script}: writeOnlyAllowlist cita "${camelField}", que não é um campo conhecido do módulo`,
          );
        }
      });
    });
  }

  it("todos os 3 scripts de estado têm ao menos 1 invocação em algum playbook (sanity)", () => {
    for (const mod of MODULES) {
      assert.ok(
        combined.includes(mod.script),
        `${mod.script} nunca é mencionado em nenhum orchestrator-stage-*.md — módulo órfão?`,
      );
    }
  });
});
