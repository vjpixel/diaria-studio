#!/usr/bin/env node
/**
 * run-doppler-mcp.mjs (#8994) — entrypoint do MCP `doppler` em `.mcp.json`.
 *
 * Lê DOPPLER_MCP_TOKEN do ambiente ou, se ausente/vazio, do `.env` do projeto;
 * repassa ao servidor como DOPPLER_TOKEN (só no ambiente do filho). Sem token,
 * sai com código 1 e mensagem clara em stderr em vez de subir o servidor com
 * token vazio (que o harness só reportava como CONNECTION_CLOSED).
 * stdio é do servidor — este arquivo só escreve em stderr. Ver mcp-wrapper-core.mjs.
 */
import {
  DOPPLER_MCP_TOKEN_KEY,
  buildDopplerChildEnv,
  buildSpawnSpec,
  launch,
  loadEnvOrExit,
  resolveDopplerLaunch,
} from "./mcp-wrapper-core.mjs";

const merged = loadEnvOrExit([DOPPLER_MCP_TOKEN_KEY]);
const resolved = resolveDopplerLaunch(merged);
if (resolved.error) {
  process.stderr.write(resolved.error + "\n");
  process.exit(1);
}
launch(buildSpawnSpec(resolved.command, resolved.args), buildDopplerChildEnv(merged, resolved.childEnv));
