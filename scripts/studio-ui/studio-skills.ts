/**
 * studio-skills.ts (#4270, fatia da EPIC "Studio UI" #3554)
 *
 * Camada de leitura da página `/skills` — o inventário de comandos que
 * responde "quais skills existem, o que cada uma faz, e que argumentos
 * aceita" sem precisar abrir arquivos no terminal ou lembrar de cabeça.
 * Arquivo próprio desta fatia (mesma convenção de `studio-integrations.ts`
 * (#3848) e `studio-utms.ts` (#4041)) — `server.ts` só roteia.
 *
 * **Catálogo gerado do filesystem, nunca hardcoded** — o problema que a
 * issue #4270 resolve é exatamente a duplicação estática que já defasa hoje
 * na seção "Como usar" do CLAUDE.md (`/diaria-semanal`, `/diaria-mes-erros`,
 * `/diaria-remover-votos-pixel` existem e não aparecem lá). `listSkillsFromDir`
 * lê `.claude/skills/{id}/SKILL.md` toda vez que a página é aberta — sem cache,
 * sem lista paralela pra manter sincronizada. O ÚNICO ponto "curado" é
 * `deriveSkillGroup` (agrupamento visual), e mesmo esse é uma função PURA de
 * `id` com fallback default — uma skill nova sem nome convencional cai em
 * "Auxiliares / debug" automaticamente, nunca fica invisível (ver docstring
 * da função).
 *
 * **Escopo: só skills VERSIONADAS no repo** (decisão explícita da issue,
 * opção "mais simples" das duas listadas). `humanizador`
 * (`~/.claude/skills/humanizador`, CLAUDE.md setup 3a) é instalada
 * GLOBALMENTE por fora do checkout — listar exigiria ler fora de `rootDir` e
 * marcar origem visualmente; a página de hoje documenta essa omissão em texto
 * estático (`public/skills.html`), não tenta resolver o HOME do usuário.
 *
 * **Diretórios stale/vazios são ignorados em silêncio.** A máquina do editor
 * tem dirs sem `SKILL.md` (`diaria-4-publicar`, `diaria-sorteio` — vazios,
 * invisíveis pro git). O parser exige `SKILL.md` legível; sem ele, o
 * diretório é pulado sem virar erro — a página não deve anunciar um comando
 * que não existe.
 *
 * **Fora de escopo (issue #4270, seção "Fora de escopo"):** disparar skill
 * pelo painel. Só leitura — o botão "copiar comando" (client-side,
 * `skills.js`) é o único affordance de ação.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectExecMode, type ExecMode } from "../lib/exec-mode.ts";

// ---------------------------------------------------------------------------
// Frontmatter YAML mínimo (só o que os SKILL.md deste repo usam: pares
// `chave: valor` de uma linha — nunca listas/objetos aninhados). Um parser
// dedicado evita puxar uma dependência de YAML só pra isto.
// ---------------------------------------------------------------------------

export interface ParsedFrontmatter {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Separa o bloco `---\n...\n---` do corpo. Fail-soft: sem abertura/fechamento
 * reconhecível, devolve `frontmatter: {}` e o arquivo INTEIRO como `body` —
 * nunca lança. @pure
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (!raw.startsWith("---")) return { frontmatter: {}, body: raw };
  const closeIdx = raw.indexOf("\n---", 3);
  if (closeIdx === -1) return { frontmatter: {}, body: raw };

  const fmBlock = raw.slice(3, closeIdx);
  const body = raw.slice(closeIdx + 4).replace(/^(\r?\n)+/, "");

  const frontmatter: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of fmBlock.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/.exec(line);
    if (m) {
      currentKey = m[1];
      frontmatter[currentKey] = m[2].trim();
    } else if (currentKey) {
      // Continuação de linha (não visto hoje nos SKILL.md reais, mas
      // defensivo — melhor concatenar do que perder o conteúdo em silêncio).
      frontmatter[currentKey] = `${frontmatter[currentKey]} ${line.trim()}`.trim();
    }
  }
  return { frontmatter, body };
}

/**
 * Extrai o heading `# /skill-name [args]` do corpo — primeira linha H1
 * (`# `, nunca `## `). Devolve o texto cru após `# `, ex:
 * `"/diaria-log [edition] [level]"`. `null` se não houver H1. @pure
 */
