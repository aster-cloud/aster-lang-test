/**
 * 确定性 zip 写出（包格式 v1 夹具用），以及畸形 zip 所需的「按原样写入头部」开关。
 *
 * ★为什么不用 zlib.deflateRawSync：Node 捆绑的 zlib（Chromium 分支）在不同 CPU / 版本上可能产出不同的压缩字节，
 * `build-package-fixtures.mjs --check` 要求逐字节复现，换一台 CI 机器就可能误报。因此这里只产出两种手写、
 * 与 zlib 无关的 deflate 流：
 *   - deflateStored：全部用存储块（BTYPE=00），读取方仍须走 inflate 路径；
 *   - deflateZeros：单个动态 Huffman 块编码 n 个零字节（字面量 0 + 长度 258 / 距离 1 的重复），每 258 字节只占 2 bit，
 *     压缩比约 1032:1，用于解压炸弹夹具；输出与位置无关，不需要先在内存里生成 n 字节。
 *
 * zip 头部固定：版本 2.0、无 extra field、无数据描述符、mtime 1980-01-01T00:00:00（DOS time 0 / date 0x21）、
 * 文件权限 0644、目录 0755（ADR 0059 §6.1）。条目顺序由调用方决定（夹具按路径字节序）。
 */
import { crc32 as zlibCrc32 } from 'node:zlib';

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const VERSION = 20;
const VERSION_MADE_BY = (3 << 8) | VERSION; // UNIX，2.0

/** CRC-32（IEEE），可增量：crc32(b, crc32(a)) === crc32(a‖b)。 */
export function crc32(buf, prev = 0) {
  return zlibCrc32(buf, prev) >>> 0;
}

/** 由存储块组成的 deflate 流（每块 ≤ 65 535 字节；空输入也有一个最终块）。 */
export function deflateStored(data) {
  const parts = [];
  let off = 0;
  do {
    const len = Math.min(65535, data.length - off);
    const head = Buffer.alloc(5);
    head[0] = off + len >= data.length ? 1 : 0; // BFINAL，BTYPE=00；存储块前一块已按字节对齐
    head.writeUInt16LE(len, 1);
    head.writeUInt16LE(~len & 0xffff, 3);
    parts.push(head, data.subarray(off, off + len));
    off += len;
  } while (off < data.length);
  return Buffer.concat(parts);
}

/** LSB 优先的比特写出器；缓冲区预先清零，写 0 比特只需推进位置。 */
class BitWriter {
  constructor(capacityBytes) {
    this.buf = Buffer.alloc(capacityBytes);
    this.bit = 0;
  }

  /** 写 value 的低 n 位（deflate 的「额外位」与头部字段：低位在前）。 */
  bits(value, n) {
    for (let i = 0; i < n; i++) this.one((value >>> i) & 1);
  }

  /** 写 Huffman 码（码字高位在前）。 */
  code(code, len) {
    for (let i = len - 1; i >= 0; i--) this.one((code >>> i) & 1);
  }

  one(b) {
    if (b) this.buf[this.bit >>> 3] |= 1 << (this.bit & 7);
    this.bit++;
  }

  zeros(n) {
    this.bit += n;
  }

  bytes() {
    return this.buf.subarray(0, (this.bit + 7) >>> 3);
  }
}

// 动态块的码表（RFC 1951 §3.2.7）。字面量/长度表只用三个符号：285（长度 258）1 位、字面量 0 与块尾 256 各 2 位；
// 距离表只用距离码 0（距离 1），按 RFC「只用一个距离码时以 1 位编码」。规范 Huffman 分配：
// 285 → 0；0 → 10；256 → 11；距离 0 → 0。
const LIT0 = [0b10, 2];
const EOB = [0b11, 2];
const LEN258 = [0b0, 1];
const DIST1 = [0b0, 1];
// 码长码表只用 18（1 位）、1、2（各 2 位）：18 → 0；1 → 10；2 → 11。
const CL = { 18: [0b0, 1], 1: [0b10, 2], 2: [0b11, 2] };
// 码长码长度的发送顺序（RFC 1951）；只需发到符号 1 所在的第 18 个位置。
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const CL_LENGTHS = { 18: 1, 1: 2, 2: 2 };

/** n 个零字节的 deflate 流（单个最终动态块）。 */
export function deflateZeros(n) {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`deflateZeros 需要正整数，得到 ${n}`);
  const matches = Math.floor((n - 1) / 258);
  const literals = 1 + ((n - 1) % 258);
  const w = new BitWriter(64 + Math.ceil((matches * 2 + literals * 2) / 8));
  w.bits(1, 1); // BFINAL
  w.bits(2, 2); // BTYPE=10 动态
  w.bits(286 - 257, 5); // HLIT
  w.bits(1 - 1, 5); // HDIST
  w.bits(18 - 4, 4); // HCLEN：发送前 18 个码长码长度
  for (const sym of CL_ORDER.slice(0, 18)) w.bits(CL_LENGTHS[sym] ?? 0, 3);
  // 287 个码长：[0]=2，[1..255]=0，[256]=2，[257..284]=0，[285]=1，距离[0]=1
  w.code(...CL[2]);
  w.code(...CL[18]); w.bits(138 - 11, 7);
  w.code(...CL[18]); w.bits(117 - 11, 7);
  w.code(...CL[2]);
  w.code(...CL[18]); w.bits(28 - 11, 7);
  w.code(...CL[1]);
  w.code(...CL[1]);
  // 数据：先一个字面量 0，之后每个匹配复制前 258 字节（全零），余数用字面量补齐
  w.code(...LIT0);
  // 一个匹配 = 长度码 '0' + 距离码 '0'，两位都是 0：直接推进
  w.zeros(matches * (LEN258[1] + DIST1[1]));
  for (let i = 1; i < literals; i++) w.code(...LIT0);
  w.code(...EOB);
  return Buffer.from(w.bytes());
}

