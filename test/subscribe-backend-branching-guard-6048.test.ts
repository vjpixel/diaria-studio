/**
 * test/subscribe-backend-branching-guard-6048.test.ts (#6048)
 *
 * Guarda ESTRUTURAL, não caso-a-caso: o bug original (#6048) existiu porque
 * o rollout Beehiiv→Kit migrou 1 dos 5 pontos de cadastro do worker `poll` —
 * `test/poll-subscribe-remaining-callsites-kit-6048.test.ts` prova que os 5
 * de HOJE ramificam por `SUBSCRIBE_BACKEND`, mas um teste por call site só
 * protege os call sites que já existem — não o 6º que alguém adicionar
 * amanhã sem lembrar de ramificar. É exatamente assim que este bug nasceu.
 *
 * Cobre os 3 workers da migração #6048, cada um com seu PAR de nomes
 * função-Beehiiv/função-Kit (achado do fleet review, F3: a 1ª versão deste
 * guard varria `workers/reativar/src` procurando `subscribeToBeehiiv(`/
 * `subscribeToKit(`, mas esse worker usa `activateSubscription`/
 * `activateSubscriptionKit` — proteção zero ali, com o docstring prometendo
 * cobertura que o código não entregava):
 *
 *   - `poll`:    `subscribeToBeehiiv`   / `subscribeToKit`   (subscribe.ts,
 *                importado por web-gate.ts/identify.ts/index.ts/magic-link.ts)
 *   - `cursos`:  `subscribeToBeehiiv`   / `subscribeToKit`   (subscribe.ts)
 *   - `reativar`: `activateSubscription` / `activateSubscriptionKit` (index.ts)
 *
 * DOIS invariantes independentes, nenhum sozinho cobre os dois cenários de
 * regressão (achado no fleet review pré-merge, 2 revisores independentes,
 * um reproduziu ao vivo):
 *
 *   A. **Bloco de função top-level** — a função que contém a chamada ao lado
 *      "Beehiiv" de um par também contém `SUBSCRIBE_BACKEND` e uma chamada
 *      ao lado "Kit" do MESMO par. Pega uma FUNÇÃO NOVA inteira desguardada
 *      (o cenário original do #6048). Falso negativo achado: uma 2ª chamada
 *      incondicional ao lado Beehiiv adicionada à MESMA função já migrada
 *      passa despercebida — o bloco já contém as duas palavras-chave por
 *      causa da chamada legítima anterior, e a nova chamada é absorvida
 *      pela presença delas em qualquer lugar do bloco (a checagem não
 *      amarra CHAMADA a RAMIFICAÇÃO, só bloco a bloco). Aplica-se aos 3
 *      pares — é a única defesa que cobre `reativar`.
 *
 *   B. **Contagem balanceada por arquivo, só para o par `poll`/`cursos`**
 *      — número de chamadas reais a `subscribeToBeehiiv(` ==
 *      `subscribeToKit(`, por arquivo. Todo call site migrado nasce em par
 *      (o ternário `SUBSCRIBE_BACKEND === "kit" ? subscribeToKit(...) :
 *      subscribeToBeehiiv(...)` sempre soma 1 de cada). Uma chamada
 *      incondicional nova a QUALQUER um dos dois lados do par desbalanceia a
 *      contagem do arquivo inteiro — pega exatamente o cenário que A não
 *      pega (chamada extra dentro de uma função já migrada), sem depender
 *      de detectar fronteira de bloco nenhuma.
 *
 *      NÃO estendida ao par `activateSubscription`/`activateSubscriptionKit`
 *      de `reativar` de propósito: `handleConfirm` (index.ts) tem
 *      `useKit ? activateSubscriptionKit(...) : sleepImpl ? activateSubscription(...,
 *      sleepImpl) : activateSubscription(...)` — um ternário ANINHADO onde o
 *      lado Beehiiv tem 2 call sites legítimos (com/sem `sleepImpl`
 *      injetável de teste) para 1 do lado Kit. Contagem 2-para-1 é o estado
 *      CORRETO ali, não uma regressão — aplicar invariante B a este par
 *      produziria falso positivo permanente. `reativar` fica coberto só
 *      pelo invariante A (que não depende de proporção, só de "as duas
 *      palavras-chave aparecem na mesma função").
 *
 * Escolhi as DUAS (para o par que suporta B) em vez de só B porque B sozinha
 * tem seu próprio ponto cego: um arquivo NOVO com 1 chamada de cada função,
 * mas em FUNÇÕES DIFERENTES e sem ramificação real entre elas (ex: uma
 * função chama só Beehiiv, outra função — sem relação — chama só Kit) teria
 * contagem 1-1 "balanceada" sem nenhum par de fato ramificar coisa nenhuma.
 * A é quem fecha esse buraco (exige as duas palavras-chave DENTRO da MESMA
 * função). Nenhuma das duas é AST — são heurísticas de texto — mas a
 * combinação cobre os dois cenários de regressão reproduzidos no review, e
 * cada uma cobre o ponto cego da outra.
 *
 * Delimitação de bloco (invariante A): os 3 workers seguem o mesmo estilo
 * — funções top-level na coluna 0, sem nesting profundo — mas em DUAS
 * formas: `export async function nome(`/`function nome(` OU
 * `export const nome = async (...) => {` (achado do 2º revisor: a forma
 * arrow não criava fronteira nenhuma no regex original, absorvendo a
 * chamada pro bloco da função ANTERIOR). O bloco de uma chamada é do
 * último início de função top-level ANTES dela até o próximo (ou fim do
 * arquivo).
 *
 * Escolhida (a combinação, não um inventário travado — array fixo de call
 * sites esperados) porque o objetivo explícito é não precisar de
 * manutenção quando um call site NOVO e já-corretamente-ramificado
 * aparecer — um inventário travado exigiria atualização manual toda vez,
 * reintroduzindo o mesmo tipo de esquecimento que causou o bug original.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface BackendPair {
  /** Diretório `src/` do worker (usado só para rótulo/documentação). */
  worker: string;
  dir: string;
  /** Nome da função que chama o backend legado (Beehiiv). */
  legacyFn: string;
  /** Nome da função que chama o backend novo (Kit). */
  kitFn: string;
  /** Se `true`, o par participa do invariante B (contagem balanceada) —
   * só vale para pares onde todo call site legítimo é estritamente 1
   * chamada legacy : 1 chamada kit. Ver docstring acima sobre por que
   * `reativar` fica de fora. */
  balancedCountInvariant: boolean;
}

