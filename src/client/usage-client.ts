import axios from 'axios';
import { AppDatabase } from '../data/database.js';
import { logger } from '../utils/logger.js';
import { getCurrentQuotaPeriod } from '../utils/date.js';

// Tavily API actual response format
export interface TavilyUsageApiResponse {
  key: {
    usage: number;
    limit: number | null;
  };
  account: {
    current_plan: string;
    plan_usage: number;
    plan_limit: number | null;
    extract_usage: number;
    map_usage: number;
    paygo_usage: number;
    paygo_limit: number | null;
  };
}

const finiteNumberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export class UsageClient {
  constructor(private db: AppDatabase) {}

  async fetchUsage(apiKey: string): Promise<TavilyUsageApiResponse> {
    const response = await axios.get<TavilyUsageApiResponse>('https://api.tavily.com/usage', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Client-Source': 'MCP',
        accept: 'application/json',
      },
      timeout: 10000,
    });
    return response.data;
  }

  async fetchUsageAndSync(keyId: number, apiKey: string): Promise<TavilyUsageApiResponse> {
    const response = await this.fetchUsage(apiKey);
    const yearMonth = getCurrentQuotaPeriod();

    // Free Researcher keys may report key.limit as null while account.plan_limit is 1000.
    // Prefer account-level values and fall back to key-level values for compatibility.
    const quotaLimit = finiteNumberOrNull(response.account?.plan_limit)
      ?? finiteNumberOrNull(response.key?.limit);
    const usedCount = finiteNumberOrNull(response.account?.plan_usage)
      ?? finiteNumberOrNull(response.key?.usage)
      ?? 0;

    logger.info('Usage sync result', {
      keyId,
      plan: response.account.current_plan,
      used: usedCount,
      limit: quotaLimit
    });

    this.db.updateMonthlyQuotaFromUsage({
      keyId,
      yearMonth,
      quotaLimit,
      usedCount,
      resetAt: null,
    });

    return response;
  }
}
