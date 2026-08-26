/**
 * develop-plan-collision.ts (#6265)
 *
 * `data/develop/{AAMMDD}/plan.json` é chaveado só por data — sem `session_id`
 * no path. Duas sessões `/diaria-develop` concorrentes na MESMA máquina, no
 * MESMO dia, colidem: a segunda sessão a rodar a Fase 0 passo 9 (escrita
 * inicial do plano) sobrescreve INTEIRAMENTE o `plan.json` da primeira —
 * perda de dados reais (issues classificadas, `goal.reached`, todo o
 * bookkeeping da sessão), não só o risco cosmético de statusLine já
 * documentado (`session_id`, #5156 item 11).
 *
 * Evidência ao vivo (#6265, 260826): Sessão A processou ~26 issues ao longo
 * da manhã e chegou a `goal.reached: true`; Sessão B, na mesma máquina,
 * pulou o passo 0 (Resume) e escreveu `plan.json` do zero na Fase 0 passo 9,
 * apagando o trabalho de A. O reparo ad-hoc aplicado na hora — mover o
 * plano da 2ª sessão pro sufixo `b` (`data/develop/260826b/plan.json`,
 * seguindo a convenção já usada pelo repo, ex: `data/develop/260822b/`) —
 * é exatamente o comportamento que este módulo mecaniza: a Fase 0 passo 9
 * chama `resolveDevelopPlanPath` ANTES de escrever, e o sufixo certo é
 * derivado sozinho em vez de depender da sessão colidente perceber a
 * colisão por conta própria (que foi precisamente o que faltou em B).
 *
 * ## Escolha de desenho: escrita defensiva por `session_id`, não lock
 *
 * A issue propunha 3 direções não-excludentes; esta implementação escolhe a
 * combinação das opções 2+3 (auto-derivar sufixo por `session_id`, tratando
 * ausência de `session_id` — plano legado — como colisão também) em vez de
 * lock ou de recusa dura (`exit 1`) sem caminho de recuperação automático:
 *
 * - **Lock de arquivo (`O_CREAT|O_EXCL`) foi descartado**: `data/` é uma
 *   junction OneDrive compartilhada entre MÁQUINAS (não só sessões na mesma
 *   máquina) — o próprio `session-registry.ts` documenta que esse tipo de
 *   lock é só *advisory* nesse cenário (`merge-lock`, #6182: "entre
 *   máquinas, O_CREAT|O_EXCL sobre o mesmo junction OneDrive NÃO é garantia
 *   de exclusão mútua real"). Um lock que não exclui de verdade cross-
 *   máquina não fecha a lacuna, só adiciona uma peça a mais pra falhar.
 * - **Recusa dura sem fallback (`exit 1` puro) foi descartada**: obrigaria
 *   a sessão colidente a parar e esperar input humano só pra escolher um
 *   sufixo — trabalho que o mecanismo já sabe fazer sozinho de forma
 *   determinística (mesmo padrão da convenção `b`/`c` já usada pelo repo
 *   pra 2ª/3ª rodada `overnight` do mesmo dia).
 * - **Custo de migração aceito**: todo consumidor de `data/develop/{AAMMDD}/`
 *   (statusLine, painel `/rodada`, gates `--plan`) já lê o `session_id` como
 *   campo OPCIONAL (`isForeignDevelopPlan`, #5156 item 11) — nenhum
 *   consumidor precisa mudar; eles simplesmente passam a receber um
 *   `session_id` populado com mais frequência (hoje: nunca; depois desta
 *   mudança: sempre, a partir do primeiro write do passo 9). Retrocompat
 *   total com plano legado sem o campo.
 *
 * ## Contrato de `resolveDevelopPlanPath`
 *
 * Tenta, em ordem, os sufixos `""`, `"b"`, `"c"`, ... — pra cada candidato
 * `{baseDir}/{AAMMDD}{suffix}/plan.json`:
 *
 * 1. **Não existe** → usa este path (é o primeiro slot livre do dia).
 * 2. **Existe E `session_id` bate com o desta sessão** → `mode: "resume"`,
 *    mesmo path — é a PRÓPRIA sessão continuando (resume pós-compaction
 *    dentro da mesma conversa, ou um 2º write do passo 9 em diante).
 * 3. **Existe E `session_id` NÃO bate (ou está ausente — plano legado)** →
 *    tratado como colisão (sessão ALHEIA em voo); tenta o próximo sufixo.
 *
 * Ausência de `session_id` no arquivo existente é tratada como colisão
 * (nunca como "livre pra tomar") de propósito — é exatamente o caso 3 da
 * "Sugestão sobre a direção do fix" do editor no #6265: um plano sem
 * `session_id` pode ser de uma sessão viva que ainda não escreveu o campo
 * (rollout desta mudança em progresso), então a escolha conservadora é
 * nunca sobrescrever silenciosamente.
 *
 * `probe` é injetável — a implementação real (CLI) lê `existsSync`/
 * `readFileSync` de verdade; testes simulam duas escritas concorrentes sem
 * tocar o filesystem.
 *
 * **Escopo: só `/diaria-develop`.** `/diaria-overnight` não usa este
 * módulo — a issue confirma que overnight não sofre a mesma colisão: ele
 * roda serial por máquina (`data/overnight/.active-session-{hostname}.json`,
 * #3322 — um marker por-máquina que efetivamente serializa rodadas
 * overnight na mesma máquina), enquanto `/diaria-develop` suporta
 * explicitamente sessões concorrentes (teto de 6 worktrees, item 6 do
 * #5156). `/diaria-continuo` reusa parte da maquinaria de overnight mas
 * NÃO foi verificado neste PR (fora de escopo, ver corpo da issue) — se
 * `continuo` também colide, é follow-up.
 *
 * @see scripts/resolve-develop-plan-path.ts (CLI/entrypoint)
 * @see scripts/overnight-statusline.ts (`isForeignDevelopPlan`, já lê `session_id`)
 * @see scripts/lib/session-registry.ts (`data/sessions/*.json`, fonte de `session_id` real)
 * @see .claude/skills/diaria-develop/SKILL.md
 */