export function extractUsageHeading(body: string): string | null {
  const m = /^#[ \t]+(.+?)[ \t]*$/m.exec(body);
  return m ? m[1].trim() : null;
}

/**
 * Extrai o conteúdo bruto (markdown, sem re-renderizar) da seção
 * `## Argumentos`, até o próximo heading H1/H2 ou o fim do arquivo. `null`
 * quando a seção não existe (nem toda skill declara argumentos — ex:
 * `diaria-refresh-dedup`, `diaria-atualiza-audiencia`). @pure
 */
export function extractArgumentsSection(body: string): string | null {
  const headingMatch = /^##[ \t]+Argumentos[ \t]*$/m.exec(body);
  if (!headingMatch) return null;
  const rest = body.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = /^#{1,2}[ \t]+/m.exec(rest);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  const trimmed = section.trim();
  return trimmed || null;
}

/**
 * Deriva o nome invocável (`/diaria-log`) a partir do heading — primeiro
 * token, se o heading começa com `/`. Cai pro id do diretório
 * (`/{id}`) quando o heading está ausente ou não segue a convenção (nunca
 * fica sem invocável exibível). @pure
 */
export function deriveInvocable(usageHeading: string | null, id: string): string {
  if (usageHeading && usageHeading.startsWith("/")) {
    const token = usageHeading.split(/\s/)[0];
    if (token && token.length > 1) return token;
  }
  return `/${id}`;
}

export interface SkillFlags {
  /** Presente só quando o frontmatter declara `model:` (ex: `sonnet`). */
  model?: string;
  /** Presente só quando o frontmatter declara `effort:` (ex: `high`). */
  effort?: string;
  /** Presente só quando o frontmatter declara `disable-model-invocation:`. */
  disableModelInvocation?: boolean;
}

/** Só os 3 flags que hoje aparecem em algum SKILL.md do repo (ver
 * `overnight-dispatch-rules.md`/#4270). Campos ausentes no frontmatter ficam
 * `undefined` — a UI não mostra badge pra flag que a skill não declarou. @pure */
