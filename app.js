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

// 1. DETECCIÓN AUTOMÁTICA DE TURNO
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

// 2. VERIFICACIÓN Y BLOQUEO DE SESIÓN
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

// 4. CONFIGURACIÓN DE EVENTOS GENERALES
function setupEventListeners() {
  // Login
  document.getElementById('btn-login').addEventListener('click', () => {
    const userSelect = document.getElementById('login-inspector').value;
    const pin = document.getElementById('login-pin').value;

    if (!userSelect) {
      document.getElementById('login-error').innerText = '⚠️ Debes seleccionar un inspector.';
      document.getElementById('login-error').style.display = 'block';
      return;
    }

    if (pin === '1234' || pin === '0000') {
      sessionStorage.setItem('usuario_calidad', userSelect.trim());
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

  // Ficha técnica dinámica al seleccionar/escribir producto
  const inputProd = document.getElementById('select-producto');
  inputProd.addEventListener('input', () => actualizarFichaProducto());
  inputProd.addEventListener('change', () => actualizarFichaProducto());

  // Escáner QR
  document.getElementById('btn-qr').addEventListener('click', startQRScanner);
  document.getElementById('btn-close-qr').addEventListener('click', stopQRScanner);

  // ACCIÓN PRINCIPAL: GUARDAR + PDF EN DRIVE + COPIA LOCAL
  const btnGuardar = document.getElementById('btn-imprimir-pdf') || document.getElementById('btn-guardar-registro');
  if (btnGuardar) {
    btnGuardar.addEventListener('click', async () => {
      const maquinaVal = obtenerValorMaquina();
      const productoVal = obtenerValorProducto();

      if (!maquinaVal || !productoVal) {
        alert("Por favor selecciona o escribe Máquina y Producto válidos.");
        return;
      }

      btnGuardar.disabled = true;
      btnGuardar.innerText = "Procesando PDF y Guardando...";

      // 1. Generar Base64 del PDF desde la plantilla HTML limpia
      const pdfBase64 = await obtenerPDFBase64();

      // 2. Enviar a Google Sheets y Drive
      const exito = await enviarAGoogleSheets(pdfBase64);

      if (exito) {
        // 3. Descargar copia local
        generarReportePDF();
        
        // 4. Pausa para sincronización de base de datos
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        alert("¡Registro guardado en Google Sheets, PDF en Drive e Historial actualizado!");
        resetFormulario();
        await loadCatalogData();
      }

      btnGuardar.disabled = false;
      btnGuardar.innerText = "📄 GENERAR / IMPRIMIR PDF Y GUARDAR REGISTRO";
    });
  }

  // Refrescar Historial
  document.getElementById('btn-refresh-historial').addEventListener('click', loadCatalogData);
}

// 5. HELPER PARA OBTENER VALORES DE LOS CAMPOS DATALIST
function obtenerValorMaquina() {
  const val = document.getElementById('select-maquina').value.trim();
  const match = maquinasCache.find(m => m.id === val || (m.nombre && m.nombre === val) || `${m.nombre} (${m.id})` === val);
  return match ? match.id : val;
}

function obtenerTextoMaquina() {
  const val = document.getElementById('select-maquina').value.trim();
  const match = maquinasCache.find(m => m.id === val || (m.nombre && m.nombre === val) || `${m.nombre} (${m.id})` === val);
  return match ? (match.nombre ? `${match.nombre} (${match.id})` : match.id) : val;
}

function obtenerValorProducto() {
  const val = document.getElementById('select-producto').value.trim();
  const match = productosCache.find(p => p.id === val || (p.nombre && p.nombre === val) || `${p.nombre} (${p.id})` === val);
  return match ? match.id : val;
}

function obtenerTextoProducto() {
  const val = document.getElementById('select-producto').value.trim();
  const match = productosCache.find(p => p.id === val || (p.nombre && p.nombre === val) || `${p.nombre} (${p.id})` === val);
  return match ? (match.nombre ? `${match.nombre} (${match.id})` : match.id) : val;
}

function actualizarFichaProducto() {
  const prodId = obtenerValorProducto();
  const selected = productosCache.find(p => p.id === prodId);
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
}

// 6. BOTONES TOGGLE CUMPLE / NO CUMPLE (DELEGACIÓN GLOBAL)
function setupToggles() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-toggle');
    if (!btn) return;

    e.preventDefault();
    const targetInput = document.getElementById(btn.dataset.target);

    if (btn.classList.contains('active-cumple')) {
      btn.classList.remove('active-cumple');
      btn.classList.add('active-nocumple');
      btn.innerText = 'No Cumple';
      if (targetInput) targetInput.value = 'No Cumple';
    } else {
      btn.classList.remove('active-nocumple');
      btn.classList.add('active-cumple');
      btn.innerText = 'Cumple';
      if (targetInput) targetInput.value = 'Cumple';
    }
  });
}

