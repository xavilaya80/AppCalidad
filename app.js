// REGISTRO DE SERVICE WORKER PARA PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(err => console.log('Error SW:', err));
}

// ⚠️ PEGA AQUÍ TU URL DESPLEGADA DE GOOGLE APPS SCRIPT
const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxsjzw8hWWDvn7DTJBfRRVyCFtXyB2iP__NmGodyAOj3EJvdNozTQ-vUZW79RuiWryQIQ/exec';

// ESTADO LOCAL
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

// 1. DETECCIÓN AUTOMÁTICA DE TURNO (08:00 a 20:00 = Mañana, 20:00 a 08:00 = Noche)
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

// 2. VERIFICACIÓN Y BLOQUEO DE SESIÓN (SOLO INSPECTORES)
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

// 3. NAVEGACIÓN ENTRE PESTAÑAS
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

// 4. CONFIGURACIÓN DE EVENTOS Y BOTONES
function setupEventListeners() {
  // Login de Inspectores
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

  // Logout
  document.getElementById('btn-logout').addEventListener('click', () => {
    sessionStorage.removeItem('usuario_calidad');
    checkSession();
  });

  // Ficha técnica dinámica
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

  // QR Scanner
  document.getElementById('btn-qr').addEventListener('click', startQRScanner);
  document.getElementById('btn-close-qr').addEventListener('click', stopQRScanner);

  // ACCIÓN PRINCIPAL: GUARDAR EN GOOGLE SHEETS + RESPALDAR PDF EN DRIVE + DESCARGAR/IMPRIMIR
  document.getElementById('btn-imprimir-pdf').addEventListener('click', async () => {
    const maquina = document.getElementById('select-maquina').value;
    const producto = document.getElementById('select-producto').value;

    if (!maquina || !producto) {
      alert("Por favor selecciona Máquina y Producto antes de generar el reporte.");
      return;
    }

    const btnPDF = document.getElementById('btn-imprimir-pdf');
    btnPDF.disabled = true;
    btnPDF.innerText = "Procesando PDF y Guardando...";

    // 1. Generar Base64 del PDF desde la plantilla limpia
    const pdfBase64 = await obtenerPDFBase64();

    // 2. Enviar datos a Google Sheets y Drive
    const exito = await enviarAGoogleSheets(pdfBase64);

    if (exito) {
      // 3. Descargar copia local limpia en la tablet
      generarReportePDF();
      
      // 4. Pausa de 2.5 segundos para que Google Sheets termine de escribir la fila
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      alert("¡Registro guardado en Google Sheets, PDF respaldado en Drive e Historial actualizado!");
      resetFormulario();
      await loadCatalogData(); // Recarga catálogo e historial actualizado desde Sheets
    }

    btnPDF.disabled = false;
    btnPDF.innerText = "📄 GENERAR / IMPRIMIR PDF Y GUARDAR REGISTRO";
  });

  // Refrescar Historial manualmente
  document.getElementById('btn-refresh-historial').addEventListener('click', loadCatalogData);
}

// 5. BOTONES TOGGLE CUMPLE / NO CUMPLE
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

