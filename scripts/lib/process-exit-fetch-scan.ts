/**
 * process-exit-fetch-scan.ts (#9911): acha script em `scripts/` que usa
 * `fetch` E chama `process.exit(`, a combinação que no Windows (Node 24) sai
 * 127 em vez do código pedido (ver `scripts/lib/cli-exit.ts`).
 *
 * Critério por arquivo, via AST do TypeScript (comentário e string não contam):
 *  - "usa fetch": o identificador `fetch` aparece como VALOR — chamado
 *    (`fetch(url)`, `globalThis.fetch(url)`) ou passado adiante
 *    (`checkTokenRemote(fetch, …)`, `{ fetchFn: fetch }`). Nome de
 *    declaração, import e acesso `algo.fetch` em objeto que não é o global
 *    ficam de fora. Fetch feito só dentro de um módulo importado não é visto
 *    (limite conhecido: o guard é heurístico, não análise de fluxo).
 *  - "chama process.exit": qualquer `process.exit(...)`.
 *
 * `ALLOWLIST`: scripts ainda não migrados (#9911 migrou o conjunto prioritário
 * — LinkedIn pessoal, publish-facebook/instagram/linkedin/threads e os
 * scripts de Stage 2/4/5/6 — e, num 2º lote, 13 alarmes/reports/builders/
 * verificadores de leitura; num 3º lote (#9991), 6 scripts de até 4 saídas
 * — clarice-plan-wave, clarice-stripe-delta, delete-test-schedules,
 * inject-poll-token, sync-apoio-nivel-beehiiv, sync-cursos-subscribers-kv;
 * o resto fica para PR futuro). Restam servidores (`oauth-setup.ts` sobe o
 * callback HTTP), scripts com 5+ saídas e `clarice-engagement-cohorts-v2.ts`
 * (os testes substituem `process.exit` para observar o código). Duas ficaram
 * de propósito: `publish-monthly.ts` (os testes de integração substituem
 * `process.exit` para observar o código; migrar exige reescrever esses
 * testes) e `serve-preview.ts` (servidor de longa duração: o teardown por
 * SIGINT/SIGTERM e o `--ensure` saem com servidor ou filho ainda vivos, e
 * trocar por `exitCode` pode deixar o processo pendurado — pede revisão
 * saída por saída). A lista só encolhe: entrada que deixou de violar é reportada como
 * obsoleta e o teste falha até ela sair.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/** Paths relativos à raiz do repo, com `/`. Remover ao migrar. */
export const ALLOWLIST: ReadonlySet<string> = new Set([
  "scripts/clarice-engagement-cohorts-v2.ts",
  "scripts/clarice-schedule-ramp.ts",
  "scripts/cohort-engagement.ts",
  "scripts/eia-compose.ts",
  "scripts/evaluate-brevo-diaria.ts",
  "scripts/google-ads-associate-token.ts",
  "scripts/oauth-setup.ts",
  "scripts/onboarding-welcome-run.ts",
  "scripts/publish-monthly.ts",
  "scripts/serve-preview.ts",
  "scripts/studio/verify-remote-tunnel.ts",
  "scripts/sync-pending-to-brevo.ts",
  "scripts/verify-emails-mv.ts",
  "scripts/verify-pending-emails-mv.ts",
]);

const GLOBAL_OBJECTS = new Set(["globalThis", "global", "window", "self"]);

