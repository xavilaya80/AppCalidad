const TZ_SANTIAGO = "America/Santiago";

/*
 * A que TURNO y a que FECHA OPERATIVA pertenece un instante.
 *
 *   08:00 - 19:59  ->  Turno Mañana, fecha operativa = ese mismo dia
 *   20:00 - 23:59  ->  Turno Noche,  fecha operativa = ese mismo dia
 *   00:00 - 07:59  ->  Turno Noche,  fecha operativa = el dia ANTERIOR
 *
 * La fecha operativa del Turno Noche es siempre el dia en que EMPEZO (a las 20:00),
 * asi la madrugada queda agrupada con la tarde-noche que la precede.
 */
function getInfoTurnoOperativo(fechaObj) {
  var d = fechaObj ? new Date(fechaObj) : new Date();
  var hora = Number(Utilities.formatDate(d, TZ_SANTIAGO, "HH"));
  var turno = (hora >= 8 && hora < 20) ? "Turno Mañana" : "Turno Noche";

  // Se restan 24 h al INSTANTE y recien despues se formatea en Santiago.
  // Antes se usaba setDate(getDate()-1), que opera sobre el calendario de la zona
  // del script: si el proyecto no esta en America/Santiago, la madrugada podia
  // caer en la fecha operativa equivocada.
  var instante = (hora < 8) ? new Date(d.getTime() - 24 * 60 * 60 * 1000) : d;

  return {
    turno: turno,
    fechaOperativa: Utilities.formatDate(instante, TZ_SANTIAGO, "yyyy-MM-dd"),
    horaExacta: Utilities.formatDate(d, TZ_SANTIAGO, "HH:mm:ss"),
    fechaHoraCompleta: Utilities.formatDate(d, TZ_SANTIAGO, "yyyy-MM-dd HH:mm:ss")
  };
}

/*
 * Cuanto historial viaja a la tablet.
 *
 * doGet leia TODA la planilla en cada carga. "Inspecciones_Detalle" crece a razon
 * de UNA FILA POR CAVIDAD (hasta 24 por ronda), asi que es la hoja que revienta
 * primero: a un año de uso son cientos de miles de celdas y Apps Script corta a
 * los 30 s. Con esta ventana el costo deja de crecer con la antiguedad.
 */
var DIAS_HISTORIAL = 7;
var MAX_HISTORIAL = 800;

/*
 * C2: tope de desviaciones por cavidad que viajan a la tablet.
 *
 * Solo se mandan las cavidades que tuvieron al menos un "No Cumple", que en
 * una linea sana son pocas. El tope existe por si una maquina se descompone y
 * empieza a fallar todo: mejor recortar que dejar la tablet sin cargar.
 */
var MAX_DESVIACIONES = 1500;

/*
 * C3: variables que se grafican por cavidad, y su posicion en MEDICIONES_ORDEN.
 *
 * Van solo tres. Mandar las trece multiplicaria el peso de la respuesta para
 * graficar cosas que no son numericas (color, calce, caida) o que nadie sigue
 * en el tiempo. Con moldes de 24 cavidades la diferencia no es menor.
 */
var VARIABLES_GRAFICO = [
  { clave: "peso",    idx: 3 },
  { clave: "ciclo",   idx: 2 },
  { clave: "espesor", idx: 1 }
];

// Tope de rondas que llevan el detalle por cavidad. La ventana de B4 son 7 dias
// (unas 40 rondas en operacion normal), asi que rara vez se toca.
var MAX_RONDAS_GRAFICO = 200;   // tope de seguridad; lo que se deja fuera se informa

var TURNOS_VALIDOS = ["Turno Mañana", "Turno Noche"];

