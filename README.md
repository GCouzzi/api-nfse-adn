# API NFS-e Nacional — ADN Contribuinte

API REST para sincronizar, consultar e baixar documentos da NFS-e Nacional distribuídos pelo Ambiente de Dados Nacional (ADN). A aplicação utiliza Bun, Express, certificado digital A1 com mTLS e oferece persistência em SQLite ou PostgreSQL.

O projeto inclui um painel web para consultar notas, aplicar filtros, acompanhar sincronizações e baixar XMLs ou pacotes ZIP.

Também oferece cadastro de empresas e certificados A1, seleção da empresa no painel e geração de DANFSe em PDF, individual ou em lote. Consulte [Empresas, certificados e PDFs](docs/EMPRESAS_E_PDF.md) para configurar as credenciais e escolher entre Gotenberg e Puppeteer.

## Recursos

- Sincronização incremental por NSU, assíncrona por padrão.
- Bloqueio de sincronizações simultâneas para o mesmo CNPJ.
- Histórico persistente dos jobs de sincronização.
- Consulta por competência, papel fiscal, status, prestador, tomador e chave de acesso.
- Listagem agrupada por mês de competência.
- Download do XML individual, ZIP de uma nota, ZIP mensal ou ZIP completo do CNPJ.
- Armazenamento do XML original e dos principais dados extraídos da nota.
- Suporte a SQLite e PostgreSQL.
- Login de administrador com sessão por cookie e API token opcional para integrações.
- Rate limiting de entrada e intervalo configurável entre chamadas ao ADN.
- Painel web e documentação OpenAPI servidos pela própria aplicação.

## Requisitos

