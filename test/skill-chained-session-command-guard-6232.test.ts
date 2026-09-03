/**
 * test/skill-chained-session-command-guard-6232.test.ts (#6232)
 *
 * Fronteira lint-enforced (mesmo molde de `test/getarg-numeric-guard-4573.test.ts`
 * e `test/lib-boundary.test.ts`: grep estrutural sobre os arquivos do repo,
 * sem executar nada) contra o padrão que causou o incidente da issue: um
 * comando de exemplo/instrução dentro de um `SKILL.md` que invoca
 * `scripts/overnight-session-marker.ts --start`/`--phase` ou
 * `scripts/lib/session-registry.ts {subcomando injetável}` **encadeado ou
 * pipado** (`&&`/`;`/`|`/multi-linha) dentro do MESMO trecho de código
 * (bloco cercado ```...``` ou span inline `...`). O conjunto exato de
 * subcomandos injetáveis não é mais listado aqui em prosa (#6351 — a lista
 * hardcoded anterior já tinha divergido da real, ver
 * `loadInjectableSubcommandsFromHook` abaixo, que a deriva do hook real em
 * vez de repeti-la).
 *
 * Por que importa: `.claude/hooks/inject-session-id.mjs` (`isChainedCommand`)
 * recusa injetar `--session-id` automaticamente exatamente nesse formato, de
 * propósito (comentário do próprio hook) — um comando assim, copiado ou
 * reproduzido literalmente de uma SKILL, sai sem `--session-id`. Antes deste
 * PR, `overnight-session-marker.ts` gravava um marker anônimo em silêncio
 * nesse caso (ver `resolveSessionIdOrThrow` em `scripts/overnight-session-marker.ts`,
 * que agora falha alto); `session-registry.ts` já falhava alto
 * (`requireSessionId`). O achado ao vivo do #6232: as duas chamadas erradas
 * do coordenador que produziram o marker anônimo não vieram de texto
 * literal do SKILL.md (varrido aqui e confirmado limpo — ver
 * `KNOWN_CLEAN_AT_WRITE_TIME` abaixo), mas a documentação PODERIA introduzir
 * esse padrão no futuro (ex: alguém "otimizando" um passo da skill juntando
 * dois comandos com `&&`) sem ninguém perceber até a próxima rodada
 * reproduzir o incidente — este teste impede que isso aconteça calado.
 *
 * Escopo: só `.claude/skills/*\/SKILL.md` (onde o coordenador overnight/
 * develop lê as instruções que reproduz como comando Bash) — não
 * `context/overnight-dispatch-rules.md` nem outra prosa, que já não contém
 * comando executável nesse formato (mesmo escopo de arquivo do #4573 restrito
 * a `scripts/`, adaptado aqui pra `.claude/skills/`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = join(ROOT, ".claude", "skills");
const INJECT_SESSION_ID_HOOK = join(ROOT, ".claude", "hooks", "inject-session-id.mjs");

const TARGET_MARKER = "overnight-session-marker.ts";
const TARGET_REGISTRY = "session-registry.ts";

/**
 * Extrai a lista de subcomandos injetáveis DIRETO do texto-fonte de
 * `.claude/hooks/inject-session-id.mjs` (regex sobre a declaração
 * `const INJECTABLE_SUBCOMMANDS = /\b(...)\b/;`), em vez de manter uma
 * cópia estática hardcoded aqui (#6351 — a cópia anterior já tinha
 * divergido em silêncio do hook real: `conflicts`, `grant-merge`,
 * `check-merge-grant`, `consume-merge-grant` e `merge-lock-renew` foram
 * adicionados ao hook nos #6168/#6296/#6303 sem nunca entrar aqui, e nada
 * acusava — este teste continuava verde testando um regex incompleto).
 * Ler o texto via `readFileSync` + regex (sem `import` do `.mjs` como
 * módulo) preserva a restrição registrada de "teste estático,
 * self-contained" — não é o teste chamando o hook, é o teste lendo o
 * literal que o hook declara, a mesma fonte única. Se o hook mudar de
 * forma (nome da const, formato da regex) a ponto de a extração falhar,
 * o teste "guard das SKILLs" abaixo falha alto (a asserção de não-vazio
 * logo adiante) em vez de voltar a divergir em silêncio.
 */