// Suma (o resta) dias a una fecha "yyyy-MM-dd" sin pelear con zonas horarias.
function sumarDiasISO(iso, dias) {
  var partes = String(iso).split("-");
  var d = new Date(Date.UTC(Number(partes[0]), Number(partes[1]) - 1, Number(partes[2]), 12));
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// La columna de fecha guarda texto "yyyy-MM-dd HH:mm:ss", pero si alguien edita
// la hoja a mano puede quedar un Date real. Se aceptan ambos.
function fechaISODeCelda(valor) {
  if (valor instanceof Date) return Utilities.formatDate(valor, TZ_SANTIAGO, "yyyy-MM-dd");
  var t = String(valor === null || valor === undefined ? "" : valor);
  return t.length >= 10 ? t.slice(0, 10) : "";
}

function normalizarTurno(valor) {
  var t = String(valor === null || valor === undefined ? "" : valor).trim();
  return (TURNOS_VALIDOS.indexOf(t) !== -1) ? t : "";
}

function normalizarFechaOperativa(valor) {
  var f = String(valor === null || valor === undefined ? "" : valor).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(f) ? f : "";
}

/*
 * Columnas de "Inspecciones_Cabecera" (0-indexado):
 *  0 idInspeccion       5 maquina         10 observaciones     15 correlativoMaquina
 *  1 correlativo        6 producto        11 pdfUrl            16 cavidadMolde
 *  2 fechaHora(apertura)7 operario        12 estado            17 color_med    18 color_val
 *  3 turno              8 loteMp          13 inspectorLab      19 ciclo_med    20 ciclo_val
 *  4 inspector(terreno) 9 loteBxa         14 fechaHoraCierre   21 peso_med     22 peso_val
 *                                                              23 probador_med 24 probador_val
 *
 * Valores posibles de "estado" (columna 12 / M):
 *   "Pendiente" -> ronda de terreno esperando el ensayo de laboratorio.
 *   "Cerrada"   -> ronda completa, con mediciones de laboratorio y PDF individual.
 *   "Cancelada" -> ronda descartada. Se ignora en TODOS los reportes.
 *   "Detenida"  -> EVENTO PUNTUAL: la maquina estaba detenida en ese instante del turno.
 *                  No es una ronda de inspeccion y NO bloquea la maquina: las
 *                  inspecciones posteriores siguen su curso normal.
 *
 * Columnas de "Inspecciones_Detalle" (0-indexado):
 *  0 idDetalle  1 idInspeccion  2 cavidad_molde
 *  3-15  los 13 campos "_val" (Cumple / No Cumple)
 *  16-28 los 13 campos "_med" (Valores reales medidos)
 */
var MEDICIONES_ORDEN = [
  "color", "espesor", "ciclo", "peso", "calce", "filtracion",
  "probador", "hcuello", "phi_int", "phi_hilo", "phi_trinquete", "rebalse", "caida"
];

var MEDICIONES_ETIQUETAS = [
  "Color", "Espesor", "Ciclo", "Peso", "Calce", "Filtración",
  "Probador", "H Cuello", "Φ Int", "Φ Hilo", "Φ Trinquete", "Rebalse", "Caída"
];

var MEDICIONES_TERRENO = ["color", "ciclo", "peso", "probador"];
var MEDICIONES_LAB = MEDICIONES_ORDEN.filter(function (m) { return MEDICIONES_TERRENO.indexOf(m) === -1; });

/* ===================================================================
 * TOLERANCIAS TECNICAS (C1)
 *
 * Hasta ahora la especificacion viajaba como texto y el inspector decidia a
 * ojo si el valor cumplia. Aca se convierte ese texto en un rango numerico
 * para que la app pueda decidirlo sola.
 *
 * De donde sale el rango, en este orden:
 *
 *   1. Columnas propias en Productos_Specs, si existen. Se buscan POR NOMBRE
 *      de encabezado (peso_min / peso_max, ciclo_min / ciclo_max, ...), asi
 *      que se pueden agregar donde sea y en cualquier orden. Es la forma
 *      recomendada: no depende de como este redactada la celda.
 *
 *   2. El texto de la celda de siempre, interpretado. Se aceptan los formatos
 *      que se usan en la practica:
 *          23.5 +/- 0.5     23,5 ± 0,5     23.5 ± 2%
 *          23.0 - 24.0      23 a 24        entre 23 y 24
 *          min 23           >= 23          max 24        <= 24
 *
 * Si no se puede sacar un rango, se devuelve el nominal sin min ni max y la
 * app NO marca nada automaticamente. Es deliberado: marcar "Cumple" sin poder
 * comprobarlo es exactamente el error que se corrigio en A2, y produce
 * certificados de conformidad falsos.
 * =================================================================== */

// Variables validables: clave que viaja al frontend, columna historica (base 0)
// y nombres de encabezado aceptados para las columnas min/max.
var VARIABLES_SPEC = [
  { clave: "peso",              col: 2,  alias: ["peso"] },
  { clave: "espesor",           col: 3,  alias: ["espesor", "espesorpared"] },
  { clave: "diametroInterior",  col: 4,  alias: ["diametrointerior", "diamint", "phiint", "diametrointgollete"] },
  { clave: "hcuello",           col: 5,  alias: ["hcuello", "altocuello", "alturacuello"] },
  { clave: "ciclo",             col: 7,  alias: ["ciclo", "tiempociclo"] },
  { clave: "diametroHilo",      col: 8,  alias: ["diametrohilo", "diamhilo", "phihilo"] },
  { clave: "diametroTrinquete", col: 10, alias: ["diametrotrinquete", "diamtrinquete", "phitrinquete"] },
  { clave: "rebalse",           col: 11, alias: ["rebalse", "capacidadrebalse"] }
];

function sinAcentos(valor) {
  return String(valor === null || valor === undefined ? "" : valor)
    .toLowerCase()
    .replace(/[\u00e1\u00e0\u00e4\u00e2]/g, "a")
    .replace(/[\u00e9\u00e8\u00eb\u00ea]/g, "e")
    .replace(/[\u00ed\u00ec\u00ef\u00ee]/g, "i")
    .replace(/[\u00f3\u00f2\u00f6\u00f4]/g, "o")
    .replace(/[\u00fa\u00f9\u00fc\u00fb]/g, "u")
    .replace(/\u00f1/g, "n");
}

// "Peso Min. (g)" -> "pesomin": asi el encabezado se puede escribir como sea.
// La unidad entre parentesis se descarta ANTES, o quedaria pegada ("pesoming").
function normalizarEncabezado(valor) {
  return sinAcentos(valor)
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/*
 * Busca la columna de un extremo. Primero por nombre exacto y, si no aparece,
 * por prefijo: asi "Peso Min g" (sin parentesis) tambien se encuentra.
 */
function buscarColumnaExtremo(encabezados, base, sufijos) {
  var i, k;
  for (i = 0; i < sufijos.length; i++) {
    var exacto = encabezados[base + sufijos[i]];
    if (exacto !== undefined) return exacto;
  }
  var claves = Object.keys(encabezados);
  for (i = 0; i < sufijos.length; i++) {
    var prefijo = base + sufijos[i];
    for (k = 0; k < claves.length; k++) {
      // El resto tiene que ser corto: es una unidad (g, mm, s), no otra variable.
      if (claves[k].indexOf(prefijo) === 0 && claves[k].length - prefijo.length <= 3) {
        return encabezados[claves[k]];
      }
    }
  }
  return undefined;
}

function indiceEncabezados(fila) {
  var idx = {};
  for (var i = 0; i < fila.length; i++) {
    var n = normalizarEncabezado(fila[i]);
    if (n && idx[n] === undefined) idx[n] = i;
  }
  return idx;
}

function aNumero(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  if (typeof valor === "number") return isNaN(valor) ? null : valor;
  var s = String(valor).trim().replace(/(\d),(\d)/g, "$1.$2").replace(/[^0-9.\-]/g, "");
  if (!s || s === "-" || s === ".") return null;
  var n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function armarRango(min, max, nominal, texto, fuente) {
  // Un rango al reves casi siempre es un tipeo; se acomoda en vez de descartarlo.
  if (min !== null && max !== null && min > max) {
    var t = min; min = max; max = t;
  }
  return {
    min: min,
    max: max,
    nominal: nominal,
    texto: texto,
    fuente: fuente,
    validable: (min !== null || max !== null)
  };
}

/*
 * Interpreta la celda de especificacion. Devuelve null si esta vacia.
 */
function parsearTolerancia(bruto) {
  var original = String(bruto === null || bruto === undefined ? "" : bruto).trim();
  if (!original || original === "-") return null;

  var s = sinAcentos(original)
    .replace(/(\d)[,](\d)/g, "$1.$2")     // coma decimal chilena
    .replace(/\u00b1/g, "+/-")            // ±
    .replace(/\u2213/g, "+/-")            // ∓
    .replace(/\u2265/g, ">=")             // ≥
    .replace(/\u2264/g, "<=")             // ≤
    .replace(/[\u2013\u2014]/g, "-");     // – —

  var N = "(-?\\d+(?:\\.\\d+)?)";

  // 1) nominal +/- tolerancia, absoluta o en porcentaje.
  //    Se admite una unidad entre medio: "23.5 g +/- 0.5 g".
  var UNIDAD = "\\s*[a-z]{0,4}\\s*";
  var m = s.match(new RegExp(N + UNIDAD + "(?:\\+\\/-|\\+-)\\s*" + N + "\\s*(%?)"));
  if (m) {
    var nom = parseFloat(m[1]);
    var tol = Math.abs(parseFloat(m[2]));
    if (m[3] === "%") tol = Math.abs(nom) * tol / 100;
    return armarRango(nom - tol, nom + tol, nom, original, "texto");
  }

  // 2) rango explicito
  m = s.match(new RegExp(N + "\\s*(?:-|a|y|to|hasta)\\s*" + N));
  if (m) {
    var a = parseFloat(m[1]);
    var b = parseFloat(m[2]);
    return armarRango(a, b, (a + b) / 2, original, "texto");
  }

  // 3) un solo extremo
  var mMin = s.match(new RegExp("(?:>=|>|min(?:imo)?\\.?)\\s*" + N));
  var mMax = s.match(new RegExp("(?:<=|<|max(?:imo)?\\.?)\\s*" + N));
  if (mMin || mMax) {
    return armarRango(mMin ? parseFloat(mMin[1]) : null,
                      mMax ? parseFloat(mMax[1]) : null,
                      null, original, "texto");
  }

  // 4) un numero suelto: es el nominal, pero sin tolerancia NO se puede validar
  m = s.match(new RegExp(N));
  if (m) {
    return armarRango(null, null, parseFloat(m[1]), original, "texto");
  }

  return null;
}

/*
 * Arma las tolerancias de una fila de Productos_Specs.
 */
function leerTolerancias(fila, encabezados) {
  var salida = {};

  for (var v = 0; v < VARIABLES_SPEC.length; v++) {
    var def = VARIABLES_SPEC[v];
    var min = null, max = null, nominal = null, hayColumnas = false;

    // 1. Columnas dedicadas, buscadas por nombre de encabezado.
    for (var a = 0; a < def.alias.length && !hayColumnas; a++) {
      var base = def.alias[a];
      var iMin = buscarColumnaExtremo(encabezados, base, ["min", "minimo"]);
      var iMax = buscarColumnaExtremo(encabezados, base, ["max", "maximo"]);

      if (iMin !== undefined || iMax !== undefined) {
        min = iMin !== undefined ? aNumero(fila[iMin]) : null;
        max = iMax !== undefined ? aNumero(fila[iMax]) : null;
        var iNom = encabezados[base + "nominal"];
        if (iNom !== undefined) nominal = aNumero(fila[iNom]);
        hayColumnas = (min !== null || max !== null);
      }
    }

    var textoCelda = fila[def.col];

    if (hayColumnas) {
      salida[def.clave] = armarRango(min, max, nominal, String(textoCelda || ""), "columnas");
      continue;
    }

    // 2. Interpretar el texto de la celda de siempre.
    var r = parsearTolerancia(textoCelda);
    if (r) salida[def.clave] = r;
  }

  return salida;
}

/* ===================================================================
 * ACTA DE TRASPASO DEL AREA DE CALIDAD (BEL-SGC-004.04)
 *
 * Los consolidados por maquina son el detalle: una hoja por maquina con todas
 * sus rondas. El acta es lo otro que hace falta al terminar el turno: UNA fila
 * por maquina, con lo que el turno siguiente necesita saber en treinta
 * segundos -que se estaba corriendo, que se desvio, que se hizo y como quedo
 * la maquina-.
 *
 * Replica el formulario en papel que hoy se llena a mano.
 * =================================================================== */

var ACTA_CODIGO = "BEL-SGC-004.04";
var ACTA_REVISION = "001";
var ACTA_FECHA_REV = "19/02/2026";
var ACTA_CARPETA = "Actas_Traspaso";

var CLAVE_DESTINATARIOS = "acta_destinatarios";
var CLAVE_JEFE_TURNO = "acta_jefe_turno";

// Aceptable para lo que se necesita: descartar tipeos evidentes antes de que
// MailApp falle con la lista entera y no se envie nada a nadie.
var RE_CORREO = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;

function leerConfigActa() {
  var props = PropertiesService.getScriptProperties();
  var crudo = props.getProperty(CLAVE_DESTINATARIOS) || "";
  return {
    destinatarios: crudo ? crudo.split(",") : [],
    jefeTurno: props.getProperty(CLAVE_JEFE_TURNO) || ""
  };
}

/*
 * Guarda los destinatarios habituales para no retipearlos cada noche.
 * Los invalidos se devuelven en vez de descartarse en silencio: si alguien
 * escribio mal un correo, tiene que enterarse ahora y no cuando el acta no llegue.
 */
function guardarConfigActa(data) {
  var lista = normalizarDestinatarios(data.destinatarios);
  var props = PropertiesService.getScriptProperties();
  props.setProperty(CLAVE_DESTINATARIOS, lista.validos.join(","));
  if (data.jefeTurno !== undefined) {
    props.setProperty(CLAVE_JEFE_TURNO, String(data.jefeTurno || "").trim());
  }
  return {
    status: "success",
    destinatarios: lista.validos,
    invalidos: lista.invalidos,
    jefeTurno: String(data.jefeTurno || "").trim()
  };
}

function normalizarDestinatarios(entrada) {
  var bruto = [];
  if (Object.prototype.toString.call(entrada) === "[object Array]") {
    bruto = entrada;
  } else if (entrada) {
    bruto = String(entrada).split(/[,;\s]+/);
  }

  var validos = [], invalidos = [], vistos = {};
  for (var i = 0; i < bruto.length; i++) {
    var c = String(bruto[i] || "").trim();
    if (!c) continue;
    if (!RE_CORREO.test(c)) { invalidos.push(c); continue; }
    var clave = c.toLowerCase();
    if (vistos[clave]) continue;      // el mismo correo dos veces manda dos copias
    vistos[clave] = true;
    validos.push(c);
  }
  return { validos: validos, invalidos: invalidos };
}

// "2026-08-24 20:40:15" -> "20:40"
function horaCorta(fechaHora) {
  var m = String(fechaHora || "").match(/(\d{2}):(\d{2})/);
  return m ? m[1] + ":" + m[2] : "";
}

function primerValorUtil(valores) {
  for (var i = valores.length - 1; i >= 0; i--) {
    var v = String(valores[i] === null || valores[i] === undefined ? "" : valores[i]).trim();
    if (v && v !== "N/A" && v !== "-") return v;
  }
  return "";
}

/*
 * Arma una fila del acta por CADA maquina de la planilla, no solo por las que
 * tuvieron rondas: una maquina sin registro en todo el turno es justamente lo
 * que hay que ver, y en una lista que solo muestra lo inspeccionado no aparece.
 */
/* ===================================================================
 * ESTADO VIGENTE DE CADA MAQUINA
 *
 * Una detencion no termina cuando pasa la hora: termina cuando alguien va,
 * comprueba que se arreglo y vuelve a inspeccionar. Hasta entonces la maquina
 * SIGUE detenida, aunque hayan pasado dos turnos.
 *
 * El estado no se guarda en ninguna parte: se deduce de la ultima ronda de esa
 * maquina. Un estado guardado aparte se desincroniza en cuanto alguien corrige
 * una fila a mano en la planilla; deducirlo no puede mentir.
 *
 * Para no volver a leer la planilla entera (ver B4) se recorren solo dos
 * columnas -maquina y estado- y despues se leen completas UNICAMENTE las pocas
 * filas de las maquinas que quedaron detenidas.
 * =================================================================== */
function estadoActualMaquinas(sheetCab) {
  var salida = {};
  if (!sheetCab) return salida;

  var ultima = sheetCab.getLastRow();
  if (ultima < 2) return salida;

  var filas = ultima - 1;
  var maquinas = sheetCab.getRange(2, 6, filas, 1).getValues();   // F
  var estados = sheetCab.getRange(2, 13, filas, 1).getValues();   // M

  // La ultima fila de cada maquina manda. Se recorre de arriba hacia abajo
  // porque la planilla se escribe con appendRow: el orden es cronologico.
  var ultimaFilaPorMaquina = {};
  for (var i = 0; i < filas; i++) {
    var maq = String(maquinas[i][0] || "").trim();
    if (!maq) continue;
    ultimaFilaPorMaquina[maq] = { fila: i + 2, estado: String(estados[i][0] || "").trim() };
  }

  var detenidas = [];
  for (var m in ultimaFilaPorMaquina) {
    var info = ultimaFilaPorMaquina[m];
    salida[m] = { maquina: m, detenida: (info.estado === "Detenida"), desde: "", motivo: "", detalle: "", idRonda: "" };
    if (info.estado === "Detenida") detenidas.push(info.fila);
  }

  if (detenidas.length === 0) return salida;

  // Solo ahora se leen filas completas, y solo las de las maquinas detenidas.
  detenidas.sort(function (a, b) { return a - b; });
  var valores = leerFilasDispersas(sheetCab, detenidas, 13);

  for (var d = 0; d < detenidas.length; d++) {
    var fila = valores[detenidas[d]];
    if (!fila) continue;
    var maqDet = String(fila[5] || "").trim();
    if (!salida[maqDet]) continue;
    var obs = String(fila[10] || "");
    salida[maqDet].desde = String(fila[2] || "");
    salida[maqDet].motivo = extraerMotivoDetencion(obs);
    salida[maqDet].detalle = extraerDetalleDetencion(obs);
    salida[maqDet].idRonda = String(fila[0] || "");
  }

  return salida;
}

/*
 * Ultima ronda productiva de cada maquina, para el acta.
 *
 * En el acta en papel una maquina DETENIDA igual muestra producto, lote y
 * ciclo: los de lo ultimo que estuvo corriendo. Sin esto la fila saldria vacia
 * justo para las maquinas de las que hay algo que decir.
 */
function ultimaProduccionMaquinas(dataCab) {
  var salida = {};
  for (var r = 1; r < dataCab.length; r++) {
    var fila = dataCab[r];
    if (!fila[0]) continue;
    if (String(fila[12] || "").trim() === "Detenida") continue;
    var maq = String(fila[5] || "").trim();
    if (!maq) continue;
    salida[maq] = {
      producto: String(fila[6] || ""),
      loteMp: String(fila[8] || ""),
      loteBxa: String(fila[9] || ""),
      ciclo: String(fila[19] || "")
    };
  }
  return salida;
}

function construirFilasActa(turno, fechaOperativa) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetCab = ss.getSheetByName("Inspecciones_Cabecera");
  var sheetDet = ss.getSheetByName("Inspecciones_Detalle");
  var sheetMaq = ss.getSheetByName("Maquinas");

  var dataCab = sheetCab ? sheetCab.getDataRange().getValues() : [];
  var dataDet = sheetDet ? sheetDet.getDataRange().getValues() : [];
  var dataMaq = sheetMaq ? sheetMaq.getDataRange().getValues() : [];

  // Fallas por ronda, agrupadas por cavidad (mismo criterio que el consolidado).
  var fallasPorId = {};
  for (var d = 1; d < dataDet.length; d++) {
    if (!dataDet[d][1]) continue;
    var idDet = String(dataDet[d][1]);
    var nroCav = Number(dataDet[d][2]) || 1;
    if (!fallasPorId[idDet]) fallasPorId[idDet] = {};
    for (var v = 0; v < MEDICIONES_ORDEN.length; v++) {
      if (String(dataDet[d][3 + v]) !== "No Cumple") continue;
      var etiqueta = MEDICIONES_ETIQUETAS[v];
      if (!fallasPorId[idDet][etiqueta]) fallasPorId[idDet][etiqueta] = [];
      if (fallasPorId[idDet][etiqueta].indexOf(nroCav) === -1) {
        fallasPorId[idDet][etiqueta].push(nroCav);
      }
    }
  }

  // Rondas del turno, agrupadas por maquina.
  var porMaquina = {};
  for (var r = 1; r < dataCab.length; r++) {
    var fila = dataCab[r];
    if (!fila[0]) continue;
    var info = getInfoTurnoOperativo(fila[2]);
    if (info.turno !== turno || info.fechaOperativa !== fechaOperativa) continue;

    var maq = String(fila[5] || "").trim();
    if (!maq) continue;
    if (!porMaquina[maq]) porMaquina[maq] = [];
    porMaquina[maq].push(fila);
  }

  // Orden de la planilla Maquinas; las que aparezcan en rondas y no esten
  // listadas se agregan al final para no perderlas.
  var orden = [];
  for (var m = 1; m < dataMaq.length; m++) {
    var idMaq = String(dataMaq[m][0] || "").trim();
    if (!idMaq) continue;
    orden.push({ id: idMaq, nombre: String(dataMaq[m][1] || idMaq).trim() });
  }
  var listados = {};
  for (var o = 0; o < orden.length; o++) listados[orden[o].id] = true;
  for (var extra in porMaquina) {
    if (!listados[extra]) orden.push({ id: extra, nombre: extra });
  }

  var vigente = estadoActualMaquinas(sheetCab);
  var ultimaProd = ultimaProduccionMaquinas(dataCab);

  var filas = [];
  for (var k = 0; k < orden.length; k++) {
    filas.push(resumirMaquinaActa(
      orden[k], porMaquina[orden[k].id] || [], fallasPorId,
      vigente[orden[k].id], ultimaProd[orden[k].id]));
  }
  return filas;
}

function resumirMaquinaActa(maquina, rondas, fallasPorId, vigente, ultimaProd) {
  var base = {
    maquina: maquina.nombre,
    producto: "", loteMp: "", loteBxa: "", ciclo: "",
    desvios: [], acciones: [], responsables: [],
    estado: "SIN REGISTRO", rondas: rondas.length, arrastrada: false
  };

  if (rondas.length === 0) {
    // Sin rondas en el turno hay dos situaciones muy distintas:
    //
    //   - la maquina venia DETENIDA de antes: sigue detenida, y eso hay que
    //     traspasarlo aunque nadie la haya tocado en estas 12 horas;
    //   - la maquina no se inspecciono y punto: decir "PRODUCIENDO" seria
    //     afirmar algo que nadie comprobo, asi que queda SIN REGISTRO.
    if (vigente && vigente.detenida) {
      base.estado = "DETENIDA";
      base.arrastrada = true;
      base.desvios.push("Detenida desde " + (vigente.desde || "turno anterior") +
                        (vigente.motivo ? ": " + vigente.motivo : "") +
                        (vigente.detalle ? " - " + vigente.detalle : ""));
      if (ultimaProd) {
        base.producto = ultimaProd.producto;
        base.loteMp = ultimaProd.loteMp;
        base.loteBxa = ultimaProd.loteBxa;
        base.ciclo = ultimaProd.ciclo;
      }
    }
    return base;
  }

  rondas.sort(function (a, b) {
    return String(a[2]).localeCompare(String(b[2]));
  });

  var productos = [], lotesMp = [], lotesBxa = [], ciclos = [];
  var vistasAcc = {}, vistasResp = {};

  for (var i = 0; i < rondas.length; i++) {
    var f = rondas[i];
    var estado = String(f[12] || "").trim();
    var hora = horaCorta(f[2]);
    var obs = String(f[10] || "").trim();

    productos.push(f[6]);
    lotesMp.push(f[8]);
    lotesBxa.push(f[9]);
    ciclos.push(f[19]);

    if (estado === "Detenida") {
      var motivo = extraerMotivoDetencion(obs);
      var detalle = extraerDetalleDetencion(obs);
      base.desvios.push(hora + " Detenida: " + (motivo || "sin motivo indicado") +
                        (detalle ? " - " + detalle : ""));
    } else {
      var fallas = fallasPorId[String(f[0])];
      if (fallas) {
        var resumen = resumirFallas(fallas);
        if (resumen) base.desvios.push(hora + " " + resumen);
      }
      // La observacion del inspector va aparte: describe lo que ninguna
      // medicion captura (rayas, rechupes, material sucio).
      if (obs) base.desvios.push(hora + " " + obs);

      // Si la ronda anterior de esta maquina era una detencion, esta ronda es
      // la que la puso de vuelta en marcha: eso se anota solo.
      if (i > 0 && String(rondas[i - 1][12] || "").trim() === "Detenida") {
        var acc = String(f[25] || "").trim();
        base.desvios.push(hora + " Reactivada" + (acc ? ": " + acc : "") + ".");
      }
    }

    var acc = String(f[25] || "").trim();
    if (acc && !vistasAcc[acc.toLowerCase()]) { vistasAcc[acc.toLowerCase()] = true; base.acciones.push(acc); }
    var resp = String(f[26] || "").trim();
    if (resp && !vistasResp[resp.toLowerCase()]) { vistasResp[resp.toLowerCase()] = true; base.responsables.push(resp); }
  }

  base.producto = primerValorUtil(productos);
  base.loteMp = primerValorUtil(lotesMp);
  base.loteBxa = primerValorUtil(lotesBxa);
  base.ciclo = primerValorUtil(ciclos);

  // El estado que importa es como QUEDA la maquina al entregar el turno, no
  // como estuvo en el medio: lo define la ultima ronda.
  var ultima = String(rondas[rondas.length - 1][12] || "").trim();
  base.estado = (ultima === "Detenida") ? "DETENIDA" : "PRODUCIENDO";

  // Una maquina detenida que no muestra producto es una fila inutil en el
  // acta: se completa con lo ultimo que estuvo corriendo.
  if (ultimaProd) {
    if (!base.producto) base.producto = ultimaProd.producto;
    if (!base.loteMp) base.loteMp = ultimaProd.loteMp;
    if (!base.loteBxa) base.loteBxa = ultimaProd.loteBxa;
    if (!base.ciclo) base.ciclo = ultimaProd.ciclo;
  }

  return base;
}

function actaHTML(filas, datos) {
  var fechaCorta = datos.fechaOperativa.split("-").reverse().join("/");

  var cuerpo = "";
  for (var i = 0; i < filas.length; i++) {
    var f = filas[i];
    var sinRegistro = (f.rondas === 0);

    var claseEstado = "est-prod";
    if (f.estado === "DETENIDA") claseEstado = "est-det";
    if (sinRegistro) claseEstado = "est-nada";

    var desvios = f.desvios.length
      ? f.desvios.map(function (d) { return escaparHTML(d); }).join("<br>")
      : (sinRegistro ? '<span class="tenue">Sin rondas registradas en este turno</span>' : "");

    cuerpo +=
      '<tr' + (sinRegistro ? ' class="fila-nada"' : '') + '>' +
        '<td class="maq">' + escaparHTML(f.maquina) + '</td>' +
        '<td>' + escaparHTML(f.producto) + '</td>' +
        '<td class="chico">' + escaparHTML(f.loteMp) + '</td>' +
        '<td class="chico">' + escaparHTML(f.loteBxa) + '</td>' +
        '<td class="num">' + escaparHTML(f.ciclo) + '</td>' +
        '<td class="desvio">' + desvios + '</td>' +
        '<td>' + escaparHTML(f.acciones.join("; ")) + '</td>' +
        '<td>' + escaparHTML(f.responsables.join("; ")) + '</td>' +
        '<td class="' + claseEstado + '">' + escaparHTML(f.estado) + '</td>' +
      '</tr>';
  }

  return '<html><head><meta charset="UTF-8"><style>' +
    '@page { size: A4 landscape; margin: 12mm 10mm; }' +
    'body { font-family: Arial, Helvetica, sans-serif; font-size: 8.5pt; color: #0f172a; }' +
    'table { width: 100%; border-collapse: collapse; }' +
    '.cab td { border: 1px solid #0f172a; padding: 5px 8px; vertical-align: middle; }' +
    '.marca { font-size: 17pt; font-weight: bold; letter-spacing: 1px; color: #0284c7; }' +
    '.marca small { display: block; font-size: 6pt; letter-spacing: 3px; color: #64748b; font-weight: normal; }' +
    '.titulo { text-align: center; font-weight: bold; font-size: 11pt; }' +
    '.meta { font-size: 7.5pt; width: 170px; }' +
    '.fecha-doc { margin: 10px 0 4px auto; width: 220px; border: 1px solid #0f172a; ' +
      'padding: 4px 8px; font-weight: bold; font-size: 9pt; }' +
    '.datos th { background: #e2e8f0; border: 1px solid #0f172a; padding: 5px 4px; font-size: 7.5pt; }' +
    '.datos td { border: 1px solid #0f172a; padding: 4px 5px; vertical-align: top; line-height: 1.35; }' +
    '.maq { font-weight: bold; white-space: nowrap; }' +
    '.chico { font-size: 7pt; }' +
    '.num { text-align: center; }' +
    '.desvio { font-size: 7.5pt; }' +
    '.est-prod { text-align: center; font-weight: bold; color: #15803d; font-size: 7.5pt; }' +
    '.est-det { text-align: center; font-weight: bold; color: #b91c1c; font-size: 7.5pt; }' +
    '.est-nada { text-align: center; color: #94a3b8; font-size: 7.5pt; }' +
    '.fila-nada td { background: #f8fafc; }' +
    '.tenue { color: #94a3b8; font-style: italic; }' +
    '.pie { margin-top: 14px; }' +
    '.pie td { border: 1px solid #0f172a; padding: 6px 8px; font-size: 9pt; }' +
    '.pie .obs { height: 46px; vertical-align: top; }' +
    '</style></head><body>' +

    '<table class="cab"><tr>' +
      '<td style="width:160px; text-align:center;"><span class="marca">beluxa<small>CONTAINERS SOLUTIONS</small></span></td>' +
      '<td class="titulo">REGISTRO<br>ACTA TRASPASO AREA DE CALIDAD POR TURNO</td>' +
      '<td class="meta">Rev.: ' + ACTA_REVISION + '<br>Fecha: ' + ACTA_FECHA_REV +
        '<br>C&oacute;digo: ' + ACTA_CODIGO + '</td>' +
    '</tr></table>' +

    '<div class="fecha-doc">Fecha: ' + escaparHTML(fechaCorta) + '</div>' +

    '<table class="datos"><thead><tr>' +
      '<th style="width:7%;">M&aacute;quina</th>' +
      '<th style="width:12%;">Producto</th>' +
      '<th style="width:9%;">Lote MP</th>' +
      '<th style="width:7%;">Lote Bxa</th>' +
      '<th style="width:6%;">Tiempo Ciclo</th>' +
      '<th style="width:27%;">Desv&iacute;o detectado</th>' +
      '<th style="width:14%;">Acci&oacute;n correctiva</th>' +
      '<th style="width:10%;">Responsable</th>' +
      '<th style="width:8%;">Estado de la m&aacute;quina</th>' +
    '</tr></thead><tbody>' + cuerpo + '</tbody></table>' +

    '<table class="pie">' +
      '<tr><td>' + escaparHTML(datos.turno) + ' &nbsp; ' + escaparHTML(fechaCorta) + '</td></tr>' +
      '<tr><td>Inspector de Calidad: ' + escaparHTML(datos.inspector || "") + '</td></tr>' +
      '<tr><td>Jefe de Turno: ' + escaparHTML(datos.jefeTurno || "") + '</td></tr>' +
      '<tr><td class="obs">Observaciones: ' + escaparHTML(datos.observaciones || "") + '</td></tr>' +
    '</table>' +

    '</body></html>';
}

/*
 * Genera el acta y, si se pide, la manda por correo.
 *
 * Generar y enviar van juntos a proposito: si fueran dos llamadas habria que
 * volver a armar el PDF o pasearlo por la red, y con la cola offline de A6 eso
 * multiplica las formas de que salgan dos actas distintas del mismo turno.
 */
function generarActaTraspaso(data) {
  var turno = normalizarTurno(data.turnoActual);
  if (!turno) return { status: "error", message: "Turno no reconocido: '" + data.turnoActual + "'." };

  var fecha = normalizarFechaOperativa(data.fechaOperativa);
  if (!fecha) {
    return { status: "error", message: "Fecha operativa inválida: '" + data.fechaOperativa + "'." };
  }

  var filas = construirFilasActa(turno, fecha);
  var conRondas = 0;
  for (var i = 0; i < filas.length; i++) if (filas[i].rondas > 0) conRondas++;

  if (filas.length === 0) {
    return { status: "empty", message: "No hay máquinas cargadas en la hoja Maquinas." };
  }

  var html = actaHTML(filas, {
    turno: turno,
    fechaOperativa: fecha,
    inspector: data.inspector || "",
    jefeTurno: data.jefeTurno || "",
    observaciones: data.observaciones || ""
  });

  var nombre = "Acta_Traspaso_" + fecha + "_" + turno.replace(/\s+/g, "_") + ".pdf";
  var blob = Utilities.newBlob(html, "text/html", "acta.html").getAs("application/pdf");
  blob.setName(nombre);

  var carpetas = DriveApp.getFoldersByName(ACTA_CARPETA);
  var carpeta = carpetas.hasNext() ? carpetas.next() : DriveApp.createFolder(ACTA_CARPETA);
  var archivo = carpeta.createFile(blob);
  archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  var resultado = {
    status: "success",
    url: archivo.getUrl(),
    nombre: nombre,
    turno: turno,
    fechaOperativa: fecha,
    maquinas: filas.length,
    maquinasConRondas: conRondas,
    maquinasSinRegistro: filas.length - conRondas,
    detenidas: filas.filter(function (f) { return f.estado === "DETENIDA"; }).length,
    enviado: false,
    destinatarios: [],
    invalidos: []
  };

  if (!data.enviar) return resultado;

  var lista = normalizarDestinatarios(data.destinatarios);
  resultado.invalidos = lista.invalidos;

  if (lista.validos.length === 0) {
    resultado.status = "parcial";
    resultado.message = "El acta se generó, pero no se envió: no hay direcciones válidas." +
      (lista.invalidos.length ? " Revisa: " + lista.invalidos.join(", ") : "");
    return resultado;
  }

  try {
    MailApp.sendEmail({
      to: lista.validos.join(","),
      subject: "Acta de Traspaso Calidad · " + turno + " · " + fecha,
      htmlBody:
        '<p>Adjunto el <strong>Acta de Traspaso del Área de Calidad</strong>.</p>' +
        '<p><strong>' + escaparHTML(turno) + '</strong> del <strong>' + escaparHTML(fecha) + '</strong><br>' +
        'Inspector de Calidad: ' + escaparHTML(data.inspector || "-") + '<br>' +
        'Jefe de Turno: ' + escaparHTML(data.jefeTurno || "-") + '</p>' +
        '<p>' + conRondas + ' de ' + filas.length + ' máquinas con rondas registradas · ' +
        resultado.detenidas + ' detenida(s).</p>' +
        (resultado.maquinasSinRegistro > 0
          ? '<p style="color:#b45309;"><strong>Atención:</strong> ' + resultado.maquinasSinRegistro +
            ' máquina(s) sin ninguna ronda en el turno.</p>'
          : '') +
        '<p style="color:#64748b; font-size:12px;">Generado automáticamente por App Calidad. ' +
        'También queda en Drive: <a href="' + archivo.getUrl() + '">ver acta</a>.</p>',
      attachments: [blob]
    });
    resultado.enviado = true;
    resultado.destinatarios = lista.validos;
  } catch (err) {
    // El PDF ya existe: se informa el fallo de correo sin perder el acta.
    resultado.status = "parcial";
    resultado.message = "El acta se generó y quedó en Drive, pero el envío falló: " + err.message;
  }

  return resultado;
}

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

  // 2. Leer Productos (Leyendo TODAS las especificaciones de la hoja Productos_Specs)
  var sheetProd = ss.getSheetByName("Productos_Specs");
  var dataProd = sheetProd ? sheetProd.getDataRange().getValues() : [];
  var encabezados = indiceEncabezados(dataProd.length ? dataProd[0] : []);
  var productos = [];
  for (var j = 1; j < dataProd.length; j++) {
    if (dataProd[j][0]) {
      productos.push({
        id: String(dataProd[j][0]),
        nombre: String(dataProd[j][1] || dataProd[j][0]),
        peso: dataProd[j][2] || "-",
        espesor: dataProd[j][3] || "-",
        diametroInterior: dataProd[j][4] || "-",
        hcuello: dataProd[j][5] || "-",
        color: dataProd[j][6] || "-",
        ciclo: dataProd[j][7] || "-",
        diametroHilo: dataProd[j][8] || "-",
        diametroTrinquete: dataProd[j][10] || "-",
        rebalse: dataProd[j][11] || "-",
        // C1: los mismos valores, ya interpretados como rango numerico.
        tolerancias: leerTolerancias(dataProd[j], encabezados)
      });
    }
  }

  // 3. Leer Operarios de la hoja "Operarios" (Columna A)
  var sheetOp = ss.getSheetByName("Operarios");
  var dataOp = sheetOp ? sheetOp.getDataRange().getValues() : [];
  var operarios = [];
  for (var o = 1; o < dataOp.length; o++) {
    var nombreOp = String(dataOp[o][0] || "").trim();
    if (nombreOp && nombreOp !== "Nombre Completo") {
      operarios.push({ id: nombreOp, nombre: nombreOp });
    }
  }

  // ---------- 4. Que filas de la cabecera entran ----------
  var sheetCab = ss.getSheetByName("Inspecciones_Cabecera");
  var alcance = seleccionarFilasCabecera(sheetCab, DIAS_HISTORIAL);

  var idsNecesarios = {};
  for (var a = 0; a < alcance.filas.length; a++) {
    var filaCab = alcance.valores[alcance.filas[a]];
    if (filaCab && filaCab[0]) idsNecesarios[String(filaCab[0])] = true;
  }

  // ---------- 5. Detalle, solo el de esas rondas ----------
  var sheetDet = ss.getSheetByName("Inspecciones_Detalle");
  var dataDet = leerDetalleDeRondas(sheetDet, idsNecesarios);

  var detallePorId = {};
  var cavidadesPorId = {};   // cuantas cavidades se registraron en cada ronda
  var cavidadBasePorId = {}; // numero de la cavidad representativa elegida
  var terrenoPorId = {};     // chequeo de terreno cavidad por cavidad
  var fallasPorId = {};      // C2: que cavidad fallo y en que variable
  var valoresPorId = {};     // C3: [cavidad, peso, ciclo, espesor] por cavidad

  for (var d = 0; d < dataDet.length; d++) {
    if (!dataDet[d][1]) continue;
    var idDet = String(dataDet[d][1]);
    var nroCav = Number(dataDet[d][2]) || 1;

    cavidadesPorId[idDet] = (cavidadesPorId[idDet] || 0) + 1;

    // El laboratorio necesita ver que midio terreno en ESA misma cavidad.
    if (!terrenoPorId[idDet]) terrenoPorId[idDet] = [];
    var regTerreno = { cavidad: nroCav };
    for (var tt = 0; tt < MEDICIONES_ORDEN.length; tt++) {
      var claveTT = MEDICIONES_ORDEN[tt];
      if (MEDICIONES_TERRENO.indexOf(claveTT) === -1) continue;
      regTerreno[claveTT + "_val"] = dataDet[d][3 + tt];
      regTerreno[claveTT + "_med"] = dataDet[d][16 + tt];
    }
    terrenoPorId[idDet].push(regTerreno);

    // C2: se anota la cavidad SOLO si algo salio "No Cumple". Guardar tambien
    // las conformes multiplicaria por 20 el tamaño de la respuesta sin aportar:
    // una cavidad que no aparece es una cavidad que paso.
    var fallasCav = [];
    for (var ff = 0; ff < MEDICIONES_ORDEN.length; ff++) {
      if (String(dataDet[d][3 + ff]).trim() === "No Cumple") fallasCav.push(MEDICIONES_ORDEN[ff]);
    }
    if (fallasCav.length > 0) {
      if (!fallasPorId[idDet]) fallasPorId[idDet] = [];
      fallasPorId[idDet].push({ cavidad: nroCav, fallas: fallasCav });
    }

    // C3: los valores medidos de esta cavidad, como tupla compacta.
    // Un arreglo en vez de un objeto: son ~4 veces menos bytes por cavidad y
    // esto se repite por cada cavidad de cada ronda de la ventana.
    var tupla = [nroCav];
    for (var vg = 0; vg < VARIABLES_GRAFICO.length; vg++) {
      tupla.push(aNumero(dataDet[d][16 + VARIABLES_GRAFICO[vg].idx]));
    }
    if (!valoresPorId[idDet]) valoresPorId[idDet] = [];
    valoresPorId[idDet].push(tupla);

    // Como resumen para el historial se usa siempre la cavidad mas baja.
    if (cavidadBasePorId[idDet] !== undefined && nroCav >= cavidadBasePorId[idDet]) continue;
    cavidadBasePorId[idDet] = nroCav;

    var det = { cavidadBase: nroCav };
    for (var m = 0; m < MEDICIONES_ORDEN.length; m++) {
      det[MEDICIONES_ORDEN[m] + "_val"] = dataDet[d][3 + m];
      det[MEDICIONES_ORDEN[m] + "_med"] = dataDet[d][16 + m];
    }
    detallePorId[idDet] = det;
  }

  // ---------- 6. Armar historial y pendientes ----------
  var historial = [];
  var pendientes = [];
  var desviaciones = [];      // C2: una entrada por cavidad que fallo
  var desviacionesTruncadas = 0;
  var resumenPorTurno = {};   // "fecha|turno" -> conteos, para el modal de cierre

  for (var f = 0; f < alcance.filas.length; f++) {
    var fila = alcance.valores[alcance.filas[f]];
    if (!fila || !fila[0]) continue;

    var infoFila = getInfoTurnoOperativo(fila[2]);
    var estado = String(fila[12] || "").trim() || "Cerrada";
    var idInspeccion = String(fila[0]);

    var base = {
      idInspeccion: idInspeccion,
      correlativo: String(fila[1]),
      correlativoMaquina: fila[15] ? String(fila[15]) : "",
      fechaHora: infoFila.fechaHoraCompleta,
      turno: String(fila[3] || ""),
      inspector: String(fila[4] || ""),
      maquina: String(fila[5] || ""),
      producto: String(fila[6] || ""),
      operario: String(fila[7] || ""),
      loteMp: String(fila[8] || ""),
      loteBxa: String(fila[9] || ""),
      cavidadMolde: fila[16] || 1,
      estado: estado,
      // Turno calculado a partir de la hora, no el que se tipeo: es el que
      // agrupa bien las rondas de una misma jornada (misma regla que B3).
      fechaOperativa: infoFila.fechaOperativa,
      turnoOperativo: infoFila.turno,
      accionCorrectiva: String(fila[25] || ""),
      responsable: String(fila[26] || ""),
      color_med: fila[17], color_val: fila[18] || "Cumple",
      ciclo_med: fila[19], ciclo_val: fila[20] || "Cumple",
      peso_med: fila[21], peso_val: fila[22] || "Cumple",
      probador_med: fila[23], probador_val: fila[24] || "Cumple"
    };

    // Conteo por turno operativo: alimenta el modal de "Cerrar Turno".
    var claveTurno = infoFila.fechaOperativa + "|" + infoFila.turno;
    if (!resumenPorTurno[claveTurno]) {
      resumenPorTurno[claveTurno] = {
        fechaOperativa: infoFila.fechaOperativa,
        turno: infoFila.turno,
        total: 0, pendientes: 0, cerradas: 0, detenciones: 0
      };
    }
    var r = resumenPorTurno[claveTurno];
    r.total++;
    if (estado === "Pendiente") r.pendientes++;
    else if (estado === "Detenida") r.detenciones++;
    else r.cerradas++;

    if (estado === "Pendiente") {
      base.cavidadesTerreno = (terrenoPorId[idInspeccion] || []).sort(function (x, y) {
        return x.cavidad - y.cavidad;
      });
      pendientes.push(base);
    } else {
      base.observaciones = String(fila[10] || "");
      base.pdfUrl = String(fila[11] || "");
      base.inspectorLab = String(fila[13] || "");
      base.fechaHoraCierre = String(fila[14] || "");
      base.cavidadesEnsayadas = cavidadesPorId[idInspeccion] || 0;
      var det2 = detallePorId[idInspeccion];
      if (det2) {
        for (var key in det2) base[key] = det2[key];
      }
      historial.push(base);

      // C3: valores por cavidad para el grafico, en las rondas mas recientes.
      // alcance.filas viene ordenado, asi que las ultimas son las recientes.
      if (historial.length <= MAX_RONDAS_GRAFICO || alcance.filas.length - f <= MAX_RONDAS_GRAFICO) {
        var vals = valoresPorId[idInspeccion];
        if (vals) {
          base.porCavidad = vals.slice().sort(function (x, y) { return x[0] - y[0]; });
        }
      }

      // C2: las cavidades que fallaron en esta ronda.
      var fallasRonda = fallasPorId[idInspeccion];
      if (fallasRonda) {
        for (var q = 0; q < fallasRonda.length; q++) {
          if (desviaciones.length >= MAX_DESVIACIONES) { desviacionesTruncadas++; continue; }
          desviaciones.push({
            idInspeccion: idInspeccion,
            maquina: base.maquina,
            producto: base.producto,
            turno: infoFila.turno,
            fechaOperativa: infoFila.fechaOperativa,
            fechaHora: base.fechaHora,
            cavidad: fallasRonda[q].cavidad,
            fallas: fallasRonda[q].fallas
          });
        }
      }
    }
  }

  // Solo los turnos mas recientes: es lo unico que se puede llegar a cerrar.
  var resumenTurnos = [];
  for (var claveR in resumenPorTurno) resumenTurnos.push(resumenPorTurno[claveR]);
  resumenTurnos.sort(function (a2, b2) {
    if (a2.fechaOperativa === b2.fechaOperativa) return a2.turno < b2.turno ? 1 : -1;
    return a2.fechaOperativa < b2.fechaOperativa ? 1 : -1;
  });
  resumenTurnos = resumenTurnos.slice(0, 8);

  var response = {
    maquinas: maquinas,
    productos: productos,
    operarios: operarios,
    historial: historial,
    pendientes: pendientes,
    desviaciones: desviaciones,
    desviacionesTruncadas: desviacionesTruncadas,
    // C3: orden de los valores dentro de cada tupla de porCavidad.
    variablesGrafico: VARIABLES_GRAFICO.map(function (v) { return v.clave; }),
    resumenTurnos: resumenTurnos,
    configActa: leerConfigActa(),
    // La tablet necesita saber que maquinas estan detenidas AHORA para poder
    // pedir la reactivacion antes de dejar inspeccionar.
    estadoMaquinas: estadoActualMaquinas(sheetCab),
    turnoActual: getInfoTurnoOperativo(new Date()),
    // Metadatos de la ventana: la app avisa al usuario que esta viendo un recorte.
    historialDias: DIAS_HISTORIAL,
    historialDesde: alcance.fechaCorte,
    historialTruncado: alcance.truncado,
    filasLeidasDetalle: dataDet.length
  };
  return ContentService.createTextOutput(JSON.stringify(response))
    .setMimeType(ContentService.MimeType.JSON);
}

/*
 * Elige que filas de "Inspecciones_Cabecera" hay que traer SIN leer la hoja entera.
 *
 * Recorre primero dos columnas angostas (fecha y estado) y recien despues lee las
 * 25 columnas del tramo que hace falta. Criterio:
 *   - los ultimos `dias` dias operativos, y
 *   - TODAS las rondas Pendientes sin importar su antiguedad: una ronda que sigue
 *     esperando al laboratorio no puede desaparecer de la lista por vieja.
 */
function seleccionarFilasCabecera(sheetCab, dias) {
  var vacio = { filas: [], valores: {}, fechaCorte: "", truncado: 0 };
  if (!sheetCab) return vacio;

  var ultimaFila = sheetCab.getLastRow();
  if (ultimaFila < 2) return vacio;

  var n = ultimaFila - 1;
  var fechas = sheetCab.getRange(2, 3, n, 1).getValues();    // col C: fechaHora
  var estados = sheetCab.getRange(2, 13, n, 1).getValues();  // col M: estado

  var hoy = getInfoTurnoOperativo(new Date()).fechaOperativa;
  // Un dia extra de margen: las rondas de 00:00-07:59 pertenecen al dia operativo
  // anterior, y aqui se compara contra la fecha de calendario.
  var fechaCorte = sumarDiasISO(hoy, -(dias));

  var filasPendientes = [];
  var filasHistorial = [];

  for (var i = 0; i < n; i++) {
    var estado = String(estados[i][0] || "").trim() || "Cerrada";
    if (estado === "Cancelada") continue;

    if (estado === "Pendiente") { filasPendientes.push(i + 2); continue; }

    var iso = fechaISODeCelda(fechas[i][0]);
    if (iso && iso >= fechaCorte) filasHistorial.push(i + 2);
  }

  // Tope de seguridad. Se conservan las mas recientes y se informa cuantas
  // quedaron fuera: nunca un recorte silencioso.
  var truncado = 0;
  if (filasHistorial.length > MAX_HISTORIAL) {
    truncado = filasHistorial.length - MAX_HISTORIAL;
    filasHistorial = filasHistorial.slice(filasHistorial.length - MAX_HISTORIAL);
  }

  var todas = filasPendientes.concat(filasHistorial);
  todas.sort(function (a, b) { return a - b; });
  if (todas.length === 0) {
    return { filas: [], valores: {}, fechaCorte: fechaCorte, truncado: truncado };
  }

  var valores = leerFilasDispersas(sheetCab, todas, sheetCab.getLastColumn());
  return { filas: todas, valores: valores, fechaCorte: fechaCorte, truncado: truncado };
}

/*
 * Devuelve solo las filas de "Inspecciones_Detalle" de las rondas pedidas.
 *
 * Esta es la optimizacion que mas pesa: en vez de traer las 29 columnas de toda la
 * hoja, se barre UNA columna (el idInspeccion) para ubicar donde empieza lo que
 * interesa, y recien ahi se lee el tramo ancho. Como las filas se agregan en orden,
 * ese tramo es el final de la hoja salvo que haya una ronda pendiente muy antigua.
 */
/*
 * Lee un conjunto disperso de filas agrupandolas en el menor numero de rangos.
 *
 * Las filas que interesan casi siempre estan juntas al final de la hoja (lo
 * reciente), pero una ronda Pendiente antigua puede quedar sola al principio.
 * Leer de corrido desde ella hasta el final significaria traer la planilla entera,
 * justo lo que se quiere evitar: por eso los huecos grandes cortan el bloque.
 */
function leerFilasDispersas(hoja, filas, ancho) {
  var valores = {};
  if (!filas || filas.length === 0) return valores;

  // Si el hueco entre dos filas utiles es chico, sale mas barato leer de corrido
  // que hacer otra llamada a getRange.
  var TOLERANCIA_HUECO = 50;

  var i = 0;
  while (i < filas.length) {
    var inicio = filas[i];
    var fin = filas[i];
    var j = i + 1;
    while (j < filas.length && (filas[j] - fin) <= TOLERANCIA_HUECO) {
      fin = filas[j];
      j++;
    }

    var bloque = hoja.getRange(inicio, 1, fin - inicio + 1, ancho).getValues();
    for (var k = i; k < j; k++) valores[filas[k]] = bloque[filas[k] - inicio];
    i = j;
  }

  return valores;
}

function leerDetalleDeRondas(sheetDet, idsNecesarios) {
  if (!sheetDet) return [];

  var ultimaFila = sheetDet.getLastRow();
  if (ultimaFila < 2) return [];

  // Indice angosto: se recorre UNA columna para saber exactamente que filas hacen
  // falta, en vez de traerse las 29 columnas de toda la hoja.
  var ids = sheetDet.getRange(2, 2, ultimaFila - 1, 1).getValues();

  var filas = [];
  for (var i = 0; i < ids.length; i++) {
    if (idsNecesarios[String(ids[i][0])]) filas.push(i + 2);
  }
  if (filas.length === 0) return [];

  var valores = leerFilasDispersas(sheetDet, filas, sheetDet.getLastColumn());

  var salida = [];
  for (var f = 0; f < filas.length; f++) {
    if (valores[filas[f]]) salida.push(valores[filas[f]]);
  }
  return salida;
}

/*
 * Acciones que ESCRIBEN. Todas se serializan con LockService.
 *
 * Sin bloqueo, dos peticiones simultaneas pueden intercalarse entre el momento en
 * que leen la planilla y el momento en que escriben. Ejemplo real: crearRonda
 * calcula el correlativo por maquina con contarRondasMaquinaTurno() y despues hace
 * appendRow(); si dos rondas entran a la vez, ambas cuentan lo mismo y quedan con
 * el mismo numero. Con la cola offline de A6 esto dejo de ser hipotetico: al volver
 * la señal se disparan varios envios seguidos.
 */
var ACCIONES_CON_ESCRITURA = {
  generarActa: true,
  guardarConfigActa: true,
  crearRonda: true,
  cerrarRonda: true,
  cancelarRonda: true,
  registrarDetencion: true,
  cerrarTurno: true,
  generarConsolidado: true
};

var LOCK_ESPERA_MS = 10000;

function respuestaJSON(objeto) {
  return ContentService.createTextOutput(JSON.stringify(objeto))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = null;

  try {
    var data = JSON.parse(e.postData.contents);

    if (ACCIONES_CON_ESCRITURA[data.action]) {
      lock = LockService.getScriptLock();

      // tryLock espera hasta LOCK_ESPERA_MS y devuelve false si no lo consiguio.
      if (!lock.tryLock(LOCK_ESPERA_MS)) {
        lock = null;   // no lo tenemos: no hay que liberarlo en el finally
        return respuestaJSON({
          status: "busy",
          reintentable: true,
          message: "El servidor está procesando otra operación. El registro NO se guardó; " +
                   "se reintentará automáticamente en unos segundos."
        });
      }
    }

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
      case "registrarDetencion":
        resultado = registrarDetencion(data);
        break;
      case "generarActa":
        resultado = generarActaTraspaso(data);
        break;

      case "guardarConfigActa":
        resultado = guardarConfigActa(data);
        break;

      case "generarConsolidado":
      case "cerrarTurno":
        // La app manda turno Y fecha operativa explicitos: el servidor ya no
        // adivina cual turno se esta cerrando a partir de la hora actual.
        resultado = generarPDFsPorMaquinaTurno(data.turnoActual, data.fechaOperativa);
        break;
      default:
        resultado = { status: "error", message: "Acción no reconocida: " + data.action };
    }

    return respuestaJSON(resultado);
  } catch (err) {
    return respuestaJSON({ status: "error", message: err.toString() });
  } finally {
    if (lock) {
      /*
       * flush() ANTES de soltar el lock: Apps Script bufferiza las escrituras de
       * Spreadsheet. Sin esto, la siguiente peticion podria tomar el lock y leer la
       * planilla todavia sin nuestros cambios, que es justo la carrera que el lock
       * pretende evitar.
       */
      try { SpreadsheetApp.flush(); } catch (errFlush) { /* nada que hacer aqui */ }
      lock.releaseLock();
    }
  }
}