export function parseSkillFlags(frontmatter: Record<string, string>): SkillFlags {
  const flags: SkillFlags = {};
  if (frontmatter.model) flags.model = frontmatter.model;
  if (frontmatter.effort) flags.effort = frontmatter.effort;
  if (frontmatter["disable-model-invocation"] !== undefined) {
    flags.disableModelInvocation = frontmatter["disable-model-invocation"].toLowerCase() === "true";
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Agrupamento visual (#4270 "Agrupamento sugerido na página")
// ---------------------------------------------------------------------------

export const SKILL_GROUP_ORDER = [
  "pipeline-diaria",
  "mensal-semanal",
  "dev-sessions",
  "auxiliares",
] as const;
export type SkillGroupId = (typeof SKILL_GROUP_ORDER)[number];

export const SKILL_GROUP_LABELS: Record<SkillGroupId, string> = {
  "pipeline-diaria": "Pipeline diária",
  "mensal-semanal": "Mensal / Semanal",
  "dev-sessions": "Sessões de dev",
  auxiliares: "Auxiliares / debug",
};

/**
 * Agrupamento por CONVENÇÃO DE NOME do diretório — deliberadamente não é uma
 * lista `id -> grupo` mantida à mão (isso reintroduziria a mesma defasagem
 * que a issue resolve pro resto da página). Uma skill nova sem prefixo
 * reconhecido cai no fallback `auxiliares`, nunca fica de fora do
 * agrupamento. @pure
 */
export function deriveSkillGroup(id: string): SkillGroupId {
  if (id === "diaria-edicao" || /^diaria-[1-6]-/.test(id)) return "pipeline-diaria";
  if (id.includes("mensal") || id.includes("semanal")) return "mensal-semanal";
  if (id.includes("overnight") || id.includes("develop")) return "dev-sessions";
  return "auxiliares";
}

// ---------------------------------------------------------------------------
// Skill (1 SKILL.md parseado)
// ---------------------------------------------------------------------------

export interface SkillEntry {
  /** Nome do diretório em `.claude/skills/` — id estável. */
  id: string;
  /** Nome invocável, ex `/diaria-log`. */
  invocable: string;
  /** `description` do frontmatter. String vazia quando ausente (fixture
   * "frontmatter faltando description", #4270) — a UI mostra um aviso
   * inline em vez de esconder a skill. */
  description: string;
  /** Heading H1 cru do corpo (`/diaria-log [edition] [level]`). `null` se o
   * arquivo não tiver H1 (SKILL.md malformado — raro, mas não é motivo pra
   * sumir da lista). */
  usageHeading: string | null;
  /** Conteúdo cru da seção `## Argumentos`, quando existir. */
  argumentsMarkdown: string | null;
  flags: SkillFlags;
  group: SkillGroupId;
  /** Path relativo ao root do repo, pra exibir a origem (`.claude/skills/…/SKILL.md`). */
  sourcePath: string;
}

/** Monta uma `SkillEntry` a partir do conteúdo cru de um `SKILL.md`. @pure */
export function parseSkillMarkdown(id: string, raw: string, sourcePath: string): SkillEntry {
  const { frontmatter, body } = parseFrontmatter(raw);
  const usageHeading = extractUsageHeading(body);
  return {
    id,
    invocable: deriveInvocable(usageHeading, id),
    description: frontmatter.description ?? "",
    usageHeading,
    argumentsMarkdown: extractArgumentsSection(body),
    flags: parseSkillFlags(frontmatter),
    group: deriveSkillGroup(id),
    sourcePath: sourcePath.replace(/\\/g, "/"),
  };
}

export interface SkillParseError {
  id: string;
  sourcePath: string;
  error: string;
}

export interface ListSkillsResult {
  skills: SkillEntry[];
  errors: SkillParseError[];
}

/**
 * Lê `skillsDir` (tipicamente `{rootDir}/.claude/skills`) e devolve toda
 * skill com `SKILL.md` legível — ordenada por id. Diretório sem `SKILL.md`
 * é pulado em silêncio (ver header). Falha de LEITURA (não de conteúdo —
 * conteúdo malformado ainda produz uma entry best-effort) vira `errors[]`,
 * nunca derruba a listagem inteira.
 */
export function listSkillsFromDir(skillsDir: string): ListSkillsResult {
  const skills: SkillEntry[] = [];
  const errors: SkillParseError[] = [];
  if (!existsSync(skillsDir)) return { skills, errors };

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const skillMdPath = join(skillsDir, id, "SKILL.md");
    if (!existsSync(skillMdPath)) continue; // stale/empty dir — ignorado em silêncio (#4270)
    const sourcePath = `.claude/skills/${id}/SKILL.md`;
    try {
      const raw = readFileSync(skillMdPath, "utf8");
      skills.push(parseSkillMarkdown(id, raw, sourcePath));
    } catch (e) {
      errors.push({ id, sourcePath, error: (e as Error).message });
    }
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  return { skills, errors };
}

// ---------------------------------------------------------------------------
// Snapshot (`GET /api/skills`)
// ---------------------------------------------------------------------------

export interface SkillsSnapshot {
  execMode: ExecMode;
  generatedAt: string;
  skills: SkillEntry[];
  errors: SkillParseError[];
  groupOrder: ReadonlyArray<SkillGroupId>;
  groupLabels: Record<SkillGroupId, string>;
}

export interface BuildSkillsOptions {
  now?: () => number;
}

/** Monta o snapshot de `GET /api/skills`. Puramente local (só filesystem) —
 * sem rede, sem credencial, sem cache: reler 18 arquivos pequenos a cada
 * request é mais barato que administrar TTL/invalidação. */
export function buildSkillsData(rootDir: string, opts: BuildSkillsOptions = {}): SkillsSnapshot {
  const now = opts.now ?? (() => Date.now());
  const skillsDir = join(rootDir, ".claude", "skills");
  const { skills, errors } = listSkillsFromDir(skillsDir);
  return {
    execMode: detectExecMode({ projectRoot: rootDir }),
    generatedAt: new Date(now()).toISOString(),
    skills,
    errors,
    groupOrder: SKILL_GROUP_ORDER,
    groupLabels: SKILL_GROUP_LABELS,
  };
}