function isFetchValue(node: ts.Identifier): boolean {
  if (node.text !== "fetch") return false;
  const p = node.parent;
  if (!p) return false;
  // `algo.fetch`: conta só quando `algo` é o objeto global.
  if (ts.isPropertyAccessExpression(p) && p.name === node) {
    return ts.isIdentifier(p.expression) && GLOBAL_OBJECTS.has(p.expression.text);
  }
  // Nomes de declaração/importação/chave de objeto não são uso.
  if (
    (ts.isVariableDeclaration(p) && p.name === node) ||
    (ts.isParameter(p) && p.name === node) ||
    (ts.isFunctionDeclaration(p) && p.name === node) ||
    (ts.isPropertyAssignment(p) && p.name === node) ||
    (ts.isPropertySignature(p) && p.name === node) ||
    (ts.isPropertyDeclaration(p) && p.name === node) ||
    (ts.isMethodDeclaration(p) && p.name === node) ||
    (ts.isBindingElement(p) && (p.name === node || p.propertyName === node)) ||
    ts.isImportSpecifier(p) ||
    ts.isExportSpecifier(p) ||
    ts.isTypeQueryNode(p) ||
    ts.isQualifiedName(p)
  ) {
    return false;
  }
  return true;
}

function isProcessExitCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const e = node.expression;
  return (
    ts.isPropertyAccessExpression(e) &&
    e.name.text === "exit" &&
    ts.isIdentifier(e.expression) &&
    e.expression.text === "process"
  );
}

export interface FileScan {
  usesFetch: boolean;
  callsProcessExit: boolean;
}