/*
 * Paso 1 (Terreno): abre la ronda y SIEMBRA una fila por cavidad en
 * "Inspecciones_Detalle" con el chequeo hecho en maquina.
 *
 * Antes solo se guardaban las 4 mediciones de la cavidad 1 en la cabecera y las
 * cavidades 2..24 se perdian. Ahora la cabecera conserva la cavidad 1 (para no
 * romper el historial ni el grafico) y el detalle guarda TODAS.
 */
/* ===================================================================
 * CORRELATIVOS QUE NO SE REPITEN (B1)
 *
 * Antes el correlativo era sheetCab.getLastRow(): el identificador ERA la
 * posicion en la planilla. Con eso basta borrar una fila -o que alguien limpie
 * registros de prueba- para que el siguiente registro reciba un numero que ya
 * existe. Dos filas distintas con el mismo correlativo en un registro de
 * calidad es exactamente lo que no puede pasar.
 *
 * Ahora hay un contador aparte que solo sube. Nunca retrocede aunque la
 * planilla encoja, porque no mira cuantas filas hay sino cuantos numeros se
 * entregaron.
 *
 * La primera vez se siembra con el mayor numero ya usado, para no chocar con
 * lo que la planilla ya tiene. Las escrituras estan serializadas con
 * LockService (B2), asi que dos peticiones simultaneas no pueden reservar el
 * mismo numero.
 * =================================================================== */

