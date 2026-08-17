import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export interface LockPayload {
  pid: number;
  startedAt: number;
  lastHeartbeat: number;
  version: string;
  socketPath: string;
  metadata?: Record<string, unknown>;
}

export type LockAcquisitionStatus = "acquired" | "already_running" | "stale_recovered";

export interface LockAcquisitionResult {
  status: LockAcquisitionStatus;
  lock?: DaemonLock;
  pid?: number;
  lockData?: LockPayload;
  previousLockData?: LockPayload;
}

export interface LockInspectionResult {
  exists: boolean;
  isStale: boolean;
  isProcessAlive: boolean;
  pid?: number;
  lockData?: LockPayload;
  error?: string;
}

export interface DaemonLockOptions {
  lockPath: string;
  socketPath?: string;
  version?: string;
  staleThresholdMs?: number;
  heartbeatIntervalMs?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Checks whether a process with the given PID is currently active.
 */
export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0 || !Number.isInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    // EPERM means the process exists but is owned by another user -> definitely alive
    if (error.code === "EPERM") {
      return true;
    }
    // ESRCH means no such process exists
    if (error.code === "ESRCH") {
      return false;
    }
    // Any other error: defensively assume alive
    return true;
  }
}

/**
 * Manages an atomic single-instance daemon lock file with PID inspection,
 * periodic heartbeat renewals, and stale lock recovery.
 */
export class DaemonLock {
  readonly lockPath: string;
  readonly socketPath: string;
  readonly version: string;
  readonly staleThresholdMs: number;
  readonly heartbeatIntervalMs: number;
  readonly metadata: Record<string, unknown>;

  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isHeld = false;
  private startedAt = 0;

  constructor(options: DaemonLockOptions) {
    this.lockPath = path.resolve(options.lockPath);
    this.socketPath = options.socketPath ?? "";
    this.version = options.version ?? "0.1.0";
    this.staleThresholdMs = options.staleThresholdMs ?? 15000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 3000;
    this.metadata = options.metadata ?? {};
  }

  /**
   * Returns true if this lock instance is currently held by this process.
   */
  get isLocked(): boolean {
    return this.isHeld;
  }

  /**
   * Attempts to acquire the daemon lock atomically.
   */
  async acquire(): Promise<LockAcquisitionResult> {
    if (this.isHeld) {
      return {
        status: "acquired",
        lock: this,
        pid: process.pid,
      };
    }

    // Ensure parent directory exists
    const lockDir = path.dirname(this.lockPath);
    await fs.promises.mkdir(lockDir, { recursive: true, mode: 0o700 });

    const inspectResult = await this.inspect();

    if (inspectResult.exists && !inspectResult.isStale && inspectResult.isProcessAlive) {
      return {
        status: "already_running",
        pid: inspectResult.pid,
        lockData: inspectResult.lockData,
      };
    }

    let isRecovery = false;
    let previousLockData: LockPayload | undefined;

    if (inspectResult.exists) {
      // Lock exists but is stale (process is dead or heartbeat timed out or corrupted)
      isRecovery = true;
      previousLockData = inspectResult.lockData;
      try {
        await fs.promises.unlink(this.lockPath);
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code !== "ENOENT") {
          // If cannot remove, another process might have handled it
        }
      }
    }

    this.startedAt = Date.now();
    const payload: LockPayload = {
      pid: process.pid,
      startedAt: this.startedAt,
      lastHeartbeat: Date.now(),
      version: this.version,
      socketPath: this.socketPath,
      metadata: this.metadata,
    };

    try {
      await fs.promises.writeFile(this.lockPath, JSON.stringify(payload, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EEXIST") {
        // Race condition: another process just created the lock file. Re-inspect.
        const freshInspect = await this.inspect();
        if (freshInspect.exists && !freshInspect.isStale && freshInspect.isProcessAlive) {
          return {
            status: "already_running",
            pid: freshInspect.pid,
            lockData: freshInspect.lockData,
          };
        }
      }
      throw err;
    }

    this.isHeld = true;
    this.startHeartbeat();

    return {
      status: isRecovery ? "stale_recovered" : "acquired",
      lock: this,
      pid: process.pid,
      lockData: payload,
      previousLockData,
    };
  }

  /**
   * Updates the heartbeat timestamp in the lock file.
   */
  async heartbeat(): Promise<void> {
    if (!this.isHeld) return;

    const payload: LockPayload = {
      pid: process.pid,
      startedAt: this.startedAt,
      lastHeartbeat: Date.now(),
      version: this.version,
      socketPath: this.socketPath,
      metadata: this.metadata,
    };

    const tmpPath = `${this.lockPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
      await fs.promises.rename(tmpPath, this.lockPath);
    } catch {
      // Clean up tmp file on error if it exists
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        // Ignore unlink error
      }
    }
  }

  /**
   * Releases the lock file and stops the heartbeat timer.
   */
  async release(): Promise<void> {
    this.stopHeartbeat();
    if (!this.isHeld) return;

    this.isHeld = false;
    try {
      const content = await fs.promises.readFile(this.lockPath, "utf-8");
      const parsed = JSON.parse(content) as LockPayload;
      if (parsed.pid === process.pid) {
        await fs.promises.unlink(this.lockPath);
      }
    } catch {
      // Ignore errors when releasing (e.g. file already gone)
    }
  }

  /**
   * Inspects the current state of the lock file.
   */
  async inspect(): Promise<LockInspectionResult> {
    try {
      const content = await fs.promises.readFile(this.lockPath, "utf-8");
      let parsed: LockPayload;
      try {
        parsed = JSON.parse(content) as LockPayload;
      } catch {
        // Corrupted JSON -> consider stale
        return {
          exists: true,
          isStale: true,
          isProcessAlive: false,
          error: "Corrupted lock file content",
        };
      }

      if (typeof parsed.pid !== "number" || !parsed.pid) {
        return {
          exists: true,
          isStale: true,
          isProcessAlive: false,
          error: "Missing or invalid PID in lock file",
        };
      }

      const alive = isProcessAlive(parsed.pid);
      const heartbeatAge = Date.now() - (parsed.lastHeartbeat || 0);
      const isHeartbeatExpired = heartbeatAge > this.staleThresholdMs;
      const isStale = !alive || isHeartbeatExpired;

      return {
        exists: true,
        isStale,
        isProcessAlive: alive,
        pid: parsed.pid,
        lockData: parsed,
      };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        return {
          exists: false,
          isStale: false,
          isProcessAlive: false,
        };
      }
      return {
        exists: true,
        isStale: true,
        isProcessAlive: false,
        error: error.message,
      };
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, this.heartbeatIntervalMs);
    // Unref so heartbeat doesn't prevent Node process exit if remaining
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

export async function acquireDaemonLock(
  options: DaemonLockOptions,
): Promise<LockAcquisitionResult> {
  const lock = new DaemonLock(options);
  return lock.acquire();
}
