/**
 * 硬件脸 · 眼睛状态机(纯 C,零 IDF 依赖)—— 可宿主单测。
 *
 * ── 这是"双形体人格"的硬件那半边 ────────────────────────────────
 * 创意备忘《双形体人格与交互创意》主张 **一个灵魂、两个身体**:
 *   · 屏幕形象 = 卡通杯(mood.ts),详细视图;
 *   · 硬件脸   = 杯盖双眼(Memory LCD 128×128 单色),默认态/情感。
 * 同一份人格状态 + 短时 mood 驱动,靠**交接协议**(谁持脸)无损转移。
 * 屏幕那半已落在 `apps/web`(窗口 A);**本文件把同一套眼睛词汇表搬到杯盖端**。
 *
 * ── 为什么是"纯 C + 与 web 逐字同构"─────────────────────────────
 * 备忘 §4.3 明说"在拿到屏之前就把动画调好":真板到货前,把状态决议、优先级、
 * 各态姿态、交接闭眼包络这些**最容易错**的部分,在 PC 上跑单测钉死。
 * 逻辑与 `apps/web/src/lib/eyes.ts` **同源同口径**(十二态、同一优先级、同一阈值),
 * 差别只在语言与"无浮点帧循环依赖 DOM"。
 *
 * ── 铁律(备忘 §4.1)────────────────────────────────────────────
 * **只传状态,绝不传像素**:状态机在杯盖本地跑;下行 `face` 指令只给
 * emotion/intensity/gaze 几个字节,由这里程序化展开成眼型(见 eye_render.c)。
 *
 * ── 与 eyes.ts 的刻意差异(均为嵌入式约束,非语义变更)──────────
 *   1. 时间不自己走:调用方每帧给 `dt`(与 eyes.ts 的 rAF 固定步长累加同构),
 *      真机上由主循环定时器喂;宿主单测里由脚本喂。
 *   2. "未知值"用 NaN(pct/temp)与 -1(枚举索引)表示,替代 TS 的 null;
 *      构造输入请用 `EYE_INPUTS_DEFAULT()` 再覆盖字段(默认全部"未知")。
 *   3. 浮点用 float(单精度),真板省算力;阈值都是量级判断,精度无碍。
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <math.h>

#ifdef __cplusplus
extern "C" {
#endif

// ── 十二态(备忘 §3 词汇表,编号与备忘一致)────────────────────────
typedef enum {
    EYE_NAP = 0,      /**< 1 打盹:两条横线,极缓呼吸 */
    EYE_SLEEP,        /**< 2 睡觉(闭眼):交接给屏幕 / 夜间 */
    EYE_IDLE,         /**< 3 睁眼待机 */
    EYE_BLINK,        /**< 4 眨眼(瞬态) */
    EYE_LOOK,         /**< 5 看主人:瞳孔上看 */
    EYE_STARTLED,     /**< 6 摇杯受惊:瞳孔放大 + 反向摆动 */
    EYE_TILT,         /**< 7 倾斜跟随:瞳孔随重力偏 */
    EYE_CONTENT,      /**< 8 喝一口满足:弧眼 + 慢眨 */
    EYE_SULKY,        /**< 9 欠水蔫:上眼睑下垂,视线向下 */
    EYE_SMUG,         /**< 10 得意:微眯 */
    EYE_WEAK,         /**< 11 低电虚弱:半闭 + 瞳孔缩小 + 三次慢眨 */
    EYE_FORGOTTEN,    /**< 12 被遗忘(抗议):转开视线,不看你 */
} eye_state_t;

/** 长期性格底色(M4 后端战报给);与 web `EyeDisposition` 同义三态。 */
typedef enum {
    EYE_DISPO_SULKY = 0,
    EYE_DISPO_NORMAL,
    EYE_DISPO_SMUG,
} eye_disposition_t;

/** 谁持有脸(交接协议 §1.3);EYE_OWNER_SCREEN = 前端接管 → 盖子闭眼。 */
typedef enum {
    EYE_OWNER_LID = 0,
    EYE_OWNER_SCREEN,
} eye_owner_t;

/** "未提供"的电池百分比(替代 TS null)。 */
#define EYE_PCT_NONE (-1)
/** 契约 motion 未知时的取值(替代 TS null);否则用契约 motion_state 的枚举序。 */
#define EYE_MOTION_NONE (-1)

/** 输入:`EYE_INPUTS_DEFAULT()` 起手,再逐字段覆盖。 */
typedef struct {
    eye_owner_t owner;      /**< 谁持脸(交接最高优先) */
    int motion;             /**< 契约 motion 枚举序;EYE_MOTION_NONE = 无遥测 */
    float tilt_deg;         /**< 倾角(度) */
    float tilt_dir;         /**< 方向(度) */
    int battery_pct;        /**< 0..100;EYE_PCT_NONE = 未知 */
    bool charging;
    float level01;          /**< 水位比例 0..1(加分项:水低 → 眼神耷拉) */
    float temp_c;           /**< 水温℃;NAN = 未知(加分项:水烫 → 眯眼,渲染器另加蒸汽纹) */
    eye_disposition_t disposition; /**< 长期性格底色 */
    float idle_sec;         /**< 距上次**事件**的秒数(打盹触发) */
    float forgot_sec;       /**< 距上次**前端连接/用**的秒数(被遗忘触发) */
} eye_inputs_t;

