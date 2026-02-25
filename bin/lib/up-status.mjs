import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function createUpStatusStore(filePath, input) {
  const now = isoNow();
  const state = {
    supervisor: {
      pid: process.pid,
      startedAt: now,
      updatedAt: now,
      status: "running",
      runtime: input.runtime,
      workerMode: input.workerMode
    },
    services: Object.fromEntries(
      input.services.map((name) => [
        name,
        {
          name,
          status: "idle",
          restartCount: 0,
          updatedAt: now
        }
      ])
    )
  };

  persistState(filePath, state);

  return {
    filePath,
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    },
    setSupervisorStatus(status) {
      state.supervisor.status = status;
      state.supervisor.updatedAt = isoNow();
      persistState(filePath, state);
    },
    markServiceStarting(name) {
      const service = ensureService(state, name);
      service.status = "starting";
      service.startedAt = isoNow();
      service.updatedAt = service.startedAt;
      delete service.lastExit;
      persistState(filePath, state);
    },
    markServiceRunning(name, pid) {
      const service = ensureService(state, name);
      service.status = "running";
      service.pid = pid;
      service.updatedAt = isoNow();
      persistState(filePath, state);
    },
    markServiceRestartScheduled(name, restartCount, delayMs) {
      const service = ensureService(state, name);
      service.status = "restart_scheduled";
      service.restartCount = restartCount;
      service.nextRestartAt = new Date(Date.now() + delayMs).toISOString();
      service.updatedAt = isoNow();
      persistState(filePath, state);
    },
    markServiceExited(name, code, signal) {
      const service = ensureService(state, name);
      service.status = "exited";
      delete service.pid;
      delete service.nextRestartAt;
      service.lastExit = {
        code: code ?? null,
        signal: signal ?? null,
        at: isoNow()
      };
      service.updatedAt = isoNow();
      persistState(filePath, state);
    }
  };
}

export function readUpStatus(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function ensureService(state, name) {
  if (!(name in state.services)) {
    state.services[name] = {
      name,
      status: "idle",
      restartCount: 0,
      updatedAt: isoNow()
    };
  }
  return state.services[name];
}

function persistState(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function isoNow() {
  return new Date().toISOString();
}