export function loadInjectableSubcommandsFromHook(hookPath: string): RegExp {
  const source = readFileSync(hookPath, "utf8");
  const match = source.match(
    /const\s+INJECTABLE_SUBCOMMANDS\s*=\s*\/\\b\(([^)]+)\)\\b\//,
  );
  if (!match) {
    throw new Error(
      `Não foi possível extrair INJECTABLE_SUBCOMMANDS de ${hookPath} — ` +
        "o formato da declaração no hook mudou; atualize o regex de extração " +
        "em loadInjectableSubcommandsFromHook (test/skill-chained-session-command-guard-6232.test.ts).",
    );
  }
  return new RegExp(`\\b(${match[1]})\\b`);
}

const INJECTABLE_SUBCOMMANDS = loadInjectableSubcommandsFromHook(INJECT_SESSION_ID_HOOK);

/**
 * Extrai os alvos INCONDICIONAIS (`needsSessionId: () => true` — o script
 * inteiro exige `--session-id`, sem noção de subcomando, como
 * `resolve-develop-plan-path.ts`/`resolve-overnight-plan-path.ts`/
 * `cleanup-merged-worktrees.ts` em `SESSION_ID_TARGETS`) DIRETO do
 * texto-fonte do hook — mesma disciplina de `loadInjectableSubcommandsFromHook`
 * acima (#6351: fonte única, nunca uma cópia estática que diverge em
 * silêncio). Origem: #7315 — o guard cobria só `TARGET_MARKER`/
 * `TARGET_REGISTRY` (os 2 alvos que existiam quando este teste nasceu no
 * #6232), enquanto o hook real já tinha 5 (`SESSION_ID_TARGETS`, #6259/
 * #6265/#6328/#7304) — os 3 incondicionais nunca eram varridos nas SKILLs.
 * Derivar do hook (em vez de listar os 3 nomes à mão de novo) é a correção
 * que a própria issue pede: se um 6º alvo incondicional entrar no hook no
 * mesmo formato, este teste passa a cobri-lo sem precisar de edição aqui.
 */
export function loadUnconditionalTargetsFromHook(hookPath: string): string[] {
  const source = readFileSync(hookPath, "utf8");
  const constDecls = new Map<string, string>();
  for (const m of source.matchAll(/const\s+(TARGET_\w+)\s*=\s*"([^"]+)"/g)) {
    constDecls.set(m[1], m[2]);
  }
  const targets: string[] = [];
  for (const m of source.matchAll(/match:\s*(TARGET_\w+),\s*\n\s*needsSessionId:\s*\(\)\s*=>\s*true/g)) {
    const value = constDecls.get(m[1]);
    if (value) targets.push(value);
  }
  if (targets.length === 0) {
    throw new Error(
      `Não foi possível extrair nenhum alvo incondicional (needsSessionId: () => true) de ${hookPath} — ` +
        "o formato de SESSION_ID_TARGETS no hook mudou; atualize o regex de extração " +
        "em loadUnconditionalTargetsFromHook (test/skill-chained-session-command-guard-6232.test.ts).",
    );
  }
  return targets;
}

const UNCONDITIONAL_TARGETS = loadUnconditionalTargetsFromHook(INJECT_SESSION_ID_HOOK);
// Mesma heurística de encadeamento de .claude/hooks/inject-session-id.mjs
// (isChainedCommand) — inclusive o `\r?\n`: um bloco cercado multi-linha
// conta como "encadeado" porque a injeção automática do hook real também o
// trata assim (comentário de isChainedCommand: sem o `\n`, um heredoc/script
// de várias linhas engana a injeção).
const CHAIN_RE = /&&|\|\||;|\|(?!\|)|\r?\n/;

export interface FlaggedSpan {
  /** Path relativo ao root do repo, POSIX. */
  file: string;
  /** Trecho de código flagrado (truncado pra legibilidade). */
  snippet: string;
}

/** `true` se `text` invoca um subcomando injetável de um dos scripts-alvo —
 *  os 2 com regra por subcomando (`TARGET_MARKER`/`TARGET_REGISTRY`) mais
 *  todo alvo INCONDICIONAL derivado do hook (#7315, `UNCONDITIONAL_TARGETS`
 *  acima — hoje `resolve-develop-plan-path.ts`, `resolve-overnight-plan-
 *  path.ts` e `cleanup-merged-worktrees.ts`, mas nunca hardcoded aqui). */
export function referencesInjectableCommand(text: string): boolean {
  if (text.includes(TARGET_MARKER)) {
    return /--start\b/.test(text) || /--phase\b/.test(text);
  }
  if (text.includes(TARGET_REGISTRY)) {
    return INJECTABLE_SUBCOMMANDS.test(text);
  }
  return UNCONDITIONAL_TARGETS.some((target) => text.includes(target));
}

