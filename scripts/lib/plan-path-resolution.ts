/**
 * plan-path-resolution.ts (#6328)
 *
 * Miolo PURO e genérico do resolvedor de colisão de `plan.json` — extraído
 * de `scripts/lib/develop-plan-collision.ts` (#6265, que resolvia isto só
 * pro `/diaria-develop`) para ser compartilhado com `/diaria-overnight`
 * (#6328). Parametrizado pelo diretório base (`data/develop` vs
 * `data/overnight`) — a lógica em si nunca dependeu de nada específico do
 * develop, só o naming dos tipos/CLI original sugeria isso.
 *
 * ## Por que o overnight também precisa disto (#6328)
 *
 * `data/overnight/{AAMMDD}/plan.json` é chaveado só por data — sem
 * `session_id` no path — exatamente como o `plan.json` do develop era antes
 * do #6265. A diferença que faz o caso do overnight **mais grave**, não
 * menos: ele roda DESASSISTIDO. Uma 2ª máquina que rode `/diaria-overnight`
 * no mesmo dia (`data/` é o MESMO OneDrive entre máquinas, ver CLAUDE.md §
 * Setup) encontra o `plan.json` que a 1ª máquina escreveu e, com a checagem
 * antiga (`existsSync` puro, "existe → é retomada"), conclui erroneamente
 * que é ela mesma continuando — **pulando o briefing** e escrevendo por
 * cima do plano da rodada viva, sem alarme e sem ninguém acordado para
 * notar (issue #6328, achado ao vivo em 26/08/2026 quando o editor
 * perguntou "se eu rodar numa 2ª máquina, ela sabe que deve usar sufixo
 * diferente?" — resposta correta antes deste módulo: só se alguém
 * lembrar).
 *
 * ## Escolha de desenho: escrita defensiva por `session_id`, não lock
 *
 * Ver o docblock original de `scripts/lib/develop-plan-collision.ts` (#6265)
 * para o racional completo (lock `O_CREAT|O_EXCL` descartado porque
 * `data/` é uma junction OneDrive cross-máquina onde esse tipo de lock é só
 * *advisory*, #6182; recusa dura sem fallback descartada porque obrigaria
 * parar e esperar humano pra escolher um sufixo que o mecanismo já sabe
 * derivar sozinho). O discriminador é `session_id` — não `machine_id`:
 * duas sessões em MÁQUINAS diferentes já têm `session_id` diferentes por
 * construção (o harness gera um por sessão, nunca reaproveitado entre
 * processos), então a checagem por `session_id` já cobre o caso
 * cross-máquina sem precisar comparar `machine_id` explicitamente — o
 * campo `machine_id` gravado no `plan.json` (ver `scripts/lib/machine-id.ts`)
 * é consumido por quem PRECISA saber "de qual máquina veio este plano"
 * depois do fato (statusLine, painel, relatório), não pelo resolver em si.
 *
 * ## Contrato de `resolvePlanPath`
 *
 * Tenta, em ordem, os sufixos `""`, `"b"`, `"c"`, ... — pra cada candidato
 * `{baseDir}/{aammdd}{suffix}/plan.json`:
 *
 * 1. **Não existe** → usa este path (é o primeiro slot livre do dia).
 * 2. **Existe E `session_id` bate com o desta sessão** → `mode: "resume"`,
 *    mesmo path — é a PRÓPRIA sessão continuando (resume pós-compaction
 *    dentro da mesma conversa, ou um 2º write em diante).
 * 3. **Existe E `session_id` NÃO bate (ou está ausente — plano legado)** →
 *    tratado como colisão (sessão ALHEIA em voo — mesma máquina OU outra
 *    máquina no mesmo OneDrive, indistinguível e irrelevante pra decisão);
 *    tenta o próximo sufixo.
 *
 * Ausência de `session_id` no arquivo existente é tratada como colisão
 * (nunca como "livre pra tomar") de propósito — um plano sem `session_id`
 * pode ser de uma sessão viva que ainda não escreveu o campo (rollout desta
 * mudança em progresso, ou `plan.json` de antes do #6265/#6328), então a
 * escolha conservadora é nunca sobrescrever silenciosamente.
 *
 * `probe` é injetável — a implementação real (CLI) lê `existsSync`/
 * `readFileSync` de verdade (ver `createFsPlanProbe` abaixo); testes
 * simulam múltiplas escritas concorrentes sem tocar o filesystem.
 *
 * @see scripts/lib/develop-plan-collision.ts (wrapper fino, nomes
 *   específicos do develop preservados para retrocompatibilidade — mesmo
 *   contrato de saída, nenhum consumidor existente precisa mudar)
 * @see scripts/resolve-develop-plan-path.ts (CLI develop)
 * @see scripts/resolve-overnight-plan-path.ts (CLI overnight, #6328)
 * @see scripts/lib/machine-id.ts (`machine_id` gravado à parte, consumido
 *   por quem precisa discriminar por máquina depois do fato)
 * @see .claude/skills/diaria-develop/SKILL.md
 * @see .claude/skills/diaria-overnight/SKILL.md
 */

