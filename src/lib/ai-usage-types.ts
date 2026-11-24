export type AiUsageTask = 'build' | 'design' | 'writing' | 'translation' | 'site-translation' | 'seo' | 'seo-content' | 'vision' | 'source' | 'connection';
export interface AiModelRate { model: string; currency: string; inputPerMillion: number; outputPerMillion: number; }
export interface AiPricing { revision: number; rates: AiModelRate[]; updatedAt: string; }
export interface AiUsageItem {
  id: string; task: AiUsageTask; model: string; status: 'started' | 'succeeded' | 'failed'; errorCode: string;
  inputChars: number; outputChars: number | null; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  imageCount: number; durationMs: number; createdAt: string; jobId: string | null;
  estimate: { currency: string; amount: number; pricingRevision: number } | null; usageWarning?: string;
}
export interface AiUsageList { items: AiUsageItem[]; total: number; page: number; pageSize: number; period: { from: string; to: string; timezone: 'UTC' }; }
