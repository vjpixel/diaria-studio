/**
 * scripts/lib/diaria/drive-owner-account.ts (#13619)
 *
 * A conta DONA da pasta de vídeo (`diaria-studio-video`, diaria.editor,
 * #12578), para o que tem de nascer com o mesmo dono do resto da pasta:
 * a `{AAMMDD}/arquivo/` que o arquivamento de versões cria (#13610) e a
 * lixeira da `_superadas/` vazia que ele absorve. O OAuth do projeto
 * (`data/.credentials.json`, `scripts/google-auth.ts`) autentica como a
 * vjpixel, editora da pasta: com ele a `arquivo/` nascia com dono vjpixel e a
 * lixeira da `_superadas/` da diaria.editor voltava `403
 * insufficientFilePermissions` (decisão do editor de 19/11/2026: a
 * diaria.editor cria).
 *
 * Onde a credencial está: no `300` a diaria.editor é o remote rclone
 * `gdrive-diaria:` (o mesmo do bisync de `data/`, #12359, e do arquivamento
 * dos brutos, `archive-video-brutos.ts`, #12789), com `client_id` e
 * `client_secret` próprios. O token sai de `rclone config dump` e é renovado
 * aqui, em memória, no endpoint de token do Google com o client do próprio
 * remote; nada é gravado de volta no config do rclone, e nenhum segredo entra
 * em mensagem de erro.
 *
 * Config: `publishing.video.archive_folder_owner.rclone_remote` (ex.
 * `"gdrive-diaria:"`). Ausente = sem conta dona: o OAuth do projeto cria, como
 * antes. Falha da conta dona (rclone ausente, como no Neo; remote ausente;
 * refresh recusado; criação recusada) nunca para o arquivamento: quem chama
 * (`resolveArchiveFolder`) avisa e cria com o OAuth do projeto, que fica dono
 * da pasta (o fallback documentado).
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Folga antes do `expiry`: token que vence em menos que isso é renovado antes de usar. */
const EXPIRY_SKEW_MS = 60_000;

export interface ArchiveFolderOwnerConfig {
  /** Remote rclone da conta dona, com os dois-pontos (`gdrive-diaria:`). */
  rcloneRemote: string;
}

/**
 * Pura — `publishing.video.archive_folder_owner` do `platform.config.json`.
 * Ausente, vazio ou sem `rclone_remote` string = `null` (sem conta dona).
 */
export function archiveFolderOwnerFrom(config: unknown): ArchiveFolderOwnerConfig | null {
  const owner = (config as { publishing?: { video?: { archive_folder_owner?: { rclone_remote?: unknown } } } } | null)?.publishing?.video
    ?.archive_folder_owner;
  const remote = owner?.rclone_remote;
  if (typeof remote !== "string" || !remote.trim()) return null;
  return { rcloneRemote: remote.trim() };
}

export interface RcloneDriveCredential {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  /** epoch ms; ausente = renovar antes de usar. */
  expiryMs?: number;
}

/** Nome do remote no `config dump` (sem os dois-pontos e sem caminho). */
export function remoteKeyOf(remote: string): string {
  const key = remote.trim().replace(/:.*$/, "");
  if (!key) throw new Error(`remote rclone inválido: "${remote}"`);
  return key;
}

/**
 * Pura — a credencial do remote dentro da saída de `rclone config dump`
 * (JSON). Lança com mensagem sem segredo: remote ausente, tipo diferente de
 * `drive`, sem `client_id`/`client_secret` próprios (o client embutido do
 * rclone não pode ser renovado daqui) ou sem `refresh_token`.
 */
export function parseRcloneDriveCredential(dumpJson: string, remote: string): RcloneDriveCredential {
  const key = remoteKeyOf(remote);
  let dump: Record<string, Record<string, unknown>>;
  try {
    dump = JSON.parse(dumpJson) as Record<string, Record<string, unknown>>;
  } catch {
    throw new Error("saída de rclone config dump ilegível (config criptografado?)");
  }
  const r = dump?.[key];
  if (!r || typeof r !== "object") throw new Error(`remote ${key}: não existe no rclone desta máquina`);
  if (r.type !== "drive") throw new Error(`remote ${key}: tipo ${String(r.type)}, não drive`);
  const clientId = typeof r.client_id === "string" ? r.client_id : "";
  const clientSecret = typeof r.client_secret === "string" ? r.client_secret : "";
  if (!clientId || !clientSecret) throw new Error(`remote ${key}: sem client_id/client_secret próprios, o token não pode ser renovado fora do rclone`);
  let token: { access_token?: unknown; refresh_token?: unknown; expiry?: unknown };
  try {
    token = JSON.parse(String(r.token ?? "")) as typeof token;
  } catch {
    throw new Error(`remote ${key}: token ilegível no config do rclone`);
  }
  if (typeof token.refresh_token !== "string" || !token.refresh_token) throw new Error(`remote ${key}: sem refresh_token`);
  const expiryMs = typeof token.expiry === "string" ? Date.parse(token.expiry) : NaN;
  return {
    clientId,
    clientSecret,
    refreshToken: token.refresh_token,
    ...(typeof token.access_token === "string" && token.access_token ? { accessToken: token.access_token } : {}),
    ...(Number.isFinite(expiryMs) ? { expiryMs } : {}),
  };
}

