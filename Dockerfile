FROM node:20-alpine

# Metadatos
LABEL maintainer="Jorge Medrano"
LABEL description="Super Neumoflux - Servidor y Juego Multijugador Cooperativo"

# Establecer directorio de trabajo en el contenedor
WORKDIR /app

# Copiar manifiestos de dependencias
COPY package*.json ./

# Instalar dependencias de producción limpias
RUN npm install --omit=dev && npm cache clean --force

# Copiar todo el código de la aplicación
COPY . .

# Exponer el puerto del servidor HTTP / Web
EXPOSE 3000

# Variables de entorno por defecto
ENV NODE_ENV=production
ENV PORT=3000

# Healthcheck para Docker
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/salud || exit 1

# Comando de arranque del servidor
CMD ["node", "server.js"]
