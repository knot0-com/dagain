export function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const flags = {};

  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (!token) {
      i += 1;
      continue;
    }

    if (token === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }

    if (!token.startsWith("-")) {
      positional.push(token);
      i += 1;
      continue;
    }

    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        const key = token.slice(2, eq);
        const value = token.slice(eq + 1);
        flags[key] = value === "" ? true : value;
        i += 1;
        continue;
      }

      const key = token.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
      continue;
    }

    // Short flags: -abc or -k value
    const shorts = token.slice(1).split("").filter(Boolean);
    if (shorts.length === 1) {
      const key = shorts[0];
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i += 1;
      }
      continue;
    }

    for (const key of shorts) flags[key] = true;
    i += 1;
  }

  const command = positional[0] || "";
  return { command, positional: positional.slice(1), flags };
}