/** Resultado de sondar um path candidato de `plan.json`. */
export interface DevelopPlanProbeResult {
  exists: boolean;
  /** `session_id` gravado no arquivo, se presente — `null`/`undefined`/`""`
   * tratado uniformemente como "ausente" pelo resolver. */
  sessionId?: string | null;
}

export type DevelopPlanProbe = (path: string) => DevelopPlanProbeResult;

export type DevelopPlanResolveMode = "fresh" | "resume" | "derived-after-collision";

export interface ResolvedDevelopPlanPath {
  /** Path final a usar para `plan.json` desta sessão. */
  path: string;
  /** Sufixo aplicado ao diretório `{AAMMDD}{suffix}` — `""` no caso comum. */
  suffix: string;
  mode: DevelopPlanResolveMode;
  /** Presente só quando `mode === "derived-after-collision"` — o(s) path(s)
   * alheio(s) que forçaram o avanço de sufixo, na ordem em que foram
   * encontrados. */
  collisions?: Array<{ path: string; sessionId: string | null }>;
}

/** Sufixos tentados em ordem — mesma convenção alfabética já usada pelo
 * repo pra 2ª/3ª rodada do mesmo dia (`260822b`, `260826b`, observados ao
 * vivo em `data/overnight/`/`data/develop/`). 25 letras é folga generosa
 * sobre qualquer concorrência real esperada (teto de 6 worktrees POR
 * sessão, não 25 sessões no mesmo dia). */
const SUFFIXES: readonly string[] = [
  "",
  ...Array.from({ length: 25 }, (_, i) => String.fromCharCode("b".charCodeAt(0) + i)),
];

function normalizeSessionId(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Pure: resolve qual path de `plan.json` esta sessão deve usar, evitando
 * sobrescrever o plano de outra sessão em voo. Nunca lança em uso normal —
 * só se os 26 sufixos se esgotarem (cenário extremo, ver `SUFFIXES`), sinal
 * de que algo mais está errado (falha ao ler `data/develop/`, por exemplo).
 */
export function resolveDevelopPlanPath(
  baseDir: string,
  aammdd: string,
  sessionId: string,
  probe: DevelopPlanProbe,
): ResolvedDevelopPlanPath {
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
    `resolveDevelopPlanPath: esgotou os ${SUFFIXES.length} sufixos disponíveis para ${aammdd} em ${baseDir} — ` +
      `sinal de problema na leitura de ${baseDir}, não concorrência real.`,
  );
}
