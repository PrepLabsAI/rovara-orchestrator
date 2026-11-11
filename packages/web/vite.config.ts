import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Build the read-only status page into dist/, served from S3 through CloudFront (infra/lib/web.ts). */
export default defineConfig({ plugins: [react()], root: import.meta.dirname, build: { outDir: "dist", emptyOutDir: true } });
