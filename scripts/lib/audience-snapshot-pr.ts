/**
 * scripts/lib/audience-snapshot-pr.ts (#11733 item 2)
 *
 * Quem commita o snapshot de audiência. O Stage 0 (passo 0i,
 * `scripts/update-audience.ts`) regrava `context/audience-profile.md` e cria
 * `docs/audience-history/AAAA-MM-DD.md` no checkout onde a edição roda, e
 * ninguém commitava: os arquivos ficavam dias parados como modificado/untracked
 * até alguém abrir um `chore: snapshot de audiência` à mão (evidência da issue,
 * 22 a 29/10/2026 no Neo).
 *
 * Dono a partir daqui: o próprio Stage 0, logo depois do 0i, via
 * `scripts/commit-audience-snapshot.ts`. O commit sai numa PR aberta de um
 * worktree temporário (mesmo isolamento de `publish-edition-site-page.ts`,
 * #8636, e `hubs-weekly-regen.ts`, #8906): o checkout compartilhado nunca
 * recebe checkout, add nem commit. Uma PR por vez ("rolante"): se já há PR
 * aberta de snapshot, o run seguinte empilha um commit nela em vez de abrir
 * outra, então nunca acumula mais de uma.
 *
 * O script NUNCA mergeia (mesma decisão do #6598 para a PR da página do
 * site): merge segue o fluxo normal (CI verde → coordenador/sessão). Depois
 * do merge, o `sync-code.ts` do início da próxima edição descarta as cópias
 * locais idênticas a origin/master (#11562, `discardCollisionsIdenticalToUpstream`)
 * e o checkout volta a ficar limpo sozinho.
 *
 * Este módulo é a parte pura (seleção de caminhos, escolha da PR, textos).
 */

/** Prefixo da branch das PRs de snapshot. */
export const AUDIENCE_SNAPSHOT_BRANCH_PREFIX = "chore/audience-snapshot-";

/** Os dois caminhos que o 0i escreve (pathspec do `git status`). */
export const AUDIENCE_SNAPSHOT_PATHSPEC = ["context/audience-profile.md", "docs/audience-history"] as const;

/**
 * Arquivo gerado pelo 0i (profile ou um snapshot diário/consolidado do
 * histórico). Mesmo critério de `isRoutineAudienceSnapshot` em
 * `scripts/session-close-check.ts` (#11737), que não importa daqui para não
 * colidir com a PR #11821 em voo no mesmo arquivo.
 */
export function isAudienceSnapshotPath(path: string): boolean {
  return path === "context/audience-profile.md" || /^docs\/audience-history\/[^/]+\.md$/.test(path);
}

export interface SnapshotStatusEntry {
  code: string;
  path: string;
}

/**
 * Caminhos a levar para a PR a partir de `git status --porcelain=v1
 * --untracked-files=all`. Entra modificado, untracked, adicionado e removido
 * (o `prune-audience-history.ts` remove snapshots antigos). Fica de fora:
 * caminho com aspas (nome com caractere especial, nunca gerado pelo 0i),
 * conflito (`U`/`AA`/`DD`) e qualquer coisa fora dos caminhos do 0i.
 * Renomeação usa o destino. Resultado ordenado e sem repetição.
 */
export function selectSnapshotPaths(porcelain: string): SnapshotStatusEntry[] {
  const out = new Map<string, SnapshotStatusEntry>();
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    if (code.includes("U") || code === "AA" || code === "DD" || code === "!!") continue;
    const rest = line.slice(3);
    const arrow = rest.indexOf(" -> ");
    const path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    if (path.startsWith("\"") || !isAudienceSnapshotPath(path)) continue;
    out.set(path, { code, path });
  }
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export interface OpenPrRef {
  number: number;
  headRefName: string;
  url?: string;
}

/**
 * A PR de snapshot aberta a reaproveitar: a de menor número entre as abertas
 * com branch no prefixo (deveria haver no máximo uma; se houver mais, a mais
 * antiga recebe o commit e as outras ficam visíveis para quem for mergear).
 */
export function pickOpenSnapshotPr(prs: OpenPrRef[]): OpenPrRef | undefined {
  return prs
    .filter((p) => typeof p.headRefName === "string" && p.headRefName.startsWith(AUDIENCE_SNAPSHOT_BRANCH_PREFIX))
    .sort((a, b) => a.number - b.number)[0];
}

/** Branch nova (só quando não há PR aberta): `chore/audience-snapshot-AAAAMMDD-HHMMSS` em UTC. */
export function newSnapshotBranchName(now: Date): string {
  const iso = now.toISOString(); // 2026-11-02T03:04:05.000Z
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
  return `${AUDIENCE_SNAPSHOT_BRANCH_PREFIX}${stamp}`;
}

/** Datas `AAAA-MM-DD` dos snapshots diários entre os caminhos, ordenadas. */
export function snapshotDates(paths: string[]): string[] {
  const dates = new Set<string>();
  for (const p of paths) {
    const m = /^docs\/audience-history\/(\d{4}-\d{2}-\d{2})\.md$/.exec(p);
    if (m) dates.add(m[1]);
  }
  return [...dates].sort();
}

/**
 * Título da PR/mensagem do commit, no padrão dos commits manuais (`chore:
 * snapshot de audiência ...`). Título e corpo não citam a issue de origem por
 * número: cada PR diária viraria uma referência cruzada na issue.
 */
export function buildSnapshotCommitTitle(paths: string[]): string {
  const dates = snapshotDates(paths);
  const span = dates.length === 0 ? "profile" : dates.length === 1 ? dates[0] : `${dates[0]} a ${dates[dates.length - 1]}`;
  return `chore: snapshot de audiência ${span}`;
}

export function buildSnapshotPrBody(entries: SnapshotStatusEntry[]): string {
  const lines = entries.map((e) => `- \`${e.code.trim() || "M"}\` ${e.path}`);
  return [
    "Snapshot de audiência gerado pelo Stage 0 (passo 0i, `scripts/update-audience.ts`) e commitado por `scripts/commit-audience-snapshot.ts` a partir de um worktree temporário.",
    "",
    "Arquivos:",
    ...lines,
    "",
    "PR rolante: enquanto esta estiver aberta, os próximos Stage 0 empilham commits aqui em vez de abrir outra. O script não mergeia; depois do merge, o `sync-code.ts` da próxima edição descarta as cópias locais idênticas a origin/master.",
    "",
    "no-regression-test: dado gerado (snapshot de audiência), sem código executável",
    // #11971: a PR rolante empilha ~165 linhas por Stage 0 e passa do limiar
    // de 500 adições do gate #7115 em ~3 edições; sem esta linha o check fica
    // vermelho a cada commit novo. O gate relê o corpo pela API (#7140), e o
    // corpo só é escrito na criação, então a linha precisa nascer com ela.
    "removal-declaration: dado gerado (snapshot de audiência), nada a remover",
  ].join("\n");
}