/**
 * Extrai todo trecho de código de um SKILL.md — blocos cercados
 * (```...```, qualquer linguagem) e spans inline (`...`, sem quebra de
 * linha — spans inline nunca contêm `\n` por construção Markdown).
 */
export function extractCodeSpans(markdown: string): string[] {
  const spans: string[] = [];
  for (const match of markdown.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)) {
    spans.push(match[1]);
  }
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    spans.push(match[1]);
  }
  return spans;
}

/**
 * Varre todo `SKILL.md` sob `dir` (`.claude/skills/*\/SKILL.md`) e devolve
 * todo trecho de código que invoca um subcomando injetável ENCADEADO/PIPADO
 * — o padrão que faz `inject-session-id.mjs` recusar a injeção automática de
 * `--session-id`.
 */
export function findChainedSessionCommandsInSkills(dir: string): FlaggedSpan[] {
  const found: FlaggedSpan[] = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const markdown = readFileSync(skillPath, "utf8");
    for (const span of extractCodeSpans(markdown)) {
      if (referencesInjectableCommand(span) && CHAIN_RE.test(span)) {
        found.push({
          file: `.claude/skills/${entry.name}/SKILL.md`,
          snippet: span.length > 200 ? `${span.slice(0, 200)}…` : span,
        });
      }
    }
  }
  return found;
}

describe("findChainedSessionCommandsInSkills — unidades isoladas", () => {
  it("span sem os scripts-alvo → nunca flagra, mesmo com &&/pipe", () => {
    assert.equal(referencesInjectableCommand("echo a && echo b"), false);
  });

  it("overnight-session-marker.ts --start standalone → não flagra (sem encadeamento)", () => {
    const span = "npx tsx scripts/overnight-session-marker.ts --start";
    assert.equal(referencesInjectableCommand(span), true);
    assert.equal(CHAIN_RE.test(span), false);
  });

  it("overnight-session-marker.ts --start encadeado com ';' → flagra", () => {
    const span = "npx tsx scripts/overnight-session-marker.ts --start ; echo ok";
    assert.ok(referencesInjectableCommand(span) && CHAIN_RE.test(span));
  });

  it("overnight-session-marker.ts --phase pipado com '|' → flagra", () => {
    const span = "npx tsx scripts/overnight-session-marker.ts --phase autonomous | tail -2";
    assert.ok(referencesInjectableCommand(span) && CHAIN_RE.test(span));
  });

  it("session-registry.ts claim-issue com '&&' → flagra", () => {
    const span = "npx tsx scripts/lib/session-registry.ts claim-issue --issue 1 && echo done";
    assert.ok(referencesInjectableCommand(span) && CHAIN_RE.test(span));
  });

  it("session-registry.ts list-active (não-injetável) encadeado → não flagra — list-active não está em INJECTABLE_SUBCOMMANDS", () => {
    const span = "npx tsx scripts/lib/session-registry.ts list-active | jq .";
    assert.equal(referencesInjectableCommand(span), false);
  });

  it("bloco cercado MULTI-LINHA com o alvo → flagra (mesma definição conservadora do hook real)", () => {
    const span = "npx tsx scripts/overnight-session-marker.ts --start\nnpx tsx scripts/lib/session-registry.ts register --kind overnight";
    assert.ok(referencesInjectableCommand(span) && CHAIN_RE.test(span));
  });

  // #7315: os 2 alvos que o guard não cobria — `.claude/hooks/
  // inject-session-id.mjs` já injeta incondicionalmente nos dois (sem
  // noção de subcomando), mas `referencesInjectableCommand` só conhecia
  // `TARGET_MARKER`/`TARGET_REGISTRY` até este fix.
  it("#7315: resolve-develop-plan-path.ts standalone → flagra como injetável (incondicional)", () => {
    const span = "npx tsx scripts/lib/resolve-develop-plan-path.ts --stage 2";
    assert.equal(referencesInjectableCommand(span), true);
    assert.equal(CHAIN_RE.test(span), false);
  });

  it("#7315: resolve-develop-plan-path.ts encadeado com '&&' → flagra", () => {
    const span = "npx tsx scripts/lib/resolve-develop-plan-path.ts --stage 2 && echo ok";
    assert.ok(referencesInjectableCommand(span) && CHAIN_RE.test(span));
  });

  it("#7315: resolve-overnight-plan-path.ts pipado com '|' → flagra", () => {
    const span = "npx tsx scripts/lib/resolve-overnight-plan-path.ts --stage 2 | tail -1";
    assert.ok(referencesInjectableCommand(span) && CHAIN_RE.test(span));
  });

  it("#7315: resolve-overnight-plan-path.ts standalone → flagra como injetável (incondicional)", () => {
    const span = "npx tsx scripts/lib/resolve-overnight-plan-path.ts --stage 4";
    assert.equal(referencesInjectableCommand(span), true);
    assert.equal(CHAIN_RE.test(span), false);
  });

  // Não pedido explicitamente pela #7315, mas coberto de graça pela mesma
  // extração dinâmica (`UNCONDITIONAL_TARGETS`) — cleanup-merged-worktrees.ts
  // é o 5º alvo do hook (#7304), mesma regra incondicional dos 2 acima.
  it("cleanup-merged-worktrees.ts encadeado com ';' → também flagra (5º alvo do hook, coberto pela extração dinâmica)", () => {
    const span = "npx tsx scripts/cleanup-merged-worktrees.ts ; echo ok";
    assert.ok(referencesInjectableCommand(span) && CHAIN_RE.test(span));
  });
});