const BACKEND_PAIRS: BackendPair[] = [
  {
    worker: "poll",
    dir: join(ROOT, "workers", "poll", "src"),
    legacyFn: "subscribeToBeehiiv",
    kitFn: "subscribeToKit",
    balancedCountInvariant: true,
  },
  {
    worker: "cursos",
    dir: join(ROOT, "workers", "cursos", "src"),
    legacyFn: "subscribeToBeehiiv",
    kitFn: "subscribeToKit",
    balancedCountInvariant: true,
  },
  {
    worker: "reativar",
    dir: join(ROOT, "workers", "reativar", "src"),
    legacyFn: "activateSubscription",
    kitFn: "activateSubscriptionKit",
    balancedCountInvariant: false,
  },
];

function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

// Início de função top-level, coluna 0, sem indentação — 2 formas usadas
// nos 3 workers: declaração (`function nome(`) e const-arrow
// (`export const nome = async (` / `export const nome = (`). `^`/`$` casam
// início/fim de CADA linha (o array já vem split por "\n").
const TOP_LEVEL_FN_START_RE =
  /^(export\s+)?(async\s+)?function\s+\w+\s*\(|^export\s+const\s+\w+\s*=\s*(async\s+)?\(/;

function makeCallRe(name: string): RegExp {
  return new RegExp(`${name}\\s*\\(`);
}
function makeDefinitionRe(name: string): RegExp {
  return new RegExp(`\\bfunction\\s+${name}\\s*\\(`);
}

// Linha de comentário (`//...`, `* ...` de JSDoc/bloco, ou abertura `/**`/`/*`)
// — referências em prosa a "subscribeToBeehiiv(" em docstrings (achado ao
// vivo: identify.ts:434, "...igual ao fail-soft de handleJogarSubscribe/
// subscribeToBeehiiv (identify_subscribe_failed).") não são chamadas reais.
const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*)/;

function isRealCallLine(line: string, callRe: RegExp, definitionRe: RegExp): boolean {
  return callRe.test(line) && !definitionRe.test(line) && !COMMENT_LINE_RE.test(line);
}

interface CallSite {
  worker: string;
  file: string;
  line: number; // 1-based
  text: string;
}

function findAllLegacyCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const pair of BACKEND_PAIRS) {
    const callRe = makeCallRe(pair.legacyFn);
    const definitionRe = makeDefinitionRe(pair.legacyFn);
    for (const file of tsFilesUnder(pair.dir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (isRealCallLine(line, callRe, definitionRe)) {
          sites.push({ worker: pair.worker, file: file.slice(ROOT.length + 1), line: i + 1, text: line.trim() });
        }
      });
    }
  }
  return sites;
}

/** Bloco de texto da função top-level que contém a linha `lineIdx` (0-based)
 * do arquivo já dividido em `lines`. */
function enclosingFunctionBlock(lines: string[], lineIdx: number): string {
  const fnStarts: number[] = [];
  lines.forEach((l, i) => {
    if (TOP_LEVEL_FN_START_RE.test(l)) fnStarts.push(i);
  });
  let start = 0;
  for (const s of fnStarts) {
    if (s <= lineIdx) start = s;
    else break;
  }
  const nextStart = fnStarts.find((s) => s > lineIdx);
  const end = nextStart ?? lines.length;
  return lines.slice(start, end).join("\n");
}

// ── Invariante A: bloco de função contém a ramificação (todos os pares) ────

