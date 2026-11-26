import { defineConfig, loadEnv, Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import basicSsl from "@vitejs/plugin-basic-ssl";
import path from "path";
import http from "node:http";
import { createServer } from "./api/index";

const API_PORT = 8081;

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  // Accept STRIPE_PUBLISHABLE_KEY as an alias (publishable keys are public by design).
  const stripePk = env.VITE_STRIPE_PUBLISHABLE_KEY || env.STRIPE_PUBLISHABLE_KEY || "";
  return {
  define: { "import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY": JSON.stringify(stripePk) },
  envPrefix: ["VITE_", "PUBLIC_"],
  server: {
    host: "::",
    port: 8080,
    proxy: {
      "/api": {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
        secure: false,
      },
    },
    fs: {
      allow: [".", "./client", "./shared"],
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**"],
    },
  },
  build: {
    outDir: "dist",
  },
  plugins: [basicSsl(), react(), expressPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./client"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
  };
});

/**
 * Vite re-bundles this config (and api/index.ts inside it) when the API
 * changes and builds the new dev server *before* closing the old one, so the
 * previous API listener must be closed first or :8081 is still taken
 * (EADDRINUSE crashed `npm run dev` on every api/index.ts edit). The handle
 * lives on globalThis because the reloaded config is a fresh module.
 */
const devApi = globalThis as typeof globalThis & { __qsDevApiServer?: http.Server };

function expressPlugin(): Plugin {
  return {
    name: "express-plugin",
    apply: "serve",
    async configureServer() {
      const prev = devApi.__qsDevApiServer;
      if (prev?.listening) {
        await new Promise<void>((resolve) => {
          prev.close(() => resolve());
          prev.closeAllConnections();
        });
      }
      const server = http.createServer(createServer());
      // The Vite proxy reuses keep-alive sockets; Node's 5s default made the API close one just as the proxy
      // sent on it (ECONNRESET → random "Network Error" in the browser). Outlive the proxy's idle sockets.
      server.keepAliveTimeout = 65_000;
      server.headersTimeout = 66_000;
      devApi.__qsDevApiServer = server;
      server.on("error", (e) => console.error(`❌ Express API failed to start on :${API_PORT}:`, e.message));
      server.listen(API_PORT, () => {
        console.log(`✅ Express API → http://localhost:${API_PORT}`);
      });
    },
  };
}