export function scanSource(src: string, fileName = "x.ts"): FileScan {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const r: FileScan = { usesFetch: false, callsProcessExit: false };
  const visit = (n: ts.Node): void => {
    if (r.usesFetch && r.callsProcessExit) return;
    if (ts.isIdentifier(n) && isFetchValue(n)) r.usesFetch = true;
    if (isProcessExitCall(n)) r.callsProcessExit = true;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return r;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

export interface ScanResult {
  /** Arquivos com fetch + process.exit fora da allowlist. */
  violations: string[];
  /** Entradas da allowlist que já não violam (ou não existem) — remover. */
  stale: string[];
}

export function scanProcessExitAfterFetch(root: string, allowlist: ReadonlySet<string> = ALLOWLIST): ScanResult {
  const violating = new Set<string>();
  for (const abs of walkTs(join(root, "scripts"))) {
    const rel = relative(root, abs).split(sep).join("/");
    const s = scanSource(readFileSync(abs, "utf8"), abs);
    if (s.usesFetch && s.callsProcessExit) violating.add(rel);
  }
  return {
    violations: [...violating].filter((f) => !allowlist.has(f)).sort(),
    stale: [...allowlist].filter((f) => !violating.has(f)).sort(),
  };
}

// ---------------------------------------------------------------------------
// #9991: corpo de fetch não consumido em script que sai por `runCli` ou
// atribui `process.exitCode` à mão (#10022).
//
// `process.exit()` matava o socket de um `fetch` cujo corpo ninguém leu;
// com `process.exitCode` (o padrão do `runCli`) o processo só sai quando o
// loop esvazia, e o socket do undici com corpo pendente o segura até o
// servidor fechar ou um timeout abortar (PDF de vários MB no
// fetch-source-text: até ~20s a mais por chamada). A correção é
// `await res.body?.cancel().catch(() => {})` antes de sair sem ler.
//
// Heurística AST, por função, para cada variável `X` atribuída de
// `await fetch(...)` (também `fetchImpl`/`fetchFn` e `globalThis.fetch`):
//  - "never-consumed": `X` nunca tem o corpo lido (`X.json()`/`.text()`/
//    `.arrayBuffer()`/`.blob()`/`.formData()`/`X.body`) nem escapa (passado
//    como argumento, devolvido, atribuído a outra coisa).
//  - "exit-without-consume": um `if` cuja condição lê `X.algo` (ok, status,
//    headers) tem um ramo que sai (`return`/`continue`/`break`/`throw`)
//    sem consumir nem repassar `X`.
// Limites conhecidos: fetch feito dentro de módulo importado não é visto;
// a saída por fall-through depois de um `if (X.ok) { ... }` não é seguida.
// ---------------------------------------------------------------------------

const BODY_METHODS = new Set(["json", "text", "arrayBuffer", "blob", "formData", "bytes"]);
const FETCH_CALLEE_NAMES = new Set(["fetch", "fetchImpl", "fetchFn"]);

function isFetchCallee(e: ts.Expression): boolean {
  if (ts.isIdentifier(e)) return FETCH_CALLEE_NAMES.has(e.text);
  return (
    ts.isPropertyAccessExpression(e) &&
    e.name.text === "fetch" &&
    ts.isIdentifier(e.expression) &&
    GLOBAL_OBJECTS.has(e.expression.text)
  );
}

/**
 * `await fetch(...)` cujo corpo importa. `method: "HEAD"` literal fica de
 * fora: resposta de HEAD não tem corpo para segurar o socket.
 */
function isAwaitedFetch(e: ts.Expression | undefined): boolean {
  if (!e) return false;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isAwaitExpression(e) || !ts.isCallExpression(e.expression)) return false;
  const call = e.expression;
  if (!isFetchCallee(call.expression)) return false;
  const init = call.arguments[1];
  if (init && ts.isObjectLiteralExpression(init)) {
    for (const p of init.properties) {
      if (
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "method" &&
        ts.isStringLiteralLike(p.initializer) && p.initializer.text.toUpperCase() === "HEAD"
      ) {
        return false;
      }
    }
  }
  return true;
}

/** `console.algo(...)`: só imprime, não consome nem repassa o stream. */
function isConsoleCall(c: ts.CallExpression): boolean {
  const e = c.expression;
  return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "console";
}

/**
 * `X.body` (nó `p`) usado de um jeito que consome ou repassa o stream:
 * `X.body.cancel()`/`.getReader()`/`.pipeTo()` (qualquer acesso a membro),
 * argumento de chamada que não é `console.*`, `for await (… of X.body)`,
 * `return X.body`, atribuição. Ler só para inspecionar (`if (res.body)`,
 * `console.log(res.body)`, template string) não conta (#10022).
 */
function bodyAccessConsumes(p: ts.PropertyAccessExpression): boolean {
  let n: ts.Node = p;
  while (ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isAsExpression(n.parent)) n = n.parent;
  const q = n.parent;
  if (!q) return false;
  if ((ts.isPropertyAccessExpression(q) || ts.isElementAccessExpression(q)) && q.expression === n) return true;
  if (ts.isCallExpression(q)) return q.arguments.includes(n as ts.Expression) && !isConsoleCall(q);
  if (ts.isNewExpression(q)) return !!q.arguments?.includes(n as ts.Expression);
  return (
    (ts.isForOfStatement(q) && q.expression === n) ||
    ts.isReturnStatement(q) ||
    (ts.isArrowFunction(q) && q.body === n) ||
    (ts.isBinaryExpression(q) && q.right === n && q.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
    (ts.isVariableDeclaration(q) && q.initializer === n) ||
    (ts.isPropertyAssignment(q) && q.initializer === n) ||
    ts.isArrayLiteralExpression(q) ||
    ts.isSpreadElement(q)
  );
}

/** `n` é uma leitura de corpo de `X`: `X.json()`/`.text()`/... ou `X.body` consumido. */
function isBodyRead(n: ts.Node, name: string): n is ts.PropertyAccessExpression {
  if (!ts.isPropertyAccessExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== name) return false;
  const m = n.name.text;
  if (m === "body") return bodyAccessConsumes(n);
  return BODY_METHODS.has(m) && ts.isCallExpression(n.parent) && n.parent.expression === n;
}

/** Todas as leituras de corpo de `X` em `node`, sem descer em funções aninhadas. */
function bodyReads(node: ts.Node, name: string): ts.PropertyAccessExpression[] {
  const out: ts.PropertyAccessExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (isBodyRead(n, name)) out.push(n);
    if (isFunctionLike(n)) return;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return out;
}

/**
 * Passar de `child` para `parent` entra num caminho que pode não executar
 * (ramo de `if`, `?:`, lado direito de `&&`/`||`/`??`, corpo de laço,
 * `case`, `catch`).
 */
function isConditionalEdge(parent: ts.Node, child: ts.Node): boolean {
  if (ts.isIfStatement(parent)) return child !== parent.expression;
  if (ts.isConditionalExpression(parent)) return child !== parent.condition;
  if (ts.isBinaryExpression(parent)) {
    const k = parent.operatorToken.kind;
    return (
      child === parent.right &&
      (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken)
    );
  }
  if (ts.isIterationStatement(parent, false)) return child === parent.statement;
  return ts.isCaseClause(parent) || ts.isDefaultClause(parent) || ts.isCatchClause(parent);
}

/**
 * A leitura `read` acontece em todo caminho que chega ao `if` `target`
 * (aproximação de dominância): sobe de `read` até o primeiro ancestral
 * comum sem atravessar ramo condicional e exige que, ali, a leitura venha
 * antes (statement anterior no mesmo bloco, ou a condição do `if` que
 * contém `target`). Antes do #10022 qualquer leitura textualmente anterior
 * calava todos os `if` seguintes, inclusive uma leitura dentro de outro `if`.
 */
function dominates(read: ts.Node, target: ts.Node): boolean {
  if (read.getStart() >= target.getStart()) return false;
  const targetAncestors = new Set<ts.Node>();
  for (let a: ts.Node | undefined = target; a; a = a.parent) targetAncestors.add(a);
  let child: ts.Node = read;
  for (let p = read.parent; p; child = p, p = p.parent) {
    if (targetAncestors.has(p)) {
      if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p)) return true; // `child` é statement anterior
      if (ts.isIfStatement(p)) return child === p.expression;
      return false;
    }
    if (isFunctionLike(p) || isConditionalEdge(p, child)) return false;
  }
  return false;
}

