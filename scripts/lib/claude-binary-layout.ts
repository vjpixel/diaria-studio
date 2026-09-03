/**
 * scripts/lib/claude-binary-layout.ts (#7189)
 *
 * ─── A classe de erro que este módulo existe pra nomear ─────────────────────
 *
 * Rodada `/diaria-overnight` 260902: **4 ocorrências** de
 * `Error: claude native binary not installed.` saindo NO LUGAR do resultado
 * de comandos `npx tsx …` — inclusive `check-pr-checks-gate.ts`, cujo
 * veredito é o que decide se um PR pode mergear. O erro imprime a instrução
 * padrão do pacote `@anthropic-ai/claude-code` ("rode
 * `node node_modules/@anthropic-ai/claude-code/install.cjs`"), plausível o
 * bastante pra ser lido como "o gate reprovou" por quem não sabe o que
 * procurar — mesma família de risco documentada na #7140 (resposta errada,
 * plausível, aceita como se fosse a resposta certa).
 *
 * Estado medido ao vivo (helios, 02-03/09/2026, reproduzido de novo ao
 * investigar esta issue): o install global do CLI
 * (`~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/`) tinha
 * `bin/` contendo **só `claude.exe`** (binário Windows) numa máquina
 * **Linux** — o `cli-wrapper.cjs` do próprio pacote resolve o binário da
 * plataforma corrente via `PLATFORMS[platformKey].bin`
 * (`claude`/`claude.exe` conforme `process.platform`) mais
 * `require.resolve` do pacote `@anthropic-ai/claude-code-{platform}`
 * correspondente — layout de plataforma ERRADA no prefixo global faz
 * qualquer invocação de `claude` (inclusive as que o harness dispara
 * internamente ao redor de cada chamada de ferramenta Bash) falhar com essa
 * mensagem, mesmo que o pacote npm em si esteja instalado corretamente.
 *
 * Rodar `node install.cjs` manualmente NÃO corrige sozinho quando a causa é
 * layout cruzado — reinstala pra plataforma atual, mas se algo continuar
 * sobrescrevendo com o layout de outra plataforma depois (hipótese não
 * confirmada por este módulo: prefixo `~/.npm-global` compartilhado/
 * sincronizado entre a máquina Windows e a Linux do editor), o sintoma
 * volta. Este módulo não tenta consertar isso (fora do repo, ação do
 * editor) — só nomeia a causa real em vez de deixar o sintoma se disfarçar
 * de "check reprovado".
 *
 * ─── O que este módulo faz e não faz ─────────────────────────────────────
 *
 * `diagnoseClaudeBinaryLayout` é PURA — recebe o conteúdo já lido de
 * `bin/` e das dependências opcionais instaladas (nunca lê o disco sozinha,
 * nunca sabe onde fica o install global de verdade) pra ser testável contra
 * fixtures, sem tocar o install global real (regra #633 do CLAUDE.md — bugfix
 * exige teste de regressão, e o "estado real" aqui é justamente algo que
 * não se deve reproduzir em CI). A leitura de disco (`which claude`,
 * `require.resolve`, `readdirSync`) vive em
 * `scripts/check-claude-binary-layout.ts`, que chama esta função com o que
 * encontrou.
 */

export type ClaudeBinaryLayoutVerdict =
  | "ok"
  | "wrong-platform-layout"
  | "missing"
  | "unknown-platform";

export interface ClaudeBinaryLayoutDiagnosis {
  verdict: ClaudeBinaryLayoutVerdict;
  /** Mensagem legível nomeando a causa real + próximo passo. */
  message: string;
  /** `node {installRoot}/install.cjs` — sempre o caminho GLOBAL resolvido,
   * nunca o caminho local relativo que a mensagem padrão do pacote imprime
   * (esse caminho local não existe quando o CLI é instalado globalmente —
   * achado da #7189: seguir a instrução padrão do erro não funcionou). */
  fixCommand: string | null;
}

interface PlatformBinaryInfo {
  /** Nome do binário nativo esperado nesta plataforma dentro de `bin/`. */
  binaryName: string;
}

