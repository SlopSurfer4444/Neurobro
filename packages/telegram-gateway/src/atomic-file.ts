import { mkdir, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function writeFileAtomic(
  targetPath: string,
  contents: string,
  mode: number = 0o600,
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const suffix = randomBytes(6).toString("hex");
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${suffix}`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode, flag: "wx" });
  await chmod(temporaryPath, mode).catch(() => undefined);
  await rename(temporaryPath, targetPath);
  await chmod(targetPath, mode).catch(() => undefined);
}
