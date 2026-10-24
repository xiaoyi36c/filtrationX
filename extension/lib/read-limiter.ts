// 轻量读限速器 (M3)。
//
// GraphQL 读接口（UserTweets）消耗用户登录会话的请求配额，与写操作
// （mute/block，x-action 的 1.2s 预算 + 跨 tab 锁）不同源，因此单独一个
// 极保守的串行限速：
//
//   - 全局串行（一条链），两次请求之间至少间隔 minIntervalMs；
//   - 命中 429 进入冷却（默认 10 分钟），冷却期内所有调用直接失败；
//   - 串行而不是并发窗口：hover 触发本来就该一次一个，简单即正确。

export class ReadLimiter {
  private lastStart = 0;
  private coolingUntil = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly minIntervalMs = 400,
    private readonly cooldownMs = 600_000,
  ) {}

  get cooling(): boolean {
    return Date.now() < this.coolingUntil;
  }

  get waitMs(): number {
    if (this.cooling) return this.coolingUntil - Date.now();
    return Math.max(0, this.lastStart + this.minIntervalMs - Date.now());
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain
      .then(() => this.gate())
      .then(task)
      .catch((e: unknown) => {
        const status =
          e instanceof HttpError ? e.status : (e as { status?: number } | null)?.status;
        if (status === 429) this.coolingUntil = Date.now() + this.cooldownMs;
        throw e;
      });
    this.chain = next.catch(() => undefined);
    return next as Promise<T>;
  }

  cooldownNow(): void {
    this.coolingUntil = Date.now() + this.cooldownMs;
  }

  private async gate(): Promise<void> {
    if (this.cooling) {
      const e = new Error("rate_limited") as Error & { status?: number };
      e.status = 429;
      throw e;
    }
    const wait = this.waitMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastStart = Date.now();
  }
}

/** 带状态码的 HTTP 错误——限速器据此识别 429。 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}