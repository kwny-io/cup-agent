/**
 * 管理后台(#73 配套)—— 用户管理 + 投稿审核。
 *
 * 与看板卡片不同,这是**独立 Tab**(App 里仅 `me.role==='admin'` 可见)。
 * 所有接口走后端 `/admin/*`(会话 + role 双守卫);非管理员调会 403,故本页也只在
 * 管理员身份下才渲染 —— 前端不做安全边界,只做"不给按不动的按钮"的体验。
 *
 * 真实 click(铁律):禁用开关、通过 / 驳回都是真按钮点击。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Chip } from './ui.tsx';
import { sanitizePack } from '../lib/pack-apply.ts';
import type { AdminUser, PersonaPack, SocialApi } from '../data/source.ts';

export function AdminPanel({ social }: { social: SocialApi }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [packs, setPacks] = useState<PersonaPack[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [us, ps] = await Promise.all([social.adminListUsers(), social.adminListPacks('pending')]);
    setUsers(us);
    setPacks(ps.map(sanitizePack));
    setLoaded(true);
  }, [social]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function toggleDisabled(u: AdminUser): Promise<void> {
    setErr(null);
    const out = await social.adminSetDisabled(u.user_id, !u.disabled);
    if (out) {
      setUsers((prev) => prev.map((x) => (x.user_id === out.user_id ? out : x)));
    } else {
      setErr('操作失败(可能不能禁用自己)');
    }
  }

  async function verdict(pack: PersonaPack, approve: boolean): Promise<void> {
    setErr(null);
    const out = await social.adminVerdict(pack.pack_id, approve);
    if (out) {
      setPacks((prev) => prev.filter((p) => p.pack_id !== out.pack_id)); // 审完即离队
    } else {
      setErr('审核失败');
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <h2 className="text-base font-bold text-cup-deep">管理后台</h2>
      {err && (
        <p className="text-xs text-cup-ember" role="alert">
          {err}
        </p>
      )}

      <Card title="用户" hint={`${users.length} 人`}>
        {loaded && users.length === 0 ? (
          <p className="py-4 text-center text-xs text-cup-ink-soft">还没有注册用户</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {users.map((u) => (
              <li
                key={u.user_id}
                className="flex items-center justify-between gap-2 rounded-xl bg-white/70 px-3 py-2 ring-1 ring-cup-veil/50"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm text-cup-ink">{u.nickname || u.email}</span>
                  {u.role === 'admin' && <Chip tone="warm">管理员</Chip>}
                  {u.disabled && <Chip>已禁用</Chip>}
                </div>
                <Button
                  tone="ghost"
                  onClick={() => void toggleDisabled(u)}
                  disabled={u.role === 'admin'}
                >
                  {u.disabled ? '启用' : '禁用'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="投稿审核" hint={`${packs.length} 个待审`}>
        {loaded && packs.length === 0 ? (
          <p className="py-4 text-center text-xs text-cup-ink-soft">没有待审的投稿</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {packs.map((p) => (
              <li key={p.pack_id} className="rounded-2xl bg-white/70 p-3 ring-1 ring-cup-veil/50">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-cup-ink">{p.name}</div>
                    {p.tone && (
                      <div className="truncate text-xs text-cup-ink-soft">语气:{p.tone}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button onClick={() => void verdict(p, true)}>通过</Button>
                    <Button tone="ghost" onClick={() => void verdict(p, false)}>
                      驳回
                    </Button>
                  </div>
                </div>
                {p.lines.length > 0 && (
                  <div className="mt-1 text-xs text-cup-ink-soft">台词 {p.lines.length} 句</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
