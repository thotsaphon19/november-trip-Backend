FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p uploads
RUN npx prisma generate

EXPOSE 4000

CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
