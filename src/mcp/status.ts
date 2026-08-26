import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { McpClientInfo, McpStatusRecord, McpStatusView, McpProcessStatus } from './types';

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Windows ACLs are managed by the user profile.
  }
}

function atomicWrite(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(temporaryPath, 0o600);
  } catch {
    // Windows ACLs are managed by the user profile.
  }
  fs.renameSync(temporaryPath, filePath);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class McpStatusReporter {
  private readonly record: McpStatusRecord;
  private readonly filePath: string;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly statusDir: string,
    configPath: string,
    connectionIds: string[],
  ) {
    this.record = {
      version: 1,
      instanceId: crypto.randomUUID(),
      pid: process.pid,
      parentPid: process.ppid,
      status: 'starting',
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      configPath: path.resolve(configPath),
      connectionIds,
    };
    this.filePath = path.join(statusDir, `${this.record.instanceId}.json`);
  }

  start(): void {
    ensureDirectory(this.statusDir);
    this.write();
    this.timer = setInterval(() => this.heartbeat(), 5000);
    this.timer.unref();
  }

  setClient(client: McpClientInfo | undefined): void {
    if (client?.name) this.record.client = { name: client.name, version: client.version };
    this.setStatus('running');
  }

  setStatus(status: McpProcessStatus, lastError?: string): void {
    this.record.status = status;
    this.record.lastHeartbeat = new Date().toISOString();
    if (lastError) this.record.lastError = lastError;
    if (status === 'stopped') this.record.stoppedAt = new Date().toISOString();
    this.write();
  }

  heartbeat(): void {
    this.record.lastHeartbeat = new Date().toISOString();
    this.write();
  }

  stop(error?: string): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.setStatus(error ? 'error' : 'stopped', error);
  }

  private write(): void {
    try {
      ensureDirectory(this.statusDir);
      atomicWrite(this.filePath, this.record);
    } catch (error) {
      process.stderr.write(`[connect-toolbox-mcp] status write failed: ${(error as Error).message}\n`);
    }
  }
}

export function readMcpStatuses(statusDir: string): McpStatusView[] {
  if (!fs.existsSync(statusDir)) return [];
  const result: McpStatusView[] = [];
  for (const name of fs.readdirSync(statusDir)) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(statusDir, name);
    try {
      const record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as McpStatusRecord;
      if (record.version !== 1 || !record.instanceId) continue;
      const alive = record.status === 'running' || record.status === 'starting'
        ? isProcessAlive(record.pid)
        : false;
      const lastHeartbeat = Date.parse(record.lastHeartbeat);
      const stale = alive
        ? !Number.isFinite(lastHeartbeat) || Date.now() - lastHeartbeat > 30000
        : record.status !== 'stopped';
      result.push({ ...record, alive, stale });
    } catch {
      // Ignore partially written or obsolete status files.
    }
  }
  return result.sort((a, b) => b.lastHeartbeat.localeCompare(a.lastHeartbeat));
}
