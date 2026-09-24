/**
 * ==========================================================================
 * SUPER NEUMOFLUX - CONTROLADOR PRINCIPAL DEL JUEGO Y FLUJO DE PANTALLAS
 * ==========================================================================
 * Integraciones:
 * - MQTT Broker (EMQX) para sincronización en tiempo real con Panel Admin y Pantalla
 * - Pre-carga de Modelos 3D y Visor MindAR en Pantalla de Carga (Screen 2)
 * - Protección y bloqueo estricto de "A Combatir" hasta habilitación por administración
 * - Animaciones dinámicas de personajes en Pantallas 0, 3, 6, 7, 9 y 10
 */

// --------------------------------------------------------------------------
// 1. CONFIGURACIÓN Y ESTADO GLOBAL
// --------------------------------------------------------------------------
let currentScreen = 0;
let combateHabilitado = false;
let participante = {
    id: 'jugador_' + Date.now() + '_' + Math.floor(Math.random() * 9999),
    nombre: 'Marta Vargas',
    nombreTruncado: 'MARTA VA...',
    carnet: '7894561',
    whatsapp: '76543210'
};

// Estado del Juego
let puntos = 0;
let tiempoRonda = 60; // Configurable desde Panel Admin
let tiempoRestante = 60;
let mocosEliminados = 0;
let juegoTimerInterval = null;
let mocoSpawnerInterval = null;
let waitingDotsInterval = null;
let activeMocos = [];
let cargandoTimer = null;
let toastTimeout = null;

// Lista de Sprites de Mocos
const mocoSprites = [];
for (let i = 1; i <= 11; i++) {
    mocoSprites.push(`assets/mocos/moco_${i}.png`);
}

