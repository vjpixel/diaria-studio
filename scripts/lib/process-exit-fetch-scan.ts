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
 * verificadores de leitura; o resto fica para PR futuro). Duas ficaram
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
  "scripts/clarice-plan-wave.ts",
  "scripts/clarice-schedule-ramp.ts",
  "scripts/clarice-stripe-delta.ts",
  "scripts/cohort-engagement.ts",
  "scripts/delete-test-schedules.ts",
  "scripts/eia-compose.ts",
  "scripts/evaluate-brevo-diaria.ts",
  "scripts/google-ads-associate-token.ts",
  "scripts/inject-poll-token.ts",
  "scripts/oauth-setup.ts",
  "scripts/onboarding-welcome-run.ts",
  "scripts/publish-monthly.ts",
  "scripts/serve-preview.ts",
  "scripts/studio/verify-remote-tunnel.ts",
  "scripts/sync-apoio-nivel-beehiiv.ts",
  "scripts/sync-cursos-subscribers-kv.ts",
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
