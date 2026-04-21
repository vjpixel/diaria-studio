/**
 * google-auth.ts
 *
 * Módulo compartilhado de autenticação OAuth 2.0 para as APIs do Google.
 * Usa o refresh_token salvo em `data/.credentials.json` para obter um
 * access_token válido. Renova automaticamente quando próximo de expirar.
 *
 * Sem dependências externas — usa fetch nativo do Node 18+.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CREDENTIALS_PATH = resolve(ROOT, "data", ".credentials.json");
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleCredentials {
  client_id: string;
  client_secret: string;
  access_token: string;
  refresh_token: string;
  expiry_ms: number; // epoch ms quando o access_token expira
}

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

function loadCredentials(): GoogleCredentials {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new GoogleAuthError(
      `Credenciais não encontradas em ${CREDENTIALS_PATH}.\n` +
        "Execute: npx tsx scripts/oauth-setup.ts"
    );
  }
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as GoogleCredentials;
  } catch (e) {
    throw new GoogleAuthError(`Erro ao ler ${CREDENTIALS_PATH}: ${e}`);
  }
}

function saveCredentials(creds: GoogleCredentials): void {
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), "utf8");
}

async function refreshAccessToken(creds: GoogleCredentials): Promise<GoogleCredentials> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new GoogleAuthError(`Token refresh falhou (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  const updated: GoogleCredentials = {
    ...creds,
    access_token: data.access_token,
    expiry_ms: Date.now() + data.expires_in * 1000,
  };
  saveCredentials(updated);
  return updated;
}

/**
 * Retorna um access_token válido, renovando automaticamente se necessário.
 * Chame antes de cada requisição à API.
 */
export async function getAccessToken(): Promise<string> {
  let creds = loadCredentials();
  // Renova se expira nos próximos 90 segundos
  if (Date.now() > creds.expiry_ms - 90_000) {
    creds = await refreshAccessToken(creds);
  }
  return creds.access_token;
}

/**
 * Helper para requests autenticados às APIs do Google.
 * Inclui o Authorization header automaticamente.
 */
export async function gFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const token = await getAccessToken();
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
}
