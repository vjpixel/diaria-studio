/**
 * test/subscribe-backend-branching-guard-6048.test.ts (#6048, reduzido no #6291)
 *
 * Guarda ESTRUTURAL, não caso-a-caso. Cobria originalmente os 3 workers da
 * migração #6048, cada um com seu PAR de nomes função-Beehiiv/função-Kit —
 * mas o #6291 tornou essa cobertura DESNECESSÁRIA (e, pior, incompatível
 * — ver abaixo) para 2 dos 3 pares:
 *
 *   - `poll`/`cursos`: `subscribeToBeehiiv`/`subscribeToKit` deixaram de ser
 *     `export`adas — só `subscribeViaConfiguredBackend` (subscribe.ts de
 *     cada worker) é exportada, e ela é o ÚNICO lugar que ainda chama as
 *     duas funções cruas. Um 6º call site que tentasse pular a ramificação
 *     não CONSEGUE mais importar as funções cruas — o erro deixou de ser
 *     detectável por este teste de regex e passou a ser inexprimível por
 *     tipo (`npx tsc --noEmit` recusa a importação direta). Cobertura de
 *     runtime equivalente (export ausente + parser tolerante de
 *     `SUBSCRIBE_BACKEND`) vive em
 *     `test/subscribe-backend-single-entrypoint-6291.test.ts`.
 *   - **Incompatibilidade, não só redundância:** o corpo de
 *     `subscribeViaConfiguredBackend` ramifica via `resolveBackend(env) ===
 *     "kit" ? ... : ...` — uma função auxiliar, não o literal
 *     `SUBSCRIBE_BACKEND` inline. O invariante A abaixo exige a palavra
 *     `SUBSCRIBE_BACKEND` no MESMO bloco da chamada; como só `resolveBackend`
 *     (função separada) contém esse literal, manter `poll`/`cursos` em
 *     `BACKEND_PAIRS` faria este teste FALHAR permanentemente contra código
 *     correto — não é opcional, precisava sair.
 *
 * `reativar` fica: usa `activateSubscription`/`activateSubscriptionKit`
 * (index.ts) — nomes e formato DIFERENTES (não `subscribeTo*`), semântica
 * diferente (ativar assinatura pendente, não criar uma nova), e um call
 * site com ternário ANINHADO 2:1 (ver invariante B abaixo) — fora do
 * escopo do #6291 (issue não pedia mexer nele; superfície de teste direto
 * já grande, ver docstring da issue). Continua coberto só pelo invariante A
 * abaixo — é a única defesa estrutural que resta neste arquivo.
 *
 * DOIS invariantes seguem definidos (código inalterado), mas só o par
 * `reativar` participa de `BACKEND_PAIRS` agora:
 *
 *   A. **Bloco de função top-level** — a função que contém a chamada ao lado
 *      "Beehiiv" de um par também contém `SUBSCRIBE_BACKEND` (literal) e uma
 *      chamada ao lado "Kit" do MESMO par. Pega uma FUNÇÃO NOVA inteira
 *      desguardada.
 *
 *   B. **Contagem balanceada por arquivo** — NÃO aplicada a `reativar` de
 *      propósito: `handleConfirm` (index.ts) tem `useKit ?
 *      activateSubscriptionKit(...) : sleepImpl ? activateSubscription(...,
 *      sleepImpl) : activateSubscription(...)` — ternário ANINHADO onde o
 *      lado Beehiiv tem 2 call sites legítimos (com/sem `sleepImpl`
 *      injetável de teste) para 1 do lado Kit. Contagem 2-para-1 é o estado
 *      CORRETO ali, não uma regressão.
 *
 * Delimitação de bloco (invariante A): funções top-level na coluna 0, sem
 * nesting profundo, em DUAS formas: `export async function nome(`/
 * `function nome(` OU `export const nome = async (...) => {`. O bloco de
 * uma chamada é do último início de função top-level ANTES dela até o
 * próximo (ou fim do arquivo).
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

// #6291: `poll` e `cursos` saíram — ver docstring do arquivo. Só `reativar`
// segue coberto por este guard de regex; os outros 2 pares viraram
// estruturalmente inalcançáveis (export removido).
const BACKEND_PAIRS: BackendPair[] = [
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

describe("reativar: toda chamada a activateSubscription ramifica por SUBSCRIBE_BACKEND (#6048, escopo reduzido no #6291)", () => {
  it("invariante A — nenhum call site desguardado (bloco da função contém a ramificação)", () => {
    const bad = findUnguardedCallSites();
    assert.deepEqual(
      bad,
      [],
      bad
        .map(
          (b) =>
            `[${b.worker}] ${b.file}:${b.line} — chama o backend legado sem ramificar por SUBSCRIBE_BACKEND na mesma função ` +
            `("${b.text}"). Ramifique: env.SUBSCRIBE_BACKEND === "kit" ? await <fnKit>(...) : await <fnLegado>(...).`,
        )
        .join("\n"),
    );
  });

  it("invariante B — vazio de propósito (nenhum par 1:1 restante — ver docstring do arquivo)", () => {
    const bad = findCountMismatches();
    assert.deepEqual(bad, []);
  });

  it("sanity: o scan encontra os call sites conhecidos hoje em reativar — silêncio não é proteção", () => {
    const sites = findAllLegacyCallSites();
    const byWorker = (w: string) => sites.filter((s) => s.worker === w).length;
    // reativar: 2 (handleConfirm — 2 call sites do lado legado, ver docstring
    // sobre o ternário aninhado com sleepImpl). Se isto cair, o scan parou de
    // enxergar call sites reais (falso "tudo guardado" por scan vazio, não
    // por conformidade real) — era exatamente o buraco do F3 pra `reativar`
    // antes da versão original deste guard.
    assert.ok(byWorker("reativar") >= 2, `reativar: esperava >=2, achou ${byWorker("reativar")}: ${JSON.stringify(sites.filter((s) => s.worker === "reativar"))}`);
  });
});
