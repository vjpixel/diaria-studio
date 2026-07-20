---
name: diaria-4-revisao
description: Roda a Etapa 4 (revisão editorial assistida — pré-render HTML + resumo consolidado + gate humano pré-publicação). Uso — `/diaria-4-revisao AAMMDD`.
---

# /diaria-4-revisao

Dispara a Etapa 4 da pipeline Diar.ia: **Revisão editorial assistida**. Monta um resumo consolidado da edição final (destaques + títulos + links verificados + lints + imagens + social preview) e apresenta num gate humano. Aprovado → Etapa 5 (Publicação) pode ser disparada.

## Argumentos

- `$1` = data da edição no formato `AAMMDD` (ex: `260418`).

Se não passar data, rodar `npx tsx scripts/lib/find-current-edition.ts --stage 4` e parsear `candidates[]` do JSON de saída (#583):
  - **Se `candidates.length === 1`**: assumir essa edição. Logar info: `Assumindo edição em curso: {AAMMDD}`.
  - **Se `candidates.length === 0`**: erro. `Nenhuma edição com Stage 3 aprovado e Stage 4 incompleto. Rode /diaria-3-imagens primeiro ou passe AAMMDD explicitamente.`
  - **Se `candidates.length >= 2`**: perguntar ao editor qual: `Múltiplas edições em curso: {lista}. Qual processar?`

**`{EDITION_DIR}` (#2463/#3024):** diretório REAL da edição no disco — pode ser o layout flat legado OU o nested novo, dependendo de quando a edição foi criada. Resolver **uma vez** logo após ter `{AAMMDD}`, e usar em todo path abaixo que hoje aparece como `data/editions/{AAMMDD}/`:
```bash
EDITION_DIR=$(npx tsx scripts/lib/find-current-edition.ts --resolve {AAMMDD})
```

## Pré-requisitos

- Etapas 1–3 completas: `02-reviewed.md`, `03-social.md`, `01-eia.md` + `01-eia-A.jpg` + `01-eia-B.jpg`, `04-d{1,2,3}*.jpg`

## Passo -1 — Task tracking setup (#904)

**Defensive cleanup**: varrer `TaskList()` e marcar como `completed` qualquer task `in_progress` de Stages anteriores. Em seguida, criar tasks: `Stage 4a — pre-render técnico`, `Stage 4b — resumo consolidado`, `Stage 4c — gate humano`. Marcar `completed` quando cada passo retornar. **No-op se TaskCreate/TaskUpdate não estiver disponível**.

## O que faz

Você (top-level Claude Code) **lê `.claude/agents/orchestrator-stage-4.md` como playbook e executa diretamente**. As etapas são:

### Etapa 4a. Pré-requisitos + sync

Verificar sentinel Stage 3, marcar Stage 4 `running`, sync pull.

### Etapa 4b. Pré-render técnico

- capture-livros-promo (screenshot, opcional)
- upload-images-public (newsletter + social)
- Pre-render newsletter HTML (beehiiv-playbook steps 1-5 sem dispatch)
- Pre-render social preview HTML
- close-poll (set gabarito)
- check-invariants --stage 4

### Etapa 4c. Resumo consolidado + gate humano (#1694)

Coleta destaques (D1/D2/D3 com títulos e URLs), verifica acessibilidade, roda lints (`validate-lancamentos.ts`, `lint-newsletter-md.ts`), lista imagens e social hooks. Apresenta ao editor num gate visual limpo com link para newsletter HTML preview + social preview.

Respostas aceitas: `sim` (aprovar), `editar` (halt para edição local/Studio, re-rodar), `ajustar` (edição inline no chat, volta ao gate), `abortar` (encerrar sem sentinel).

Com `--no-gates` (ou `auto_approve = true`): pular o gate, ir direto ao sentinel.

### Etapa 4d. Escrever sentinel de conclusão

```bash
npx tsx scripts/pipeline-sentinel.ts write \
  --edition {AAMMDD} --step 4 \
  --outputs "02-reviewed.md,03-social.md"
npx tsx scripts/update-stage-status.ts --edition-dir {EDITION_DIR}/ --stage 4 --status done
```

## Output

- `_internal/.step-4-done.json` — sentinel de conclusão da Revisão
- `_internal/newsletter-final.html` — HTML pré-renderizado pronto para Stage 5
- `_internal/05-social-preview.json` — URL do social preview (com hash)
- `06-public-images.json` — URLs públicas das imagens

## Próximo passo

Após aprovação: `/diaria-5-publicacao {AAMMDD}` para dispatch da newsletter e social.

## Notas

- Para rodar como parte do pipeline completo, use `/diaria-edicao`.
- Resume-aware: re-rodar detecta sentinel e pula pré-render já concluído.
