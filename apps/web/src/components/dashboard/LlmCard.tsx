/**
 * 接入我的模型卡(BYOK)—— 用户给自己那只杯配自己的 provider / model / key。
 *
 * 与设备写端点(目标 / 配置走 x-api-key)**不同**:这是**账号行为** ——
 * 后端 `GET|PUT|DELETE /cups/:id/llm` 走**会话闸**(Bearer,同 /social/*)+ 归属校验,
 * 只有已绑这只杯的用户能读写(非主人 403)。故要登录。
 *
 * 安全口径:
 *   · key 只**单向**进后端(`CupLlmService` 加密后落库),后端出口永不含 key ——
 *     本卡也只在提交那一刻持有输入,提交后**立即清空** state,不回显、不落 sessionStorage;
 *   · 出口视图只有 `has_key` 布尔,据此显示"已接入 / 未接入"。
 *
 * 真实 click 提交(铁律),busy / error / saved 三态照 GoalCard / ProfileCard。
 */
import { useEffect, useState } from 'react';
import { Button, Card, TextField } from '../ui.tsx';
import type { CupLlmProvider, CupLlmPublic, PublicUser, SocialApi } from '../../data/source.ts';

/** provider 默认对话模型 —— 与后端 DEFAULT_CHAT_MODEL 逐字一致(冻结握手) */
const DEFAULT_MODEL: Record<CupLlmProvider, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o-mini',
};

const PROVIDER_LABEL: Record<CupLlmProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

export function LlmCard({
  social,
  enabled,
  user,
}: {
  social: SocialApi | null;
  enabled: boolean;
  user: PublicUser | null;
}) {
  const [current, setCurrent] = useState<CupLlmPublic | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [provider, setProvider] = useState<CupLlmProvider>('anthropic');
  const [model, setModel] = useState(DEFAULT_MODEL.anthropic);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!social || !user) {
      setLoaded(true);
      return;
    }
    let alive = true;
    void social.getCupLlm().then((cfg) => {
      if (!alive) return;
      setCurrent(cfg);
      if (cfg) {
        setProvider(cfg.provider);
        setModel(cfg.model);
        setBaseUrl(cfg.base_url ?? '');
        setKey('');
      }
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [social, user]);

  if (!enabled || !social) {
    return (
      <Card title="接入我的模型" hint="需连后端">
        <p className="py-4 text-center text-xs text-cup-ink-soft">
          接自己的模型要连后端(?cloud=1)
        </p>
      </Card>
    );
  }

  if (!user) {
    return (
      <Card title="接入我的模型" hint="未登录">
        <p className="py-4 text-center text-xs text-cup-ink-soft">
          登录后,可以给自己那只杯接上你自己的模型
        </p>
      </Card>
    );
  }

  function pickProvider(p: CupLlmProvider): void {
    setProvider(p);
    setError(null);
    setSaved(false);
    // 当前模型还是旧 provider 的默认值(或空)→ 换成新 provider 的默认,免得留个不搭的模型名
    setModel((m) => (m === '' || m === DEFAULT_MODEL.anthropic || m === DEFAULT_MODEL.openai ? DEFAULT_MODEL[p] : m));
  }

  async function save(): Promise<void> {
    if (!social) return;
    const m = model.trim();
    if (m === '') {
      setError('模型名不能为空');
      return;
    }
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const cfg = await social.saveCupLlm({
        provider,
        model: m,
        ...(baseUrl.trim() !== '' ? { base_url: baseUrl.trim() } : {}),
        ...(key.trim() !== '' ? { key: key.trim() } : {}),
      });
      if (cfg) {
        setCurrent(cfg);
        setKey(''); // 提交后立即清空,不在前端留 key
        setSaved(true);
      } else {
        setError('保存失败(可能未登录,或这只杯不属于你)');
      }
    } finally {
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    if (!social) return;
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const ok = await social.clearCupLlm();
      if (ok) {
        setCurrent(null);
        setProvider('anthropic');
        setModel(DEFAULT_MODEL.anthropic);
        setKey('');
        setBaseUrl('');
      } else {
        setError('取消接入失败,请重试');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="接入我的模型"
      hint={current ? `${PROVIDER_LABEL[current.provider]} · ${current.model}` : '未接入'}
    >
      {!loaded ? (
        <p className="py-4 text-center text-xs text-cup-ink-soft">读取中…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-cup-ink-soft">
            接上你自己的模型后,杯子回答你的话就用它;不接则用服务器默认模型。
            {current?.has_key ? '密钥已保存 —— 留空即沿用,不会回显。' : ''}
          </p>

          {/* provider 选择:两个按钮(与看板 pill 风格一致;真实 click 可测) */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-cup-ink-soft">厂商</span>
            <div className="flex gap-1.5" role="group" aria-label="模型厂商">
              {(Object.keys(DEFAULT_MODEL) as CupLlmProvider[]).map((p) => (
                <Button
                  key={p}
                  tone={provider === p ? 'deep' : 'ghost'}
                  aria-pressed={provider === p}
                  disabled={busy}
                  onClick={() => pickProvider(p)}
                >
                  {PROVIDER_LABEL[p]}
                </Button>
              ))}
            </div>
          </div>

          <form
            className="flex flex-col gap-2"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-xs text-cup-ink-soft">模型</span>
              <TextField
                aria-label="模型名"
                placeholder={DEFAULT_MODEL[provider]}
                value={model}
                disabled={busy}
                onChange={(e) => {
                  setModel(e.target.value);
                  setSaved(false);
                  setError(null);
                }}
              />
            </label>

            <label className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-xs text-cup-ink-soft">密钥</span>
              <TextField
                type="password"
                aria-label="模型密钥"
                autoComplete="off"
                placeholder={current?.has_key ? '已保存(留空不改)' : '你的 API key'}
                value={key}
                disabled={busy}
                onChange={(e) => {
                  setKey(e.target.value);
                  setSaved(false);
                  setError(null);
                }}
              />
            </label>

            <label className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-xs text-cup-ink-soft">端点</span>
              <TextField
                aria-label="自定义端点"
                placeholder="可留空(用厂商默认)"
                value={baseUrl}
                disabled={busy}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  setSaved(false);
                  setError(null);
                }}
              />
            </label>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button type="submit" disabled={busy}>
                {busy ? '保存中…' : current ? '更新' : '接入'}
              </Button>
              {current && (
                <Button type="button" tone="ghost" disabled={busy} onClick={() => void clear()}>
                  取消接入
                </Button>
              )}
              {saved && (
                <span className="text-xs text-cup-aqua" role="status">
                  已保存
                </span>
              )}
            </div>
          </form>

          {error && (
            <p className="text-xs text-cup-ember" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
