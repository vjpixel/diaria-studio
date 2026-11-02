/**
 * check-adhoc-research-candidates.ts (#11797)
 *
 * Confere a saída de uma pesquisa ad-hoc de candidatos (ex.: newsletters
 * recebidas desde DD/MM) antes de o coordenador sugerir qualquer item ao
 * editor. Regras em `scripts/lib/adhoc-research-gate.ts`; protocolo do
 * dispatch em `context/adhoc-research-rules.md`.
 *
 * Uso:
 *   npx tsx scripts/check-adhoc-research-candidates.ts \
 *     --candidates <candidatos.json> --window-start YYYY-MM-DD [--out <relatorio.json>]
 *
 * Input: array de candidatos (ou `{ candidates: [...] }`), cada um
 *   { url, title?, date, date_source: "primary"|"newsletter"|"unknown",
 *     claims?: [{ text, source: "primary"|"newsletter"|"unknown", source_url? }] }
 *
 * Stdout: relatório JSON (`AdhocGateReport`).
 * Exit: 0 = todos `ok`; 3 = algum `nao_verificado`/`fora_da_janela` (o
 * coordenador repassa o veredito ao editor, nunca sugere o item como
 * verificado); 1 = erro de uso/leitura.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import {
  classifyAdhocCandidates,
  type AdhocCandidate,
} from "./lib/adhoc-research-gate.ts";

export function parseCandidatesJson(raw: string): AdhocCandidate[] {
  const parsed: unknown = JSON.parse(raw);
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { candidates?: unknown }).candidates)
      ? (parsed as { candidates: unknown[] }).candidates
      : null;
  if (!list) throw new Error("input deve ser um array de candidatos ou { candidates: [...] }");
  for (const [i, c] of list.entries()) {
    if (!c || typeof c !== "object" || typeof (c as { url?: unknown }).url !== "string") {
      throw new Error(`candidato ${i} sem campo url (string)`);
    }
  }
  return list as AdhocCandidate[];
}

function main(): number {
  const { values } = parseArgs(process.argv.slice(2));
  const candidatesPath = values["candidates"];
  const windowStart = values["window-start"];
  if (!candidatesPath || !windowStart) {
    console.error(
      "uso: check-adhoc-research-candidates.ts --candidates <json> --window-start YYYY-MM-DD [--out <json>]",
    );
    return 1;
  }
  const candidates = parseCandidatesJson(readFileSync(candidatesPath, "utf8"));
  const report = classifyAdhocCandidates(candidates, windowStart);
  const json = JSON.stringify(report, null, 2);
  if (values["out"]) writeFileSync(values["out"], json + "\n", "utf8");
  console.log(json);
  return report.ok === report.total ? 0 : 3;
}

if (isMainModule(import.meta.url)) {
  void runCli(main);
}
