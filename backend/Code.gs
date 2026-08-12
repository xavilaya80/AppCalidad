const TZ_SANTIAGO = "America/Santiago";

function getInfoTurnoOperativo(fechaObj) {
  var d = fechaObj ? new Date(fechaObj) : new Date();
  var hora = Number(Utilities.formatDate(d, TZ_SANTIAGO, "HH"));
  var turno = (hora >= 8 && hora < 20) ? "Turno Mañana" : "Turno Noche";

  var fechaOperativa = new Date(d.getTime());
  if (hora < 8) {
    fechaOperativa.setDate(fechaOperativa.getDate() - 1);
  }

  return {
    turno: turno,
    fechaOperativa: Utilities.formatDate(fechaOperativa, TZ_SANTIAGO, "yyyy-MM-dd"),
    horaExacta: Utilities.formatDate(d, TZ_SANTIAGO, "HH:mm:ss"),
    fechaHoraCompleta: Utilities.formatDate(d, TZ_SANTIAGO, "yyyy-MM-dd HH:mm:ss")
  };
}

/*
 * Columnas de "Inspecciones_Cabecera" (0-indexado, tal como las entrega getValues()):
 *  0 idInspeccion       5 maquina         10 observaciones     15 correlativoMaquina
 *  1 correlativo        6 producto        11 pdfUrl            16 cavidadMolde
 *  2 fechaHora(apertura)7 operario        12 estado            17 color_med    18 color_val
 *  3 turno               8 loteMp          13 inspectorLab      19 ciclo_med    20 ciclo_val
 *  4 inspector(terreno)  9 loteBxa         14 fechaHoraCierre   21 peso_med     22 peso_val
 *                                                                23 probador_med 24 probador_val
 *
 * Las columnas 17-24 son el "chequeo rápido" que registra el Inspector de Terreno
 * (Color, Ciclo, Peso, Probador) ANTES de que la ronda pase a Laboratorio. El resto
 * de las mediciones (los otros 9 campos de MEDICIONES_ORDEN) las completa Laboratorio
 * recién al cerrar la ronda.
 *
 * "estado" vacío/indefinido (filas antiguas del flujo de un solo paso) se trata como "Cerrada".
 *
 * Columnas de "Inspecciones_Detalle" (0-indexado):
 *  0 idDetalle  1 idInspeccion  2 cavidad_molde
 *  3-15  los 13 campos "_val" (mismo orden que MEDICIONES_ORDEN)
 *  16-28 los 13 campos "_med" (mismo orden), agregados al final para no romper filas antiguas.
 */
var MEDICIONES_ORDEN = [
  "color", "espesor", "ciclo", "peso", "calce", "filtracion",
  "probador", "hcuello", "phi_int", "phi_hilo", "phi_trinquete", "rebalse", "caida"
];
var MEDICIONES_ETIQUETAS = [
  "Color", "Espesor", "Ciclo", "Peso", "Calce", "Filtración",
  "Probador", "H Cuello", "Φ Int", "Φ Hilo", "Φ Trinquete", "Rebalse", "Caída"
];