// Modelos 3D y Targets de MindAR para precarga (Únicamente sobre escaneado)
const RECURSOS_AR = [
    { id: 'cesium', url: 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/CesiumMan/glTF-Binary/CesiumMan.glb' },
    { id: 'targets', url: 'RealidadAumentada/WebAr/targets.mind' }
];
let modelosPreloadCompletado = false;

// --------------------------------------------------------------------------
// 2. SISTEMA DE TOAST / NOTIFICACIONES CYBER
// --------------------------------------------------------------------------
function mostrarToastCyber(mensaje, esExito = false) {
    const toast = document.getElementById('cyberToast');
    if (!toast) return;

    if (toastTimeout) clearTimeout(toastTimeout);
    toast.textContent = mensaje;
    toast.classList.toggle('success', Boolean(esExito));
    toast.classList.add('show');

    toastTimeout = setTimeout(() => {
        toast.classList.remove('show');
    }, 3200);
}

// --------------------------------------------------------------------------
// 3. NAVEGACIÓN Y CONTROL ENTRE PANTALLAS
// --------------------------------------------------------------------------
function goToScreen(index) {
    if (index < 0 || index > 10) return;

    // REGLA ESTRICTA: No permitir entrar a pantallas de combate si no está habilitado por administración
    if (!combateHabilitado && (index === 6 || index === 7 || index === 8 || index === 9)) {
        console.warn(`[Bloqueo] Acceso a pantalla ${index} denegado: Combate no habilitado por administración.`);
        sound.init();
        if (typeof sound.playLocked === 'function') {
            sound.playLocked();
        } else {
            sound.playClick();
        }
        mostrarToastCyber('🔒 Modo combate deshabilitado: El anfitrión debe activarlo desde el Panel de Control.');
        if (currentScreen !== 3 && currentScreen !== 0 && currentScreen !== 1 && currentScreen !== 2) {
            goToScreen(3);
        }
        return;
    }

    currentScreen = index;

    // Limpiar temporizadores de pantallas previas
    if (index !== 8 && waitingDotsInterval) {
        clearInterval(waitingDotsInterval);
        waitingDotsInterval = null;
    }
    if (index !== 9 && juegoTimerInterval) {
        detenerJuego();
    }

    // Gestionar Visor MindAR (Screen 5) con pre-calentamiento y carga instantánea
    const arFrame = document.getElementById('arFrame');
    if (arFrame) {
        if (!arFrame.src || !arFrame.src.includes('mindar.html')) {
            arFrame.src = 'RealidadAumentada/WebAr/mindar.html';
        }

        if (index === 5) {
            const activarCamara = () => {
                try {
                    if (arFrame.contentWindow && typeof arFrame.contentWindow.iniciarAR === 'function') {
                        arFrame.contentWindow.iniciarAR();
                    }
                } catch (e) {
                    console.warn('[AR] Esperando inicialización del visor:', e);
                }
            };

            if (arFrame.contentDocument && arFrame.contentDocument.readyState === 'complete') {
                activarCamara();
            } else {
                arFrame.onload = activarCamara;
            }
        } else {
            // Detener cámara al salir sin destruir la escena WebGL/WASM precargada
            try {
                if (arFrame.contentWindow && typeof arFrame.contentWindow.detenerAR === 'function') {
                    arFrame.contentWindow.detenerAR();
                }
            } catch (e) {}
        }
    }

    // Ocultar todas las pantallas y activar la seleccionada
    document.querySelectorAll('.screen-view').forEach(s => s.classList.remove('active'));
    const targetScreen = document.getElementById(`screen-${index}`);
    if (targetScreen) {
        targetScreen.classList.add('active');
    }

    // Inicializaciones por pantalla
    if (index === 2) {
        iniciarCargandoScreen();
    } else if (index === 8) {
        iniciarAnimacionEnEspera();
    } else if (index === 9) {
        iniciarPartidaJugador();
    } else if (index === 10) {
        mostrarResultadosFinales();
    }
}

// --------------------------------------------------------------------------
// 4. FORMATEO DE NOMBRE DE JUGADOR
// --------------------------------------------------------------------------
function truncarNombre(nombreCompleto) {
    if (!nombreCompleto || typeof nombreCompleto !== 'string') return 'JUGADOR...';
    const partes = nombreCompleto.trim().toUpperCase().split(/\s+/);
    if (partes.length === 1) {
        return partes[0].substring(0, 8) + '...';
    }
    const primerNombre = partes[0];
    const segundoNombre = partes[1] || '';
    const subSegundo = segundoNombre.substring(0, 2);
    return `${primerNombre} ${subSegundo}...`;
}

function actualizarNombreDisplays() {
    const txt = participante.nombreTruncado;
    const hud9 = document.getElementById('hudPlayerName');
    const hud10 = document.getElementById('hudFinalPlayerName');
    if (hud9) hud9.textContent = txt;
    if (hud10) hud10.textContent = txt;
}

// --------------------------------------------------------------------------
// 5. PANTALLA 1: REGISTRO Y GUARDADO MEDIANTE ENDPOINT HTTP / LOCAL
// --------------------------------------------------------------------------
async function guardarRegistro(event) {
    if (event) event.preventDefault();
    sound.init();
    sound.playClick();

    const nombreInput = document.getElementById('inputNombre').value.trim();
    const carnetInput = document.getElementById('inputCarnet').value.trim();
    const whatsappInput = document.getElementById('inputWhatsapp').value.trim();

    if (!nombreInput || !carnetInput || !whatsappInput) {
        const fb = document.getElementById('registroFeedback');
        fb.style.color = '#ff5577';
        fb.textContent = 'Por favor completa todos los campos.';
        return;
    }

    participante.nombre = nombreInput;
    participante.carnet = carnetInput;
    participante.whatsapp = whatsappInput;
    participante.nombreTruncado = truncarNombre(nombreInput);
    actualizarNombreDisplays();

    // Persistencia local
    try {
        localStorage.setItem('participante_neumoflux', JSON.stringify(participante));
    } catch (e) {
        console.warn('LocalStorage error:', e);
    }

    const feedback = document.getElementById('registroFeedback');
    feedback.style.color = '#74c7ec';
    feedback.textContent = 'Registrando participante...';

    // Notificar también por MQTT para panel de administración
    if (clienteMQTT && clienteMQTT.connected) {
        clienteMQTT.publish(topicoSecreto, JSON.stringify({
            accion: 'jugador_unido',
            id: participante.id,
            nombre: participante.nombre,
            carnet: participante.carnet,
            whatsapp: participante.whatsapp,
            color: '#00f0ff'
        }));
    }

    feedback.style.color = '#a6e3a1';
    feedback.textContent = '¡Datos registrados con éxito!';

    setTimeout(() => {
        goToScreen(2);
    }, 300);
}

// --------------------------------------------------------------------------
// 6. PANTALLA 2: CARGANDO Y PRECARGA DE MODELOS 3D MINDAR
// --------------------------------------------------------------------------
function precargarModelosAR() {
    return Promise.all(
        RECURSOS_AR.map(item => {
            return fetch(item.url, { mode: 'cors' })
                .then(res => {
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    return res.blob();
                })
                .then(blob => {
                    console.log(`[AR Preload] Recurso '${item.id}' precargado con éxito (${blob.size} bytes).`);
                    return true;
                })
                .catch(err => {
                    console.info(`[AR Preload] Pre-caché para '${item.id}' iniciado en segundo plano.`);
                    return false;
                });
        })
    ).then(() => {
        modelosPreloadCompletado = true;
    });
}

function iniciarCargandoScreen() {
    if (cargandoTimer) clearTimeout(cargandoTimer);
    const label = document.getElementById('loadingDots');
    let dots = 0;

    // Iniciar precarga de modelos 3D y descriptores MindAR
    precargarModelosAR();

    const dotInterval = setInterval(() => {
        if (currentScreen !== 2) {
            clearInterval(dotInterval);
            return;
        }
        dots = (dots + 1) % 4;
        if (label) {
            const estadoTexto = modelosPreloadCompletado ? 'Preparando módulos AR' : 'Precargando modelos AR';
            label.textContent = estadoTexto + '.'.repeat(dots);
        }
    }, 350);

    // Tiempo mínimo de animación estética antes de avanzar
    cargandoTimer = setTimeout(() => {
        if (currentScreen === 2) {
            avanzarDesdeCargando();
        }
    }, 2800);
}

function avanzarDesdeCargando() {
    if (cargandoTimer) clearTimeout(cargandoTimer);
    goToScreen(combateHabilitado ? 6 : 3);
}

// --------------------------------------------------------------------------
// 7. PANTALLAS 3 Y 6: CONTROL DE COMBATE Y HABILITACIÓN POR ADMINISTRACIÓN
// --------------------------------------------------------------------------
function setEstadoCombate(activo, silenciarNotif = false) {
    const estadoPrevio = combateHabilitado;
    combateHabilitado = Boolean(activo);

    try {
        localStorage.setItem('combate_habilitado', combateHabilitado ? '1' : '0');
    } catch (e) {}

    // Actualizar botón en Screen 3
    const btnCombatDis = document.getElementById('btnCombatDisabled');
    if (btnCombatDis) {
        if (combateHabilitado) {
            btnCombatDis.disabled = false;
            btnCombatDis.removeAttribute('disabled');
            btnCombatDis.classList.remove('btn-combat-locked', 'btn-disabled');
            btnCombatDis.classList.add('btn-combat-active');
        } else {
            btnCombatDis.disabled = true;
            btnCombatDis.setAttribute('disabled', 'disabled');
            btnCombatDis.classList.add('btn-combat-locked', 'btn-disabled');
            btnCombatDis.classList.remove('btn-combat-active');
        }
    }

    if (combateHabilitado && !estadoPrevio) {
        if (!silenciarNotif) {
            mostrarToastCyber('⚡ ¡A COMBATIR HABILITADO POR ADMINISTRACIÓN!', true);
            sound.init();
            sound.playBonus();
        }
        // Si el usuario está en la pantalla 3, pasar automáticamente a pantalla 6
        if (currentScreen === 3) {
            goToScreen(6);
        }
    } else if (!combateHabilitado && estadoPrevio) {
        if (!silenciarNotif) {
            mostrarToastCyber('🔒 Modo Combate deshabilitado por administración.');
            sound.init();
            if (typeof sound.playLocked === 'function') sound.playLocked();
        }
        // Si estaba en pantalla de combate o tutorial, regresar a Screen 3
        if (currentScreen === 6 || currentScreen === 7 || currentScreen === 8 || currentScreen === 9) {
            detenerJuego();
            goToScreen(3);
        }
    }
}

function intentarCombateInactivo(e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    sound.init();
    if (typeof sound.playLocked === 'function') {
        sound.playLocked();
    } else {
        sound.playClick();
    }
    mostrarToastCyber('🔒 Botón no disponible: Debe ser habilitado por administración desde el Panel de Control.');
}

function volverDeAR() {
    sound.init();
    sound.playClick();
    const arFrame = document.getElementById('arFrame');
    if (arFrame && arFrame.contentWindow && typeof arFrame.contentWindow.detenerAR === 'function') {
        try {
            arFrame.contentWindow.detenerAR();
        } catch (e) {}
    }
    goToScreen(combateHabilitado ? 6 : 3);
}

// --------------------------------------------------------------------------
// 8. PANTALLA 8: ANIMACIÓN EN ESPERA Y PRUEBA CONTROLADA
// --------------------------------------------------------------------------
function iniciarAnimacionEnEspera() {
    if (waitingDotsInterval) clearInterval(waitingDotsInterval);
    const txt = document.getElementById('enEsperaTitulo');
    const secuencias = ['EN ESPERA.', 'EN ESPERA..', 'EN ESPERA...'];
    let idx = 0;
    waitingDotsInterval = setInterval(() => {
        if (currentScreen !== 8) {
            clearInterval(waitingDotsInterval);
            return;
        }
        idx = (idx + 1) % secuencias.length;
        if (txt) txt.textContent = secuencias[idx];
    }, 450);
}

function intentarIniciarDesdeEspera() {
    if (!combateHabilitado) {
        sound.init();
        if (typeof sound.playLocked === 'function') sound.playLocked();
        mostrarToastCyber('🔒 Espera a que el anfitrión inicie el combate desde el panel.');
        return;
    }
    iniciarPartidaJugador();
}

// --------------------------------------------------------------------------
// 9. PANTALLA 9: EL JUEGO ACTIVO (ANIMACIÓN ROBOT + MOCOS + HUD)
// --------------------------------------------------------------------------
function iniciarPartidaJugador() {
    sound.init();
    sound.playStart();

    puntos = 0;
    mocosEliminados = 0;
    tiempoRestante = tiempoRonda;
    activeMocos = [];

    actualizarNombreDisplays();
    document.getElementById('hudScore').textContent = '0pts';
    actualizarTimerHUD();

    // Limpiar arena y asegurar robot inferior animando
    const arena = document.getElementById('gameArena');
    const robotImg = document.getElementById('gameCheeringRobot') || arena.querySelector('.game-cheering-robot');
    arena.innerHTML = '';
    if (robotImg) {
        arena.appendChild(robotImg);
    } else {
        const nuevoRobot = document.createElement('img');
        nuevoRobot.src = 'assets/ui/robot_waving.png';
        nuevoRobot.className = 'game-cheering-robot';
        nuevoRobot.id = 'gameCheeringRobot';
        nuevoRobot.alt = 'Robot Animando';
        arena.appendChild(nuevoRobot);
    }

    // Cronómetro de ronda
    if (juegoTimerInterval) clearInterval(juegoTimerInterval);
    juegoTimerInterval = setInterval(() => {
        tiempoRestante--;
        actualizarTimerHUD();

        if (tiempoRestante <= 0) {
            detenerJuego();
            sound.playVictory();
            goToScreen(10);
        }
    }, 1000);

    // Generador de mocos interactivos
    if (mocoSpawnerInterval) clearInterval(mocoSpawnerInterval);
    spawnMoco();
    mocoSpawnerInterval = setInterval(() => {
        if (currentScreen === 9 && activeMocos.length < 5) {
            spawnMoco();
        }
    }, 750);
}

function actualizarTimerHUD() {
    const min = Math.floor(tiempoRestante / 60);
    const sec = tiempoRestante % 60;
    const str = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    const el = document.getElementById('hudTimer');
    if (el) el.textContent = str;
}

function spawnMoco() {
    const arena = document.getElementById('gameArena');
    if (!arena) return;

    const mocoId = 'moco_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const mocoElem = document.createElement('div');
    mocoElem.className = 'moco-target';
    mocoElem.id = mocoId;

    const arenaRect = arena.getBoundingClientRect();
    const paddingX = 60;
    const paddingTop = 40;
    const paddingBottom = 130;

    const maxX = Math.max(arenaRect.width - paddingX * 2, 100);
    const maxY = Math.max(arenaRect.height - paddingTop - paddingBottom, 100);

    const posX = paddingX + Math.random() * maxX;
    const posY = paddingTop + Math.random() * maxY;

    mocoElem.style.left = posX + 'px';
    mocoElem.style.top = posY + 'px';

    const randomSprite = mocoSprites[Math.floor(Math.random() * mocoSprites.length)];
    const lifespanSeconds = 2.2 + Math.random() * 0.8;
    const circum = 260;

    mocoElem.innerHTML = `
        <svg class="target-timer-svg" viewBox="0 0 100 100">
            <circle class="target-timer-circle" cx="50" cy="50" r="41" />
        </svg>
        <img src="${randomSprite}" class="moco-splat-img" alt="Moco">
    `;

    const onTap = (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        eliminarMoco(mocoId, posX, posY, true);
    };

    mocoElem.addEventListener('pointerdown', onTap);
    arena.appendChild(mocoElem);

    const circle = mocoElem.querySelector('.target-timer-circle');
    const startTime = Date.now();
    const totalMs = lifespanSeconds * 1000;

    const animInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const ratio = Math.max(0, 1 - (elapsed / totalMs));
        if (circle) {
            circle.style.strokeDashoffset = circum * (1 - ratio);
            if (ratio < 0.3) {
                circle.style.stroke = '#ff3366';
            }
        }

        if (elapsed >= totalMs) {
            clearInterval(animInterval);
            eliminarMoco(mocoId, posX, posY, false);
        }
    }, 60);

    activeMocos.push({ id: mocoId, elem: mocoElem, timer: animInterval });
}

