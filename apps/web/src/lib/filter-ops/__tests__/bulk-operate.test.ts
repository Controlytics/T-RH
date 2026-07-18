import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api-client', () => ({
  apiClient: { post: vi.fn(), postWithReauth: vi.fn() },
}));
import { apiClient } from '@/lib/api-client';
import { bulkOperate } from '../bulk-operate';

describe('bulkOperate client helper', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('posts all items in one request and returns results', async () => {
    (apiClient.post as any).mockResolvedValue({ results: [{ clientOpId: 'a', filterId: 'f1', status: 'ok', snapshot: {} }] });
    const items = [{ clientOpId: 'a', filterId: 'f1', kind: 'advance' as const, payload: {} }];
    const out = await bulkOperate(items);
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith('/api/filters/bulk-operate', { items });
    expect(out.results).toHaveLength(1);
  });

  it('uses postWithReauth when a password is supplied', async () => {
    (apiClient.postWithReauth as any).mockResolvedValue({ results: [] });
    const items = [{ clientOpId: 'a', filterId: 'f1', kind: 'submit-checklist' as const, payload: {} }];
    await bulkOperate(items, 'pw');
    expect(apiClient.postWithReauth).toHaveBeenCalledWith('/api/filters/bulk-operate', { items }, 'pw');
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});
