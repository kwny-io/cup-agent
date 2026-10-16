/**
 * 养成卡 / 分享卡绘制 —— Canvas 2D(零依赖;铁律:不引图表库、不引 WebGL)。
 *
 * #72「导出养成卡」与 #74「分享卡」共用这套绘制助手:**同一个卡面,两种数据源**
 * (养成卡画自己的性格 + 昵称;#74 分享卡在组队 streak 上再叠队友数)。
 *
 * 布局计算(哪些行、每行文字、卡高多少)抽成**纯函数** `buildCardLines`,可单测;
 * `drawCard` 只负责把它画到 2D context 上 —— 与 lib/mood-history.ts 同一分工思路
 * (逻辑与渲染分离,jsdom 无真 canvas 也能测逻辑)。
 *
 * 配色不写死:走与 UI 一致的暖青体系(见 lib/color.ts),深底 + 亮字,截图好看。
 */
import type { TraitRecord } from '../data/source.ts';
import type { MemoirLine } from './memories.ts';

export interface CardLine {
  /** 角色:标题行放大加粗,副标题略小,正文常规 */
  role: 'title' | 'subtitle' | 'body' | 'stat';
  text: string;
}

export interface CardModel {
  /** 卡面主标题(昵称或"我们的杯子") */
  title: string;
  lines: CardLine[];
  /** 底部小字(生成日期 / 站点名) */
  footnote: string;
}

const DISPOSITION_CN: Record<TraitRecord['disposition'], string> = {
  sulky: '蔫蔫的',
  normal: '平平常常',
  smug: '得意洋洋',
};

/** 0..1 → 百分比整数串 */
function pct(x: number): string {
  return `${Math.round(clamp01(x) * 100)}%`;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * 养成卡模型 —— 一只杯子的"性格档案"(#72)。
 * 数字全部来自后端派生快照(不重算),这里只加工成"要画哪些行"。
 */
export function buildPetCard(traits: TraitRecord, nickname: string, dateLabel: string): CardModel {
  const name = nickname.trim() || '我的杯子';
  return {
    title: name,
    lines: [
      { role: 'subtitle', text: `脾气:${DISPOSITION_CN[traits.disposition]}` },
      { role: 'stat', text: `连续达标  ${traits.streak} 天` },
      { role: 'stat', text: `近一周达标率  ${pct(traits.level)}` },
      { role: 'stat', text: `水温满意度  ${pct(traits.warmth)}` },
      { role: 'stat', text: `续杯规律  ${pct(traits.refill_habit)}` },
    ],
    footnote: `cup-agent · ${dateLabel}`,
  };
}

/**
 * 分享卡模型 —— 组队 streak(#74 + P4.3 带归属)。
 * 只带"共同达标天数 + 成员数",不带任何人的原始饮水曲线(隐私口径同迁移码)。
 * `invite`(P4.3)给定时,底部压一行邀请码 —— 收到卡的人据此打开落地页(免注册)。
 */
export function buildShareCard(
  team: { streak: number; members: number; days: string[] },
  dateLabel: string,
  invite?: string | null,
): CardModel {
  const members = Math.max(0, Math.floor(team.members));
  const title = members >= 2 ? '我们的杯子' : '我的杯子';
  const lines: CardLine[] = [
    { role: 'subtitle', text: members >= 2 ? `${members} 只杯子一起` : '还没组上队' },
    { role: 'stat', text: `组队连续达标  ${Math.max(0, Math.floor(team.streak))} 天` },
  ];
  if (team.days.length > 0) {
    const first = team.days[0]!;
    const last = team.days[team.days.length - 1]!;
    lines.push({ role: 'body', text: `${first} → ${last}` });
  }
  const code = invite?.trim();
  if (code) {
    lines.push({ role: 'body', text: `邀请码  ${code}` });
    lines.push({ role: 'body', text: `打开链接领一只能一起组队的杯子` });
  }
  return { title, lines, footnote: `cup-agent · ${dateLabel}` };
}

export const CARD_W = 480;
export const CARD_H = 320;

/**
 * 回忆录卡模型 —— 把「回忆」的逐日行整成一张长图(与养成卡/分享卡同一皮)。
 * 每天一行(`M月D日 周X · 一句话标题`),行数 = 天数,故卡高随天数增长(cardHeight 会算)。
 * 标题行下再压一行小字:共几天的回忆。
 */
export function buildMemoirCard(lines: MemoirLine[], dateLabel: string): CardModel {
  const body: CardLine[] = [{ role: 'subtitle', text: `共 ${lines.length} 天的回忆` }];
  for (const l of lines) body.push({ role: 'body', text: `${l.label} · ${l.title}` });
  return { title: '我们的回忆录', lines: body, footnote: `cup-agent · 导出于 ${dateLabel}` };
}

/**
 * 把模型画到 2D 上下文的尺寸算出来 —— 卡高随行数走(行多就高一点)。
 * 抽出来可单测(jsdom 的 canvas 是桩,但尺寸计算是纯算术)。
 */
export function cardHeight(model: CardModel): number {
  const lineH = 34;
  return 96 + model.lines.length * lineH + 48;
}

/**
 * 真绘制。context 由调用方给(浏览器里的真 canvas;测试里是桩也不炸)。
 * 不用 ctx.roundRect(jsdom 桩有,但旧浏览器未必)→ 手画圆角矩形。
 */
export function drawCard(ctx: CanvasRenderingContext2D, model: CardModel, w = CARD_W): number {
  const h = cardHeight(model);
  // 背景:深底渐变(与品牌深色 cup-deep 同系)
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#123a44');
  g.addColorStop(1, '#0b242b');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // 圆角描边
  ctx.strokeStyle = 'rgba(147, 220, 198, 0.35)';
  ctx.lineWidth = 2;
  roundRect(ctx, 8, 8, w - 16, h - 16, 20);
  ctx.stroke();

  const padX = 40;
  let y = 72;

  ctx.textBaseline = 'alphabetic';
  // 标题
  ctx.fillStyle = '#eafafd';
  ctx.font = 'bold 34px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(model.title, padX, y);
  y += 46;

  for (const line of model.lines) {
    if (line.role === 'subtitle') {
      ctx.fillStyle = '#93dcc6';
      ctx.font = '20px system-ui, -apple-system, "Segoe UI", sans-serif';
    } else if (line.role === 'stat') {
      ctx.fillStyle = '#f7b57e';
      ctx.font = 'bold 24px system-ui, -apple-system, "Segoe UI", sans-serif';
    } else {
      ctx.fillStyle = '#b8d8dd';
      ctx.font = '18px system-ui, -apple-system, "Segoe UI", sans-serif';
    }
    ctx.fillText(line.text, padX, y);
    y += 34;
  }

  // 底部小字
  ctx.fillStyle = 'rgba(184, 216, 221, 0.6)';
  ctx.font = '14px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(model.footnote, padX, h - 30);

  return h;
}

/** 手画圆角矩形路径(不依赖 ctx.roundRect) */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);

  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * 把已绘制的 canvas 导出成 PNG 下载(**纯浏览器**,不落服务器)。
 * 无 canvas.toBlob(旧环境)时静默失败 —— 导出是增强,不该让页面崩。
 */
export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): void {
  try {
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  } catch {
    /* 环境不支持:忽略 */
  }
}
