#!/usr/bin/env node
/**
 * SHIM de compatibilidade (#14121). O gerador dos units da edição agendada
 * mudou para `scripts/edicao-agendada/setup-edicao-schedule-systemd.ts`; este
 * caminho segue funcionando para instruções e docs antigos que o citam.
 * Trava: `test/edicao-agendada-shims-14121.test.ts`.
 */
import { isMainModule } from "../lib/cli-args.ts";
import { runCli } from "../edicao-agendada/setup-edicao-schedule-systemd.ts";

export * from "../edicao-agendada/setup-edicao-schedule-systemd.ts";

if (isMainModule(import.meta.url)) runCli();
