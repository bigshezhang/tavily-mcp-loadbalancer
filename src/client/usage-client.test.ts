import fs from 'fs';
import os from 'os';
import path from 'path';
import { UsageClient, TavilyUsageApiResponse } from './usage-client';
import { AppDatabase } from '../data/database';
import { getCurrentQuotaPeriod } from '../utils/date';

const createTestDatabase = (): { db: AppDatabase; cleanup: () => void } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavily-usage-client-test-'));
  const db = new AppDatabase(path.join(dir, 'test.db'), 'test-encryption-key');
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};

const usageResponse = (accountLimit: number | null, keyLimit: number | null): TavilyUsageApiResponse => ({
  key: { usage: 12, limit: keyLimit },
  account: {
    current_plan: 'Researcher',
    plan_usage: 37,
    plan_limit: accountLimit,
    extract_usage: 0,
    map_usage: 0,
    paygo_usage: 0,
    paygo_limit: null,
  },
});

describe('UsageClient quota normalization', () => {
  it('persists the account limit when a free key reports key.limit as null', async () => {
    const { db, cleanup } = createTestDatabase();
    try {
      const key = db.addApiKey({ keyValue: 'tvly-free-key' });
      const client = new UsageClient(db);
      client.fetchUsage = jest.fn().mockResolvedValue(usageResponse(1000, null));

      await client.fetchUsageAndSync(key.id, key.key_value);

      const quota = db.getMonthlyQuotaForKey(key.id, getCurrentQuotaPeriod());
      expect(quota?.used_count).toBe(37);
      expect(quota?.quota_limit).toBe(1000);
    } finally {
      cleanup();
    }
  });

  it('falls back to key-level values when account values are unavailable', async () => {
    const { db, cleanup } = createTestDatabase();
    try {
      const key = db.addApiKey({ keyValue: 'tvly-key-fallback' });
      const client = new UsageClient(db);
      const response = usageResponse(null, 500);
      (response.account as any).plan_usage = null;
      client.fetchUsage = jest.fn().mockResolvedValue(response);

      await client.fetchUsageAndSync(key.id, key.key_value);

      const quota = db.getMonthlyQuotaForKey(key.id, getCurrentQuotaPeriod());
      expect(quota?.used_count).toBe(12);
      expect(quota?.quota_limit).toBe(500);
    } finally {
      cleanup();
    }
  });
});
