/**
 * video-montage-env.ts (#11642) — o que uma máquina precisa para rodar o
 * `/diaria-video-montagem`, e de onde vem o Python. Puro: as sondas (spawn,
 * statfs, Drive) vivem em `scripts/check-video-env.ts --montagem`.
 *
 * Contexto: a skill nasceu só no Neo (bruto em `G:`, faster-whisper no Python
 * do usuário). No 300 (29/10/2026) `python` resolvia para o venv do Hermes, que
 * tinha faster-whisper por acaso, e o cache do Hugging Face não tinha o
 * `large-v3-turbo` (o script roda com `HF_HUB_OFFLINE=1`, então a transcrição
 * falharia). Daqui o venv próprio `~/.venv-video-montagem` e o check.
 */

export type MontageEnvItemId = "ffmpeg" | "python" | "model" | "drive" | "disk";

export interface MontageProbe {
  ok: boolean;
  detail?: string;
}

export type MontageEnvProbes = Record<MontageEnvItemId, MontageProbe>;

export interface MontageEnvItem {
  id: MontageEnvItemId;
  ok: boolean;
  fix: string | null;
  detail: string | null;
}

export interface MontageEnvReport {
  platform: string;
  python: string;
  items: MontageEnvItem[];
  ready: boolean;
  missing: MontageEnvItemId[];
}

/** O modelo da transcrição (o mesmo default de `scripts/video/transcribe_words.py`). */
export const WHISPER_MODEL = "large-v3-turbo";

/** Python do venv próprio da montagem, por plataforma. */
export function montageVenvPython(platform: NodeJS.Platform | string, home: string): string {
  const base = home.replace(/[\\/]+$/, "");
  return platform === "win32" ? `${base}/.venv-video-montagem/Scripts/python.exe` : `${base}/.venv-video-montagem/bin/python`;
}

/**
 * De onde vem o Python (#11642), na ordem: `--python`, `DIARIA_VIDEO_PYTHON`,
 * o venv `~/.venv-video-montagem` quando existe, e por fim `python` do PATH (o
 * Neo, que usa o Python do usuário).
 */
export function resolveVideoPython(opts: {
  flag?: string;
  env?: string;
  platform: NodeJS.Platform | string;
  home: string;
  exists: (p: string) => boolean;
}): { python: string; from: "flag" | "env" | "venv" | "path" } {
  if (opts.flag) return { python: opts.flag, from: "flag" };
  if (opts.env) return { python: opts.env, from: "env" };
  const venv = montageVenvPython(opts.platform, opts.home);
  if (opts.home && opts.exists(venv)) return { python: venv, from: "venv" };
  return { python: "python", from: "path" };
}

/** Espaço livre exigido para o bruto: 3x o tamanho (bruto + áudio + clipes da prévia), piso de 25 GB sem tamanho conhecido. */
export function requiredFreeBytes(brutoBytes: number | null): number {
  return brutoBytes && brutoBytes > 0 ? 3 * brutoBytes : 25e9;
}

/** Comando de setup do venv (o mesmo de `docs/setup.md`, seção do vídeo). */
export function montageSetupCommand(platform: NodeJS.Platform | string): string {
  return platform === "win32"
    ? "uv venv --python 3.12 %USERPROFILE%\\.venv-video-montagem && set VIRTUAL_ENV=%USERPROFILE%\\.venv-video-montagem && uv pip install -r scripts/video/montagem-requirements.txt"
    : "uv venv --python 3.12 ~/.venv-video-montagem && VIRTUAL_ENV=~/.venv-video-montagem uv pip install -r scripts/video/montagem-requirements.txt";
}

const ORDER: MontageEnvItemId[] = ["ffmpeg", "python", "model", "drive", "disk"];

function fixFor(id: MontageEnvItemId, platform: string, python: string): string {
  switch (id) {
    case "ffmpeg":
      return platform === "win32" ? "instalar o ffmpeg e pôr no PATH" : "sudo apt install ffmpeg";
    case "python":
      return `${montageSetupCommand(platform)} (docs/setup.md, seção "Vídeo: montagem")`;
    case "model":
      return `baixar o modelo uma vez, com rede: ${python} -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='int8')"`;
    case "drive":
      return "Drive for desktop montado (G:) ou OAuth do projeto válido (data/.credentials.json; renovar com scripts/oauth-setup.ts)";
    case "disk":
      return "liberar espaço no disco do cache (~/.cache/diaria-video-montagem; DIARIA_VIDEO_CACHE_DIR aponta para outro disco)";
  }
}

/** Puro: relatório a partir das sondas. */
export function assessMontageEnv(probes: MontageEnvProbes, platform: NodeJS.Platform | string, python: string): MontageEnvReport {
  const items = ORDER.map((id): MontageEnvItem => ({
    id,
    ok: probes[id].ok,
    fix: probes[id].ok ? null : fixFor(id, platform, python),
    detail: probes[id].detail ?? null,
  }));
  const missing = items.filter((i) => !i.ok).map((i) => i.id);
  return { platform, python, items, ready: missing.length === 0, missing };
}

export function formatMontageEnvReport(r: MontageEnvReport): string {
  const lines = [`Ambiente da montagem do vídeo (${r.platform}, python: ${r.python}):`];
  for (const i of r.items) {
    const d = i.detail ? ` (${i.detail})` : "";
    lines.push(i.ok ? `  [ok] ${i.id}${d}` : `  [falta] ${i.id}${d}. Resolver: ${i.fix}`);
  }
  lines.push(r.ready ? "A montagem roda nesta máquina." : `A montagem NÃO roda nesta máquina (falta: ${r.missing.join(", ")}).`);
  return lines.join("\n");
}
