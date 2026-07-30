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
  setupCustomComboboxes();
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

// LÓGICA DE MÁQUINAS Y PRODUCTOS COMPATIBLE CON PANTALLAS TÁCTILES / TABLETS
function setupCustomComboboxes() {
  const inputMaq = document.getElementById('input-search-maquina');
  const dropMaq = document.getElementById('dropdown-maquina');
  
  const abrirMaq = (e) => {
    if(e) e.stopPropagation();
    renderComboboxOptions(inputMaq, dropMaq, maquinasCache, 'maquina');
  };
  inputMaq.addEventListener('focus', abrirMaq);
  inputMaq.addEventListener('click', abrirMaq);
  inputMaq.addEventListener('touchstart', abrirMaq);
  inputMaq.addEventListener('input', abrirMaq);

  const inputProd = document.getElementById('input-search-producto');
  const dropProd = document.getElementById('dropdown-producto');
  
  const abrirProd = (e) => {
    if(e) e.stopPropagation();
    renderComboboxOptions(inputProd, dropProd, productosCache, 'producto');
  };
  inputProd.addEventListener('focus', abrirProd);
  inputProd.addEventListener('click', abrirProd);
  inputProd.addEventListener('touchstart', abrirProd);
  inputProd.addEventListener('input', abrirProd);

  // Cerrar desplegables al tocar fuera
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.form-group')) {
      dropMaq.style.display = 'none';
      dropProd.style.display = 'none';
    }
  });
  document.addEventListener('touchstart', (e) => {
    if (!e.target.closest('.form-group')) {
      dropMaq.style.display = 'none';
      dropProd.style.display = 'none';
    }
  });
}

function renderComboboxOptions(inputEl, dropEl, data, tipo) {
  const filter = inputEl.value.toLowerCase().trim();
  dropEl.innerHTML = '';
  
  const matches = data.filter(item => 
    (item.id || '').toLowerCase().includes(filter) || 
    (item.nombre || '').toLowerCase().includes(filter)
  );

  if (matches.length === 0) {
    dropEl.innerHTML = `<div class="combobox-item" style="color:#94a3b8;">Sin coincidencias</div>`;
  } else {
    matches.forEach(item => {
      const div = document.createElement('div');
      div.className = 'combobox-item';
      const labelText = (item.nombre && item.nombre !== item.id) ? `${item.nombre} (${item.id})` : item.id;
      div.innerText = labelText;
      
      const seleccionarItem = (e) => {
        e.preventDefault();
        e.stopPropagation();
        inputEl.value = labelText;
        document.getElementById(`select-${tipo}`).value = item.id;
        inputEl.classList.remove('input-error');
        dropEl.style.display = 'none';

        if (tipo === 'producto') {
          actualizarFichaProducto(item.id);
        }
      };

      div.addEventListener('click', seleccionarItem);
      div.addEventListener('touchstart', seleccionarItem);
      dropEl.appendChild(div);
    });
  }
  dropEl.style.display = 'block';
}

