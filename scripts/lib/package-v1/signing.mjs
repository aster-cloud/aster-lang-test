/**
 * 包格式 v1 签名配方（ADR 0059 §6.2）：被签字节 = manifest.json 文件字节本身（且必须等于其规范 JSON 形）；
 * `sig` = 64 字节 Ed25519 签名的 base64url（无填充）；manifest.sig.json = {"alg":"Ed25519","issuer","kid","sig"}。
 * 与 aster-guard `src/receipt.ts` 的收据验签同一配方（node:crypto，`verify(null, bytes, key, sig)`）。
 *
 * 夹具只用 conformance/package-v1/keys/ 下的测试密钥，绝不用于发布。
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const base64url = (buf) => Buffer.from(buf).toString('base64url');

/** 32 字节种子 → { privateKey, publicKey, publicRaw }。 */
export function keyPairFromSeed(seed) {
  if (seed.length !== 32) throw new Error('Ed25519 种子必须是 32 字节');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const publicRaw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { privateKey, publicKey, publicRaw };
}

/** 32 字节原始公钥 → KeyObject。 */
export function publicKeyFromRaw(raw) {
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** 签 manifest 文件字节，返回 manifest.sig.json 的对象形。 */
export function signManifest(manifestBytes, keyPair, { issuer, kid }) {
  return { alg: 'Ed25519', issuer, kid, sig: base64url(sign(null, manifestBytes, keyPair.privateKey)) };
}

/** 验签（只校验密码学部分；kid 查锚、alg 与编码规范性由调用方先判）。 */
export function verifyManifest(manifestBytes, sigB64u, publicKey) {
  const sig = Buffer.from(sigB64u, 'base64url');
  if (sig.length !== 64 || base64url(sig) !== sigB64u) return false;
  return verify(null, manifestBytes, publicKey, sig);
}
