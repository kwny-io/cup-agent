/**
 * 带超时的写请求(POST/PUT)—— 从 CloudSource 里抽出来,好单测(见 test/http.test.ts)。
 *
 * 为什么要硬超时:后端进程卡住 / 网关挂起时 fetch 会一直 pending,
 * 若不超时,UI 会被永久钉在"等待中"(这正是工程评审里最要命的一条)。
 * AbortController 到点 abort,fetch 随即 reject 成 AbortError → 归为 timeout。
 *
 * fetch 作为**参数注入**:测试可以塞一个"永不回包、但响应 abort"的假实现,
 * 在没有真实网络的情况下把超时分支跑到。
 */
export type HttpOutcome<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'offline' }
  | { kind: 'timeout' }
  | { kind: 'error' };

/**
 * 带 JSON 体与超时的写请求(POST / PUT 共用)。method 由薄壳决定,
 * 结果分类(postJson 最早定下)不变 —— offline / timeout / error 可区分。
 *
 * extraHeaders 排在 fetchImpl **之后**:fetchImpl 是由测试注入的位置参数,
 * 挪动会让既有测试传入的假 fetch 错位,故新增的 header 只能续在末尾。
 */
export async function jsonRequest<T>(
  method: 'POST' | 'PUT',
  url: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  extraHeaders?: Record<string, string>,
): Promise<HttpOutcome<T>> {
  const ac = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl(url, {
      method,
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!r.ok) return { kind: 'error' };
    return { kind: 'ok', data: (await r.json()) as T };
  } catch (e) {
    // abort 触发的是 AbortError;其余(网络断了 / 后端没起)算 offline
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    return { kind: aborted ? 'timeout' : 'offline' };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** POST JSON(前 4 参签名与旧版逐字一致,调用处零改动;仅续加 extraHeaders) */
export function postJson<T>(
  url: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  extraHeaders?: Record<string, string>,
): Promise<HttpOutcome<T>> {
  return jsonRequest<T>('POST', url, body, timeoutMs, fetchImpl, extraHeaders);
}

/** PUT JSON —— 改每日目标(PUT /cups/:id/goal)用 */
export function putJson<T>(
  url: string,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
  extraHeaders?: Record<string, string>,
): Promise<HttpOutcome<T>> {
  return jsonRequest<T>('PUT', url, body, timeoutMs, fetchImpl, extraHeaders);
}