// 7. PLANTILLA PDF LIMPIA EN 1 PÁGINA
function crearElementoPDF() {
  const inspector = sessionStorage.getItem('usuario_calidad') || '---';
  const maquinaText = obtenerTextoMaquina() || '-';
  const productoText = obtenerTextoProducto() || '-';
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
    { label: 'Ciclo de Soplado/Inyección', med: document.getElementById('med-ciclo').value || 'Sin detalle', val: document.getElementById('val-ciclo').value },
    { label: 'Peso del Producto', med: document.getElementById('med-peso').value || 'Sin detalle', val: document.getElementById('val-peso').value },
    { label: 'Calce y Ajuste de Tapa', med: document.getElementById('med-calce').value || 'Sin detalle', val: document.getElementById('val-calce').value },
    { label: 'Hermeticidad / Filtración', med: document.getElementById('med-filtracion').value || 'Sin detalle', val: document.getElementById('val-filtracion').value },
  ];

  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.left = '0';
  container.style.zIndex = '99999';
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

  await new Promise(r => setTimeout(r, 150));

  const opt = {
    margin:       0.2,
    filename:     'reporte.pdf',
    image:        { type: 'jpeg', quality: 0.85 },
    html2canvas:  { scale: 1.5, useCORS: true, scrollX: 0, scrollY: 0 },
    jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
  };
  
  const base64 = await html2pdf().set(opt).from(element).outputPdf('datauristring');
  document.body.removeChild(element);
  return base64;
}

function generarReportePDF() {
  const element = crearElementoPDF();
  document.body.appendChild(element);

  const maquinaText = obtenerValorMaquina() || 'MAQ';
  const fecha = new Date().toISOString().slice(0, 10);

  const opt = {
    margin:       0.2,
    filename:     `Inspeccion_${maquinaText.replace(/[^a-zA-Z0-9]/g, '_')}_${fecha}.pdf`,
    image:        { type: 'jpeg', quality: 0.85 },
    html2canvas:  { scale: 1.5, useCORS: true, scrollX: 0, scrollY: 0 },
    jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
  };

  html2pdf().set(opt).from(element).save().then(() => {
    if (document.body.contains(element)) {
      document.body.removeChild(element);
    }
  });
}

// 8. CARGA DE CATÁLOGOS E HISTORIAL DESDE GOOGLE SHEETS
async function loadCatalogData() {
  try {
    const response = await fetch(GOOGLE_SCRIPT_URL);
    const data = await response.json();

    maquinasCache = data.maquinas || [];
    productosCache = data.productos || [];
    historialCache = data.historial || [];

    // Poblar datalist de Máquinas
    const dlMaq = document.getElementById('lista-maquinas');
    if (dlMaq) {
      dlMaq.innerHTML = maquinasCache.map(m => {
        const txt = (m.nombre && m.nombre !== m.id) ? `${m.nombre} (${m.id})` : m.id;
        return `<option value="${m.id}">${txt}</option>`;
      }).join('');
    }

    // Poblar datalist de Productos
    const dlProd = document.getElementById('lista-productos');
    if (dlProd) {
      dlProd.innerHTML = productosCache.map(p => {
        const txt = (p.nombre && p.nombre !== p.id) ? `${p.nombre} (${p.id})` : p.id;
        return `<option value="${p.id}">${txt}</option>`;
      }).join('');
    }

    renderHistorialInspector();

  } catch (err) {
    console.error("Error al obtener datos desde Google Sheets:", err);
  }
}

// 9. RENDERIZAR HISTORIAL
function renderHistorialInspector() {
  const usuarioActual = (sessionStorage.getItem('usuario_calidad') || '').trim().toLowerCase();
  const tbody = document.getElementById('tabla-historial-body');

  if (!tbody) return;

  const misRegistros = historialCache.filter(item => 
    (item.inspector || '').trim().toLowerCase() === usuarioActual
  );

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

// 10. ENVÍO DE DATOS A GOOGLE SHEETS
async function enviarAGoogleSheets(pdfBase64Data) {
  const maquinaId = obtenerValorMaquina();
  const productoId = obtenerValorProducto();
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
    id_maquina: maquinaId,
    id_producto: productoId,
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

// 11. LIMPIAR FORMULARIO
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

// 12. ESCÁNER QR
function startQRScanner() {
  document.getElementById('qr-modal').style.display = 'flex';
  html5QrCode = new Html5Qrcode("reader");
  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 220, height: 220 } },
    (decodedText) => {
      document.getElementById('select-maquina').value = decodedText;
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
