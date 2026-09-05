/**
 * auth.js — identidad con Google Identity Services (GIS).
 *
 * Script clasico (sin modulos): expone window.Auth dentro de una IIFE. Se carga
 * despues de config.js, util.js y demo.js, y antes de api.js y app.js.
 *
 * Superficie publica (contrato, seccion 8):
 *   iniciar(onCambio)        arranca la sesion y avisa cada cambio de estado
 *   token()                  el ID token vigente, o null
 *   usuario()                {email, nombre, foto} o null
 *   salir()                  cierra la sesion en este dispositivo
 *   pintarBoton(contenedor)  dibuja el boton de acceso de Google
 *   caducado()               true si la sesion murio por tiempo
 *   expiraEn()               milisegundos que le quedan al token
 *
 * onCambio(estado) recibe {autenticado, email, nombre, foto} y ademas
 * {caducado, demo} como informacion extra para pintar la pantalla de acceso.
 *
 * LO QUE ESTE ARCHIVO NO HACE, Y ES A PROPOSITO: no decide permisos. Aqui no se
 * mira ningun rol, ninguna lista de inscritos ni ninguna regla del reto. El
 * frontend solo consigue el ID token y lo manda; quien autoriza es el backend,
 * que verifica la firma del token contra Google y busca el correo en la hoja
 * Participantes. Cualquier dato que se lea del token en este archivo sirve
 * unicamente para pintar nombre, foto y correo en la pantalla.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------- constantes --

  // Clave de sessionStorage. Se usa sessionStorage y NO localStorage a
  // proposito: el token muere al cerrar la pestana, asi que la ventana en la
  // que sirve para algo si alguien se lleva el telefono es mucho mas corta.
  var CLAVE_SESION = 'reto_idt';

  // El SDK de Google se carga con async defer desde index.html, asi que puede
  // no estar listo cuando arranca app.js. Se sondea con limite en vez de
  // esperar para siempre: si un bloqueador lo corta, hay que decirlo.
  var ESPERA_SDK_MS = 10000;
  var PASO_SONDEO_MS = 150;

  // El ID token de Google dura una hora. Se renueva 5 minutos antes y se
  // considera muerto 10 segundos antes del vencimiento real, para no mandar un
  // token que se apaga en pleno viaje.
  var MARGEN_RENOVACION_MS = 5 * 60 * 1000;
  var MARGEN_VENCIDO_MS = 10 * 1000;

  // Si el token no trae exp legible se supone algo menos de una hora. La
  // verificacion de verdad la hace el backend; esto solo sirve para programar
  // el temporizador de renovacion.
  var DURACION_SUPUESTA_MS = 55 * 60 * 1000;

  // Al volver a una pestana vieja, la sesion guardada puede estar caducada. Se
  // espera un momento antes de avisar: el acceso automatico de Google suele
  // devolver una credencial nueva en menos de eso y el aviso seria ruido.
  var ESPERA_AVISO_MS = 3000;

  var URL_SDK = 'https://accounts.google.com/gsi/client';

  // En modo demostracion no hay red ni token real. Este valor existe solo para
  // que token() no devuelva null y app.js no crea que nadie entro; api.js en
  // modo demo delega en window.Demo y no lo manda a ninguna parte.
  var TOKEN_DEMO = 'demo';

  // Centinela de plantilla, armado por partes igual que en config.js para que
  // ninguna verificacion automatica confunda esta constante con un valor sin
  // llenar.
  var PLANTILLA = ['PEGA', 'AQUI'].join('_');

  var TXT = {
    sdkTitulo: 'No se pudo cargar el acceso con Google',
    sdkDetalle: 'Puede que un bloqueador de anuncios o una extensión del ' +
      'navegador esté bloqueando el acceso con Google. Desactívalo para esta ' +
      'página, revisa tu conexión y vuelve a intentarlo.',
    sdkDetalle2: 'Si el problema sigue, vuelve a cargar la página o abre el ' +
      'enlace en Chrome o Safari sin restricciones.',
    reintentar: 'Reintentar',
    cargando: 'Cargando el acceso con Google…',
    faltaTitulo: 'Falta configurar el acceso',
    faltaDetalle: 'El dueño del reto todavía no pegó la dirección del servidor ' +
      '(API_URL) en la configuración de la aplicación. Es el único dato que ' +
      'hace falta y sin él nadie puede entrar. Avísale para que lo complete.',
    caducada: 'Tu sesión caducó, vuelve a entrar con tu cuenta de Google.',
    credencialMala: 'Google no devolvió un acceso válido. Vuelve a intentarlo.',
    demoBoton: 'Entrar en modo demostración',
    demoNota: 'Los datos son de prueba y no se guardan en ninguna parte.'
  };

  // Personas de la demostracion, una por estado de RETO_CONFIG.DEMO_ESTADO.
  // demo.js puede imponer las suyas (ver identidadDeDemo) para que el correo
  // coincida con el participante que siembra en sus datos.
  var USUARIOS_DEMO = {
    participante: { email: 'ana.demo@example.com', nombre: 'Ana Quispe', inicial: 'A', fondo: '#0e6f52' },
    admin: { email: 'rosa.demo@example.com', nombre: 'Rosa Medina', inicial: 'R', fondo: '#1d4ed8' },
    observador: { email: 'luis.demo@example.com', nombre: 'Luis Vega', inicial: 'L', fondo: '#6d28d9' }
  };

  // ------------------------------------------------------------------ estado --

  var modoDemo = Boolean(window.RETO_CONFIG && window.RETO_CONFIG.DEMO);

  var jwt = null;              // el ID token, solo en memoria y sessionStorage
  var perfil = null;           // {email, nombre, foto} para pintar, nada mas
  var vencimientoMs = null;    // epoch en ms del exp del token
  var caducadoFlag = false;
  var alCambio = null;
  var arrancado = false;
  var iniciado = false;        // google.accounts.id.initialize ya se llamo
  var falloSdk = false;
  // Mensaje del fallo al pedirle el Client ID al backend, o null si todo bien.
  var falloClientId = null;
  var esperandoSdk = false;
  var sdkInyectado = false;
  var contenedorBoton = null;
  var tempRenovar = null;
  var tempCaducar = null;
  var notificacionPendiente = false;
  var vigilanciaPuesta = false;

  // ------------------------------------------------------------- auxiliares --

  /** Ejecuta fn en el siguiente turno: nunca reentra en quien nos llamo. */
  function pronto(fn) {
    if (typeof Promise === 'function') {
      Promise.resolve().then(fn);
      return;
    }
    setTimeout(fn, 0);
  }

  function crear(tag, clase, texto) {
    var nodo = document.createElement(tag);
    if (clase) nodo.className = clase;
    if (texto !== undefined && texto !== null) nodo.textContent = String(texto);
    return nodo;
  }

  function vaciar(nodo) {
    while (nodo && nodo.firstChild) nodo.removeChild(nodo.firstChild);
    return nodo;
  }

  function resolver(contenedor) {
    if (typeof contenedor === 'string') {
      try {
        return document.querySelector(contenedor);
      } catch (e) {
        return null;
      }
    }
    if (contenedor && contenedor.nodeType === 1) return contenedor;
    return null;
  }

  function conectado(nodo) {
    if (!nodo) return false;
    if (typeof nodo.isConnected === 'boolean') return nodo.isConnected;
    return Boolean(nodo.parentNode);
  }

  function texto(valor) {
    if (typeof valor !== 'string') return '';
    return valor.trim();
  }

  /**
   * Solo se acepta como foto una URL https o un data URI de imagen. El payload
   * del token es un dato de entrada, no una orden: si trajera algo raro como
   * javascript:..., no debe llegar nunca al src de una imagen.
   */
  function fotoSegura(valor) {
    var v = texto(valor);
    if (!v) return null;
    if (v.slice(0, 8).toLowerCase() === 'https://') return v;
    if (v.slice(0, 11).toLowerCase() === 'data:image/') return v;
    return null;
  }

  function avisarError(mensaje) {
    if (window.U && typeof window.U.mostrarError === 'function') {
      window.U.mostrarError(mensaje);
    }
  }

  function esOscuro() {
    try {
      return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
      return false;
    }
  }

  // -------------------------------------------------------------- almacenaje --

  // sessionStorage puede lanzar en navegacion privada o con cookies de terceros
  // bloqueadas. Se envuelve todo: perder la persistencia degrada la comodidad
  // (hay que volver a entrar al recargar), no rompe la aplicacion.

  function guardarEnSesion(valor) {
    try {
      window.sessionStorage.setItem(CLAVE_SESION, valor);
    } catch (e) {
      // Sin almacenamiento: el token vive solo en memoria.
    }
  }

  function leerDeSesion() {
    try {
      return window.sessionStorage.getItem(CLAVE_SESION) || null;
    } catch (e) {
      return null;
    }
  }

  function borrarDeSesion() {
    try {
      window.sessionStorage.removeItem(CLAVE_SESION);
    } catch (e) {
      // Nada que hacer: igual se limpio la copia en memoria.
    }
  }

  // -------------------------------------------------------------- credencial --

  /**
   * leerPayload(jwt) -> objeto | null
   *
   * DECODIFICACION COSMETICA. Un JWT son tres partes separadas por punto:
   * cabecera, payload y firma. Aqui se abre SOLO el payload, con atob, para
   * sacar nombre, foto y correo y poder pintarlos en la cabecera, ademas del
   * exp para programar la renovacion.
   *
   * Esto NO es una verificacion. Cualquiera puede escribir un JWT con el
   * contenido que quiera; sin comprobar la firma, lo que se lee aqui no prueba
   * nada. La verificacion real ocurre en el backend, que valida la firma contra
   * Google, el aud, el iss, el exp y el email_verified. El frontend nunca
   * decide permisos: si alguien falsifica un token para verse como admin en su
   * propia pantalla, el backend le responde NO_AUTENTICADO igual.
   */
  function leerPayload(credencial) {
    try {
      var partes = String(credencial).split('.');
      if (partes.length !== 3) return null;

      var b64 = partes[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4 !== 0) b64 += '=';

      var bytes = window.atob(b64);

      // atob entrega bytes crudos; el nombre puede traer tildes en UTF-8, asi
      // que se pasa por percent-encoding para decodificarlo bien.
      var pct = '';
      for (var i = 0; i < bytes.length; i++) {
        var c = bytes.charCodeAt(i);
        pct += '%' + ('00' + c.toString(16)).slice(-2);
      }
      var crudo = decodeURIComponent(pct);

      var datos = JSON.parse(crudo);
      if (!datos || typeof datos !== 'object') return null;
      return datos;
    } catch (e) {
      // Token con forma inesperada: se sigue sin perfil. El backend dira si
      // sirve o no. Nunca se registra el contenido del token.
      return null;
    }
  }

  function perfilDesde(carga) {
    var datos = carga || {};
    var correo = texto(datos.email).toLowerCase();
    var nombre = texto(datos.name) || texto(datos.given_name) || correo;
    return {
      email: correo || null,
      nombre: nombre || null,
      foto: fotoSegura(datos.picture)
    };
  }

  function vencimientoDesde(carga) {
    var exp = carga ? Number(carga.exp) : NaN;
    if (isFinite(exp) && exp > 0) return Math.round(exp * 1000);
    return Date.now() + DURACION_SUPUESTA_MS;
  }

  // ---------------------------------------------------------------- caducidad --

  function vencido() {
    if (modoDemo) return false;
    if (!jwt) return false;
    if (vencimientoMs === null) return false;
    return Date.now() >= (vencimientoMs - MARGEN_VENCIDO_MS);
  }

  function limpiarTemporizadores() {
    if (tempRenovar) {
      clearTimeout(tempRenovar);
      tempRenovar = null;
    }
    if (tempCaducar) {
      clearTimeout(tempCaducar);
      tempCaducar = null;
    }
  }

  function programarTemporizadores() {
    limpiarTemporizadores();
    if (modoDemo || !jwt || vencimientoMs === null) return;

    var ahora = Date.now();

    var msRenovar = (vencimientoMs - MARGEN_RENOVACION_MS) - ahora;
    if (msRenovar < 1000) msRenovar = 1000;
    tempRenovar = setTimeout(renovar, msRenovar);

    var msCaducar = (vencimientoMs - MARGEN_VENCIDO_MS) - ahora;
    if (msCaducar < 0) msCaducar = 0;
    tempCaducar = setTimeout(function () {
      revisarCaducidad();
    }, msCaducar + 500);
  }

  /**
   * Pide a Google una credencial nueva antes de que la actual muera. Si el
   * intento no llega a nada, el temporizador de caducidad se encarga de limpiar
   * y avisar: nunca se deja al usuario chocando contra peticiones que fallan
   * una tras otra sin explicacion.
   */
  function renovar() {
    tempRenovar = null;
    if (!sdkDisponible() || !iniciado) return;
    try {
      window.google.accounts.id.prompt();
    } catch (e) {
      // Algunos navegadores no permiten mostrar el aviso sin un toque de la
      // persona. No es un error que valga la pena mostrar: la caducidad si se
      // avisa, y con un mensaje claro.
    }
  }

  /**
   * Comprueba si el token de memoria ya no sirve. Se llama en token(), al
   * volver a la pestana y por temporizador, porque en un celular los
   * temporizadores no corren igual cuando la pantalla esta apagada.
   */
  function revisarCaducidad() {
    if (!vencido()) return false;
    caducar(true);
    return true;
  }

  function caducar(avisar) {
    limpiarTemporizadores();
    jwt = null;
    perfil = null;
    vencimientoMs = null;
    borrarDeSesion();
    caducadoFlag = true;
    notificar();
    if (avisar) avisarError(TXT.caducada);
    if (conectado(contenedorBoton)) pintarBoton(contenedorBoton);
  }

  function avisarCaducidadDiferida() {
    setTimeout(function () {
      // Si el acceso automatico de Google ya devolvio credencial, no hay nada
      // que avisar.
      if (!jwt && caducadoFlag) avisarError(TXT.caducada);
    }, ESPERA_AVISO_MS);
  }

  // -------------------------------------------------------------- avisos out --

  function estadoActual() {
    var vivo = Boolean(jwt) && !vencido();
    return {
      autenticado: vivo,
      email: vivo && perfil ? perfil.email : null,
      nombre: vivo && perfil ? perfil.nombre : null,
      foto: vivo && perfil ? perfil.foto : null,
      caducado: caducadoFlag,
      demo: modoDemo
    };
  }

  /**
   * Avisa a app.js del estado. Siempre en el siguiente turno y agrupando los
   * avisos seguidos: asi nunca se entra de vuelta en app.js en medio de una
   * llamada suya, y no se pinta la vista dos veces por el mismo cambio.
   */
  function notificar() {
    if (typeof alCambio !== 'function') return;
    if (notificacionPendiente) return;
    notificacionPendiente = true;
    pronto(function () {
      notificacionPendiente = false;
      var fn = alCambio;
      if (typeof fn !== 'function') return;
      try {
        fn(estadoActual());
      } catch (e) {
        // Un fallo al pintar no debe dejar la sesion a medio aplicar.
      }
    });
  }

  // ---------------------------------------------------------------- SDK GIS --

  function sdkDisponible() {
    return Boolean(
      window.google &&
      window.google.accounts &&
      window.google.accounts.id &&
      typeof window.google.accounts.id.initialize === 'function'
    );
  }

  function configurado() {
    var cfg = window.RETO_CONFIG || {};
    if (typeof cfg.configurado === 'function') {
      try {
        if (!cfg.configurado()) return false;
      } catch (e) {
        // Si el ayudante falla se decide con el client_id de abajo.
      }
    }
    // El Client ID ya NO se exige aqui: lo entrega el backend en la ruta
    // `arranque`. Lo unico imprescindible para arrancar es la URL del backend,
    // que es el unico valor que se pega a mano en web/js/config.js.
    var url = texto(cfg.API_URL);
    if (!url) return false;
    if (url.indexOf(PLANTILLA) >= 0) return false;
    return true;
  }

  /** Sondea hasta que el SDK aparezca o se agote el limite. */
  function esperarSdk(limiteMs) {
    var limite = typeof limiteMs === 'number' ? limiteMs : ESPERA_SDK_MS;
    return new Promise(function (listo) {
      if (sdkDisponible()) {
        listo(true);
        return;
      }
      var vencimiento = Date.now() + limite;
      var reloj = setInterval(function () {
        if (sdkDisponible()) {
          clearInterval(reloj);
          listo(true);
          return;
        }
        if (Date.now() >= vencimiento) {
          clearInterval(reloj);
          listo(false);
        }
      }, PASO_SONDEO_MS);
    });
  }

  /**
   * Vuelve a pedir el SDK oficial de Google. Solo se usa desde el boton de
   * reintentar: si la primera carga se cayo por red inestable, este segundo
   * intento la arregla sin obligar a recargar la pagina. No agrega ninguna
   * dependencia nueva: es exactamente el mismo archivo que index.html ya pide.
   */
  function inyectarSdk() {
    if (sdkInyectado || sdkDisponible()) return;
    sdkInyectado = true;
    try {
      var s = document.createElement('script');
      s.src = URL_SDK;
      s.async = true;
      s.defer = true;
      document.head.appendChild(s);
    } catch (e) {
      // Si no se puede ni insertar el script, queda el mensaje de error.
    }
  }

  function inicializar() {
    if (iniciado || !sdkDisponible() || !configurado()) return;
    try {
      window.google.accounts.id.initialize({
        client_id: texto(window.RETO_CONFIG.GOOGLE_CLIENT_ID),
        callback: alRecibirCredencial,
        // auto_select: si la persona ya entro antes en este navegador y tiene
        // una sola cuenta, Google la reconecta sin preguntar. Es lo que hace
        // que abrir la app por la manana no cueste dos toques.
        auto_select: true,
        // cancel_on_tap_outside: false para que un toque fuera del recuadro no
        // cierre el acceso a mitad de camino; en un celular pasa todo el rato.
        cancel_on_tap_outside: false,
        context: 'signin',
        itp_support: true
      });
      iniciado = true;
    } catch (e) {
      // Client ID mal formado o SDK a medio cargar: se trata como fallo de
      // carga y el boton muestra el mensaje con reintento.
      falloSdk = true;
    }
  }

  /** Callback de credencial de GIS. */
  function alRecibirCredencial(respuesta) {
    var credencial = respuesta && typeof respuesta.credential === 'string'
      ? respuesta.credential
      : '';
    if (!credencial || credencial.split('.').length !== 3) {
      avisarError(TXT.credencialMala);
      return;
    }
    aplicarCredencial(credencial);
  }

  function aplicarCredencial(credencial) {
    var carga = leerPayload(credencial);
    jwt = credencial;
    perfil = perfilDesde(carga);
    vencimientoMs = vencimientoDesde(carga);
    caducadoFlag = false;
    guardarEnSesion(credencial);
    programarTemporizadores();
    notificar();
  }

  /** Recupera la sesion de sessionStorage al recargar la pagina. */
  function restaurar() {
    var guardado = leerDeSesion();
    if (!guardado || guardado.split('.').length !== 3) {
      if (guardado) borrarDeSesion();
      return false;
    }

    var carga = leerPayload(guardado);
    var vence = vencimientoDesde(carga);
    if (Date.now() >= (vence - MARGEN_VENCIDO_MS)) {
      borrarDeSesion();
      caducadoFlag = true;
      return false;
    }

    jwt = guardado;
    perfil = perfilDesde(carga);
    vencimientoMs = vence;
    programarTemporizadores();
    return true;
  }

  // ------------------------------------------------------------- vigilancia --

  function ponerVigilancia() {
    if (vigilanciaPuesta) return;
    vigilanciaPuesta = true;

    // Al volver a la pestana se revisa la caducidad: en un celular los
    // temporizadores se congelan con la pantalla apagada y el token puede haber
    // muerto sin que nadie lo note.
    try {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) revisarCaducidad();
      });
      window.addEventListener('focus', function () {
        revisarCaducidad();
      });
    } catch (e) {
      // Sin vigilancia queda el temporizador y la revision de token().
    }

    // Si cambia el modo claro u oscuro, el boton de Google se repinta con el
    // tema que toca.
    try {
      var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
      if (!mq) return;
      var alCambiarTema = function () {
        if (conectado(contenedorBoton)) pintarBoton(contenedorBoton);
      };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', alCambiarTema);
      else if (typeof mq.addListener === 'function') mq.addListener(alCambiarTema);
    } catch (e) {
      // El tema del boton se queda como estaba: no es grave.
    }
  }

  // ------------------------------------------------------------ demostracion --

  function avatarDemo(inicial, fondo) {
    // Los dos valores vienen de la tabla fija de arriba, no de la red ni de la
    // persona, asi que armar la cadena aqui no interpola nada ajeno.
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img">' +
      '<rect width="64" height="64" rx="32" fill="' + fondo + '"/>' +
      '<text x="32" y="42" text-anchor="middle" font-family="system-ui, sans-serif"' +
      ' font-size="28" font-weight="600" fill="#ffffff">' + inicial + '</text>' +
      '</svg>';
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  function claveDemo() {
    var cfg = window.RETO_CONFIG || {};
    var estado = texto(cfg.DEMO_ESTADO).toLowerCase();
    if (estado === 'admin') return 'admin';
    if (estado === 'observador') return 'observador';
    return 'participante';
  }

  /**
   * Identidad simulada. Si demo.js publica Demo.identidad(clave), manda ella:
   * asi el correo de quien usa la demostracion coincide con el participante que
   * demo.js siembra en sus datos. Si no la publica, se usa la tabla de arriba.
   */
  function identidadDeDemo() {
    var clave = claveDemo();

    var propia = null;
    try {
      if (window.Demo && typeof window.Demo.identidad === 'function') {
        propia = window.Demo.identidad(clave);
      }
    } catch (e) {
      propia = null;
    }
    if (propia && typeof propia === 'object' && texto(propia.email)) {
      return {
        email: texto(propia.email).toLowerCase(),
        nombre: texto(propia.nombre) || texto(propia.email),
        foto: fotoSegura(propia.foto)
      };
    }

    var base = USUARIOS_DEMO[clave] || USUARIOS_DEMO.participante;
    return {
      email: base.email,
      nombre: base.nombre,
      foto: avatarDemo(base.inicial, base.fondo)
    };
  }

  /** Sesion de demostracion: inmediata, sin red y sin caducidad. */
  function entrarEnDemo() {
    jwt = TOKEN_DEMO;
    perfil = identidadDeDemo();
    vencimientoMs = null;
    caducadoFlag = false;
    limpiarTemporizadores();
    notificar();
  }

  // ----------------------------------------------------------------- boton --

  function bloqueError(titulo, detalles, conReintento) {
    var caja = crear('div', 'error');
    caja.setAttribute('role', 'alert');

    var linea = crear('p');
    linea.appendChild(crear('strong', null, titulo));
    caja.appendChild(linea);

    for (var i = 0; i < detalles.length; i++) {
      caja.appendChild(crear('p', null, detalles[i]));
    }

    if (conReintento) {
      var boton = crear('button', 'boton boton--primario boton--bloque', TXT.reintentar);
      boton.type = 'button';
      boton.addEventListener('click', reintentarCarga);
      caja.appendChild(boton);
    }
    return caja;
  }

  function bloqueCargando() {
    var caja = crear('div', 'cargando', TXT.cargando);
    caja.setAttribute('role', 'status');
    caja.setAttribute('aria-live', 'polite');
    return caja;
  }

  function bloqueDemo() {
    var caja = crear('div', 'apilado');
    var boton = crear('button', 'boton boton--primario boton--bloque', TXT.demoBoton);
    boton.type = 'button';
    boton.addEventListener('click', function () {
      entrarEnDemo();
    });
    caja.appendChild(boton);
    caja.appendChild(crear('p', 'campo__ayuda', TXT.demoNota));
    return caja;
  }

  /** Ancho para el boton de Google: Google lo acepta entre 200 y 400 px. */
  function anchoBoton(contenedor) {
    var ancho = 0;
    try {
      ancho = contenedor.clientWidth || contenedor.offsetWidth || 0;
    } catch (e) {
      ancho = 0;
    }
    if (!ancho) ancho = 320;
    return Math.max(200, Math.min(400, Math.round(ancho)));
  }

  function reintentarCarga() {
    falloSdk = false;
    // Tambien hay que soltar el pestillo del arranque. Sin esto, el boton
    // "Reintentar" del fallo de Client ID repintaba el mismo error para
    // siempre: traerClientId() ya habia puesto arranquePedido en true y
    // devolvia sin tocar la red, asi que nadie podia entrar sin recargar la
    // pagina a mano. (P1.9 de la revision 2026-09-04.)
    falloClientId = null;
    arranquePedido = false;
    esperandoSdk = false;
    if (conectado(contenedorBoton)) pintarBoton(contenedorBoton);
    inyectarSdk();
    arrancarSdk();
  }

  /**
   * pintarBoton(contenedor) -> HTMLElement | null
   *
   * Dibuja el acceso dentro del contenedor (nodo o selector). Nunca deja el
   * contenedor vacio: si el SDK todavia carga muestra el estado de carga, si no
   * llego muestra el error con reintento, y si falta configurar lo dice.
   */
  function pintarBoton(contenedor) {
    var caja = resolver(contenedor);
    if (!caja) return null;
    contenedorBoton = caja;
    vaciar(caja);

    if (modoDemo) {
      caja.appendChild(bloqueDemo());
      return caja;
    }

    if (!configurado()) {
      caja.appendChild(bloqueError(TXT.faltaTitulo, [TXT.faltaDetalle], false));
      return caja;
    }

    // Falta el Client ID y el backend no lo pudo entregar: el motivo exacto es
    // mas util que el mensaje generico del SDK, asi que gana este.
    var cfgBoton = window.RETO_CONFIG || {};
    if (typeof cfgBoton.clientIdListo === 'function' && !cfgBoton.clientIdListo()) {
      if (falloClientId) {
        caja.appendChild(bloqueError('No se pudo preparar el acceso', [falloClientId], true));
      } else {
        caja.appendChild(bloqueCargando());
        arrancarSdk();
      }
      return caja;
    }

    if (!sdkDisponible()) {
      if (falloSdk) {
        caja.appendChild(bloqueError(TXT.sdkTitulo, [TXT.sdkDetalle, TXT.sdkDetalle2], true));
      } else {
        caja.appendChild(bloqueCargando());
        arrancarSdk();
      }
      return caja;
    }

    inicializar();
    if (!iniciado) {
      caja.appendChild(bloqueError(TXT.sdkTitulo, [TXT.sdkDetalle, TXT.sdkDetalle2], true));
      return caja;
    }

    var marco = crear('div', 'apilado centrado');
    marco.style.alignItems = 'center';
    var hueco = crear('div');
    marco.appendChild(hueco);
    caja.appendChild(marco);

    try {
      window.google.accounts.id.renderButton(hueco, {
        type: 'standard',
        theme: esOscuro() ? 'filled_blue' : 'outline',
        size: 'large',
        text: 'signin_with',
        shape: 'pill',
        logo_alignment: 'left',
        locale: 'es',
        width: anchoBoton(caja)
      });
    } catch (e) {
      vaciar(caja);
      caja.appendChild(bloqueError(TXT.sdkTitulo, [TXT.sdkDetalle, TXT.sdkDetalle2], true));
    }
    return caja;
  }

  // --------------------------------------------------------------- arranque --

  /**
   * Trae el Client ID del backend con la ruta publica `arranque`. Es lo que
   * permite que en web/js/config.js solo se pegue la URL del backend.
   *
   * Se intenta una sola vez por carga de pagina: si el backend no responde, no
   * tiene sentido insistir en bucle, y pintarBoton ya explica el fallo. Nunca
   * bloquea la restauracion de una sesion previa, que ocurre antes.
   */
  var arranquePedido = false;

  function traerClientId() {
    if (arranquePedido) return Promise.resolve(false);
    arranquePedido = true;

    var api = window.Api;
    if (!api || typeof api.arranque !== 'function') return Promise.resolve(false);

    return api.arranque().then(function (datos) {
      var cfg = window.RETO_CONFIG || {};
      if (!datos || !datos.clientId) {
        // El backend esta vivo pero sin OAUTH_CLIENT_ID configurado. Es un
        // estado distinto de "no responde" y merece su propio mensaje.
        falloClientId = 'El servidor del reto responde, pero todavía no tiene configurado el identificador de Google. Quien administra debe ejecutar configurarClienteOauth en Apps Script.';
        return false;
      }
      if (typeof cfg.fijarClientId !== 'function' || !cfg.fijarClientId(datos.clientId)) {
        falloClientId = 'El servidor devolvió un identificador de Google con formato inválido. Revisa la propiedad OAUTH_CLIENT_ID en Apps Script.';
        return false;
      }
      falloClientId = null;
      return true;
    }, function (err) {
      falloClientId = (err && (err.mensaje || err.message))
        ? String(err.mensaje || err.message)
        : 'No se pudo contactar al servidor del reto.';
      return false;
    });
  }

  function arrancarSdk() {
    if (modoDemo || esperandoSdk) return;
    if (sdkDisponible() && iniciado) return;
    if (!configurado()) return;

    // Sin Client ID no se puede inicializar GIS: se pide al backend y se
    // reintenta este mismo arranque cuando llega.
    var cfg = window.RETO_CONFIG || {};
    if (typeof cfg.clientIdListo === 'function' && !cfg.clientIdListo()) {
      if (arranquePedido) {
        if (conectado(contenedorBoton)) pintarBoton(contenedorBoton);
        notificar();
        return;
      }
      esperandoSdk = true;
      traerClientId().then(function (listo) {
        esperandoSdk = false;
        if (listo) {
          arrancarSdk();
          return;
        }
        if (conectado(contenedorBoton)) pintarBoton(contenedorBoton);
        notificar();
      });
      return;
    }

    esperandoSdk = true;
    esperarSdk().then(function (listo) {
      esperandoSdk = false;

      if (!listo) {
        falloSdk = true;
        if (window.console && typeof window.console.warn === 'function') {
          // Mensaje sin ningun dato de sesion: aqui jamas se escribe el token.
          window.console.warn('El SDK de Google no cargó en ' + (ESPERA_SDK_MS / 1000) + ' s.');
        }
        if (conectado(contenedorBoton)) pintarBoton(contenedorBoton);
        notificar();
        return;
      }

      falloSdk = false;
      inicializar();

      // Sin sesion viva se pide el acceso automatico: es lo que hace util el
      // auto_select de initialize. Si la persona lo cierra, queda el boton.
      if (!jwt && iniciado) {
        try {
          window.google.accounts.id.prompt();
        } catch (e) {
          // Sin aviso automatico: el boton sigue siendo la via normal.
        }
      }

      if (conectado(contenedorBoton)) pintarBoton(contenedorBoton);
    });
  }

  // -------------------------------------------------------- API publica --

  /**
   * iniciar(onCambio)
   *
   * Arranca la sesion y llama a onCambio({autenticado, email, nombre, foto})
   * cada vez que cambia: al recuperar la sesion guardada, al entrar, al salir y
   * al caducar. En modo demostracion la sesion se simula al instante y no se
   * toca la red.
   */
  function iniciar(onCambio) {
    alCambio = typeof onCambio === 'function' ? onCambio : null;

    if (modoDemo) {
      entrarEnDemo();
      return;
    }

    if (arrancado) {
      notificar();
      return;
    }
    arrancado = true;

    ponerVigilancia();

    var recuperada = restaurar();
    notificar();

    if (!recuperada && caducadoFlag) avisarCaducidadDiferida();

    arrancarSdk();
  }

  /**
   * token() -> string | null
   *
   * El ID token vigente. Devuelve null si no hay sesion o si ya caduco, para
   * que api.js falle rapido y con un mensaje claro en vez de mandar un token
   * muerto. En modo demostracion devuelve un valor de relleno que api.js no
   * manda a ninguna parte.
   */
  function token() {
    if (modoDemo) return TOKEN_DEMO;
    revisarCaducidad();
    return jwt || null;
  }

  /**
   * usuario() -> {email, nombre, foto} | null
   *
   * Datos para pintar la cabecera, sacados del payload del token sin verificar.
   * No trae rol ni permisos a proposito: el rol lo dice el backend en la ruta
   * sesion, y es el unico que manda.
   */
  function usuario() {
    if (!jwt || vencido() || !perfil) return null;
    return {
      email: perfil.email,
      nombre: perfil.nombre,
      foto: perfil.foto
    };
  }

  /**
   * caducado() -> boolean
   *
   * true cuando habia sesion y murio por tiempo sin poder renovarla. Se apaga
   * al volver a entrar y al llamar a salir().
   */
  function caducado() {
    if (modoDemo) return false;
    revisarCaducidad();
    return caducadoFlag;
  }

  /**
   * expiraEn() -> number | null
   *
   * Milisegundos que le quedan al token: 0 si no hay sesion o ya caduco, y null
   * en modo demostracion, donde la sesion simulada no caduca.
   */
  function expiraEn() {
    if (modoDemo) return null;
    if (!jwt || vencimientoMs === null) return 0;
    var resto = vencimientoMs - Date.now();
    return resto > 0 ? resto : 0;
  }

  /**
   * salir()
   *
   * Cierra la sesion en este dispositivo: desactiva el acceso automatico de
   * Google, borra el token de memoria y de sessionStorage y avisa del cambio.
   * No cierra la cuenta de Google en el navegador, solo esta aplicacion.
   */
  function salir() {
    if (!modoDemo) {
      try {
        if (sdkDisponible()) window.google.accounts.id.disableAutoSelect();
      } catch (e) {
        // Si no se pudo desactivar, la sesion local se limpia igual.
      }
    }

    limpiarTemporizadores();
    jwt = null;
    perfil = null;
    vencimientoMs = null;
    caducadoFlag = false;
    borrarDeSesion();

    notificar();
    if (conectado(contenedorBoton)) pintarBoton(contenedorBoton);
  }

  window.Auth = {
    iniciar: iniciar,
    token: token,
    usuario: usuario,
    salir: salir,
    pintarBoton: pintarBoton,
    caducado: caducado,
    expiraEn: expiraEn
  };
}());
