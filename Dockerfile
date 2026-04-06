# Use the official Node.js image as the base image
FROM node:18

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Only set NODE_ENV here — all secrets injected by Railway at runtime
ENV NODE_ENV=production

# Railway injects PORT automatically, default to 4000
EXPOSE 4000

# Define the command to run the application
CMD ["npm", "start"]