import axios from 'axios';
import { AppDatabase } from '../data/database.js';
import { UsageClient } from '../client/usage-client.js';
import { logger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import { EventBus } from '../core/event-bus.js';

export type UsageSyncReason = 'scheduled' | 'stale' | 'all' | 'manual_test' | 'new_key';

interface UsageSyncTask {
  keyId: number;
  priority: number;
  reasons: Set<UsageSyncReason>;
  enqueuedAt: number;
}

export interface UsageSyncEnqueueResult {
  requested: number;
  enqueued: number;
  deduplicated: number;
  promoted: number;
  missing: number;
  queue: UsageSyncQueueStatus;
}

export interface UsageSyncQueueStatus {
  pending: number;
  running: number;
  runningKeyId: number | null;
  blockedUntil: string | null;
  nextRequestAt: string | null;
  lastRequestAt: string | null;
}

interface UsageSyncOptions {
  minIntervalMs?: number;
  retryDelayMs?: number;
  staleAfterMs?: number;
  scheduleIntervalMs?: number;
  autoEnqueueOnStart?: boolean;
}

interface ParsedUsageError {
  type: 'auth' | 'rate_limit' | 'network';
  message: string;
  responseData: unknown;
  retryAfterMs: number | null;
}

const priorityFor = (reason: UsageSyncReason): number => {
  switch (reason) {
    case 'manual_test': return 50;
    case 'new_key': return 40;
    case 'all': return 30;
    case 'stale': return 20;
    case 'scheduled': return 10;
  }
};

const stringifyLogData = (data: unknown): string | null => {
  if (data === undefined || data === null) return null;
  try {
    const json = JSON.stringify(data);
    return json.length > 50000 ? `${json.slice(0, 50000)}...(truncated)` : json;
  } catch {
    return null;
  }
};

const parseRetryAfterMs = (value: unknown): number | null => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  if (typeof raw === 'string') {
    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs) && dateMs > Date.now()) return dateMs - Date.now();
  }
  return null;
};

const parseUsageError = (error: unknown): ParsedUsageError => {
  if (!axios.isAxiosError(error)) {
    return {
      type: 'network',
      message: error instanceof Error ? error.message : String(error || 'Usage sync failed'),
      responseData: null,
      retryAfterMs: null,
    };
  }

  const status = error.response?.status;
  const data = error.response?.data as any;
  const detail = data?.detail;
  const message =
    (typeof detail === 'string' && detail) ||
    (detail && typeof detail === 'object' && (detail.error || detail.message || detail.detail)) ||
    data?.error ||
    data?.message ||
    error.message;
  const normalized = String(message).toLowerCase();
  const rateLimited = status === 429 || normalized.includes('excessive requests') || normalized.includes('rate limit');

  return {
    type: status === 401 || status === 403 ? 'auth' : rateLimited ? 'rate_limit' : 'network',
    message: String(message || error.message),
    responseData: data ?? null,
    retryAfterMs: parseRetryAfterMs(error.response?.headers?.['retry-after']),
  };
};

export class UsageSyncScheduler {
  private readonly minIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly staleAfterMs: number;
  private readonly scheduleIntervalMs: number;
  private readonly autoEnqueueOnStart: boolean;
  private queue: UsageSyncTask[] = [];
  private pending = new Map<number, UsageSyncTask>();
  private runningTask: UsageSyncTask | null = null;
  private processTimer?: NodeJS.Timeout;
  private scheduleTimer?: NodeJS.Timeout;
  private lastRequestAt = 0;
  private blockedUntil = 0;
  private started = false;

  constructor(
    private db: AppDatabase,
    private usageClient: UsageClient,
    private eventBus?: EventBus,
    options: UsageSyncOptions = {}
  ) {
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? config.usageSyncMinIntervalMs);
    this.retryDelayMs = Math.max(1000, options.retryDelayMs ?? config.usageSyncRetryDelayMs);
    this.staleAfterMs = Math.max(0, options.staleAfterMs ?? config.usageSyncStaleAfterMs);
    this.scheduleIntervalMs = Math.max(1000, options.scheduleIntervalMs ?? config.usageSyncScheduleIntervalMs);
    this.autoEnqueueOnStart = options.autoEnqueueOnStart ?? true;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    // Resume work that was pending when the process stopped.
    const recoverableIds = this.db.getUsageSyncStates()
      .filter((state) => state.last_status === 'pending' || state.last_status === 'running' || state.last_status === 'rate_limited')
      .map((state) => state.key_id);
    if (recoverableIds.length > 0) this.enqueueKeys(recoverableIds, 'scheduled');
    if (this.autoEnqueueOnStart) this.enqueueStale('scheduled');

