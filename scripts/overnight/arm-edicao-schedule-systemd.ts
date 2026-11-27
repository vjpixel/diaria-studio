#!/usr/bin/env node
/**
 * SHIM de compatibilidade (#14121). O wrapper de armar/desarmar o timer da
 * edição agendada mudou para `scripts/edicao-agendada/arm-edicao-schedule-systemd.ts`;
 * este caminho segue funcionando para instruções e docs antigos que o citam.
 * Trava: `test/edicao-agendada-shims-14121.test.ts`.
 */
import { isMainModule } from "../lib/cli-args.ts";
import { runCli } from "../edicao-agendada/arm-edicao-schedule-systemd.ts";

export * from "../edicao-agendada/arm-edicao-schedule-systemd.ts";

if (isMainModule(import.meta.url)) runCli();