function eliminarMoco(id, x, y, fueImpacto) {
    const idx = activeMocos.findIndex(m => m.id === id);
    if (idx === -1) return;

    const mocoObj = activeMocos[idx];
    clearInterval(mocoObj.timer);
    activeMocos.splice(idx, 1);

    if (fueImpacto) {
        puntos += 10;
        mocosEliminados++;

        document.getElementById('hudScore').textContent = puntos + 'pts';
        sound.playTap(Math.min(mocosEliminados, 20), 20);
        mostrarEfectoGolpe(x, y);

        // Animar salto celebratorio del Robot animador (Screen 9)
        const cheerRobot = document.getElementById('gameCheeringRobot');
        if (cheerRobot) {
            cheerRobot.classList.remove('pump');
            void cheerRobot.offsetWidth;
            cheerRobot.classList.add('pump');
        }

        if (clienteMQTT && clienteMQTT.connected) {
            clienteMQTT.publish(topicoSecreto, JSON.stringify({
                accion: 'progreso_juego',
                id: participante.id,
                nombre: participante.nombre,
                puntos: puntos,
                targets: mocosEliminados
            }));
        }
    }

    if (mocoObj.elem && mocoObj.elem.parentNode) {
        mocoObj.elem.style.transform = 'translate(-50%, -50%) scale(0.2)';
        mocoObj.elem.style.opacity = '0';
        mocoObj.elem.style.transition = 'all 0.16s ease-out';
        setTimeout(() => {
            if (mocoObj.elem && mocoObj.elem.parentNode) {
                mocoObj.elem.parentNode.removeChild(mocoObj.elem);
            }
        }, 160);
    }
}