    this.scheduleTimer = setInterval(() => this.enqueueStale('scheduled'), this.scheduleIntervalMs);
    this.scheduleTimer.unref?.();
    this.scheduleProcess(0);
  }

  enqueueAll(): UsageSyncEnqueueResult {
    return this.enqueueKeys(this.db.getApiKeys().map((key) => key.id), 'all');
  }

  enqueueStale(reason: 'stale' | 'scheduled' = 'stale'): UsageSyncEnqueueResult {
    const cutoff = Date.now() - this.staleAfterMs;
    const states = new Map(this.db.getUsageSyncStates().map((state) => [state.key_id, state]));
    const ids = this.db.getApiKeys()
      .filter((key) => {
        const lastSuccessAt = states.get(key.id)?.last_success_at;
        return !lastSuccessAt || Date.parse(lastSuccessAt) <= cutoff;
      })
      .map((key) => key.id);
    return this.enqueueKeys(ids, reason);
  }

  enqueueKeys(ids: number[], reason: UsageSyncReason): UsageSyncEnqueueResult {
    const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isFinite(id))));
    let enqueued = 0;
    let deduplicated = 0;
    let promoted = 0;
    let missing = 0;
    const priority = priorityFor(reason);

    for (const keyId of uniqueIds) {
      try {
        this.db.getApiKeyById(keyId);
      } catch {
        missing += 1;
        continue;
      }

      if (this.runningTask?.keyId === keyId) {
        this.runningTask.reasons.add(reason);
        deduplicated += 1;
        continue;
      }

      const existing = this.pending.get(keyId);
      if (existing) {
        existing.reasons.add(reason);
        if (priority > existing.priority) {
          existing.priority = priority;
          promoted += 1;
        }
        deduplicated += 1;
        continue;
      }

      const task: UsageSyncTask = {
        keyId,
        priority,
        reasons: new Set([reason]),
        enqueuedAt: Date.now(),
      };
      this.queue.push(task);
      this.pending.set(keyId, task);
      this.db.markUsageSyncPending(keyId);
      enqueued += 1;
    }

    this.sortQueue();
    this.scheduleProcess(0);
    const result = {
      requested: uniqueIds.length,
      enqueued,
      deduplicated,
      promoted,
      missing,
      queue: this.getStatus(),
    };
    this.emitStatus();
    return result;
  }

  cancelKey(keyId: number): void {
    const task = this.pending.get(keyId);
    if (!task) return;
    this.pending.delete(keyId);
    this.queue = this.queue.filter((item) => item.keyId !== keyId);
    this.emitStatus();
  }

  getStatus(): UsageSyncQueueStatus {
    const now = Date.now();
    const nextRequestAt = Math.max(
      this.blockedUntil,
      this.lastRequestAt > 0 ? this.lastRequestAt + this.minIntervalMs : 0
    );
    return {
      pending: this.queue.length,
      running: this.runningTask ? 1 : 0,
      runningKeyId: this.runningTask?.keyId ?? null,
      blockedUntil: this.blockedUntil > now ? new Date(this.blockedUntil).toISOString() : null,
      nextRequestAt: this.queue.length > 0 && nextRequestAt > now ? new Date(nextRequestAt).toISOString() : null,
      lastRequestAt: this.lastRequestAt > 0 ? new Date(this.lastRequestAt).toISOString() : null,
    };
  }

  stop(): void {
    this.started = false;
    if (this.processTimer) clearTimeout(this.processTimer);
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
    this.processTimer = undefined;
    this.scheduleTimer = undefined;
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
  }

  private scheduleProcess(delayMs: number): void {
    if (!this.started || this.runningTask || this.processTimer || this.queue.length === 0) return;
    this.processTimer = setTimeout(() => {
      this.processTimer = undefined;
      void this.processNext();
    }, Math.max(0, delayMs));
    this.processTimer.unref?.();
  }

  private async processNext(): Promise<void> {
    if (!this.started || this.runningTask || this.queue.length === 0) return;
    const now = Date.now();
    const readyAt = Math.max(this.blockedUntil, this.lastRequestAt + this.minIntervalMs);
    if (readyAt > now) {
      this.scheduleProcess(readyAt - now);
      this.emitStatus();
      return;
    }

    this.sortQueue();
    const task = this.queue.shift();
    if (!task) return;
    this.pending.delete(task.keyId);
    this.runningTask = task;
    this.db.markUsageSyncRunning(task.keyId);
    this.lastRequestAt = Date.now();
    this.emitStatus();

    const startedAt = Date.now();
    let shouldRequeue = false;
    try {
      const key = this.db.getApiKeyById(task.keyId);
      const usage = await this.usageClient.fetchUsageAndSync(key.id, key.key_value);
      this.db.markUsageSyncSuccess(key.id);
      this.logResult(task, 'success', usage, Date.now() - startedAt, null, null);
      logger.info('Usage sync task completed', { keyId: key.id, reasons: Array.from(task.reasons) });
    } catch (error: unknown) {
      const parsed = parseUsageError(error);
      this.logResult(task, 'error', parsed.responseData, Date.now() - startedAt, parsed.type, parsed.message);
      if (parsed.type === 'rate_limit') {
        const delayMs = Math.max(parsed.retryAfterMs ?? this.retryDelayMs, 1000);
        this.blockedUntil = Date.now() + delayMs;
        this.db.markUsageSyncFailure(task.keyId, 'rate_limited', parsed.message);
        shouldRequeue = true;
        logger.warn('Usage sync queue rate limited', { keyId: task.keyId, delayMs });
      } else {
        this.db.markUsageSyncFailure(task.keyId, 'error', parsed.message);
        logger.warn('Usage sync task failed', { keyId: task.keyId, type: parsed.type, error: parsed.message });
      }
    } finally {
      this.runningTask = null;
      if (shouldRequeue) {
        task.enqueuedAt = Date.now();
        this.queue.push(task);
        this.pending.set(task.keyId, task);
        this.sortQueue();
      }
      this.emitStatus();
      this.scheduleProcess(0);
    }
  }

  private logResult(
    task: UsageSyncTask,
    responseStatus: 'success' | 'error',
    responseData: unknown,
    responseTimeMs: number,
    errorType: string | null,
    errorMessage: string | null
  ): void {
    const toolName = task.reasons.has('manual_test') ? 'test' : 'sync_quota';
    this.db.insertRequestLog({
      key_id: task.keyId,
      tool_name: toolName,
      request_params: JSON.stringify({ reasons: Array.from(task.reasons) }),
      response_data: stringifyLogData(responseData),
      response_status: responseStatus,
      response_time_ms: responseTimeMs,
      error_type: errorType,
      error_message: errorMessage,
    });
  }

  private emitStatus(): void {
    this.eventBus?.emitEvent('usage_sync', this.getStatus());
  }
}
