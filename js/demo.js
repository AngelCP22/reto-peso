/**
 * demo.js — doble de prueba de la API (seccion 7 del contrato).
 *
 * Script clasico (sin modulos): expone window.Demo. Se carga despues de
 * camara.js y antes que api.js, porque api.js delega en este objeto cuando la
 * URL trae demo=1.
 *
 * Reglas que este archivo cumple por diseno:
 *
 *  - Mismas firmas que Api y misma FORMA de respuesta que el backend real. Si
 *    la demo devolviera una aproximacion, validar el diseno contra ella no
 *    probaria nada.
 *  - Datos deterministas: ni Math.random ni el reloj entran en el contenido.
 *    El azar sale de un generador congruencial con semilla fija, asi que dos
 *    cargas seguidas del mismo dia pintan exactamente los mismos numeros y una
 *    captura de pantalla se puede comparar con la siguiente.
 *  - La fecha de hoy si sale del navegador, pero se lee UNA sola vez al cargar
 *    y todo lo demas (inicio del reto, fin, fechas de cada registro) se deriva
 *    de ella. Sin eso, "hoy" no coincidiria con el dia real y la vista de hoy
 *    no se podria probar.
 *  - Metricas calculadas de verdad con las reglas de la seccion 6 sobre los
 *    datos sembrados. Nada de porcentajes escritos a mano.
 *  - Cero acceso a la red, cero DOM, cero console.*, cero base64 de fotos
 *    guardado en memoria.
 */
