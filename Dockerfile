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

# Set environment variables
ENV NODE_ENV=production
ENV PORT=4000
ENV MONGO_URI=mongodb+srv://<db_username>:<db_password>@cluster0.jhhxq5e.mongodb.net/?appName=Cluster0
ENV JWT_SECRET=your_jwt_secret

# Expose the port the app runs on
EXPOSE 4000

# Define the command to run the application
CMD ["npm", "start"]