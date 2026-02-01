function envNoColor() {
  return "NO_COLOR" in process.env || process.env.TERM === "dumb";
}

function wrap(enabled, code, text) {
  if (!enabled) return String(text);
  return `\u001b[${code}m${text}\u001b[0m`;
}

export function createUi({ stream = process.stderr, noColor = false, forceColor = false } = {}) {
  const isTTY = Boolean(stream?.isTTY);
  const color = Boolean(forceColor || (isTTY && !noColor && !envNoColor()));

  const c = {
    bold: (s) => wrap(color, "1", s),
    dim: (s) => wrap(color, "2", s),
    red: (s) => wrap(color, "31", s),
    green: (s) => wrap(color, "32", s),
    yellow: (s) => wrap(color, "33", s),
    blue: (s) => wrap(color, "34", s),
    magenta: (s) => wrap(color, "35", s),
    cyan: (s) => wrap(color, "36", s),
    gray: (s) => wrap(color, "90", s),
  };

  function ts() {
    // HH:MM:SS (local)
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function writeLine(line = "") {
    stream.write(String(line) + "\n");
  }

  function detail(line = "") {
    if (!line) return writeLine("");
    writeLine(`${c.gray("│")} ${c.dim(line)}`);
  }

  function formatStatus(statusRaw) {
    const status = String(statusRaw || "unknown").toLowerCase();
    const label = status;
    if (status === "done" || status === "success") return c.green(label);
    if (status === "open") return c.yellow(label);
    if (status === "in_progress") return c.blue(label);
    if (status === "needs_human" || status === "checkpoint") return c.magenta(label);
    if (status === "failed" || status === "fail" || status === "error") return c.red(label);
    return c.gray(label);
  }

  function formatNode(node) {
    const id = node?.id || "(missing-id)";
    const title = node?.title || "(untitled)";
    const type = node?.type || "(type?)";
    const status = formatStatus(node?.status || "(status?)");
    return `${c.bold(id)} ${c.dim(`[${type}]`)} (${status}) — ${title}`;
  }

  function formatCounts(counts) {
    const parts = [];
    const keys = Object.keys(counts || {}).sort();
    for (const key of keys) {
      const n = counts[key];
      parts.push(`${formatStatus(key)} ${c.bold(String(n))}`);
    }
    return parts.join(c.dim(" · "));
  }

  function hr(label = "") {
    const columns = Number(stream?.columns || 0);
    const width = Number.isFinite(columns) && columns > 0 ? Math.min(columns, 120) : 80;
    const text = String(label || "").trim();
    const rule = "─";
    if (!text) return c.dim(rule.repeat(width));
    const inner = ` ${text} `;
    const remaining = width - inner.length;
    if (remaining <= 2) return c.dim(inner.slice(0, width));
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    return c.dim(rule.repeat(left) + inner + rule.repeat(right));
  }

  function event(kind, message) {
    const k = String(kind || "info");
    const label =
      k === "select"
        ? "select"
        : k === "spawn"
          ? "spawn"
          : k === "exit"
            ? "exit"
            : k === "done"
              ? "done"
              : k === "checkpoint"
                ? "checkpoint"
                : k === "fail"
                  ? "fail"
                  : k === "warn"
                    ? "warn"
                    : "info";
    const pad = label.padEnd(10, " ");
    const tag =
      label === "select"
        ? c.cyan(pad)
        : label === "spawn"
          ? c.blue(pad)
          : label === "done"
            ? c.green(pad)
            : label === "checkpoint"
              ? c.magenta(pad)
              : label === "fail"
                ? c.red(pad)
                : label === "warn"
                  ? c.yellow(pad)
                  : c.gray(pad);
    writeLine(`${c.dim(ts())} ${tag} ${message}`);
  }

  function truncate(text, max = 180) {
    const t = String(text || "").trim();
    if (!t) return "";
    if (t.length <= max) return t;
    return t.slice(0, max - 1) + "…";
  }

  function formatDuration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return "";
    if (n < 1000) return `${Math.round(n)}ms`;
    const s = n / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s - m * 60);
    return `${m}m${String(rem).padStart(2, "0")}s`;
  }

  function spinnerStart(text) {
    if (!isTTY) return { stop: () => {} };
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const fallback = ["-", "\\", "|", "/"];
    const useFrames = color ? frames : fallback;
    let i = 0;
    let rendered = false;
    let stopped = false;
    const id = setInterval(() => {
      if (stopped) return;
      const frame = useFrames[i % useFrames.length];
      i += 1;
      rendered = true;
      try {
        stream.write(`\r\u001b[2K${c.dim(frame)} ${text}`);
      } catch {
        // ignore
      }
    }, 90);
    id.unref?.();
    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(id);
        if (!rendered) return;
        try {
          stream.write("\r\u001b[2K");
        } catch {
          // ignore
        }
      },
    };
  }

  return {
    stream,
    isTTY,
    color,
    c,
    writeLine,
    detail,
    event,
    formatStatus,
    formatNode,
    formatCounts,
    hr,
    truncate,
    formatDuration,
    spinnerStart,
  };
}
