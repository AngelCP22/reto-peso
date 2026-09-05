/**
 * camara.js — captura en vivo. Es la primera capa del anti-trampa: en todo el
 * proyecto no existe ningun selector de archivos, asi que la unica via para que
 * una foto entre al reto es este archivo.
 *
 * Script clasico (sin modulos): expone window.Camara. Se carga despues de
 * util.js y antes de api.js.
 *
 * Reglas que este archivo hace cumplir por diseno:
 *  - Solo getUserMedia. Nunca se lee un archivo del telefono.
 *  - El base64 sale SIN el prefijo "data:image/jpeg;base64,": el backend lo
 *    rechaza con prefijo (Fotos.gs y lib_validacion.gs lo comprueban).
 *  - El hash SHA-256 se calcula sobre los BYTES del JPEG, no sobre la cadena
 *    base64. El servidor recalcula el hash sobre los bytes decodificados y
 *    compara; hashear la cadena daria un valor distinto y todo registro seria
 *    rechazado con DATOS_INVALIDOS.
 *  - El thumb se reescala desde el mismo lienzo del full, no desde el video otra
 *    vez: entre dos lecturas del video el frame cambia y la miniatura mostraria
 *    un instante distinto al de la foto que se firma con el hash.
 *  - cerrar() detiene TODAS las pistas. No cerrar el stream deja la luz de la
 *    camara encendida, sigue gastando bateria y en iOS hace que la siguiente
 *    apertura falle con NotReadableError porque la camara queda ocupada.
 *  - Aqui no hay ni un console.*: por el visor pasan las fotos del reto.
 */