import { existsSync, readFileSync } from "node:fs";

/** Resultado de sondar um path candidato de `plan.json`. */
export interface PlanPathProbeResult {
  exists: boolean;
  /** `session_id` gravado no arquivo, se presente — `null`/`undefined`/`""`
   * tratado uniformemente como "ausente" pelo resolver. */
  sessionId?: string | null;
}

export type PlanPathProbe = (path: string) => PlanPathProbeResult;

export type PlanPathResolveMode = "fresh" | "resume" | "derived-after-collision";

export interface ResolvedPlanPath {
  /** Path final a usar para `plan.json` desta sessão. */
  path: string;
  /** Sufixo aplicado ao diretório `{aammdd}{suffix}` — `""` no caso comum. */
  suffix: string;
  mode: PlanPathResolveMode;
  /** Presente só quando `mode === "derived-after-collision"` — o(s) path(s)
   * alheio(s) que forçaram o avanço de sufixo, na ordem em que foram
   * encontrados. */
  collisions?: Array<{ path: string; sessionId: string | null }>;
}

/** Sufixos tentados em ordem — mesma convenção alfabética já usada pelo
 * repo pra 2ª/3ª rodada do mesmo dia (`260822b`, `260826b`, observados ao
 * vivo em `data/overnight/`/`data/develop/`). 25 letras é folga generosa
 * sobre qualquer concorrência real esperada. */
const SUFFIXES: readonly string[] = [
  "",
  ...Array.from({ length: 25 }, (_, i) => String.fromCharCode("b".charCodeAt(0) + i)),
];

function normalizeSessionId(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Pure: resolve qual path de `plan.json` esta sessão deve usar, evitando
 * sobrescrever o plano de outra sessão em voo — mesma máquina ou outra
 * máquina compartilhando o mesmo diretório `data/` via OneDrive. Nunca
 * lança em uso normal — só se os 26 sufixos se esgotarem (cenário extremo,
 * ver `SUFFIXES`), sinal de que algo mais está errado (falha ao ler
 * `{baseDir}/`, por exemplo).
 */
export function resolvePlanPath(
  baseDir: string,
  aammdd: string,
  sessionId: string,
  probe: PlanPathProbe,
): ResolvedPlanPath {
  const ourSessionId = normalizeSessionId(sessionId);
  const collisions: Array<{ path: string; sessionId: string | null }> = [];

  for (const suffix of SUFFIXES) {
    const path = `${baseDir}/${aammdd}${suffix}/plan.json`;
    const probed = probe(path);

    if (!probed.exists) {
      return {
        path,
        suffix,
        mode: collisions.length > 0 ? "derived-after-collision" : "fresh",
        ...(collisions.length > 0 ? { collisions } : {}),
      };
    }

    const planSessionId = normalizeSessionId(probed.sessionId);
    if (ourSessionId !== "" && planSessionId === ourSessionId) {
      return { path, suffix, mode: "resume" };
    }

    // Existe, e não é claramente nosso (session_id diferente OU ausente —
    // plano legado tratado como potencialmente alheio, nunca "livre").
    collisions.push({ path, sessionId: probed.sessionId ?? null });
  }

  throw new Error(
    `resolvePlanPath: esgotou os ${SUFFIXES.length} sufixos disponíveis para ${aammdd} em ${baseDir} — ` +
      `sinal de problema na leitura de ${baseDir}, não concorrência real.`,
  );
}

/**
 * Probe real de filesystem — leitura de `{path}` do disco, mesma
 * implementação que os dois CLIs (`resolve-develop-plan-path.ts`,
 * `resolve-overnight-plan-path.ts`) usavam duplicada antes deste módulo.
 * JSON malformado (conflito de sync do OneDrive em voo) é tratado como
 * "existe, session_id desconhecido" — nunca "não existe": a checagem de
 * colisão continua conservadora, nunca escreve por cima de um arquivo que
 * não conseguiu ler.
 */
export function createFsPlanProbe(): PlanPathProbe {
  return (path: string): PlanPathProbeResult => {
    if (!existsSync(path)) return { exists: false };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { session_id?: unknown };
      const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : null;
      return { exists: true, sessionId };
    } catch {
      return { exists: true, sessionId: null };
    }
  };
}
