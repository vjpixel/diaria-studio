# Arquivamento de edições antigas

A pipeline acumula 1 diretório por edição em `data/editions/{AAMMDD}/` (~5MB cada por causa das imagens). Em produção sustentada, isso vira gigabytes em poucos meses. O script `scripts/archive-editions.ts` move edições antigas pra `data/archive/{YYMM}/{AAMMDD}/` mantendo o working tree leve.

## Comandos

```bash
# Dry-run (default): lista o que seria movido sem executar
npm run archive-editions

# Threshold custom
npm run archive-editions -- --older-than 180

# Executar de fato
npm run archive-editions -- --execute

# Incluir edições de teste / sem 05-published.json
npm run archive-editions -- --execute --include-test
```

## Regras de elegibilidade

Uma edição vai pro archive quando **todas** as condições são satisfeitas:

1. Diretório casa o padrão `^\d{6}$` (AAMMDD válido).
2. Idade > threshold (default 90 dias, configurável via `--older-than`).
3. `{edition}/05-published.json` existe **e** tem `status: "published"` ou `"scheduled"`.

Edições com status `draft`, `failed`, sem `05-published.json`, ou com formato de pasta inválido são **puladas** por padrão (provavelmente testes ou execuções interrompidas que o editor pode querer revisar manualmente). Use `--include-test` pra forçar arquivamento dessas também.

## Localização do destino

```
data/archive/
├── 2601/        # Edições de Jan/2026
│   ├── 260103/
│   ├── 260105/
│   └── ...
├── 2602/
│   └── ...
└── 2603/
    └── ...
```

Agrupar por `YYMM` mantém arquivos navegáveis no terminal sem listas gigantes.

## Acessar uma edição arquivada

Edições arquivadas mantêm a estrutura original — basta navegar:

```bash
ls data/archive/2601/260105/
# 01-categorized.md  02-reviewed.md  03-social.md  04-d1.jpg  ...
```

Não há descompressão necessária (V1 não comprime; ver [follow-up](#follow-ups) abaixo).

## Política de retenção

- **0–90 dias**: em `data/editions/`. Acessível pela pipeline, gates, retry, etc.
- **90 dias–2 anos**: em `data/archive/`. Read-only por convenção. Não consultadas pela pipeline.
- **> 2 anos**: candidatas a deletar manualmente se o disco apertar. O editor decide caso a caso (algumas edições têm valor histórico — ex: primeira edição, edições virais).

## Backups

`data/archive/` está **gitignored** (privacidade — pode conter rascunhos não-publicados). Se quiser preservar histórico fora do disco local, opções:

- O Drive sync já mantém uma cópia de cada edição em `Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/` quando rodada (configurado em `platform.config.json`).
- Snapshot manual periódico de `data/archive/` pra storage externo (Drive separado, `tar.gz` em backup pessoal, etc.).

## Riscos

- **Perda acidental**: se o script tiver bug, edição válida pode ir pro archive errado. Mitigação: dry-run é o default; `--execute` é explícito; o script **nunca sobrescreve** um destino de archive já existente.
- **Move atravessa partições**: `renameSync` falha entre filesystems diferentes. Hoje só move dentro de `data/`, então não importa, mas seria um problema se alguém configurasse `data/archive/` em outro mountpoint. Follow-up: detectar `EXDEV` e fallback pra copy+delete.
- **Git history não encolhe**: archive remove só do working tree. Pra reduzir tamanho do clone histórico precisaria `git filter-branch` ou `git filter-repo` — fora de escopo.

## Follow-ups (não implementados em V1)

- Compressão automática (`tar.gz` ao mover) pra economizar disco. Issue: precisa decidir se aceitar custo de descompressão na consulta vale o ganho de espaço (~70% smaller para texto+JSON, ~10% para imagens já comprimidas).
- Cron / `npm run archive-editions:auto` rodando mensalmente via `setup.ts` ou hook do shell.
- Retenção configurável por status (ex: `published` → 1 ano, `failed` → 30 dias).

Refs #98.
