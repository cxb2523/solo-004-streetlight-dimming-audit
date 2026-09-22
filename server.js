#!/usr/bin/env node
/*
 * 零依赖静态文件服务（Node 20 内置模块）。
 * 用法：node server.js [端口]  ，默认 8080，浏览器打开 http://localhost:8080/
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const PUBLIC_DIRS = ['web', 'data'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-cache', ...headers });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/web/index.html';

  const filePath = path.normalize(path.join(ROOT, pathname));
  const relative = path.relative(ROOT, filePath);
  const topDir = relative.split(path.sep)[0];
  if (relative.startsWith('..') || path.isAbsolute(relative) || !PUBLIC_DIRS.includes(topDir)) {
    return send(res, 403, 'Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not Found');
    fs.readFile(filePath, (readErr, buf) => {
      if (readErr) return send(res, 500, 'Read Error');
      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      send(res, 200, buf, { 'Content-Type': type });
    });
  });
});

server.listen(PORT, () => {
  console.log(`路灯能耗审计页已启动: http://localhost:${PORT}/`);
});
