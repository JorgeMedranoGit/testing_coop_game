# 🚀 Super Neumoflux - Juego Colaborativo Multijugador

Juego interactivo y colaborativo multiusuario en tiempo real sincronizado mediante MQTT y WebSockets, con módulo de Realidad Aumentada (MindAR), pantalla host para proyección en vivo y base de datos relacional PostgreSQL dockerizada.

---

## 🏗️ Arquitectura del Sistema

* **Frontend Web (100% interactivo):**
  * `index.html`: Aplicación para el teléfono de los participantes (Registro, WebAR y juego de combate contra los mocos).
  * `pantalla.html`: Pantalla host para proyectores / pantallas gigantes (Mural adaptativo optimizado para hasta 200 cuadrantes a 60 FPS).
  * `admin.html`: Centro de control del anfitrión para moderar, iniciar rondas y descargar reportes.
  * `RealidadAumentada/`: Módulo WebAR basado en MindAR y A-Frame.
* **Backend y Persistencia:**
  * `server.js`: Servidor HTTP, API REST y sincronizador en tiempo real de eventos MQTT contra la Base de Datos.
  * `db.js`: Capa de datos con conexión a PostgreSQL y migraciones automáticas de esquema.
* **Infraestructura Docker:**
  * `Dockerfile`: Imagen ligera basada en Node.js 20 Alpine.
  * `docker-compose.yml`: Orquestación de la aplicación web y la base de datos PostgreSQL con volúmenes persistentes.

---

## 🐳 Despliegue Rápido en VPS con Docker

### 1. Clonar el repositorio en la VPS
```bash
git clone https://github.com/JorgeMedranoGit/testing_coop_game.git
cd testing_coop_game
```

### 2. Configurar variables de entorno (Opcional)
Puedes personalizar las contraseñas o el puerto creando tu archivo `.env`:
```bash
cp .env.example .env
```

### 3. Levantar los contenedores
```bash
docker compose up -d --build
```

### 4. Verificar estado
```bash
docker compose ps
docker compose logs -f app
```

Una vez levantado:
* **Participante:** `http://TU_IP:3000/index.html` (o por dominio con SSL)
* **Proyección Host:** `http://TU_IP:3000/pantalla.html`
* **Panel Administrador:** `http://TU_IP:3000/admin.html`
* **Salud del Sistema:** `http://TU_IP:3000/api/salud`

> [!IMPORTANT]
> Para el módulo de **Realidad Aumentada (cámara en móviles)**, los navegadores modernos exigen conexión segura **HTTPS**. Se recomienda colocar un proxy inverso como Nginx, Traefik o Caddy con certificado SSL gratuito (Let's Encrypt) apuntando al puerto `3000`.

---

## 🗄️ Esquema de la Base de Datos (PostgreSQL)

El sistema crea y migra automáticamente las tablas al iniciar:

1. **`participantes`:** Almacena cada jugador registrado (ID, Nombre, Carnet, WhatsApp, Color, IP, Fecha de registro).
2. **`rondas`:** Registra cada partida iniciada por el anfitrión (Tiempo de ronda, meta de targets, total de participantes, estado).
3. **`puntuaciones`:** Guarda los resultados de cada jugador por ronda (Targets destruidos, tiempo, cuadrantes asignados, si calificó al mínimo).
4. **`logs_actividad`:** Auditoría de eventos del sistema.

---

## 🔌 Endpoints de la API REST

| Método | Endpoint | Descripción |
|---|---|---|
| `GET` | `/api/salud` | Healthcheck y estado de la BD / MQTT |
| `POST` | `/api/registro` | Registra o actualiza a un participante en la BD |
| `GET` | `/api/participantes` | Lista JSON de participantes con su mejor puntaje |
| `GET` | `/api/participantes/export/csv` | Descarga de reporte completo en formato CSV (BOM UTF-8 para Excel) |
| `GET` | `/api/participantes/export/json` | Descarga de datos en formato JSON |
| `GET` | `/api/ranking` | Tabla de posiciones de los mejores jugadores |
| `GET` | `/api/stats` | Estadísticas totales del evento |
| `DELETE` | `/api/participantes` | Reinicia y limpia los registros de la base de datos |

---

## 💻 Ejecución Local sin Docker

Si deseas probar el juego localmente en tu equipo sin PostgreSQL:
```bash
npm install
npm start
```
*El sistema detectará automáticamente que no hay PostgreSQL activo y utilizará almacenamiento local fallback en `participantes.json` sin interrumpir la ejecución.*