describe("loadUnconditionalTargetsFromHook — extração a partir do hook real (#7315)", () => {
  it("extrai os 3 alvos incondicionais conhecidos, incluindo os 2 que a #7315 reportou como faltantes", () => {
    assert.ok(UNCONDITIONAL_TARGETS.includes("resolve-develop-plan-path.ts"));
    assert.ok(UNCONDITIONAL_TARGETS.includes("resolve-overnight-plan-path.ts"));
    assert.ok(UNCONDITIONAL_TARGETS.includes("cleanup-merged-worktrees.ts"));
  });

  it("nunca inclui TARGET_MARKER/TARGET_REGISTRY (esses têm regra por subcomando, não incondicional)", () => {
    assert.ok(!UNCONDITIONAL_TARGETS.includes(TARGET_MARKER));
    assert.ok(!UNCONDITIONAL_TARGETS.includes(TARGET_REGISTRY));
  });
});

describe("loadInjectableSubcommandsFromHook — extração a partir do hook real (#6351)", () => {
  it(".claude/hooks/inject-session-id.mjs existe neste checkout (senão a extração não testa nada)", () => {
    assert.ok(existsSync(INJECT_SESSION_ID_HOOK), `esperado existir: ${INJECT_SESSION_ID_HOOK}`);
  });

  it("extrai um regex não-vazio que reconhece subcomandos conhecidos, incluindo os que já divergiram no #6351", () => {
    // register/claim-issue eram os únicos cobertos pela cópia estática antiga;
    // grant-merge/conflicts/merge-lock-renew são os que já tinham divergido em
    // silêncio (#6351) — todos precisam bater agora que a lista vem do hook.
    for (const subcommand of [
      "register",
      "claim-issue",
      "unclaim-issue",
      "is-claimed",
      "conflicts",
      "grant-merge",
      "check-merge-grant",
      "consume-merge-grant",
      "merge-lock-acquire",
      "merge-lock-release",
      "merge-lock-renew",
    ]) {
      assert.ok(
        INJECTABLE_SUBCOMMANDS.test(subcommand),
        `esperado que o regex extraído do hook reconhecesse "${subcommand}"`,
      );
    }
  });

  it("não reconhece list-active (leitura pura, nunca deve entrar na lista injetável)", () => {
    assert.equal(INJECTABLE_SUBCOMMANDS.test("list-active"), false);
  });
});

describe("guard das SKILLs (#6232)", () => {
  it(".claude/skills existe neste checkout (senão o teste não está testando nada)", () => {
    assert.ok(existsSync(SKILLS_DIR), `esperado existir: ${SKILLS_DIR}`);
  });

  it("nenhuma SKILL.md contém chamada encadeada/pipada de overnight-session-marker.ts ou session-registry.ts (subcomandos injetáveis)", () => {
    const flagged = findChainedSessionCommandsInSkills(SKILLS_DIR);
    assert.deepEqual(
      flagged,
      [],
      "Encontrado(s) trecho(s) de SKILL.md invocando um comando que depende da injeção " +
        "automática de --session-id (.claude/hooks/inject-session-id.mjs) de forma " +
        "encadeada/pipada/multi-linha — a injeção NÃO acontece nesse formato (mesmo bug de " +
        "origem do #6232). Reescreva o comando como chamadas standalone separadas, uma por " +
        "linha de instrução (nunca dentro do mesmo bloco de código com &&/;/pipe), ou documente " +
        "explicitamente que a chamada precisa de --session-id manual:\n" +
        JSON.stringify(flagged, null, 2),
    );
  });
});
