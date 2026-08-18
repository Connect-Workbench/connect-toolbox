import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { pino, Logger as PinoLogger } from 'pino';

type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

let outputChannel: vscode.LogOutputChannel | null = null;
let pinoLogger: PinoLogger | null = null;
let logFile = '';

/**
 * 日志系统（升级版）：
 * - vscode.LogOutputChannel：输出面板可见（原生级别过滤，用户可查）
 * - pino：结构化 JSON 落盘（logs/connect-toolbox.log，我侧排障用）
 */
export function initLogger(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('Connect Toolbox', { log: true });
  try {
    const logDir = path.join(context.globalStorageUri.fsPath, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, 'connect-toolbox.log');
    // sync 模式：避免 worker transport 在扩展环境的复杂性；JSON lines 格式
    // pino v10 类型未暴露 destination（运行时存在），此处显式断言
    const destination = (pino as unknown as { destination: (o: { dest: string; sync: boolean; mkdir: boolean }) => unknown }).destination;
    const dest = destination({ dest: logFile, sync: true, mkdir: true });
    pinoLogger = pino(
      {
        level: 'info',
        timestamp: pino.stdTimeFunctions.isoTime,
      },
      dest as Parameters<typeof pino>[1],
    );
  } catch {
    pinoLogger = null;
  }
  info('logger initialized', { logFile, outputChannel: true });
}

function write(level: LogLevel, msg: string, args: unknown[]): void {
  // 输出面板（VSCode 原生）
  try {
    if (args.length > 0) {
      (outputChannel as unknown as Record<string, (m: string, ...a: unknown[]) => void>)?.[level]?.(msg, ...args);
    } else {
      (outputChannel as unknown as Record<string, (m: string) => void>)?.[level]?.(msg);
    }
  } catch {
    /* ignore */
  }
  // 落盘（pino）
  try {
    const fn = (pinoLogger as unknown as Record<string, (obj: unknown, m: string) => void>)?.[level];
    fn?.call(pinoLogger, { args: args.length > 0 ? args : undefined }, msg);
  } catch {
    /* ignore */
  }
}

export function trace(msg: string, ...args: unknown[]): void {
  write('trace', msg, args);
}
export function debug(msg: string, ...args: unknown[]): void {
  write('debug', msg, args);
}
export function info(msg: string, ...args: unknown[]): void {
  write('info', msg, args);
}
export function warn(msg: string, ...args: unknown[]): void {
  write('warn', msg, args);
}
export function error(msg: string, ...args: unknown[]): void {
  write('error', msg, args);
}

/** 日志文件路径（供调试时查看） */
export function getLogFile(): string {
  return logFile;
}
