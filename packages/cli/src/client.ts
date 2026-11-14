/** HTTP client for the operator API. */

export class Unreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unreachable";
  }
}

export interface ApiResult {
  status: number;
  body: unknown;
}

export interface Api {
  request(method: string, path: string, body?: unknown, opts?: { idempotencyKey?: string }): Promise<ApiResult>;
}

/** Where the CLI keeps the operator's token. The OS keychain by default. */
export interface TokenStore {
  get(url: string): Promise<string | null>;
  set(url: string, token: string): Promise<void>;
  delete(url: string): Promise<void>;
}

export class KeychainTokenStore implements TokenStore {
  private async entry(url: string) {
    const { Entry } = await import("@napi-rs/keyring");
    return new Entry("rovara-orch", url);
  }
  async get(url: string) {
    try {
      return (await this.entry(url)).getPassword() ?? null;
    } catch {
      return null;
    }
  }
  async set(url: string, token: string) {
    (await this.entry(url)).setPassword(token);
  }
  async delete(url: string) {
    try {
      (await this.entry(url)).deletePassword();
    } catch {
      // nothing stored
    }
  }
}

export class MemoryTokenStore implements TokenStore {
  private readonly m = new Map<string, string>();
  async get(url: string) {
    return this.m.get(url) ?? null;
  }
  async set(url: string, token: string) {
    this.m.set(url, token);
  }
  async delete(url: string) {
    this.m.delete(url);
  }
}

export class HttpApi implements Api {
  constructor(
    private readonly baseUrl: string,
    private readonly token: () => Promise<string | null>,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async request(method: string, path: string, body?: unknown, opts: { idempotencyKey?: string } = {}): Promise<ApiResult> {
    const token = await this.token();
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new Unreachable(`cannot reach ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status >= 500) throw new Unreachable(`the orchestrator answered ${res.status}`);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}