/**
 * 写出 zip。entry 字段：
 *   name（必填）、directory（目录条目，无数据）、data（未压缩字节）、method（0 存储 / 8 deflate，缺省 0；
 *   8 用 deflateStored）；
 *   descriptor：置通用标志位 3，本地头的 crc / 大小写 0，数据后跟带签名的数据描述符（java.util.zip.ZipOutputStream
 *   对 DEFLATED 条目的写法）；utf8：置通用标志位 11（ZipOutputStream 对非 ASCII 名的写法）；flags：额外或上的标志位；
 *   畸形开关：rawMethod（头部写入的方法号，如 12）、compressed（直接给出压缩后字节）、crc、declaredUncompressedSize、
 *   declaredCompressedSize（头部写入的值，不必与实际相符）；cd：只覆盖中央目录中的字段（name / crc /
 *   compressedSize / uncompressedSize），用于本地头与中央目录不一致；lfh：反过来只覆盖本地头（name / uncompressedSize）；zip64：大小字段写 0xFFFFFFFF 并带 ZIP64 extra；
 *   rawName：直接给出条目名字节（可为非法 UTF-8）；dirData：给目录条目塞入数据（畸形目录条目）。
 * 归档级 opts：prefix（首个本地头之前的字节）、comment（EOCD 注释）、suffix（EOCD 之后的字节）。
 * 不给任何开关时输出与本模块此前版本逐字节相同。
 */
export function writeZip(entries, opts = {}) {
  const locals = [];
  const centrals = [];
  const prefix = opts.prefix ?? Buffer.alloc(0);
  let offset = prefix.length;
  for (const e of entries) {
    const name = e.rawName ?? Buffer.from(e.name, 'utf8');
    // lfh：只覆盖本地头中的字段（name / uncompressedSize），与 cd 相反方向的不一致
    const lfh = e.lfh ?? {};
    const localName = lfh.name !== undefined ? Buffer.from(lfh.name, 'utf8') : name;
    const data = e.directory ? (e.dirData ?? Buffer.alloc(0)) : (e.data ?? Buffer.alloc(0));
    const method = e.rawMethod ?? (e.directory ? 0 : (e.method ?? 0));
    const compressed = e.compressed ?? (method === 8 ? deflateStored(data) : data);
    const crc = e.crc ?? crc32(data);
    const csize = e.declaredCompressedSize ?? compressed.length;
    const usize = e.declaredUncompressedSize ?? data.length;
    const mode = e.directory ? 0o40755 : 0o100644;
    const flags = (e.flags ?? 0) | (e.descriptor ? 0x0008 : 0) | (e.utf8 ? 0x0800 : 0);
    const big = 0xffffffff;
    const extra = e.zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (e.zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(usize), 4);
      extra.writeBigUInt64LE(BigInt(csize), 12);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.zip64 ? 45 : VERSION, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(e.descriptor ? 0 : crc, 14);
    local.writeUInt32LE(e.descriptor ? 0 : (e.zip64 ? big : csize), 18);
    local.writeUInt32LE(e.descriptor ? 0 : (e.zip64 ? big : (lfh.uncompressedSize ?? usize)), 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(extra.length, 28);
    locals.push(local, localName, extra, compressed);
    let descriptorLen = 0;
    if (e.descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(csize, 8);
      dd.writeUInt32LE(usize, 12);
      locals.push(dd);
      descriptorLen = dd.length;
    }

    const cd = e.cd ?? {};
    const cdName = cd.name !== undefined ? Buffer.from(cd.name, 'utf8') : name;
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(e.zip64 ? 45 : VERSION, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(cd.crc ?? crc, 16);
    central.writeUInt32LE(e.zip64 ? big : (cd.compressedSize ?? csize), 20);
    central.writeUInt32LE(e.zip64 ? big : (cd.uncompressedSize ?? usize), 24);
    central.writeUInt16LE(cdName.length, 28);
    central.writeUInt16LE(extra.length, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attr
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, cdName, extra);

    offset += local.length + localName.length + extra.length + compressed.length + descriptorLen;
  }
  const cd = Buffer.concat(centrals);
  const comment = opts.comment ?? Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([prefix, ...locals, cd, eocd, comment, opts.suffix ?? Buffer.alloc(0)]);
}

/** 读回中央目录与各条目的压缩字节（测试用；不做任何合法性判断）。 */
export function readZipHeaders(buf) {
  const eocdAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdAt < 0) throw new Error('找不到 EOCD');
  const count = buf.readUInt16LE(eocdAt + 10);
  let p = buf.readUInt32LE(eocdAt + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`中央目录第 ${i} 项签名错误`);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const h = {
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      dosTime: buf.readUInt16LE(p + 12),
      dosDate: buf.readUInt16LE(p + 14),
      crc: buf.readUInt32LE(p + 16),
      compressedSize: buf.readUInt32LE(p + 20),
      uncompressedSize: buf.readUInt32LE(p + 24),
      externalAttr: buf.readUInt32LE(p + 38),
      flags: buf.readUInt16LE(p + 8),
    };
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    h.compressed = buf.subarray(dataAt, dataAt + h.compressedSize);
    out.push(h);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