var CLAVE_CORR_CAB = "correlativo_cabecera";
var CLAVE_CORR_DET = "correlativo_detalle";

// Mayor numero ya usado en una columna de identificadores.
// Sirve tanto para "12" como para "DET-0012".
function mayorCorrelativoUsado(hoja, columna) {
  var ultima = hoja.getLastRow();
  if (ultima < 2) return 0;

  var valores = hoja.getRange(2, columna, ultima - 1, 1).getValues();
  var mayor = 0;
  for (var i = 0; i < valores.length; i++) {
    var m = String(valores[i][0] === null || valores[i][0] === undefined ? "" : valores[i][0])
      .match(/(\d+)\s*$/);
    if (!m) continue;
    var n = parseInt(m[1], 10);
    if (!isNaN(n) && n > mayor) mayor = n;
  }
  return mayor;
}

/*
 * Reserva `cantidad` numeros consecutivos y devuelve el primero.
 *
 * Se reservan de una vez, no de a uno, porque una ronda de 24 cavidades
 * necesita 24 identificadores de detalle en la misma operacion.
 */
function reservarCorrelativos(clave, cantidad, hoja, columna) {
  var props = PropertiesService.getScriptProperties();
  var actual = parseInt(props.getProperty(clave), 10);

  if (isNaN(actual)) {
    // Primer uso: se parte de lo que la planilla ya tiene entregado.
    actual = mayorCorrelativoUsado(hoja, columna);
  }

  // Piso de seguridad por si alguien pego filas a mano sin correlativo: el
  // contador nunca queda por debajo de la cantidad de filas existentes.
  var filas = hoja.getLastRow() - 1;
  if (filas > actual) actual = filas;

  props.setProperty(clave, String(actual + cantidad));
  return actual + 1;
}

// "DET-0042"
function idDetalle(numero) {
  return "DET-" + String(numero).padStart(4, '0');
}