(function () {
  'use strict';

  var MIME = 'image/jpeg';

  // Contrato, seccion 4: full con lado mayor <= 1280 px y calidad 0.82; thumb
  // con lado mayor <= 360 px y calidad 0.7.
  var LADO_FULL = 1280;
  var LADO_THUMB = 360;
  var CALIDAD_FULL = 0.82;
  var CALIDAD_THUMB = 0.7;

  // Escalera de reserva si el JPEG sale por encima del limite. Se baja calidad
  // antes de rendirse: mejor una foto algo mas comprimida que un registro
  // perdido despues de que la persona ya se peso.
  var CALIDADES_RESERVA = [0.7, 0.6, 0.5];

  // Los mismos topes en bytes que valida el backend (Fotos.gs:
  // LIMITE_BYTES_POR_DEFECTO = 1572864). Se comprueban aqui para avisar antes
  // de gastar la subida y no despues, con un DATOS_INVALIDOS del servidor.
  var MAX_BYTES_FULL = 1572864;
  var MAX_BYTES_THUMB = 204800;

  // Resolucion ideal que se le pide a la camara. "ideal" y no "exact": con
  // exact, cualquier telefono que no tenga ese modo falla con
  // OverconstrainedError en vez de darnos lo mas parecido.
  var ANCHO_IDEAL = 1280;
  var ALTO_IDEAL = 720;

  // Espera maxima a que el video informe sus dimensiones. En un celular lento
  // encender la camara toma un par de segundos; pasados 10 s ya no va a llegar.
  var MS_METADATOS = 10000;

  var CLAVE_CAMARA = 'reto.camara';
  var MODO_DEFECTO = 'environment';

  var DEMO_ANCHO = 900;
  var DEMO_ALTO = 1200;

  var RE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
  var RE_ESPACIOS = /\s+/g;
  var RE_DATA = /^data:/i;

  // ------------------------------------------------------------- mensajes --
  // Todos con tildes y accionables: el usuario esta de pie frente a la balanza,
  // no leyendo documentacion. Nunca se muestra el nombre tecnico del error.

  var MSJ_SIN_HTTPS = 'La cámara solo funciona con una conexión segura. ' +
    'Abre la aplicación con https:// (o desde localhost) y vuelve a intentarlo.';

  var MSJ_SIN_SOPORTE = 'Este navegador no permite tomar fotos desde la ' +
    'aplicación. Ábrela en Chrome o en Safari actualizados.';

  var MSJ_IFRAME = 'La cámara está bloqueada porque la aplicación se abrió ' +
    'dentro de otra página. Ábrela en su propia pestaña y vuelve a intentarlo.';

  var MSJ_PERMISO = 'No diste permiso para usar la cámara. Toca el candado ' +
    'que está junto a la dirección web, activa "Cámara" y vuelve a intentarlo. ' +
    'En iPhone también revisa Ajustes > Safari > Cámara.';

  var MSJ_SEGURIDAD = 'El navegador bloqueó la cámara por seguridad. Revisa ' +
    'los permisos del sitio y que la dirección empiece con https://.';

  var MSJ_SIN_CAMARA = 'No encontramos ninguna cámara en este dispositivo. ' +
    'Usa un teléfono con cámara para registrar la foto del día.';

  var MSJ_OCUPADA = 'Otra aplicación está usando la cámara. Cierra la cámara ' +
    'del teléfono o la videollamada que tengas abierta y vuelve a intentarlo.';

  var MSJ_RESTRICCIONES = 'Tu cámara no acepta la calidad que pedimos ni la ' +
    'configuración básica. Prueba con otro navegador o reinicia el teléfono.';

  var MSJ_INTERRUMPIDA = 'La cámara se interrumpió antes de encender. Vuelve ' +
    'a intentarlo.';

  var MSJ_NAVEGADOR = 'Este navegador no aceptó la petición de cámara. ' +
    'Actualízalo o ábrela en Chrome o Safari.';

  var MSJ_GENERICO = 'No pudimos encender la cámara. Vuelve a intentarlo y, ' +
    'si sigue igual, cierra y vuelve a abrir el navegador.';

  var MSJ_SIN_VIDEO = 'No hay dónde mostrar la cámara. Recarga la página e ' +
    'inténtalo de nuevo.';

  var MSJ_SIN_METADATOS = 'La cámara encendió pero no envió imagen. Cierra ' +
    'las otras aplicaciones que usen la cámara y vuelve a intentarlo.';

  var MSJ_VIDEO_FALLO = 'Se cortó la imagen de la cámara. Vuelve a encenderla ' +
    'e inténtalo de nuevo.';

  var MSJ_CANCELADA = 'Se canceló el encendido de la cámara porque se abrió ' +
    'otra vez. Vuelve a intentarlo.';

  var MSJ_CERRADA = 'La cámara no está encendida. Ábrela antes de tomar la foto.';

  var MSJ_SIN_IMAGEN = 'La cámara todavía no envía imagen. Espera un segundo ' +
    'y vuelve a tocar el botón para que la foto no salga en negro.';

  var MSJ_PERDIDA = 'Se perdió la conexión con la cámara. Vuelve a encenderla ' +
    'y toma la foto otra vez.';

  var MSJ_SIN_HASH = 'Este navegador no puede calcular la huella de la foto. ' +
    'Abre la aplicación con https:// en Chrome o Safari actualizados.';

  var MSJ_JPEG = 'No pudimos convertir la foto a JPEG. Vuelve a tomarla.';

  // -------------------------------------------------------------- estado --

  var estado = {
    video: null,
    stream: null,
    opciones: null,
    modo: null,
    pausada: false,
    perdida: false,
    demo: false,
    // Contador de aperturas. Si alguien toca dos veces el boton de encender,
    // la apertura vieja termina despues que la nueva y no debe pisarla ni
    // quedarse con un stream vivo (= luz encendida) que nadie cierra.
    generacion: 0,
    vigilandoVisibilidad: false
  };

  var contadorDemo = 0;

  function noop() { }

  function cfg() {
    return window.RETO_CONFIG || {};
  }

  function esDemo() {
    return !!cfg().DEMO;
  }

  function demoSinCamara() {
    return esDemo() && cfg().DEMO_ESTADO === 'sincamara';
  }

  function esObjeto(v) {
    return !!v && typeof v === 'object';
  }

  function esVideo(nodo) {
    return !!nodo && nodo.nodeType === 1 &&
      String(nodo.tagName || '').toLowerCase() === 'video';
  }

  function enteroPositivo(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(n);
  }

  /**
   * Error con .mensaje y .message iguales, mas un .codigo tecnico.
   * U.textoDeMensaje lee .mensaje primero, asi que U.mostrarError(err) muestra
   * el texto para el usuario y nunca el codigo.
   */
  function errorCamara(mensaje, codigo) {
    var texto = typeof mensaje === 'string' && mensaje.trim() ? mensaje : MSJ_GENERICO;
    var err = new Error(texto);
    err.mensaje = texto;
    err.codigo = codigo || 'camara';
    err.esCamara = true;
    return err;
  }

  // -------------------------------------------------------- disponibilidad --

  function enIframe() {
    try {
      return window.self !== window.top;
    } catch (e) {
      // Un error al comparar ya significa que hay un padre de otro origen.
      return true;
    }
  }

  /**
   * true solo cuando estamos embebidos Y la politica de permisos dice que no
   * hay camara. Si el navegador no expone featurePolicy no se puede saber, y en
   * ese caso se deja intentar: el error real de getUserMedia informa mejor que
   * una suposicion.
   */
  function iframeSinPermiso() {
    if (!enIframe()) return false;
    try {
      var politica = document.featurePolicy || document.permissionsPolicy;
      if (politica && typeof politica.allowsFeature === 'function') {
        return !politica.allowsFeature('camera');
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  /**
   * soportada() -> {ok, motivo, codigo}
   *
   * El orden de las comprobaciones importa: en un origen sin https Chrome ni
   * siquiera expone navigator.mediaDevices, asi que si se preguntara primero
   * por el soporte se culparia al navegador de un problema que es de la
   * direccion. Por eso el contexto seguro va primero.
   *
   * En modo demo devuelve ok salvo con estado=sincamara, que existe justo para
   * poder ver en pantalla como queda el error sin desconectar nada.
   */
  function soportada() {
    if (demoSinCamara()) {
      return { ok: false, motivo: MSJ_SIN_CAMARA, codigo: 'sin_camara' };
    }
    if (esDemo()) {
      return { ok: true, motivo: '', codigo: '' };
    }
    if (typeof window.isSecureContext === 'boolean' && !window.isSecureContext) {
      return { ok: false, motivo: MSJ_SIN_HTTPS, codigo: 'sin_https' };
    }
    var medios = navigator && navigator.mediaDevices;
    if (!medios || typeof medios.getUserMedia !== 'function') {
      return { ok: false, motivo: MSJ_SIN_SOPORTE, codigo: 'sin_soporte' };
    }
    if (iframeSinPermiso()) {
      return { ok: false, motivo: MSJ_IFRAME, codigo: 'iframe' };
    }
    return { ok: true, motivo: '', codigo: '' };
  }

  // ------------------------------------------------------- camara elegida --

  function normalizarModo(valor) {
    var v = valor;
    if (esObjeto(v)) v = v.ideal || v.exact || '';
    v = String(v || '').trim().toLowerCase();
    if (v === 'user' || v === 'frontal' || v === 'delantera') return 'user';
    return MODO_DEFECTO;
  }

  /**
   * La eleccion vive en sessionStorage, no en localStorage: es una preferencia
   * de la sesion, no un dato que valga la pena conservar en el dispositivo. No
   * es ningun secreto (el contrato prohibe guardar tokens, no preferencias).
   */
  function leerModo() {
    try {
      var v = window.sessionStorage.getItem(CLAVE_CAMARA);
      if (v === 'user' || v === 'environment') return v;
    } catch (e) {
      // Safari en navegacion privada lanza al tocar sessionStorage.
    }
    return null;
  }

  function guardarModo(modo) {
    try {
      window.sessionStorage.setItem(CLAVE_CAMARA, modo);
    } catch (e) {
      // Sin almacenamiento la app sigue: solo se pierde la preferencia.
    }
  }

  // ------------------------------------------------------------- getUserMedia --

  function nombreError(e) {
    if (!e) return '';
    return String(e.name || e.code || '');
  }

  function esRestriccion(e) {
    var n = nombreError(e);
    return n === 'OverconstrainedError' || n === 'ConstraintNotSatisfiedError';
  }

  /** Traduce el error de getUserMedia a un mensaje accionable en espanol. */
  function traducir(e) {
    if (e && e.esCamara) return e;
    switch (nombreError(e)) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
      case 'PermissionDismissedError':
        return errorCamara(MSJ_PERMISO, 'permiso_denegado');
      case 'SecurityError':
        return errorCamara(MSJ_SEGURIDAD, 'seguridad');
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return errorCamara(MSJ_SIN_CAMARA, 'sin_camara');
      case 'NotReadableError':
      case 'TrackStartError':
      case 'SourceUnavailableError':
        return errorCamara(MSJ_OCUPADA, 'camara_ocupada');
      case 'OverconstrainedError':
      case 'ConstraintNotSatisfiedError':
        return errorCamara(MSJ_RESTRICCIONES, 'restricciones');
      case 'AbortError':
        return errorCamara(MSJ_INTERRUMPIDA, 'interrumpida');
      case 'TypeError':
        return errorCamara(MSJ_NAVEGADOR, 'navegador');
      default:
        return errorCamara(MSJ_GENERICO, 'desconocido');
    }
  }

  /**
   * Pide el stream y, si la camara rechaza las restricciones, reintenta con
   * `video: true`. Ese reintento salva a los Android de gama baja y a varias
   * webcams de escritorio, que no aceptan facingMode ni 1280x720 y responden
   * OverconstrainedError: sin el reintento la app quedaria inutilizable ahi.
   */
  async function pedirStream(modo, o) {
    var restricciones = {
      audio: false,
      video: {
        facingMode: { ideal: modo },
        width: { ideal: enteroPositivo(o.ancho) || ANCHO_IDEAL },
        height: { ideal: enteroPositivo(o.alto) || ALTO_IDEAL }
      }
    };
    try {
      return await navigator.mediaDevices.getUserMedia(restricciones);
    } catch (e) {
      if (!esRestriccion(e)) throw e;
      return await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    }
  }

  function pistasDe(stream) {
    if (!stream) return [];
    try {
      if (typeof stream.getTracks === 'function') return stream.getTracks() || [];
      if (typeof stream.getVideoTracks === 'function') return stream.getVideoTracks() || [];
    } catch (e) {
      return [];
    }
    return [];
  }

  /**
   * true cuando ya no queda ninguna pista de video viva.
   *
   * Hace falta ademas del evento 'ended': por especificacion, stop() no dispara
   * 'ended', y un <video> con la pista terminada se queda con el ultimo frame
   * a la vista. Sin esta comprobacion, capturar() devolveria ese frame viejo
   * como si fuera de ahora, que es exactamente la puerta que el anti-trampa no
   * puede dejar abierta.
   */
  function sinPistaViva(stream) {
    var pistas = pistasDe(stream);
    if (!pistas.length) return true;
    for (var i = 0; i < pistas.length; i++) {
      if (pistas[i].readyState !== 'ended') return false;
    }
    return true;
  }

  /** Detiene todas las pistas. Es lo que apaga la luz de la camara. */
  function detener(stream) {
    var pistas = pistasDe(stream);
    for (var i = 0; i < pistas.length; i++) {
      try {
        if (typeof pistas[i].stop === 'function') pistas[i].stop();
      } catch (e) {
        // Una pista que ya termino tira excepcion; da igual, el objetivo es que
        // ninguna quede viva.
      }
    }
  }

  /**
   * Deja el <video> como lo necesita un celular:
   *  - muted ANTES de asignar srcObject, o iOS no arranca el autoplay.
   *  - playsInline (atributo y propiedad, mas el webkit- historico): sin esto
   *    iOS abre el video en pantalla completa y rompe la vista con la pose
   *    encima del visor, que es justo lo que sostiene el anti-trampa.
   */
  function prepararVideo(videoEl) {
    try {
      videoEl.muted = true;
      videoEl.defaultMuted = true;
      videoEl.setAttribute('muted', '');
      videoEl.autoplay = true;
      videoEl.setAttribute('autoplay', '');
      videoEl.playsInline = true;
      videoEl.setAttribute('playsinline', '');
      videoEl.setAttribute('webkit-playsinline', 'true');
      videoEl.controls = false;
      videoEl.removeAttribute('poster');
    } catch (e) {
      // Un nodo que no acepta estas propiedades no es un video usable; el
      // fallo real aparecera al asignar srcObject.
    }
  }

  /**
   * Espera a que el video informe dimensiones reales. No basta con
   * loadedmetadata: en iOS ese evento llega con videoWidth 0 y capturar ahi
   * produce una imagen negra, el fallo mas reportado de este tipo de app. Por
   * eso se exige videoWidth > 0 y se escuchan tambien loadeddata y canplay.
   */
  function esperarMetadatos(videoEl) {
    return new Promise(function (resolver, rechazar) {
      if (videoEl.readyState >= 1 && videoEl.videoWidth > 0) {
        resolver();
        return;
      }
      var reloj = setTimeout(function () {
        soltar();
        rechazar(errorCamara(MSJ_SIN_METADATOS, 'sin_metadatos'));
      }, MS_METADATOS);

      function soltar() {
        clearTimeout(reloj);
        videoEl.removeEventListener('loadedmetadata', alListo);
        videoEl.removeEventListener('loadeddata', alListo);
        videoEl.removeEventListener('canplay', alListo);
        videoEl.removeEventListener('error', alFallo);
      }

      function alListo() {
        if (!(videoEl.videoWidth > 0)) return;
        soltar();
        resolver();
      }

      function alFallo() {
        soltar();
        rechazar(errorCamara(MSJ_VIDEO_FALLO, 'video'));
      }

      videoEl.addEventListener('loadedmetadata', alListo);
      videoEl.addEventListener('loadeddata', alListo);
      videoEl.addEventListener('canplay', alListo);
      videoEl.addEventListener('error', alFallo);
    });
  }

  function reproducir(videoEl) {
    try {
      var p = videoEl.play();
      if (p && typeof p.catch === 'function') p.catch(noop);
    } catch (e) {
      // Sin gesto del usuario algunos navegadores no reproducen. El video ya
      // esta muted y con autoplay, asi que normalmente se ve igual; si no, la
      // comprobacion de videoWidth en capturar() lo detecta y avisa.
    }
  }

  /**
   * Si el sistema mata la pista (llamada entrante, la persona cambia de app en
   * iOS, se desconecta la webcam) el video se congela. Sin esta marca,
   * capturar() enviaria el ultimo frame o una imagen negra como si nada.
   */
  function vigilar(stream, generacion) {
    var pistas = pistasDe(stream);
    for (var i = 0; i < pistas.length; i++) {
      try {
        pistas[i].addEventListener('ended', function () {
          if (generacion !== estado.generacion) return;
          estado.perdida = true;
          var aviso = estado.opciones && estado.opciones.alPerder;
          if (typeof aviso === 'function') {
            try { aviso(errorCamara(MSJ_PERDIDA, 'perdida')); } catch (e) { /* la vista decide */ }
          }
        });
      } catch (e) {
        // Pista sin addEventListener: se pierde la deteccion temprana, pero
        // capturar() sigue protegido por la comprobacion de videoWidth.
      }
    }
  }

  function alVolverVisible() {
    if (document.visibilityState !== 'visible') return;
    if (!estado.stream || estado.pausada || !estado.video) return;
    // Volver de segundo plano en iOS deja el video pausado: sin este play() la
    // previa se queda quieta y la persona cree que la camara se colgo.
    reproducir(estado.video);
  }

  function vigilarVisibilidad() {
    if (estado.vigilandoVisibilidad) return;
    try {
      document.addEventListener('visibilitychange', alVolverVisible);
      estado.vigilandoVisibilidad = true;
    } catch (e) {
      // Sin el evento solo se pierde el reintento automatico.
    }
  }

  function desvigilarVisibilidad() {
    if (!estado.vigilandoVisibilidad) return;
    try {
      document.removeEventListener('visibilitychange', alVolverVisible);
    } catch (e) {
      // Nada que hacer: el listener se va con la pagina.
    }
    estado.vigilandoVisibilidad = false;
  }

  // ------------------------------------------------------------- apertura --

  /**
   * abrir(videoEl, opts) -> Promise<{ancho, alto, camara, demo}>
   *
   * opts admite:
   *   facingMode  'environment' (por defecto) o 'user'
   *   ancho, alto resolucion ideal, no exacta
   *   alPerder    funcion avisada si el sistema corta la camara
   *
   * Cierra cualquier stream anterior antes de pedir uno nuevo: dos streams
   * vivos a la vez dejan la camara ocupada y la luz encendida.
   */
  async function abrir(videoEl, opts) {
    var o = esObjeto(opts) ? opts : {};

    if (!esVideo(videoEl)) throw errorCamara(MSJ_SIN_VIDEO, 'sin_video');

    var apoyo = soportada();
    if (!apoyo.ok) throw errorCamara(apoyo.motivo, apoyo.codigo);

    cerrar();
    var gen = ++estado.generacion;

    var modo = normalizarModo(o.facingMode || o.camara || leerModo() || MODO_DEFECTO);
    estado.video = videoEl;
    estado.opciones = o;
    estado.modo = modo;
    estado.pausada = false;
    estado.perdida = false;
    guardarModo(modo);

    if (esDemo()) {
      // La demo no toca la camara. Se pinta una imagen sintetica como poster
      // del video para que el visor no quede en negro.
      estado.demo = true;
      prepararVideo(videoEl);
      try {
        videoEl.poster = lienzoDemo().toDataURL(MIME, CALIDAD_THUMB);
      } catch (e) {
        // Sin poster la demo funciona igual; capturar() sigue devolviendo foto.
      }
      return { ancho: DEMO_ANCHO, alto: DEMO_ALTO, camara: modo, demo: true };
    }

    var stream;
    try {
      stream = await pedirStream(modo, o);
    } catch (e) {
      if (gen === estado.generacion) cerrar();
      throw traducir(e);
    }

    // Mientras se esperaba el permiso alguien pudo volver a abrir o salir de la
    // vista: el stream recien llegado se apaga en vez de quedar huerfano.
    if (gen !== estado.generacion) {
      detener(stream);
      throw errorCamara(MSJ_CANCELADA, 'cancelada');
    }

    prepararVideo(videoEl);
    try {
      videoEl.srcObject = stream;
    } catch (e) {
      detener(stream);
      if (gen === estado.generacion) cerrar();
      throw errorCamara(MSJ_NAVEGADOR, 'sin_srcobject');
    }

    estado.stream = stream;

    try {
      await esperarMetadatos(videoEl);
    } catch (e) {
      // Importante apagar aqui: la camara ya esta encendida aunque no de imagen.
      if (gen === estado.generacion) cerrar();
      else detener(stream);
      throw e;
    }

    if (gen !== estado.generacion) {
      detener(stream);
      throw errorCamara(MSJ_CANCELADA, 'cancelada');
    }

    reproducir(videoEl);
    vigilar(stream, gen);
    vigilarVisibilidad();

    return {
      ancho: videoEl.videoWidth || 0,
      alto: videoEl.videoHeight || 0,
      camara: modo,
      demo: false
    };
  }

  /**
   * cerrar() -> boolean
   *
   * Detiene todas las pistas y limpia srcObject. Es idempotente: llamarlo dos
   * veces, o sin haber abierto nunca, no hace nada y no lanza.
   *
   * Hay que llamarlo al salir de la vista de registro, al enviar el registro y
   * antes de cambiar de camara. Si no se llama, la luz de la camara se queda
   * encendida, el telefono consume bateria sin motivo y la persona ve que la
   * app la sigue mirando: eso mata la confianza en el reto.
   *
   * Conserva la eleccion de camara (frontal o trasera) para el siguiente abrir().
   */
  function cerrar() {
    estado.generacion++;
    desvigilarVisibilidad();

    var video = estado.video;
    var stream = estado.stream;

    if (stream) detener(stream);

    if (video) {
      try { video.pause(); } catch (e) { /* ya estaba detenido */ }
      try {
        video.srcObject = null;
      } catch (e) {
        try { video.removeAttribute('src'); } catch (e2) { /* nada mas que hacer */ }
      }
      try { video.removeAttribute('poster'); } catch (e) { /* nada mas que hacer */ }
    }

    estado.stream = null;
    estado.video = null;
    estado.opciones = null;
    estado.pausada = false;
    estado.perdida = false;
    estado.demo = false;
    return true;
  }

  /**
   * cambiarCamara() -> Promise<{ancho, alto, camara, demo}>
   *
   * Alterna entre 'user' y 'environment' reabriendo el stream y recuerda la
   * eleccion en sessionStorage. Si la camara nueva falla (hay telefonos donde
   * la frontal no acepta las restricciones) vuelve a la anterior para no dejar
   * al usuario sin visor, y despues lanza el error para que la vista lo avise.
   */
  async function cambiarCamara() {
    var video = estado.video;
    var opciones = esObjeto(estado.opciones) ? estado.opciones : {};
    var anterior = estado.modo || leerModo() || MODO_DEFECTO;
    var siguiente = anterior === 'user' ? 'environment' : 'user';

    if (!video) {
      // Sin visor abierto solo se anota la preferencia para el proximo abrir().
      estado.modo = siguiente;
      guardarModo(siguiente);
      return { ancho: 0, alto: 0, camara: siguiente, demo: esDemo() };
    }

    try {
      return await abrir(video, conModo(opciones, siguiente));
    } catch (e) {
      guardarModo(anterior);
      try {
        await abrir(video, conModo(opciones, anterior));
      } catch (e2) {
        // Si tampoco se puede volver, el error que se reporta es el primero:
        // describe lo que la persona intentaba hacer.
      }
      throw traducir(e);
    }
  }

  function conModo(opciones, modo) {
    var copia = {};
    Object.keys(opciones).forEach(function (k) { copia[k] = opciones[k]; });
    copia.facingMode = modo;
    return copia;
  }

  // --------------------------------------------------------------- previa --

  /**
   * congelar() -> boolean
   *
   * Detiene la reproduccion dejando el ultimo frame a la vista, para el paso de
   * "confirmar antes de enviar". No detiene las pistas: la camara sigue
   * encendida y reanudar() es instantaneo, sin volver a pedir permiso.
   */
  function congelar() {
    if (!estado.video) return false;
    try { estado.video.pause(); } catch (e) { /* seguimos marcando la pausa */ }
    estado.pausada = true;
    return true;
  }

  /** reanudar() -> boolean. Vuelve a mover la previa tras un congelar(). */
  function reanudar() {
    estado.pausada = false;
    if (!estado.video) return false;
    reproducir(estado.video);
    return true;
  }

  /** enPausa() -> boolean. true mientras la previa esta congelada. */
  function enPausa() {
    return !!estado.pausada;
  }

  /**
   * previa(base64) -> data URI o null
   *
   * Convierte el base64 de capturar() en algo que se pueda poner en el src de
   * un <img class="visor__previa"> para revisar la foto antes de enviarla.
   *
   * Acepta la cadena suelta o el objeto {base64, mime} tal como sale de
   * capturar(). Valida el alfabeto base64 y devuelve null si no cuadra: asi
   * nunca se puede colar otro esquema (javascript:, por ejemplo) en un src.
   */
  function previa(entrada) {
    var b64 = esObjeto(entrada) ? entrada.base64 : entrada;
    if (typeof b64 !== 'string') return null;

    var limpio = b64.trim();
    if (!limpio) return null;

    if (RE_DATA.test(limpio)) {
      var corte = limpio.indexOf('base64,');
      if (corte < 0) return null;
      limpio = limpio.slice(corte + 7);
    }
    limpio = limpio.replace(RE_ESPACIOS, '');
    if (!limpio || limpio.length % 4 !== 0 || !RE_BASE64.test(limpio)) return null;

    return 'data:' + MIME + ';base64,' + limpio;
  }

  // ----------------------------------------------------------- bytes y hash --

  /** ArrayBuffer -> base64 estandar, por trozos para no reventar la pila. */
  function aBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var trozo = 0x8000;
    var partes = [];
    for (var i = 0; i < bytes.length; i += trozo) {
      partes.push(String.fromCharCode.apply(null, bytes.subarray(i, i + trozo)));
    }
    return window.btoa(partes.join(''));
  }

  /** base64 -> ArrayBuffer. Solo se usa en la ruta de reserva sin toBlob. */
  function deBase64(b64) {
    var crudo = window.atob(b64);
    var bytes = new Uint8Array(crudo.length);
    for (var i = 0; i < crudo.length; i++) bytes[i] = crudo.charCodeAt(i) & 0xff;
    return bytes.buffer;
  }

  /**
   * SHA-256 hexadecimal en minusculas de los BYTES del JPEG.
   *
   * Sobre el ArrayBuffer, nunca sobre la cadena base64: el servidor decodifica
   * y hashea los bytes, y compara con este valor. Hashear la cadena daria un
   * hash distinto y todo registro se rechazaria.
   */
  async function sha256Hex(buffer) {
    var sub = window.crypto && window.crypto.subtle;
    if (!sub || typeof sub.digest !== 'function') {
      throw errorCamara(MSJ_SIN_HASH, 'sin_hash');
    }
    var resumen = await sub.digest('SHA-256', buffer);
    var bytes = new Uint8Array(resumen);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      var parte = bytes[i].toString(16);
      hex += parte.length === 1 ? '0' + parte : parte;
    }
    return hex;
  }

  /**
   * Lienzo -> ArrayBuffer con el JPEG.
   *
   * Se prefiere toBlob porque entrega los bytes reales: de ahi salen el hash y
   * el base64, asi que ambos describen exactamente el mismo archivo. La reserva
   * con toDataURL existe para navegadores viejos y decodifica el base64 a bytes
   * para no cambiar la regla del hash.
   */
  function aJpeg(lienzo, calidad) {
    return new Promise(function (resolver, rechazar) {
      function porDataUri() {
        var uri = '';
        try {
          uri = lienzo.toDataURL(MIME, calidad);
        } catch (e) {
          rechazar(errorCamara(MSJ_JPEG, 'jpeg'));
          return;
        }
        var corte = typeof uri === 'string' ? uri.indexOf('base64,') : -1;
        if (corte < 0 || uri.indexOf(MIME) < 0) {
          rechazar(errorCamara(MSJ_JPEG, 'jpeg'));
          return;
        }
        try {
          resolver(deBase64(uri.slice(corte + 7)));
        } catch (e) {
          rechazar(errorCamara(MSJ_JPEG, 'jpeg'));
        }
      }

      if (typeof lienzo.toBlob !== 'function') {
        porDataUri();
        return;
      }

      try {
        lienzo.toBlob(function (blob) {
          if (!blob) {
            porDataUri();
            return;
          }
          if (typeof blob.arrayBuffer === 'function') {
            blob.arrayBuffer().then(resolver, function () {
              rechazar(errorCamara(MSJ_JPEG, 'jpeg'));
            });
            return;
          }
          var lector = new FileReader();
          lector.onload = function () { resolver(lector.result); };
          lector.onerror = function () { rechazar(errorCamara(MSJ_JPEG, 'jpeg')); };
          try {
            lector.readAsArrayBuffer(blob);
          } catch (e) {
            rechazar(errorCamara(MSJ_JPEG, 'jpeg'));
          }
        }, MIME, calidad);
      } catch (e) {
        porDataUri();
      }
    });
  }

  /**
   * Exporta bajando calidad hasta caber en el tope de bytes. Rendirse en el
   * primer intento seria peor: una foto con mucho detalle puede pasarse de
   * 1,5 MB y la persona ya se peso, no se le puede pedir que empiece de nuevo.
   */
  async function exportar(lienzo, calidades, maxBytes, queEs) {
    var ultimo = 0;
    for (var i = 0; i < calidades.length; i++) {
      var buffer = await aJpeg(lienzo, calidades[i]);
      ultimo = buffer.byteLength;
      if (ultimo <= maxBytes) {
        return { buffer: buffer, calidad: calidades[i] };
      }
    }
    throw errorCamara(
      'La ' + queEs + ' sigue pesando ' + Math.round(ultimo / 1024) + ' KB y el ' +
      'máximo permitido es ' + Math.round(maxBytes / 1024) + ' KB, incluso en la ' +
      'calidad más baja. Vuelve a tomarla más cerca del objeto o con menos ' +
      'cosas de fondo.',
      'foto_pesada'
    );
  }

  // -------------------------------------------------------------- captura --

  function medidas(ancho, alto, ladoMax) {
    var mayor = Math.max(ancho, alto);
    if (!(mayor > 0)) return null;
    var escala = mayor > ladoMax ? ladoMax / mayor : 1;
    return {
      ancho: Math.max(1, Math.round(ancho * escala)),
      alto: Math.max(1, Math.round(alto * escala))
    };
  }

  /** Dibuja una fuente (video o lienzo) reescalada al lado mayor pedido. */
  function dibujar(fuente, ancho, alto, ladoMax) {
    var m = medidas(ancho, alto, ladoMax);
    if (!m) throw errorCamara(MSJ_SIN_IMAGEN, 'sin_imagen');

    var lienzo = document.createElement('canvas');
    lienzo.width = m.ancho;
    lienzo.height = m.alto;

    var ctx = lienzo.getContext('2d');
    if (!ctx) throw errorCamara(MSJ_JPEG, 'sin_lienzo');

    if (typeof ctx.imageSmoothingQuality === 'string') ctx.imageSmoothingQuality = 'high';
    // Fondo opaco: el JPEG no tiene transparencia y un lienzo vacio saldria
    // negro en los bordes si la fuente no cubre todo.
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, m.ancho, m.alto);
    ctx.drawImage(fuente, 0, 0, m.ancho, m.alto);

    return { lienzo: lienzo, ancho: m.ancho, alto: m.alto };
  }

  function textoFechaDemo() {
    var u = window.U;
    var ahora = new Date();
    var iso = u && typeof u.hoyISO === 'function' ? u.hoyISO() : '';
    var fecha = u && typeof u.fmtFecha === 'function' && iso ? u.fmtFecha(iso) : iso;
    var dos = function (n) { return n < 10 ? '0' + n : String(n); };
    var hora = dos(ahora.getHours()) + ':' + dos(ahora.getMinutes()) + ':' +
      dos(ahora.getSeconds());
    return { fecha: fecha || iso, hora: hora };
  }

  /**
   * Imagen sintetica del modo demo: un rectangulo con la fecha y un texto.
   * Lleva la hora con segundos y un contador para que dos capturas nunca den
   * los mismos bytes; si dieran el mismo hash, el backend real las rechazaria
   * como FOTO_DUPLICADA y la demo no serviria para probar el flujo.
   */
  function lienzoDemo() {
    contadorDemo++;
    var lienzo = document.createElement('canvas');
    lienzo.width = DEMO_ANCHO;
    lienzo.height = DEMO_ALTO;

    var ctx = lienzo.getContext('2d');
    if (!ctx) throw errorCamara(MSJ_JPEG, 'sin_lienzo');

    var t = textoFechaDemo();

    ctx.fillStyle = '#101418';
    ctx.fillRect(0, 0, DEMO_ANCHO, DEMO_ALTO);

    ctx.fillStyle = '#1d6ff2';
    ctx.fillRect(60, 60, DEMO_ANCHO - 120, DEMO_ALTO - 120);

    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(100, 380, DEMO_ANCHO - 200, 440);

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.font = '700 120px system-ui, -apple-system, Arial, sans-serif';
    ctx.fillText('DEMO', DEMO_ANCHO / 2, 250);

    ctx.font = '600 44px system-ui, -apple-system, Arial, sans-serif';
    ctx.fillText('Foto simulada', DEMO_ANCHO / 2, 480);
    ctx.fillText(t.fecha, DEMO_ANCHO / 2, 560);
    ctx.fillText(t.hora + ' · ' + contadorDemo, DEMO_ANCHO / 2, 640);

    ctx.font = '400 34px system-ui, -apple-system, Arial, sans-serif';
    ctx.fillText('Modo demostración: sin cámara', DEMO_ANCHO / 2, 740);

    return lienzo;
  }

  /**
   * capturar() -> Promise<{full, thumb, hash, ancho, alto, bytes, calidad, origen}>
   *
   *   full  {base64, mime}  lado mayor <= 1280 px, calidad 0.82
   *   thumb {base64, mime}  lado mayor <= 360 px, calidad 0.7
   *   hash  SHA-256 hex en minusculas de los bytes del JPEG de full
   *
   * El base64 va SIN el prefijo "data:image/jpeg;base64,". El backend rechaza
   * cualquier cadena que empiece con "data:", asi que el prefijo solo se agrega
   * al pintar, y eso lo hace previa().
   */
  async function capturar() {
    if (esDemo()) return capturarDemo();

    if (!estado.stream || !estado.video) throw errorCamara(MSJ_CERRADA, 'cerrada');
    // Camara perdida = frame congelado. Se comprueba aqui mismo, no solo con el
    // evento 'ended', para no firmar con el hash una foto de hace un minuto.
    if (estado.perdida || sinPistaViva(estado.stream)) {
      throw errorCamara(MSJ_PERDIDA, 'perdida');
    }

    var video = estado.video;
    var ancho = video.videoWidth || 0;
    var alto = video.videoHeight || 0;

    // Este es el fallo mas comun en iOS: el video existe, se ve el visor, pero
    // todavia no hay frame y el JPEG saldria negro. Mejor un error claro que
    // una foto inservible que ya quedo registrada en el reto.
    if (!(ancho > 0) || !(alto > 0)) throw errorCamara(MSJ_SIN_IMAGEN, 'sin_imagen');

    var full = dibujar(video, ancho, alto, LADO_FULL);
    return await empaquetar(full);
  }

  async function capturarDemo() {
    var base = lienzoDemo();
    var full = dibujar(base, base.width, base.height, LADO_FULL);
    return await empaquetar(full);
  }

  /**
   * Exporta el full, deriva el thumb del MISMO lienzo y calcula el hash.
   * El thumb no se vuelve a leer del video a proposito: entre dos lecturas el
   * frame cambia y la miniatura mostraria un instante distinto al de la foto
   * firmada, justo lo que la verificacion cruzada necesita comparar.
   */
  async function empaquetar(full) {
    var expFull = await exportar(
      full.lienzo,
      [CALIDAD_FULL].concat(CALIDADES_RESERVA),
      MAX_BYTES_FULL,
      'foto'
    );
    var hash = await sha256Hex(expFull.buffer);

    var thumb = dibujar(full.lienzo, full.ancho, full.alto, LADO_THUMB);
    var expThumb = await exportar(
      thumb.lienzo,
      [CALIDAD_THUMB].concat(CALIDADES_RESERVA),
      MAX_BYTES_THUMB,
      'miniatura'
    );

    return {
      full: { base64: aBase64(expFull.buffer), mime: MIME },
      thumb: { base64: aBase64(expThumb.buffer), mime: MIME },
      hash: hash,
      ancho: full.ancho,
      alto: full.alto,
      bytes: expFull.buffer.byteLength,
      calidad: expFull.calidad,
      // El servidor solo acepta 'camara' en la version 1: no hay otra via.
      origen: 'camara'
    };
  }

  // --------------------------------------------------------------- lectura --

  /** abierta() -> boolean. true cuando hay stream vivo (o demo abierta). */
  function abierta() {
    if (estado.demo) return !!estado.video;
    if (!estado.stream || !estado.video || estado.perdida) return false;
    return !sinPistaViva(estado.stream);
  }

  /** camaraActual() -> 'environment' | 'user'. La que se usaria al abrir. */
  function camaraActual() {
    return estado.modo || leerModo() || MODO_DEFECTO;
  }

  window.Camara = {
    soportada: soportada,
    abrir: abrir,
    capturar: capturar,
    cerrar: cerrar,
    cambiarCamara: cambiarCamara,

    congelar: congelar,
    reanudar: reanudar,
    enPausa: enPausa,
    previa: previa,

    abierta: abierta,
    camaraActual: camaraActual,
    MIME: MIME
  };
}());
