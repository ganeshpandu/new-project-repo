# Use the official Node.js image from Docker Hub
FROM node:22.11.0-alpine

# Set the working directory
WORKDIR /app

# Copy the application code into the container
COPY . .

# Ensure that the start.sh script is executable
RUN chmod +x /app/start.sh

# Install PostgreSQL client and bash for shell compatibility
RUN apk add --no-cache postgresql-client bash

# Install dependencies and build user-service
WORKDIR /app/user-service
RUN npm install --legacy-peer-deps && \
    npm run prisma:generate && \
    npm run build

# Install dependencies and build masterData-service
WORKDIR /app/masterData-service
RUN npm install --legacy-peer-deps && \
    npm run prisma:generate && \
    npm run build

# Expose the necessary ports for both services
EXPOSE 3001 3002

# Set the entrypoint to run the start.sh script when the container starts
CMD ["sh", "-c", "/app/start.sh"]
