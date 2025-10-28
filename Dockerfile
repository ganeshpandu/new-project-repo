# Build dependencies and compile TypeScript
FROM node:22.11.0-alpine

WORKDIR /app
COPY . .

RUN chmod +x /app/start.sh

# Install PostgreSQL client and bash for shell compatibility
RUN apk add --no-cache postgresql-client bash

# Install and build user-service
RUN cd user-service && npm install --legacy-peer-deps && npm run prisma:generate && npm run build

# Install and build masterData-service
RUN cd masterData-service && npm install --legacy-peer-deps && npm run prisma:generate && npm run build

EXPOSE 3001 3002

CMD ["sh", "-c", "/app/start.sh"]
