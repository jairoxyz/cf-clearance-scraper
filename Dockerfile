# Use a slim debian image as the base image
FROM node:21-slim

ARG TARGETPLATFORM
ARG BUILDPLATFORM
ARG TARGETARCH

RUN printf "I am running on ${BUILDPLATFORM}, building for ${TARGETPLATFORM}\n"

# Install necessary dependencies for running Chrome
RUN apt-get update && apt-get install -y \
    # wget \
    # gnupg \
    # ca-certificates \
    # apt-transport-https \
    chromium \
    chromium-driver \
    xvfb \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium

# Set up the working directory in the container
WORKDIR /app
RUN chown -R node:node /app

# Copy package.json and package-lock.json to the working directory
COPY --chown=node:node package*.json ./

# Install Node.js dependencies
RUN npm update
RUN npm install

# Copy the rest of the application code
COPY --chown=node:node . .

# Expose the port your app runs on
EXPOSE 3001

CMD ["node", "src/index.js"]
