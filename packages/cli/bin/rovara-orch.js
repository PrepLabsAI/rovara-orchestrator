#!/usr/bin/env node
// Runs the CLI from its TypeScript source (packages are not built): tsx compiles it on load.
import { register } from "tsx/esm/api";

register();
await import("../src/bin.ts");
