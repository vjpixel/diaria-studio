#!/usr/bin/env node
/**
 * confirmation-path-probe.ts (#8548 item 4) — confere, só com GET, que o
 * caminho depois do clique de confirmação (Kit DOI e botão da Brevo) termina
 * na página `diar.ia.br/confirmada` no ar, sem erro. Lógica e limites em
 * `scripts/lib/confirmation-path-probe.ts`.
 *
 * Uso: `npx tsx scripts/confirmation-path-probe.ts [--json]`
 *
 * Exit: 0 = todos os destinos ok; 1 = algum destino com problema.
 */
import {
  CONFIRMATION_PATH_PROBES,
  evaluateConfirmationProbe,
  fetchConfirmationProbe,
  type ProbeVerdict,
} from "./lib/confirmation-path-probe.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";

export async function runConfirmationPathProbe(fetchFn: typeof fetch = fetch): Promise<ProbeVerdict[]> {
  return Promise.all(
    CONFIRMATION_PATH_PROBES.map(async (probe) => evaluateConfirmationProbe(probe, await fetchConfirmationProbe(probe, fetchFn))),
  );
}

export function renderProbeReport(verdicts: readonly ProbeVerdict[]): string {
  const lines: string[] = ["Caminho pós-confirmação (#8548 item 4)", ""];
  for (const v of verdicts) {
    lines.push(`${v.ok ? "ok  " : "FALHA"} ${v.id}: ${v.url} -> ${v.finalUrl ?? "(sem resposta)"} [${v.finalStatus ?? "-"}, ${v.saltos} salto(s)]`);
    for (const p of v.problemas) lines.push(`      - ${p}`);
  }
  lines.push(
    "",
    "Fora da sonda: o link do botão do e-mail (app.kit.com/forms/confirm?key=…) e o campo",
    '"After confirming redirect to" do form 9897918, que só se conferem no painel do Kit.',
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const verdicts = await runConfirmationPathProbe();
  if (hasFlag(process.argv.slice(2), "json")) console.log(JSON.stringify(verdicts, null, 2));
  else console.log(renderProbeReport(verdicts));
  process.exitCode = verdicts.every((v) => v.ok) ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[confirmation-path-probe] erro: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
