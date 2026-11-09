/**
 * env-loader.ts (#923, consolidado pra arquivo único em #4820)
 *
 * Carrega `.env` do root do projeto em scripts standalone (`npx tsx`).
 *
 * **Por que isto existe:** scripts standalone não herdam env vars carregadas
 * pelo orchestrator (Claude Code Bash inherits shell env, mas o terminal
 * raramente tem `set -a; source .env; set +a` ativo). Sem esse loader,
 * `process.env.DIARIA_LINKEDIN_CRON_TOKEN` fica `undefined` mesmo com a var
 * presente em `.env` — causa fallback silencioso pra fire-now em
 * `publish-linkedin.ts --schedule`, que postou 3 posts à 1h da manhã
 * em vez de agendar (incidente 2026-05-07, #923).
 *
 * **#4820 — `.env.local` deixou de ser suportado.** O projeto tinha 2
 * arquivos possíveis pra credencial (`.env.local` com precedência, `.env`
 * como fallback), o que já causou diagnóstico errado de credencial "ausente"
 * quando na verdade só estava no arquivo não-checado (achado ao vivo 260809).
 * Decisão do editor: consolidar pra um único arquivo. Risco assumido: uma
 * key que só exista em `.env.local` numa máquina para de carregar sem aviso
 * — migrar o conteúdo pra `.env` é responsabilidade de quem tiver esse
 * arquivo local (checagem pendente do PR, ver PR body).
 *
 * **Precedência:** vars já presentes em `process.env` ganham (não sobrescreve
 * o que já foi setado no shell/ambiente).
 *
 * **Aviso de divergência (#8237, achado ao vivo 17/09/2026).** No Neo, o
 * processo da sessão do Claude Code já carrega `GOOGLE_CLIENT_ID`/
 * `GOOGLE_CLIENT_SECRET` no ambiente com valores DIFERENTES dos do `.env`
 * do projeto — origem provável: o app desktop injeta essas 2 chaves pra
 * algum uso interno de OAuth Google, sem relação com este repo. Como a
 * precedência acima é deliberada, `loadProjectEnv` nunca sobrescreve — mas
 * o silêncio total escondeu o problema por dias: `microsoft-ads-ingest.ts`
 * (identidade Google do Microsoft Ads) renovava o token contra a conta
 * ERRADA, sempre com `Unauthorized`, sem nenhum sinal de que a causa era
 * uma var poluída, não uma credencial mal configurada. `warnOnEnvDivergence`
 * fecha esse buraco: compara cada chave do `.env` contra o que já está em
 * `process.env` e avisa em `stderr` quando os valores diferem — nunca
 * aborta, nunca muda qual valor vence (seria mudar o invariante que
 * `test/env-loader.test.ts` trava: "não sobrescreve var já presente em
 * process.env"). Fail-soft por completo: qualquer erro ao ler/parsear o
 * `.env` pra comparação é engolido — o load real (via `dotenvConfig`
 * abaixo) é quem decide se o arquivo é válido, este aviso é só diagnóstico.
 *
 * **Exceção estreita: o mesmo `.env` lido pelo systemd (#12477, achado
 * 08/11/2026 no `300`).** As units fazem `EnvironmentFile=-{repo}/.env`
 * (#5114), então a var já chega no ambiente vinda DESTE arquivo, mas lida pelo
 * parser do systemd, que trata `\` de outro jeito. Em
 * `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` (gravado sem aspas por
 * `materialize-google-ads-credentials.ts`) o systemd remove as barras e os
 * `\n` da `private_key` viram `n`: o aviso saía em todo log de task e o
 * processo ficava com uma chave PEM corrompida. Não são duas credenciais, é
 * uma lida por dois parsers. `adoptDotenvForSystemdParsedKeys` reconhece esse
 * caso por igualdade EXATA (valor do ambiente === parse systemd do `.env` E
 * !== parse dotenv) e adota o valor do dotenv, que é o formato em que o
 * projeto grava o arquivo. Qualquer outra divergência (processo pai, shell,
 * app desktop como no #8237) segue intacta: o ambiente vence e o aviso sai.
 *
 * Uso:
 * ```ts
 * import { loadProjectEnv } from "./lib/env-loader.ts";
 * loadProjectEnv();
 * // resto do script — agora process.env tem .env carregado
 * ```
 *
 * Pode ser chamado multiplas vezes — idempotente.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as dotenvConfig, parse as dotenvParse } from "dotenv";

import { parseSystemdEnvironmentFile } from "./systemd-env-file.ts";

/**
 * Chaves já avisadas nesta execução do processo — `loadProjectEnv()` roda
 * mais de uma vez por pipeline (ex: `stage-0-run.ts` chama direto E de novo
 * via `preflightExternalLocks()`), e como a divergência é sempre a mesma
 * enquanto o processo pai não muda, repetir o aviso idêntico só adiciona
 * ruído sem informação nova. Módulo-level de propósito — nunca reseta
 * dentro do mesmo processo Node; um processo novo (próxima invocação do
 * script) volta a avisar, que é o comportamento certo.
 */
