import fs from "fs";
import path from "path";

// The cockpit stores attached PDFs under data/files/cockpit/<userId>/ (the dev
// UPLOADS_DIR is cwd-relative and not configurable). Remove what the synthetic
// E2E user created; the user id lives in a throwaway file next to the DB.
export default async function globalTeardown() {
  const tmp = path.join(process.cwd(), ".cockpit-tmp");
  for (const port of ["3738", "3739"]) {
    const f = path.join(tmp, `e2e-user-${port}.json`);
    if (!fs.existsSync(f)) continue;
    const { id } = JSON.parse(fs.readFileSync(f, "utf8")) as { id?: string };
    if (id && /^[0-9a-f-]{36}$/.test(id)) {
      fs.rmSync(path.join(process.cwd(), "data", "files", "cockpit", id), {
        recursive: true,
        force: true,
      });
    }
    fs.rmSync(f, { force: true });
    fs.rmSync(path.join(tmp, `e2e-mcp-token-${port}.txt`), { force: true });
  }
}
