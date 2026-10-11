/** 看板通用小组件:卡片 / 数字 / 标签 / 按钮 / 输入框。都走主题 token,不写死颜色。 */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react';

export function Card({
  title,
  hint,
  action,
  children,
  className = '',
}: {
  title?: string;
  hint?: string;
  /** 标题行右侧的自定义节点(优先于 hint,如徽标) */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-cup bg-white/80 p-4 shadow-sm ring-1 ring-cup-veil/60 backdrop-blur ${className}`}
    >
      {title && (
        <header className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-cup-ink">{title}</h2>
          {action ?? (hint && <span className="text-xs text-cup-ink-soft">{hint}</span>)}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  unit,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-cup-ink-soft">{label}</span>
      <span className="flex items-baseline gap-1">
        <span
          className={`text-2xl font-bold tabular-nums ${
            accent ? 'text-cup-ember' : 'text-cup-deep'
          }`}
        >
          {value}
        </span>
        {unit && <span className="text-xs text-cup-ink-soft">{unit}</span>}
      </span>
    </div>
  );
}

export function Chip({ children, tone = 'cool' }: { children: ReactNode; tone?: 'cool' | 'warm' }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        tone === 'warm'
          ? 'bg-cup-warm/20 text-cup-ember'
          : 'bg-cup-aqua/15 text-cup-deep'
      }`}
    >
      {children}
    </span>
  );
}

export function Bar({ value }: { value: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-cup-foam">
      <div
        className="h-full rounded-full bg-gradient-to-r from-cup-aqua to-cup-warm transition-[width] duration-500"
        style={{ width: `${Math.round(value * 100)}%` }}
      />
    </div>
  );
}

/** 主次两级:tone='deep' 实心主色,tone='ghost' 描边轻量 */
export function Button({
  children,
  tone = 'deep',
  className = '',
  ...rest
}: {
  children: ReactNode;
  tone?: 'deep' | 'ghost';
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const base =
    'inline-flex items-center justify-center gap-1 rounded-full px-3.5 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
  const skin =
    tone === 'deep'
      ? 'bg-cup-deep text-cup-mist hover:bg-cup-aqua'
      : 'text-cup-deep ring-1 ring-cup-veil hover:bg-cup-foam';
  return (
    <button className={`${base} ${skin} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function TextField({
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`min-w-0 flex-1 rounded-full bg-white/70 px-3.5 py-1.5 text-sm text-cup-ink outline-none ring-1 ring-cup-veil placeholder:text-cup-ink-soft/70 focus:ring-cup-aqua ${className}`}
      {...rest}
    />
  );
}

/** 多行输入 —— 语气 / 台词这类自由文本用(#73 投稿表单)。圆角方框,与 TextField 同皮。 */
export function TextArea({
  className = '',
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`min-w-0 w-full rounded-2xl bg-white/70 px-3.5 py-2 text-sm text-cup-ink outline-none ring-1 ring-cup-veil placeholder:text-cup-ink-soft/70 focus:ring-cup-aqua ${className}`}
      {...rest}
    />
  );
}
