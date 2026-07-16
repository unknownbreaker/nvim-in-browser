// Reads a <input type="file" webkitdirectory> selection into path/bytes pairs,
// stripping the top folder segment (the user picked ".../mycfg", we want the
// tree beneath it) and sanitizing each path. Shared by the config folder-import
// and the manual plugin-folder-upload flows.
import { isSafeRelpath } from "../storage/config-store";

export function toUploadRelpath(webkitRelativePath: string): string | null {
  const slash = webkitRelativePath.indexOf("/");
  if (slash < 0) return null; // no top-folder segment -> not a folder upload entry
  const rel = webkitRelativePath.slice(slash + 1);
  if (rel.length === 0) return null;
  if (!isSafeRelpath(rel)) return null;
  return rel;
}

export async function readFolderUpload(
  files: FileList,
): Promise<{ path: string; data: Uint8Array }[]> {
  const out: { path: string; data: Uint8Array }[] = [];
  for (const file of Array.from(files)) {
    const rel = toUploadRelpath(file.webkitRelativePath);
    if (rel === null) continue;
    out.push({ path: rel, data: new Uint8Array(await file.arrayBuffer()) });
  }
  return out;
}
