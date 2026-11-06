/** Incoming/outgoing operation from a bank statement (amount in minor units, positive = incoming). */
export interface BankStatementItem {
  id: string;
  time: number;
  amount: number;
  currencyCode: number;
  description: string;
  comment?: string;
}

export interface BankAccount {
  id: string;
  kind: 'card' | 'jar';
  /** Card mask or jar title, for the admin to pick from. */
  label: string;
  currencyCode: number;
  /** Public top-up link (jars only). */
  sendLink?: string;
}

/** Read-only access to the owner's bank statement. */
export interface BankClient {
  listAccounts(): Promise<BankAccount[]>;
  statement(accountId: string, from: Date, to: Date): Promise<BankStatementItem[]>;
}

export class BankRateLimitError extends Error {
  constructor() {
    super('Monobank API rate limit (1 request per 60 s)');
    this.name = 'BankRateLimitError';
  }
}

const API = 'https://api.monobank.ua';
const TIMEOUT_MS = 15_000;
/** Monobank returns at most 31 days + 1 hour per statement request. */
const MAX_PERIOD_MS = 31 * 24 * 60 * 60 * 1000;

interface ClientInfo {
  accounts?: { id: string; currencyCode: number; maskedPan?: string[]; type?: string; sendId?: string }[];
  jars?: { id: string; currencyCode: number; title?: string; sendId?: string }[];
}

function jarLink(sendId: string | undefined): string | undefined {
  if (!sendId) return undefined;
  return `https://send.monobank.ua/${sendId.startsWith('jar/') ? sendId : `jar/${sendId}`}`;
}

/**
 * Monobank personal API (https://api.monobank.ua/docs/). The personal token
 * only allows reading account info and statements — it cannot move money.
 */
export class MonobankClient implements BankClient {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listAccounts(): Promise<BankAccount[]> {
    const info = (await this.get('/personal/client-info')) as ClientInfo;
    const cards: BankAccount[] = (info.accounts ?? []).map((account) => ({
      id: account.id,
      kind: 'card',
      label: [account.maskedPan?.[0] ?? account.type ?? 'account', currencyLabel(account.currencyCode)].join(' · '),
      currencyCode: account.currencyCode,
    }));
    const jars: BankAccount[] = (info.jars ?? []).map((jar) => {
      const link = jarLink(jar.sendId);
      return {
        id: jar.id,
        kind: 'jar',
        label: [jar.title ?? 'jar', currencyLabel(jar.currencyCode)].join(' · '),
        currencyCode: jar.currencyCode,
        ...(link ? { sendLink: link } : {}),
      };
    });
    return [...jars, ...cards];
  }

  async statement(accountId: string, from: Date, to: Date): Promise<BankStatementItem[]> {
    const start = Math.max(from.getTime(), to.getTime() - MAX_PERIOD_MS);
    const items = (await this.get(`/personal/statement/${encodeURIComponent(accountId)}/${Math.floor(start / 1000)}/${Math.floor(to.getTime() / 1000)}`)) as BankStatementItem[];
    return Array.isArray(items) ? items : [];
  }

  private async get(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${API}${path}`, { headers: { 'X-Token': this.token }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status === 429) throw new BankRateLimitError();
    if (!response.ok) throw new Error(`Monobank API responded with HTTP ${response.status}`);
    return response.json();
  }
}

function currencyLabel(code: number): string {
  return ({ 980: 'UAH', 840: 'USD', 978: 'EUR' } as Record<number, string>)[code] ?? String(code);
}

/** ISO 4217 numeric code for the alphabetic one used in settings. */
export function currencyNumericCode(alpha: string): number | undefined {
  return ({ UAH: 980, USD: 840, EUR: 978 } as Record<string, number>)[alpha];
}
