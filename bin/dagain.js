#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv).catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});