function findUnguardedCallSites(): CallSite[] {
  const bad: CallSite[] = [];
  for (const pair of BACKEND_PAIRS) {
    const callRe = makeCallRe(pair.legacyFn);
    const definitionRe = makeDefinitionRe(pair.legacyFn);
    const kitCallRe = makeCallRe(pair.kitFn);
    for (const file of tsFilesUnder(pair.dir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!isRealCallLine(line, callRe, definitionRe)) return;
        const block = enclosingFunctionBlock(lines, i);
        const guarded = /SUBSCRIBE_BACKEND/.test(block) && kitCallRe.test(block);
        if (!guarded) {
          bad.push({ worker: pair.worker, file: file.slice(ROOT.length + 1), line: i + 1, text: line.trim() });
        }
      });
    }
  }
  return bad;
}

// ── Invariante B: contagem balanceada por arquivo (só pares 1:1) ───────────

interface CountMismatch {
  worker: string;
  file: string;
  legacyFn: string;
  kitFn: string;
  legacyCalls: number;
  kitCalls: number;
}

function findCountMismatches(): CountMismatch[] {
  const bad: CountMismatch[] = [];
  for (const pair of BACKEND_PAIRS) {
    if (!pair.balancedCountInvariant) continue;
    const callRe = makeCallRe(pair.legacyFn);
    const definitionRe = makeDefinitionRe(pair.legacyFn);
    const kitCallRe = makeCallRe(pair.kitFn);
    const kitDefinitionRe = makeDefinitionRe(pair.kitFn);
    for (const file of tsFilesUnder(pair.dir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      let legacyCalls = 0;
      let kitCalls = 0;
      for (const line of lines) {
        if (isRealCallLine(line, callRe, definitionRe)) legacyCalls++;
        if (isRealCallLine(line, kitCallRe, kitDefinitionRe)) kitCalls++;
      }
      // Arquivo sem NENHUMA das duas funções não participa deste invariante
      // — 0-0 é vácuo, não um par ramificado.
      if (legacyCalls === 0 && kitCalls === 0) continue;
      if (legacyCalls !== kitCalls) {
        bad.push({ worker: pair.worker, file: file.slice(ROOT.length + 1), legacyFn: pair.legacyFn, kitFn: pair.kitFn, legacyCalls, kitCalls });
      }
    }
  }
  return bad;
}

describe("toda chamada ao backend legado (Beehiiv) ramifica por SUBSCRIBE_BACKEND (#6048)", () => {
  it("invariante A — nenhum call site desguardado, nos 3 workers (bloco da função contém a ramificação)", () => {
    const bad = findUnguardedCallSites();
    assert.deepEqual(
      bad,
      [],
      bad
        .map(
          (b) =>
            `[${b.worker}] ${b.file}:${b.line} — chama o backend legado sem ramificar por SUBSCRIBE_BACKEND na mesma função ` +
            `("${b.text}"). Ramifique: env.SUBSCRIBE_BACKEND === "kit" ? await <fnKit>(...) : await <fnLegado>(...) ` +
            `— mesmo padrão de workers/poll/src/subscribe.ts:585-591.`,
        )
        .join("\n"),
    );
  });

  it("invariante B — contagem legado==Kit por arquivo, nos pares estritamente 1:1 (poll, cursos)", () => {
    const bad = findCountMismatches();
    assert.deepEqual(
      bad,
      [],
      bad
        .map(
          (b) =>
            `[${b.worker}] ${b.file} — ${b.legacyCalls}x ${b.legacyFn}( vs ${b.kitCalls}x ${b.kitFn}( (deveriam ser iguais: ` +
            `todo call site ramificado soma 1 de cada). Uma chamada incondicional nova a qualquer um dos dois lados ` +
            `desbalanceia a contagem — ache a chamada extra e ramifique-a.`,
        )
        .join("\n"),
    );
  });

  it("sanity: o scan encontra os call sites conhecidos hoje, nos 3 workers — silêncio não é proteção", () => {
    const sites = findAllLegacyCallSites();
    const byWorker = (w: string) => sites.filter((s) => s.worker === w).length;
    // poll: 5 (subscribe.ts, web-gate.ts, identify.ts, index.ts, magic-link.ts).
    // cursos: 1 (subscribe.ts).
    // reativar: 2 (handleConfirm — 2 call sites do lado legado, ver docstring
    // sobre o ternário aninhado com sleepImpl).
    // Se algum destes cair, o scan parou de enxergar call sites reais naquele
    // worker (falso "tudo guardado" por scan vazio, não por conformidade real)
    // — era exatamente o buraco do F3 pra `reativar` antes desta versão.
    assert.ok(byWorker("poll") >= 5, `poll: esperava >=5, achou ${byWorker("poll")}`);
    assert.ok(byWorker("cursos") >= 1, `cursos: esperava >=1, achou ${byWorker("cursos")}`);
    assert.ok(byWorker("reativar") >= 2, `reativar: esperava >=2, achou ${byWorker("reativar")}: ${JSON.stringify(sites.filter((s) => s.worker === "reativar"))}`);
  });
});