function crearRonda(data) {
  if (!data.idRonda) return { status: "error", message: "Falta idRonda." };
  if (!data.id_maquina || !data.id_producto) return { status: "error", message: "Falta máquina o producto." };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetCab = ss.getSheetByName("Inspecciones_Cabecera");
  var sheetDet = ss.getSheetByName("Inspecciones_Detalle");
  if (!sheetCab) return { status: "error", message: "No existe la hoja Inspecciones_Cabecera." };
  if (!sheetDet) return { status: "error", message: "No existe la hoja Inspecciones_Detalle." };

  // IDEMPOTENCIA: si el idRonda ya existe, esto es un reintento de la cola offline
  // (el POST original si llego, pero la respuesta se perdio). Se responde exito sin
  // volver a escribir, para no duplicar la ronda.
  var filaPrevia = encontrarFilaPorId(sheetCab, data.idRonda, 0);
  if (filaPrevia !== -1) {
    var previa = sheetCab.getRange(filaPrevia, 1, 1, 25).getValues()[0];
    return {
      status: "success",
      id: data.idRonda,
      duplicado: true,
      correlativoMaquina: previa[15],
      cavidadesDeclaradas: Number(previa[16]) || 1,
      cavidadesRegistradas: contarDetallePorRonda(sheetDet, data.idRonda)
    };
  }

  var cavidadesTerreno = normalizarCavidadesTerreno(data);

  var faltantes = validarChequeoTerreno(cavidadesTerreno);
  if (faltantes.length > 0) {
    return {
      status: "error",
      message: "Falta el chequeo de terreno en: " + faltantes.slice(0, 8).join("; ") +
               (faltantes.length > 8 ? " y " + (faltantes.length - 8) + " mas." : ".")
    };
  }

  var infoTiempo = getInfoTurnoOperativo(new Date());
  var correlativo = reservarCorrelativos(CLAVE_CORR_CAB, 1, sheetCab, 2);
  var correlativoMaquina = contarRondasMaquinaTurno(
    sheetCab, data.id_maquina, infoTiempo.fechaOperativa, infoTiempo.turno) + 1;

  // Inspeccionar una maquina detenida ES reactivarla: al quedar esta ronda como
  // la ultima de la maquina, su estado vigente vuelve a produccion.
  var estadoPrevio = estadoActualMaquinas(sheetCab)[String(data.id_maquina)];
  var reactivo = !!(estadoPrevio && estadoPrevio.detenida);

  var totalCavidades = Number(data.cavidad_molde) || cavidadesTerreno.length;
  var base = cavidadesTerreno[0];   // cavidad 1: se replica en la cabecera

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
    "",                 // Observaciones (Col K)
    "",                 // PDF Url (Col L)
    "Pendiente",        // Estado (Col M)
    "",                 // Inspector Lab (Col N)
    "",                 // FechaHoraCierre (Col O)
    correlativoMaquina, // Col P
    totalCavidades,     // Col Q
    base.color_med, base.color_val,
    base.ciclo_med, base.ciclo_val,
    base.peso_med, base.peso_val,
    base.probador_med, base.probador_val,
    // ACTA: se registran junto al desvio, que es cuando se saben. Reconstruirlas
    // al cerrar el turno significaria acordarse de lo que paso 12 horas antes.
    data.accion_correctiva || "",   // Z
    data.responsable || ""          // AA
  ]);

  // --- Siembra del detalle: una fila por cavidad ---
  // La fila donde se ESCRIBE sigue siendo el final de la hoja; lo que ya no
  // sale de ahi es el identificador.
  var lastRowDet = sheetDet.getLastRow();
  var baseDet = reservarCorrelativos(CLAVE_CORR_DET, cavidadesTerreno.length, sheetDet, 1);
  var filas = [];
  for (var c = 0; c < cavidadesTerreno.length; c++) {
    filas.push(construirFilaDetalle(
      idDetalle(baseDet + c),
      data.idRonda,
      cavidadesTerreno[c].cavidad,
      cavidadesTerreno[c]
    ));
  }
  sheetDet.getRange(lastRowDet + 1, 1, filas.length, filas[0].length).setValues(filas);

  return {
    status: "success",
    id: data.idRonda,
    reactivada: reactivo,
    correlativoMaquina: correlativoMaquina,
    cavidadesRegistradas: cavidadesTerreno.length,
    cavidadesDeclaradas: totalCavidades
  };
}

// Toda cavidad debe traer sus 4 chequeos, salvo que esten marcados "No Aplica".
function validarChequeoTerreno(cavidades) {
  var faltantes = [];
  for (var c = 0; c < cavidades.length; c++) {
    for (var t = 0; t < MEDICIONES_TERRENO.length; t++) {
      var clave = MEDICIONES_TERRENO[t];
      if (cavidades[c][clave + "_val"] === "No Aplica") continue;
      if (cavidades[c][clave + "_med"] === "N/A") {
        faltantes.push("Cavidad " + cavidades[c].cavidad + " - " +
                       MEDICIONES_ETIQUETAS[MEDICIONES_ORDEN.indexOf(clave)]);
      }
    }
  }
  return faltantes;
}

/*
 * Arma una fila de 29 columnas de "Inspecciones_Detalle".
 * Las llaves ausentes quedan como "Pendiente"/"" -> es el estado natural de las
 * mediciones de laboratorio mientras la ronda todavia no se ensaya.
 */
function construirFilaDetalle(idDetalle, idRonda, nroCavidad, valores) {
  var fila = [idDetalle, idRonda, nroCavidad];
  for (var paso = 0; paso < 2; paso++) {
    var sufijo = (paso === 0) ? "_val" : "_med";
    for (var v = 0; v < MEDICIONES_ORDEN.length; v++) {
      var valor = valores[MEDICIONES_ORDEN[v] + sufijo];
      if (valor === undefined || valor === null) {
        valor = (sufijo === "_val") ? "Pendiente" : "";
      }
      fila.push(valor);
    }
  }
  return fila;
}

// Paso 2 (Laboratorio): Completa mediciones, cierra la ronda y genera el PDF individual
function cerrarRonda(data) {
  if (!data.idRonda) return { status: "error", message: "Falta idRonda." };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetCab = ss.getSheetByName("Inspecciones_Cabecera");
  var sheetDet = ss.getSheetByName("Inspecciones_Detalle");

  var fila = encontrarFilaPorId(sheetCab, data.idRonda, 0);
  if (fila === -1) return { status: "error", message: "No se encontró la ronda " + data.idRonda + "." };

  var filaValores = sheetCab.getRange(fila, 1, 1, 25).getValues()[0];
  var estadoActual = String(filaValores[12] || "").trim() || "Cerrada";

  // Una ronda ya Cerrada es, casi siempre, el reintento de una cola offline cuyo
  // primer envio si llego. Se responde exito (no se sobrescribe nada) para que la
  // cola pueda vaciarse sin mostrarle un error alarmante al inspector.
  if (estadoActual === "Cerrada") {
    return {
      status: "success",
      id: data.idRonda,
      duplicado: true,
      pdfUrl: String(filaValores[11] || ""),
      cavidadesGuardadas: contarDetallePorRonda(sheetDet, data.idRonda),
      cavidadesDeclaradas: Number(filaValores[16]) || 1,
      cavidadesSinEnsayar: 0,
      desviaciones: 0
    };
  }

  // Cancelada u otro estado si es un error real: no se debe cerrar.
  if (estadoActual !== "Pendiente") {
    return { status: "error", message: "La ronda " + data.idRonda + " está " + estadoActual.toLowerCase() + ": no se puede cerrar." };
  }

  if (!sheetDet) return { status: "error", message: "No existe la hoja Inspecciones_Detalle." };

  // Guardia anti-registro-fantasma: si el payload no trae NINGUNA llave de medicion,
  // no se cierra la ronda. Antes esto pasaba desapercibido y se generaba un PDF
  // que certificaba "Cumple" sin un solo dato real.
  if (!payloadTieneMediciones(data)) {
    return {
      status: "error",
      message: "No llegaron las mediciones de laboratorio. La ronda " + data.idRonda + " sigue Pendiente."
    };
  }

  var cavidadesDeclaradas = Number(filaValores[16]) || 1;
  var cavidadesLab = normalizarMedicionesLab(data, cavidadesDeclaradas);

  var dataParaPdf = {
    inspector_calidad: filaValores[4],
    id_maquina: filaValores[5],
    id_producto: filaValores[6],
    operario: filaValores[7],
    lote_mp: filaValores[8],
    lote_bxa: filaValores[9],
    cavidad_molde: cavidadesDeclaradas,
    inspector_lab: data.inspector_lab || "",
    observaciones: data.observaciones || "",
    // Respaldo del chequeo de terreno de la cavidad 1. Desde A3 el detalle guarda
    // TODAS las cavidades; esto solo se usa para rondas antiguas sin filas sembradas.
    color_med: limpiarMedicion(filaValores[17]), color_val: limpiarEstado(filaValores[18]),
    ciclo_med: limpiarMedicion(filaValores[19]), ciclo_val: limpiarEstado(filaValores[20]),
    peso_med: limpiarMedicion(filaValores[21]), peso_val: limpiarEstado(filaValores[22]),
    probador_med: limpiarMedicion(filaValores[23]), probador_val: limpiarEstado(filaValores[24])
  };

  // Completa las filas que terreno ya habia sembrado, cavidad por cavidad.
  var sync = sincronizarDetalleLaboratorio(sheetDet, data.idRonda, cavidadesLab, dataParaPdf);
  var cavidades = sync.cavidades;

  dataParaPdf.cavidadesEnsayadas = cavidades.length;

  var pdfUrl = crearPDFNativoInseccion(data.idRonda, filaValores[2], dataParaPdf, filaValores[3], cavidades);
  var infoCierre = getInfoTurnoOperativo(new Date());

  sheetCab.getRange(fila, 11).setValue(dataParaPdf.observaciones); // Col K
  sheetCab.getRange(fila, 12).setValue(pdfUrl);                    // Col L
  sheetCab.getRange(fila, 13).setValue("Cerrada");                 // Col M
  sheetCab.getRange(fila, 14).setValue(data.inspector_lab || "");  // Col N
  sheetCab.getRange(fila, 15).setValue(infoCierre.fechaHoraCompleta); // Col O

  return {
    status: "success",
    id: data.idRonda,
    pdfUrl: pdfUrl,
    cavidadesGuardadas: cavidades.length,
    cavidadesDeclaradas: cavidadesDeclaradas,
    cavidadesSinEnsayar: sync.sinEnsayar,
    cavidadesNuevasEnLab: sync.agregadas,
    desviaciones: listarDesviaciones(cavidades).length
  };
}

/*
 * Fusiona las mediciones de laboratorio sobre las filas de detalle que terreno
 * ya habia sembrado, emparejando POR NUMERO DE CAVIDAD.
 *
 *  - Cavidad con datos de terreno y de laboratorio -> se completa.
 *  - Cavidad de terreno que el laboratorio no ensayo -> sus 9 ensayos quedan
 *    "No Aplica"/"N/A" (nunca "Cumple") y se informa en cavidadesSinEnsayar.
 *  - Cavidad que solo aparece en laboratorio (ronda antigua o molde recontado)
 *    -> se agrega como fila nueva para no perderla.
 *
 * Devuelve { cavidades, sinEnsayar, agregadas } donde `cavidades` trae las 13
 * mediciones completas de cada cavidad, listas para el PDF.
 */
function sincronizarDetalleLaboratorio(sheetDet, idRonda, cavidadesLab, datosCabecera) {
  var datos = sheetDet.getDataRange().getValues();
  var indicesRonda = [];
  var indicePorCavidad = {};

  for (var i = 1; i < datos.length; i++) {
    if (String(datos[i][1]) !== String(idRonda)) continue;
    var nro = Number(datos[i][2]) || 1;
    indicePorCavidad[nro] = i;
    indicesRonda.push(i);
  }

  var labPorCavidad = {};
  for (var l = 0; l < cavidadesLab.length; l++) {
    labPorCavidad[cavidadesLab[l].cavidad] = cavidadesLab[l];
  }

  // Ronda creada ANTES de A3: no hay filas sembradas. Se crean ahora usando el
  // chequeo de terreno de la cabecera para la cavidad 1.
  if (indicesRonda.length === 0) {
    var nuevas = [];
    var lastRow = sheetDet.getLastRow();
    var baseNuevas = reservarCorrelativos(CLAVE_CORR_DET, cavidadesLab.length, sheetDet, 1);
    for (var n = 0; n < cavidadesLab.length; n++) {
      var reg = cavidadesLab[n];
      if (reg.cavidad === 1 && datosCabecera) {
        for (var t = 0; t < MEDICIONES_TERRENO.length; t++) {
          var kt = MEDICIONES_TERRENO[t];
          reg[kt + "_med"] = datosCabecera[kt + "_med"];
          reg[kt + "_val"] = datosCabecera[kt + "_val"];
        }
      } else {
        for (var t2 = 0; t2 < MEDICIONES_TERRENO.length; t2++) {
          var kt2 = MEDICIONES_TERRENO[t2];
          reg[kt2 + "_med"] = "N/A";
          reg[kt2 + "_val"] = "No Aplica";
        }
      }
      nuevas.push(construirFilaDetalle(
        idDetalle(baseNuevas + n), idRonda, reg.cavidad, reg));
    }
    sheetDet.getRange(lastRow + 1, 1, nuevas.length, nuevas[0].length).setValues(nuevas);
    return { cavidades: cavidadesLab, sinEnsayar: 0, agregadas: cavidadesLab.length };
  }

  var salida = [];
  var sinEnsayar = 0;

  for (var f = 0; f < indicesRonda.length; f++) {
    var idx = indicesRonda[f];
    var nroCav = Number(datos[idx][2]) || 1;
    var lab = labPorCavidad[nroCav];
    var completa = { cavidad: nroCav };

    for (var m = 0; m < MEDICIONES_ORDEN.length; m++) {
      var clave = MEDICIONES_ORDEN[m];

      if (MEDICIONES_TERRENO.indexOf(clave) !== -1) {
        // Terreno ya esta escrito: se conserva tal cual.
        completa[clave + "_val"] = limpiarEstado(datos[idx][3 + m]);
        completa[clave + "_med"] = limpiarMedicion(datos[idx][16 + m]);
        continue;
      }

      var estado = lab ? lab[clave + "_val"] : "No Aplica";
      var medicion = lab ? lab[clave + "_med"] : "N/A";
      datos[idx][3 + m] = estado;
      datos[idx][16 + m] = medicion;
      completa[clave + "_val"] = estado;
      completa[clave + "_med"] = medicion;
    }

    if (!lab) sinEnsayar++;
    salida.push(completa);
  }

  // Escritura: en bloque si las filas quedaron contiguas (el caso normal).
  var minIdx = indicesRonda[0], maxIdx = indicesRonda[0];
  for (var k = 1; k < indicesRonda.length; k++) {
    if (indicesRonda[k] < minIdx) minIdx = indicesRonda[k];
    if (indicesRonda[k] > maxIdx) maxIdx = indicesRonda[k];
  }
  if (maxIdx - minIdx + 1 === indicesRonda.length) {
    var bloque = [];
    for (var b = minIdx; b <= maxIdx; b++) bloque.push(datos[b]);
    sheetDet.getRange(minIdx + 1, 1, bloque.length, bloque[0].length).setValues(bloque);
  } else {
    for (var r = 0; r < indicesRonda.length; r++) {
      var ir = indicesRonda[r];
      sheetDet.getRange(ir + 1, 1, 1, datos[ir].length).setValues([datos[ir]]);
    }
  }

  // Cavidades que solo trae el laboratorio: se agregan para no perderlas.
  var extras = [];
  for (var nc in labPorCavidad) {
    if (indicePorCavidad[nc] !== undefined) continue;
    var extra = labPorCavidad[nc];
    for (var e = 0; e < MEDICIONES_TERRENO.length; e++) {
      var ke = MEDICIONES_TERRENO[e];
      extra[ke + "_med"] = "N/A";
      extra[ke + "_val"] = "No Aplica";
    }
    extras.push(extra);
    salida.push(extra);
  }

  if (extras.length > 0) {
    var lastExtra = sheetDet.getLastRow();
    var baseExtra = reservarCorrelativos(CLAVE_CORR_DET, extras.length, sheetDet, 1);
    var filasExtra = [];
    for (var x = 0; x < extras.length; x++) {
      filasExtra.push(construirFilaDetalle(
        idDetalle(baseExtra + x), idRonda, extras[x].cavidad, extras[x]));
    }
    sheetDet.getRange(lastExtra + 1, 1, filasExtra.length, filasExtra[0].length).setValues(filasExtra);
  }

  salida.sort(function (a, b) { return a.cavidad - b.cavidad; });
  return { cavidades: salida, sinEnsayar: sinEnsayar, agregadas: extras.length };
}

