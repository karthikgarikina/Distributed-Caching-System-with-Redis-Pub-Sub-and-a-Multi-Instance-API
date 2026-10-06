FROM node:20-alpine

# Install curl for docker healthcheck
RUN apk add --no-cache curl

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

EXPOSE 8081 8082 8083

CMD ["npm", "start"]
