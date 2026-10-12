/**
 * 设备一次性 claim code 的**模拟器半**(纯 TS,零依赖)—— 让"假杯子"像真固件一样持有绑定码。
 *
 * 为什么要有这个:可信绑定(pg 阶段 4 三档删除的硬前置)要求**绑定时出示设备端一次性码**
 * ——证明"手上有真设备"。真机由固件 `claim_code_generate`(见 firmware/.../claim_code.c)出码;
 * 模拟器若不发码,整条"设备 → broker → 后端 → 绑定"就断在这里,`--require-claim` 开关永远开不了。
 * 本模块补齐这一环:**与固件同算法**(splitmix64 + Crockford Base32),故同一 seed 两端出同码。
 *
 * 只做**生成**(模拟器是数据源,不需要校验别人的码)—— 生成即已规范化(大写、在字母表内)。
 * 故这里不复刻 `normalizeClaim`(那是服务端/固件收码侧的事,复刻只会多一份漂移源)。
 *
 * 校验侧(服务端 `normalizeClaim` 必须能原样收下本模块产出的码)由 `test/claim.test.ts` 钉形状:
 * 长度恰 8、每字符在 `CLAIM_ALPHABET` 内、且**无 I/L/O/U**。
 */

/** Crockford Base32(恰 32 字符;无易混的 I/L/O/U,索引即编码值)—— 与固件 `CUP_CLAIM_ALPHABET` 逐字一致 */
export const CLAIM_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 码长(字符数)—— 与固件 `CUP_CLAIM_LEN` 一致 */
export const CLAIM_LEN = 8;

const MASK64 = (1n << 64n) - 1n;

/**
 * 由 64 位种子生成一枚码 —— **逐位复刻固件 `claim_code_generate`**:
 * `z = (*state += 0x9E3779B97F4A7C15)`,两次 splitmix64 混淆,再自高位起每 5 bit 取一个索引。
 * 8 字符 × 5 bit = 40 bit 编码空间。
 *
 * 用 `bigint` 而非 `number`:64 位运算超出 JS 双精度整数精度(2^53),`number` 会丢低位、码就错了。
 * @param seed 64 位种子(模拟器用 `--seed` 派生;固件拼两次 esp_random())
 */
export function generateClaim(seed: bigint): string {
  let z = (seed + 0x9e3779b97f4a7c15n) & MASK64; // uint64_t z = (*state += 常量)
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  const bits = (z ^ (z >> 31n)) & MASK64;

  let out = '';
  for (let i = 0; i < CLAIM_LEN; i++) {
    const shift = 64n - 5n * BigInt(i + 1);
    const idx = Number((bits >> shift) & 0x1fn);
    out += CLAIM_ALPHABET[idx];
  }
  return out;
}

/** hello 握手帧(设备上电/连上时发一次)—— 与固件 `mqtt_uplink.c` 的字段集逐字一致。 */
export interface HelloFrame {
  kind: 'hello';
  v: 1;
  cup_id: string;
  device_id: string;
  claim: string;
  issued_at: number;
}

/**
 * 造一枚 hello 帧(带一次性 claim code)。两个出口(WS / MQTT)共用,保证同一设备对前后端
 * 报同一枚码 —— 若各自造码,后端的"同一设备反复 hello"去重会看到两枚不同的码而困惑。
 *
 * @param deviceId 设备 id(杯盖 `lid-*` / 底座 `base-*`);后端 WS 出口无 topic,靠此字段认设备
 * @param cupId    杯子 id(一 cup 一灵魂两具身体,盖与底座共用)
 * @param claim    一次性码(见 `generateClaim`);真机上由固件 NVS 持有并复用
 * @param nowMs    签发时刻(墙钟 ms);后端只当审计字段,判定一律用服务端时钟
 */
export function buildHello(deviceId: string, cupId: string, claim: string, nowMs: number): HelloFrame {
  return { kind: 'hello', v: 1, cup_id: cupId, device_id: deviceId, claim, issued_at: nowMs };
}