/*
 * ¿El payload trae la estructura de mediciones de laboratorio?
 * No juzga el contenido (todo "No Aplica" es valido); solo detecta que las llaves
 * llegaron. Es la red de seguridad contra el bug original de A2.
 */
function payloadTieneMediciones(data) {
  var arr = data.medicionesPorCavidad;
  if (Object.prototype.toString.call(arr) === "[object Array]" && arr.length > 0) return true;
  for (var m = 0; m < MEDICIONES_LAB.length; m++) {
    if (data[MEDICIONES_LAB[m] + "_med"] !== undefined) return true;
    if (data[MEDICIONES_LAB[m] + "_val"] !== undefined) return true;
  }
  return false;
}

/*
 * Normaliza las mediciones de laboratorio a [{cavidad, <clave>_med, <clave>_val}, ...].
 * Acepta el formato que envia app.js (data.medicionesPorCavidad) y, por compatibilidad,
 * el formato plano antiguo (data.espesor_med, data.calce_med, ...).
 */
function normalizarMedicionesLab(data, cavidadesDeclaradas) {
  return normalizarCavidades(data.medicionesPorCavidad, MEDICIONES_LAB, data);
}

function normalizarCavidadesTerreno(data) {
  return normalizarCavidades(data.cavidadesTerreno, MEDICIONES_TERRENO, data);
}

/*
 * Convierte el array que envia la app a [{cavidad, <clave>_med, <clave>_val}, ...].
 * Si el array no viene (cliente antiguo), reconstruye una sola cavidad desde las
 * llaves planas del payload.
 */
function normalizarCavidades(arr, claves, datosPlanos) {
  var salida = [];
  var esArray = (Object.prototype.toString.call(arr) === "[object Array]" && arr.length > 0);

  if (esArray) {
    for (var i = 0; i < arr.length; i++) {
      var fuente = arr[i] || {};
      var registro = { cavidad: Number(fuente.cavidad) || (i + 1) };
      for (var m = 0; m < claves.length; m++) {
        var k = claves[m];
        registro[k + "_med"] = limpiarMedicion(fuente[k + "_med"]);
        registro[k + "_val"] = limpiarEstado(fuente[k + "_val"]);
      }
      salida.push(registro);
    }
  } else {
    var unica = { cavidad: 1 };
    for (var f = 0; f < claves.length; f++) {
      var kf = claves[f];
      unica[kf + "_med"] = limpiarMedicion(datosPlanos ? datosPlanos[kf + "_med"] : null);
      unica[kf + "_val"] = limpiarEstado(datosPlanos ? datosPlanos[kf + "_val"] : null);
    }
    salida.push(unica);
  }

  salida.sort(function (a, b) { return a.cavidad - b.cavidad; });
  return salida;
}

function limpiarMedicion(valor) {
  if (valor === null || valor === undefined) return "N/A";
  var s = String(valor).trim();
  return (s === "") ? "N/A" : s;
}

/*
 * CLAVE: un estado desconocido o ausente se degrada a "No Aplica", NUNCA a "Cumple".
 * Ese default optimista era lo que convertia un payload perdido en un certificado
 * de conformidad falso.
 */
function limpiarEstado(valor) {
  var s = String(valor === null || valor === undefined ? "" : valor).trim();
  if (s === "Cumple" || s === "No Cumple" || s === "No Aplica") return s;
  return "No Aplica";
}

// Devuelve ["Peso - cavidad 1", "Espesor - cavidades 3, 7", ...]
function listarDesviaciones(cavidades) {
  var porEtiqueta = {};

  for (var c = 0; c < cavidades.length; c++) {
    for (var m = 0; m < MEDICIONES_ORDEN.length; m++) {
      var clave = MEDICIONES_ORDEN[m];
      if (cavidades[c][clave + "_val"] === "No Cumple") {
        var etiqueta = MEDICIONES_ETIQUETAS[m];
        if (!porEtiqueta[etiqueta]) porEtiqueta[etiqueta] = [];
        if (porEtiqueta[etiqueta].indexOf(cavidades[c].cavidad) === -1) {
          porEtiqueta[etiqueta].push(cavidades[c].cavidad);
        }
      }
    }
  }

  var salida = [];
  for (var e in porEtiqueta) {
    var lista = porEtiqueta[e].sort(function (a, b) { return a - b; });
    salida.push(e + " - " + (lista.length === 1 ? "cavidad " : "cavidades ") + lista.join(", "));
  }
  return salida;
}

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

  // Terreno ya habia sembrado una fila por cavidad: se eliminan para no dejar
  // detalle huerfano acumulandose en la hoja.
  var sheetDet = ss.getSheetByName("Inspecciones_Detalle");
  var borradas = sheetDet ? eliminarDetallePorRonda(sheetDet, data.idRonda) : 0;

  return { status: "success", id: data.idRonda, detalleEliminado: borradas };
}

function eliminarDetallePorRonda(sheetDet, idRonda) {
  var datos = sheetDet.getDataRange().getValues();
  var borradas = 0;
  // De abajo hacia arriba: borrar filas desplaza los indices siguientes.
  for (var i = datos.length - 1; i >= 1; i--) {
    if (String(datos[i][1]) === String(idRonda)) {
      sheetDet.deleteRow(i + 1);
      borradas++;
    }
  }
  return borradas;
}

/*
 * Registra una MAQUINA DETENIDA como un evento puntual del turno.
 *
 * Se escribe una fila en "Inspecciones_Cabecera" con estado "Detenida" que se abre
 * y se cierra en el mismo instante: no queda pendiente de laboratorio, no genera
 * fila en "Inspecciones_Detalle" y no produce PDF individual.
 *
 * IMPORTANTE: el estado vive en la FILA, no en la maquina. Registrar una detencion
 * NO marca la maquina como detenida hacia el futuro ni bloquea las inspecciones
 * posteriores; solo describe como estaba esa maquina a esa hora.
 */
function registrarDetencion(data) {
  if (!data.idRonda) return { status: "error", message: "Falta idRonda." };
  if (!data.id_maquina) return { status: "error", message: "Falta la maquina detenida." };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetCab = ss.getSheetByName("Inspecciones_Cabecera");
  if (!sheetCab) return { status: "error", message: "No existe la hoja Inspecciones_Cabecera." };

  // IDEMPOTENCIA (ver crearRonda): un reintento de la cola no debe duplicar el paro.
  var filaPrevia = encontrarFilaPorId(sheetCab, data.idRonda, 0);
  if (filaPrevia !== -1) {
    var previa = sheetCab.getRange(filaPrevia, 1, 1, 25).getValues()[0];
    return {
      status: "success",
      id: data.idRonda,
      duplicado: true,
      maquina: String(previa[5]),
      turno: String(previa[3]),
      hora: String(previa[2]).slice(11) || String(previa[2]),
      motivo: extraerMotivoDetencion(previa[10]),
      correlativoMaquina: previa[15]
    };
  }

  var infoTiempo = getInfoTurnoOperativo(new Date());
  var correlativo = reservarCorrelativos(CLAVE_CORR_CAB, 1, sheetCab, 2);
  var correlativoMaquina = contarRondasMaquinaTurno(
    sheetCab, data.id_maquina, infoTiempo.fechaOperativa, infoTiempo.turno) + 1;

  var motivo = String(data.motivo_parada || "").trim();
  var observaciones = String(data.observaciones || "").trim();
  if (!observaciones) {
    observaciones = "[DETENIDA - " + (motivo || "Sin motivo especificado") + "]";
  }

  sheetCab.appendRow([
    data.idRonda,                  // A  idInspeccion (DETENIDA-<timestamp>)
    correlativo,                   // B  correlativo global
    infoTiempo.fechaHoraCompleta,  // C  fecha/hora exacta del paro
    infoTiempo.turno,              // D  turno operativo
    data.inspector_calidad || "",  // E  inspector que constata la detencion
    data.id_maquina,               // F  maquina
    "N/A",                         // G  producto      (no aplica)
    "N/A",                         // H  operario      (no aplica)
    "N/A",                         // I  lote MP       (no aplica)
    "N/A",                         // J  lote BXA      (no aplica)
    observaciones,                 // K  [DETENIDA - Causa]: Detalle
    "",                            // L  sin PDF individual
    "Detenida",                    // M  estado
    "",                            // N  sin inspector de laboratorio
    infoTiempo.fechaHoraCompleta,  // O  evento puntual: se cierra en el mismo instante
    correlativoMaquina,            // P  correlativo por maquina/turno
    "N/A",                         // Q  cavidades     (no aplica)
    "N/A", "No Aplica",            // R/S  color
    "N/A", "No Aplica",            // T/U  ciclo
    "N/A", "No Aplica",            // V/W  peso
    "N/A", "No Aplica",            // X/Y  probador
    // ACTA: una detencion tambien lleva accion correctiva y responsable.
    data.accion_correctiva || "",   // Z
    data.responsable || ""          // AA
  ]);

  return {
    status: "success",
    id: data.idRonda,
    maquina: String(data.id_maquina),
    turno: infoTiempo.turno,
    hora: infoTiempo.horaExacta,
    motivo: motivo || extraerMotivoDetencion(observaciones),
    correlativoMaquina: correlativoMaquina
  };
}

// "[DETENIDA - Cambio de Molde]: paso a formato 500cc"  ->  "Cambio de Molde"
function extraerMotivoDetencion(observaciones) {
  var txt = String(observaciones || "").trim();
  var m = txt.match(/^\[DETENIDA\s*-\s*([^\]]*)\]/);
  if (m && m[1].trim()) return m[1].trim();
  return "Sin motivo especificado";
}

// "[DETENIDA - Cambio de Molde]: paso a formato 500cc"  ->  "paso a formato 500cc"
function extraerDetalleDetencion(observaciones) {
  var txt = String(observaciones || "").trim();
  var i = txt.indexOf("]:");
  if (i !== -1) return txt.substring(i + 2).trim();
  return "";
}

function contarDetallePorRonda(sheetDet, idRonda) {
  if (!sheetDet) return 0;
  var datos = sheetDet.getDataRange().getValues();
  var total = 0;
  for (var i = 1; i < datos.length; i++) {
    if (String(datos[i][1]) === String(idRonda)) total++;
  }
  return total;
}

function encontrarFilaPorId(sheet, id, col0) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][col0]) === String(id)) return i + 1;
  }
  return -1;
}