/** Pura — o access token ainda serve (com folga de 1 min antes do `expiry`). */
export function accessTokenUsable(cred: Pick<RcloneDriveCredential, "accessToken" | "expiryMs">, nowMs: number): boolean {
  return Boolean(cred.accessToken) && typeof cred.expiryMs === "number" && cred.expiryMs - EXPIRY_SKEW_MS > nowMs;
}

/** O binário do rclone: `RCLONE_BIN`, senão `~/.local/bin/rclone` (o do 300, como o `archive-video-brutos`), senão o do PATH. */
export function rcloneBin(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RCLONE_BIN) return env.RCLONE_BIN;
  const local = join(homedir(), ".local", "bin", "rclone");
  return existsSync(local) ? local : "rclone";
}

function rcloneConfigDump(bin: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile(bin, ["config", "dump"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // Só o código: o stderr do rclone pode ecoar trecho do config.
      if (err) rej(new Error(`rclone config dump falhou (${(err as NodeJS.ErrnoException).code ?? "erro"})`));
      else res(stdout);
    });
  });
}

export interface OwnerFetchDeps {
  /** Saída de `rclone config dump` (default: roda o rclone). */
  dumpConfig?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Um `fetch` autenticado como a conta do remote rclone. Preguiçoso: nada roda
 * até a 1ª chamada (o comando que nunca cria `arquivo/` não chama o rclone).
 * Token vencido é renovado antes; 401 renova e repete 1x. Sem retry de
 * transiente: o POST que cria a pasta não é idempotente (repetir pode criar
 * duas), e quem chama já relê antes de recorrer ao OAuth do projeto.
 */
export function makeRcloneOwnerFetch(remote: string, deps: OwnerFetchDeps = {}): (url: string, init?: RequestInit) => Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const dump = deps.dumpConfig ?? (() => rcloneConfigDump(rcloneBin()));
  let cred: Promise<RcloneDriveCredential> | null = null;
  const load = () => (cred ??= dump().then((out) => parseRcloneDriveCredential(out, remote)).catch((e) => {
    cred = null; // a próxima chamada tenta de novo
    throw e;
  }));
  const refresh = async (c: RcloneDriveCredential, signal?: AbortSignal | null): Promise<string> => {
    const res = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken, grant_type: "refresh_token" }).toString(),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) throw new Error(`renovação do token de ${remoteKeyOf(remote)} recusada (${res.status}${body.error ? ` ${body.error}` : ""})`);
    c.accessToken = body.access_token;
    c.expiryMs = now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000;
    return c.accessToken;
  };
  const authed = (url: string, init: RequestInit, token: string) =>
    doFetch(url, { ...init, headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), Authorization: `Bearer ${token}` } });
  return async (url, init = {}) => {
    const c = await load();
    const token = accessTokenUsable(c, now()) ? c.accessToken! : await refresh(c, init.signal);
    const res = await authed(url, init, token);
    if (res.status !== 401) return res;
    await res.arrayBuffer().catch(() => undefined);
    return authed(url, init, await refresh(c, init.signal));
  };
}

/**
 * O `ownerFetch` dos `MontageDriveDeps` a partir do `platform.config.json`:
 * `undefined` sem `archive_folder_owner` (ou com o config ilegível, que o
 * resto do comando já reporta).
 */
export function ownerFetchFromConfigFile(configPath: string, deps: OwnerFetchDeps = {}): ((url: string, init?: RequestInit) => Promise<Response>) | undefined {
  let owner: ArchiveFolderOwnerConfig | null = null;
  try {
    owner = archiveFolderOwnerFrom(JSON.parse(readFileSync(configPath, "utf8")));
  } catch {
    return undefined;
  }
  return owner ? makeRcloneOwnerFetch(owner.rcloneRemote, deps) : undefined;
}