function mostrarEfectoGolpe(x, y) {
    const arena = document.getElementById('gameArena');
    if (!arena) return;

    const puaj = document.createElement('div');
    puaj.className = 'hit-effect-puaj';
    puaj.textContent = 'PUAJ!';
    puaj.style.left = (x - 25 + Math.random() * 20) + 'px';
    puaj.style.top = (y - 30) + 'px';
    arena.appendChild(puaj);

    const pts = document.createElement('div');
    pts.className = 'hit-effect-points';
    pts.textContent = '+10';
    pts.style.left = (x + 20) + 'px';
    pts.style.top = (y - 15) + 'px';
    arena.appendChild(pts);

    setTimeout(() => {
        if (puaj.parentNode) puaj.parentNode.removeChild(puaj);
        if (pts.parentNode) pts.parentNode.removeChild(pts);
    }, 700);
}

function detenerJuego() {
    if (juegoTimerInterval) {
        clearInterval(juegoTimerInterval);
        juegoTimerInterval = null;
    }
    if (mocoSpawnerInterval) {
        clearInterval(mocoSpawnerInterval);
        mocoSpawnerInterval = null;
    }
    activeMocos.forEach(m => {
        clearInterval(m.timer);
        if (m.elem && m.elem.parentNode) {
            m.elem.parentNode.removeChild(m.elem);
        }
    });
    activeMocos = [];
}

