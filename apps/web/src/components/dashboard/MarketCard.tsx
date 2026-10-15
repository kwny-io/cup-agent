/**
 * 人格市场卡(#73 UGC)—— 浏览已上架包 + 投稿 + 订阅。
 *
 * 安全口径(与后端 normalizePack / lib/pack-apply.ts 呼应):
 *   · 远端包**只带数值 + 文本,不执行代码**;
 *   · 展示前先过 sanitizePack(前端那道) —— 越界值钳到语义区间、未知键丢弃、长文本截断;
 *   · 投稿草稿发后端前先过 sanitizeDraft(预检,后端仍会把关)。
 *
 * 投稿要登录(后端写端点要会话);未登录时只读浏览。
 * 真实 click 提交(铁律)。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Chip, TextArea, TextField } from '../ui.tsx';
import { describeThresholds, describeWave, sanitizePack, sanitizeDraft } from '../../lib/pack-apply.ts';
import type { PublicUser, SocialApi } from '../../data/source.ts';
import type { PersonaPack } from '../../data/source.ts';

export function MarketCard({
  social,
  enabled,
  user,
}: {
  social: SocialApi | null;
  enabled: boolean;
  user: PublicUser | null;
}) {
  const [packs, setPacks] = useState<PersonaPack[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [subscribed, setSubscribed] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    if (!social) return;
    const list = await social.listPacks();
    setPacks(list.map(sanitizePack));
    // 登录后回读「我订过哪些」——卡片加载即正确显示已订阅(不是点过才算)。
    const mine = user ? await social.listSubscriptions() : [];
    setSubscribed(new Set(mine));
    setLoaded(true);
  }, [social, user]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!enabled || !social) {
    return (
      <Card title="人格市场" hint="需连后端">
        <p className="py-4 text-center text-xs text-cup-ink-soft">
          人格市场要连后端(?cloud=1)
        </p>
      </Card>
    );
  }

  async function subscribe(packId: string): Promise<void> {
    if (!social) return;
    const ok = await social.subscribePack(packId);
    if (ok) setSubscribed((prev) => new Set(prev).add(packId));
  }

  return (
    <Card title="人格市场" hint={`${packs.length} 个已上架`}>
      <div className="flex flex-col gap-3">
        {loaded && packs.length === 0 ? (
          <p className="py-6 text-center text-xs text-cup-ink-soft">
            还没有上架的人格包 —— 投稿一个,等管理员审核通过就出现在这里
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {packs.map((p) => (
              <PackRow
                key={p.pack_id}
                pack={p}
                subscribed={subscribed.has(p.pack_id)}
                onSubscribe={() => void subscribe(p.pack_id)}
              />
            ))}
          </ul>
        )}

        {user ? (
          <SubmitForm social={social} onSubmitted={reload} />
        ) : (
          <p className="border-t border-cup-veil/60 pt-3 text-xs text-cup-ink-soft">
            登录后才能投稿人格包
          </p>
        )}
      </div>
    </Card>
  );
}

function PackRow({
  pack,
  subscribed,
  onSubscribe,
}: {
  pack: PersonaPack;
  subscribed: boolean;
  onSubscribe: () => void;
}) {
  const th = describeThresholds(pack.thresholds);
  const wv = describeWave(pack.wave);
  return (
    <li className="rounded-2xl bg-white/70 p-3 ring-1 ring-cup-veil/50">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-cup-ink">{pack.name}</div>
          {pack.tone && <div className="truncate text-xs text-cup-ink-soft">语气:{pack.tone}</div>}
        </div>
        <Button tone={subscribed ? 'ghost' : 'deep'} disabled={subscribed} onClick={onSubscribe}>
          {subscribed ? '已订阅' : '订阅'}
        </Button>
      </div>
      {(th.length > 0 || wv.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {th.map((r) => (
            <Chip key={r.key}>
              {r.key} {r.value}
            </Chip>
          ))}
          {wv.map((r) => (
            <Chip key={r.key} tone="warm">
              波 {r.key} {r.value}
            </Chip>
          ))}
        </div>
      )}
      {pack.lines.length > 0 && (
        <div className="mt-2 text-xs text-cup-ink-soft">
          台词 {pack.lines.length} 句:{pack.lines.slice(0, 3).join(' / ')}
          {pack.lines.length > 3 ? ' …' : ''}
        </div>
      )}
    </li>
  );
}

function SubmitForm({
  social,
  onSubmitted,
}: {
  social: SocialApi;
  onSubmitted: () => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [tone, setTone] = useState('');
  const [linesText, setLinesText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(): Promise<void> {
    setMsg(null);
    if (!name.trim()) {
      setMsg({ ok: false, text: '包名不能为空' });
      return;
    }
    const lines = linesText
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const draft = sanitizeDraft({ name, tone, thresholds: {}, wave: {}, lines });
    setBusy(true);
    try {
      const out = await social.submitPack(draft);
      if (out) {
        setMsg({ ok: true, text: '已投稿,等管理员审核' });
        setName('');
        setTone('');
        setLinesText('');
        await onSubmitted();
      } else {
        setMsg({ ok: false, text: '投稿失败(可能未登录或后端拒绝)' });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2 border-t border-cup-veil/60 pt-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <span className="text-xs font-medium text-cup-ink-soft">投稿一个人格包</span>
      <TextField
        placeholder="包名,如「温柔早八」"
        aria-label="包名"
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
      />
      <TextField
        placeholder="语气(可留空)"
        aria-label="语气"
        value={tone}
        disabled={busy}
        onChange={(e) => setTone(e.target.value)}
      />
      <TextArea
        placeholder="台词库,一行一句(可留空)"
        aria-label="台词库"
        rows={3}
        value={linesText}
        disabled={busy}
        onChange={(e) => setLinesText(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? '投稿中…' : '投稿'}
        </Button>
        {msg && (
          <span className={`text-xs ${msg.ok ? 'text-cup-aqua' : 'text-cup-ember'}`} role="status">
            {msg.text}
          </span>
        )}
      </div>
    </form>
  );
}
