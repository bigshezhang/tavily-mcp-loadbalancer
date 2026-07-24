import fs from 'fs';
import os from 'os';
import path from 'path';
import { AppDatabase } from '../data/database';
import { UsageClient } from '../client/usage-client';
import { UsageSyncScheduler } from './usage-sync';

const createTestDatabase = (): { db: AppDatabase; cleanup: () => void } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavily-usage-sync-test-'));
  const db = new AppDatabase(path.join(dir, 'test.db'), 'test-encryption-key');
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for usage sync');
};

describe('UsageSyncScheduler', () => {
  it('deduplicates queued keys and promotes manual tests ahead of background work', async () => {
    const { db, cleanup } = createTestDatabase();
    const first = db.addApiKey({ keyValue: 'tvly-first' });
    const second = db.addApiKey({ keyValue: 'tvly-second' });
    const calls: number[] = [];
    const usageClient = {
      fetchUsageAndSync: jest.fn(async (keyId: number) => {
        calls.push(keyId);
        return { key: {}, account: {} };
      }),
    } as unknown as UsageClient;
    const scheduler = new UsageSyncScheduler(db, usageClient, undefined, {
      minIntervalMs: 0,
      scheduleIntervalMs: 60_000,
      autoEnqueueOnStart: false,
    });

    try {
      scheduler.enqueueKeys([first.id], 'scheduled');
      scheduler.enqueueKeys([second.id], 'all');
      const promoted = scheduler.enqueueKeys([first.id, first.id], 'manual_test');

      expect(promoted.requested).toBe(1);
      expect(promoted.enqueued).toBe(0);
      expect(promoted.deduplicated).toBe(1);
      expect(promoted.promoted).toBe(1);

      scheduler.start();
      await waitFor(() => calls.length === 2);

      expect(calls).toEqual([first.id, second.id]);
      expect(db.getUsageSyncStateForKey(first.id)?.last_status).toBe('success');
      expect(db.getUsageSyncStateForKey(second.id)?.last_status).toBe('success');
    } finally {
      scheduler.stop();
      cleanup();
    }
  });

  it('only enqueues keys whose last successful sync is stale', () => {
    const { db, cleanup } = createTestDatabase();
    const fresh = db.addApiKey({ keyValue: 'tvly-fresh' });
    const neverSynced = db.addApiKey({ keyValue: 'tvly-never' });
    db.markUsageSyncSuccess(fresh.id);
    const usageClient = { fetchUsageAndSync: jest.fn() } as unknown as UsageClient;
    const scheduler = new UsageSyncScheduler(db, usageClient, undefined, {
      staleAfterMs: 60_000,
      autoEnqueueOnStart: false,
    });

    try {
      const result = scheduler.enqueueStale('stale');
      expect(result.requested).toBe(1);
      expect(result.enqueued).toBe(1);
      expect(db.getUsageSyncStateForKey(neverSynced.id)?.last_status).toBe('pending');
    } finally {
      scheduler.stop();
      cleanup();
    }
  });

  it('pauses the whole queue on 429 and retries after retry-after', async () => {
    jest.useFakeTimers();
    const { db, cleanup } = createTestDatabase();
    const key = db.addApiKey({ keyValue: 'tvly-rate-limited' });
    const rateLimitError = Object.assign(new Error('Too many requests'), {
      isAxiosError: true,
      response: {
        status: 429,
        headers: { 'retry-after': '2' },
        data: { error: 'Your request has been blocked due to excessive requests.' },
      },
    });
    const fetchUsageAndSync = jest.fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({ key: {}, account: {} });
    const usageClient = { fetchUsageAndSync } as unknown as UsageClient;
    const scheduler = new UsageSyncScheduler(db, usageClient, undefined, {
      minIntervalMs: 0,
      retryDelayMs: 10_000,
      scheduleIntervalMs: 60_000,
      autoEnqueueOnStart: false,
    });

    try {
      scheduler.enqueueKeys([key.id], 'manual_test');
      scheduler.start();
      await jest.advanceTimersByTimeAsync(0);

      expect(fetchUsageAndSync).toHaveBeenCalledTimes(1);
      expect(db.getUsageSyncStateForKey(key.id)?.last_status).toBe('rate_limited');
      expect(scheduler.getStatus().pending).toBe(1);

      await jest.advanceTimersByTimeAsync(1999);
      expect(fetchUsageAndSync).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(fetchUsageAndSync).toHaveBeenCalledTimes(2);
      expect(db.getUsageSyncStateForKey(key.id)?.last_status).toBe('success');
    } finally {
      scheduler.stop();
      cleanup();
      jest.useRealTimers();
    }
  });
});
