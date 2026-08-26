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
 * Mecanismo: varre `workers/poll/src/`, `workers/cursos/src/` e
 * `workers/reativar/src/` (os 3 workers da migração #6048) atrás de TODA
 * chamada a `subscribeToBeehiiv(` que não seja a própria DEFINIÇÃO da função
 * (`export async function subscribeToBeehiiv`), e afirma que ela está dentro
 * de um bloco de função top-level que também contém `SUBSCRIBE_BACKEND` e
 * uma chamada a `subscribeToKit(` — ou seja, a seleção de backend
 * (`env.SUBSCRIBE_BACKEND === "kit" ? subscribeToKit(...) : subscribeToBeehiiv(...)`,
 * mesmo padrão em todo call site já migrado).
 *
 * Delimitação de bloco: os 3 workers seguem o mesmo estilo — funções
 * top-level (`export async function nome(` / `function nome(` na coluna 0,
 * sem nesting profundo). O bloco de uma chamada é do último início de função
 * top-level ANTES dela até o próximo início de função top-level (ou fim do
 * arquivo) — não é AST, é heurística de texto, mas o suficiente pro que este
 * guard protege: "a ramificação existe na MESMA função que faz a chamada".
 *
 * Escolhida em vez de um inventário travado (array fixo de call sites
 * esperados) porque o objetivo explícito é não precisar de manutenção
 * quando um call site NOVO aparecer — um inventário travado exigiria
 * atualização manual toda vez que alguém adicionasse um cadastro legítimo já
 * ramificado, o que reintroduz o mesmo tipo de esquecimento que causou o bug
 * original. A troca é heurística de texto (não semântica) — aceitável porque
 * o guard só precisa detectar AUSÊNCIA de ramificação, não validar a
 * ramificação em si (isso já é coberto caso-a-caso pelo teste irmão).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_DIRS = [
  join(ROOT, "workers", "poll", "src"),
  join(ROOT, "workers", "cursos", "src"),
  join(ROOT, "workers", "reativar", "src"),
];

function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

// Início de função top-level: coluna 0, sem indentação — o estilo real dos
// 3 workers (ver docstring acima). `^`/`$` casam início/fim de CADA linha
// (o array já vem split por "\n", uma string por linha).
const TOP_LEVEL_FN_START_RE = /^(export\s+)?(async\s+)?function\s+\w+\s*\(/;

// Chamada (não definição) — exclui a linha `... function subscribeToBeehiiv(`.
const CALL_RE = /subscribeToBeehiiv\s*\(/;
const DEFINITION_RE = /\bfunction\s+subscribeToBeehiiv\s*\(/;
// Linha de comentário (`//...`, `* ...` de JSDoc/bloco, ou abertura `/**`/`/*`)
// — referências em prosa a "subscribeToBeehiiv(" em docstrings (achado ao
// vivo: identify.ts:434, "...igual ao fail-soft de handleJogarSubscribe/
// subscribeToBeehiiv (identify_subscribe_failed).") não são chamadas reais.
const COMMENT_LINE_RE = /^\s*(\/\/|\/\*|\*)/;

function isRealCallLine(line: string): boolean {
  return CALL_RE.test(line) && !DEFINITION_RE.test(line) && !COMMENT_LINE_RE.test(line);
}

interface CallSite {
  file: string;
  line: number; // 1-based
  text: string;
}

function findAllCallSites(): CallSite[] {
  const sites: CallSite[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of tsFilesUnder(dir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (isRealCallLine(line)) {
          sites.push({ file: file.slice(ROOT.length + 1), line: i + 1, text: line.trim() });
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

function findUnguardedCallSites(): CallSite[] {
  const bad: CallSite[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of tsFilesUnder(dir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!isRealCallLine(line)) return;
        const block = enclosingFunctionBlock(lines, i);
        const guarded = /SUBSCRIBE_BACKEND/.test(block) && /subscribeToKit\s*\(/.test(block);
        if (!guarded) {
          bad.push({ file: file.slice(ROOT.length + 1), line: i + 1, text: line.trim() });
        }
      });
    }
  }
  return bad;
}

describe("toda chamada a subscribeToBeehiiv( ramifica por SUBSCRIBE_BACKEND (#6048)", () => {
  it("nenhum call site desguardado em workers/{poll,cursos,reativar}/src", () => {
    const bad = findUnguardedCallSites();
    assert.deepEqual(
      bad,
      [],
      bad
        .map(
          (b) =>
            `${b.file}:${b.line} — chama subscribeToBeehiiv sem ramificar por SUBSCRIBE_BACKEND na mesma função ` +
            `("${b.text}"). Ramifique: env.SUBSCRIBE_BACKEND === "kit" ? await subscribeToKit(...) : await subscribeToBeehiiv(...) ` +
            `— mesmo padrão de workers/poll/src/subscribe.ts:585-591.`,
        )
        .join("\n"),
    );
  });

  it("sanity: o scan encontra os call sites conhecidos hoje — silêncio não é proteção", () => {
    const sites = findAllCallSites();
    // 5 em workers/poll/src (subscribe.ts, web-gate.ts, identify.ts,
    // index.ts, magic-link.ts) + 1 em workers/cursos/src/subscribe.ts.
    // Se este número cair, o scan parou de enxergar call sites reais
    // (falso "tudo guardado" por scan vazio, não por conformidade real).
    assert.ok(
      sites.length >= 6,
      `esperava >=6 call sites de subscribeToBeehiiv( nos 3 workers, achou ${sites.length}: ${JSON.stringify(sites)}`,
    );
  });
});