/** 一帧姿态 —— 渲染器唯一输入;全是归一化量,与像素无关(屏幕端/预览端可任意缩放)。 */
typedef struct {
    eye_state_t state;
    float openness;    /**< 眼睑开度 0..1(0=全闭,1=常态,>1=瞪大) */
    float gaze_x;      /**< 瞳孔水平偏移 -1..1 */
    float gaze_y;      /**< 瞳孔竖直偏移 -1..1 */
    float pupil_scale; /**< 瞳孔缩放(1=常态) */
    float rotate;      /**< 整眼旋转(rad,随液面/重力) */
    float drop_y;      /**< 竖直位移(-1..1;正=下垂) */
    bool  arc;         /**< 笑眼弧(content) */
    float squint;      /**< 上眼睑额外下压 0..1(smug/蔫的眯眼 + 交接) */
    bool  hot;         /**< 水烫(加分项):叠加蒸汽纹 */
    float steam_phase; /**< 蒸汽上升相位(rad);hot 时由时钟推进 */
} eye_pose_t;

/** 状态机实例(调用方持有;eyes_init 起手)。字段私有,勿直接读写。 */
typedef struct {
    float clock;
    eye_state_t state;
    float blink_in;        /**< 距下次眨的倒计时(秒) */
    float blink_t;         /**< <0 = 不在眨 */
    float blink_dur;       /**< 本次眨的时长(常态 BLINK_S,低电慢眨 WEAK_BLINK_S) */
    float startled_t;
    float content_t;
    float wobble;
    float drift;
    bool  was_shaking;
    float seed;
    bool  hot_state;
    float steam_phase;
    float handoff;         /**< 交接闭眼包络 0..1(0=睁,1=闭) */
    int   weak_blinks;
    float weak_blink_in;
    float weak_rest_t;
    int   expr_state;      /**< 一次性强制表情;-1 = 无 */
    float expr_t;
    eye_pose_t pose;
} eye_eyes_t;

/** 阈值(备忘 §3 触发栏;均为 [待实测] 的工程默认,与 eyes.ts 同值)。 */
#define EYE_BLINK_MIN_S        2.0f
#define EYE_BLINK_MAX_S        6.0f
#define EYE_BLINK_S            0.18f
#define EYE_NAP_AFTER_S        (30.0f * 60.0f)
#define EYE_FORGOT_AFTER_S     (2.0f * 60.0f * 60.0f)
#define EYE_LOW_BATTERY_PCT    20
#define EYE_CONTENT_S          3.5f
#define EYE_STARTLED_S         1.6f
#define EYE_TILT_DEG           20.0f
#define EYE_LOW_LEVEL          0.15f
#define EYE_HOT_TEMP_C         55.0f
#define EYE_HOT_SQUINT         0.35f
#define EYE_HANDOFF_S          0.4f
#define EYE_WEAK_BLINK_S       0.7f
#define EYE_WEAK_BLINK_GAP_S   1.3f
#define EYE_WEAK_BLINK_COUNT   3
#define EYE_WEAK_CYCLE_REST_S  6.0f

/** 把 inputs 全字段置"未知/中性"(NaN 温度、-1 指数、非充电、level=1、NORMAL 性格)。 */
eye_inputs_t eye_inputs_default(void);

/** 起手:状态 idle、姿态 idle、眨眼计时随机种子置 1。 */
void eyes_init(eye_eyes_t *e);

/** 外部事件:喝了一口(契约 drink 事件 / 水位掉档)。 */
void eyes_note_drink(eye_eyes_t *e);
/** 外部事件:受惊(契约 shake / 冲击)。通常 step 的 motion 边沿会自动触发,这是手动口。 */
void eyes_note_startled(eye_eyes_t *e);
/** 外部事件:**强制一次表情**(手势语法 §5.1 #1)。优先级仅次于交接;到点自落。 */
void eyes_note_expression(eye_eyes_t *e, eye_state_t state, float seconds);

/**
 * 每帧按固定步长推进,产出并缓存本帧姿态。
 * @param e   实例
 * @param dt  时间步(秒);真板由定时器给,宿主编排由脚本给
 * @param inp 本帧输入
 * @return 本帧姿态的只读指针(指向 e->pose,下次 step 前有效)
 */
const eye_pose_t *eyes_step(eye_eyes_t *e, float dt, const eye_inputs_t *inp);

/** 当前状态名(日志/调试用;永不返回 NULL)。 */
const char *eye_state_str(eye_state_t s);

#ifdef __cplusplus
}
#endif