function actualizarFichaProducto(prodId) {
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

  // Logout manual
  document.getElementById('btn-logout').addEventListener('click', () => {
    sessionStorage.removeItem('usuario_calidad');
    checkSession();
  });

  // CERRAR TURNO + GENERACIÓN DE PDFS + CIERRE AUTOMÁTICO DE SESIÓN
  document.getElementById('btn-cerrar-turno').addEventListener('click', async () => {
    const turno = obtenerTurnoAuto();
    const inspector = sessionStorage.getItem('usuario_calidad') || 'Inspector';

    if (!confirm(`¿Atención ${inspector}! ¿Deseas cerrar el ${turno}, generar los reportes PDF por máquina en Drive y finalizar tu sesión?`)) {
      return;
    }

    const btn = document.getElementById('btn-cerrar-turno');
    btn.disabled = true;
    btn.innerText = "Procesando y Cerrando...";

    try {
      const response = await fetch(GOOGLE_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'cerrarTurno', turnoActual: turno })
      });
      const res = await response.json();
      alert(`✅ ${res.message}\n\nTurno finalizado. Tu sesión se cerrará a continuación.`);
    } catch (err) {
      alert("✅ Proceso de Cierre de Turno enviado a Google Drive. Finalizando sesión...");
    }

    // Limpieza de formulario y cierre de sesión automático
    resetFormulario();
    sessionStorage.removeItem('usuario_calidad');
    checkSession(); // Redirige de inmediato al modal de inicio de sesión
  });

  // GUARDAR REGISTRO CON VALIDACIÓN ESTRICTA
  document.getElementById('btn-guardar-registro').addEventListener('click', async () => {
    const maquinaId = document.getElementById('select-maquina').value;
    const productoId = document.getElementById('select-producto').value;
    const inputMaq = document.getElementById('input-search-maquina');
    const inputProd = document.getElementById('input-search-producto');

    // 1. Validar Selección de Máquina y Producto
    if (!maquinaId) {
      alert("⚠️ Por favor selecciona una Máquina válida de la lista.");
      inputMaq.classList.add('input-error');
      inputMaq.focus();
      return;
    } else {
      inputMaq.classList.remove('input-error');
    }

    if (!productoId) {
      alert("⚠️ Por favor selecciona un Producto válido de la lista.");
      inputProd.classList.add('input-error');
      inputProd.focus();
      return;
    } else {
      inputProd.classList.remove('input-error');
    }

    // 2. VALIDACIÓN ESTRICTA DE LAS 6 MEDICIONES
    const medicionesDef = [
      { id: 'med-color', nombre: 'Color y Apariencia' },
      { id: 'med-espesor', nombre: 'Espesor de Pared' },
      { id: 'med-ciclo', nombre: 'Ciclo de Soplado/Inyección' },
      { id: 'med-peso', nombre: 'Peso del Producto' },
      { id: 'med-calce', nombre: 'Calce y Ajuste de Tapa' },
      { id: 'med-filtracion', nombre: 'Hermeticidad / Filtración' }
    ];

    let faltantes = [];
    let primerCampoErr = null;

    medicionesDef.forEach(m => {
      const el = document.getElementById(m.id);
      if (!el || !el.value.trim()) {
        el.classList.add('input-error');
        faltantes.push(m.nombre);
        if (!primerCampoErr) primerCampoErr = el;
      } else {
        el.classList.remove('input-error');
      }
    });

    if (faltantes.length > 0) {
      alert("⚠️ ATENCIÓN: No se puede guardar la inspección. Faltan completar las siguientes mediciones:\n\n• " + faltantes.join("\n• "));
      if (primerCampoErr) {
        primerCampoErr.focus();
        primerCampoErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    const btnGuardar = document.getElementById('btn-guardar-registro');
    btnGuardar.disabled = true;
    btnGuardar.innerText = "Guardando...";

    const exito = await enviarAGoogleSheets();

    if (exito) {
      alert("¡Registro guardado exitosamente!");
      resetFormulario();
      await loadCatalogData();
    }

    btnGuardar.disabled = false;
    btnGuardar.innerText = "💾 GUARDAR REGISTRO DE INSPECCIÓN";
  });

  document.getElementById('btn-qr').addEventListener('click', startQRScanner);
  document.getElementById('btn-close-qr').addEventListener('click', stopQRScanner);
  document.getElementById('btn-refresh-historial').addEventListener('click', loadCatalogData);
}

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

async function loadCatalogData() {
  try {
    const response = await fetch(GOOGLE_SCRIPT_URL);
    const data = await response.json();

    maquinasCache = data.maquinas || [];
    productosCache = data.productos || [];
    historialCache = data.historial || [];

    renderHistorialInspector();
  } catch (err) {
    console.error("Error al obtener datos:", err);
  }
}

function renderHistorialInspector() {
  const usuarioActual = (sessionStorage.getItem('usuario_calidad') || '').trim().toLowerCase();
  const tbody = document.getElementById('tabla-historial-body');

  if (!tbody) return;

  const misRegistros = historialCache.filter(item => 
    (item.inspector || '').trim().toLowerCase() === usuarioActual
  );

  if (misRegistros.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding: 20px;">No tienes registros guardados aún.</td></tr>`;
    return;
  }

  tbody.innerHTML = misRegistros.map(reg => `
    <tr>
      <td><strong>${reg.idInspeccion}</strong></td>
      <td>${reg.correlativo}</td>
      <td>${reg.fechaHora}</td>
      <td>${reg.turno}</td>
      <td>${reg.maquina}</td>
      <td>${reg.operario || '-'}</td>
      <td>${reg.producto}</td>
      <td>${reg.observaciones || '-'}</td>
    </tr>
  `).join('');
}

async function enviarAGoogleSheets() {
  const maquinaId = document.getElementById('select-maquina').value;
  const productoId = document.getElementById('select-producto').value;
  const inspectorActual = sessionStorage.getItem('usuario_calidad');

  const medColor = document.getElementById('med-color').value.trim();
  const medEspesor = document.getElementById('med-espesor').value.trim();
  const medCiclo = document.getElementById('med-ciclo').value.trim();
  const medPeso = document.getElementById('med-peso').value.trim();
  const medCalce = document.getElementById('med-calce').value.trim();
  const medFiltracion = document.getElementById('med-filtracion').value.trim();
  const obsUsuario = document.getElementById('input-observaciones').value.trim();

  const resumenMediciones = `[MEDICIONES -> Peso: ${medPeso} | Espesor: ${medEspesor} | Ciclo: ${medCiclo} | Color: ${medColor} | Calce: ${medCalce} | Leak: ${medFiltracion}]`;

  const payload = {
    turno: obtenerTurnoAuto(),
    inspector_calidad: inspectorActual,
    id_maquina: maquinaId,
    id_producto: productoId,
    operario: document.getElementById('input-operario').value,
    lote_mp: document.getElementById('input-lote-mp').value,
    lote_bxa: document.getElementById('input-lote-bxa').value,
    observaciones: `${obsUsuario} ${resumenMediciones}`.trim(),
    
    cavidad_molde: document.getElementById('input-cavidad').value,
    color: `${document.getElementById('val-color').value} (${medColor})`,
    espesor_pared: `${document.getElementById('val-espesor').value} (${medEspesor})`,
    ciclo: `${document.getElementById('val-ciclo').value} (${medCiclo})`,
    peso: `${document.getElementById('val-peso').value} (${medPeso})`,
    calce_ajuste: `${document.getElementById('val-calce').value} (${medCalce})`,
    filtracion: `${document.getElementById('val-filtracion').value} (${medFiltracion})`
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
    alert("Error de conexión al guardar.");
    return false;
  }
}

function resetFormulario() {
  document.querySelectorAll('input:not([type="hidden"]):not(#input-cavidad):not(#input-turno), textarea').forEach(el => {
    el.value = '';
    el.classList.remove('input-error');
  });
  
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
      const match = maquinasCache.find(m => m.id === decodedText || (m.nombre && m.nombre.toLowerCase().includes(decodedText.toLowerCase())));
      if (match) {
        document.getElementById('select-maquina').value = match.id;
        document.getElementById('input-search-maquina').value = match.nombre ? `${match.nombre} (${match.id})` : match.id;
        document.getElementById('input-search-maquina').classList.remove('input-error');
      } else {
        document.getElementById('select-maquina').value = decodedText;
        document.getElementById('input-search-maquina').value = decodedText;
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
