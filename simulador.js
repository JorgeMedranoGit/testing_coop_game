/**
 * Simulador de Carga MQTT para Mural Colectivo
 * Ejecución:
 *   npm install
 *   node simulador.js [cantidad_de_bots]
 * 
 * Ejemplo:
 *   node simulador.js 200
 */

const mqtt = require('mqtt');

const CANTIDAD_BOTS = parseInt(process.argv[2]) || 200;
const BATCH_SIZE = 10;
const BATCH_INTERVAL_MS = 150;
const TOPICO = 'proyecto_ar_evento_juego_1a2b3c_lpz';
const BROKER_URL = 'wss://broker.emqx.io:8084/mqtt';

const COLORES = [
    '#cba6f7', '#f38ba8', '#fab387', '#f9e2af', 
    '#a6e3a1', '#94e2d5', '#74c7ec', '#89b4fa', '#b4befe'
];

const NOMBRES_BASE = [
    'Alex', 'Sam', 'Cris', 'Dani', 'Leo', 'Nico', 'Max', 'Vale', 'Maya', 'Santi',
    'Lucas', 'Emma', 'Mateo', 'Sofia', 'Ian', 'Mora', 'Bruno', 'Gael', 'Elena', 'Zoe'
];

console.log('\x1b[35m%s\x1b[0m', '==================================================');
console.log('\x1b[36m%s\x1b[0m', `🚀 INICIANDO SIMULADOR: ${CANTIDAD_BOTS} BOTS MQTT`);
console.log('\x1b[90m%s\x1b[0m', `Broker: ${BROKER_URL}`);
console.log('\x1b[90m%s\x1b[0m', `Tópico: ${TOPICO}`);
console.log('\x1b[35m%s\x1b[0m', '==================================================');

const bots = [];
let conectados = 0;
let completados = 0;

for (let i = 1; i <= CANTIDAD_BOTS; i++) {
    const nombreBase = NOMBRES_BASE[Math.floor(Math.random() * NOMBRES_BASE.length)];
    bots.push({
        index: i,
        id: `bot_${i}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        nombre: `Bot ${i} (${nombreBase})`,
        color: COLORES[i % COLORES.length],
        client: null,
        timer: null,
        state: 'idle'
    });
}

let currentIndex = 0;
const batchTimer = setInterval(() => {
    const limit = Math.min(currentIndex + BATCH_SIZE, CANTIDAD_BOTS);
    for (let i = currentIndex; i < limit; i++) {
        conectarBot(bots[i]);
    }
    currentIndex = limit;

    process.stdout.write(`\r\x1b[33m[Conectando] Despachados: ${currentIndex}/${CANTIDAD_BOTS} bots...\x1b[0m`);

    if (currentIndex >= CANTIDAD_BOTS) {
        clearInterval(batchTimer);
        console.log(`\n\x1b[32m✔ Despachadas todas las ${CANTIDAD_BOTS} conexiones.\x1b[0m`);
    }
}, BATCH_INTERVAL_MS);

function conectarBot(bot) {
    try {
        const client = mqtt.connect(BROKER_URL, {
            keepalive: 60,
            reconnectPeriod: 5000,
            clean: true,
            clientId: `sim_node_${bot.id}`
        });

        bot.client = client;

        client.on('connect', () => {
            bot.state = 'online';
            conectados++;
            
            client.subscribe(TOPICO, (err) => {
                if (!err) {
                    client.publish(TOPICO, JSON.stringify({
                        accion: 'jugador_unido',
                        id: bot.id,
                        nombre: bot.nombre,
                        color: bot.color
                    }));
                }
            });
        });

        client.on('message', (topic, msg) => {
            try {
                const data = JSON.parse(msg.toString());
                manejarMensaje(bot, data);
            } catch (e) {}
        });

        client.on('error', () => {
            bot.state = 'error';
        });

    } catch (e) {
        bot.state = 'error';
    }
}

function manejarMensaje(bot, data) {
    if (data.accion === 'ping_jugadores') {
        if (bot.client && bot.client.connected) {
            bot.client.publish(TOPICO, JSON.stringify({
                accion: 'jugador_unido',
                id: bot.id,
                nombre: bot.nombre,
                color: bot.color
            }));
        }
    } else if (data.accion === 'iniciar_juego') {
        bot.state = 'playing';
        const minTargetsReq = data.minTargets || (data.taps || 10);
        const tiempoRonda = data.tiempoRonda || 15;
        const targetsDestruidos = Math.max(3, Math.floor(minTargetsReq - 3 + Math.random() * 14));
        const califica = targetsDestruidos >= minTargetsReq;

        const duracion = Math.min(tiempoRonda, 3.5 + Math.random() * (tiempoRonda - 2.5)).toFixed(2);
        const delayMs = parseFloat(duracion) * 1000;

        if (bot.timer) clearTimeout(bot.timer);
        bot.timer = setTimeout(() => {
            if (bot.state === 'playing' && bot.client && bot.client.connected) {
                bot.client.publish(TOPICO, JSON.stringify({
                    accion: 'juego_terminado',
                    id: bot.id,
                    nombre: bot.nombre,
                    color: bot.color,
                    targets: targetsDestruidos,
                    califica: califica,
                    tiempo: tiempoRonda
                }));
                bot.state = 'completed';
                completados++;
                process.stdout.write(`\r\x1b[36m[Progreso Ronda] Completaron: ${completados}/${CANTIDAD_BOTS} bots...\x1b[0m`);
            }
        }, delayMs);
    } else if (data.accion === 'reiniciar_juego') {
        if (bot.timer) clearTimeout(bot.timer);
        completados = 0;
        bot.state = 'online';
    } else if (data.accion === 'desconectar_todos') {
        if (bot.timer) clearTimeout(bot.timer);
        bot.state = 'disconnected';
        if (bot.client) {
            try { bot.client.end(true); } catch (e) {}
        }
    }
}

// Salida limpia con Ctrl + C
function cerrarLimpio() {
    console.log('\n\x1b[31m%s\x1b[0m', '🛑 Desconectando todos los bots...');
    bots.forEach(b => {
        if (b.timer) clearTimeout(b.timer);
        if (b.client) {
            try {
                if (b.client.connected) {
                    b.client.publish(TOPICO, JSON.stringify({
                        accion: 'jugador_desconectado',
                        id: b.id
                    }));
                }
                b.client.end(true);
            } catch (e) {}
        }
    });
    console.log('\x1b[32m✔ Desconexión finalizada. ¡Hasta luego!\x1b[0m');
    process.exit(0);
}

process.on('SIGINT', cerrarLimpio);
process.on('SIGTERM', cerrarLimpio);
