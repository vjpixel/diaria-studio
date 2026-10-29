/**
 * video-env-check.ts (#11223) — o que esta máquina precisa para rodar o
 * `/diaria-publica-video` inteiro, capa incluída, sem o Neo.
 *
 * Contexto: o editor viaja e o Neo fica ligado poucas horas por dia. A capa
 * horizontal era o único passo que só saía no Neo (rembg em `.venv-rembg/`,
 * Codex CLI pela assinatura ChatGPT, Georgia instalada, guard #4090). Este
 * módulo é a parte pura do diagnóstico: recebe o resultado das sondas e diz,
 * por item, o que falta e qual passo da skill fica bloqueado. A sonda real
 * (spawn, fonte) vive em `scripts/check-video-env.ts`.
 *
 * Nunca instala nada: só diz o comando de setup documentado em
 * `docs/setup.md` (rembg) e `docs/codex-image-setup.md` (Codex).
 */

export type VideoEnvItemId = "ffmpeg" | "codex" | "georgia" | "rembg";

/** Resultado bruto de uma sonda. `detail` vai para o relatório (versão, erro). */
export interface ProbeResult {
  ok: boolean;
  detail?: string;
}

export type VideoEnvProbes = Record<VideoEnvItemId, ProbeResult>;

export interface VideoEnvItem {
  id: VideoEnvItemId;
  ok: boolean;
  /** Passo da skill que fica bloqueado quando o item falta. */
  blocks: string;
  /** O que fazer para resolver (comando/doc). Só quando `ok` é false. */
  fix: string | null;
  detail: string | null;
}

export interface VideoEnvReport {
  platform: string;
  items: VideoEnvItem[];
  /** `true` só quando todos os itens estão ok: a capa sai nesta máquina. */
  coverReady: boolean;
  missing: VideoEnvItemId[];
}

/** Caminho do Python do venv do rembg (mesmo layout de `scripts/setup-rembg.py`). */
export function rembgVenvPython(platform: NodeJS.Platform | string): string {
  return platform === "win32" ? ".venv-rembg/Scripts/python.exe" : ".venv-rembg/bin/python";
}

/** Comando de setup do rembg por plataforma (o mesmo de `docs/setup.md`). */
export function rembgSetupCommand(platform: NodeJS.Platform | string): string {
  return platform === "win32"
    ? "py -3.11 scripts/setup-rembg.py"
    : "uv python install 3.11.9 && $(uv python find 3.11.9) scripts/setup-rembg.py";
}

/**
 * #11532: caminhos de instalação do Codex CLI fora do PATH de uma shell não
 * interativa (no 300, `~/.npm-global/bin/codex`: `ssh 300 'codex'` não acha,
 * a shell interativa acha). Só Unix. Mesma lista de `codexFallbackPaths` em
 * `scripts/codex-image.js`, que usa o primeiro que existir quando `codex` não
 * resolve no PATH (paridade em `test/codex-path-fallback-11532.test.ts`).
 */
export function codexCandidatePaths(platform: NodeJS.Platform | string, home: string): string[] {
  if (platform === "win32" || !home) return [];
  const base = home.replace(/\/+$/, "");
  return [`${base}/.npm-global/bin/codex`, `${base}/.local/bin/codex`];
}

/**
 * #11532 item 3: o que o `--dry-run` do `publish-youtube.ts` lista como
 * pré-requisito da capa horizontal: cada item com o passo que ele bloqueia e,
 * quando falta, como resolver. Puro, sobre o relatório de `assessVideoEnv`.
 */
export function coverPrerequisites(report: VideoEnvReport): {
  ready: boolean;
  items: { id: VideoEnvItemId; ok: boolean; blocks: string; fix: string | null; detail: string | null }[];
  summary: string;
} {
  return {
    ready: report.coverReady,
    items: report.items.map((i) => ({ id: i.id, ok: i.ok, blocks: i.blocks, fix: i.fix, detail: i.detail })),
    summary: report.coverReady
      ? "pré-requisitos da capa (ffmpeg, codex, georgia, rembg) ok nesta máquina"
      : `capa horizontal não sai nesta máquina (falta: ${report.missing.join(", ")}); o upload segue com a thumb automática do YouTube`,
  };
}

const ORDER: VideoEnvItemId[] = ["ffmpeg", "codex", "georgia", "rembg"];

function describe(id: VideoEnvItemId, platform: string): { blocks: string; fix: string } {
  switch (id) {
    case "ffmpeg":
      return {
        blocks: "frames do bruto (Passo A2.2) e duração/frame do vertical",
        fix: platform === "win32" ? "instalar o ffmpeg e pôr no PATH" : "sudo apt install ffmpeg",
      };
    case "codex":
      return {
        blocks: "fundo da capa por outpaint (Passo A2.4)",
        fix:
          "instalar o Codex CLI e `codex login` com a conta ChatGPT, nunca API key (docs/codex-image-setup.md); " +
          "se já está instalado mas fora do PATH, ponha o diretório dele no PATH (no 300: ~/.npm-global/bin, #11532)",
      };
    case "georgia":
      return {
        blocks: "composição da capa (Passo A2.5, guard #4090)",
        fix: platform === "win32"
          ? "Georgia vem com o Windows: conferir a instalação da fonte"
          : "copiar georgia*.ttf do Neo (C:\\Windows\\Fonts) para ~/.local/share/fonts/ e rodar fc-cache -f (a fonte não é redistribuível, nunca versionar no repo)",
      };
    case "rembg":
      return {
        blocks: "recorte do retrato (Passo A2.3)",
        fix: `${rembgSetupCommand(platform)} (docs/setup.md, seção rembg)`,
      };
  }
}

/** Puro: monta o relatório a partir das sondas. */
export function assessVideoEnv(probes: VideoEnvProbes, platform: NodeJS.Platform | string): VideoEnvReport {
  const items = ORDER.map((id): VideoEnvItem => {
    const probe = probes[id];
    const { blocks, fix } = describe(id, platform);
    return { id, ok: probe.ok, blocks, fix: probe.ok ? null : fix, detail: probe.detail ?? null };
  });
  const missing = items.filter((i) => !i.ok).map((i) => i.id);
  return { platform, items, coverReady: missing.length === 0, missing };
}

/** Puro: relatório legível para o terminal. */
export function formatVideoEnvReport(report: VideoEnvReport): string {
  const lines = [`Ambiente do vídeo do dia (${report.platform}):`];
  for (const i of report.items) {
    const detail = i.detail ? ` (${i.detail})` : "";
    lines.push(i.ok ? `  [ok] ${i.id}${detail}` : `  [falta] ${i.id}${detail}: bloqueia ${i.blocks}. Resolver: ${i.fix}`);
  }
  lines.push(
    report.coverReady
      ? "A capa horizontal sai nesta máquina."
      : `A capa horizontal NÃO sai nesta máquina (falta: ${report.missing.join(", ")}). O resto do /diaria-publica-video segue.`,
  );
  return lines.join("\n");
}