// Capturadas por el Inspector de Terreno (guardadas en Inspecciones_Cabecera, columnas 17-24)
var MEDICIONES_TERRENO = ["color", "ciclo", "peso", "probador"];
// Completadas por Laboratorio al cerrar la ronda (llegan en el payload de cerrarRonda)
var MEDICIONES_LAB = MEDICIONES_ORDEN.filter(function (m) { return MEDICIONES_TERRENO.indexOf(m) === -1; });

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Leer Máquinas
  var sheetMaq = ss.getSheetByName("Maquinas");
  var dataMaq = sheetMaq ? sheetMaq.getDataRange().getValues() : [];
  var maquinas = [];
  for (var i = 1; i < dataMaq.length; i++) {
    if (dataMaq[i][0]) {
      maquinas.push({ id: String(dataMaq[i][0]), nombre: String(dataMaq[i][1] || dataMaq[i][0]) });
    }
  }

  // 2. Leer Productos (Columnas C a L)
  var sheetProd = ss.getSheetByName("Productos_Specs");
  var dataProd = sheetProd ? sheetProd.getDataRange().getValues() : [];
  var productos = [];
  for (var j = 1; j < dataProd.length; j++) {
    if (dataProd[j][0]) {
      productos.push({
        id: String(dataProd[j][0]),
        nombre: String(dataProd[j][1] || dataProd[j][0]),
        peso: dataProd[j][2],
        diametroInterior: dataProd[j][4],
        color: dataProd[j][6],
        ciclo: dataProd[j][7],
        diametroHilo: dataProd[j][8]
      });
    }
  }

  // 3. Leer Operarios de la hoja "Operarios" (Columna A / Índice 0)
  var sheetOp = ss.getSheetByName("Operarios");
  var dataOp = sheetOp ? sheetOp.getDataRange().getValues() : [];
  var operarios = [];
  for (var o = 1; o < dataOp.length; o++) {
    var nombreOp = String(dataOp[o][0] || "").trim();
    if (nombreOp) {
      operarios.push({ id: nombreOp, nombre: nombreOp });
    }
  }

  // 4. Leer Detalle -> mapa por idInspeccion (para adjuntar mediciones al historial)
  var sheetDet = ss.getSheetByName("Inspecciones_Detalle");
  var dataDet = sheetDet ? sheetDet.getDataRange().getValues() : [];
  var detallePorId = {};
  for (var d = 1; d < dataDet.length; d++) {
    if (!dataDet[d][1]) continue;
    var det = {};
    for (var m = 0; m < MEDICIONES_ORDEN.length; m++) {
      det[MEDICIONES_ORDEN[m] + "_val"] = dataDet[d][3 + m];
      det[MEDICIONES_ORDEN[m] + "_med"] = dataDet[d][16 + m];
    }
    detallePorId[String(dataDet[d][1])] = det;
  }

  // 5. Leer Cabecera -> separar en historial (Cerrada) y pendientes (Pendiente)
  var sheetCab = ss.getSheetByName("Inspecciones_Cabecera");
  var dataCab = sheetCab ? sheetCab.getDataRange().getValues() : [];
  var historial = [];
  var pendientes = [];

  for (var k = 1; k < dataCab.length; k++) {
    if (!dataCab[k][0]) continue;

    var infoFila = getInfoTurnoOperativo(dataCab[k][2]);
    var estado = String(dataCab[k][12] || "").trim() || "Cerrada";
    var idInspeccion = String(dataCab[k][0]);

    var base = {
      idInspeccion: idInspeccion,
      correlativo: String(dataCab[k][1]),
      correlativoMaquina: dataCab[k][15] ? String(dataCab[k][15]) : "",
      fechaHora: infoFila.fechaHoraCompleta,
      turno: String(dataCab[k][3] || ""),
      inspector: String(dataCab[k][4] || ""),
      maquina: String(dataCab[k][5] || ""),
      producto: String(dataCab[k][6] || ""),
      operario: String(dataCab[k][7] || ""),
      loteMp: String(dataCab[k][8] || ""),
      loteBxa: String(dataCab[k][9] || ""),
      cavidadMolde: dataCab[k][16] || 1,
      estado: estado,
      color_med: dataCab[k][17], color_val: dataCab[k][18] || "Cumple",
      ciclo_med: dataCab[k][19], ciclo_val: dataCab[k][20] || "Cumple",
      peso_med: dataCab[k][21], peso_val: dataCab[k][22] || "Cumple",
      probador_med: dataCab[k][23], probador_val: dataCab[k][24] || "Cumple"
    };

    if (estado === "Cancelada") {
      continue; // no se muestra ni en historial ni en pendientes
    }

    if (estado === "Pendiente") {
      pendientes.push(base);
    } else {
      base.observaciones = String(dataCab[k][10] || "");
      base.pdfUrl = String(dataCab[k][11] || "");
      base.inspectorLab = String(dataCab[k][13] || "");
      base.fechaHoraCierre = String(dataCab[k][14] || "");
      var det2 = detallePorId[idInspeccion];
      if (det2) {
        for (var key in det2) base[key] = det2[key];
      }
      historial.push(base);
    }
  }

  var response = { maquinas: maquinas, productos: productos, operarios: operarios, historial: historial, pendientes: pendientes };
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var resultado;

    switch (data.action) {
      case "crearRonda":
        resultado = crearRonda(data);
        break;
      case "cerrarRonda":
        resultado = cerrarRonda(data);
        break;
      case "cancelarRonda":
        resultado = cancelarRonda(data);
        break;
      case "generarConsolidado":
      case "cerrarTurno":
        resultado = generarPDFsPorMaquinaTurno(data.turnoActual);
        break;
      default:
        resultado = { status: "error", message: "Acción no reconocida: " + data.action };
    }

    return ContentService.createTextOutput(JSON.stringify(resultado))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Paso 1 (Terreno): abre una ronda pendiente para una máquina. No genera PDF ni fila de Detalle todavía.
