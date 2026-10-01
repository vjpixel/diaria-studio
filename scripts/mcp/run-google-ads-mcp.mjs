#!/usr/bin/env node
/**
 * run-google-ads-mcp.mjs (#8994) — entrypoint do MCP `google-ads` em `.mcp.json`.
 *
 * Carrega GOOGLE_ADS_* / GOOGLE_APPLICATION_CREDENTIALS do `.env` do projeto
 * (sem sobrescrever o ambiente), recusa subir sem credencial, prefere o
 * binário `google-ads-mcp` instalado via `pipx install` e só cai em
 * `pipx run --spec` (lento) se ele faltar.
 * stdio é do servidor — este arquivo só escreve em stderr. Ver mcp-wrapper-core.mjs.
 */
import {
  GOOGLE_ADS_ENV_KEYS,
  buildSpawnSpec,
  launch,
  loadEnvOrExit,
  resolveGoogleAdsLaunch,
} from "./mcp-wrapper-core.mjs";

const env = loadEnvOrExit(GOOGLE_ADS_ENV_KEYS);
const resolved = resolveGoogleAdsLaunch(env);
if (resolved.error) {
  process.stderr.write(resolved.error + "\n");
  process.exit(1);
}
if (resolved.warning) process.stderr.write(resolved.warning + "\n");
launch(buildSpawnSpec(resolved.command, resolved.args), env);
