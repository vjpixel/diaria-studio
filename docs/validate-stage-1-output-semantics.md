# `validate-stage-1-output.ts` — semântica canônica (#581, #828, #832)

Documento canônico dos exit codes e modo de uso do `scripts/validate-stage-1-output.ts`.

Anteriormente os mesmos detalhes viviam duplicados em `.claude/skills/diaria-1-pesquisa/SKILL.md` e `.claude/agents/orchestrator-stage-1-research.md`, com risco de drift quando uma das duas era atualizada e a outra não (#832). Single source of truth aqui — ambos arquivos linkam pra cá.

## Quando rodar

Antes de apresentar o gate humano de Stage 1, depois que `01-categorized.md`, `01-categorized.json` e `01-eia.md` foram gerados (ou intencionalmente skipados). `04-d1-1x1.jpg` é output de Stage 3 e não está no escopo deste validator. Detecta regressões conhecidas:

- **#577** Drive sync push pulado silenciosamente.
- **#578** EIA format quebrado (UnknownUnknown, EN no lugar de PT-BR, sem hyperlinks).
- **#579** Numeração não-sequencial cross-section.
- **#580** Notícias off-topic (não-IA).
- **#488** Mínimos por seção abaixo do alvo.

## Comando

```bash
npx tsx scripts/validate-stage-1-output.ts \
  --edition {AAMMDD} \
  --edition-dir data/editions/{AAMMDD}/
```

Flags opcionais:

- `--ai-relevance-threshold 0.7` — override do threshold de IA-relevance (default 0.7).
- `--no-drive-sync` — skip da assertion de drive_sync_confirmed (também auto-detectado de `platform.config.json > drive_sync = false`).

## Exit codes

| Código | Significado | Ação do caller |
|---|---|---|
| **0** | Tudo OK | Apresentar gate normal. |
| **1** | Warnings | Apresentar gate **com banner de warnings** no topo. Ler `assertions[]` do JSON em stdout, extrair `.message` para cada `status: "warn"`, mostrar no relatório do gate antes do conteúdo. Editor decide se aprova ou pede retry. |
| **2** | Blockers | **Não apresentar gate.** Mostrar `assertions[].message` dos `status: "blocker"` e oferecer retry: `Retry / abortar?`. |
| **3** | Erro de uso (args inválidos, edition-dir não existe) | Reportar e abortar. |

## Falha do próprio validator

Exit code não-mapeado, crash, ou erro inesperado → logar warn e prosseguir com gate normal. **Nunca bloquear edição por falha do próprio validator** — o validator é catch-net, não gating crítico.

## Output JSON

`stdout` contém um `ValidationResult`:

```ts
interface ValidationResult {
  edition: string;
  edition_dir: string;
  assertions: AssertionResult[];
  blocking_count: number;
  warning_count: number;
  ok_count: number;
}

interface AssertionResult {
  name: string;            // "outputs_present", "ai_relevance_ratio", etc.
  status: "ok" | "warn" | "blocker";
  message: string;         // human-readable pra editor
  details?: Record<string, unknown>;  // dados estruturados pra logs
}
```

## Callers

- **`/diaria-1-pesquisa` skill** (`.claude/skills/diaria-1-pesquisa/SKILL.md`) — chama no Passo 3.
- **`/diaria-edicao` orchestrator** (`.claude/agents/orchestrator-stage-1-research.md`) — chama no substep 1w-bis.

Ambos seguem a tabela de exit codes acima.
