# WARP.md

Este arquivo dá orientações ao WARP (warp.dev) para trabalhar neste repositório.

## Sobre o repositório

Este repositório é uma **skill para Claude Code / OpenCode**, escrita inteiramente em Markdown, focada em português brasileiro.

O artefato de "runtime" é o `SKILL.md`: o Claude Code lê o frontmatter YAML (metadados + ferramentas permitidas) e o prompt/instruções que vêm depois.

O `README.md` é para humanos: instalação, uso e um resumo compacto dos padrões.

## Arquivos principais (e como se relacionam)

- `SKILL.md`
  - A definição real da skill.
  - Começa com frontmatter YAML (`---` … `---`) contendo `name`, `version`, `description` e `allowed-tools`.
  - Depois do frontmatter vem o prompt do editor: lista canônica e detalhada dos padrões, com exemplos pt-BR.
- `README.md`
  - Instruções de instalação e uso.
  - Contém uma tabela resumida dos 27 padrões e um histórico de versões curto.
- `CONTRIBUTING.md`
  - Convenções de manutenção (fluxo de PR, versionamento, formas de seção, checagens locais).
  - Vale para qualquer editor.

Ao mudar comportamento/conteúdo, trate o `SKILL.md` como fonte da verdade, e atualize o `README.md` para ficar consistente.

## Comandos comuns

### Instalar a skill no Claude Code

Recomendado (clonar direto no diretório de skills):

```bash
mkdir -p ~/.claude/skills
git clone https://github.com/vjpixel/humanizador.git ~/.claude/skills/humanizador
```

Instalação/atualização manual (só o arquivo da skill):

```bash
mkdir -p ~/.claude/skills/humanizador
cp SKILL.md ~/.claude/skills/humanizador/
```

## Como "rodar" (Claude Code)

Invocar a skill:

- `/humanizador` e colar o texto

## Contribuindo

Para fluxo de PR, versionamento, convenções de SKILL.md e como rodar as checagens localmente, veja [`CONTRIBUTING.md`](CONTRIBUTING.md).
