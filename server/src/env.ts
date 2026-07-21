import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal .env loader (no dependency).
 *
 * Nothing was reading the repo's .env, so documented settings like NTFY_URL
 * silently never applied. This runs before anything else reads process.env -
 * import it FIRST in the entrypoint. Real environment variables always win, so
 * `NTFY_URL=... npm start` still overrides the file.
 */
export function loadEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = process.env.POLARIS_ENV_FILE ?? join(here, "..", "..", ".env");
  if (!existsSync(envPath)) return;

  let text: string;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return; // unreadable .env is not fatal
  }

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    // `export FOO=bar` is valid in a file people also source from a shell.
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    // strip matching surrounding quotes
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    } else {
      // Strip a trailing `# comment`. Only when unquoted and whitespace-
      // separated, so a '#' inside a value (ntfy topics, passwords) survives.
      // Without this, `NTFY_URL=https://ntfy.sh/topic  # mine` parses into a URL
      // that still has a valid .host, so ntfyStatus() reports "configured" while
      // every notification 404s - the silent-failure mode all over again.
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trimEnd();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// Run on import. Modules like notify.ts read process.env at evaluation time, so
// this must happen before they load - hence `import "./env.js"` sits first in
// the entrypoint's import list (ES modules evaluate in import order).
loadEnv();
