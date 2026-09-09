import { defineConfig } from "vite";
import { fileURLToPath, URL } from "url";
import react from "@vitejs/plugin-react";
import { entries, entryFileNames } from "./build.entries.js";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: entries,
      output: { entryFileNames },
    },
    outDir: "dist",
  },
  resolve: {
    alias: [
      {
        find: "@",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
    ],
  },
});
