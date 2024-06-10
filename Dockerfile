# Use the official Node.js image as the base image
FROM node:22-slim

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
    xvfb \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome
# RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
#     && echo "deb [arch=${TARGETARCH}] https://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
#     && apt-get update \
#     # && apt-get install -y google-chrome-stable \
#     && apt-get install -y chromium \
#     && rm -rf /var/lib/apt/lists/*

# Install chromium and X11 on Alpine
# RUN apk update && apk add --no-cache \
#     xvfb \
#     chromium \
#     && rm -rf /var/cache/apk/*

# Set up the working directory in the container
WORKDIR /app
RUN chown -R node:node /app

# Copy package.json and package-lock.json to the working directory
COPY --chown=node:node package*.json ./

# Install Node.js dependencies
RUN npm install
RUN npm install -g pm2
RUN npm prune --production

# Copy the rest of the application code
COPY --chown=node:node . .

# Expose the port your app runs on
EXPOSE 3001

# Command to run the application
CMD ["pm2-runtime", "index.js"]