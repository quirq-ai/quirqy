import { copyFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Start without bundled content; local workspace files remain untracked.
await mkdir(path.join(root, "workspace"), { recursive: true });
const destination = path.join(root, "public", "capybara.png");
await mkdir(path.dirname(destination), { recursive: true });
try {
  await access(destination);
} catch {
  // Reuse the already-cloned, MIT-licensed original asset. No network request.
  for (const folder of ["OpenMuse", "openmuse"]) {
    try {
      await copyFile(path.resolve(root, "..", folder, "apps/mobile/assets/capybara.png"), destination);
      break;
    } catch { /* A bundled SVG fallback is used if the sibling clone is absent. */ }
  }
}
