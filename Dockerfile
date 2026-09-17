# Builds and runs smallprint-mcp, the MCP server in ./mcp, over stdio. Used by registries that run a server to
# check it answers (Glama's listing check). The server reads https://smallprint.dev/api and nothing else.
FROM node:20-alpine
WORKDIR /app
COPY mcp/package.json ./
RUN npm install --no-audit --no-fund
COPY mcp/ ./
RUN npm run build
ENTRYPOINT ["node", "dist/smallprint-mcp.js"]