/** `X` tem o corpo lido/cancelado ou é repassado (argumento, return, atribuição) dentro de `node`. */
function consumesOrEscapes(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name) {
      const p = n.parent;
      if (ts.isPropertyAccessExpression(p) && p.expression === n) {
        if (isBodyRead(p, name)) found = true;
      } else if (
        (ts.isCallExpression(p) && p.arguments.includes(n)) ||
        (ts.isNewExpression(p) && !!p.arguments?.includes(n)) ||
        ts.isReturnStatement(p) ||
        (ts.isArrowFunction(p) && p.body === n) ||
        (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
        (ts.isVariableDeclaration(p) && p.initializer === n) ||
        ts.isShorthandPropertyAssignment(p) ||
        (ts.isPropertyAssignment(p) && p.initializer === n) ||
        ts.isArrayLiteralExpression(p) ||
        ts.isSpreadElement(p)
      ) {
        found = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function readsPropertyOf(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) found = true;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function exits(s: ts.Statement): boolean {
  if (ts.isReturnStatement(s) || ts.isContinueStatement(s) || ts.isBreakStatement(s) || ts.isThrowStatement(s)) return true;
  if (ts.isBlock(s)) return s.statements.some(exits);
  return false;
}

function isFunctionLike(n: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n)
  );
}

export interface UnconsumedBody {
  line: number;
  name: string;
  reason: "never-consumed" | "exit-without-consume";
}

export function scanUnconsumedFetchBody(src: string, fileName = "x.ts"): UnconsumedBody[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: UnconsumedBody[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const checkFunction = (fn: ts.FunctionLikeDeclaration): void => {
    const body = fn.body;
    if (!body) return;
    // Variáveis desta função vindas de `await fetch(...)`, sem descer em funções aninhadas.
    // Cada `const X = await fetch()` é uma variável; atribuições ao mesmo `let`
    // (ex.: laço de redirects) contam uma vez só.
    const vars: Array<[string, ts.Node]> = [];
    const assigned = new Set<string>();
    const collect = (n: ts.Node): void => {
      if (isFunctionLike(n)) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && isAwaitedFetch(n.initializer)) {
        vars.push([n.name.text, n]);
      }
      if (
        ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(n.left) && isAwaitedFetch(n.right) && !assigned.has(n.left.text)
      ) {
        assigned.add(n.left.text);
        vars.push([n.left.text, n]);
      }
      ts.forEachChild(n, collect);
    };
    ts.forEachChild(body, collect);
    for (const [name, decl] of vars) {
      // Escopo: o bloco que contém a declaração (`const res` em blocos irmãos
      // são variáveis distintas); atribuição a `let` externo usa a função.
      let scope: ts.Node = body;
      if (ts.isVariableDeclaration(decl)) {
        for (let p: ts.Node | undefined = decl.parent; p && p !== body; p = p.parent) {
          if (ts.isBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p)) {
            scope = p;
            break;
          }
        }
      }
      const declPos = decl.getStart(sf);
      if (!consumesOrEscapes(scope, name)) {
        out.push({ line: lineOf(decl), name, reason: "never-consumed" });
        continue;
      }
      // Corpo já lido em todo caminho até o `if` (ex.: `const data = await
      // res.json()` e depois `if (!res.ok || !data.ok) return`): nada pendurado.
      const reads = bodyReads(scope, name);
      const visitIf = (n: ts.Node): void => {
        if (isFunctionLike(n)) return;
        if (
          ts.isIfStatement(n) && n.getStart(sf) > declPos && readsPropertyOf(n.expression, name) &&
          !reads.some((r) => dominates(r, n))
        ) {
          for (const branch of [n.thenStatement, n.elseStatement]) {
            if (branch && !ts.isIfStatement(branch) && exits(branch) && !consumesOrEscapes(branch, name)) {
              out.push({ line: lineOf(branch), name, reason: "exit-without-consume" });
            }
          }
        }
        ts.forEachChild(n, visitIf);
      };
      ts.forEachChild(scope, visitIf);
    }
  };

  const visit = (n: ts.Node): void => {
    if (isFunctionLike(n)) checkFunction(n as ts.FunctionLikeDeclaration);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Script que sai por `runCli` (importa `cli-exit`): onde o #9991 morde. */
export function usesRunCli(src: string): boolean {
  return /from\s+["'][^"']*\/cli-exit(\.ts|\.js)?["']/.test(src);
}

/**
 * Script que atribui `process.exitCode` à mão (`process.exitCode = 1`,
 * `||=`, `??=`...): sai pelo mesmo caminho do `runCli` — só quando o loop
 * esvazia — e por isso também é segurado por corpo pendente (#10022).
 */
export function assignsProcessExitCode(src: string): boolean {
  return /\bprocess\.exitCode\s*(?:\|\||&&|\?\?)?=(?!=)/.test(src);
}

export type BodyViolation = { file: string } & UnconsumedBody;

/**
 * Varre `scripts/` (fora de `scripts/lib/`) nos scripts que saem pelo loop
 * vazio: os que usam `runCli` e os que atribuem `process.exitCode` à mão.
 * Antes do #10022 só os do `runCli` eram vistos, e um script no padrão manual
 * (ex.: `clarice-plan-wave.ts`) reintroduzia o #9991 sem o guard perceber.
 */
export function scanUnconsumedBodyInExitCodeScripts(root: string): BodyViolation[] {
  const out: BodyViolation[] = [];
  for (const abs of walkTs(join(root, "scripts"))) {
    const rel = relative(root, abs).split(sep).join("/");
    if (rel.startsWith("scripts/lib/")) continue;
    const src = readFileSync(abs, "utf8");
    if (!usesRunCli(src) && !assignsProcessExitCode(src)) continue;
    for (const v of scanUnconsumedFetchBody(src, abs)) out.push({ file: rel, ...v });
  }
  return out;
}