// { "Peso": [3,7] }  ->  ["Peso (cav 3, 7)"]
function resumirFallas(mapa) {
  var salida = [];
  for (var etiqueta in mapa) {
    var cavs = mapa[etiqueta].sort(function (a, b) { return a - b; });
    salida.push(etiqueta + " (cav " + cavs.join(", ") + ")");
  }
  return salida;
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

/*
 * PDF individual de la ronda, ahora con desglose POR CAVIDAD.
 *
 * @param cavidades  array [{cavidad, <clave>_med, <clave>_val}, ...] con los ensayos
 *                   de laboratorio de cada cavidad (ver normalizarMedicionesLab).
 *
 * Estructura del reporte:
 *   1. Ficha de identificacion de la ronda
 *   2. Dictamen de conformidad (CONFORME / CON DESVIACIONES + detalle)
 *   3. Seccion A: chequeo en maquina (terreno)
 *   4. Seccion B: matriz de ensayos de laboratorio, una columna por cavidad
 *   5. Observaciones
 */
function crearPDFNativoInseccion(idInspeccion, fechaHora, data, turnoOficial, cavidades) {
  try {
    if (Object.prototype.toString.call(cavidades) !== "[object Array]" || cavidades.length === 0) {
      cavidades = normalizarMedicionesLab(data, Number(data.cavidad_molde) || 1);
    }

    var desviaciones = listarDesviaciones(cavidades);
    var hayDesviaciones = (desviaciones.length > 0);

    // ---------- 2. Dictamen ----------
    var dictamenHTML;
    if (hayDesviaciones) {
      var listaHTML = "";
      for (var t = 0; t < desviaciones.length; t++) {
        listaHTML += '<li style="margin-bottom:2px;"><b>' + desviaciones[t] + '</b></li>';
      }
      dictamenHTML = '' +
        '<div class="dict dict-nok">' +
          '<div class="dict-tit">&#10007; PRODUCTO CON DESVIACIONES (' + desviaciones.length + ')</div>' +
          '<ul style="margin:4px 0 0 16px; padding:0;">' + listaHTML + '</ul>' +
        '</div>';
    } else {
      dictamenHTML = '' +
        '<div class="dict dict-ok">' +
          '<div class="dict-tit">&#10003; CONFORME &#8212; todas las caracteristicas evaluadas dentro de especificacion</div>' +
        '</div>';
    }

    // ---------- 3 y 4. Matrices por cavidad ----------
    var terrenoHTML = matrizPorCavidadHTML(cavidades, "terreno", "Chequeo en Maquina");
    var labHTML = matrizPorCavidadHTML(cavidades, "laboratorio", "Ensayo de Laboratorio");

    var ensayadas = cavidades.length;
    var declaradas = Number(data.cavidad_molde) || ensayadas;
    var avisoCavidades = (ensayadas !== declaradas)
      ? '<div class="aviso">&#9888; El molde declara ' + declaradas + ' cavidades y se registraron ensayos de ' + ensayadas + '.</div>'
      : '';

    var htmlContent = '' +
      '<html><head><style>' +
        'body { font-family: Arial, sans-serif; color:#0f172a; margin:15px; font-size:10px; }' +
        '.title-area { text-align:center; border-bottom:2px solid #0284c7; padding-bottom:5px; margin-bottom:10px; }' +
        '.title-area h1 { font-size:14px; margin:0; color:#0f172a; font-weight:bold; }' +
        '.title-area p { font-size:9.5px; margin:2px 0 0 0; color:#0284c7; font-weight:bold; }' +
        '.info-table { width:100%; border-collapse:collapse; margin-bottom:10px; font-size:9.5px; }' +
        '.info-table td { padding:5px 8px; border:1px solid #cbd5e1; }' +
        '.lbl { font-weight:bold; color:#1e293b; background-color:#f1f5f9; width:18%; }' +
        '.val { color:#0f172a; width:32%; }' +
        '.dict { border-radius:4px; padding:8px 10px; margin-bottom:10px; }' +
        '.dict-tit { font-size:11px; font-weight:bold; }' +
        '.dict-ok { background-color:#f0fdf4; border:1px solid #15803d; color:#15803d; }' +
        '.dict-nok { background-color:#fef2f2; border:1px solid #b91c1c; color:#b91c1c; }' +
        '.sec-header { font-size:10.5px; font-weight:bold; color:#0284c7; margin:12px 0 4px 0; border-bottom:1px solid #0284c7; padding-bottom:3px; }' +
        '.nota { font-size:8.5px; color:#64748b; margin:0 0 4px 0; }' +
        '.aviso { font-size:9px; color:#b45309; background-color:#fffbeb; border:1px solid #f59e0b; border-radius:3px; padding:5px 8px; margin-bottom:8px; }' +
        'table.specs-table, table.matriz { width:100%; border-collapse:collapse; margin-top:4px; margin-bottom:8px; font-size:9px; }' +
        'table.specs-table th, table.matriz th { background-color:#0f172a; color:#fff; padding:5px; text-align:left; border:1px solid #0f172a; }' +
        'td.nom { padding:5px; border:1px solid #cbd5e1; font-weight:bold; color:#0f172a; }' +
        'td.dato { padding:5px; border:1px solid #cbd5e1; color:#334155; }' +
        '.leyenda { font-size:8.5px; color:#475569; margin-top:2px; }' +
        '.leyenda span { padding:1px 5px; border-radius:2px; margin-right:6px; }' +
        '.obs-box { background-color:#f8fafc; border:1px solid #cbd5e1; border-radius:4px; padding:8px; margin-top:10px; font-size:9px; }' +
      '</style></head><body>' +

      '<div class="title-area">' +
        '<h1>CONTROL DE CALIDAD - PLANTA DE MOLDEO</h1>' +
        '<p>REGISTRO TECNICO OFICIAL DE INSPECCION EN PROCESO (' + escaparHTML(idInspeccion) + ')</p>' +
      '</div>' +

      '<table class="info-table">' +
        '<tr><td class="lbl">Fecha / Hora Ronda:</td><td class="val">' + escaparHTML(fechaHora) + '</td>' +
            '<td class="lbl">Inspector Terreno:</td><td class="val">' + escaparHTML(data.inspector_calidad || "-") + '</td></tr>' +
        '<tr><td class="lbl">Maquina:</td><td class="val">' + escaparHTML(data.id_maquina || "-") + '</td>' +
            '<td class="lbl">Inspector Laboratorio:</td><td class="val">' + escaparHTML(data.inspector_lab || "-") + '</td></tr>' +
        '<tr><td class="lbl">Producto:</td><td class="val">' + escaparHTML(data.id_producto || "-") + '</td>' +
            '<td class="lbl">Operario:</td><td class="val">' + escaparHTML(data.operario || "Sin especificar") + '</td></tr>' +
        '<tr><td class="lbl">Lote MP:</td><td class="val">' + escaparHTML(data.lote_mp || "-") + '</td>' +
            '<td class="lbl">Turno:</td><td class="val">' + escaparHTML(turnoOficial) + '</td></tr>' +
        '<tr><td class="lbl">Lote BXA:</td><td class="val">' + escaparHTML(data.lote_bxa || "-") + '</td>' +
            '<td class="lbl">Cavidades ensayadas:</td><td class="val"><b>' + ensayadas + ' de ' + declaradas + '</b></td></tr>' +
      '</table>' +

      avisoCavidades +
      dictamenHTML +

      '<div class="sec-header">A. CHEQUEO EN MAQUINA (TERRENO) - POR CAVIDAD</div>' +
      '<p class="nota">Registrado por el inspector de terreno durante la ronda, cavidad por cavidad.</p>' +
      terrenoHTML +

      '<div class="sec-header">B. ENSAYOS DE LABORATORIO POR CAVIDAD</div>' +
      '<p class="nota">Cada columna es una cavidad del molde. El valor mostrado es la medicion real registrada.</p>' +
      labHTML +
      '<div class="leyenda">' +
        '<span style="background-color:#dcfce7; color:#15803d; font-weight:bold;">valor</span> Cumple' +
        '<span style="background-color:#fee2e2; color:#b91c1c; font-weight:bold; margin-left:10px;">valor &#10007;</span> No Cumple' +
        '<span style="background-color:#f1f5f9; color:#94a3b8; margin-left:10px;">N/A</span> No Aplica / no ensayado' +
      '</div>' +

      '<div class="obs-box">' +
        '<strong style="color:#0f172a;">Observaciones Adicionales:</strong><br>' +
        '<span style="color:#334155;">' + escaparHTML(data.observaciones || "Sin observaciones registradas.") + '</span>' +
      '</div>' +

      '</body></html>';

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

// Celda de la matriz: valor real + color segun estado. El simbolo extra permite
// distinguir Cumple de No Cumple aunque el PDF se imprima en blanco y negro.
/*
 * Matriz medicion x cavidad. Se parte en bloques de 6 columnas para que quepa
 * en hoja vertical (24 cavidades -> 4 tablas).
 */
function matrizPorCavidadHTML(cavidades, grupoMediciones, tituloColumna) {
  var esTerreno = (grupoMediciones === "terreno");
  var BLOQUE = 6;
  var html = "";

  for (var ini = 0; ini < cavidades.length; ini += BLOQUE) {
    var grupo = cavidades.slice(ini, ini + BLOQUE);
    var ancho = Math.floor(66 / grupo.length);

    html += '<table class="matriz"><thead><tr><th style="width:34%;">' + tituloColumna + '</th>';
    for (var g = 0; g < grupo.length; g++) {
      html += '<th style="width:' + ancho + '%; text-align:center;">CAV ' + grupo[g].cavidad + '</th>';
    }
    html += '</tr></thead><tbody>';

    for (var m = 0; m < MEDICIONES_ORDEN.length; m++) {
      var clave = MEDICIONES_ORDEN[m];
      var deTerreno = (MEDICIONES_TERRENO.indexOf(clave) !== -1);
      if (deTerreno !== esTerreno) continue;

      html += '<tr><td class="nom">' + MEDICIONES_ETIQUETAS[m] + '</td>';
      for (var h = 0; h < grupo.length; h++) {
        html += celdaMedicionHTML(grupo[h][clave + "_med"], grupo[h][clave + "_val"]);
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
  }
  return html;
}

function celdaMedicionHTML(medicion, estadoCrudo) {
  var estado = limpiarEstado(estadoCrudo);
  var texto = escaparHTML(limpiarMedicion(medicion));
  var css;

  if (estado === "No Cumple") {
    css = "background-color:#fee2e2; color:#b91c1c; font-weight:bold;";
    texto = texto + " &#10007;";
  } else if (estado === "No Aplica") {
    css = "background-color:#f1f5f9; color:#94a3b8;";
    texto = "N/A";
  } else {
    css = "background-color:#dcfce7; color:#15803d; font-weight:bold;";
  }
  return '<td style="border:1px solid #cbd5e1; padding:4px; text-align:center; ' + css + '">' + texto + '</td>';
}

function badgeEstadoHTML(estadoCrudo) {
  var estado = limpiarEstado(estadoCrudo);
  var css;
  if (estado === "No Cumple") css = "background-color:#b91c1c; color:#ffffff;";
  else if (estado === "No Aplica") css = "background-color:#94a3b8; color:#ffffff;";
  else css = "background-color:#15803d; color:#ffffff;";

  return '<td style="padding:5px; border:1px solid #cbd5e1; text-align:center;">' +
           '<span style="' + css + ' padding:3px 6px; border-radius:3px; font-weight:bold; font-size:8.5px; display:block;">' +
             estado.toUpperCase() +
           '</span></td>';
}

// Los datos vienen de la planilla y pueden traer < o &: sin escapar rompen el PDF.
function escaparHTML(valor) {
  return String(valor === null || valor === undefined ? "" : valor)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Consolida por maquina el turno indicado, con desglose POR CAVIDAD.
 *
 * @param turnoParam  "Turno Mañana" | "Turno Noche". Si viene vacio se usa el actual.
 * @param fechaParam  "yyyy-MM-dd" de la fecha OPERATIVA. Si viene vacia se usa la actual.
 *
 * Estructura del informe:
 *   1. Ficha de identificacion (maquina, producto, turno, lotes)
 *   2. Indicadores del turno
 *   3. Matriz de evolucion: una columna por ronda
 *   4. Analisis de cambios entre primera y ultima ronda
 *   5. Detalle por cavidad: una matriz por ronda, una columna por cavidad
 *   6. Detenciones y detalle de rondas
 *
 * Por que el detalle por cavidad va en su propia seccion y no dentro de la
 * matriz de evolucion: esa matriz existe para ver como se movio el proceso a lo
 * largo del turno. Meter ahi las cavidades daria rondas x cavidades columnas
 * (3 rondas y 8 cavidades son 24) y el PDF se vuelve ilegible.
 */
function generarPDFsPorMaquinaTurno(turnoParam, fechaParam) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetCab = ss.getSheetByName("Inspecciones_Cabecera");
  var sheetDet = ss.getSheetByName("Inspecciones_Detalle");
  var dataCab = sheetCab.getDataRange().getValues();
  var dataDet = sheetDet ? sheetDet.getDataRange().getValues() : [];

  if (dataCab.length <= 1) {
    return { status: "empty", message: "No hay registros guardados en la planilla." };
  }

  // ------------------------------------------------------------------
  // 1. Detalle por cavidad
  // ------------------------------------------------------------------
  /*
   * Se recorre Inspecciones_Detalle UNA sola vez y se arma, por ronda, el
   * arreglo de cavidades con el mismo formato que consume matrizPorCavidadHTML:
   *   { cavidad: n, <clave>_med: valor medido, <clave>_val: estado }
   *
   * Columnas de la hoja: 0 idDetalle | 1 idInspeccion | 2 cavidad |
   *                      3..15 estados | 16..28 mediciones
   */
  var cavidadesPorId = {};
  var fallasPorId = {};

  for (var d = 1; d < dataDet.length; d++) {
    if (!dataDet[d][1]) continue;

    var idDet = String(dataDet[d][1]);
    var nroCav = Number(dataDet[d][2]) || 1;

    var reg = { cavidad: nroCav };
    for (var m = 0; m < MEDICIONES_ORDEN.length; m++) {
      reg[MEDICIONES_ORDEN[m] + "_val"] = dataDet[d][3 + m];
      reg[MEDICIONES_ORDEN[m] + "_med"] = dataDet[d][16 + m];
    }
    if (!cavidadesPorId[idDet]) cavidadesPorId[idDet] = [];
    cavidadesPorId[idDet].push(reg);

    // Que cavidad fallo y en que variable. Agrupado para que una cavidad mala
    // no quede tapada por otra buena de la misma ronda.
    if (!fallasPorId[idDet]) fallasPorId[idDet] = {};
    for (var v = 0; v < MEDICIONES_ORDEN.length; v++) {
      if (String(dataDet[d][3 + v]) !== "No Cumple") continue;
      var etiqueta = MEDICIONES_ETIQUETAS[v];
      if (!fallasPorId[idDet][etiqueta]) fallasPorId[idDet][etiqueta] = [];
      if (fallasPorId[idDet][etiqueta].indexOf(nroCav) === -1) {
        fallasPorId[idDet][etiqueta].push(nroCav);
      }
    }
  }

  for (var idOrd in cavidadesPorId) {
    cavidadesPorId[idOrd].sort(function (a, b) { return a.cavidad - b.cavidad; });
  }

  var noCumplePorId = {};
  for (var idF in fallasPorId) noCumplePorId[idF] = resumirFallas(fallasPorId[idF]);

  // ------------------------------------------------------------------
  // 2. Especificaciones tecnicas por producto
  // ------------------------------------------------------------------
  var specsPorProducto = leerSpecsParaConsolidado(ss);

  // ------------------------------------------------------------------
  // 3. Turno y fecha objetivo
  // ------------------------------------------------------------------
  var infoActual = getInfoTurnoOperativo(new Date());

  if (turnoParam && !normalizarTurno(turnoParam)) {
    return { status: "error", message: "Turno no reconocido: '" + turnoParam + "'." };
  }
  if (fechaParam && !normalizarFechaOperativa(fechaParam)) {
    return { status: "error", message: "Fecha operativa inválida: '" + fechaParam + "' (se espera yyyy-MM-dd)." };
  }

  var turnoObjetivo = normalizarTurno(turnoParam) || infoActual.turno;
  var fechaObjetivo = normalizarFechaOperativa(fechaParam) || infoActual.fechaOperativa;

  // ------------------------------------------------------------------
  // 4. Agrupar rondas por maquina
  // ------------------------------------------------------------------
  var registrosPorMaquina = {};
  var totalAgrupados = 0;

  for (var i = 1; i < dataCab.length; i++) {
    if (!dataCab[i][2]) continue;
    var estado = String(dataCab[i][12] || "").trim() || "Cerrada";
    if (estado === "Cancelada") continue;

    var infoFila = getInfoTurnoOperativo(dataCab[i][2]);
    if (infoFila.fechaOperativa !== fechaObjetivo || infoFila.turno !== turnoObjetivo) continue;

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
      cavidadMolde: dataCab[i][16] || "",
      noCumple: noCumplePorId[idInspeccion] || [],
      cavidades: cavidadesPorId[idInspeccion] || [],
      esDetencion: (estado === "Detenida"),
      motivoDetencion: (estado === "Detenida") ? extraerMotivoDetencion(dataCab[i][10]) : "",
      detalleDetencion: (estado === "Detenida") ? extraerDetalleDetencion(dataCab[i][10]) : ""
    });
    totalAgrupados++;
  }

  if (totalAgrupados === 0) {
    return {
      status: "warning",
      turno: turnoObjetivo,
      fechaOperativa: fechaObjetivo,
      message: "No hay registros para " + turnoObjetivo + " del " + fechaObjetivo + "."
    };
  }

  // ------------------------------------------------------------------
  // 5. Un PDF por maquina
  // ------------------------------------------------------------------
  var folderName = "Inspecciones_PDF";
  var folders = DriveApp.getFoldersByName(folderName);
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
  var pdfsGenerados = 0;

  for (var maquinaKey in registrosPorMaquina) {
    var listaMaq = registrosPorMaquina[maquinaKey];

    // Cronologico: la matriz de evolucion no significa nada desordenada.
    listaMaq.sort(function (a, b) { return String(a.hora) < String(b.hora) ? -1 : 1; });

    var html = consolidadoMaquinaHTML(
      maquinaKey, listaMaq, turnoObjetivo, fechaObjetivo, specsPorProducto
    );

    // Sanitizacion identica a la version anterior: cualquier caracter que no sea
    // alfanumerico pasa a "_". Cambiarla alteraria los nombres y el Portal Calidad
    // dejaria de reconocer el patron Consolidado_<maquina>_<fecha>_<turno>.
    var nombre = "Consolidado_" + String(maquinaKey).replace(/[^a-zA-Z0-9]/g, "_") +
                 "_" + fechaObjetivo + "_" + turnoObjetivo.replace(/\s+/g, "_") + ".pdf";

    var blob = Utilities.newBlob(html, "text/html", "consolidado.html").getAs("application/pdf");
    blob.setName(nombre);
    folder.createFile(blob);
    pdfsGenerados++;
  }

  // Mismas claves que la version anterior: app.js lee d.count y d.registros para
  // armar el mensaje de confirmacion. Cambiarlas romperia ese aviso.
  return {
    status: "success",
    count: pdfsGenerados,
    turno: turnoObjetivo,
    fechaOperativa: fechaObjetivo,
    registros: totalAgrupados,
    folderUrl: folder.getUrl()
  };
}


/**
 * Texto de especificacion por producto y por medicion, para la columna
 * "ESPECIFICACION TECNICA" de la matriz de evolucion.
 *
 * Se indexa por nombre Y por id porque la cabecera de inspeccion guarda el
 * nombre del producto, pero no siempre coincide exactamente con la primera
 * columna de Productos_Specs.
 */
function leerSpecsParaConsolidado(ss) {
  var hoja = ss.getSheetByName("Productos_Specs");
  if (!hoja) return {};

  var filas = hoja.getDataRange().getValues();
  var mapa = {};

  // Medicion -> columna de Productos_Specs. Las que no tienen especificacion
  // numerica (calce, filtracion, probador, caida) quedan fuera a proposito.
  var COLUMNAS = {
    peso: 2, espesor: 3, phi_int: 4, hcuello: 5,
    color: 6, ciclo: 7, phi_hilo: 8, phi_trinquete: 10, rebalse: 11
  };

  for (var i = 1; i < filas.length; i++) {
    if (!filas[i][0]) continue;

    var specs = {};
    for (var clave in COLUMNAS) {
      var valor = filas[i][COLUMNAS[clave]];
      specs[clave] = (valor === null || valor === undefined || String(valor).trim() === "")
        ? "-" : String(valor).trim();
    }

    mapa[String(filas[i][0]).trim()] = specs;
    if (filas[i][1]) mapa[String(filas[i][1]).trim()] = specs;
  }
  return mapa;
}


/** Arma el HTML completo del consolidado de UNA maquina. */
function consolidadoMaquinaHTML(maquina, lista, turno, fecha, specsPorProducto) {

  var cerradas = 0, pendientes = 0, conDesviacion = 0, detenciones = 0;
  for (var q = 0; q < lista.length; q++) {
    if (lista[q].esDetencion) detenciones++;
    else if (lista[q].estado === "Cerrada") cerradas++;
    else pendientes++;
    if (lista[q].noCumple && lista[q].noCumple.length) conDesviacion++;
  }

  var rondas = lista.filter(function (r) { return !r.esDetencion; });
  var primera = rondas.length ? rondas[0] : lista[0];
  var ultima = rondas.length ? rondas[rondas.length - 1] : lista[lista.length - 1];
  var specs = specsPorProducto[String(primera.producto || "").trim()] || {};

  // ---------- Ficha ----------
  var ficha =
    '<table class="info">' +
      '<tr><td class="lbl">Máquina</td><td class="val">' + escaparHTML(maquina) + '</td>' +
          '<td class="lbl">Producto</td><td class="val">' + escaparHTML(primera.producto || "-") + '</td></tr>' +
      '<tr><td class="lbl">Fecha</td><td class="val">' + escaparHTML(fecha) + '</td>' +
          '<td class="lbl">Turno</td><td class="val">' + escaparHTML(turno) + '</td></tr>' +
      '<tr><td class="lbl">Primera ronda</td><td class="val">' + escaparHTML(primera.hora || "-") + '</td>' +
          '<td class="lbl">Última ronda</td><td class="val">' + escaparHTML(ultima.hora || "-") + '</td></tr>' +
      '<tr><td class="lbl">Operario</td><td class="val">' + escaparHTML(primera.operario || "-") + '</td>' +
          '<td class="lbl">Lote MP</td><td class="val">' + escaparHTML(primera.loteMp || "-") + '</td></tr>' +
      '<tr><td class="lbl">Lote BXA</td><td class="val" colspan="3">' + escaparHTML(primera.loteBxa || "-") + '</td></tr>' +
    '</table>';

  // ---------- Indicadores ----------
  var kpis =
    '<table class="kpis"><tr>' +
      kpiHTML(lista.length, "RONDAS", "#0f172a") +
      kpiHTML(cerradas, "CERRADAS", "#15803d") +
      kpiHTML(pendientes, "PENDIENTES", "#d97706") +
      kpiHTML(conDesviacion, "CON DESVIACIÓN", conDesviacion ? "#b91c1c" : "#15803d") +
    '</tr></table>';

  // ---------- Matriz de evolucion ----------
  var evolucion = evolucionHTML(rondas, specs);

  // ---------- Analisis de cambios ----------
  var cambios = analisisCambiosHTML(rondas);

  // ---------- Detalle por cavidad ----------
  var porCavidad = "";
  for (var r = 0; r < rondas.length; r++) {
    var cavs = rondas[r].cavidades;
    if (!cavs || !cavs.length) continue;

    porCavidad +=
      '<div class="ronda-cav">' +
        '<div class="ronda-tit">RONDA ' + escaparHTML(rondas[r].hora) +
          ' &#8212; ' + cavs.length + (cavs.length === 1 ? ' cavidad ensayada' : ' cavidades ensayadas') +
        '</div>' +
        matrizPorCavidadHTML(cavs, "terreno", "Chequeo en Máquina") +
        matrizPorCavidadHTML(cavs, "laboratorio", "Ensayo de Laboratorio") +
      '</div>';
  }
  if (porCavidad) {
    porCavidad = '<div class="sec">DETALLE POR CAVIDAD</div>' + porCavidad;
  }

  // ---------- Detenciones ----------
  var bloqueDetenciones = "";
  if (detenciones > 0) {
    bloqueDetenciones =
      '<div class="det-box">' +
        '<div class="det-title">&#9940; DETENCIONES REGISTRADAS EN ESTE TURNO (' + detenciones + ')</div>' +
        '<table class="det-table"><thead><tr>' +
          '<th style="width:12%;">Hora</th><th style="width:33%;">Motivo</th>' +
          '<th>Detalle</th><th style="width:18%;">Registro</th>' +
        '</tr></thead><tbody>';
    for (var dd = 0; dd < lista.length; dd++) {
      if (!lista[dd].esDetencion) continue;
      bloqueDetenciones +=
        '<tr><td><b>' + escaparHTML(lista[dd].hora) + '</b></td>' +
        '<td><b>' + escaparHTML(lista[dd].motivoDetencion) + '</b></td>' +
        '<td>' + escaparHTML(lista[dd].detalleDetencion || "Sin detalle adicional.") + '</td>' +
        '<td>' + escaparHTML(lista[dd].inspector || "-") + '</td></tr>';
    }
    bloqueDetenciones += '</tbody></table></div>';
  }

  // ---------- Detalle de rondas ----------
  var detalleRondas = '<div class="sec">DETALLE DE LAS RONDAS</div>';
  for (var k = 0; k < rondas.length; k++) {
    var ro = rondas[k];
    var conforme = !(ro.noCumple && ro.noCumple.length);

    detalleRondas +=
      '<div class="ronda">' +
        '<div class="ronda-head ' + (conforme ? "ok" : "nok") + '">' +
          'RONDA ' + escaparHTML(ro.hora) + ' &#8212; ' +
          (conforme ? '&#10003; CONFORME' : '&#10007; CON DESVIACIONES') +
        '</div>' +
        '<table class="info">' +
          '<tr><td class="lbl">Inspector Terreno</td><td class="val">' + escaparHTML(ro.inspector || "-") + '</td>' +
              '<td class="lbl">Inspector Laboratorio</td><td class="val">' + escaparHTML(ro.inspectorLab || "-") + '</td></tr>' +
          '<tr><td class="lbl">Operario</td><td class="val">' + escaparHTML(ro.operario || "-") + '</td>' +
              '<td class="lbl">Cavidades ensayadas</td><td class="val">' + (ro.cavidades ? ro.cavidades.length : 0) + '</td></tr>' +
          '<tr><td class="lbl">Lote MP</td><td class="val">' + escaparHTML(ro.loteMp || "-") + '</td>' +
              '<td class="lbl">Lote BXA</td><td class="val">' + escaparHTML(ro.loteBxa || "-") + '</td></tr>' +
        '</table>';

    if (!conforme) {
      detalleRondas += '<div class="desv"><b>Desviaciones:</b> ' +
        escaparHTML(ro.noCumple.join(" | ")) + '</div>';
    }
    detalleRondas += '</div>';
  }

  return '' +
    '<html><head><meta charset="UTF-8"><style>' +
      'body { font-family: Arial, sans-serif; color:#0f172a; margin:15px; font-size:10px; }' +
      '.header { border-bottom:3px solid #0284c7; padding-bottom:6px; margin-bottom:10px; text-align:center; }' +
      '.header h1 { margin:0; font-size:14px; }' +
      '.header .sub { color:#0284c7; font-weight:bold; font-size:10px; }' +
      '.info { width:100%; border-collapse:collapse; margin-bottom:8px; font-size:9.5px; }' +
      '.info td { padding:4px 7px; border:1px solid #cbd5e1; }' +
      '.lbl { font-weight:bold; background-color:#f1f5f9; width:17%; }' +
      '.val { width:33%; }' +
      '.kpis { width:100%; border-collapse:separate; border-spacing:5px 0; margin-bottom:10px; }' +
      '.kpi { text-align:center; border:1px solid #cbd5e1; border-radius:4px; padding:6px 2px; background:#f8fafc; }' +
      '.kpi .n { font-size:17px; font-weight:bold; display:block; }' +
      '.kpi .t { font-size:7.5px; color:#64748b; letter-spacing:0.04em; }' +
      '.sec { background:#0f172a; color:#fff; font-weight:bold; font-size:10px; padding:4px 8px; margin:12px 0 6px 0; }' +
      '.evo { width:100%; border-collapse:collapse; font-size:8.5px; }' +
      '.evo th { background:#0f172a; color:#fff; padding:4px; border:1px solid #0f172a; text-align:center; }' +
      '.evo th.p { text-align:left; width:14%; }' +
      '.evo td { border:1px solid #cbd5e1; padding:3px; text-align:center; }' +
      '.evo td.p { text-align:left; font-weight:bold; background:#f1f5f9; }' +
      '.evo td.spec { text-align:left; color:#334155; background:#f8fafc; }' +
      '.matriz { width:100%; border-collapse:collapse; font-size:8.5px; margin-bottom:6px; }' +
      '.matriz th { background:#334155; color:#fff; padding:3px; border:1px solid #334155; }' +
      '.matriz td.nom { font-weight:bold; background:#f1f5f9; border:1px solid #cbd5e1; padding:3px 5px; }' +
      '.ronda-cav { margin-bottom:10px; }' +
      '.ronda-tit { font-weight:bold; font-size:9.5px; color:#0284c7; margin:6px 0 3px 0; }' +
      '.ronda { margin-bottom:8px; }' +
      '.ronda-head { font-weight:bold; font-size:9.5px; padding:3px 6px; margin-bottom:3px; }' +
      '.ronda-head.ok { background:#dcfce7; color:#15803d; }' +
      '.ronda-head.nok { background:#fee2e2; color:#b91c1c; }' +
      '.desv { background:#fef2f2; border-left:3px solid #b91c1c; padding:4px 7px; font-size:9px; }' +
      '.cambio { font-size:9px; padding:3px 0; border-bottom:1px dotted #cbd5e1; }' +
      '.det-box { margin-top:12px; border:1px solid #b91c1c; border-radius:4px; padding:7px 9px; background:#fef2f2; }' +
      '.det-title { color:#b91c1c; font-weight:bold; font-size:10px; margin-bottom:5px; }' +
      '.det-table { width:100%; border-collapse:collapse; font-size:9px; }' +
      '.det-table th { background:#b91c1c; color:#fff; padding:4px; border:1px solid #cbd5e1; }' +
      '.det-table td { padding:4px; border:1px solid #cbd5e1; }' +
      '.pie { margin-top:14px; padding-top:5px; border-top:1px solid #cbd5e1; font-size:8px; color:#64748b; text-align:center; }' +
    '</style></head><body>' +
      '<div class="header">' +
        '<h1>CONTROL DE CALIDAD &#8212; INFORME CONSOLIDADO</h1>' +
        '<span class="sub">EVOLUCIÓN DEL PROCESO POR MÁQUINA Y TURNO</span>' +
      '</div>' +
      ficha + kpis +
      '<div class="sec">EVOLUCIÓN DE ESPECIFICACIONES DURANTE EL TURNO</div>' + evolucion +
      cambios +
      porCavidad +
      bloqueDetenciones +
      detalleRondas +
      '<div class="pie">Informe generado automáticamente por el Sistema de Control de Calidad. ' +
        'Máquina: ' + escaparHTML(maquina) + ' | Fecha operativa: ' + escaparHTML(fecha) +
        ' | Turno: ' + escaparHTML(turno) + '</div>' +
    '</body></html>';
}


function kpiHTML(numero, texto, color) {
  return '<td class="kpi"><span class="n" style="color:' + color + ';">' + numero + '</span>' +
         '<span class="t">' + texto + '</span></td>';
}


/**
 * Matriz medicion x ronda.
 *
 * El valor que se muestra es el de la cavidad mas baja de la ronda, porque la
 * columna representa la ronda entera y hay que elegir un representante. El
 * estado, en cambio, se calcula mirando TODAS las cavidades: si alguna no
 * cumple, la celda se marca en rojo. Sin eso, una cavidad fuera de norma podia
 * quedar oculta detras del valor conforme de la cavidad 1.
 */
function evolucionHTML(rondas, specs) {
  if (!rondas.length) return '<p>Sin rondas de inspección en este turno.</p>';

  var html = '<table class="evo"><thead><tr>' +
    '<th class="p">PARÁMETRO</th><th style="width:14%;">ESPECIFICACIÓN TÉCNICA</th>';

  for (var r = 0; r < rondas.length; r++) {
    html += '<th>' + escaparHTML(rondas[r].hora) + '<br>' +
            '<span style="font-weight:normal; font-size:7.5px;">' +
            escaparHTML(rondas[r].id) + '</span></th>';
  }
  html += '</tr></thead><tbody>';

  for (var m = 0; m < MEDICIONES_ORDEN.length; m++) {
    var clave = MEDICIONES_ORDEN[m];

    html += '<tr><td class="p">' + MEDICIONES_ETIQUETAS[m] + '</td>' +
            '<td class="spec">' + escaparHTML(specs[clave] || "-") + '</td>';

    for (var j = 0; j < rondas.length; j++) {
      var cavs = rondas[j].cavidades || [];
      var valor = "-";
      var hayNoCumple = false;
      var todasNA = cavs.length > 0;

      for (var c = 0; c < cavs.length; c++) {
        var estado = limpiarEstado(cavs[c][clave + "_val"]);
        if (estado === "No Cumple") hayNoCumple = true;
        if (estado !== "No Aplica") todasNA = false;
        if (c === 0) valor = limpiarMedicion(cavs[c][clave + "_med"]);
      }

      var css, texto;
      if (hayNoCumple) {
        css = "background-color:#fee2e2; color:#b91c1c; font-weight:bold;";
        texto = escaparHTML(valor) + "<br>&#10007; NO CUMPLE";
      } else if (todasNA) {
        css = "background-color:#f1f5f9; color:#94a3b8;";
        texto = "N/A";
      } else if (!cavs.length) {
        css = "background-color:#f8fafc; color:#94a3b8;";
        texto = "-";
      } else {
        css = "background-color:#dcfce7; color:#15803d;";
        texto = escaparHTML(valor) + "<br>&#10003; CUMPLE";
      }
      html += '<td style="' + css + '">' + texto + '</td>';
    }
    html += '</tr>';
  }

  return html + '</tbody></table>';
}


/**
 * Compara la primera ronda con la ultima y lista lo que se movio.
 * Solo variables numericas: en color o calce un cambio de texto no dice nada
 * sobre deriva del proceso.
 */
function analisisCambiosHTML(rondas) {
  if (rondas.length < 2) return "";

  var primera = rondas[0].cavidades || [];
  var ultima = rondas[rondas.length - 1].cavidades || [];
  if (!primera.length || !ultima.length) return "";

  var lineas = "";

  for (var m = 0; m < MEDICIONES_ORDEN.length; m++) {
    var clave = MEDICIONES_ORDEN[m];

    var a = parseFloat(String(primera[0][clave + "_med"]).replace(",", "."));
    var b = parseFloat(String(ultima[0][clave + "_med"]).replace(",", "."));
    if (isNaN(a) || isNaN(b) || a === b) continue;

    var flecha = (b > a) ? "&#8593;" : "&#8595;";
    var color = (b > a) ? "#b45309" : "#0369a1";

    lineas += '<div class="cambio"><b>' + MEDICIONES_ETIQUETAS[m] + '</b> &#8212; ' +
      escaparHTML(rondas[0].hora) + ': ' + a +
      ' <span style="color:' + color + '; font-weight:bold;">' + flecha + '</span> ' +
      escaparHTML(rondas[rondas.length - 1].hora) + ': ' + b + '</div>';
  }

  if (!lineas) return "";
  return '<div class="sec">ANÁLISIS DE CAMBIOS EN EL PROCESO</div>' + lineas;
}
