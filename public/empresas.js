(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  let companies = [];
  let certificates = [];
  let companyId = null;
  let certificateId = null;

  async function api(path, options = {}) {
    const response = await window.NfseApi.request(path, options);
    const json = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(json.error || "Não foi possível concluir a operação.");
    return json.data;
  }

  function showError(id, message) {
    $(id).textContent = message;
    $(id).hidden = !message;
    if (message) $(id).focus();
  }

  async function load() {
    try {
      [companies, certificates] = await Promise.all([
        api("/api/empresas"),
        api("/api/certificados"),
      ]);
      $("companyRows").innerHTML =
        companies
          .map(
            (company) =>
              `<tr><td><strong>${esc(company.nome)}</strong><br><small>${esc(company.cnpj)}</small></td><td>${esc(company.certificado?.titular || "Sem certificado")}<br><small>${esc(company.certificado?.arquivo || "")}</small></td><td>${company.ativa ? "Ativa" : "Inativa"}</td><td><button class="btn btn-ghost" type="button" data-company="${esc(company.id)}">Editar</button></td></tr>`,
          )
          .join("") ||
        '<tr><td colspan="4">Nenhuma empresa cadastrada.</td></tr>';
      $("certificateRows").innerHTML =
        certificates
          .map(
            (certificate) =>
              `<tr><td><strong>${esc(certificate.titular)}</strong><br><small>${esc(certificate.arquivo)}</small></td><td>${new Date(certificate.validade).toLocaleDateString("pt-BR")}${Date.parse(certificate.validade) <= Date.now() ? " · Vencido" : ""}</td><td><button class="btn btn-ghost" type="button" data-certificate="${esc(certificate.id)}">Substituir / revalidar</button></td></tr>`,
          )
          .join("") ||
        '<tr><td colspan="3">Nenhum certificado cadastrado.</td></tr>';
      const selected = $("companyCertificate").value;
      $("companyCertificate").innerHTML =
        '<option value="">Sem certificado</option>' +
        certificates
          .map(
            (certificate) =>
              `<option value="${esc(certificate.id)}">${esc(certificate.titular)} — ${esc(certificate.arquivo)}</option>`,
          )
          .join("");
      $("companyCertificate").value = selected;
      showError("pageError", "");
    } catch (error) {
      showError("pageError", error.message);
    }
  }

  async function loadFiles() {
    try {
      const files = await api("/api/certificados/arquivos");
      const selected = $("certificateFile").value;
      $("certificateFile").innerHTML =
        '<option value="">Selecione um arquivo</option>' +
        files
          .map((file) => `<option value="${esc(file)}">${esc(file)}</option>`)
          .join("");
      $("certificateFile").value = selected;
      $("fileHelp").textContent = files.length
        ? "Selecione um arquivo A1 da pasta autorizada."
        : "Nenhum .pfx ou .p12 encontrado. Adicione os arquivos na pasta do servidor e atualize a lista.";
    } catch (error) {
      showError("certificateError", error.message);
    }
  }

  function resetCompany() {
    companyId = null;
    $("companyForm").reset();
    $("companyCnpj").disabled = false;
    $("companyFormTitle").textContent = "Cadastrar empresa";
    showError("companyError", "");
  }

  function resetCertificate() {
    certificateId = null;
    $("certificateForm").reset();
    updateCertificateSource();
    $("certificateSave").textContent = "Validar e cadastrar certificado";
    showError("certificateError", "");
  }

  function updateCertificateSource() {
    const upload = $("certificateSource").value === "upload";
    $("certificateUploadField").hidden = !upload;
    $("certificateUpload").disabled = !upload;
    $("certificateUpload").required = upload;
    $("certificateExistingField").hidden = upload;
    $("certificateFile").disabled = upload;
    $("certificateFile").required = !upload;
    $("reloadFiles").hidden = upload;
  }

  window.addEventListener("nfse:authchange", async () => {
    await load();
    await loadFiles();
  });
  $("companyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("companySave").disabled = true;
    $("companyFeedback").textContent = "Salvando empresa…";
    showError("companyError", "");
    try {
      await api(companyId ? `/api/empresas/${companyId}` : "/api/empresas", {
        method: companyId ? "PUT" : "POST",
        body: JSON.stringify({
          nome: $("companyName").value,
          cnpj: $("companyCnpj").value,
          ativa: $("companyActive").value === "true",
          certificado_id: $("companyCertificate").value || null,
        }),
      });
      resetCompany();
      await load();
      $("companyFeedback").textContent =
        "Empresa salva. Ela já está disponível no seletor de consulta.";
    } catch (error) {
      showError("companyError", error.message);
      $("companyFeedback").textContent = "";
    } finally {
      $("companySave").disabled = false;
    }
  });
  $("certificateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("certificateSave").disabled = true;
    $("certificateFeedback").textContent = "Validando certificado…";
    showError("certificateError", "");
    try {
      const uploading = $("certificateSource").value === "upload";
      const route = certificateId
        ? `/api/certificados/${certificateId}`
        : "/api/certificados";
      let body;
      if (uploading) {
        const file = $("certificateUpload").files[0];
        if (!file || !/\.(pfx|p12)$/i.test(file.name))
          throw new Error("Selecione um certificado .pfx ou .p12.");
        if (!file.size || file.size > 10 * 1024 * 1024)
          throw new Error("O certificado deve ser um arquivo de até 10 MB.");
        body = new FormData();
        body.append("arquivo", file);
        body.append("senha", $("certificatePassword").value);
      } else {
        body = JSON.stringify({
          arquivo: $("certificateFile").value,
          senha: $("certificatePassword").value,
        });
      }
      const certificate = await api(uploading ? `${route}/upload` : route, {
        method: certificateId ? "PUT" : "POST",
        body,
      });
      resetCertificate();
      await Promise.all([load(), loadFiles()]);
      $("companyCertificate").value = certificate.id;
      $("certificateFeedback").textContent =
        "Certificado validado e salvo. Selecione-o na empresa e salve o cadastro.";
    } catch (error) {
      showError("certificateError", error.message);
      $("certificateFeedback").textContent = "";
    } finally {
      $("certificatePassword").value = "";
      $("certificateSave").disabled = false;
    }
  });
  $("companyRows").addEventListener("click", (event) => {
    const id = event.target.closest("[data-company]")?.dataset.company;
    const company = companies.find((item) => item.id === id);
    if (!company) return;
    companyId = company.id;
    $("companyName").value = company.nome;
    $("companyCnpj").value = company.cnpj;
    $("companyCnpj").disabled = true;
    $("companyActive").value = String(Boolean(company.ativa));
    $("companyCertificate").value = company.certificado_id || "";
    $("companyFormTitle").textContent = "Editar empresa";
    $("companyName").focus();
  });
  $("certificateRows").addEventListener("click", (event) => {
    const id = event.target.closest("[data-certificate]")?.dataset.certificate;
    const certificate = certificates.find((item) => item.id === id);
    if (!certificate) return;
    certificateId = certificate.id;
    $("certificateSource").value = "existing";
    $("certificateUpload").value = "";
    updateCertificateSource();
    $("certificateFile").value = certificate.arquivo;
    $("certificatePassword").value = "";
    $("certificateSave").textContent = "Validar e atualizar certificado";
    $("certificateFile").focus();
  });
  $("companyReset").addEventListener("click", resetCompany);
  $("certificateReset").addEventListener("click", resetCertificate);
  $("certificateSource").addEventListener("change", updateCertificateSource);
  $("reloadFiles").addEventListener("click", loadFiles);
  $("companyCnpj").addEventListener("blur", () => {
    const field = $("companyCnpj");
    field.setCustomValidity(
      field.value && field.value.replace(/\D/g, "").length !== 14
        ? "Informe um CNPJ com 14 dígitos."
        : "",
    );
    if (!field.checkValidity()) field.reportValidity();
  });
  $("companyCnpj").addEventListener("input", () =>
    $("companyCnpj").setCustomValidity(""),
  );
  updateCertificateSource();
  load();
  loadFiles();
})();