- [Bun](https://bun.sh/) 1.3.14 ou superior para execução local.
- Certificado digital ICP-Brasil A1 com acesso ao ADN para sincronizações reais.
- Docker com o plugin Compose para execução em contêiner.

## Desenvolvimento local com Bun

Instale as dependências:

```bash
bun install
```

Crie o arquivo `.env` a partir do modelo:

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```bash
# Linux e macOS
cp .env.example .env
```

Para desenvolvimento local com SQLite e sem acesso real ao ADN, ajuste estas variáveis no `.env`:

```env
PORT=4000
DB_CLIENT=sqlite
DB_PATH=./data/nfse.db
ADN_ENV=homologacao
ENABLE_MOCK=true
ENABLE_UI=true
ADMIN_USERNAME=admin
ADMIN_PASSWORD=SUBSTITUA_POR_UMA_SENHA_FORTE
API_TOKEN=
```

Inicie a aplicação com recarregamento automático:

```bash
bun run dev
```

A API e o painel são servidos pelo mesmo processo:

| Recurso                 | Endereço                                  |
| :---------------------- | :---------------------------------------- |
| Painel web              | `http://localhost:4000/app/`              |
| Informações da API      | `http://localhost:4000/`                  |
| Healthcheck             | `http://localhost:4000/health`            |
| Documentação interativa | `http://localhost:4000/docs`              |
| Especificação OpenAPI   | `http://localhost:4000/docs/openapi.json` |

Quando `DB_PATH=./data/nfse.db`, o nome final inclui o ambiente do ADN. Em homologação, o arquivo criado é `data/nfse_homologacao.db`.

Para executar sem o modo watch:

```bash
bun run start
```

## Sincronização real com o ADN

Para desativar o mock e usar mTLS, configure no `.env`:

```env
ADN_ENV=homologacao
ENABLE_MOCK=false
CERT_PATH=./certs/certificado.pfx
CERT_PASSWORD=senha_do_certificado
```

Em produção, altere `ADN_ENV=producao`. Também é possível informar o certificado em Base64 por meio de `CERT_BASE64`.

O certificado e sua senha não devem ser versionados. A pasta `certs/` e os arquivos de certificado estão ignorados pelo Git.

Cadastre a empresa e valide seu certificado em `/app/empresas.html`. As sincronizações utilizam o certificado vinculado à empresa; o arquivo legado configurado acima também aparece na lista como `certificado-configurado.pfx`. Configure `CERT_ENCRYPTION_KEY` ou seu arquivo de segredo para salvar senhas. A ausência de certificado válido com `ENABLE_MOCK=false` causa erro e não ativa respostas simuladas.

O cadastro também permite enviar um `.pfx` ou `.p12` de até 10 MB pelo navegador. Os uploads são validados e salvos na pasta `CERTIFICATES_DIR` (padrão: `./certs`), com senha criptografada no banco. Nos Compose, `CERTIFICATES_HOST_DIR` define a pasta persistente do host, montada com escrita em `/app/certs`; Docker Secrets continuam somente leitura. Consulte [a configuração de armazenamento e permissões](docs/EMPRESAS_E_PDF.md#pasta-local-vps-e-docker-secrets).

## Bancos de dados

SQLite é usado quando `DB_CLIENT` não está definido. Para selecioná-lo explicitamente:

```env
DB_CLIENT=sqlite
DB_PATH=./data/nfse.db
```

Para usar PostgreSQL em uma execução local com Bun:

```env
DB_CLIENT=postgres
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nfse_db
PG_POOL_SIZE=10
```

As tabelas e os índices são criados automaticamente na inicialização.

## Execução com Docker Compose

O projeto mantém dois arquivos Compose independentes. Ambos executam a API e o painel; a diferença é o banco utilizado.

| Arquivo                       | Serviços            | Persistência              |
| :---------------------------- | :------------------ | :------------------------ |
| `docker-compose.sqlite.yml`   | API                 | Volume `nfse_sqlite_data` |
| `docker-compose.postgres.yml` | API e PostgreSQL 17 | Volume `nfse_pg_data`     |

Antes de iniciar qualquer stack, disponibilize o certificado no caminho definido por `CERT_PATH`. O padrão é `./certs/certificado.pfx`. O arquivo é montado no contêiner como Docker Secret.

Para o login, configure `ADMIN_USERNAME`, `ADMIN_PASSWORD` e `APP_ORIGIN=https://notas.seudominio.com` no ambiente. Os dois Compose repassam essas variáveis à aplicação. Publique o serviço por HTTPS. Para desenvolvimento local com Bun, use o fluxo descrito acima.

SQLite:

```bash
docker compose -f docker-compose.sqlite.yml up -d --build
```

PostgreSQL:

```bash
docker compose -f docker-compose.postgres.yml up -d --build
```

Para acompanhar os logs ou encerrar a stack, informe o mesmo arquivo usado na inicialização:

```bash
docker compose -f docker-compose.sqlite.yml logs -f api
docker compose -f docker-compose.sqlite.yml down
```

Substitua o nome do arquivo por `docker-compose.postgres.yml` ao operar a stack PostgreSQL.

## Login e autenticação da API

O painel utiliza um único administrador com acesso completo. Configure `ADMIN_USERNAME` e `ADMIN_PASSWORD` nas variáveis de ambiente do serviço. No EasyPanel, informe esses valores diretamente na configuração de ambiente; executando localmente com Bun, use o arquivo `.env`.

A aplicação gera o hash Argon2id em memória na inicialização e o utiliza para verificar o login. Não é necessário gerar hashes manualmente ou disponibilizar arquivos de senha. A senha permanece na configuração do ambiente e não é gravada pela aplicação em arquivos, no banco ou nos logs.

Depois do login, o navegador recebe um cookie `HttpOnly`, com `SameSite=Strict` e validade de oito horas. O cliente compartilhado usa a sessão em todas as páginas e inclui proteção contra CSRF nas alterações. O botão **Sair** revoga a sessão. As credenciais e o identificador da sessão não são salvos no armazenamento local do navegador.

As sessões ficam em memória: reiniciar o servidor exige novo login. Execute uma única instância da aplicação com esta configuração. Fechar uma página não encerra a sessão nem interrompe trabalhos de PDF em andamento. Alterar o usuário ou a senha e reiniciar a aplicação invalida as sessões anteriores.

Na VPS, configure:

```env
NODE_ENV=production
APP_ORIGIN=https://notas.seudominio.com
ADMIN_USERNAME=admin
ADMIN_PASSWORD=SUBSTITUA_POR_UMA_SENHA_FORTE
```

`APP_ORIGIN` deve conter apenas protocolo e domínio, sem `/app` ou barra final. O proxy, como o EasyPanel, deve encaminhar todas as rotas do domínio para a porta da aplicação, incluindo `/app`, `/auth` e `/api`. Em produção, o cookie exige HTTPS. Em desenvolvimento local, o cookie funciona em HTTP. As tentativas de login são limitadas a dez por IP em quinze minutos; atrás de um proxy sem encaminhamento confiável de IP, esse limite é compartilhado pelos clientes do proxy.

Para trocar a senha no EasyPanel, altere `ADMIN_PASSWORD` e reimplante o serviço. Em uma execução local, altere o `.env` e reinicie a aplicação.

As rotas em `/api` sempre exigem autenticação. Para integrações externas, configure `API_TOKEN` no servidor e use um dos cabeçalhos:

```http
Authorization: Bearer SEU_TOKEN
```

```http
x-api-key: SEU_TOKEN
```

Para gerar um token hexadecimal de 32 bytes:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

```bash
openssl rand -hex 32
```

O painel utiliza o login e não precisa conhecer `API_TOKEN`. Deixar essa variável vazia desativa o acesso por token; a API continua exigindo uma sessão válida. Sem credenciais de administrador, o login fica indisponível e a API permanece protegida.

## Variáveis de ambiente

| Variável               | Padrão da aplicação       | Descrição                                                    |
| :--------------------- | :------------------------ | :----------------------------------------------------------- |
| `PORT`                 | `4000`                    | Porta HTTP da API e do painel.                               |
| `DB_CLIENT`            | `sqlite`                  | Banco utilizado: `sqlite` ou `postgres`.                     |
| `DB_PATH`              | `data/nfse_<ambiente>.db` | Caminho do banco SQLite.                                     |
| `DATABASE_URL`         | PostgreSQL local          | String de conexão do PostgreSQL.                             |
| `PG_POOL_SIZE`         | `10`                      | Número máximo de conexões no pool.                           |
| `ADN_ENV`              | `homologacao`             | Ambiente `homologacao` ou `producao`.                        |
| `CERT_PATH`            | `certs/certificado.pfx`   | Caminho do certificado A1.                                   |
| `CERT_PASSWORD`        | vazio                     | Senha do certificado A1.                                     |
| `CERT_BASE64`          | vazio                     | Certificado A1 codificado em Base64.                         |
| `ENABLE_MOCK`          | `false`                   | Ativa respostas simuladas do ADN.                            |
| `ENABLE_UI`            | `true`                    | Disponibiliza o painel em `/app/`.                           |
| `API_TOKEN`            | vazio                     | Credencial opcional para integrações externas.               |
| `ADMIN_USERNAME`       | vazio                     | Usuário único do painel.                                     |
| `ADMIN_PASSWORD`       | vazio                     | Senha do administrador, recebida pelo ambiente.              |
| `APP_ORIGIN`           | origem HTTP da requisição | Origem pública do painel; obrigatória em produção com login. |
| `RATE_LIMIT_WINDOW_MS` | `60000`                   | Janela do rate limit em milissegundos.                       |
| `RATE_LIMIT_MAX`       | `100`                     | Requisições permitidas por janela e por IP.                  |
| `ADN_REQUEST_DELAY_MS` | `500`                     | Intervalo entre lotes consultados no ADN.                    |
| `ADN_MAX_RETRIES`      | `3`                       | Máximo de tentativas em falhas transitórias.                 |

Consulte [.env.example](.env.example) para a configuração base e as tabelas da documentação para os recursos adicionais. Os valores de exemplo devem ser revisados antes do uso.

## Testes e build

```bash
bun run format:check
bun run typecheck
bun test src/tests
bun run build
```

Para aplicar a formatação do projeto, execute `bun run format`.

O build é gerado em `dist/`.

Também existem scripts para gerar executáveis autônomos:

```bash
bun run build:exe
bun run build:linux
```

Os diretórios `public/` e `docs/` devem acompanhar o executável para que o painel e a documentação sejam servidos.

## Documentação da API

- [Guia dos endpoints](docs/API.md)
- [Especificação OpenAPI 3.0](docs/openapi.json)
- [Cadastro de empresas, certificados e geração de PDF](docs/EMPRESAS_E_PDF.md)
- Interface interativa em `GET /docs`

## Endpoints principais

| Método | Endpoint                       | Descrição                                                |
| :----- | :----------------------------- | :------------------------------------------------------- |
| `POST` | `/api/sync`                    | Inicia uma sincronização.                                |
| `GET`  | `/api/sync/jobs`               | Lista jobs de sincronização.                             |
| `GET`  | `/api/sync/jobs/:id`           | Consulta um job.                                         |
| `GET`  | `/api/sync/:cnpj`              | Consulta o controle de sincronização do CNPJ.            |
| `GET`  | `/api/notas`                   | Lista e filtra notas armazenadas.                        |
| `GET`  | `/api/notas/:chaveAcesso`      | Retorna uma nota e seus eventos.                         |
| `GET`  | `/api/notas/:chaveAcesso/xml`  | Baixa o XML principal.                                   |
| `GET`  | `/api/notas/:chaveAcesso/zip`  | Baixa uma nota e seus eventos em ZIP.                    |
| `GET`  | `/api/notas/cnpj/:cnpj/zip`    | Baixa XMLs em lote, com filtro opcional por competência. |
| `GET`  | `/api/notas/documento/:id/xml` | Baixa um documento XML pelo ID.                          |
