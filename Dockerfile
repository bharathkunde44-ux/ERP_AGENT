FROM mcr.microsoft.com/playwright:v1.49.0-jammy
WORKDIR /app
COPY erp-assignment-agent/package*.json ./
RUN npm install
COPY erp-assignment-agent/ ./
EXPOSE 3005
CMD ["node", "src/index.js"]