function crearRonda(data) {
  if (!data.idRonda) return { status: "error", message: "Falta idRonda." };
  if (!data.id_maquina || !data.id_producto) return { status: "error", message: "Falta máquina o producto." };
  for (var t = 0; t < MEDICIONES_TERRENO.length; t++) {
    if (!data[MEDICIONES_TERRENO[t] + "_med"]) {
      return { status: "error", message: "Falta el chequeo de terreno: " + MEDICIONES_TERRENO[t] + "." };
    }
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetCab = ss.getSheetByName("Inspecciones_Cabecera");
  var infoTiempo = getInfoTurnoOperativo(new Date());

  var correlativo = sheetCab.getLastRow();
  var correlativoMaquina = contarRondasMaquinaTurno(sheetCab, data.id_maquina, infoTiempo.fechaOperativa, infoTiempo.turno) + 1;

  sheetCab.appendRow([
    data.idRonda,
    correlativo,
    infoTiempo.fechaHoraCompleta,
    infoTiempo.turno,
    data.inspector_calidad || "",
    data.id_maquina || "",
    data.id_producto || "",
    data.operario || "",
    data.lote_mp || "",
    data.lote_bxa || "",
    "",                 // observaciones: se completa al cerrar en laboratorio
    "",                 // pdfUrl: se completa al cerrar
    "Pendiente",        // estado
    "",                 // inspectorLab
    "",                 // fechaHoraCierre
    correlativoMaquina,
    data.cavidad_molde || 1,
    data.color_med || "", data.color_val || "Cumple",
    data.ciclo_med || "", data.ciclo_val || "Cumple",
    data.peso_med || "", data.peso_val || "Cumple",
    data.probador_med || "", data.probador_val || "Cumple"
  ]);

  return { status: "success", id: data.idRonda, correlativoMaquina: correlativoMaquina };
}

// Paso 2 (Laboratorio): completa mediciones, cierra la ronda y genera el PDF individual.
function cerrarRonda(data) {
  if (!data.idRonda) return { status: "error", message: "Falta idRonda." };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetCab = ss.getSheetByName("Inspecciones_Cabecera");
  var sheetDet = ss.getSheetByName("Inspecciones_Detalle");

  var fila = encontrarFilaPorId(sheetCab, data.idRonda, 0);
  if (fila === -1) return { status: "error", message: "No se encontró la ronda " + data.idRonda + "." };

  var filaValores = sheetCab.getRange(fila, 1, 1, 25).getValues()[0];
  var estadoActual = String(filaValores[12] || "").trim() || "Cerrada";
  if (estadoActual !== "Pendiente") {
    return { status: "error", message: "La ronda " + data.idRonda + " ya estaba " + estadoActual.toLowerCase() + "." };
  }

  // Identificación y el chequeo rápido de Terreno (Color/Ciclo/Peso/Probador) se toman de la
  // fila ya guardada en terreno, no de lo que reenvíe el cliente al cerrar.
  var dataParaPdf = {
    inspector_calidad: filaValores[4],
    id_maquina: filaValores[5],
    id_producto: filaValores[6],
    operario: filaValores[7],
    lote_mp: filaValores[8],
    lote_bxa: filaValores[9],
    cavidad_molde: filaValores[16] || 1,
    observaciones: data.observaciones || "",
    color_med: filaValores[17], color_val: filaValores[18] || "Cumple",
    ciclo_med: filaValores[19], ciclo_val: filaValores[20] || "Cumple",
    peso_med: filaValores[21], peso_val: filaValores[22] || "Cumple",
    probador_med: filaValores[23], probador_val: filaValores[24] || "Cumple"
  };
  // El resto de las mediciones las completa Laboratorio recién ahora, al cerrar.
  for (var m = 0; m < MEDICIONES_LAB.length; m++) {
    var clave = MEDICIONES_LAB[m];
    dataParaPdf[clave + "_med"] = data[clave + "_med"];
    dataParaPdf[clave + "_val"] = data[clave + "_val"] || "Cumple";
  }

  var pdfUrl = crearPDFNativoInseccion(data.idRonda, filaValores[2], dataParaPdf, filaValores[3]);
  var infoCierre = getInfoTurnoOperativo(new Date());

  sheetCab.getRange(fila, 11).setValue(dataParaPdf.observaciones); // col K
  sheetCab.getRange(fila, 12).setValue(pdfUrl);                    // col L
  sheetCab.getRange(fila, 13).setValue("Cerrada");                 // col M
  sheetCab.getRange(fila, 14).setValue(data.inspector_lab || "");  // col N
  sheetCab.getRange(fila, 15).setValue(infoCierre.fechaHoraCompleta); // col O

  var lastRowDet = sheetDet.getLastRow();
  var idDetalle = "DET-" + String(lastRowDet).padStart(4, '0');
  var filaDetalle = [idDetalle, data.idRonda, dataParaPdf.cavidad_molde];
  for (var v = 0; v < MEDICIONES_ORDEN.length; v++) filaDetalle.push(dataParaPdf[MEDICIONES_ORDEN[v] + "_val"]);
  for (var w = 0; w < MEDICIONES_ORDEN.length; w++) filaDetalle.push(dataParaPdf[MEDICIONES_ORDEN[w] + "_med"]);
  sheetDet.appendRow(filaDetalle);

  return { status: "success", id: data.idRonda, pdfUrl: pdfUrl };
}

// Descarta una ronda abierta por error en terreno (máquina/producto equivocado, etc.)
function cancelarRonda(data) {
  if (!data.idRonda) return { status: "error", message: "Falta idRonda." };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetCab = ss.getSheetByName("Inspecciones_Cabecera");
  var fila = encontrarFilaPorId(sheetCab, data.idRonda, 0);
  if (fila === -1) return { status: "error", message: "No se encontró la ronda " + data.idRonda + "." };

  var estadoActual = String(sheetCab.getRange(fila, 13).getValue() || "").trim() || "Cerrada";
  if (estadoActual !== "Pendiente") {
    return { status: "error", message: "Solo se pueden cancelar rondas Pendientes." };
  }

  sheetCab.getRange(fila, 13).setValue("Cancelada");
  return { status: "success", id: data.idRonda };
}

function encontrarFilaPorId(sheet, id, col0) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][col0]) === String(id)) return i + 1; // fila 1-indexada para getRange
  }
  return -1;
}

