/**
 * Servidor HTTP, API REST y Sincronizador MQTT para Super Neumoflux
 * Docker / VPS ready con persistencia en PostgreSQL
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const db = require('./db');

const PUERTO = process.env.PORT || parseInt(process.argv[2], 10) || 3000;
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'wss://broker.emqx.io:8084/mqtt';
const TOPICO_SECRET = 'super_neumoflux_game_2024_coop_v1';

let estadoCombateGlobal = false;
let rondaActualId = null;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mind': 'application/octet-stream',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json'
};

// -------------------------------------------------------------
// 1. SINCRONIZADOR MQTT EN TIEMPO REAL (Listener de persistencia)
// -------------------------------------------------------------
let clienteMQTT = null;

function iniciarSincronizadorMQTT() {
    try {
        console.log(`📡 [MQTT] Conectando al broker: ${MQTT_BROKER_URL}`);
        clienteMQTT = mqtt.connect(MQTT_BROKER_URL, {
            clientId: 'server_db_sync_' + Math.random().toString(16).substring(2, 8),
            keepalive: 60,
            clean: true,
            reconnectPeriod: 3000
        });

        clienteMQTT.on('connect', () => {
            console.log('✅ [MQTT] Servidor sincronizador conectado al broker.');
            clienteMQTT.subscribe(TOPICO_SECRET, { qos: 1 });
            clienteMQTT.subscribe(TOPICO_SECRET + '/combate', { qos: 1 });
        });

        clienteMQTT.on('message', async (topic, payload) => {
            try {
                const data = JSON.parse(payload.toString());

                if (data.accion === 'jugador_unido') {
                    await db.guardarParticipante({
                        id: data.id || ('p_' + Date.now()),
                        nombre: data.nombre,
                        carnet: data.carnet,
                        whatsapp: data.whatsapp,
                        color: data.color
                    });
                } else if (data.accion === 'iniciar_juego') {
                    const ronda = await db.crearRonda({
                        tiempoRonda: data.tiempoRonda || 15,
                        minTargets: data.minTargets || (data.taps || 10),
                        totalJugadores: data.totalJugadores || 0
                    });
                    if (ronda && ronda.id) rondaActualId = ronda.id;
                } else if (data.accion === 'fin_juego') {
                    const pId = data.id || data.nombre;
                    await db.guardarPuntuacion({
                        participanteId: pId,
                        rondaId: rondaActualId,
                        targets: Number(data.targets || data.taps || 0),
                        califica: Boolean(data.califica),
                        tiempo: Number(data.tiempo || 0),
                        cuadrantes: Number(data.cuadrantes || 1)
                    });
                } else if (data.accion === 'ronda_completada' || data.accion === 'mural_completado') {
                    if (rondaActualId) {
                        await db.finalizarRonda(rondaActualId, data.bloquesRevelados || 0);
                        rondaActualId = null;
                    }
                }
            } catch (err) {
                // Ignore parse errors from unknown message formats
            }
        });

        clienteMQTT.on('error', (err) => {
            console.warn('⚠️ [MQTT] Error en cliente de fondo:', err.message);
        });
    } catch (e) {
        console.warn('⚠️ [MQTT] No se pudo inicializar listener MQTT:', e.message);
    }
}

// -------------------------------------------------------------
// 2. SERVIDOR HTTP Y API REST
// -------------------------------------------------------------
const server = http.createServer(async (req, res) => {
    // CORS headers para soportar acceso cruzado / proxies
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Helper para responder JSON
    const sendJSON = (statusCode, data) => {
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
    };

    // Helper para leer body
    const leerBody = () => new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk.toString());
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on('error', reject);
    });

    // --- ENDPOINTS API ---

    // 1. Salud del sistema / Docker Healthcheck
    if (pathname === '/api/salud' && req.method === 'GET') {
        return sendJSON(200, {
            status: 'ok',
            motorBD: db.isPostgres ? 'PostgreSQL' : 'JSON Fallback',
            mqtt: clienteMQTT && clienteMQTT.connected ? 'conectado' : 'desconectado',
            timestamp: new Date().toISOString()
        });
    }

    // 2. Estadísticas globales de la base de datos
    if (pathname === '/api/stats' && req.method === 'GET') {
        try {
            const stats = await db.obtenerEstadisticas();
            return sendJSON(200, stats);
        } catch (e) {
            return sendJSON(500, { error: e.message });
        }
    }

    // 3. POST /api/registro: Registrar o actualizar participante en BD
    if (pathname === '/api/registro' && req.method === 'POST') {
        try {
            const data = await leerBody();
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
            
            const participante = await db.guardarParticipante({
                id: data.id,
                nombre: data.nombre,
                carnet: data.carnet,
                whatsapp: data.whatsapp,
                color: data.color,
                ip
            });

            console.log(`[Registro BD] ${participante.nombre} (ID: ${participante.id})`);
            return sendJSON(200, {
                success: true,
                mensaje: 'Participante guardado exitosamente en base de datos',
                participante
            });
        } catch (err) {
            console.error('[Error Registro]', err);
            return sendJSON(400, { success: false, error: 'Datos de registro inválidos' });
        }
    }

    // 4. GET /api/participantes: Consultar lista desde BD
    if (pathname === '/api/participantes' && req.method === 'GET') {
        try {
            const lista = await db.obtenerParticipantes();
            return sendJSON(200, lista);
        } catch (e) {
            return sendJSON(500, { error: 'Error al consultar participantes en BD' });
        }
    }

    // 5. GET /api/participantes/export/csv: Descargar archivo CSV con BOM
    if (pathname === '/api/participantes/export/csv' && req.method === 'GET') {
        try {
            const lista = await db.obtenerParticipantes();
            let csv = '\uFEFFID,Nombre,Carnet,WhatsApp,Color,Targets,Califica,Cuadrantes,CreadoEn\n';
            lista.forEach(j => {
                const nom = (j.nombre || '').replace(/"/g, '""');
                const fecha = j.creado_en ? new Date(j.creado_en).toLocaleString('es-BO') : '';
                csv += `"${j.id}","${nom}","${j.carnet || ''}","${j.whatsapp || ''}","${j.color || ''}",${j.max_targets || j.targets || 0},${j.califica ? 'SI' : 'NO'},${j.cuadrantes || 0},"${fecha}"\n`;
            });

            res.writeHead(200, {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="participantes_neumoflux_${new Date().toISOString().slice(0, 10)}.csv"`
            });
            res.end(csv);
            return;
        } catch (e) {
            return sendJSON(500, { error: 'Error exportando CSV' });
        }
    }

    // 6. GET /api/participantes/export/json: Descargar archivo JSON
    if (pathname === '/api/participantes/export/json' && req.method === 'GET') {
        try {
            const lista = await db.obtenerParticipantes();
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Content-Disposition': `attachment; filename="participantes_neumoflux_${new Date().toISOString().slice(0, 10)}.json"`
            });
            res.end(JSON.stringify(lista, null, 2));
            return;
        } catch (e) {
            return sendJSON(500, { error: 'Error exportando JSON' });
        }
    }

    // 7. GET /api/ranking: Tabla de posiciones
    if (pathname === '/api/ranking' && req.method === 'GET') {
        try {
            const ranking = await db.obtenerRanking(100);
            return sendJSON(200, ranking);
        } catch (e) {
            return sendJSON(500, { error: e.message });
        }
    }

    // 8. DELETE /api/participantes: Limpiar la tabla de participantes (Admin)
    if (pathname === '/api/participantes' && req.method === 'DELETE') {
        try {
            await db.limpiarParticipantes();
            console.log('🗑️ [BD] Participantes y puntuaciones eliminadas.');
            return sendJSON(200, { success: true, mensaje: 'Base de datos reiniciada.' });
        } catch (e) {
            return sendJSON(500, { error: e.message });
        }
    }

    // 9. /api/estado-combate (GET & POST)
    if (pathname === '/api/estado-combate') {
        if (req.method === 'GET') {
            return sendJSON(200, { success: true, habilitado: estadoCombateGlobal });
        } else if (req.method === 'POST') {
            try {
                const data = await leerBody();
                if (typeof data.habilitado !== 'undefined') {
                    estadoCombateGlobal = Boolean(data.habilitado);
                } else if (typeof data.activo !== 'undefined') {
                    estadoCombateGlobal = Boolean(data.activo);
                }
                return sendJSON(200, { success: true, habilitado: estadoCombateGlobal });
            } catch (e) {
                return sendJSON(400, { success: false, error: 'JSON inválido' });
            }
        }
    }

    // --- SERVIDOR DE ARCHIVOS ESTÁTICOS ---
    let safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[\/\\])+/, '');
    if (safePath === '/' || safePath === '\\' || safePath === '') {
        safePath = 'index.html';
    }

    const filePath = path.join(__dirname, safePath);

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`404 No encontrado: ${pathname}`);
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400'
        });
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
    });
});

// Inicializar la base de datos y arrancar el servidor
async function iniciarServidor() {
    await db.init();
    iniciarSincronizadorMQTT();

    server.listen(PUERTO, () => {
        console.log('====================================================');
        console.log(`🚀 Servidor Super Neumoflux en ejecución`);
        console.log(`🌐 Web:           http://localhost:${PUERTO}/`);
        console.log(`📋 Panel Admin:   http://localhost:${PUERTO}/admin.html`);
        console.log(`🎮 Participante:  http://localhost:${PUERTO}/index.html`);
        console.log(`🖥️  Pantalla Host: http://localhost:${PUERTO}/pantalla.html`);
        console.log(`💾 Base de Datos: ${db.isPostgres ? 'PostgreSQL (Activa)' : 'JSON Local'}`);
        console.log('====================================================');
    });
}

iniciarServidor();
