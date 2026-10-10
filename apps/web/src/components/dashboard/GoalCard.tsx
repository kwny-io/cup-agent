/**
 * 每日目标设置入口 —— 看板补齐 HANDOFF §6 第 4 条。
 *
 * 以前只能靠对话里说"把目标改成 2000",没有 UI。这里给一个直接改的口子:
 *   读当前目标(来自 useCupData 的 goal) → 输入 → 校验 → 保存 → 立刻反映。
 *
 * 逻辑(校验/格式化)在 lib/goal.ts,本组件只接 React 状态;
 * 保存走 DataSource.setGoal(云源 PUT /goal,mock 存本地),组件不直接 fetch。
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Card, TextField } from '../ui.tsx';
import { GOAL_MAX, GOAL_MIN, parseGoal } from '../../lib/goal.ts';
import type { GoalResult } from '../../data/source.ts';

export function GoalCard({
  goal,
  onSave,
}: {
  /** 当前目标(实时);打开卡片时作为输入初值 */
  goal: number;
  /** 保存;null = 该数据源不支持写目标(纯模拟器),则禁用输入 */
  onSave: ((goalMl: number) => Promise<GoalResult>) | null;
}) {
  const [input, setInput] = useState(String(goal));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // goal 变化(比如对话里改了 / 后端轮询回灌)时,若用户没在编辑就同步输入框
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setInput(String(goal));
  }, [goal]);

  const disabled = !onSave || busy;

  async function save(): Promise<void> {
    setError(null);
    setSaved(false);
    const p = parseGoal(input);
    if (!p.ok) {
      setError(p.reason);
      return;
    }
    if (!onSave) return;
    if (p.value === goal) {
      setSaved(true); // 没变,不算错,给个"已保存"的安心反馈
      return;
    }
    setBusy(true);
    try {
      const res = await onSave(p.value);
      if (res.ok) {
        setSaved(true);
      } else {
        // 与对话线同款:按原因给不同人话,别一律"失败了"
        setError(
          res.reason === 'offline'
            ? '连不上后端,改不了(离线时用 ?mock=1)'
            : res.reason === 'timeout'
              ? '后端没及时回,再试一次'
              : res.reason === 'invalid'
                ? `目标需在 ${GOAL_MIN}–${GOAL_MAX} ml`
                : '后端拒绝了这次修改',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="每日目标" hint={`范围 ${GOAL_MIN}–${GOAL_MAX} ml`}>
      <form
        className="flex items-center gap-2"
        // 关掉浏览器原生校验,让 lib/goal.ts(有单测)当唯一裁判:空/非整数/越界
        // 都走我们的人话提示,而不是浏览器那句"两个最接近的有效值…"。
        // save() 里 parseGoal 把关,后端仍受自身校验保护。
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          type="number"
          inputMode="numeric"
          min={GOAL_MIN}
          max={GOAL_MAX}
          // min 与 step 必须同基:min=1 配 step=50 会把 1500/2000 这类整数判成
          // "非法值"。目标是任意整数,故 step=1(配 noValidate,校验由 lib/goal.ts 裁决)。
          step={1}
          value={input}
          disabled={disabled}
          aria-label="每日目标(毫升)"
          aria-invalid={error !== null}
          onFocus={() => {
            editing.current = true;
          }}
          onBlur={() => {
            editing.current = false;
          }}
          onChange={(e) => {
            setInput(e.target.value);
            setSaved(false);
            setError(null);
          }}
        />
        <span className="text-xs text-cup-ink-soft">ml</span>
        <Button type="submit" disabled={disabled || input === String(goal)}>
          {busy ? '保存中…' : '保存'}
        </Button>
      </form>
      {error ? (
        <p className="mt-2 text-xs text-cup-ember" role="alert">
          {error}
        </p>
      ) : saved ? (
        <p className="mt-2 text-xs text-cup-aqua" role="status">
          已保存,目标 {goal} ml
        </p>
      ) : !onSave ? (
        <p className="mt-2 text-xs text-cup-ink-soft">当前数据源不支持改目标(连后端 ?cloud=1 或 ?mock=1)</p>
      ) : (
        <p className="mt-2 text-xs text-cup-ink-soft">改完今日进度条与达标线会立刻更新</p>
      )}
    </Card>
  );
}
