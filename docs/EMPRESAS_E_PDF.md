# Empresas, certificados e geração de DANFSe

O painel permite selecionar empresas cadastradas, sincronizar com um certificado específico e baixar DANFSe em PDF. A geração utiliza o XML armazenado e a situação conhecida após a última sincronização. O certificado é necessário para a consulta ao ADN; a geração de PDF utiliza os documentos locais.

## Cadastro de empresas e certificados

1. Defina uma pasta privada para os certificados em `CERTIFICATES_DIR` (padrão: `./certs`). Para enviar arquivos pelo painel, o usuário que executa a aplicação precisa de permissão de escrita nessa pasta. Também é possível disponibilizar os arquivos manualmente e cadastrá-los pela lista de arquivos existentes.
2. Configure uma chave para criptografar as senhas. Gere uma chave de 32 bytes:

   ```bash
   bun -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

3. Salve o resultado em `CERT_ENCRYPTION_KEY` no ambiente da aplicação ou em um arquivo apontado por `CERT_ENCRYPTION_KEY_FILE`. O arquivo `/run/secrets/cert_encryption_key` é utilizado quando disponível.
4. Acesse `/app/empresas.html`. Em **Origem do certificado**, escolha **Enviar arquivo deste computador** ou **Usar arquivo já disponível no servidor**. Informe a senha e salve. Depois, cadastre ou edite a empresa para vincular o certificado.
5. Volte ao painel, selecione a empresa e solicite a sincronização.

A chave de criptografia deve permanecer estável entre reinicializações. Seu backup deve acompanhar os backups do banco e dos certificados, com acesso restrito. Alterar a chave impede a leitura das senhas anteriores; cadastre novamente as senhas caso a chave seja substituída sem migração.

As senhas são criptografadas com AES-256-GCM. A API de listagem retorna somente metadados dos certificados. O cadastro valida a senha, a presença da chave privada e a validade do certificado. A autorização para consultar o CNPJ é verificada pelo ADN durante a sincronização.

O upload aceita um arquivo `.pfx` ou `.p12` de até 10 MB. O conteúdo é recebido em memória e validado antes de qualquer gravação: extensão, estrutura PKCS#12, chave privada, senha e período de validade. O nome definitivo é gerado pelo servidor (`certificado-<UUID>.pfx`), sem usar o nome enviado como caminho. Se a gravação no banco falhar, o novo arquivo é removido. Os arquivos originais enviados são preservados no formato PKCS#12; as senhas são criptografadas separadamente no banco.

No Linux, arquivos novos são criados com modo `0600` e a pasta, quando criada pela aplicação, com modo `0700`. Diretórios já existentes mantêm suas permissões; configure o proprietário para o usuário da aplicação. No Windows, o acesso depende das permissões NTFS da pasta. O destino do upload deve ficar fora de `public/`; a aplicação rejeita essa pasta e seus subdiretórios.

O cadastro de arquivos já disponíveis aceita somente arquivos da pasta permitida. Caminhos arbitrários e links que saem dessa pasta são rejeitados. Se o certificado anteriormente configurado por `CERT_PATH`, `CERT_BASE64` ou Docker Secret existir, a lista também oferece `certificado-configurado.pfx`. Ao substituir um certificado por upload, o cadastro passa a apontar para o novo arquivo; o arquivo anterior permanece na pasta, sem sobrescrita ou exclusão automática.

Um certificado pode ser vinculado a várias empresas. A troca do arquivo exige revalidação no cadastro; a aplicação detecta alterações pelo fingerprint do arquivo. Empresas inativas mantêm as notas acessíveis, mas não podem iniciar novas sincronizações.

Cadastros, consultas e downloads exigem a sessão do administrador ou um `API_TOKEN` de integração válido. O administrador e o token possuem acesso a todas as empresas cadastradas. A seleção da empresa define o contexto da consulta e não constitui controle de acesso por usuário.

### Pasta local, VPS e Docker Secrets

Executando diretamente com Bun, configure o destino no ambiente do processo. Exemplo para uma VPS:

```dotenv
CERTIFICATES_DIR=/opt/nfse/certs
```

Essa pasta deve pertencer ao usuário que executa o Bun. Para uso local, o padrão `./certs` atende ao mesmo fluxo de upload. Não é necessário executar Docker. Para acesso remoto, configure o [login do administrador](../README.md#login-e-autenticação-da-api), `APP_ORIGIN` e HTTPS no proxy que publica a aplicação. Integrações externas podem usar `API_TOKEN`.

Nos dois Compose, o volume de certificados permite leitura e escrita. A variável `CERTIFICATES_HOST_DIR` escolhe a pasta no host, enquanto a aplicação usa `/app/certs` dentro do contêiner:

```dotenv
CERTIFICATES_HOST_DIR=/opt/nfse/certs
```

O usuário `bun` do contêiner precisa ter permissão de escrita no diretório montado. O volume deve ser persistente para manter os uploads entre recriações do contêiner.

`CERT_PATH` e o Docker Secret `cert_pfx` continuam atendendo ao certificado previamente configurado. O caminho `/run/secrets/cert_pfx` é um arquivo somente leitura, não um destino de upload. A aplicação salva novos arquivos em `CERTIFICATES_DIR`, sem modificar Docker Secrets. A pasta dos certificados, o banco e a chave de criptografia devem fazer parte do backup da aplicação.

## Renderizador de PDF

Os serviços de PDF dependem do contrato `PdfRenderer`. A composição em `src/main/services.ts` seleciona um adaptador. Consultas, regras de status e exportações são compartilhadas pelos dois renderizadores.

### Gotenberg

```env
PDF_RENDERER=gotenberg
GOTENBERG_URL=http://gotenberg:3000
PDF_TIMEOUT_MS=60000
```

Use o endereço acessível a partir do processo da aplicação. Na execução local com Bun, informe o endereço acessível do serviço da VPS. No contêiner, `localhost` identifica o próprio contêiner.

Se o serviço exigir Basic Auth, configure `GOTENBERG_USERNAME` e `GOTENBERG_PASSWORD`. A senha também pode ser fornecida pelo arquivo `/run/secrets/gotenberg_password`.

A aplicação envia o HTML e recebe o PDF por `POST /forms/chromium/convert/html`. O conteúdo fiscal necessário à renderização é enviado ao serviço configurado. Certificados e senhas dos certificados não são enviados.

### Puppeteer com Chromium local

```env
PDF_RENDERER=puppeteer
CHROMIUM_EXECUTABLE_PATH=C:/Program Files/Google/Chrome/Application/chrome.exe
```

Em Linux, informe o caminho do Chromium instalado. O projeto utiliza `puppeteer-core`; não baixa um navegador automaticamente. A aplicação continua sendo executada com `bun run dev` ou `bun run start`.

Nos dois Compose, `INSTALL_CHROMIUM=true` instala Chromium na construção da imagem. Configure `CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser`, reconstrua a imagem e ajuste `API_MEMORY_LIMIT` à memória necessária ao navegador. O isolamento do Chromium depende dos recursos de sandbox permitidos pelo host. Gotenberg é a opção padrão e dispensa Chromium na imagem da aplicação.

Executáveis gerados por `bun build --compile` também precisam de um serviço Gotenberg ou de um navegador externo, conforme a opção selecionada.

## Downloads

- **PDF individual:** gerado em memória, sem persistir o PDF em disco.
- **PDFs do mês:** ZIP com um PDF por nota de toda a competência da empresa, independentemente da página e dos demais filtros da listagem.
- **Todos os PDFs:** ZIP com um PDF por nota da empresa.

Os lotes são processados em segundo plano. Ao selecionar uma empresa, o painel recupera suas últimas 20 exportações, mesmo sem buscar as notas novamente. A lista mostra a competência, a data da solicitação, o progresso, as falhas e o prazo de disponibilidade. Você pode fechar a página e voltar para acompanhar o processamento ou baixar um pacote pronto enquanto ele estiver disponível. A geração é limitada a uma conversão por vez para controlar o consumo de memória.

O painel consulta a lista a cada 1,5 segundo enquanto há lotes em andamento e a cada 30 segundos nos demais casos. O botão **Atualizar** permite uma consulta imediata. Exportações com falha ou expiradas permanecem no histórico recente, sem botão de download. A API também disponibiliza a lista em `GET /api/notas/pdf/exportacoes?empresaId=<ID>` ou com `cnpj=<CNPJ>`.

Os arquivos de trabalho ficam em `PDF_TEMP_DIR`. Os PDFs intermediários são removidos depois da criação do ZIP. O ZIP é removido após o término ou interrupção da transferência e, caso não seja baixado, após o prazo configurado por `PDF_EXPORT_TTL_MS` (padrão: uma hora). Para repetir um download, solicite outro pacote. O servidor identifica o término do envio, sem confirmar o salvamento no dispositivo do usuário.

Se algumas notas falharem, a exportação recebe o status `PARTIAL` e inclui `falhas.json` no ZIP. Se todas falharem, recebe `FAILED`. Exportações interrompidas por reinicialização recebem `FAILED`; devem ser solicitadas novamente.

Notas canceladas ou substituídas são renderizadas a partir do XML original e do status consolidado dos eventos. Solicitações de cancelamento pendentes e indeferidas não cancelam a nota. Os XMLs originais permanecem preservados.

## Vínculo entre empresa e documento

O documento fiscal é compartilhado quando o mesmo XML é recebido por empresas diferentes. O vínculo de distribuição registra empresa, ambiente, NSU e documento. O NSU não é utilizado como identificador global da nota.

Os endpoints de notas exigem `empresaId` ou o CNPJ de uma empresa cadastrada. Detalhes, XML, PDF, ZIP individual e ZIP em lote verificam o vínculo com a empresa informada. Um CNPJ presente como participante no XML não cria automaticamente um novo vínculo de distribuição.

Na primeira inicialização após a atualização, a aplicação registra o conjunto de notas legadas. Ao cadastrar uma empresa, somente as notas desse conjunto em que ela consta como participante recebem um vínculo de origem `LEGADO`. Isso preserva a consulta de dados anteriores à implementação, mas não comprova qual CNPJ recebeu originalmente o documento. Novas sincronizações registram a origem `SINCRONIZACAO` e o NSU de distribuição explicitamente; cadastrar outra empresa posteriormente não cria vínculos com essas notas automaticamente.

Utilize um banco separado para homologação e produção. A inicialização registra o ambiente e rejeita a abertura do mesmo banco em outro ambiente. Os bancos legados assumem o ambiente configurado na primeira inicialização após a atualização. No SQLite, o caminho padrão já inclui o ambiente.

As filas de sincronização e exportação executam em uma única instância da aplicação. Os registros e resultados são persistentes, mas os workers e seus bloqueios são locais ao processo. Não execute várias instâncias contra o mesmo banco sem acrescentar coordenação distribuída.

## Variáveis adicionais

| Variável                   | Padrão                                            | Uso                                                  |
| :------------------------- | :------------------------------------------------ | :--------------------------------------------------- |
| `CERTIFICATES_DIR`         | `./certs`                                         | Pasta dos certificados no processo da aplicação.     |
| `CERTIFICATES_HOST_DIR`    | `./certs`                                         | Pasta do host montada pelos Compose.                 |
| `CERT_ENCRYPTION_KEY`      | vazio                                             | Chave hexadecimal de 64 caracteres para as senhas.   |
| `CERT_ENCRYPTION_KEY_FILE` | `/run/secrets/cert_encryption_key`                | Arquivo da chave de criptografia.                    |
| `PDF_RENDERER`             | `gotenberg`                                       | `gotenberg` ou `puppeteer`.                          |
| `GOTENBERG_URL`            | vazio                                             | Endereço do serviço Gotenberg existente.             |
| `GOTENBERG_USERNAME`       | vazio                                             | Usuário de Basic Auth, se necessário.                |
| `GOTENBERG_PASSWORD`       | vazio                                             | Senha de Basic Auth, se necessário.                  |
| `CHROMIUM_EXECUTABLE_PATH` | vazio                                             | Caminho do navegador para Puppeteer.                 |
| `PDF_TEMP_DIR`             | Pasta `nfse-pdf-exports` no temporário do sistema | Área de trabalho das exportações.                    |
| `PDF_TIMEOUT_MS`           | `60000`                                           | Tempo limite por conversão.                          |
| `PDF_EXPORT_TTL_MS`        | `3600000`                                         | Prazo de disponibilidade após concluir a exportação. |
| `INSTALL_CHROMIUM`         | `false`                                           | Argumento de build dos Compose.                      |
| `API_MEMORY_LIMIT`         | `512M`                                            | Limite de memória da API nos Compose.                |

O `.env.example` original é preservado. Acrescente ao seu `.env` somente as variáveis necessárias ao modo escolhido.

## Validação

A suíte `bun test src/tests` cobre SQLite e o repositório PostgreSQL com PostgreSQL embarcado (PGlite), sem utilizar dados de uma instância externa. O teste de navegador `bun run scripts/smoke-ui.ts` utiliza um banco SQLite em memória e configuração isolada de teste; ajuste `CHROMIUM_TEST_PATH` ao caminho do navegador instalado. Ele valida cadastro, autenticação, seleção de empresa e geração de PDFs reais. Capturas são gravadas em `scratch/`, ignorado pelo Git.

## Referências

- [Biblioteca de DANFSe](https://github.com/wedigibrasil/notaas-danfse)
- [Conversão de HTML pelo Gotenberg](https://gotenberg.dev/docs/convert-with-chromium/convert-html-to-pdf)
- [Geração de PDF com Puppeteer](https://pptr.dev/guides/pdf-generation)
- [Recebimento de arquivos multipart com Multer](https://expressjs.com/en/resources/middleware/multer/)
