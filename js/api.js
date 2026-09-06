/**
 * api.js — unico puente entre el frontend y el backend de Apps Script.
 *
 * Script clasico (sin modulos): expone window.Api y window.ErrorApi dentro de
 * una IIFE. Se carga despues de config.js, util.js, graficos.js, camara.js y
 * demo.js, y antes de auth.js y app.js.
 *
 * Reglas que este archivo hace cumplir, segun las secciones 7 y 8 del contrato:
 *
 *  - Una sola URL de salida: RETO_CONFIG.API_URL.
 *  - El ID token de Google viaja en el CUERPO de la peticion, nunca en una
 *    cabecera y nunca en la URL. Ver la nota de text/plain mas abajo.
 *  - El backend responde HTTP 200 siempre; el estado real esta en el cuerpo.
 *    Por eso aqui nunca se devuelve exito si ok es false: se lanza ErrorApi.
 *  - Ningun token se escribe en consola, en localStorage ni en la URL.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constantes de comportamiento
  // ---------------------------------------------------------------------------

  // Tiempo limite propio. Apps Script puede quedarse colgado sin cerrar la
  // conexion, y fetch no tiene timeout nativo: sin esto la app se queda
  // "cargando" para siempre.
  var MS_LIMITE = 30000;
  // registrar sube dos o cuatro fotos: necesita mas aire que una lectura.
  var MS_LIMITE_REGISTRAR = 60000;
  // probarAvisos arma el resumen de la semana y ademas sale a enviar un correo:
  // tarda mucho mas que una lectura y, por ser una escritura con efecto
  // externo, no se reintenta nunca. Cortarla por tiempo cuando el correo si
  // salio es el peor final posible, asi que se le da el mismo aire que a
  // registrar en vez de los 30 s de una lectura.
  var MS_LIMITE_AVISOS = 60000;

  // Tiempo limite propio de las rutas lentas. El resto usa MS_LIMITE.
  var LIMITES_MS = {
    registrar: MS_LIMITE_REGISTRAR,
    probarAvisos: MS_LIMITE_AVISOS
  };

  // Reintentos: solo fallos de transporte, y jamas en las rutas de SIN_REINTENTO.
  var MAX_REINTENTOS = 2;
  var ESPERAS_MS = [700, 1800];

  // Escrituras que NUNCA se repiten solas, aunque el fallo sea de transporte.
  // Las dos tienen el mismo problema: si el primer envio llego y solo se perdio
  // la respuesta, repetirlo produce un efecto real duplicado —una fila de mas o
  // una foto quemada en registrar, un correo de mas en probarAvisos—. Ante la
  // duda decide la persona, no un reintento automatico.
  var SIN_REINTENTO = { registrar: true, probarAvisos: true };

  // Cache en memoria muy corto, solo para las rutas de lectura que las vistas
  // piden repetidas veces al navegar entre pestanas.
  //
  // informeSemanal entra al cache, y esta es la razon: es una lectura pura,
  // sale de los mismos registros que resumen y la vista del tablero la pide
  // cada vez que se vuelve a ella. Su ventana es de 7 dias, asi que 30 s de
  // desfase no cambian ni un numero visible. Y lo que si cambia el informe
  // —registrar, verificar, anular o configurar— ya vacia este cache al
  // terminar, porque todas esas rutas estan en RUTAS_QUE_INVALIDAN: no hay
  // forma de quedarse mirando un informe viejo despues de escribir.
  var MS_CACHE = 30000;
  var RUTAS_CACHEABLES = { resumen: true, participantes: true, informeSemanal: true };

  // Rutas que no necesitan token. `salud` prueba el despliegue; `arranque`
  // entrega la configuracion publica del backend (entre ella el Client ID de
  // Google), y tiene que ser accesible ANTES de que exista sesion: es lo que
  // permite que en el frontend solo se pegue la URL del backend.
  var RUTAS_PUBLICAS = { salud: true, arranque: true };

  // Rutas de escritura: al terminar bien invalidan el cache de lectura, porque
  // el ranking, el informe de la semana y la lista de participantes acaban de
  // cambiar.
  //
  // probarAvisos NO esta aqui a proposito: escribe (manda un correo y deja
  // rastro en Auditoria) pero no toca ni un dato de los que pintan el tablero,
  // el informe o la lista. Vaciar el cache por ese envio obligaria a bajar
  // otra vez todo el resumen sin que hubiera cambiado nada.
  var RUTAS_QUE_INVALIDAN = {
    registrar: true,
    verificar: true,
    guardarParticipante: true,
    anularRegistro: true,
    configurar: true
  };

  // Codigos de fallo de transporte, los unicos que se reintentan.
  var REINTENTABLES = { SIN_CONEXION: true, TIEMPO_LIMITE: true };

  // MIME aceptados al armar un data URI de foto. El contrato solo permite
  // image/jpeg en el servidor; svg entra porque la demo dibuja fotos falsas.
  var MIMES_FOTO = {
    'image/jpeg': true,
    'image/png': true,
    'image/webp': true,
    'image/svg+xml': true
  };

  var TEXTO_GENERICO = 'Algo no salió bien. Intenta de nuevo.';

  // ---------------------------------------------------------------------------
  // Textos amables por codigo de error
  // ---------------------------------------------------------------------------
  //
  // El codigo tecnico jamas se le muestra al usuario: no le dice nada y asusta.
  // Cada texto explica que paso y, cuando existe, cual es el siguiente paso.
  var TEXTOS_ERROR = {
    // --- codigos del contrato (seccion 7) ---
    NO_AUTENTICADO: 'Tu sesión de Google no está activa o ya venció. Vuelve a entrar para continuar.',
    NO_INSCRITO: 'Tu correo no está inscrito en el reto. Pídele al administrador que te agregue.',
    NO_AUTORIZADO: 'No tienes permiso para hacer esto.',
    DATOS_INVALIDOS: 'Hay un dato fuera de rango. Revisa lo que escribiste e intenta de nuevo.',
    YA_REGISTRADO: 'Ya tienes el registro de hoy guardado. Vuelve mañana para el siguiente.',
    POSE_NO_ASIGNADA: 'Todavía no tienes pose asignada para hoy. Abre la pantalla de hoy para que se te asigne.',
    POSE_INCORRECTA: 'La pose cambió. Recarga la página y vuelve a tomar la foto.',
    FOTO_DUPLICADA: 'Esa foto ya se usó en otro registro. Toma una foto nueva ahora mismo.',
    FOTO_REQUERIDA: 'Falta una foto obligatoria de hoy. Tómala con la cámara para poder guardar.',
    REGISTRO_BLOQUEADO: 'Este registro ya no se puede cambiar. Pídele al administrador que lo corrija.',
    RETO_NO_INICIADO: 'El reto todavía no empieza. Podrás registrar tu peso desde el primer día.',
    RETO_CERRADO: 'El reto ya terminó y no se aceptan más registros. Puedes seguir viendo el tablero.',
    LIMITE_TASA: 'Demasiados intentos seguidos. Espera un minuto.',
    RUTA_DESCONOCIDA: 'Esta versión de la app pidió algo que el servidor no reconoce. Recarga la página.',
    ERROR_INTERNO: 'El servidor tuvo un problema. Intenta de nuevo en un momento.',

    // --- codigos que nacen en el navegador, no en el servidor ---
    SIN_CONFIGURAR: 'La app todavía no está conectada al servidor del reto. Quien administra debe pegar la dirección del servidor (API_URL) en web/js/config.js. Es el único valor que hace falta: lo demás lo entrega el servidor.',
    SIN_CONEXION: 'No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.',
    TIEMPO_LIMITE: 'El servidor tardó demasiado en responder. Intenta de nuevo.'
  };

  // Fallos de transporte durante registrar: como puede haber quedado guardado
  // a medias, el texto pide revisar antes de repetir en vez de invitar a
  // reintentar a ciegas.
  var TEXTOS_ERROR_REGISTRAR = {
    SIN_CONEXION: 'Se perdió la conexión mientras se guardaba tu registro. Revisa la pantalla de hoy antes de volver a enviarlo, por si ya quedó guardado.',
    TIEMPO_LIMITE: 'El servidor tardó demasiado al guardar tu registro. Revisa la pantalla de hoy antes de volver a enviarlo, por si ya quedó guardado.'
  };

  // Mismo caso en probarAvisos: el correo pudo salir y perderse solo la
  // respuesta, asi que el texto pide mirar la bandeja antes de repetir en vez
  // de invitar a pulsar otra vez.
  var TEXTOS_ERROR_AVISOS = {
    SIN_CONEXION: 'Se perdió la conexión mientras se pedía el correo de prueba. Revisa tu bandeja de entrada antes de volver a pedirlo, por si ya salió.',
    TIEMPO_LIMITE: 'El servidor tardó demasiado al preparar el correo de prueba. Revisa tu bandeja de entrada antes de volver a pedirlo, por si ya salió.'
  };

  // Codigos donde gana el mensaje concreto por encima de la tabla de arriba,
  // porque el detalle util vive en el mensaje y no en el codigo:
  //   DATOS_INVALIDOS  el servidor nombra el campo y el rango que fallo.
  //   ERROR_INTERNO    aqui viaja la pista de despliegue mal publicado.
  //   SIN_CONFIGURAR   dice exactamente que falta pegar.
  //   SIN_CONEXION     en registrar y en probarAvisos avisa de revisar antes
  //                    de repetir, porque el envio pudo haber llegado.
  //   TIEMPO_LIMITE    igual que el anterior.
  // Para el resto gana la tabla: su texto ya esta escrito para el usuario y no
  // depende de como redacte el backend.
  var PREFIERE_MENSAJE = {
    DATOS_INVALIDOS: true,
    ERROR_INTERNO: true,
    SIN_CONFIGURAR: true,
    SIN_CONEXION: true,
    TIEMPO_LIMITE: true
  };

  // ---------------------------------------------------------------------------
  // ErrorApi
  // ---------------------------------------------------------------------------

  /**
   * ErrorApi — el unico tipo de error que sale de Api.
   *
   *   new ErrorApi(codigo, mensaje, campo)
   *
   *   codigo   uno de los codigos del contrato o de los locales de arriba.
   *   mensaje  texto para el usuario, tal como lo mando el servidor.
   *   campo    nombre del campo del formulario culpable, o null.
   *
   * Extiende Error para que un catch generico siga funcionando y para que la
   * pila quede disponible al depurar. util.js lee "mensaje" primero y
   * "message" despues, asi que ambos se rellenan.
   */
  class ErrorApi extends Error {
    constructor(codigo, mensaje, campo) {
      var cod = typeof codigo === 'string' && codigo.trim() ? codigo.trim() : 'ERROR_INTERNO';
      var texto = typeof mensaje === 'string' && mensaje.trim() ? mensaje.trim() : '';
      super(texto || TEXTOS_ERROR[cod] || TEXTO_GENERICO);
      this.name = 'ErrorApi';
      this.codigo = cod;
      this.mensaje = texto;
      this.campo = typeof campo === 'string' && campo.trim() ? campo.trim() : null;
    }

    /**
     * textoAmable() -> string
     *
     * Frase lista para mostrar. Por defecto usa la tabla local, que esta
     * escrita con tono operativo y con el siguiente paso; para los codigos de
     * PREFIERE_MENSAJE gana el mensaje concreto, y si el codigo es desconocido
     * se cae al mensaje que llego y luego a una frase generica.
     */
    textoAmable() {
      if (PREFIERE_MENSAJE[this.codigo] && this.mensaje) return this.mensaje;
      if (TEXTOS_ERROR[this.codigo]) return TEXTOS_ERROR[this.codigo];
      if (this.mensaje) return this.mensaje;
      return TEXTO_GENERICO;
    }
  }

  /** Tabla de textos, de solo lectura, por si una vista quiere consultarla. */
  ErrorApi.TEXTOS = (function () {
    var copia = {};
    Object.keys(TEXTOS_ERROR).forEach(function (k) { copia[k] = TEXTOS_ERROR[k]; });
    return Object.freeze(copia);
  }());

  /**
   * ErrorApi.desde(entrada, codigoPorDefecto) -> ErrorApi
   *
   * Normaliza cualquier cosa que llegue a un catch (un ErrorApi, un Error
   * nativo, el objeto error de la respuesta, un texto suelto) a un ErrorApi.
   * Asi ninguna vista tiene que adivinar la forma de lo que atrapo.
   */
  ErrorApi.desde = function (entrada, codigoPorDefecto) {
    if (entrada instanceof ErrorApi) return entrada;
    var porDefecto = codigoPorDefecto || 'ERROR_INTERNO';
    if (typeof entrada === 'string') return new ErrorApi(porDefecto, entrada, null);
    if (entrada && typeof entrada === 'object') {
      var cod = typeof entrada.codigo === 'string' ? entrada.codigo : porDefecto;
      var msj = entrada.mensaje || entrada.message || '';
      return new ErrorApi(cod, msj, entrada.campo || null);
    }
    return new ErrorApi(porDefecto, '', null);
  };

  // ---------------------------------------------------------------------------
  // Estado interno
  // ---------------------------------------------------------------------------

  // Cache de lectura: clave "ruta|datos" -> {ts, valor} o {promesa}.
  var cacheRutas = new Map();
  // Cache de fotos ya bajadas: clave "id|tamano" -> data URI o promesa.
  var cacheFotos = new Map();

  // ---------------------------------------------------------------------------
  // Auxiliares
  // ---------------------------------------------------------------------------

  function conf() {
    return (window && window.RETO_CONFIG) || null;
  }

  function esDemo() {
    var c = conf();
    return !!(c && c.DEMO);
  }

  function estaConfigurado() {
    var c = conf();
    if (!c) return false;
    if (typeof c.configurado === 'function') {
      try {
        return !!c.configurado();
      } catch (e) {
        return false;
      }
    }
    return typeof c.API_URL === 'string' && c.API_URL.trim() !== '';
  }

  /**
   * Token vigente, pedido a auth.js en el momento de cada llamada. No se guarda
   * copia aqui: si la sesion se renueva, la siguiente peticion ya usa el nuevo.
   * Nunca se imprime ni se registra en ningun sitio.
   */
  function tokenActual() {
    try {
      var auth = window.Auth;
      if (auth && typeof auth.token === 'function') {
        var t = auth.token();
        if (typeof t === 'string' && t.trim()) return t.trim();
      }
    } catch (e) {
      // auth.js todavia no arranco: se trata como sesion ausente.
    }
    return '';
  }

  function dormir(ms) {
    var espera = typeof ms === 'number' && ms > 0 ? ms : 0;
    return new Promise(function (resolver) { setTimeout(resolver, espera); });
  }

  function objeto(datos) {
    return datos && typeof datos === 'object' ? datos : {};
  }

  function textoRed(codigo, ruta) {
    if (ruta === 'registrar' && TEXTOS_ERROR_REGISTRAR[codigo]) {
      return TEXTOS_ERROR_REGISTRAR[codigo];
    }
    if (ruta === 'probarAvisos' && TEXTOS_ERROR_AVISOS[codigo]) {
      return TEXTOS_ERROR_AVISOS[codigo];
    }
    return TEXTOS_ERROR[codigo] || TEXTO_GENERICO;
  }

  // ---------------------------------------------------------------------------
  // Modo demo
  // ---------------------------------------------------------------------------

  /**
   * Delega en window.Demo, que expone la misma superficie que Api. La demo no
   * toca la red: sirve para revisar todas las vistas y estados sin backend.
   */
  async function delegarDemo(ruta, datos) {
    var demo = window.Demo;
    if (!demo || typeof demo[ruta] !== 'function') {
      throw new ErrorApi('RUTA_DESCONOCIDA', TEXTOS_ERROR.RUTA_DESCONOCIDA, null);
    }
    var resultado;
    try {
      // foto es la unica ruta cuyo metodo publico lleva dos argumentos
      // posicionales en vez del objeto de datos.
      if (ruta === 'foto') {
        var d = objeto(datos);
        resultado = await Promise.resolve(demo.foto(d.fotoId, d.tamano));
      } else {
        resultado = await Promise.resolve(demo[ruta](objeto(datos)));
      }
    } catch (err) {
      throw ErrorApi.desde(err);
    }
    return desenvolver(resultado);
  }

  /**
   * Acepta tanto el valor directo como el sobre {ok, datos, error} y devuelve
   * siempre los datos. Si el sobre trae ok false, lanza. Vale para la demo y
   * para el servidor: nadie recibe un exito falso.
   */
  function desenvolver(resultado) {
    if (resultado && typeof resultado === 'object' && typeof resultado.ok === 'boolean') {
      if (!resultado.ok) throw ErrorApi.desde(resultado.error || {}, 'ERROR_INTERNO');
      return typeof resultado.datos === 'undefined' ? {} : resultado.datos;
    }
    return resultado;
  }

  // ---------------------------------------------------------------------------
  // Peticion real
  // ---------------------------------------------------------------------------

  function armarPeticion(ruta, datos, senal) {
    var url = String(conf().API_URL).trim();

    // Las rutas publicas viajan como GET con la ruta en la query, tal como
    // manda la seccion 7 del contrato: sirven antes de que exista sesion. Un
    // GET sin cabeceras propias tampoco dispara preflight, asi que sigue siendo
    // una peticion simple.
    if (RUTAS_PUBLICAS[ruta]) {
      url += (url.indexOf('?') >= 0 ? '&' : '?') + 'ruta=' + encodeURIComponent(ruta);
      return {
        url: url,
        opciones: {
          method: 'GET',
          redirect: 'follow',
          cache: 'no-store',
          credentials: 'omit',
          signal: senal
        }
      };
    }

    // Por que text/plain y no application/json: con application/json el
    // navegador manda antes una peticion OPTIONS (preflight CORS) y Apps Script
    // no atiende OPTIONS, asi que la llamada moriria sin llegar al codigo.
    // text/plain la vuelve una peticion simple, sin preflight. Consecuencia
    // directa: no se puede usar la cabecera Authorization, y por eso el ID
    // token va dentro del cuerpo, en el campo idToken. El cuerpo sigue siendo
    // JSON; solo la etiqueta de tipo cambia.
    var cuerpo = {
      ruta: ruta,
      idToken: tokenActual(),
      datos: objeto(datos)
    };

    return {
      url: url,
      opciones: {
        method: 'POST',
        redirect: 'follow',
        cache: 'no-store',
        // Sin cookies: la respuesta debe depender solo del token verificado, no
        // de con que cuenta de Google este el navegador en ese momento.
        credentials: 'omit',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(cuerpo),
        signal: senal
      }
    };
  }

  /**
   * Un intento contra el servidor. Lanza ErrorApi en todos los caminos de
   * fallo; si vuelve, vuelve con los datos buenos de la ruta.
   */
  async function peticion(ruta, datos) {
    var limite = LIMITES_MS[ruta] || MS_LIMITE;
    var controlador = new AbortController();
    var vencido = false;
    var reloj = setTimeout(function () {
      vencido = true;
      controlador.abort();
    }, limite);

    var crudo = '';
    try {
      var armado = armarPeticion(ruta, datos, controlador.signal);
      var respuesta = await fetch(armado.url, armado.opciones);
      // El cuerpo se lee dentro del mismo reloj: una conexion que entrega
      // cabeceras y luego se queda muda tambien es un tiempo limite.
      crudo = await respuesta.text();

      if (!respuesta.ok) {
        // Apps Script responde 200 hasta para los errores de negocio, asi que
        // otro estado significa que la URL o el despliegue estan mal.
        throw new ErrorApi(
          'ERROR_INTERNO',
          'El servidor respondió de una forma inesperada. Revisa que la dirección del servidor sea la del despliegue actual y que esté publicado para cualquier persona.',
          null
        );
      }
    } catch (err) {
      if (err instanceof ErrorApi) throw err;
      if (vencido || (err && err.name === 'AbortError')) {
        throw new ErrorApi('TIEMPO_LIMITE', textoRed('TIEMPO_LIMITE', ruta), null);
      }
      // fetch solo rechaza por transporte: sin red, DNS caido, CORS bloqueado.
      throw new ErrorApi('SIN_CONEXION', textoRed('SIN_CONEXION', ruta), null);
    } finally {
      clearTimeout(reloj);
    }

    var sobre;
    try {
      sobre = JSON.parse(crudo);
    } catch (e) {
      // Apps Script devuelve HTML (la pantalla de inicio de sesion o una de
      // error) cuando el despliegue esta mal publicado. Ese HTML nunca se
      // muestra ni se inserta en la pagina: solo se traduce a este aviso.
      throw new ErrorApi(
        'ERROR_INTERNO',
        'El servidor no respondió con datos del reto. Revisa el despliegue del Web App: debe estar publicado como «Ejecutar como: yo» y con acceso para cualquier persona, y la dirección del servidor debe ser la del despliegue actual.',
        null
      );
    }

    if (!sobre || typeof sobre !== 'object' || typeof sobre.ok !== 'boolean') {
      throw new ErrorApi(
        'ERROR_INTERNO',
        'La respuesta del servidor llegó incompleta. Revisa que el despliegue esté actualizado e intenta de nuevo.',
        null
      );
    }

    if (!sobre.ok) {
      // Error de negocio del servidor: se respeta su codigo, su mensaje y el
      // campo culpable para que el formulario pueda marcarlo.
      var e = sobre.error && typeof sobre.error === 'object' ? sobre.error : {};
      throw new ErrorApi(e.codigo || 'ERROR_INTERNO', e.mensaje || '', e.campo || null);
    }

    return typeof sobre.datos === 'undefined' ? {} : sobre.datos;
  }

  // ---------------------------------------------------------------------------
  // Reintentos
  // ---------------------------------------------------------------------------

  /**
   * Repite el intento solo ante fallos de transporte (sin conexion o tiempo
   * limite), como maximo MAX_REINTENTOS veces y con espera creciente.
   *
   * Un error de negocio no se reintenta: YA_REGISTRADO o POSE_INCORRECTA van a
   * fallar igual y solo gastarian el limite de tasa del servidor.
   */
  async function conReintentos(ejecutar, permitirReintentos) {
    var intento = 0;
    for (;;) {
      try {
        return await ejecutar();
      } catch (err) {
        var e = ErrorApi.desde(err);
        var puede = permitirReintentos && REINTENTABLES[e.codigo] && intento < MAX_REINTENTOS;
        if (!puede) throw e;
        await dormir(ESPERAS_MS[intento] || 2000);
        intento += 1;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // llamar
  // ---------------------------------------------------------------------------

  /**
   * llamar(ruta, datos) -> Promise<datos de la ruta>
   *
   * Punto unico de salida. Lanza ErrorApi ante cualquier fallo; jamas devuelve
   * un objeto de exito cuando algo salio mal.
   */
  async function llamar(ruta, datos) {
    var nombre = typeof ruta === 'string' ? ruta.trim() : '';
    if (!nombre) {
      throw new ErrorApi('RUTA_DESCONOCIDA', TEXTOS_ERROR.RUTA_DESCONOCIDA, null);
    }

    // El modo demo tambien respeta RUTAS_QUE_INVALIDAN. Sin esto la demo
    // guardaba en cache el tablero y el informe de la semana y no los soltaba
    // hasta 30 s despues de registrar, asi que el doble de prueba se
    // comportaba distinto del backend justo en lo que hay que validar con el.
    if (esDemo()) {
      var deLaDemo = await delegarDemo(nombre, datos);
      if (RUTAS_QUE_INVALIDAN[nombre]) invalidar();
      return deLaDemo;
    }

    if (!estaConfigurado()) {
      throw new ErrorApi('SIN_CONFIGURAR', TEXTOS_ERROR.SIN_CONFIGURAR, null);
    }

    // Sin sesion no se molesta al servidor: responderia NO_AUTENTICADO igual,
    // pero gastando una llamada del limite de tasa y varios segundos.
    if (!RUTAS_PUBLICAS[nombre] && !tokenActual()) {
      throw new ErrorApi('NO_AUTENTICADO', TEXTOS_ERROR.NO_AUTENTICADO, null);
    }

    // NUNCA se reintentan registrar ni probarAvisos: son las dos escrituras con
    // efecto real que un segundo envio duplicaria. En registrar, si el primero
    // llego y solo se perdio la respuesta, repetirlo crea un registro repetido
    // o choca contra FOTO_DUPLICADA. En probarAvisos, repetirlo manda un
    // segundo correo y gasta cuota de MailApp para nada. Ante la duda, decide
    // la persona —mirando la pantalla de hoy o su bandeja—, no un reintento
    // automatico.
    var permitir = !SIN_REINTENTO[nombre];

    var respuesta = await conReintentos(function () {
      return peticion(nombre, datos);
    }, permitir);

    if (RUTAS_QUE_INVALIDAN[nombre]) invalidar();
    return respuesta;
  }

  // ---------------------------------------------------------------------------
  // Cache de lectura
  // ---------------------------------------------------------------------------

  function claveCache(ruta, datos) {
    var d = objeto(datos);
    var partes = Object.keys(d).sort().map(function (k) {
      var v = d[k];
      return k + '=' + (v === null || typeof v === 'undefined' ? '' : String(v));
    });
    return ruta + '|' + partes.join('&');
  }

  /**
   * Igual que llamar, pero sirve la respuesta de los ultimos MS_CACHE
   * milisegundos y une las llamadas simultaneas en una sola peticion. Solo se
   * usa en resumen y participantes: son las lecturas que se repiten al navegar
   * entre pestanas, y 30 s de desfase no le cambian nada al usuario.
   */
  function llamarConCache(ruta, datos) {
    if (!RUTAS_CACHEABLES[ruta]) return llamar(ruta, datos);

    var clave = claveCache(ruta, datos);
    var guardado = cacheRutas.get(clave);
    if (guardado) {
      if (guardado.promesa) return guardado.promesa;
      if (Date.now() - guardado.ts < MS_CACHE) return Promise.resolve(guardado.valor);
      cacheRutas.delete(clave);
    }

    var promesa = llamar(ruta, datos).then(function (valor) {
      cacheRutas.set(clave, { ts: Date.now(), valor: valor });
      return valor;
    }, function (err) {
      // Un fallo no se cachea: la siguiente vista vuelve a intentarlo.
      cacheRutas.delete(clave);
      throw err;
    });

    cacheRutas.set(clave, { promesa: promesa });
    return promesa;
  }

  /**
   * invalidar(que) -> void
   *
   *   invalidar()                  borra el cache de resumen y participantes.
   *   invalidar('resumen')         borra solo esa ruta.
   *   invalidar('participantes')   borra solo esa ruta.
   *   invalidar('fotos')           borra las fotos ya bajadas.
   *   invalidar('todo')            borra ambas cosas.
   *
   * Se llama sola despues de cada escritura (registrar, verificar y las de
   * admin). Queda publica para cuando una vista quiera datos frescos a la
   * fuerza, por ejemplo al tirar para refrescar.
   */
  function invalidar(que) {
    var clave = typeof que === 'string' ? que.trim() : '';

    if (clave === 'fotos') {
      cacheFotos.clear();
      return;
    }
    if (clave === 'todo') {
      cacheRutas.clear();
      cacheFotos.clear();
      return;
    }
    if (clave && RUTAS_CACHEABLES[clave]) {
      var prefijo = clave + '|';
      Array.from(cacheRutas.keys()).forEach(function (k) {
        if (k.indexOf(prefijo) === 0) cacheRutas.delete(k);
      });
      return;
    }
    cacheRutas.clear();
  }

  // ---------------------------------------------------------------------------
  // Fotos
  // ---------------------------------------------------------------------------

  /**
   * Arma el data URI a partir de lo que devolvio la ruta foto ({mime, base64,
   * nombre}) o de lo que devolvio la demo (ya un data URI).
   *
   * Se exige que cualquier data URI empiece por "data:image/": asi lo que sale
   * de aqui solo puede terminar como imagen en un atributo src, nunca como
   * documento ni como script.
   */
  function aDataUri(respuesta) {
    if (typeof respuesta === 'string') {
      var texto = respuesta.trim();
      if (!texto) throw new ErrorApi('ERROR_INTERNO', 'No se pudo cargar la foto.', null);
      if (texto.slice(0, 5) === 'data:') {
        if (texto.slice(0, 11) !== 'data:image/') {
          throw new ErrorApi('ERROR_INTERNO', 'La foto llegó en un formato que no se puede mostrar.', null);
        }
        return texto;
      }
      return 'data:image/jpeg;base64,' + texto;
    }

    if (!respuesta || typeof respuesta !== 'object') {
      throw new ErrorApi('ERROR_INTERNO', 'No se pudo cargar la foto.', null);
    }

    if (typeof respuesta.dataUri === 'string') return aDataUri(respuesta.dataUri);

    var base64 = typeof respuesta.base64 === 'string' ? respuesta.base64.trim() : '';
    if (!base64) throw new ErrorApi('ERROR_INTERNO', 'No se pudo cargar la foto.', null);
    if (base64.slice(0, 5) === 'data:') return aDataUri(base64);

    var mime = typeof respuesta.mime === 'string' ? respuesta.mime.trim().toLowerCase() : '';
    if (!MIMES_FOTO[mime]) mime = 'image/jpeg';
    return 'data:' + mime + ';base64,' + base64;
  }

  /**
   * foto(id, tamano) -> Promise<string>
   *
   * Devuelve el data URI listo para el atributo src de una imagen. tamano es
   * 'thumb' (por defecto, el del feed) o 'full'.
   *
   * Las fotos ya bajadas se guardan en un Map por id y tamano: son inmutables,
   * pesan y en el historial la misma miniatura aparece muchas veces al
   * desplazarse. El cache guarda la promesa mientras baja, asi dos tarjetas que
   * piden la misma foto a la vez hacen una sola peticion.
   */
  function foto(id, tamano) {
    var fotoId = '';
    if (typeof id === 'string') fotoId = id.trim();
    else if (typeof id === 'number' && isFinite(id)) fotoId = String(id);

    if (!fotoId) {
      return Promise.reject(new ErrorApi('DATOS_INVALIDOS', 'Falta indicar cuál foto se quiere ver.', 'fotoId'));
    }

    var medida = tamano === 'full' ? 'full' : 'thumb';
    var clave = fotoId + '|' + medida;

    var guardado = cacheFotos.get(clave);
    if (typeof guardado !== 'undefined') return Promise.resolve(guardado);

    var promesa = llamar('foto', { fotoId: fotoId, tamano: medida }).then(function (respuesta) {
      var uri = aDataUri(respuesta);
      cacheFotos.set(clave, uri);
      return uri;
    }, function (err) {
      cacheFotos.delete(clave);
      throw err;
    });

    cacheFotos.set(clave, promesa);
    return promesa;
  }

  // ---------------------------------------------------------------------------
  // Metodos de conveniencia, uno por ruta de la seccion 7.1
  // ---------------------------------------------------------------------------

  /** salud() -> {version, hoy, zonaHoraria, retoActivo}. Publica, sin token. */
  function salud() {
    return llamar('salud', {});
  }

  /**
   * arranque() -> {version, clientId, backendConfigurado, retoNombre,
   *                fechaInicio, fechaFin, hoy, zonaHoraria, retoActivo}
   *
   * Publica y sin token. Es la primera llamada del frontend: trae el Client ID
   * de Google que auth.js necesita para inicializar el login. Por eso en
   * web/js/config.js solo hay que pegar la URL del backend.
   */
  function arranque() {
    return llamar('arranque', {});
  }

  /** sesion() -> {usuario, reto, hoy, registradoHoy, esPesadaOficial, requisitos}. */
  function sesion() {
    return llamar('sesion', {});
  }

  /** poseHoy() -> {fecha, codigo, texto, reveladaEn, yaRegistrado}. */
  function poseHoy() {
    return llamar('poseHoy', {});
  }

  /**
   * registrar(p) -> {registro, metricas}
   *
   * p es el cuerpo de la seccion 7.2: {pesoKg, cinturaCm, animo, nota,
   * protocolo:{ayunas, bano, ropa, balanza}, poseCodigo, origenFoto,
   * fotoEjercicio, fotoEjercicioThumb, fotoBalanza, fotoBalanzaThumb}.
   * Cada foto es {base64, mime} y las de tamano completo llevan tambien hash.
   */
  function registrar(p) {
    return llamar('registrar', objeto(p));
  }

  /** resumen() -> {reto, participantes, ranking, series}. Cacheado 30 s. */
  function resumen() {
    return llamarConCache('resumen', {});
  }

  /**
   * informeSemanal() -> {retoNombre, fechaInicio, fechaFin, hoy, desde, hasta,
   *                      lider, filas, sinRegistrar, cambioDeLider, usuarioId}
   *
   * Resumen de los ultimos 7 dias: el mismo que el backend arma con
   * Metricas.resumenSemanal y que viaja por correo cuando los avisos estan
   * encendidos. Lo puede pedir cualquier inscrito, observadores incluidos.
   * `filas` trae, por persona, el porcentaje perdido del reto completo mas los
   * datos de la semana (deltaSemanaKg, direccion, diasRegistrados, diasPosibles,
   * adherenciaPct, registroHoy, diasSinRegistrar) y los de referencia (imc,
   * imcClasificacion, kgSobreNormal). `usuarioId` es el id de quien pregunta,
   * para marcar su propia fila sin una segunda llamada.
   *
   * De aqui no sale ninguna foto, ningun hash, ningun correo y NINGUNA pose: la
   * pose del dia se revela solo por poseHoy.
   *
   * Lectura pura y cacheada 30 s, por lo explicado en RUTAS_CACHEABLES: cambia
   * solo cuando alguien escribe, y toda escritura que la cambia vacia el cache.
   *
   * OJO al pintarlo: el IMC es un dato de referencia, no entra al ranking y no
   * es un diagnostico. La vista tiene que decirlo y redactarlo como hecho
   * ("estás a 2,2 kg del rango normal"), nunca como consejo de salud.
   */
  function informeSemanal() {
    return llamarConCache('informeSemanal', {});
  }

  /**
   * probarAvisos() -> {enviado, destinatario, cuotaRestante}
   *
   * Manda el correo de prueba del resumen a una sola direccion, la del dueno
   * del script: no recibe destinatario y no hay forma de pedirle que escriba a
   * otro lado. Es de admin y se dispara desde un boton de #/admin, con
   * confirmacion.
   *
   * ESCRITURA CON EFECTO EXTERNO: sale un correo de verdad. Por eso NO se
   * reintenta nunca —esta en SIN_REINTENTO, igual que registrar—, tiene tiempo
   * limite largo y ante un fallo de transporte el texto pide revisar la bandeja
   * antes de repetir, en vez de invitar a pulsar otra vez. No invalida el cache
   * de lectura: no cambia ningun dato del tablero.
   */
  function probarAvisos() {
    return llamar('probarAvisos', {});
  }

  /** historial(f) -> {registros}. f = {participanteId?, desde?, hasta?, limite?}. */
  function historial(f) {
    return llamar('historial', objeto(f));
  }

  /** verificar(v) -> {verificacion, registro}. v = {registroId, veredicto, comentario?}. */
  function verificar(v) {
    return llamar('verificar', objeto(v));
  }

  /** participantes() -> {participantes}. Cacheado 30 s. */
  function participantes() {
    return llamarConCache('participantes', {});
  }

  /**
   * guardarParticipante(p) -> {participante}. Solo admin.
   * p = {email, nombre, rol, pesoInicialKg, metaKg?, cinturaInicialCm?,
   * alturaCm?, activo?}.
   */
  function guardarParticipante(p) {
    return llamar('guardarParticipante', objeto(p));
  }

  /** anularRegistro(a) -> {registro}. a = {registroId, motivo}. Solo admin. */
  function anularRegistro(a) {
    return llamar('anularRegistro', objeto(a));
  }

  /** configurar(c) -> {config}. c = {clave, valor}. Solo admin. */
  function configurar(c) {
    return llamar('configurar', objeto(c));
  }

  // ---------------------------------------------------------------------------
  // Superficie publica
  // ---------------------------------------------------------------------------

  window.ErrorApi = ErrorApi;

  window.Api = {
    llamar: llamar,

    salud: salud,
    arranque: arranque,
    sesion: sesion,
    poseHoy: poseHoy,
    registrar: registrar,
    resumen: resumen,
    informeSemanal: informeSemanal,
    historial: historial,
    foto: foto,
    verificar: verificar,
    participantes: participantes,
    guardarParticipante: guardarParticipante,
    anularRegistro: anularRegistro,
    configurar: configurar,
    probarAvisos: probarAvisos,

    invalidar: invalidar,

    // Referencia comoda para app.js: err instanceof Api.ErrorApi.
    ErrorApi: ErrorApi
  };
}());