/**
 * Nomes de binário esperados por plataforma — espelha o mapa `PLATFORMS` de
 * `cli-wrapper.cjs`/`install.cjs` do pacote `@anthropic-ai/claude-code`
 * (duplicado ali por design deles; duplicado aqui porque este módulo não
 * pode importar de dentro do pacote instalado globalmente, que é
 * precisamente o que pode estar com o layout errado). Só win32 usa o
 * sufixo `.exe` — todo o resto (darwin, linux, incluindo variantes
 * musl/android) usa `claude` sem extensão.
 */
const WINDOWS_PLATFORM_PREFIX = "win32-";

function expectedBinaryName(platformKey: string): PlatformBinaryInfo {
  return {
    binaryName: platformKey.startsWith(WINDOWS_PLATFORM_PREFIX) ? "claude.exe" : "claude",
  };
}

/** Sufixos de binário nativo conhecidos, pra reconhecer "layout de outra
 * plataforma presente" mesmo quando não sabemos exatamente qual. */
const KNOWN_BINARY_NAMES = ["claude", "claude.exe"];

export interface ClaudeBinaryLayoutInput {
  /** `process.platform + "-" + arch()` (+ sufixo musl/android quando
   * aplicável) — a chave de plataforma corrente, no mesmo formato usado
   * pelo `PLATFORMS` map do pacote. */
  platformKey: string;
  /** Nomes de arquivo presentes em `bin/` do install do claude-code
   * (`readdirSync` cru, sem filtrar). */
  binEntries: string[];
  /** Caminho absoluto da raiz do install (diretório que contém
   * `install.cjs`/`package.json`/`bin/`) — usado só pra montar
   * `fixCommand`; `null` quando desconhecido (diagnóstico sem fix
   * acionável). */
  installRoot: string | null;
}

/**
 * Diagnostica se `bin/` do install do claude-code carrega o binário nativo
 * da plataforma CORRENTE (`platformKey`) — puro, sem I/O.
 */
export function diagnoseClaudeBinaryLayout(
  input: ClaudeBinaryLayoutInput,
): ClaudeBinaryLayoutDiagnosis {
  const { platformKey, binEntries, installRoot } = input;
  const fixCommand = installRoot ? `node ${installRoot}/install.cjs` : null;

  if (!platformKey || platformKey.trim() === "") {
    return {
      verdict: "unknown-platform",
      message:
        "platformKey vazio/ausente — não é possível determinar qual binário nativo esta plataforma espera.",
      fixCommand: null,
    };
  }

  const { binaryName } = expectedBinaryName(platformKey);

  if (binEntries.includes(binaryName)) {
    return {
      verdict: "ok",
      message: `bin/ contém o binário nativo esperado (${binaryName}) para ${platformKey}.`,
      fixCommand: null,
    };
  }

  const foreignBinaries = binEntries.filter(
    (name) => KNOWN_BINARY_NAMES.includes(name) && name !== binaryName,
  );

  if (foreignBinaries.length > 0) {
    return {
      verdict: "wrong-platform-layout",
      message:
        `O install global do claude-code foi sobrescrito por outro layout de plataforma: ` +
        `bin/ tem ${foreignBinaries.join(", ")} (binário de outra plataforma), mas nenhum ` +
        `"${binaryName}" — o binário que ${platformKey} precisa. Isto NÃO é "postinstall não ` +
        `rodou" (a mensagem padrão do pacote sugere isso, mas é enganosa aqui) — é layout de ` +
        `plataforma errada no mesmo diretório de install, provável indício de prefixo npm global ` +
        `compartilhado/sincronizado entre máquinas de plataformas diferentes.` +
        (fixCommand
          ? ` Corrigir rodando \`${fixCommand}\` (caminho GLOBAL — o caminho local relativo que a ` +
            `mensagem padrão do erro imprime não existe em install global).`
          : ""),
      fixCommand,
    };
  }

  return {
    verdict: "missing",
    message:
      `bin/ não contém nenhum binário nativo conhecido (${binEntries.length === 0 ? "diretório vazio" : binEntries.join(", ")}) — ` +
      `parece de fato um postinstall que não rodou, não um layout de plataforma cruzada.` +
      (fixCommand ? ` Rodar \`${fixCommand}\`.` : ""),
    fixCommand,
  };
}