function contarRondasMaquinaTurno(sheetCab, maquinaId, fechaOperativa, turno) {
  var data = sheetCab.getDataRange().getValues();
  var count = 0;
  for (var i = 1; i < data.length; i++) {
    if (!data[i][2]) continue;
    var estado = String(data[i][12] || "").trim() || "Cerrada";
    if (estado === "Cancelada") continue;
    var info = getInfoTurnoOperativo(data[i][2]);
    if (String(data[i][5]) === String(maquinaId) && info.fechaOperativa === fechaOperativa && info.turno === turno) {
      count++;
    }
  }
  return count;
}

function crearPDFNativoInseccion(idInspeccion, fechaHora, data, turnoOficial) {
  try {
    var especificaciones = [
      { nombre: "Color y Apariencia", dato: data.color_med, estado: data.color_val },
      { nombre: "Espesor de Pared", dato: data.espesor_med, estado: data.espesor_val },
      { nombre: "Ciclo de Soplado/Inyección", dato: data.ciclo_med, estado: data.ciclo_val },
      { nombre: "Peso del Producto", dato: data.peso_med, estado: data.peso_val },
      { nombre: "Calce y Ajuste de Tapa", dato: data.calce_med, estado: data.calce_val },
      { nombre: "Hermeticidad / Filtración", dato: data.filtracion_med, estado: data.filtracion_val },
      { nombre: "Verificación Probador", dato: data.probador_med, estado: data.probador_val },
      { nombre: "H Cuello", dato: data.hcuello_med, estado: data.hcuello_val },
      { nombre: "Φ Interior Gollete (mm)", dato: data.phi_int_med, estado: data.phi_int_val },
      { nombre: "Φ Hilo Gollete (mm)", dato: data.phi_hilo_med, estado: data.phi_hilo_val },
      { nombre: "Φ Trinquete (mm)", dato: data.phi_trinquete_med, estado: data.phi_trinquete_val },
      { nombre: "Capacidad Rebalse", dato: data.rebalse_med, estado: data.rebalse_val },
      { nombre: "Resistencia a la Caída Libre", dato: data.caida_med, estado: data.caida_val }
    ];

    var filasTablaHTML = "";
    for (var i = 0; i < especificaciones.length; i++) {
      var item = especificaciones[i];
      var esOk = (item.estado === "Cumple");
      var badgeStyle = esOk
        ? "background-color: #15803d; color: #ffffff; padding: 3px 6px; border-radius: 3px; font-weight: bold; font-size: 8.5px; text-align: center; display: block;"
        : "background-color: #b91c1c; color: #ffffff; padding: 3px 6px; border-radius: 3px; font-weight: bold; font-size: 8.5px; text-align: center; display: block;";

      filasTablaHTML += `
        <tr>
          <td style="padding: 6px; border: 1px solid #cbd5e1; font-weight: bold; color: #0f172a;">${item.nombre}</td>
          <td style="padding: 6px; border: 1px solid #cbd5e1; text-align: center;">
            <span style="${badgeStyle}">${(item.estado || 'CUMPLE').toUpperCase()}</span>
          </td>
          <td style="padding: 6px; border: 1px solid #cbd5e1; color: #334155;">${item.dato || 'Sin detalle ingresado'}</td>
        </tr>
      `;
    }

    var htmlContent = `
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #0f172a; margin: 15px; font-size: 10px; }
          .title-area { text-align: center; border-bottom: 2px solid #0284c7; padding-bottom: 5px; margin-bottom: 12px; }
          .title-area h1 { font-size: 14px; margin: 0; color: #0f172a; font-weight: bold; }
          .title-area p { font-size: 9.5px; margin: 2px 0 0 0; color: #0284c7; font-weight: bold; }

          .info-table { width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 9.5px; }
          .info-table td { padding: 5px 8px; border: 1px solid #cbd5e1; }
          .lbl { font-weight: bold; color: #1e293b; background-color: #f1f5f9; width: 18%; }
          .val { color: #0f172a; width: 32%; }

          .sec-header { font-size: 10.5px; font-weight: bold; color: #0284c7; margin: 12px 0 6px 0; border-bottom: 1px solid #0284c7; padding-bottom: 3px; }
          .specs-table { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 9px; }
          .specs-table th { background-color: #0f172a; color: #ffffff; padding: 6px; text-align: left; border: 1px solid #0f172a; }
          .obs-box { background-color: #f8fafc; border: 1px solid #cbd5e1; border-radius: 4px; padding: 8px; margin-top: 12px; font-size: 9px; }
        </style>
      </head>
      <body>
        <div class="title-area">
          <h1>CONTROL DE CALIDAD - PLANTA DE MOLDEO</h1>
          <p>REGISTRO TÉCNICO OFICIAL DE INSPECCIÓN EN PROCESO (${idInspeccion})</p>
        </div>

        <table class="info-table">
          <tr>
            <td class="lbl">Fecha / Hora Ronda:</td>
            <td class="val">${fechaHora}</td>
            <td class="lbl">Inspector Terreno:</td>
            <td class="val">${data.inspector_calidad || '-'}</td>
          </tr>
          <tr>
            <td class="lbl">Máquina:</td>
            <td class="val">${data.id_maquina || '-'}</td>
            <td class="lbl">Operario:</td>
            <td class="val">${data.operario || 'Sin especificar'}</td>
          </tr>
          <tr>
            <td class="lbl">Producto:</td>
            <td class="val">${data.id_producto || '-'}</td>
            <td class="lbl">Turno:</td>
            <td class="val">${turnoOficial}</td>
          </tr>
          <tr>
            <td class="lbl">Lote MP:</td>
            <td class="val">${data.lote_mp || '-'}</td>
            <td class="lbl">Cavidad / Molde:</td>
            <td class="val">${data.cavidad_molde || '1'}</td>
          </tr>
          <tr>
            <td class="lbl">Lote BXA:</td>
            <td class="val">${data.lote_bxa || '-'}</td>
            <td class="lbl">Estado Registro:</td>
            <td class="val" style="color: #15803d; font-weight: bold;">CERRADA EN LABORATORIO</td>
          </tr>
        </table>

        <div class="sec-header">ESPECIFICACIONES TÉCNICAS Y EVALUACIÓN DE INSPECCIÓN</div>
        <table class="specs-table">
          <thead>
            <tr>
              <th style="width: 35%;">Especificación Técnica</th>
              <th style="width: 18%; text-align: center;">Evaluación</th>
              <th style="width: 47%;">Dato Registrado / Justificación</th>
            </tr>
          </thead>
          <tbody>
            ${filasTablaHTML}
          </tbody>
        </table>

        <div class="obs-box">
          <strong style="color: #0f172a;">Observaciones Adicionales:</strong><br>
          <span style="color: #334155;">${data.observaciones || 'Sin observaciones registradas.'}</span>
        </div>
      </body>
      </html>`;

    var blob = Utilities.newBlob(htmlContent, "text/html", "reporte.html").getAs("application/pdf");
    blob.setName(idInspeccion + "_" + (data.id_maquina || "MAQ") + ".pdf");

    var folderName = "Inspecciones_PDF";
    var folders = DriveApp.getFoldersByName(folderName);
    var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);

    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return file.getUrl();
  } catch (err) {
    return "Error generando PDF: " + err.toString();
  }
}

