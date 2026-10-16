/**
 * 分享卡邀请链接的**纯逻辑**(可单测,不碰 React / DOM)。
 *
 * 链接形状:`<origin><path>?cloud=<apiBase>&invite=<code>` ——
 * **必须保留**邀请人 URL 里的 `?cloud=`,否则落地页不知道该连哪个后端(previewInvite 打不到)。
 * 故这里不是"拼个官网地址",而是"在当前页 URL 上并入 invite=code"。
 */

/**
 * 从当前页的 origin / pathname / search 拼一条带 `invite` 的分享链接。
 * @param code 邀请码(空串 / 空白 → 原样返回当前 URL,不塞空 invite)
 */
export function buildInviteLink(code: string, search: string, origin: string, pathname: string): string {
  const c = code.trim();
  const p = new URLSearchParams(search);
  if (c === '') {
    const qs = p.toString();
    return `${origin}${pathname}${qs === '' ? '' : `?${qs}`}`;
  }
  p.set('invite', c);
  return `${origin}${pathname}?${p.toString()}`;
}

/** 从 search 里取 invite 码(去空白;空 → null)。 */
export function inviteCodeFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get('invite');
  return v !== null && v.trim() !== '' ? v.trim() : null;
}