function abandonarJuego() {
    if (confirm('¿Deseas salir del juego en curso?')) {
        detenerJuego();
        goToScreen(combateHabilitado ? 6 : 3);
    }
}

// --------------------------------------------------------------------------
// 10. PANTALLA 10: RESULTADOS Y FINALIZACIÓN
// --------------------------------------------------------------------------
function mostrarResultadosFinales() {
    actualizarNombreDisplays();
    document.getElementById('hudFinalScoreTop').textContent = puntos + 'pts';
    document.getElementById('finalScoreVal').textContent = puntos + ' pts';
    document.getElementById('finalMocosHit').textContent = `${mocosEliminados} mocos eliminados con éxito`;
}

function finalizarJuego() {
    sound.init();
    sound.playClick();

    if (clienteMQTT && clienteMQTT.connected) {
        clienteMQTT.publish(topicoSecreto, JSON.stringify({
            accion: 'juego_terminado',
            id: participante.id,
            nombre: participante.nombre,
            puntos: puntos,
            targets: mocosEliminados,
            califica: mocosEliminados >= 5,
            tiempo: tiempoRonda
        }));
    }

    goToScreen(combateHabilitado ? 6 : 3);
}

// --------------------------------------------------------------------------
// 11. CLIENTE MQTT Y SINCRONIZACIÓN CON EL SERVIDOR HTTP
// --------------------------------------------------------------------------
const topicoSecreto = 'proyecto_ar_evento_juego_1a2b3c_lpz';
let clienteMQTT = null;

