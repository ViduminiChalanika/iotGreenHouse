import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_PROXY_TARGET || "http://127.0.0.1:3000";
  return {
    build: {
      rollupOptions: {
        input: {
          main: resolve(process.cwd(), "index.html"),
          sensor: resolve(process.cwd(), "sensor.html"),
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target,
          changeOrigin: true,
        },
      },
    },
  };
});
