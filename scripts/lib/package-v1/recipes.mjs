/**
 * tamper/test-time.json 配方的运行时材料（ADR 0059 P1 T11）：生成临时包 / 超大输入，以及配方里描述的本地自签名 https 服务。
 * package-conformance.mjs 用它把配方变成可直接交给两个 CLI 的参数、stdin 与环境变量。
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

/** 生成自签名证书（RSA 2048；CN / SAN = localhost、127.0.0.1。不用 EC：macOS 的 LibreSSL 会写出显式曲线参数，JDK 只接受命名曲线），返回 { dir, keyPem, certPem, certFile }；openssl 不可用时返回 null。 */
export function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), 'pkgv1-cert-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')]);
  if (r.status !== 0) return null;
  return { dir, keyPem: readFileSync(join(dir, 'key.pem')), certPem: readFileSync(join(dir, 'cert.pem')), certFile: join(dir, 'cert.pem') };
}

/**
 * 按配方的 routes 应答的 https 服务（语义见 test-time.json 的 description）。返回 { port, close }。
 * jwksFile：keys/test-jwks.json 的绝对路径。
 */
export async function startRecipeServer(routes, cert, jwksFile) {
  const jwks = readFileSync(jwksFile);
  let port;
  const server = createServer({ key: cert.keyPem, cert: cert.certPem }, (req, res) => {
    const r = routes[req.url];
    if (!r) return res.writeHead(404).end();
    if (r.location) return res.writeHead(r.status, { location: r.location.replace('<PORT>', String(port)) }).end();
    if (r.contentEncoding === 'gzip') return res.writeHead(r.status, { 'content-encoding': 'gzip' }).end(gzipSync(jwks));
    if (r.contentEncodingHeader) return res.writeHead(r.status, { 'content-encoding': r.contentEncodingHeader }).end(jwks);
    if (r.file) return res.writeHead(r.status).end(jwks);
    if (r.zeros) return res.writeHead(r.status).end(Buffer.alloc(r.zeros, 0x20));
    if (r.jwksPaddedTo) return res.writeHead(r.status).end(Buffer.concat([jwks, Buffer.alloc(r.jwksPaddedTo - jwks.length, 0x20)]));
    return res.writeHead(r.status).end(r.body ?? '');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  port = server.address().port;
  return {
    port,
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

/** 按配方在临时目录里生成包（copyPackage + add / addDirs，或 copyZip + appendZeros），返回 { path, cleanup }；无包类配方返回 null。 */
export function materializePackage(recipe, packageV1) {
  if (!recipe.copyPackage && !recipe.copyZip) return null;
  const tmp = mkdtempSync(join(tmpdir(), 'pkgv1-recipe-'));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  if (recipe.copyPackage) {
    const dst = join(tmp, 'pkg');
    cpSync(join(packageV1, recipe.copyPackage), dst, { recursive: true });
    const chunk = Buffer.alloc(1024 * 1024);
    for (const a of recipe.add ?? []) {
      const file = join(dst, a.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, Buffer.alloc(0));
      for (let left = a.size; left > 0; left -= chunk.length) appendFileSync(file, chunk.subarray(0, Math.min(left, chunk.length)));
    }
    for (const d of recipe.addDirs ?? []) mkdirSync(join(dst, d), { recursive: true });
    return { path: dst, cleanup };
  }
  const dst = join(tmp, 'pkg.zip');
  cpSync(join(packageV1, recipe.copyZip), dst);
  const chunk = Buffer.alloc(1024 * 1024);
  for (let left = recipe.appendZeros ?? 0; left > 0; left -= chunk.length) appendFileSync(dst, chunk.subarray(0, Math.min(left, chunk.length)));
  return { path: dst, cleanup };
}

/** stdinRecipe：prefix + padding 个空格 + suffix。 */
export function recipeStdin(stdinRecipe) {
  return Buffer.concat([Buffer.from(stdinRecipe.prefix, 'utf8'), Buffer.alloc(stdinRecipe.padding, 0x20), Buffer.from(stdinRecipe.suffix, 'utf8')]);
}
