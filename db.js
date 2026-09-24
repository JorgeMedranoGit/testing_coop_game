/**
 * Módulo de Base de Datos para Super Neumoflux
 * Soporta PostgreSQL con creación automática de tablas y fallback a JSON si no hay DB configurada.
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const REGISTRO_FILE = path.join(__dirname, 'participantes.json');

class DatabaseService {
    constructor() {
        this.pool = null;
        this.isPostgres = false;
        this.initialized = false;
    }

    async init() {
        const connectionString = process.env.DATABASE_URL || 
            (process.env.DB_HOST ? `postgres://${process.env.DB_USER || 'neumo_user'}:${process.env.DB_PASSWORD || 'neumo_pass'}@${process.env.DB_HOST}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'neumoflux_db'}` : null);

        if (connectionString) {
            try {
                this.pool = new Pool({
                    connectionString,
                    max: 20,
                    idleTimeoutMillis: 30000,
                    connectionTimeoutMillis: 5000,
                });

                // Test de conexión
                const client = await this.pool.connect();
                console.log('✅ [DB] Conectado exitosamente a PostgreSQL.');
                client.release();

                await this.crearTablas();
                this.isPostgres = true;
                this.initialized = true;
                return;
            } catch (err) {
                console.warn('⚠️ [DB] No se pudo conectar a PostgreSQL:', err.message);
                console.warn('ℹ️ [DB] Iniciando en modo fallback local (participantes.json).');
            }
        } else {
            console.log('ℹ️ [DB] DATABASE_URL no definida. Operando en modo local (participantes.json).');
        }

        // Fallback local
        if (!fs.existsSync(REGISTRO_FILE)) {
            fs.writeFileSync(REGISTRO_FILE, JSON.stringify([], null, 2), 'utf8');
        }
        this.isPostgres = false;
        this.initialized = true;
    }

    async crearTablas() {
        if (!this.pool) return;

        const queries = [
            // 1. Tabla de Participantes
            `CREATE TABLE IF NOT EXISTS participantes (
                id VARCHAR(64) PRIMARY KEY,
                nombre VARCHAR(255) NOT NULL,
                carnet VARCHAR(50),
                whatsapp VARCHAR(50),
                color VARCHAR(30) DEFAULT '#00f0ff',
                ip VARCHAR(50),
                creado_en TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                actualizado_en TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );`,

            // 2. Tabla de Rondas / Partidas
            `CREATE TABLE IF NOT EXISTS rondas (
                id SERIAL PRIMARY KEY,
                tiempo_ronda INT DEFAULT 15,
                min_targets INT DEFAULT 10,
                total_jugadores INT DEFAULT 0,
                bloques_revelados INT DEFAULT 0,
                iniciada_en TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
                finalizada_en TIMESTAMP WITH TIME ZONE,
                estado VARCHAR(20) DEFAULT 'en_curso'
            );`,

            // 3. Tabla de Resultados y Puntuaciones
            `CREATE TABLE IF NOT EXISTS puntuaciones (
                id SERIAL PRIMARY KEY,
                ronda_id INT REFERENCES rondas(id) ON DELETE SET NULL,
                participante_id VARCHAR(64) REFERENCES participantes(id) ON DELETE CASCADE,
                targets INT DEFAULT 0,
                califica BOOLEAN DEFAULT FALSE,
                tiempo NUMERIC(6, 2) DEFAULT 0,
                cuadrantes INT DEFAULT 1,
                registrado_en TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );`,

            // 4. Índices para acelerar ranking y consultas concurrentes
            `CREATE INDEX IF NOT EXISTS idx_participantes_creado ON participantes(creado_en DESC);`,
            `CREATE INDEX IF NOT EXISTS idx_puntuaciones_targets ON puntuaciones(targets DESC);`,
            `CREATE INDEX IF NOT EXISTS idx_puntuaciones_participante ON puntuaciones(participante_id);`
        ];

        for (const query of queries) {
            await this.pool.query(query);
        }
        console.log('✅ [DB] Esquema y tablas de PostgreSQL verificadas/creadas correctamente.');
    }

    // --- OPERACIONES DE PARTICIPANTES ---

    async guardarParticipante(data) {
        const id = data.id || ('p_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6));
        const nombre = (data.nombre || 'Participante').trim();
        const carnet = (data.carnet || '').trim();
        const whatsapp = (data.whatsapp || '').trim();
        const color = data.color || '#00f0ff';
        const ip = data.ip || '127.0.0.1';

        if (this.isPostgres) {
            const query = `
                INSERT INTO participantes (id, nombre, carnet, whatsapp, color, ip, actualizado_en)
                VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                ON CONFLICT (id) DO UPDATE SET
                    nombre = EXCLUDED.nombre,
                    carnet = CASE WHEN EXCLUDED.carnet <> '' THEN EXCLUDED.carnet ELSE participantes.carnet END,
                    whatsapp = CASE WHEN EXCLUDED.whatsapp <> '' THEN EXCLUDED.whatsapp ELSE participantes.whatsapp END,
                    color = EXCLUDED.color,
                    ip = EXCLUDED.ip,
                    actualizado_en = CURRENT_TIMESTAMP
                RETURNING *;
            `;
            const res = await this.pool.query(query, [id, nombre, carnet, whatsapp, color, ip]);
            return res.rows[0];
        } else {
            // Fallback JSON
            let lista = [];
            try {
                lista = JSON.parse(fs.readFileSync(REGISTRO_FILE, 'utf8'));
            } catch (e) {
                lista = [];
            }

            let existente = lista.find(p => p.id === id);
            if (existente) {
                existente.nombre = nombre;
                if (carnet) existente.carnet = carnet;
                if (whatsapp) existente.whatsapp = whatsapp;
                existente.color = color;
                existente.actualizado_en = new Date().toISOString();
            } else {
                existente = {
                    id,
                    nombre,
                    carnet,
                    whatsapp,
                    color,
                    ip,
                    creado_en: new Date().toISOString()
                };
                lista.push(existente);
            }

            fs.writeFileSync(REGISTRO_FILE, JSON.stringify(lista, null, 2), 'utf8');
            return existente;
        }
    }

    async obtenerParticipantes() {
        if (this.isPostgres) {
            const query = `
                SELECT 
                    p.id, 
                    p.nombre, 
                    p.carnet, 
                    p.whatsapp, 
                    p.color, 
                    p.creado_en,
                    COALESCE(MAX(pts.targets), 0) AS max_targets,
                    COALESCE(BOOL_OR(pts.califica), FALSE) AS califica,
                    COALESCE(MAX(pts.cuadrantes), 0) AS cuadrantes,
                    MAX(pts.registrado_en) AS ultima_partida
                FROM participantes p
                LEFT JOIN puntuaciones pts ON p.id = pts.participante_id
                GROUP BY p.id, p.nombre, p.carnet, p.whatsapp, p.color, p.creado_en
                ORDER BY max_targets DESC, p.creado_en DESC;
            `;
            const res = await this.pool.query(query);
            return res.rows;
        } else {
            try {
                return JSON.parse(fs.readFileSync(REGISTRO_FILE, 'utf8'));
            } catch (e) {
                return [];
            }
        }
    }

    // --- OPERACIONES DE RONDAS Y PUNTUACIONES ---

    async crearRonda({ tiempoRonda = 15, minTargets = 10, totalJugadores = 0 }) {
        if (!this.isPostgres) return { id: 1 };
        const query = `
            INSERT INTO rondas (tiempo_ronda, min_targets, total_jugadores)
            VALUES ($1, $2, $3)
            RETURNING *;
        `;
        const res = await this.pool.query(query, [tiempoRonda, minTargets, totalJugadores]);
        return res.rows[0];
    }

    async finalizarRonda(rondaId, bloquesRevelados = 0) {
        if (!this.isPostgres || !rondaId) return;
        const query = `
            UPDATE rondas
            SET finalizada_en = CURRENT_TIMESTAMP,
                bloques_revelados = $2,
                estado = 'finalizada'
            WHERE id = $1;
        `;
        await this.pool.query(query, [rondaId, bloquesRevelados]);
    }

    async guardarPuntuacion({ participanteId, rondaId = null, targets = 0, califica = false, tiempo = 0, cuadrantes = 1 }) {
        if (!this.isPostgres) return;
        const query = `
            INSERT INTO puntuaciones (participante_id, ronda_id, targets, califica, tiempo, cuadrantes)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *;
        `;
        const res = await this.pool.query(query, [participanteId, rondaId, targets, califica, tiempo, cuadrantes]);
        return res.rows[0];
    }

    async obtenerRanking(limite = 50) {
        if (this.isPostgres) {
            const query = `
                SELECT 
                    p.id, 
                    p.nombre, 
                    p.color, 
                    MAX(pts.targets) AS targets,
                    BOOL_OR(pts.califica) AS califica,
                    MAX(pts.cuadrantes) AS cuadrantes,
                    MIN(pts.tiempo) AS mejor_tiempo,
                    MAX(pts.registrado_en) AS fecha
                FROM participantes p
                JOIN puntuaciones pts ON p.id = pts.participante_id
                GROUP BY p.id, p.nombre, p.color
                ORDER BY targets DESC, mejor_tiempo ASC
                LIMIT $1;
            `;
            const res = await this.pool.query(query, [limite]);
            return res.rows;
        }
        return [];
    }

    async obtenerEstadisticas() {
        if (this.isPostgres) {
            const resPart = await this.pool.query('SELECT COUNT(*) AS total FROM participantes;');
            const resRondas = await this.pool.query('SELECT COUNT(*) AS total FROM rondas;');
            const resTargets = await this.pool.query('SELECT COALESCE(SUM(targets), 0) AS total FROM puntuaciones;');

            return {
                motor: 'PostgreSQL',
                totalParticipantes: parseInt(resPart.rows[0].total, 10),
                totalRondas: parseInt(resRondas.rows[0].total, 10),
                totalTargetsDestruidos: parseInt(resTargets.rows[0].total, 10)
            };
        } else {
            let total = 0;
            try {
                total = JSON.parse(fs.readFileSync(REGISTRO_FILE, 'utf8')).length;
            } catch (e) {}
            return {
                motor: 'JSON Fallback',
                totalParticipantes: total,
                totalRondas: 0,
                totalTargetsDestruidos: 0
            };
        }
    }

    async limpiarParticipantes() {
        if (this.isPostgres) {
            await this.pool.query('TRUNCATE TABLE puntuaciones, rondas, participantes RESTART IDENTITY CASCADE;');
        } else {
            fs.writeFileSync(REGISTRO_FILE, JSON.stringify([], null, 2), 'utf8');
        }
    }
}

const db = new DatabaseService();
module.exports = db;
