#!/usr/bin/env node
/**
 * SHIM de compatibilidade (#14121). O runner da edição agendada mudou para
 * `scripts/edicao-agendada/run-scheduled-edicao.ts`; este caminho continua
 * funcionando para units systemd, tasks e wrappers já instalados que o citam.
 * Re-exporta tudo e, rodado como script, executa o mesmo CLI. Código novo
 * importa e invoca o caminho novo. Trava: `test/edicao-agendada-shims-14121.test.ts`.
 */
import { isMainModule } from "../lib/cli-args.ts";
import { runCli } from "../edicao-agendada/run-scheduled-edicao.ts";

export * from "../edicao-agendada/run-scheduled-edicao.ts";

if (isMainModule(import.meta.url)) runCli();
