import { describe, expect, it } from 'vitest';
import { BankRateLimitError, MonobankClient } from '../../src/modules/payments/monobank.js';

function fakeFetch(responses: Record<string, { status: number; body: unknown }>, seen: { url: string; token?: string }[]) {
  return (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace('https://api.monobank.ua', '');
    seen.push({ url: path, token: (init?.headers as Record<string, string>)['X-Token'] });
    const match = Object.entries(responses).find(([prefix]) => path.startsWith(prefix));
    const response = match?.[1] ?? { status: 404, body: {} };
    return new Response(JSON.stringify(response.body), { status: response.status });
  }) as typeof fetch;
}

describe('Monobank client', () => {
  it('lists jars (with their public links) and cards', async () => {
    const seen: { url: string; token?: string }[] = [];
    const client = new MonobankClient(
      'secret-token-value-123456',
      fakeFetch(
        {
          '/personal/client-info': {
            status: 200,
            body: {
              accounts: [{ id: 'acc1', currencyCode: 980, maskedPan: ['537541******1234'], type: 'black' }],
              jars: [{ id: 'jar1', currencyCode: 980, title: 'Батли', sendId: 'jar/AbC123' }],
            },
          },
        },
        seen,
      ),
    );
    const accounts = await client.listAccounts();
    expect(accounts).toEqual([
      { id: 'jar1', kind: 'jar', label: 'Батли · UAH', currencyCode: 980, sendLink: 'https://send.monobank.ua/jar/AbC123' },
      { id: 'acc1', kind: 'card', label: '537541******1234 · UAH', currencyCode: 980 },
    ]);
    expect(seen[0]).toEqual({ url: '/personal/client-info', token: 'secret-token-value-123456' });
  });

  it('requests a statement for at most 31 days and reports the rate limit', async () => {
    const seen: { url: string; token?: string }[] = [];
    const client = new MonobankClient(
      'secret-token-value-123456',
      fakeFetch({ '/personal/statement/jar1/': { status: 200, body: [{ id: 't1', time: 1, amount: 8900, currencyCode: 980, description: 'x' }] } }, seen),
    );
    const to = new Date('2026-11-06T12:00:00Z');
    const items = await client.statement('jar1', new Date('2026-01-01T00:00:00Z'), to);
    expect(items).toHaveLength(1);
    const [, , , , from, until] = seen[0]!.url.split('/');
    expect(Number(until) - Number(from)).toBe(31 * 24 * 60 * 60);

    const limited = new MonobankClient('secret-token-value-123456', fakeFetch({ '/personal': { status: 429, body: {} } }, []));
    await expect(limited.statement('jar1', to, to)).rejects.toBeInstanceOf(BankRateLimitError);
  });
});