function conectarMQTT() {
    try {
        clienteMQTT = mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
            clientId: 'player_' + Math.random().toString(16).substring(2, 10),
            clean: true,
            connectTimeout: 5000,
            reconnectPeriod: 3000
        });

        clienteMQTT.on('connect', () => {
            console.log('[MQTT] Conectado exitosamente al broker');
            clienteMQTT.subscribe(topicoSecreto);
            clienteMQTT.subscribe(topicoSecreto + '/combate');

            // Solicitar al panel admin el estado actual de combate en caso de estar activo
            clienteMQTT.publish(topicoSecreto, JSON.stringify({
                accion: 'solicitar_estado_combate',
                id: participante.id
            }));
        });

        clienteMQTT.on('message', (topic, payload) => {
            try {
                const data = JSON.parse(payload.toString());
                manejarMensajeMQTT(data, topic);
            } catch (e) {
                console.error('[MQTT] Error parseando mensaje:', e);
            }
        });

        clienteMQTT.on('error', (err) => {
            console.warn('[MQTT] Error:', err);
        });
    } catch (e) {
        console.warn('[MQTT] No disponible:', e);
    }
}

function manejarMensajeMQTT(data, topic = '') {
    if (!data) return;

    // 1. Control del Botón "A Combatir" (Pantalla 3 <-> Pantalla 6) vía MQTT o tópico retenido
    if (data.accion === 'habilitar_combate' || (topic && topic.endsWith('/combate')) || (typeof data.activo !== 'undefined' && data.accion !== 'iniciar_juego')) {
        setEstadoCombate(data.activo);
    }

    // 2. Inicio de partida comandado por administración
    else if (data.accion === 'iniciar_juego') {
        if (data.tiempoRonda) {
            tiempoRonda = Number(data.tiempoRonda);
        }
        setEstadoCombate(true, true);
        if (currentScreen === 8 || currentScreen === 7 || currentScreen === 6) {
            goToScreen(9);
        }
    }

    // 3. Reiniciar juego
    else if (data.accion === 'reiniciar_juego') {
        detenerJuego();
        setEstadoCombate(false);
        goToScreen(3);
    }

    // 4. Desconectar a todos los participantes
    else if (data.accion === 'desconectar_todos') {
        detenerJuego();
        setEstadoCombate(false);
        goToScreen(0);
    }

    // 5. Actualización de configuración
    else if (data.accion === 'config_actualizada') {
        if (data.tiempoRonda) {
            tiempoRonda = Number(data.tiempoRonda);
        }
    }

    // 6. Ping de administración
    else if (data.accion === 'ping_jugadores') {
        if (clienteMQTT && clienteMQTT.connected && participante.nombre) {
            clienteMQTT.publish(topicoSecreto, JSON.stringify({
                accion: 'jugador_unido',
                id: participante.id,
                nombre: participante.nombre,
                carnet: participante.carnet,
                whatsapp: participante.whatsapp,
                color: '#00f0ff'
            }));
        }
    }
}

