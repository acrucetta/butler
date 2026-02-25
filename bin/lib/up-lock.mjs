import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function acquireUpLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });

  const lockPayload = {
    pid: process.pid,
    createdAt: new Date().toISOString()
  };

  try {
    writeFileSync(lockPath, `${JSON.stringify(lockPayload)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      const active = readExistingLock(lockPath);
      if (active && Number.isInteger(active.pid) && isProcessAlive(active.pid)) {
        throw new Error(`butler up already running (pid=${active.pid}) lock=${lockPath}`);
      }
      rmSync(lockPath, { force: true });
      writeFileSync(lockPath, `${JSON.stringify(lockPayload)}\n`, { encoding: "utf8", flag: "wx" });
    } else {
      throw error;
    }
  }

  let released = false;

  return {
    get released() {
      return released;
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      rmSync(lockPath, { force: true });
    }
  };
}

function readExistingLock(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}
