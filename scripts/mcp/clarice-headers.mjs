#!/usr/bin/env node
/**
 * clarice-headers.mjs (#11251) — `headersHelper` do MCP `clarice` em `.mcp.json`.
 *
 * Imprime em stdout um objeto JSON de headers (`{"X-Clarice-Api-Key": "..."}`),
 * o formato que o Claude Code espera de um `headersHelper` (doc oficial,
 * https://code.claude.com/docs/en/mcp, "Use dynamic headers for custom
 * authentication": comando rodado num shell, cwd = diretório do projeto que
 * declara o `.mcp.json`, timeout de 10s, header dinâmico sobrepõe o estático
 * de mesmo nome).
 *
 * Por que helper e não só `${CLARICE_API_KEY}` no `headers`: o `${VAR}` é
 * expandido do ambiente do processo do Claude Code, que só tem a key quando
 * quem lança a sessão carrega o `.env` (o unit da edição agendada faz isso com
 * `EnvironmentFile=`, #5114; as sessões interativas do `300` não). Sem a var,
 * o header ia vazio e o MCP respondia 401 (#11251). Este helper lê a key do
 * ambiente ou, se ausente/vazia, do `.env` do projeto — mesma precedência dos
 * wrappers do #8994 —, independente de como a sessão foi lançada. A doc diz
 * ainda que o Claude Code tira do ambiente de um helper de repositório as
 * vars com cara de credencial (nome com `KEY`, `TOKEN`...), então na prática
 * o `.env` é a fonte.
 *
 * Sem key: exit 1 com mensagem em stderr, nada em stdout (nunca um header
 * vazio). A key nunca vai pra stderr.
 */
import { CLARICE_API_KEY_KEY, loadEnvOrExit, resolveClariceHeaders } from "./mcp-wrapper-core.mjs";

const resolved = resolveClariceHeaders(loadEnvOrExit([CLARICE_API_KEY_KEY]));
if (resolved.error) {
  process.stderr.write(resolved.error + "\n");
  process.exit(1);
}
process.stdout.write(JSON.stringify(resolved.headers) + "\n");