// 6. PLANTILLA Y GENERACIÓN DE PDF LIMPIO EN 1 PÁGINA
function crearElementoPDF() {
  const inspector = sessionStorage.getItem('usuario_calidad') || '---';
  const maquinaSelect = document.getElementById('select-maquina');
  const maquinaText = maquinaSelect.options[maquinaSelect.selectedIndex]?.text || '-';
  const productoSelect = document.getElementById('select-producto');
  const productoText = productoSelect.options[productoSelect.selectedIndex]?.text || '-';
  const turno = document.getElementById('input-turno').value || '-';
  const cavidad = document.getElementById('input-cavidad').value || '-';
  const loteMp = document.getElementById('input-lote-mp').value || '-';
  const loteBxa = document.getElementById('input-lote-bxa').value || '-';
  const obs = document.getElementById('input-observaciones').value || 'Sin observaciones.';
  const fechaHora = new Date().toLocaleString('es-CL');

  const specColor = document.getElementById('spec-color').innerText;
  const specPeso = document.getElementById('spec-peso').innerText;
  const specCiclo = document.getElementById('spec-ciclo').innerText;
  const specDiam = document.getElementById('spec-diametros').innerText;

  const items = [
    { label: 'Color y Apariencia', med: document.getElementById('med-color').value || 'Sin detalle', val: document.getElementById('val-color').value },
    { label: 'Espesor de Pared', med: document.getElementById('med-espesor').value || 'Sin detalle', val: document.getElementById('val-espesor').value },
    { label: 'Ciclo de Soplado', med: document.getElementById('med-ciclo').value || 'Sin detalle', val: document.getElementById('val-ciclo').value },
    { label: 'Peso del Producto', med: document.getElementById('med-peso').value || 'Sin detalle', val: document.getElementById('val-peso').value },
    { label: 'Calce y Ajuste de Tapa', med: document.getElementById('med-calce').value || 'Sin detalle', val: document.getElementById('val-calce').value },
    { label: 'Hermeticidad / Filtración', med: document.getElementById('med-filtracion').value || 'Sin detalle', val: document.getElementById('val-filtracion').value },
  ];

  const container = document.createElement('div');
  container.style.padding = '24px';
  container.style.fontFamily = "Arial, sans-serif";
  container.style.color = '#0f172a';
  container.style.backgroundColor = '#ffffff';
  container.style.width = '700px';

  container.innerHTML = `
    <div style="border-bottom: 3px solid #0284c7; padding-bottom: 10px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;">
      <div>
        <h1 style="font-size: 16px; color: #0f172a; margin: 0;">CONTROL DE CALIDAD - INSPECCIONES EN PROCESO</h1>
        <span style="font-size: 11px; color: #0284c7; font-weight: bold;">REPORTE OFICIAL DE PLANTA DE MOLDEO</span>
      </div>
      <div style="text-align: right; font-size: 10px; color: #475569;">
        <div><strong>Inspector:</strong> ${inspector}</div>
        <div><strong>Fecha:</strong> ${fechaHora}</div>
        <div><strong>Turno:</strong> ${turno}</div>
      </div>
    </div>

    <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px; margin-bottom: 15px;">
      <h3 style="font-size: 12px; margin: 0 0 6px 0; color: #1e293b; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px;">1. Datos de Proceso e Inspección</h3>
      <table style="width: 100%; font-size: 10px; border-collapse: collapse;">
        <tr>
          <td style="padding: 3px; width: 50%;"><strong>Máquina:</strong> ${maquinaText}</td>
          <td style="padding: 3px; width: 50%;"><strong>Producto:</strong> ${productoText}</td>
        </tr>
        <tr>
          <td style="padding: 3px;"><strong>Cavidad / Molde N°:</strong> ${cavidad}</td>
          <td style="padding: 3px;"><strong>Lote MP:</strong> ${loteMp}</td>
        </tr>
        <tr>
          <td style="padding: 3px;"><strong>Lote BXA:</strong> ${loteBxa}</td>
          <td style="padding: 3px;"><strong>Estándares:</strong> C: ${specColor} | P: ${specPeso} | Sec: ${specCiclo} | Ø: ${specDiam}</td>
        </tr>
      </table>
    </div>

    <div style="margin-bottom: 15px;">
      <h3 style="font-size: 12px; margin: 0 0 6px 0; color: #1e293b; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px;">2. Cumplimiento de Especificaciones y Mediciones</h3>
      <table style="width: 100%; font-size: 10px; border-collapse: collapse; border: 1px solid #cbd5e1;">
        <thead>
          <tr style="background: #0f172a; color: white;">
            <th style="padding: 5px; text-align: left;">Parámetro Evaluado</th>
            <th style="padding: 5px; text-align: left;">Medición Obtenida</th>
            <th style="padding: 5px; text-align: center; width: 90px;">Estado</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(item => `
            <tr style="border-bottom: 1px solid #e2e8f0;">
              <td style="padding: 5px; font-weight: bold;">${item.label}</td>
              <td style="padding: 5px;">${item.med}</td>
              <td style="padding: 5px; text-align: center;">
                <span style="display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: bold; color: white; background-color: ${item.val === 'Cumple' ? '#15803d' : '#b91c1c'};">
                  ${item.val.toUpperCase()}
                </span>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px;">
      <h3 style="font-size: 12px; margin: 0 0 4px 0; color: #1e293b;">3. Observaciones Adicionales</h3>
      <p style="font-size: 10px; margin: 0; color: #334155; white-space: pre-wrap;">${obs}</p>
    </div>
  `;

  return container;
}

async function obtenerPDFBase64() {
  const element = crearElementoPDF();
  document.body.appendChild(element);

  const opt = {
    margin:       0.2,
    filename:     'reporte.pdf',
    image:        { type: 'jpeg', quality: 0.98 },
    html2canvas:  { scale: 2, useCORS: true },
    jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
  };
  
  const base64 = await html2pdf().set(opt).from(element).outputPdf('datauristring');
  document.body.removeChild(element);
  return base64;
}

function generarReportePDF() {
  const element = crearElementoPDF();
  document.body.appendChild(element);

  const maquinaSelect = document.getElementById('select-maquina');
  const maquinaText = maquinaSelect.options[maquinaSelect.selectedIndex]?.text || 'MAQ';
  const fecha = new Date().toISOString().slice(0, 10);

  const opt = {
    margin:       0.2,
    filename:     `Inspeccion_${maquinaText.replace(/[^a-zA-Z0-9]/g, '_')}_${fecha}.pdf`,
    image:        { type: 'jpeg', quality: 0.98 },
    html2canvas:  { scale: 2, useCORS: true },
    jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
  };

  html2pdf().set(opt).from(element).save().then(() => {
    document.body.removeChild(element);
  });
}

// 7. CARGA DE CATÁLOGOS E HISTORIAL DESDE GOOGLE SHEETS
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

    // Actualizar la tabla de historial si está activa
    renderHistorialInspector();

  } catch (err) {
    console.error("Error al obtener datos desde Google Sheets:", err);
  }
}

// 8. RENDERIZAR HISTORIAL FILTRADO POR INSPECTOR LOGUEADO
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

// 9. ENVÍO DE DATOS A GOOGLE SHEETS Y DRIVE
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

// 10. LIMPIAR FORMULARIO
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

// 11. ESCÁNER QR NATIVO
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
