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
 * `.env` do projeto, independente de como a sessão foi lançada. (O código usa
 * a precedência ambiente > `.env` dos wrappers do #8994, mas o Claude Code
 * tira do ambiente de um helper de repositório as vars com cara de credencial
 * — nome com `KEY`, `TOKEN`... —, então na prática o `.env` é a única fonte.)
 * O helper só roda em pasta com trust aceito; sem trust (inclusive `claude -p`
 * headless), vale só o header estático.
 *
 * Nunca sai com erro (revisão do #11251): sem key utilizável — ausente no
 * `.env`, com quebra de linha, ou `.env` ilegível — imprime `{}` (nenhum
 * header dinâmico, nunca um header vazio) e exit 0, com o motivo em stderr.
 * Assim o `${CLARICE_API_KEY}` estático continua cobrindo a máquina que tem
 * a key só no ambiente (o helper não a vê: o ambiente dele vem sem vars com
 * `KEY` no nome). A key nunca vai pra stderr.
 */
import {
  CLARICE_API_KEY_KEY,
  EnvFileReadError,
  envWithProjectKeys,
  resolveClariceHeaders,
} from "./mcp-wrapper-core.mjs";

let env;
try {
  ({ env } = envWithProjectKeys([CLARICE_API_KEY_KEY]));
} catch (err) {
  if (!(err instanceof EnvFileReadError)) throw err;
  // `.env` existe mas não lê — mesmo racional do "sem key": não derrubar o estático.
  process.stderr.write(err.message + "\n");
  env = {};
}
const resolved = resolveClariceHeaders(env);
if (resolved.warning) process.stderr.write(resolved.warning + "\n");
process.stdout.write(JSON.stringify(resolved.headers) + "\n");
