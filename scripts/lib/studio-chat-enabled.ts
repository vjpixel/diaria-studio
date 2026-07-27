/**
 * studio-chat-enabled.ts (#4078)
 *
 * Toggle explícito "chat ativo/desativado" do painel do Studio — mitigação
 * do incidente 260726/27: uma sessão `/diaria-develop` reiniciou o
 * `Diaria-Studio-Server` sem checar se o editor tinha uma conversa em
 * andamento no chat drawer. O restart invalidou o gate/`toolUseId` em uso
 * pelo painel (o editor recebeu "conexão perdida" + "nenhum gate pendente
 * com toolUseId X") e a edição que ele estava digitando naquele momento se
 * perdeu.
 *
 * A regra que existia até aqui (`studio-ui-pause-during-active-use`, memória
 * do coordenador) era heurística — dependia do coordenador LEMBRAR de
 * perguntar. Este módulo dá um sinal EXPLÍCITO e legível por máquina:
 *   - o editor desativa o chat no painel quando não está usando (`enabled:
 *     false`) — sinalização de "pode reiniciar sem risco";
 *   - reativa quando quiser voltar a usar (`enabled: true`, também o
 *     default de uma instalação que nunca tocou o toggle — comportamento
 *     idêntico ao de antes desta issue, sem migração exigida);
 *   - qualquer sessão de automação (overnight/develop, ou um operador
 *     manual) pode checar esse estado ANTES de reiniciar/religar o Studio,
 *     via `isChatEnabled()`/`readChatEnabledState()` (import direto, sem
 *     precisar do server rodando) OU via CLI:
 *
 *       npx tsx scripts/lib/studio-chat-enabled.ts
 *       # → imprime "enabled" ou "disabled" em stdout (exit 0 sempre,
 *       #   mesmo padrão fail-soft de scripts/lib/exec-mode.ts)
 *
 *   `enabled: true` (chat ativo — o editor pode estar no meio de algo) NÃO
 *   deve ser lido como "pode reiniciar"; é `enabled: false` (o editor
 *   desativou explicitamente) que é o sinal positivo de segurança. Este
 *   módulo só EXPÕE o sinal — decidir o que fazer com ele (pular o restart,
 *   perguntar antes, etc.) é responsabilidade do caller (fora de escopo do
 *   #4078, que pede o sinal, não a integração ponta-a-ponta com as skills
 *   overnight/develop).
 *
 * Estado persistido em `data/studio-chat-enabled.json` — arquivo NOVO e
 * dedicado, nunca reaproveita/sobrescreve nenhum estado já existente sob
 * `data/`. Fail-soft total (arquivo ausente, JSON corrompido, shape
 * inesperado) -> `{enabled: true, updatedAt: null}` (o default seguro: uma
 * instalação existente que nunca tocou o toggle continua com o chat
 * funcionando exatamente como antes desta issue) — nunca lança.
 *
 * Consumido por `GET/PUT /api/chat/enabled` (`scripts/studio-ui/server.ts`)
 * e por `handleApiChat` (mesmo server — recusa `POST /api/chat` com 409
 * quando desativado, pra uma aba antiga já aberta não conseguir burlar o
 * toggle enviando uma mensagem mesmo com o chat marcado como desligado).
 *
 * @see CLAUDE.md § "Studio: toggle de chat ativo/desativado" — como checar
 * @see docs/studio-ui-ux-guidelines.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainModule } from "./cli-args.ts";

export interface ChatEnabledState {
  /** `true` = chat ativo (default) — `false` = o editor desativou
   * explicitamente (sinal de "seguro reiniciar o Studio"). */
  enabled: boolean;
  /** ISO — quando o estado foi alterado pela última vez via `setChatEnabled`.
   * `null` = nunca escrito (arquivo ausente, estado no default). */
  updatedAt: string | null;
}

const DEFAULT_STATE: ChatEnabledState = { enabled: true, updatedAt: null };

function statePath(rootDir: string): string {
  return resolve(rootDir, "data", "studio-chat-enabled.json");
}

/** Lê o estado do toggle. Fail-soft total (arquivo ausente, JSON corrompido,
 * `enabled` de tipo errado) -> `{enabled: true, updatedAt: null}` — nunca
 * lança, nunca bloqueia o chat de uma instalação que ainda não tocou o
 * toggle. */
export function readChatEnabledState(rootDir: string): ChatEnabledState {
  const p = statePath(rootDir);
  if (!existsSync(p)) return { ...DEFAULT_STATE };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<ChatEnabledState>;
    if (typeof raw.enabled !== "boolean") return { ...DEFAULT_STATE };
    return {
      enabled: raw.enabled,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Atalho booleano de `readChatEnabledState` — usado tanto pelo server
 * (`handleApiChat`, guard de `POST /api/chat`) quanto por automação externa
 * que só quer a resposta binária sem desestruturar o objeto inteiro. */
export function isChatEnabled(rootDir: string): boolean {
  return readChatEnabledState(rootDir).enabled;
}

/** Escreve o novo estado do toggle (#4078) — único ponto de escrita deste
 * módulo, chamado por `PUT /api/chat/enabled` (server.ts). Cria `data/` se
 * por algum motivo ainda não existir (defensivo — a junction OneDrive já
 * deveria garantir isso, ver CLAUDE.md § Setup). Propaga qualquer erro de
 * escrita real (disco cheio, permissão) pro caller decidir o status HTTP;
 * não é fail-soft como a leitura, porque aqui uma falha silenciosa deixaria
 * o editor achando que desativou o chat quando na verdade não desativou. */
export function setChatEnabled(
  rootDir: string,
  enabled: boolean,
  opts: { now?: () => Date } = {},
): ChatEnabledState {
  const now = opts.now ?? (() => new Date());
  const p = statePath(rootDir);
  mkdirSync(dirname(p), { recursive: true });
  const state: ChatEnabledState = { enabled, updatedAt: now().toISOString() };
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

// CLI guard: só executa como main module, importável sem efeito colateral
// (mesmo padrão de scripts/lib/exec-mode.ts).
if (isMainModule(import.meta.url)) {
  console.log(isChatEnabled(process.cwd()) ? "enabled" : "disabled");
}
