// REGISTRO DE SERVICE WORKER
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.log('Error SW:', err));
}

// ⚠️ PEGA AQUÍ TU URL DESPLEGADA DE GOOGLE APPS SCRIPT
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxsjzw8hWWDvn7DTJBfRRVyCFtXyB2iP__NmGodyAOj3EJvdNozTQ-vUZW79RuiWryQIQ/exec';

let productosCache = [];
let maquinasCache = [];
let historialCache = [];
let html5QrCode = null;

document.addEventListener('DOMContentLoaded', () => {
  checkSession();
  setupNavigation();
  setupEventListeners();
  setupToggles();
  actualizarTurnoAuto();
});

function obtenerTurnoAuto() {
  const hora = new Date().getHours();
  return (hora >= 8 && hora < 20) ? "Turno Mañana" : "Turno Noche";
}

function actualizarTurnoAuto() {
  const inputTurno = document.getElementById('input-turno');
  const turnoHeader = document.getElementById('turno-header-badge');
  const turnoActual = obtenerTurnoAuto();
  
  if (inputTurno) inputTurno.value = turnoActual;
  if (turnoHeader) turnoHeader.innerText = turnoActual;
}

function checkSession() {
  const usuario = sessionStorage.getItem('usuario_calidad');
  const modal = document.getElementById('login-modal');
  const appContent = document.getElementById('app-content');
  const userDisplay = document.getElementById('user-display');

  if (!usuario) {
    modal.style.display = 'flex';
    appContent.style.display = 'none';
    
    document.getElementById('login-inspector').value = '';
    document.getElementById('login-pin').value = '';
    document.getElementById('login-error').style.display = 'none';
  } else {
    modal.style.display = 'none';
    appContent.style.display = 'block';
    userDisplay.innerText = `Inspector: ${usuario}`;
    
    loadCatalogData();
  }
}

function setupNavigation() {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
      
      tab.classList.add('active');
      const targetView = document.getElementById(tab.dataset.target);
      if (targetView) targetView.classList.add('active');

      if (tab.dataset.target === 'view-historial') {
        renderHistorialInspector();
      }
    });
  });
}

