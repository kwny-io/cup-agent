/**
 * 人格档案卡(#72 养成卡写端)—— 导出养成卡 + 迁移码生成 / 导入。
 *
 * 与 MoodHistoryCard(只读半:脾气变化史)配一对:
 *   · 养成卡导出 —— Canvas 2D 画一张 PNG(零依赖,见 lib/card-render.ts);
 *   · 迁移码 —— 「把这只杯子带去别处」的纯本地编解码(见 lib/migrate-code.ts),
 *     **只带派生性格 + 生成日期 + 昵称**,不含聊天文本 / 原始饮水曲线。
 *
 * traits 一律来自后端档案(GET /cups/:id/profile),前端不伪造数值。
 * 导入迁移码只**校验并展示**解出的内容(真正的"应用"要后端落盘,留待后续阶段)。
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Card, TextField } from '../ui.tsx';
import { buildPetCard, cardHeight, CARD_W, drawCard, downloadCanvas } from '../../lib/card-render.ts';
import { createdAtLabel, decodeMigrateCode, encodeMigrateCode } from '../../lib/migrate-code.ts';
import type { SocialApi } from '../../data/source.ts';
import type { TraitRecord } from '../../data/source.ts';

export function ProfileCard({ social, enabled }: { social: SocialApi | null; enabled: boolean }) {
  const [traits, setTraits] = useState<TraitRecord | null>(null);
  const [nickname, setNickname] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState('');
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!social) return;
    let alive = true;
    void social.getProfile().then((p) => {
      if (!alive || !p) return;
      setTraits(p.traits);
      setNickname(p.nickname);
      setInput(p.nickname);
    });
    return () => {
      alive = false;
    };
  }, [social]);

  if (!enabled || !social) {
    return (
      <Card title="人格档案" hint="需连后端">
        <p className="py-4 text-center text-xs text-cup-ink-soft">
          养成卡与迁移码要后端的人格档案(?cloud=1)
        </p>
      </Card>
    );
  }

  async function saveNickname(): Promise<void> {
    if (!social) return;
    setError(null);
    setBusy(true);
    try {
      const p = await social.saveProfile(input.trim());
      if (p) {
        setNickname(p.nickname);
        setTraits(p.traits); // 后端现算的 traits,以后端为准
      } else {
        setError('保存失败(可能未登录或后端拒绝)');
      }
    } finally {
      setBusy(false);
    }
  }

  function exportCard(): void {
    if (!traits) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const model = buildPetCard(traits, nickname, createdAtLabel(traits.updated_at));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = CARD_W;
    canvas.height = cardHeight(model);
    drawCard(ctx, model, CARD_W);
    downloadCanvas(canvas, `cup-card-${createdAtLabel(traits.updated_at)}.png`);
  }

  function makeCode(): void {
    if (!traits) return;
    setCode(encodeMigrateCode(traits, nickname));
    setImportMsg(null);
  }

  function doImport(): void {
    const dec = decodeMigrateCode(codeInput);
    if (!dec.ok) {
      setImportMsg({ ok: false, text: dec.error });
      return;
    }
    const p = dec.payload;
    setImportMsg({
      ok: true,
      text: `解出:${p.nickname || '(无昵称)'} · ${dispositionCn(p.traits.disposition)} · 生成于 ${createdAtLabel(p.createdAt)}`,
    });
  }

  return (
    <Card title="人格档案" hint={nickname || '未命名'}>
      {!traits ? (
        <p className="py-6 text-center text-xs text-cup-ink-soft">
          还没有档案 —— 先登录,杯子喝几天水后端就会算出性格
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Trait label="脾气" value={dispositionCn(traits.disposition)} />
            <Trait label="连续达标" value={`${traits.streak} 天`} />
            <Trait label="达标率" value={`${Math.round(traits.level * 100)}%`} />
            <Trait label="水温满意度" value={`${Math.round(traits.warmth * 100)}%`} />
          </div>

          {/* 昵称编辑 */}
          <form
            className="flex items-center gap-2"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void saveNickname();
            }}
          >
            <TextField
              placeholder="给杯子起个名"
              aria-label="杯子昵称"
              value={input}
              disabled={busy}
              onChange={(e) => {
                setInput(e.target.value);
                setError(null);
              }}
            />
            <Button type="submit" disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </Button>
          </form>

          <div className="flex flex-wrap items-center gap-2">
            <Button tone="ghost" onClick={exportCard}>
              导出养成卡
            </Button>
            <Button tone="ghost" onClick={makeCode}>
              生成迁移码
            </Button>
          </div>

          {error && (
            <p className="text-xs text-cup-ember" role="alert">
              {error}
            </p>
          )}

          {code && (
            <div className="rounded-2xl bg-cup-foam/60 p-3">
              <p className="mb-1 text-xs text-cup-ink-soft">迁移码(只带派生性格,可粘贴到别的设备)</p>
              <code className="block break-all text-xs text-cup-deep" data-testid="migrate-code">
                {code}
              </code>
            </div>
          )}

          {/* 导入 */}
          <div className="flex flex-col gap-2 border-t border-cup-veil/60 pt-3">
            <span className="text-xs text-cup-ink-soft">导入迁移码</span>
            <div className="flex items-center gap-2">
              <TextField
                placeholder="粘贴迁移码 CUP1-…"
                aria-label="迁移码"
                value={codeInput}
                onChange={(e) => {
                  setCodeInput(e.target.value);
                  setImportMsg(null);
                }}
              />
              <Button tone="ghost" onClick={doImport}>
                解析
              </Button>
            </div>
            {importMsg && (
              <p className={`text-xs ${importMsg.ok ? 'text-cup-aqua' : 'text-cup-ember'}`} role="status">
                {importMsg.text}
              </p>
            )}
          </div>
        </div>
      )}

      {/* 离屏画布:导出时的绘制目标(不显示在页面上) */}
      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
    </Card>
  );
}

function Trait({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/70 px-2 py-1.5 ring-1 ring-cup-veil/50">
      <div className="text-[10px] text-cup-ink-soft">{label}</div>
      <div className="font-semibold text-cup-deep">{value}</div>
    </div>
  );
}

function dispositionCn(d: TraitRecord['disposition']): string {
  return d === 'smug' ? '得意洋洋' : d === 'sulky' ? '蔫蔫的' : '平平常常';
}