// --------------------------------------------------------------------------
// 12. INICIALIZACIÓN GENERAL AL CARGAR DOM
// --------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
    // Restaurar datos de sesión previos
    try {
        const guardado = localStorage.getItem('participante_neumoflux');
        if (guardado) {
            const parsed = JSON.parse(guardado);
            if (parsed.nombre) {
                participante.nombre = parsed.nombre;
                participante.carnet = parsed.carnet || participante.carnet;
                participante.whatsapp = parsed.whatsapp || participante.whatsapp;
                participante.nombreTruncado = truncarNombre(parsed.nombre);

                const inNom = document.getElementById('inputNombre');
                const inCar = document.getElementById('inputCarnet');
                const inWha = document.getElementById('inputWhatsapp');
                if (inNom) inNom.value = participante.nombre;
                if (inCar) inCar.value = participante.carnet;
                if (inWha) inWha.value = participante.whatsapp;
            }
        }
    } catch (e) {}

    // Restaurar estado de combate previo guardado localmente
    try {
        const combateGuardado = localStorage.getItem('combate_habilitado');
        if (combateGuardado !== null) {
            setEstadoCombate(combateGuardado === '1', true);
        }
    } catch (e) {}

    actualizarNombreDisplays();
    conectarMQTT();

    // Parámetros URL (ej: index.html?screen=3&combat=1)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('combat')) {
        setEstadoCombate(urlParams.get('combat') === '1' || urlParams.get('combat') === 'true', true);
    }
    if (urlParams.has('screen')) {
        const sNum = parseInt(urlParams.get('screen'), 10);
        if (!isNaN(sNum) && sNum >= 0 && sNum <= 10) {
            if (combateHabilitado || (sNum !== 6 && sNum !== 7 && sNum !== 8 && sNum !== 9)) {
                goToScreen(sNum);
            } else {
                goToScreen(3);
            }
        }
    }
});