(function () {
  'use strict';

  // --------------------------------------------------------------- ajustes --

  var VERSION = (window.RETO_CONFIG && window.RETO_CONFIG.VERSION) || '1.0.0';
  var ESTADO_PEDIDO = (window.RETO_CONFIG && window.RETO_CONFIG.DEMO_ESTADO) || 'normal';

  var ZONA = 'America/Lima';
  var DESPLAZAMIENTO_ZONA = '-05:00'; // Lima no tiene horario de verano.

  var DIAS_ANTES_DEL_INICIO = 40;  // el reto arranco hace 40 dias
  var SEMANAS_DE_RETO = 12;        // y dura 12 semanas
  var DIAS_DE_RETO = SEMANAS_DE_RETO * 7;

  var SEMILLA_DATOS = 20260904;   // fija: cambiarla reescribe todos los datos
  var SEMILLA_RETARDO = 777001;   // corriente aparte, para no mover los datos
  var RUIDO_KG = 0.6;             // ruido diario de +/- 0,6 kg
  var RETARDO_MIN_MS = 250;
  var RETARDO_MAX_MS = 600;

  var LIMITE_HISTORIAL = 100;
  var LIMITE_HISTORIAL_MAX = 500;
  var NOTA_MAX = 280;

  var ANIMOS = ['bien', 'normal', 'mal'];
  var VEREDICTOS = ['ok', 'duda'];
  var ROLES = ['admin', 'participante', 'observador'];

  // Codigos de error de la seccion 7, uno distinto por ruta, para que el estado
  // "error" recorra de verdad los distintos mensajes de la interfaz en vez de
  // repetir siempre ERROR_INTERNO.
  var ERRORES_DE_PRUEBA = {
    salud: ['ERROR_INTERNO', 'El servicio del reto no responde. Vuelve a intentarlo en un momento.', null],
    sesion: ['NO_INSCRITO', 'Tu correo no está en la lista del reto. Pide al administrador que te inscriba.', 'email'],
    poseHoy: ['POSE_NO_ASIGNADA', 'Todavía no hay pose asignada para hoy. Vuelve a entrar en unos minutos.', null],
    registrar: ['DATOS_INVALIDOS', 'El peso no parece válido. Revísalo y vuelve a enviarlo.', 'pesoKg'],
    resumen: ['ERROR_INTERNO', 'No se pudo armar el tablero. Vuelve a intentarlo.', null],
    historial: ['LIMITE_TASA', 'Demasiadas consultas seguidas. Espera un minuto y vuelve a intentarlo.', null],
    foto: ['NO_AUTORIZADO', 'No tienes permiso para ver esta foto.', 'fotoId'],
    verificar: ['NO_AUTORIZADO', 'No puedes verificar este registro.', 'registroId'],
    participantes: ['NO_AUTENTICADO', 'Tu sesión venció. Vuelve a entrar con Google.', null],
    guardarParticipante: ['DATOS_INVALIDOS', 'El correo del participante no es válido.', 'email'],
    anularRegistro: ['REGISTRO_BLOQUEADO', 'Ese registro ya no se puede tocar.', 'registroId'],
    configurar: ['NO_AUTORIZADO', 'Solo el administrador cambia la configuración del reto.', 'clave']
  };

  // Catalogos de poses de la version 1, copiados de lib_pose.gs en el MISMO
  // orden. Aqui solo sirven para pintar poses de mentira legibles: la semilla
  // real (POSE_SEED) vive en el backend y no participa en nada de este archivo.
  var MANOS = ['izquierda', 'derecha'];
  var MANO_ABREV = ['I', 'D'];
  var GESTOS = [
    'puno cerrado', 'palma abierta', 'pulgar arriba', 'dedos en V',
    'senalando arriba', 'dedos levantados', 'mano en la oreja', 'palma en la frente'
  ];
  var GESTO_ABREV = ['PUNO', 'PALMA', 'PULGAR', 'V', 'ARRIBA', 'DEDOS', 'OREJA', 'FRENTE'];
  var GESTO_TEXTO = [
    'con el puño cerrado', 'con la palma abierta', 'con el pulgar arriba',
    'con los dedos en V', 'señalando hacia arriba', '',
    'tocando la oreja', 'con la palma en la frente'
  ];
  var LUGAR_ABREV = ['SIEN', 'PECHO', 'FRENTE_EXT', 'CABEZA'];
  var LUGAR_TEXTO = [
    'junto a la sien', 'sobre el pecho',
    'con el brazo extendido al frente', 'sobre la cabeza'
  ];
  var GESTOS_CON_LUGAR_PROPIO = [6, 7];
  var INDICE_DEDOS = 5;

  // Pose fija que devuelve poseHoy. Coincide con el ejemplo del contrato, asi
  // que sirve de referencia visual del formato del codigo y del texto.
  var POSE_DE_HOY = {
    codigo: 'D-DEDOS3-SIEN',
    texto: 'Mano derecha con 3 dedos levantados, junto a la sien'
  };

  var NOTAS = [
    '45 min de trote suave',
    'Pesas y 20 min de bicicleta',
    'Caminata de una hora con el perro',
    'Día flojo: solo estiramientos',
    'Natación, me siento ligero',
    'Comí fuera, mañana lo compenso',
    'Sin antojos, buen día',
    'Dormí mal pero cumplí',
    'Cardio en ayunas',
    'Descanso activo y mucha agua'
  ];

  var COMENTARIOS_OK = [
    'Se ve clara la pose y el número de la balanza.',
    'Todo en orden, buen avance.',
    'Confirmado, la mano coincide con la pose del día.'
  ];
  var COMENTARIOS_DUDA = [
    'No se distingue bien la mano en la foto.',
    'La pantalla de la balanza sale borrosa, repítela mañana.'
  ];

  // --------------------------------------------------------------- numeros --

  function numeroFinito(x) {
    if (typeof x === 'number') return isFinite(x) ? x : null;
    if (typeof x === 'string') {
      var s = x.trim();
      if (!s) return null;
      var n = Number(s.replace(',', '.'));
      return isFinite(n) ? n : null;
    }
    return null;
  }

  /** Mismo redondeo que lib_metricas: corrige el sesgo binario y es simetrico
   *  en negativos, donde Math.round tira hacia +infinito. */
  function redondear(n, decimales) {
    var valor = numeroFinito(n);
    if (valor === null) return null;
    var d = decimales === undefined ? 2 : decimales;
    var factor = Math.pow(10, d);
    var ajuste = valor >= 0 ? 1e-8 : -1e-8;
    return Math.round(valor * factor + ajuste) / factor;
  }

  function pad2(n) {
    var s = String(Math.abs(Math.trunc(Number(n) || 0)));
    return s.length >= 2 ? s : '0' + s;
  }

  function pad4(n) {
    var s = String(Math.abs(Math.trunc(Number(n) || 0)));
    while (s.length < 4) s = '0' + s;
    return s;
  }

  function acotar(n, minimo, maximo) {
    if (n < minimo) return minimo;
    if (n > maximo) return maximo;
    return n;
  }

  function texto(x) {
    return (x === null || x === undefined) ? '' : String(x);
  }

  function esObjeto(x) {
    return !!x && typeof x === 'object';
  }

  // ---------------------------------------------------------------- fechas --

  var RE_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
  var MS_DIA = 86400000;

  function esISO(s) {
    if (typeof s !== 'string') return false;
    var m = RE_ISO.exec(s.trim());
    if (!m) return false;
    var mes = Number(m[2]);
    var dia = Number(m[3]);
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return false;
    var d = new Date(Date.UTC(Number(m[1]), mes - 1, dia));
    return d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
  }

  /** Acepta 'yyyy-MM-dd', ISO largo o Date. null si no sirve; nunca lanza. */
  function aISO(valor) {
    if (typeof valor === 'string') {
      var s = valor.trim();
      if (s.length > 10) s = s.slice(0, 10);
      return esISO(s) ? s : null;
    }
    if (esObjeto(valor) && typeof valor.getFullYear === 'function') {
      var iso = pad4(valor.getFullYear()) + '-' + pad2(valor.getMonth() + 1) + '-' + pad2(valor.getDate());
      return esISO(iso) ? iso : null;
    }
    return null;
  }

  function msDe(iso) {
    var m = RE_ISO.exec(iso);
    if (!m) return null;
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  /** Suma dias en UTC: el horario de verano no lo puede descuadrar. */
  function sumarDias(iso, dias) {
    var base = msDe(iso);
    if (base === null) return null;
    var d = new Date(base + (Math.trunc(dias) * MS_DIA));
    return pad4(d.getUTCFullYear()) + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function diasEntre(a, b) {
    var ma = msDe(a);
    var mb = msDe(b);
    if (ma === null || mb === null) return null;
    return Math.round((mb - ma) / MS_DIA);
  }

  /** Dias de `desde` a `hasta` contando ambos extremos, como en lib_metricas. */
  function diasInclusive(desde, hasta) {
    var d = diasEntre(desde, hasta);
    if (d === null) return 1;
    return d + 1;
  }

  function comparar(a, b) {
    var ma = msDe(a);
    var mb = msDe(b);
    if (ma === null || mb === null) return 0;
    if (ma === mb) return 0;
    return ma < mb ? -1 : 1;
  }

  function minFecha(a, b) {
    return comparar(a, b) <= 0 ? a : b;
  }

  /** Dia de la semana ISO: 1 lunes ... 7 domingo, igual que DIA_PESADA_OFICIAL. */
  function diaSemanaISO(iso) {
    var ms = msDe(iso);
    if (ms === null) return 0;
    var d = new Date(ms).getUTCDay();
    return d === 0 ? 7 : d;
  }

  /** Sello de tiempo con la zona del reto, para creado_en y revelada_en. */
  function sello(iso, hora, minuto) {
    return iso + 'T' + pad2(hora) + ':' + pad2(minuto) + ':00' + DESPLAZAMIENTO_ZONA;
  }

  // -------------------------------------------------------------- azar fijo --

  /**
   * Generador congruencial lineal con semilla explicita. Se toman los bits
   * altos porque en un LCG los bajos tienen periodo corto y saldrian patrones
   * visibles en la serie de pesos.
   */
  function generador(semilla) {
    var estado = (Math.trunc(semilla) >>> 0) || 1;
    return function () {
      estado = (Math.imul(estado, 1103515245) + 12345) >>> 0;
      return (estado >>> 8) / 16777216;
    };
  }

  /** Entero en [0, tope). */
  function entero(rnd, tope) {
    var t = Math.trunc(tope);
    if (!(t > 0)) return 0;
    var v = Math.floor(rnd() * t);
    return v >= t ? t - 1 : v;
  }

  /** Hash estable de una cadena. Sirve para dar color y forma a cada foto. */
  function hashTexto(s) {
    var h = 2166136261;
    var cadena = texto(s);
    for (var i = 0; i < cadena.length; i++) {
      h ^= cadena.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // ----------------------------------------------------------------- base64 --

  var ALFABETO_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  /** Texto -> bytes UTF-8. Se hace a mano para no depender de TextEncoder ni
   *  de unescape, y para que las tildes de las fotos no salgan rotas. */
  function bytesUtf8(cadena) {
    var s = texto(cadena);
    var bytes = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var bajo = s.charCodeAt(i + 1);
        if (bajo >= 0xdc00 && bajo <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (bajo - 0xdc00);
          i++;
        }
      }
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c < 0x10000) {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      } else {
        bytes.push(
          0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63),
          0x80 | ((c >> 6) & 63), 0x80 | (c & 63)
        );
      }
    }
    return bytes;
  }

  /** base64 propio: btoa no acepta texto con tildes y aqui todo lleva tildes. */
  function base64DeTexto(cadena) {
    var bytes = bytesUtf8(cadena);
    var salida = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i];
      var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
      var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
      salida += ALFABETO_B64.charAt(b0 >> 2);
      salida += ALFABETO_B64.charAt(((b0 & 3) << 4) | (b1 >> 4));
      salida += (i + 1 < bytes.length) ? ALFABETO_B64.charAt(((b1 & 15) << 2) | (b2 >> 6)) : '=';
      salida += (i + 2 < bytes.length) ? ALFABETO_B64.charAt(b2 & 63) : '=';
    }
    return salida;
  }

  /** Escapa para atributo y texto de XML. Las fotos se arman con cadenas, asi
   *  que un id raro del llamador no debe poder romper el SVG. */
  function escaparXml(valor) {
    return texto(valor)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // ---------------------------------------------------------------- errores --

  /**
   * Error con la forma del ErrorApi del contrato. Si api.js ya expuso su propia
   * fabrica se reaprovecha, para que instanceof y el nombre coincidan; si no
   * (api.js se carga despues), se arma aqui con los mismos campos.
   */
  function errorApi(codigo, mensaje, campo) {
    var api = window.Api;
    if (api && typeof api.crearError === 'function') {
      return api.crearError(codigo, mensaje, campo || null);
    }
    var cod = typeof codigo === 'string' && codigo ? codigo : 'ERROR_INTERNO';
    var msj = typeof mensaje === 'string' && mensaje
      ? mensaje
      : 'Ocurrió un error al procesar la solicitud.';
    var cmp = typeof campo === 'string' && campo ? campo : null;
    var e = new Error(cod + ': ' + msj + (cmp ? ' (campo: ' + cmp + ')' : ''));
    e.name = 'ErrorApi';
    e.codigo = cod;
    e.mensaje = msj;
    e.campo = cmp;
    e.esApi = true;
    return e;
  }

  function invalido(mensaje, campo) {
    return errorApi('DATOS_INVALIDOS', mensaje, campo);
  }

  // ---------------------------------------------------------------- retardo --

  var rndRetardo = generador(SEMILLA_RETARDO);

  function esperar(ms) {
    return new Promise(function (resolver) { setTimeout(resolver, ms); });
  }

  /** Retardo de 250 a 600 ms para que se vean los estados de carga. Sale del
   *  generador y no de Math.random, y usa una corriente aparte para que pedir
   *  mas o menos llamadas no altere ni un solo dato sembrado. */
  function retardo() {
    var rango = RETARDO_MAX_MS - RETARDO_MIN_MS + 1;
    return esperar(RETARDO_MIN_MS + entero(rndRetardo, rango));
  }

  // ----------------------------------------------------------------- poses --

  /** Misma derivacion que lib_pose, pero desde un indice cualquiera: aqui solo
   *  hace falta que la pose sea coherente y estable, no impredecible. */
  function poseDeIndices(iMano, iGesto, iLugar, dedos) {
    var conDedos = iGesto === INDICE_DEDOS;
    var gestoAbrev = GESTO_ABREV[iGesto] + (conDedos ? String(dedos) : '');
    var gestoTexto = conDedos
      ? 'con ' + dedos + (dedos === 1 ? ' dedo levantado' : ' dedos levantados')
      : GESTO_TEXTO[iGesto];
    var propio = GESTOS_CON_LUGAR_PROPIO.indexOf(iGesto) !== -1;
    var lugarAbrev = propio ? 'PROPIO' : LUGAR_ABREV[iLugar];
    var lugarTexto = propio ? '' : ', ' + LUGAR_TEXTO[iLugar];
    return {
      codigo: MANO_ABREV[iMano] + '-' + gestoAbrev + '-' + lugarAbrev,
      texto: 'Mano ' + MANOS[iMano] + ' ' + gestoTexto + lugarTexto
    };
  }

  function poseSembrada(rnd) {
    return poseDeIndices(
      entero(rnd, MANOS.length),
      entero(rnd, GESTOS.length),
      entero(rnd, LUGAR_ABREV.length),
      entero(rnd, 5) + 1
    );
  }

  // --------------------------------------------------------------- metricas --

  /**
   * Copia de las reglas de la seccion 6. No se importa lib_metricas.gs porque
   * es codigo de Apps Script y el frontend no lo carga; si alguna regla cambia
   * alla, hay que cambiarla aqui tambien.
   */

  // Forma exacta de un objeto Metricas, en el mismo orden que lib_metricas.gs.
  var CAMPOS_METRICAS = [
    'pesoActualSuavizado', 'pesoBase', 'kgPerdidos', 'pctPerdido',
    'avanceMetaPct', 'tasaSemanalPct', 'semaforoTasa', 'adherenciaPct',
    'racha', 'diasRegistrados', 'diasTranscurridos', 'cinturaActual',
    'cinturaPerdidaCm', 'proyeccionMetaFecha', 'ultimaFecha', 'datosSuficientes'
  ];

  function normalizarSerie(serie) {
    if (!serie || typeof serie.length !== 'number') return [];
    var porFecha = Object.create(null);
    var orden = [];
    for (var i = 0; i < serie.length; i++) {
      var item = serie[i];
      if (!esObjeto(item)) continue;
      var fecha = aISO(item.fecha);
      if (!fecha) continue;
      var peso = numeroFinito(item.pesoKg);
      if (peso === null || peso <= 0) continue;
      var cintura = numeroFinito(item.cinturaCm);
      if (!(fecha in porFecha)) orden.push(fecha);
      porFecha[fecha] = {
        fecha: fecha,
        pesoKg: peso,
        cinturaCm: (cintura !== null && cintura > 0) ? cintura : null
      };
    }
    var salida = [];
    for (var j = 0; j < orden.length; j++) salida.push(porFecha[orden[j]]);
    salida.sort(function (a, b) { return comparar(a.fecha, b.fecha); });
    return salida;
  }

  function promedioMovil(serie, fechaRef, ventanaDias, minDatos) {
    var ref = aISO(fechaRef);
    if (!ref) return null;
    var ventana = Math.max(1, Math.trunc(numeroFinito(ventanaDias) || 7));
    var minimo = Math.max(1, Math.trunc(numeroFinito(minDatos) || 2));
    var datos = normalizarSerie(serie);
    var suma = 0;
    var cuenta = 0;
    for (var i = 0; i < datos.length; i++) {
      if (comparar(datos[i].fecha, ref) > 0) continue;
      var atras = diasEntre(datos[i].fecha, ref);
      if (atras === null || Math.abs(atras) > (ventana - 1)) continue;
      suma += datos[i].pesoKg;
      cuenta++;
    }
    if (cuenta < minimo) return null;
    return suma / cuenta;
  }

  function pesoBase(participante, serie, config) {
    var datos = normalizarSerie(serie);
    var inicio = aISO(config.FECHA_INICIO);
    var elegibles = [];
    for (var i = 0; i < datos.length && elegibles.length < 3; i++) {
      if (inicio && comparar(datos[i].fecha, inicio) < 0) continue;
      elegibles.push(datos[i].pesoKg);
    }
    if (elegibles.length >= 3) {
      var suma = 0;
      for (var j = 0; j < elegibles.length; j++) suma += elegibles[j];
      return suma / elegibles.length;
    }
    var declarado = numeroFinito(participante.pesoInicialKg);
    if (declarado !== null && declarado > 0) return declarado;
    throw invalido(
      'No hay peso base: faltan registros iniciales y el peso inicial declarado.',
      'pesoInicialKg'
    );
  }

  function calcularRacha(datos, hoyRef) {
    var ultimo = -1;
    for (var i = datos.length - 1; i >= 0; i--) {
      if (comparar(datos[i].fecha, hoyRef) <= 0) { ultimo = i; break; }
    }
    if (ultimo < 0) return 0;
    var distancia = diasEntre(datos[ultimo].fecha, hoyRef);
    if (distancia === null || Math.abs(distancia) > 1) return 0;
    var racha = 1;
    for (var k = ultimo; k > 0; k--) {
      var salto = diasEntre(datos[k - 1].fecha, datos[k].fecha);
      if (salto === null || Math.abs(salto) !== 1) break;
      racha++;
    }
    return racha;
  }

  function metricasParticipante(participante, serie, config, hoy) {
    var datos = normalizarSerie(serie);

    var hoyRef = aISO(hoy);
    if (!hoyRef) hoyRef = datos.length ? datos[datos.length - 1].fecha : aISO(config.FECHA_INICIO);
    if (!hoyRef) throw invalido('Falta la fecha de hoy para calcular las métricas.', 'hoy');

    var inicio = aISO(config.FECHA_INICIO);
    if (!inicio) inicio = datos.length ? datos[0].fecha : hoyRef;
    var fin = aISO(config.FECHA_FIN);
    var corte = fin ? minFecha(hoyRef, fin) : hoyRef;

    var ventana = Math.max(1, Math.trunc(numeroFinito(config.VENTANA_MOVIL_DIAS) || 7));
    var minDatos = Math.max(1, Math.trunc(numeroFinito(config.MIN_DATOS_PROMEDIO) || 2));

    var suavizado = promedioMovil(datos, corte, ventana, minDatos);
    var base = pesoBase(participante, datos, config);
    var datosSuficientes = suavizado !== null;

    var kgExactos = datosSuficientes ? (base - suavizado) : null;
    var pctExacto = (kgExactos !== null && base > 0) ? ((kgExactos / base) * 100) : null;

    var diasTranscurridos = diasInclusive(inicio, corte);
    if (!(diasTranscurridos >= 1)) diasTranscurridos = 1;

    var diasRegistrados = 0;
    for (var i = 0; i < datos.length; i++) {
      if (comparar(datos[i].fecha, inicio) < 0) continue;
      if (comparar(datos[i].fecha, corte) > 0) continue;
      diasRegistrados++;
    }

    var adherencia = redondear(acotar((diasRegistrados / diasTranscurridos) * 100, 0, 100), 2);

    var semanas = diasTranscurridos / 7;
    var tasaExacta = (pctExacto !== null && semanas >= 1) ? (pctExacto / semanas) : null;
    var tasa = tasaExacta === null ? null : redondear(tasaExacta, 2);

    var tasaMin = numeroFinito(config.TASA_SEMANAL_SANA_MIN);
    if (tasaMin === null) tasaMin = 0.5;
    var tasaMax = numeroFinito(config.TASA_SEMANAL_SANA_MAX);
    if (tasaMax === null) tasaMax = 1.0;
    var semaforo = null;
    if (tasa !== null) {
      if (tasa < tasaMin) semaforo = 'lento';
      else if (tasa > tasaMax) semaforo = 'agresivo';
      else semaforo = 'sano';
    }

    var meta = numeroFinito(participante.metaKg);
    if (meta !== null && meta <= 0) meta = null;

    var avance = null;
    if (meta !== null && kgExactos !== null) {
      var rango = base - meta;
      avance = rango > 0 ? Math.min(100, (kgExactos / rango) * 100) : 100;
    }

    var cinturaActual = null;
    for (var k = datos.length - 1; k >= 0; k--) {
      if (comparar(datos[k].fecha, corte) > 0) continue;
      if (datos[k].cinturaCm !== null) { cinturaActual = datos[k].cinturaCm; break; }
    }
    var cinturaBase = numeroFinito(participante.cinturaInicialCm);
    if (cinturaBase !== null && cinturaBase <= 0) cinturaBase = null;
    if (cinturaBase === null) {
      for (var m = 0; m < datos.length; m++) {
        if (comparar(datos[m].fecha, inicio) < 0) continue;
        if (datos[m].cinturaCm !== null) { cinturaBase = datos[m].cinturaCm; break; }
      }
    }
    var cinturaPerdida = (cinturaBase !== null && cinturaActual !== null)
      ? redondear(cinturaBase - cinturaActual, 2)
      : null;

    var proyeccion = null;
    if (meta !== null && datosSuficientes && tasaExacta !== null && tasaExacta > 0 && suavizado > meta) {
      var kgPorSemana = (tasaExacta / 100) * base;
      if (kgPorSemana > 0) {
        var diasRestantes = Math.ceil(((suavizado - meta) / kgPorSemana) * 7);
        if (isFinite(diasRestantes)) {
          if (diasRestantes < 1) diasRestantes = 1;
          proyeccion = sumarDias(hoyRef, diasRestantes);
        }
      }
    }

    return {
      pesoActualSuavizado: datosSuficientes ? redondear(suavizado, 2) : null,
      pesoBase: redondear(base, 2),
      kgPerdidos: kgExactos === null ? null : redondear(kgExactos, 2),
      pctPerdido: pctExacto === null ? null : redondear(pctExacto, 2),
      avanceMetaPct: avance === null ? null : redondear(avance, 2),
      tasaSemanalPct: tasa,
      semaforoTasa: semaforo,
      adherenciaPct: adherencia,
      racha: calcularRacha(datos, hoyRef),
      diasRegistrados: diasRegistrados,
      diasTranscurridos: diasTranscurridos,
      cinturaActual: cinturaActual === null ? null : redondear(cinturaActual, 2),
      cinturaPerdidaCm: cinturaPerdida,
      proyeccionMetaFecha: proyeccion,
      ultimaFecha: datos.length ? datos[datos.length - 1].fecha : null,
      datosSuficientes: datosSuficientes
    };
  }

  function descendente(x, y) {
    var a = numeroFinito(x);
    var b = numeroFinito(y);
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    if (a === b) return 0;
    return a > b ? -1 : 1;
  }

  function compararNombres(x, y) {
    var a = texto(x).trim().toLowerCase();
    var b = texto(y).trim().toLowerCase();
    if (a === b) return 0;
    var r = a.localeCompare(b, 'es');
    if (r !== 0) return r < 0 ? -1 : 1;
    return 0;
  }

  /** Solo la parte de merito de los desempates: porcentaje, adherencia y kilos.
   *  El nombre ordena la presentacion pero no decide puesto. */
  function compararMerito(a, b) {
    var r = descendente(a.pctPerdido, b.pctPerdido);
    if (r !== 0) return r;
    r = descendente(a.adherenciaPct, b.adherenciaPct);
    if (r !== 0) return r;
    return descendente(a.kgPerdidos, b.kgPerdidos);
  }

  function construirRanking(lista) {
    var conDatos = [];
    var sinDatos = [];
    for (var i = 0; i < lista.length; i++) {
      var item = lista[i];
      if (!esObjeto(item) || !esObjeto(item.participante)) continue;
      if (texto(item.participante.rol).toLowerCase() === 'observador') continue;
      var metricas = esObjeto(item.metricas) ? item.metricas : {};
      var fila = {
        participanteId: item.participante.id,
        nombre: texto(item.participante.nombre),
        puesto: null
      };
      // Los 16 campos van siempre, en el orden del contrato, aunque las
      // metricas vengan a null: la vista no tiene que comprobar si existen.
      for (var c = 0; c < CAMPOS_METRICAS.length; c++) {
        var campo = CAMPOS_METRICAS[c];
        fila[campo] = metricas[campo] === undefined ? null : metricas[campo];
      }
      fila.datosSuficientes = metricas.datosSuficientes === true;
      if (fila.datosSuficientes && numeroFinito(fila.pctPerdido) !== null) conDatos.push(fila);
      else sinDatos.push(fila);
    }

    conDatos.sort(function (a, b) {
      var r = compararMerito(a, b);
      return r !== 0 ? r : compararNombres(a.nombre, b.nombre);
    });
    sinDatos.sort(function (a, b) { return compararNombres(a.nombre, b.nombre); });

    var puesto = 0;
    var anterior = null;
    for (var k = 0; k < conDatos.length; k++) {
      if (anterior === null || compararMerito(anterior, conDatos[k]) !== 0) puesto = k + 1;
      conDatos[k].puesto = puesto;
      anterior = conDatos[k];
    }
    return conDatos.concat(sinDatos);
  }

  // ----------------------------------------------------------------- fotos --

  var TAMANOS_FOTO = {
    full: { ancho: 900, alto: 1200, base: 1 },
    thumb: { ancho: 270, alto: 360, base: 0.3 }
  };

  var PALETAS = [
    ['#0e6f52', '#d9f2e6', '#04331f'],
    ['#1d4e89', '#dbe9f8', '#0a2340'],
    ['#8a4b12', '#fbe8d3', '#3d1f04'],
    ['#5b2a86', '#ece0f7', '#2a1040'],
    ['#0f6d75', '#d6f0f2', '#03383c']
  ];

  /**
   * Los ids de foto de la demo se arman legibles a proposito:
   *   foto_<tipo>_<participanteId>_<fecha>_<full|thumb>
   * Asi foto() puede pintar el nombre y la fecha correctos sin guardar ni un
   * byte de imagen en memoria.
   */
  function idFoto(tipo, participanteId, fecha, variante) {
    return 'foto_' + tipo + '_' + participanteId + '_' + fecha + '_' + variante;
  }

  function partesIdFoto(id) {
    var trozos = texto(id).split('_');
    if (trozos.length < 5 || trozos[0] !== 'foto') return null;
    return {
      tipo: trozos[1],
      participanteId: trozos[2],
      fecha: aISO(trozos[3]),
      variante: trozos[4]
    };
  }

  var ETIQUETA_TIPO = {
    ejercicio: 'Foto del ejercicio',
    balanza: 'Foto de la balanza',
    avatar: 'Foto de perfil'
  };

  /**
   * SVG sintetico distinto por id, con el nombre y la fecha pintados. Sustituye
   * a la foto real: sin esto el feed se ve vacio y no se puede juzgar el diseno.
   */
  function svgDeFoto(datos) {
    var medida = TAMANOS_FOTO[datos.variante] || TAMANOS_FOTO.full;
    var ancho = medida.ancho;
    var alto = medida.alto;
    var h = hashTexto(datos.id);
    var paleta = PALETAS[h % PALETAS.length];
    var fuerte = paleta[0];
    var suave = paleta[1];
    var oscuro = paleta[2];
    var giro = (h >> 8) % 24 - 12;
    var puntos = 4 + ((h >> 13) % 5);

    var k = medida.base;
    var tituloPx = Math.round(58 * k);
    var textoPx = Math.round(40 * k);
    var piePx = Math.round(30 * k);
    var margen = Math.round(60 * k);

    var partes = [];
    partes.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + ancho + ' ' + alto + '"');
    partes.push(' width="' + ancho + '" height="' + alto + '" role="img" aria-label="' +
      escaparXml(datos.etiqueta) + '">');
    partes.push('<rect width="' + ancho + '" height="' + alto + '" fill="' + suave + '"/>');

    // Fondo geometrico: da a cada foto una silueta reconocible de lejos.
    partes.push('<g transform="rotate(' + giro + ' ' + (ancho / 2) + ' ' + (alto / 2) + ')" opacity="0.35">');
    for (var i = 0; i < puntos; i++) {
      var r = Math.round((alto / 3) - (i * alto / (puntos * 6)));
      var cx = Math.round((ancho / 2) + (((h >> (i * 3)) % 100) - 50) * (ancho / 900));
      var cy = Math.round((alto / 2) + (((h >> (i * 4)) % 120) - 60) * (alto / 1200));
      partes.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + Math.max(8, r) +
        '" fill="none" stroke="' + fuerte + '" stroke-width="' + Math.max(2, Math.round(10 * k)) + '"/>');
    }
    partes.push('</g>');

    // Silueta esquematica: una persona para el ejercicio, una balanza para el peso.
    if (datos.tipo === 'balanza') {
      var bx = Math.round(ancho * 0.2);
      var by = Math.round(alto * 0.3);
      var bw = Math.round(ancho * 0.6);
      var bh = Math.round(alto * 0.22);
      partes.push('<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + bh +
        '" rx="' + Math.round(24 * k) + '" fill="' + fuerte + '"/>');
      partes.push('<text x="' + (ancho / 2) + '" y="' + (by + bh * 0.68) +
        '" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="700" font-size="' +
        Math.round(96 * k) + '" fill="' + suave + '">' + escaparXml(datos.valor) + '</text>');
    } else {
      var cx2 = Math.round(ancho / 2);
      var cy2 = Math.round(alto * 0.36);
      var rr = Math.round(alto * 0.055);
      partes.push('<circle cx="' + cx2 + '" cy="' + cy2 + '" r="' + rr + '" fill="' + fuerte + '"/>');
      partes.push('<path d="M ' + cx2 + ' ' + (cy2 + rr) + ' L ' + cx2 + ' ' + Math.round(alto * 0.56) +
        ' M ' + Math.round(cx2 - rr * 1.9) + ' ' + Math.round(alto * 0.47) +
        ' L ' + Math.round(cx2 + rr * 1.9) + ' ' + Math.round(alto * 0.42) +
        ' M ' + cx2 + ' ' + Math.round(alto * 0.56) + ' L ' + Math.round(cx2 - rr * 1.4) + ' ' + Math.round(alto * 0.66) +
        ' M ' + cx2 + ' ' + Math.round(alto * 0.56) + ' L ' + Math.round(cx2 + rr * 1.4) + ' ' + Math.round(alto * 0.66) +
        '" stroke="' + fuerte + '" stroke-width="' + Math.round(16 * k) +
        '" stroke-linecap="round" fill="none"/>');
    }

    // Banda inferior con nombre, fecha y detalle: es lo que hace la foto util
    // para revisar el feed y la verificacion cruzada.
    var bandaAlto = Math.round(alto * 0.26);
    var bandaY = alto - bandaAlto;
    partes.push('<rect x="0" y="' + bandaY + '" width="' + ancho + '" height="' + bandaAlto +
      '" fill="' + oscuro + '" opacity="0.92"/>');
    partes.push('<text x="' + margen + '" y="' + (bandaY + Math.round(bandaAlto * 0.34)) +
      '" font-family="system-ui, sans-serif" font-weight="700" font-size="' + tituloPx +
      '" fill="#ffffff">' + escaparXml(datos.nombre) + '</text>');
    partes.push('<text x="' + margen + '" y="' + (bandaY + Math.round(bandaAlto * 0.62)) +
      '" font-family="system-ui, sans-serif" font-size="' + textoPx +
      '" fill="#ffffff" opacity="0.92">' + escaparXml(datos.fecha) + '</text>');
    partes.push('<text x="' + margen + '" y="' + (bandaY + Math.round(bandaAlto * 0.86)) +
      '" font-family="system-ui, sans-serif" font-size="' + piePx +
      '" fill="#ffffff" opacity="0.8">' + escaparXml(datos.pie) + '</text>');
    partes.push('</svg>');
    return partes.join('');
  }

  // ------------------------------------------------------- estado sembrado --

  var HOY = aISO(new Date()) || '2026-09-04'; // se lee una sola vez, al cargar
  var estado = null;

  function configPorDefecto(inicio, fin) {
    return {
      RETO_NOMBRE: 'Reto de peso',
      FECHA_INICIO: inicio,
      FECHA_FIN: fin,
      ZONA_HORARIA: ZONA,
      VENTANA_MOVIL_DIAS: 7,
      MIN_DATOS_PROMEDIO: 2,
      DIA_PESADA_OFICIAL: 1,
      FOTO_BALANZA_DIARIA_OBLIGATORIA: false,
      FOTO_BALANZA_OFICIAL_OBLIGATORIA: true,
      CINTURA_OBLIGATORIA_OFICIAL: false,
      PESO_MIN_KG: 35,
      PESO_MAX_KG: 250,
      DELTA_DIARIO_MAX_KG: 3,
      CINTURA_MIN_CM: 40,
      CINTURA_MAX_CM: 200,
      EDICION_MISMO_DIA: true,
      OBSERVADOR_VE_FOTOS: true,
      TASA_SEMANAL_SANA_MIN: 0.5,
      TASA_SEMANAL_SANA_MAX: 1.0,
      VERSION_ESQUEMA: 1
    };
  }

  /**
   * Plan de siembra por participante. Todo esta fijado a mano para que las
   * metricas den valores interesantes y estables:
   *
   *  - `desde`/`hasta` son desplazamientos en dias desde FECHA_INICIO. Ed
   *    empezo a registrar el dia 6 y todavia no registro hoy (dia 40), asi que
   *    el flujo de registrar se puede probar de punta a punta. Alonso si
   *    registro hoy, para poder verificar su registro desde la cuenta de Ed.
   *  - `huecos` son los dias sin registro: rompen la racha y bajan la
   *    adherencia, que es justo lo que hay que ver en pantalla.
   *  - `perdidaTotal` es la caida de la tendencia en todo el reto. Con la curva
   *    de abajo Ed queda en tasa "sano" y Alonso en "agresivo", asi se ven dos
   *    colores distintos del semaforo.
   */
  var PLAN = [
    {
      id: 'p-ed',
      email: 'ed@demo.reto',
      nombre: 'Ed',
      rol: 'participante',
      pesoInicialKg: 78,
      metaKg: 62,
      cinturaInicialCm: 98,
      alturaCm: 176,
      perdidaTotal: 5.0,
      cinturaTotal: 5.5,
      desde: 6,
      hasta: 39,
      huecos: [14, 15, 31],
      anulados: [12],
      semilla: 1013904223
    },
    {
      id: 'p-alonso',
      email: 'alonso@demo.reto',
      nombre: 'Alonso',
      rol: 'participante',
      pesoInicialKg: 93,
      metaKg: 72,
      cinturaInicialCm: 112,
      alturaCm: 181,
      perdidaTotal: 9.2,
      cinturaTotal: 7.5,
      desde: 10,
      hasta: 40,
      huecos: [20, 34],
      anulados: [],
      // Un salto de 3,3 kg en un dia: dispara revisar = TRUE por
      // DELTA_DIARIO_MAX_KG y deja ver el aviso de dato improbable.
      rebote: { dia: 22, kg: 3.3 },
      semilla: 1442695040
    },
    {
      id: 'p-marcela',
      email: 'marcela@demo.reto',
      nombre: 'Marcela',
      rol: 'observador',
      pesoInicialKg: null,
      metaKg: null,
      cinturaInicialCm: null,
      alturaCm: 164,
      desde: null,
      hasta: null,
      huecos: [],
      anulados: [],
      semilla: 2531011
    }
  ];

  /** Tendencia de peso al dia `dia` del reto. Curva casi lineal con una caida
   *  algo mayor al principio, como pasa de verdad al arrancar una dieta. */
  function tendencia(pesoInicial, perdidaTotal, dia, span) {
    var frac = acotar(dia / span, 0, 1);
    var caida = perdidaTotal * (1 - Math.pow(1 - frac, 1.15));
    return pesoInicial - caida;
  }

  function participanteDe(plan, rolForzado) {
    return {
      id: plan.id,
      email: plan.email,
      nombre: plan.nombre,
      rol: rolForzado || plan.rol,
      pesoInicialKg: plan.pesoInicialKg,
      metaKg: plan.metaKg,
      cinturaInicialCm: plan.cinturaInicialCm,
      alturaCm: plan.alturaCm,
      fechaAlta: null,
      activo: true,
      avatarFotoId: idFoto('avatar', plan.id, HOY, 'full'),
      notas: ''
    };
  }

  function construirEstado() {
    var modo = ESTADO_PEDIDO;
    var vacio = modo === 'vacio';

    var inicio = vacio ? HOY : sumarDias(HOY, -DIAS_ANTES_DEL_INICIO);
    var fin = sumarDias(inicio, DIAS_DE_RETO);
    var config = configPorDefecto(inicio, fin);

    // El rol del usuario que "entra" cambia con el estado de prueba. Admin es
    // Ed con permisos ampliados: en el contrato un admin tambien compite.
    var rolEd = modo === 'admin' ? 'admin' : 'participante';

    var participantes = [];
    var porId = Object.create(null);
    for (var i = 0; i < PLAN.length; i++) {
      var plan = PLAN[i];
      var p = participanteDe(plan, plan.id === 'p-ed' ? rolEd : null);
      p.fechaAlta = sumarDias(inicio, plan.id === 'p-marcela' ? 2 : 0);
      participantes.push(p);
      porId[p.id] = p;
    }

    var nuevo = {
      config: config,
      participantes: participantes,
      porId: porId,
      registros: [],
      poses: [],
      verificaciones: [],
      contador: 0,
      usuarioId: modo === 'observador' ? 'p-marcela' : 'p-ed'
    };

    if (!vacio) sembrarRegistros(nuevo);
    return nuevo;
  }

  function sembrarRegistros(st) {
    var inicio = st.config.FECHA_INICIO;
    var span = DIAS_ANTES_DEL_INICIO;

    for (var i = 0; i < PLAN.length; i++) {
      var plan = PLAN[i];
      if (plan.desde === null) continue; // los observadores no registran

      var rnd = generador(plan.semilla);
      var pesoAnterior = null;

      for (var dia = plan.desde; dia <= plan.hasta; dia++) {
        if (plan.huecos.indexOf(dia) !== -1) continue;

        var fecha = sumarDias(inicio, dia);
        var oficial = diaSemanaISO(fecha) === st.config.DIA_PESADA_OFICIAL;

        var base = tendencia(plan.pesoInicialKg, plan.perdidaTotal, dia, span);
        var ruido = (rnd() * 2 - 1) * RUIDO_KG;
        // El fin de semana pesa un poco mas: comidas fuera y mas sal.
        var finDeSemana = diaSemanaISO(fecha) >= 6 ? 0.25 : 0;
        var rebote = (plan.rebote && plan.rebote.dia === dia) ? plan.rebote.kg : 0;
        var peso = redondear(base + ruido + finDeSemana + rebote, 1);

        var cintura = null;
        if (oficial) {
          var caidaCintura = plan.cinturaTotal * (1 - Math.pow(1 - acotar(dia / span, 0, 1), 1.15));
          cintura = redondear(plan.cinturaInicialCm - caidaCintura + (rnd() * 0.6 - 0.3), 1);
        }

        var delta = pesoAnterior === null ? 0 : Math.abs(peso - pesoAnterior);
        var revisar = delta > st.config.DELTA_DIARIO_MAX_KG;

        var pose = poseSembrada(rnd);
        var animo = ANIMOS[entero(rnd, ANIMOS.length)];
        var nota = NOTAS[entero(rnd, NOTAS.length)];
        var falla = entero(rnd, 9) === 0; // de vez en cuando un protocolo sin marcar

        st.contador++;
        var reg = {
          id: 'r-' + plan.id + '-' + fecha,
          participanteId: plan.id,
          fecha: fecha,
          pesoKg: peso,
          cinturaCm: cintura,
          animo: animo,
          nota: nota,
          protocolo: {
            ayunas: !falla,
            bano: true,
            ropa: !(falla && oficial),
            balanza: true
          },
          poseCodigo: pose.codigo,
          poseTexto: pose.texto,
          fotoEjercicioId: idFoto('ejercicio', plan.id, fecha, 'full'),
          fotoEjercicioThumbId: idFoto('ejercicio', plan.id, fecha, 'thumb'),
          fotoBalanzaId: oficial ? idFoto('balanza', plan.id, fecha, 'full') : null,
          fotoBalanzaThumbId: oficial ? idFoto('balanza', plan.id, fecha, 'thumb') : null,
          origenFoto: 'camara',
          hashEjercicio: 'demo' + hashTexto('e|' + plan.id + '|' + fecha).toString(16),
          hashBalanza: oficial ? 'demo' + hashTexto('b|' + plan.id + '|' + fecha).toString(16) : null,
          esPesadaOficial: oficial,
          revisar: revisar,
          motivoRevisar: revisar
            ? 'Variación de ' + redondear(delta, 1) + ' kg respecto al día anterior.'
            : null,
          creadoEn: sello(fecha, 6 + entero(rnd, 3), entero(rnd, 60)),
          creadoPor: plan.email,
          editadoEn: null,
          editadoPor: null,
          anulado: plan.anulados.indexOf(dia) !== -1,
          motivoAnulado: plan.anulados.indexOf(dia) !== -1
            ? 'Pesada repetida por error, se anuló para no contarla dos veces.'
            : null
        };
        st.registros.push(reg);

        st.poses.push({
          id: 'pose-' + plan.id + '-' + fecha,
          participanteId: plan.id,
          fecha: fecha,
          poseCodigo: pose.codigo,
          poseTexto: pose.texto,
          reveladaEn: sello(fecha, 5, 40),
          usadaEn: reg.creadoEn
        });

        pesoAnterior = peso;
      }
    }

    sembrarVerificaciones(st);
  }

  /** Verificacion cruzada: cada uno revisa al otro. Se dejan sin verificar los
   *  registros mas recientes para poder probar el boton desde la interfaz. */
  function sembrarVerificaciones(st) {
    var rnd = generador(424242);
    for (var i = 0; i < st.registros.length; i++) {
      var reg = st.registros[i];
      if (reg.anulado) continue;
      var otro = reg.participanteId === 'p-ed' ? 'p-alonso' : 'p-ed';
      if (!st.porId[otro]) continue;

      var diasAtras = diasEntre(reg.fecha, HOY);
      if (diasAtras !== null && diasAtras <= 1) continue; // pendientes a proposito

      var duda = entero(rnd, 8) === 0;
      var veredicto = duda ? 'duda' : 'ok';
      var comentario = duda
        ? COMENTARIOS_DUDA[entero(rnd, COMENTARIOS_DUDA.length)]
        : (entero(rnd, 3) === 0 ? COMENTARIOS_OK[entero(rnd, COMENTARIOS_OK.length)] : '');

      st.verificaciones.push({
        id: 'v-' + reg.id + '-' + otro,
        registroId: reg.id,
        verificadorId: otro,
        veredicto: veredicto,
        comentario: comentario,
        creadoEn: sello(sumarDias(reg.fecha, 0), 20, 10 + entero(rnd, 40))
      });
    }
  }

  function st() {
    if (!estado) estado = construirEstado();
    return estado;
  }

  // ----------------------------------------------------------- consultas --

  function usuario() {
    return st().porId[st().usuarioId] || null;
  }

  function esAdmin(p) {
    return !!p && p.rol === 'admin';
  }

  function puedeRegistrar(p) {
    return !!p && (p.rol === 'participante' || p.rol === 'admin');
  }

  function registrosDe(participanteId, incluirAnulados) {
    var lista = [];
    var todos = st().registros;
    for (var i = 0; i < todos.length; i++) {
      if (todos[i].participanteId !== participanteId) continue;
      if (!incluirAnulados && todos[i].anulado) continue;
      lista.push(todos[i]);
    }
    lista.sort(function (a, b) { return comparar(a.fecha, b.fecha); });
    return lista;
  }

  function serieDe(participanteId) {
    var lista = registrosDe(participanteId, false);
    var salida = [];
    for (var i = 0; i < lista.length; i++) {
      salida.push({
        fecha: lista[i].fecha,
        pesoKg: lista[i].pesoKg,
        cinturaCm: lista[i].cinturaCm
      });
    }
    return salida;
  }

  function registroPorId(id) {
    var todos = st().registros;
    for (var i = 0; i < todos.length; i++) {
      if (todos[i].id === id) return todos[i];
    }
    return null;
  }

  function registroDeFecha(participanteId, fecha) {
    var todos = st().registros;
    for (var i = 0; i < todos.length; i++) {
      var r = todos[i];
      if (r.participanteId === participanteId && r.fecha === fecha && !r.anulado) return r;
    }
    return null;
  }

  function poseDeFecha(participanteId, fecha) {
    var todas = st().poses;
    for (var i = 0; i < todas.length; i++) {
      if (todas[i].participanteId === participanteId && todas[i].fecha === fecha) return todas[i];
    }
    return null;
  }

  function verificacionesDe(registroId) {
    var salida = [];
    var todas = st().verificaciones;
    for (var i = 0; i < todas.length; i++) {
      if (todas[i].registroId === registroId) salida.push(todas[i]);
    }
    return salida;
  }

  function nombreDe(participanteId) {
    var p = st().porId[participanteId];
    return p ? p.nombre : 'Participante';
  }

  function metricasDe(participante) {
    if (!participante || participante.rol === 'observador') return null;
    try {
      return metricasParticipante(participante, serieDe(participante.id), st().config, HOY);
    } catch (e) {
      // Un observador ascendido a participante sin peso inicial no debe tumbar
      // el tablero: la vista ya sabe pintar "sin datos".
      return null;
    }
  }

  function esPesadaOficialHoy() {
    return diaSemanaISO(HOY) === st().config.DIA_PESADA_OFICIAL;
  }

  function requisitosDe(fecha) {
    var c = st().config;
    var oficial = diaSemanaISO(fecha) === c.DIA_PESADA_OFICIAL;
    return {
      fotoEjercicio: true,
      fotoBalanza: !!c.FOTO_BALANZA_DIARIA_OBLIGATORIA ||
        (oficial && !!c.FOTO_BALANZA_OFICIAL_OBLIGATORIA),
      cintura: oficial && !!c.CINTURA_OBLIGATORIA_OFICIAL,
      protocolo: true
    };
  }

  function retoIniciado() {
    return comparar(HOY, st().config.FECHA_INICIO) >= 0;
  }

  function retoCerrado() {
    return comparar(HOY, st().config.FECHA_FIN) > 0;
  }

  function retoPublico() {
    var c = st().config;
    var transcurridos = diasInclusive(c.FECHA_INICIO, minFecha(HOY, c.FECHA_FIN));
    return {
      nombre: c.RETO_NOMBRE,
      fechaInicio: c.FECHA_INICIO,
      fechaFin: c.FECHA_FIN,
      zonaHoraria: c.ZONA_HORARIA,
      diaPesadaOficial: c.DIA_PESADA_OFICIAL,
      ventanaMovilDias: c.VENTANA_MOVIL_DIAS,
      minDatosPromedio: c.MIN_DATOS_PROMEDIO,
      tasaSemanalSanaMin: c.TASA_SEMANAL_SANA_MIN,
      tasaSemanalSanaMax: c.TASA_SEMANAL_SANA_MAX,
      edicionMismoDia: !!c.EDICION_MISMO_DIA,
      observadorVeFotos: !!c.OBSERVADOR_VE_FOTOS,
      iniciado: retoIniciado(),
      cerrado: retoCerrado(),
      activo: retoIniciado() && !retoCerrado(),
      diaActual: Math.max(0, transcurridos),
      diasTotales: diasInclusive(c.FECHA_INICIO, c.FECHA_FIN),
      config: copiarConfig()
    };
  }

  function copiarConfig() {
    var c = st().config;
    var salida = {};
    var claves = Object.keys(c);
    for (var i = 0; i < claves.length; i++) salida[claves[i]] = c[claves[i]];
    return salida;
  }

  /** RegistroPublico de la seccion 7.1: sin base64 y sin hashes. */
  function registroPublico(reg, verFotos) {
    var lista = verificacionesDe(reg.id);
    var verificaciones = [];
    for (var i = 0; i < lista.length; i++) {
      verificaciones.push({
        verificadorNombre: nombreDe(lista[i].verificadorId),
        veredicto: lista[i].veredicto,
        comentario: lista[i].comentario,
        creadoEn: lista[i].creadoEn
      });
    }
    return {
      id: reg.id,
      participanteId: reg.participanteId,
      participanteNombre: nombreDe(reg.participanteId),
      fecha: reg.fecha,
      pesoKg: reg.pesoKg,
      cinturaCm: reg.cinturaCm,
      animo: reg.animo,
      nota: reg.nota,
      protocolo: {
        ayunas: !!reg.protocolo.ayunas,
        bano: !!reg.protocolo.bano,
        ropa: !!reg.protocolo.ropa,
        balanza: !!reg.protocolo.balanza
      },
      poseCodigo: reg.poseCodigo,
      poseTexto: reg.poseTexto,
      fotoEjercicioThumbId: verFotos ? reg.fotoEjercicioThumbId : null,
      fotoEjercicioId: verFotos ? reg.fotoEjercicioId : null,
      fotoBalanzaThumbId: verFotos ? reg.fotoBalanzaThumbId : null,
      fotoBalanzaId: verFotos ? reg.fotoBalanzaId : null,
      esPesadaOficial: !!reg.esPesadaOficial,
      revisar: !!reg.revisar,
      motivoRevisar: reg.motivoRevisar,
      creadoEn: reg.creadoEn,
      anulado: !!reg.anulado,
      verificaciones: verificaciones
    };
  }

  /** Un observador solo ve fotos si OBSERVADOR_VE_FOTOS lo permite. */
  function veFotos(quien) {
    if (!quien) return false;
    if (quien.rol !== 'observador') return true;
    return !!st().config.OBSERVADOR_VE_FOTOS;
  }

  function participantePublico(p) {
    return { id: p.id, nombre: p.nombre, rol: p.rol, avatarFotoId: p.avatarFotoId };
  }

  function usuarioPublico(p) {
    return {
      id: p.id,
      email: p.email,
      nombre: p.nombre,
      rol: p.rol,
      pesoInicialKg: p.pesoInicialKg,
      metaKg: p.metaKg,
      cinturaInicialCm: p.cinturaInicialCm,
      alturaCm: p.alturaCm,
      fechaAlta: p.fechaAlta,
      activo: !!p.activo,
      avatarFotoId: p.avatarFotoId
    };
  }

  // ------------------------------------------------------------ guardianes --

  function exigirInscrito() {
    var u = usuario();
    if (!u) throw errorApi('NO_INSCRITO', 'Tu correo no está en la lista del reto.', 'email');
    return u;
  }

  function exigirParticipante() {
    var u = exigirInscrito();
    if (!puedeRegistrar(u)) {
      throw errorApi('NO_AUTORIZADO', 'Tu rol es de solo lectura: no registras pesadas.', 'rol');
    }
    return u;
  }

  function exigirAdmin() {
    var u = exigirInscrito();
    if (!esAdmin(u)) {
      throw errorApi('NO_AUTORIZADO', 'Solo el administrador puede hacer este cambio.', 'rol');
    }
    return u;
  }

  function exigirRetoAbierto() {
    if (!retoIniciado()) {
      throw errorApi('RETO_NO_INICIADO', 'El reto todavía no empieza. Vuelve el día de inicio.', null);
    }
    if (retoCerrado()) {
      throw errorApi('RETO_CERRADO', 'El reto ya cerró: no se aceptan más registros.', null);
    }
  }

  /** En el estado "error" toda ruta falla, con un codigo distinto por ruta. */
  function fallarSiEstadoError(ruta) {
    if (ESTADO_PEDIDO !== 'error') return;
    var e = ERRORES_DE_PRUEBA[ruta] || ['ERROR_INTERNO', 'Algo salió mal en el servidor del reto.', null];
    throw errorApi(e[0], e[1], e[2]);
  }

  // ------------------------------------------------------------- validacion --

  function exigirNumero(valor, campo, etiqueta, minimo, maximo) {
    var n = numeroFinito(valor);
    if (n === null) throw invalido('Falta ' + etiqueta + '.', campo);
    if (n < minimo || n > maximo) {
      throw invalido(etiqueta.charAt(0).toUpperCase() + etiqueta.slice(1) +
        ' debe estar entre ' + minimo + ' y ' + maximo + '.', campo);
    }
    return n;
  }

  function exigirFoto(foto, campo, etiqueta) {
    if (!esObjeto(foto) || typeof foto.base64 !== 'string' || !foto.base64) {
      throw errorApi('FOTO_REQUERIDA', 'Falta la ' + etiqueta + '. Tómala con la cámara.', campo);
    }
    if (foto.mime && foto.mime !== 'image/jpeg') {
      throw invalido('La ' + etiqueta + ' debe ser JPEG.', campo);
    }
    return foto;
  }

  function hashUsado(hash, idPropio) {
    if (!hash) return false;
    var todos = st().registros;
    for (var i = 0; i < todos.length; i++) {
      var r = todos[i];
      if (r.id === idPropio) continue;
      if (r.hashEjercicio === hash || r.hashBalanza === hash) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- rutas --

  var rutas = {};

  rutas.salud = function () {
    return {
      version: VERSION,
      hoy: HOY,
      zonaHoraria: st().config.ZONA_HORARIA,
      retoActivo: retoIniciado() && !retoCerrado()
    };
  };

  // arranque — el bootstrap publico. En la demo el Client ID viene vacio a
  // proposito: no hay Google Sign-In que inicializar, y auth.js ni la llama
  // porque el modo demo entra directo. Se implementa para que el doble de
  // prueba cubra las 13 rutas del contrato y no falte una si algo la pide.
  rutas.arranque = function () {
    return {
      version: VERSION,
      clientId: null,
      backendConfigurado: false,
      retoNombre: st().config.RETO_NOMBRE,
      fechaInicio: st().config.FECHA_INICIO || null,
      fechaFin: st().config.FECHA_FIN || null,
      hoy: HOY,
      zonaHoraria: st().config.ZONA_HORARIA,
      retoActivo: retoIniciado() && !retoCerrado()
    };
  };

  rutas.sesion = function () {
    var u = exigirInscrito();
    var registro = registroDeFecha(u.id, HOY);
    return {
      usuario: usuarioPublico(u),
      reto: retoPublico(),
      hoy: HOY,
      registradoHoy: !!registro,
      esPesadaOficial: esPesadaOficialHoy(),
      requisitos: requisitosDe(HOY)
    };
  };

  rutas.poseHoy = function () {
    var u = exigirParticipante();
    var pose = poseDeFecha(u.id, HOY);
    if (!pose) {
      // Primera consulta del dia: se crea la pose y se sella el revelado, que
      // es la evidencia de cuando la persona supo que le tocaba.
      pose = {
        id: 'pose-' + u.id + '-' + HOY,
        participanteId: u.id,
        fecha: HOY,
        poseCodigo: POSE_DE_HOY.codigo,
        poseTexto: POSE_DE_HOY.texto,
        reveladaEn: sello(HOY, 5, 40),
        usadaEn: null
      };
      st().poses.push(pose);
    }
    return {
      fecha: pose.fecha,
      codigo: pose.poseCodigo,
      texto: pose.poseTexto,
      reveladaEn: pose.reveladaEn,
      yaRegistrado: !!registroDeFecha(u.id, HOY)
    };
  };

  rutas.registrar = function (datos) {
    var u = exigirParticipante();
    exigirRetoAbierto();
    var c = st().config;
    var p = esObjeto(datos) ? datos : {};

    var pose = poseDeFecha(u.id, HOY);
    if (!pose) {
      throw errorApi('POSE_NO_ASIGNADA',
        'Todavía no tienes pose asignada para hoy. Abre la vista de hoy antes de registrar.', null);
    }
    if (texto(p.poseCodigo) !== pose.poseCodigo) {
      throw errorApi('POSE_INCORRECTA',
        'La pose enviada no es la de hoy. Vuelve a leer la pose y toma la foto otra vez.', 'poseCodigo');
    }

    var requisitos = requisitosDe(HOY);
    exigirFoto(p.fotoEjercicio, 'fotoEjercicio', 'foto del ejercicio');
    if (requisitos.fotoBalanza) exigirFoto(p.fotoBalanza, 'fotoBalanza', 'foto de la balanza');

    if (texto(p.origenFoto) !== 'camara') {
      throw invalido('Las fotos solo se aceptan tomadas con la cámara en vivo.', 'origenFoto');
    }

    var peso = exigirNumero(p.pesoKg, 'pesoKg', 'el peso', c.PESO_MIN_KG, c.PESO_MAX_KG);

    var cintura = null;
    if (p.cinturaCm !== undefined && p.cinturaCm !== null && p.cinturaCm !== '') {
      cintura = exigirNumero(p.cinturaCm, 'cinturaCm', 'la cintura', c.CINTURA_MIN_CM, c.CINTURA_MAX_CM);
    } else if (requisitos.cintura) {
      throw invalido('Hoy toca medir la cintura.', 'cinturaCm');
    }

    var nota = texto(p.nota);
    if (nota.length > NOTA_MAX) {
      throw invalido('La nota no puede pasar de ' + NOTA_MAX + ' caracteres.', 'nota');
    }
    var animo = texto(p.animo);
    if (animo && ANIMOS.indexOf(animo) < 0) {
      throw invalido('El ánimo no es uno de los tres valores posibles.', 'animo');
    }

    var existente = registroDeFecha(u.id, HOY);
    if (existente && !c.EDICION_MISMO_DIA) {
      throw errorApi('YA_REGISTRADO', 'Ya registraste hoy y la edición está desactivada.', null);
    }

    var hashEjercicio = texto(p.fotoEjercicio && p.fotoEjercicio.hash) ||
      ('demo' + hashTexto('e|' + u.id + '|' + HOY + '|' + peso).toString(16));
    var hashBalanza = p.fotoBalanza
      ? (texto(p.fotoBalanza.hash) || ('demo' + hashTexto('b|' + u.id + '|' + HOY + '|' + peso).toString(16)))
      : null;

    if (hashUsado(hashEjercicio, existente ? existente.id : null)) {
      throw errorApi('FOTO_DUPLICADA',
        'Esa foto ya se usó en otro registro. Toma una nueva.', 'fotoEjercicio');
    }
    if (hashBalanza && hashUsado(hashBalanza, existente ? existente.id : null)) {
      throw errorApi('FOTO_DUPLICADA',
        'Esa foto de la balanza ya se usó antes. Toma una nueva.', 'fotoBalanza');
    }

    // Delta contra la ultima pesada anterior a hoy: un salto grande no se
    // rechaza, se marca. Rechazar un dato real seria peor.
    var previos = registrosDe(u.id, false);
    var ultimoPeso = null;
    for (var i = previos.length - 1; i >= 0; i--) {
      if (previos[i].fecha === HOY) continue;
      ultimoPeso = previos[i].pesoKg;
      break;
    }
    var delta = ultimoPeso === null ? 0 : Math.abs(peso - ultimoPeso);
    var revisar = delta > c.DELTA_DIARIO_MAX_KG;

    var oficial = esPesadaOficialHoy();
    var ahora = sello(HOY, 7, 30);

    var reg = existente || {
      id: 'r-' + u.id + '-' + HOY,
      participanteId: u.id,
      fecha: HOY,
      creadoEn: ahora,
      creadoPor: u.email,
      editadoEn: null,
      editadoPor: null,
      anulado: false,
      motivoAnulado: null
    };

    reg.pesoKg = redondear(peso, 2);
    reg.cinturaCm = cintura === null ? null : redondear(cintura, 1);
    reg.animo = animo || '';
    reg.nota = nota;
    reg.protocolo = {
      ayunas: !!(p.protocolo && p.protocolo.ayunas),
      bano: !!(p.protocolo && p.protocolo.bano),
      ropa: !!(p.protocolo && p.protocolo.ropa),
      balanza: !!(p.protocolo && p.protocolo.balanza)
    };
    reg.poseCodigo = pose.poseCodigo;
    reg.poseTexto = pose.poseTexto;
    // Solo se guardan los identificadores: el base64 de la foto no se conserva
    // en memoria ni se devuelve, igual que en el backend real.
    reg.fotoEjercicioId = idFoto('ejercicio', u.id, HOY, 'full');
    reg.fotoEjercicioThumbId = idFoto('ejercicio', u.id, HOY, 'thumb');
    reg.fotoBalanzaId = p.fotoBalanza ? idFoto('balanza', u.id, HOY, 'full') : null;
    reg.fotoBalanzaThumbId = p.fotoBalanza ? idFoto('balanza', u.id, HOY, 'thumb') : null;
    reg.origenFoto = 'camara';
    reg.hashEjercicio = hashEjercicio;
    reg.hashBalanza = hashBalanza;
    reg.esPesadaOficial = oficial;
    reg.revisar = revisar;
    reg.motivoRevisar = revisar
      ? 'Variación de ' + redondear(delta, 1) + ' kg respecto a la pesada anterior.'
      : null;

    if (existente) {
      reg.editadoEn = ahora;
      reg.editadoPor = u.email;
    } else {
      st().registros.push(reg);
    }
    pose.usadaEn = ahora;

    return {
      registro: registroPublico(reg, veFotos(u)),
      metricas: metricasDe(u)
    };
  };

  rutas.resumen = function () {
    var u = exigirInscrito();
    var lista = st().participantes;
    var conMetricas = [];
    var series = [];

    for (var i = 0; i < lista.length; i++) {
      var p = lista[i];
      var m = metricasDe(p);
      conMetricas.push({ participante: participantePublico(p), metricas: m });
      if (p.rol !== 'observador') {
        series.push({
          participanteId: p.id,
          nombre: p.nombre,
          metaKg: p.metaKg,
          puntos: serieDe(p.id)
        });
      }
    }

    return {
      reto: retoPublico(),
      participantes: conMetricas,
      ranking: construirRanking(conMetricas),
      series: series,
      usuarioId: u.id
    };
  };

  rutas.historial = function (filtro) {
    var u = exigirInscrito();
    var f = esObjeto(filtro) ? filtro : {};

    var pedido = texto(f.participanteId);
    if (pedido && !st().porId[pedido]) {
      throw invalido('Ese participante no existe en el reto.', 'participanteId');
    }
    var desde = aISO(f.desde);
    var hasta = aISO(f.hasta);
    var limite = numeroFinito(f.limite);
    limite = limite === null ? LIMITE_HISTORIAL : acotar(Math.trunc(limite), 1, LIMITE_HISTORIAL_MAX);

    var verFotosAqui = veFotos(u);
    var salida = [];
    var todos = st().registros.slice();
    // Mas reciente primero: el feed se lee de arriba hacia abajo.
    todos.sort(function (a, b) {
      var r = comparar(b.fecha, a.fecha);
      return r !== 0 ? r : compararNombres(nombreDe(a.participanteId), nombreDe(b.participanteId));
    });

    for (var i = 0; i < todos.length && salida.length < limite; i++) {
      var reg = todos[i];
      if (pedido && reg.participanteId !== pedido) continue;
      if (desde && comparar(reg.fecha, desde) < 0) continue;
      if (hasta && comparar(reg.fecha, hasta) > 0) continue;
      salida.push(registroPublico(reg, verFotosAqui));
    }

    return { registros: salida };
  };

  rutas.foto = function (datos) {
    var u = exigirInscrito();
    var p = esObjeto(datos) ? datos : {};
    var id = texto(p.fotoId);
    if (!id) throw invalido('Falta el identificador de la foto.', 'fotoId');
    if (!veFotos(u)) {
      throw errorApi('NO_AUTORIZADO', 'Tu rol no tiene permitido ver las fotos del reto.', 'fotoId');
    }

    var partes = partesIdFoto(id);
    if (!partes || !partes.fecha) {
      throw invalido('Esa foto no existe o el enlace ya no sirve.', 'fotoId');
    }
    var variante = texto(p.tamano) || partes.variante || 'full';
    if (!TAMANOS_FOTO[variante]) variante = 'full';

    var nombre = nombreDe(partes.participanteId);
    var reg = registroDeFecha(partes.participanteId, partes.fecha);
    var valor = reg ? (redondear(reg.pesoKg, 1) + ' kg') : '— kg';
    var etiqueta = (ETIQUETA_TIPO[partes.tipo] || 'Foto del reto') + ' de ' + nombre +
      ' del ' + partes.fecha;

    var svg = svgDeFoto({
      id: id,
      tipo: partes.tipo,
      variante: variante,
      nombre: nombre,
      fecha: partes.fecha,
      valor: valor,
      pie: (ETIQUETA_TIPO[partes.tipo] || 'Foto del reto') + ' · demo',
      etiqueta: etiqueta
    });

    var base64 = base64DeTexto(svg);
    return {
      mime: 'image/svg+xml',
      base64: base64,
      nombre: partes.fecha + '_' + partes.participanteId + '_' + partes.tipo + '_' + variante + '.svg',
      // Conveniencia para la vista: el contrato pide mime y base64, y la demo
      // ademas entrega el data URI ya armado.
      dataUri: 'data:image/svg+xml;base64,' + base64
    };
  };

  rutas.verificar = function (datos) {
    var u = exigirParticipante();
    var p = esObjeto(datos) ? datos : {};
    var reg = registroPorId(texto(p.registroId));
    if (!reg) throw invalido('Ese registro no existe.', 'registroId');
    if (reg.anulado) {
      throw errorApi('REGISTRO_BLOQUEADO', 'Ese registro está anulado: ya no se verifica.', 'registroId');
    }
    if (reg.participanteId === u.id) {
      throw errorApi('NO_AUTORIZADO', 'No puedes verificar tu propio registro.', 'registroId');
    }
    var veredicto = texto(p.veredicto);
    if (VEREDICTOS.indexOf(veredicto) < 0) {
      throw invalido('El veredicto debe ser "ok" o "duda".', 'veredicto');
    }
    var comentario = texto(p.comentario);
    if (comentario.length > NOTA_MAX) {
      throw invalido('El comentario no puede pasar de ' + NOTA_MAX + ' caracteres.', 'comentario');
    }

    var previa = null;
    var todas = st().verificaciones;
    for (var i = 0; i < todas.length; i++) {
      if (todas[i].registroId === reg.id && todas[i].verificadorId === u.id) { previa = todas[i]; break; }
    }
    var ahora = sello(HOY, 21, 5);
    if (previa) {
      previa.veredicto = veredicto;
      previa.comentario = comentario;
      previa.creadoEn = ahora;
    } else {
      previa = {
        id: 'v-' + reg.id + '-' + u.id,
        registroId: reg.id,
        verificadorId: u.id,
        veredicto: veredicto,
        comentario: comentario,
        creadoEn: ahora
      };
      st().verificaciones.push(previa);
    }

    return {
      verificacion: {
        verificadorNombre: u.nombre,
        veredicto: previa.veredicto,
        comentario: previa.comentario,
        creadoEn: previa.creadoEn
      },
      registro: registroPublico(reg, veFotos(u))
    };
  };

  rutas.participantes = function () {
    exigirInscrito();
    var lista = st().participantes;
    var salida = [];
    for (var i = 0; i < lista.length; i++) {
      if (!lista[i].activo) continue;
      salida.push(participantePublico(lista[i]));
    }
    return { participantes: salida };
  };

  rutas.guardarParticipante = function (datos) {
    exigirAdmin();
    var p = esObjeto(datos) ? datos : {};
    var email = texto(p.email).trim().toLowerCase();
    if (!email || email.indexOf('@') < 1 || email.indexOf('.') < 0) {
      throw invalido('El correo del participante no es válido.', 'email');
    }
    var nombre = texto(p.nombre).trim();
    if (!nombre) throw invalido('Falta el nombre del participante.', 'nombre');
    var rol = texto(p.rol).trim().toLowerCase() || 'participante';
    if (ROLES.indexOf(rol) < 0) {
      throw invalido('El rol debe ser admin, participante u observador.', 'rol');
    }

    var c = st().config;
    var pesoInicial = null;
    if (rol !== 'observador') {
      pesoInicial = exigirNumero(p.pesoInicialKg, 'pesoInicialKg', 'el peso inicial',
        c.PESO_MIN_KG, c.PESO_MAX_KG);
    }
    var meta = numeroFinito(p.metaKg);
    if (meta !== null && (meta < c.PESO_MIN_KG || meta > c.PESO_MAX_KG)) {
      throw invalido('La meta debe estar entre ' + c.PESO_MIN_KG + ' y ' + c.PESO_MAX_KG + '.', 'metaKg');
    }
    var cintura = numeroFinito(p.cinturaInicialCm);
    if (cintura !== null && (cintura < c.CINTURA_MIN_CM || cintura > c.CINTURA_MAX_CM)) {
      throw invalido('La cintura inicial está fuera de rango.', 'cinturaInicialCm');
    }
    var altura = numeroFinito(p.alturaCm);

    var lista = st().participantes;
    var existente = null;
    for (var i = 0; i < lista.length; i++) {
      if (lista[i].email === email) { existente = lista[i]; break; }
    }

    if (!existente) {
      st().contador++;
      existente = {
        id: 'p-nuevo-' + st().contador,
        email: email,
        nombre: nombre,
        rol: rol,
        pesoInicialKg: pesoInicial,
        metaKg: meta,
        cinturaInicialCm: cintura,
        alturaCm: altura,
        fechaAlta: HOY,
        activo: true,
        avatarFotoId: null,
        notas: ''
      };
      lista.push(existente);
      st().porId[existente.id] = existente;
    } else {
      existente.nombre = nombre;
      existente.rol = rol;
      existente.pesoInicialKg = pesoInicial === null ? existente.pesoInicialKg : pesoInicial;
      existente.metaKg = meta;
      existente.cinturaInicialCm = cintura === null ? existente.cinturaInicialCm : cintura;
      existente.alturaCm = altura === null ? existente.alturaCm : altura;
    }
    if (p.activo !== undefined) existente.activo = !!p.activo;

    return { participante: usuarioPublico(existente) };
  };

  rutas.anularRegistro = function (datos) {
    var u = exigirAdmin();
    var p = esObjeto(datos) ? datos : {};
    var reg = registroPorId(texto(p.registroId));
    if (!reg) throw invalido('Ese registro no existe.', 'registroId');
    var motivo = texto(p.motivo).trim();
    if (!motivo) throw invalido('Escribe el motivo de la anulación.', 'motivo');
    if (motivo.length > NOTA_MAX) {
      throw invalido('El motivo no puede pasar de ' + NOTA_MAX + ' caracteres.', 'motivo');
    }
    // El registro no se borra: queda anulado y fuera de las metricas.
    reg.anulado = true;
    reg.motivoAnulado = motivo;
    reg.editadoEn = sello(HOY, 22, 15);
    reg.editadoPor = u.email;
    return { registro: registroPublico(reg, veFotos(u)) };
  };

  rutas.configurar = function (datos) {
    exigirAdmin();
    var p = esObjeto(datos) ? datos : {};
    var clave = texto(p.clave).trim();
    var c = st().config;
    if (!clave || !(clave in c)) {
      throw invalido('Esa clave de configuración no existe.', 'clave');
    }

    var actual = c[clave];
    var valor = p.valor;
    if (typeof actual === 'boolean') {
      if (typeof valor === 'string') {
        var s = valor.trim().toLowerCase();
        valor = (s === 'true' || s === 'sí' || s === 'si' || s === '1');
      } else {
        valor = !!valor;
      }
    } else if (typeof actual === 'number') {
      var n = numeroFinito(valor);
      if (n === null) throw invalido('Ese valor tiene que ser un número.', 'valor');
      valor = n;
    } else if (clave === 'FECHA_INICIO' || clave === 'FECHA_FIN') {
      var iso = aISO(valor);
      if (!iso) throw invalido('La fecha debe tener el formato aaaa-mm-dd.', 'valor');
      valor = iso;
    } else {
      valor = texto(valor).trim();
      if (!valor) throw invalido('Ese valor no puede quedar vacío.', 'valor');
    }

    c[clave] = valor;
    return { config: copiarConfig() };
  };

  // ------------------------------------------------------- superficie Api --

  /**
   * llamar(ruta, datos) — mismo punto de entrada que Api.llamar: devuelve el
   * objeto `datos` de la respuesta y lanza ErrorApi cuando algo falla. Nunca
   * devuelve un exito falso.
   */
  async function llamar(ruta, datos) {
    var nombre = texto(ruta);
    await retardo();
    fallarSiEstadoError(nombre);
    var fn = Object.prototype.hasOwnProperty.call(rutas, nombre) ? rutas[nombre] : null;
    if (!fn) {
      throw errorApi('RUTA_DESCONOCIDA', 'Esa función del reto no existe en esta versión.', 'ruta');
    }
    return fn(datos);
  }

  /** Vuelve a sembrar todo desde cero. Util para probar dos veces el mismo
   *  flujo de registrar sin recargar la pagina. */
  function reiniciar() {
    estado = null;
    rndRetardo = generador(SEMILLA_RETARDO);
    return true;
  }

  window.Demo = {
    llamar: llamar,

    salud: function () { return llamar('salud', null); },
    arranque: function () { return llamar('arranque', null); },
    sesion: function () { return llamar('sesion', null); },
    poseHoy: function () { return llamar('poseHoy', null); },
    registrar: function (p) { return llamar('registrar', p); },
    resumen: function () { return llamar('resumen', {}); },
    historial: function (f) { return llamar('historial', f); },
    foto: function (id, tamano) { return llamar('foto', { fotoId: id, tamano: tamano }); },
    verificar: function (v) { return llamar('verificar', v); },
    participantes: function () { return llamar('participantes', null); },
    guardarParticipante: function (p) { return llamar('guardarParticipante', p); },
    anularRegistro: function (a) { return llamar('anularRegistro', a); },
    configurar: function (c) { return llamar('configurar', c); },

    // Metadatos del doble de prueba, no del contrato de la API.
    ES_DEMO: true,
    ESTADO: ESTADO_PEDIDO,
    HOY: HOY,
    reiniciar: reiniciar
  };
}());