const warnedKeys = new Set<string>();

/**
 * Compara as chaves do `.env` contra `process.env` e imprime em `stderr` um
 * aviso por chave cujo valor diverge — nunca lança, nunca muda qual valor
 * "ganha" (isso continua sendo decidido só por `dotenvConfig({override:false})`
 * em `loadProjectEnv`, chamado logo depois). No máximo 1 aviso por chave por
 * processo (`warnedKeys`). Exportado separadamente pra teste isolar a lógica
 * de comparação sem depender de `process.env` real.
 */
export function warnOnEnvDivergence(envFile: string, env: NodeJS.ProcessEnv = process.env): void {
  let parsed: Record<string, string>;
  try {
    parsed = dotenvParse(readFileSync(envFile, "utf8"));
  } catch {
    return; // fail-soft — dotenvConfig() é quem trata erro de leitura/parse de verdade
  }
  for (const [key, fileValue] of Object.entries(parsed)) {
    const envValue = env[key];
    if (envValue !== undefined && envValue !== fileValue && !warnedKeys.has(key)) {
      warnedKeys.add(key);
      console.warn(
        `env-loader: "${key}" já está definida no ambiente com um valor diferente do que está em .env — ` +
          `a variável do ambiente vence (precedência deliberada, ver docstring de loadProjectEnv), o .env é ` +
          `ignorado pra esta chave. Se o valor do ambiente não é o esperado, confira de onde ele está vindo ` +
          `(processo pai, shell, outra sessão) antes de assumir que a credencial de .env está em uso.` +
          (env.INVOCATION_ID
            ? ` Rodando sob systemd: confira Environment=/EnvironmentFile= da unit e drop-ins ` +
              `(\`systemctl --user cat <unit>\`), ~/.config/environment.d e o ambiente do user manager ` +
              `(\`systemctl --user show-environment\`); ver docs/systemd-env-divergence.md (#12477).`
            : ""),
      );
    }
  }
}

/**
 * Para cada chave cujo valor no ambiente é exatamente o que o systemd leria do
 * `.env` (`EnvironmentFile=`) e difere do que o dotenv lê, troca pelo valor do
 * dotenv (#12477). Devolve as chaves trocadas. Nunca lança: erro de leitura
 * vira lista vazia, e aí nada muda (o aviso de divergência decide sozinho).
 *
 * Igualdade exata com o parse do systemd é a prova de que o valor veio deste
 * arquivo e não de outra fonte; sem ela, o ambiente continua vencendo.
 */
export function adoptDotenvForSystemdParsedKeys(envFile: string, env: NodeJS.ProcessEnv = process.env): string[] {
  let content: string;
  let dotenvValues: Record<string, string>;
  let systemdValues: Record<string, string>;
  try {
    content = readFileSync(envFile, "utf8");
    dotenvValues = dotenvParse(content);
    systemdValues = parseSystemdEnvironmentFile(content);
  } catch {
    return [];
  }
  const adopted: string[] = [];
  for (const [key, fileValue] of Object.entries(dotenvValues)) {
    const envValue = env[key];
    const systemdValue = systemdValues[key];
    if (envValue === undefined || systemdValue === undefined) continue;
    if (envValue === systemdValue && envValue !== fileValue) {
      env[key] = fileValue;
      adopted.push(key);
    }
  }
  return adopted;
}

/**
 * Carrega `.env` do root do projeto.
 *
 * @param rootOverride  Path absoluto do root (default: 2 níveis acima de scripts/lib)
 * @returns             Lista de paths dos .env files efetivamente carregados
 */
export function loadProjectEnv(rootOverride?: string): string[] {
  const root = rootOverride ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const loaded: string[] = [];

  const envFile = resolve(root, ".env");
  if (existsSync(envFile)) {
    adoptDotenvForSystemdParsedKeys(envFile);
    warnOnEnvDivergence(envFile);
    dotenvConfig({ path: envFile, override: false });
    loaded.push(envFile);
  }

  return loaded;
}