function generarPDFsPorMaquinaTurno(turnoParam) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetCab = ss.getSheetByName("Inspecciones_Cabecera");
  var sheetDet = ss.getSheetByName("Inspecciones_Detalle");
  var dataCab = sheetCab.getDataRange().getValues();
  var dataDet = sheetDet ? sheetDet.getDataRange().getValues() : [];

  if (dataCab.length <= 1) {
    return { status: "empty", message: "No hay registros guardados en la planilla." };
  }

  var noCumplePorId = {};
  for (var d = 1; d < dataDet.length; d++) {
    if (!dataDet[d][1]) continue;
    var noCumple = [];
    for (var v = 0; v < MEDICIONES_ORDEN.length; v++) {
      if (String(dataDet[d][3 + v]) === "No Cumple") noCumple.push(MEDICIONES_ETIQUETAS[v]);
    }
    noCumplePorId[String(dataDet[d][1])] = noCumple;
  }

  var infoActual = getInfoTurnoOperativo(new Date());
  var turnoObjetivo = turnoParam || infoActual.turno;
  var fechaObjetivo = infoActual.fechaOperativa;

  var registrosPorMaquina = {};
  var totalAgrupados = 0;

  for (var i = 1; i < dataCab.length; i++) {
    if (!dataCab[i][2]) continue;
    var estado = String(dataCab[i][12] || "").trim() || "Cerrada";
    if (estado === "Cancelada") continue;

    var infoFila = getInfoTurnoOperativo(dataCab[i][2]);
    if (infoFila.fechaOperativa === fechaObjetivo && infoFila.turno === turnoObjetivo) {
      var maq = String(dataCab[i][5] || "SIN_MAQUINA");
      if (!registrosPorMaquina[maq]) registrosPorMaquina[maq] = [];

      var idInspeccion = String(dataCab[i][0]);
      registrosPorMaquina[maq].push({
        id: idInspeccion,
        hora: infoFila.horaExacta,
        estado: estado,
        inspector: dataCab[i][4],
        inspectorLab: dataCab[i][13] || "-",
        producto: dataCab[i][6],
        operario: dataCab[i][7],
        loteMp: dataCab[i][8],
        loteBxa: dataCab[i][9],
        observaciones: dataCab[i][10],
        noCumple: noCumplePorId[idInspeccion] || []
      });
      totalAgrupados++;
    }
  }

  if (totalAgrupados === 0) {
    return { status: "warning", message: "No se encontraron inspecciones acumuladas para " + turnoObjetivo + "." };
  }

  var folderName = "Inspecciones_PDF";
  var folders = DriveApp.getFoldersByName(folderName);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
  var pdfsGenerados = 0;

  for (var maquinaKey in registrosPorMaquina) {
    var listaMaq = registrosPorMaquina[maquinaKey];

    var htmlContent = `
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; color: #0f172a; margin: 20px; font-size: 11px; }
          .header { border-bottom: 3px solid #0284c7; padding-bottom: 8px; margin-bottom: 12px; }
          h1 { margin: 0; font-size: 16px; color: #0f172a; }
          .sub { color: #0284c7; font-weight: bold; font-size: 11px; }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          th, td { border: 1px solid #cbd5e1; padding: 6px; text-align: left; }
          th { background-color: #0f172a; color: white; }
          tr:nth-child(even) { background-color: #f8fafc; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>REPORTE CONSOLIDADO POR MÁQUINA: ${maquinaKey}</h1>
          <span class="sub">${turnoObjetivo} - FECHA OPERATIVA: ${fechaObjetivo} | TOTAL RONDAS: ${listaMaq.length}</span>
        </div>

        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Hora</th>
              <th>Estado</th>
              <th>Insp. Terreno</th>
              <th>Insp. Laboratorio</th>
              <th>Operario</th>
              <th>Producto</th>
              <th>Lotes</th>
              <th>No Cumple</th>
              <th>Observaciones</th>
            </tr>
          </thead>
          <tbody>`;

    for (var m = 0; m < listaMaq.length; m++) {
      var item = listaMaq[m];
      var estadoBadge = item.estado === "Pendiente"
        ? '<span style="color:#b91c1c; font-weight:bold;">⚠ PENDIENTE</span>'
        : '<span style="color:#15803d; font-weight:bold;">CERRADA</span>';
      htmlContent += `
        <tr>
          <td><b>${item.id}</b></td>
          <td>${item.hora}</td>
          <td>${estadoBadge}</td>
          <td>${item.inspector}</td>
          <td>${item.inspectorLab}</td>
          <td>${item.operario || '-'}</td>
          <td>${item.producto}</td>
          <td>MP: ${item.loteMp || '-'}<br>BXA: ${item.loteBxa || '-'}</td>
          <td>${item.noCumple.length ? item.noCumple.join(', ') : '-'}</td>
          <td>${item.observaciones || '-'}</td>
        </tr>`;
    }

    htmlContent += `
          </tbody>
        </table>
      </body>
      </html>`;

    var blob = Utilities.newBlob(htmlContent, "text/html", "temp.html").getAs("application/pdf");
    var nombreArchivo = `Consolidado_${maquinaKey.replace(/[^a-zA-Z0-9]/g, '_')}_${fechaObjetivo}_${turnoObjetivo.replace(/\s+/g, '_')}.pdf`;
    blob.setName(nombreArchivo);
    folder.createFile(blob);
    pdfsGenerados++;
  }

  return { status: "success", count: pdfsGenerados, folderUrl: folder.getUrl() };
}