function setupEventListeners() {
  document.getElementById('btn-login').addEventListener('click', () => {
    const userSelect = document.getElementById('login-inspector').value;
    const pin = document.getElementById('login-pin').value;

    if (!userSelect) {
      document.getElementById('login-error').innerText = '⚠️ Debes seleccionar un inspector.';
      document.getElementById('login-error').style.display = 'block';
      return;
    }

    if (pin === '1234' || pin === '0000') {
      sessionStorage.setItem('usuario_calidad', userSelect);
      document.getElementById('login-error').style.display = 'none';
      checkSession();
    } else {
      document.getElementById('login-error').innerText = '⚠️ PIN incorrecto.';
      document.getElementById('login-error').style.display = 'block';
    }
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    sessionStorage.removeItem('usuario_calidad');
    checkSession();
  });

  document.getElementById('select-producto').addEventListener('change', (e) => {
    const selected = productosCache.find(p => p.id === e.target.value);
    const banner = document.getElementById('specs-banner');

    if (selected) {
      document.getElementById('spec-color').innerText = selected.color || 'Estándar';
      document.getElementById('spec-peso').innerText = selected.peso || 'Estándar';
      document.getElementById('spec-ciclo').innerText = selected.ciclo || 'Estándar';
      document.getElementById('spec-diametros').innerText = `${selected.diametroHilo || '-'} / ${selected.diametroInterior || '-'}`;
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  });

  document.getElementById('btn-qr').addEventListener('click', startQRScanner);
  document.getElementById('btn-close-qr').addEventListener('click', stopQRScanner);

  // ACCIÓN PRINCIPAL: GUARDAR DATOS + RESPALDAR PDF EN DRIVE + IMPRIMIR/DESCARGAR
  document.getElementById('btn-imprimir-pdf').addEventListener('click', async () => {
    const maquina = document.getElementById('select-maquina').value;
    const producto = document.getElementById('select-producto').value;

    if (!maquina || !producto) {
      alert("Por favor selecciona Máquina y Producto antes de generar el reporte.");
      return;
    }

    const btnPDF = document.getElementById('btn-imprimir-pdf');
    btnPDF.disabled = true;
    btnPDF.innerText = "Guardando en Drive y procesando...";

    // 1. Generar representación Base64 del PDF
    const pdfBase64 = await obtenerPDFBase64();

    // 2. Enviar a Google Sheets y Google Drive
    const exito = await enviarAGoogleSheets(pdfBase64);

    if (exito) {
      // 3. Descargar copia local para impresión
      generarReportePDF();
      alert("¡Registro guardado en Google Sheets y PDF respaldado en Google Drive!");
      resetFormulario();
      loadCatalogData();
    }

    btnPDF.disabled = false;
    btnPDF.innerText = "📄 GENERAR / IMPRIMIR PDF Y GUARDAR REGISTRO";
  });

  document.getElementById('btn-refresh-historial').addEventListener('click', loadCatalogData);
}

function setupToggles() {
  document.querySelectorAll('.btn-toggle').forEach(btn => {
    btn.onclick = function(e) {
      e.preventDefault();
      const targetInput = document.getElementById(this.dataset.target);
      
      if (this.classList.contains('active-cumple')) {
        this.classList.remove('active-cumple');
        this.classList.add('active-nocumple');
        this.innerText = 'No Cumple';
        if (targetInput) targetInput.value = 'No Cumple';
      } else {
        this.classList.remove('active-nocumple');
        this.classList.add('active-cumple');
        this.innerText = 'Cumple';
        if (targetInput) targetInput.value = 'Cumple';
      }
    };
  });
}

// CONVIERTE LA PANTALLA EN UN STRING DE BASE64
async function obtenerPDFBase64() {
  const element = document.getElementById('view-formulario');
  const opt = {
    margin:       0.3,
    filename:     'reporte.pdf',
    image:        { type: 'jpeg', quality: 0.95 },
    html2canvas:  { scale: 2, useCORS: true },
    jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
  };
  
  return await html2pdf().set(opt).from(element).outputPdf('datauristring');
}

function generarReportePDF() {
  const element = document.getElementById('view-formulario');
  const maquina = document.getElementById('select-maquina').value || 'SinMaquina';
  const fecha = new Date().toISOString().slice(0, 10);

  const opt = {
    margin:       0.3,
    filename:     `Inspeccion_${maquina}_${fecha}.pdf`,
    image:        { type: 'jpeg', quality: 0.98 },
    html2canvas:  { scale: 2, useCORS: true },
    jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
  };

  html2pdf().set(opt).from(element).save();
}

async function loadCatalogData() {
  try {
    const response = await fetch(GOOGLE_SCRIPT_URL);
    const data = await response.json();

    maquinasCache = data.maquinas || [];
    productosCache = data.productos || [];
    historialCache = data.historial || [];

    const selectMaq = document.getElementById('select-maquina');
    selectMaq.innerHTML = '<option value="">-- Seleccionar Máquina --</option>';
    maquinasCache.forEach(m => {
      selectMaq.innerHTML += `<option value="${m.id}">${m.nombre} (${m.estado})</option>`;
    });

    const selectProd = document.getElementById('select-producto');
    selectProd.innerHTML = '<option value="">-- Seleccionar Producto --</option>';
    productosCache.forEach(p => {
      selectProd.innerHTML += `<option value="${p.id}">${p.nombre} (${p.id})</option>`;
    });

  } catch (err) {
    console.error("Error al obtener datos desde Google Sheets:", err);
  }
}

function renderHistorialInspector() {
  const usuarioActual = sessionStorage.getItem('usuario_calidad');
  const tbody = document.getElementById('tabla-historial-body');

  if (!tbody) return;

  const misRegistros = historialCache.filter(item => item.inspector === usuarioActual);

  if (misRegistros.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding: 20px;">No tienes registros guardados aún.</td></tr>`;
    return;
  }

  tbody.innerHTML = misRegistros.map(reg => `
    <tr>
      <td><strong>${reg.idInspeccion}</strong></td>
      <td>${reg.correlativo}</td>
      <td>${reg.fechaHora}</td>
      <td>${reg.turno}</td>
      <td>${reg.maquina}</td>
      <td>${reg.producto}</td>
      <td>${reg.observaciones || '-'}</td>
    </tr>
  `).join('');
}

async function enviarAGoogleSheets(pdfBase64Data) {
  const maquina = document.getElementById('select-maquina').value;
  const producto = document.getElementById('select-producto').value;
  const inspectorActual = sessionStorage.getItem('usuario_calidad');

  if (!inspectorActual) {
    alert("Sesión no identificada. Por favor inicia sesión.");
    checkSession();
    return false;
  }

  const medColor = document.getElementById('med-color').value;
  const medEspesor = document.getElementById('med-espesor').value;
  const medCiclo = document.getElementById('med-ciclo').value;
  const medPeso = document.getElementById('med-peso').value;
  const medCalce = document.getElementById('med-calce').value;
  const medFiltracion = document.getElementById('med-filtracion').value;
  const obsUsuario = document.getElementById('input-observaciones').value;

  const resumenMediciones = `[MEDICIONES -> Peso: ${medPeso||'-'} | Espesor: ${medEspesor||'-'} | Ciclo: ${medCiclo||'-'} | Color: ${medColor||'-'} | Calce: ${medCalce||'-'} | Leak: ${medFiltracion||'-'}]`;

  const payload = {
    turno: obtenerTurnoAuto(),
    inspector_calidad: inspectorActual,
    id_maquina: maquina,
    id_producto: producto,
    lote_mp: document.getElementById('input-lote-mp').value,
    lote_bxa: document.getElementById('input-lote-bxa').value,
    observaciones: `${obsUsuario} ${resumenMediciones}`.trim(),
    pdfBase64: pdfBase64Data || null,
    
    cavidad_molde: document.getElementById('input-cavidad').value,
    color: `${document.getElementById('val-color').value} (${medColor || 'S/D'})`,
    espesor_pared: `${document.getElementById('val-espesor').value} (${medEspesor || 'S/D'})`,
    ciclo: `${document.getElementById('val-ciclo').value} (${medCiclo || 'S/D'})`,
    peso: `${document.getElementById('val-peso').value} (${medPeso || 'S/D'})`,
    calce_ajuste: `${document.getElementById('val-calce').value} (${medCalce || 'S/D'})`,
    filtracion: `${document.getElementById('val-filtracion').value} (${medFiltracion || 'S/D'})`
  };

  try {
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
    return true;
  } catch (err) {
    console.error("Error al enviar a Google Sheets / Drive:", err);
    alert("Error de conexión al guardar.");
    return false;
  }
}

function resetFormulario() {
  document.querySelectorAll('input:not([type="hidden"]):not(#input-cavidad):not(#input-turno), textarea').forEach(el => el.value = '');
  document.getElementById('select-maquina').value = '';
  document.getElementById('select-producto').value = '';
  document.getElementById('specs-banner').style.display = 'none';
  
  document.querySelectorAll('.btn-toggle').forEach(btn => {
    btn.innerText = 'Cumple';
    btn.className = 'btn-toggle active-cumple';
    const targetHidden = document.getElementById(btn.dataset.target);
    if (targetHidden) targetHidden.value = 'Cumple';
  });

  actualizarTurnoAuto();
}

function startQRScanner() {
  document.getElementById('qr-modal').style.display = 'flex';
  html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 220, height: 220 } },
    (decodedText) => {
      const selectMaq = document.getElementById('select-maquina');
      for (let i = 0; i < selectMaq.options.length; i++) {
        if (selectMaq.options[i].value === decodedText || selectMaq.options[i].text.includes(decodedText)) {
          selectMaq.selectedIndex = i;
          break;
        }
      }
      stopQRScanner();
    },
    () => {}
  ).catch(err => console.log("Error al iniciar cámara QR:", err));
}

function stopQRScanner() {
  if (html5QrCode) {
    html5QrCode.stop().then(() => {
      document.getElementById('qr-modal').style.display = 'none';
    }).catch(() => {
      document.getElementById('qr-modal').style.display = 'none';
    });
  } else {
    document.getElementById('qr-modal').style.display = 'none';
  }
}
