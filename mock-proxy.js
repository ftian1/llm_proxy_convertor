#!/usr/bin/env node
/**
 * Mock HTTP 代理 —— 本地测试 gateway 的代理支持用
 * 支持: absolute-form 转发 (http 目标) + CONNECT 隧道 (https 目标)
 * 用法: node mock-proxy.js [port]   (默认 9002)
 */
'use strict';

const http = require('http');
const net = require('net');

const PORT = parseInt(process.argv[2] || '9002', 10);

const server = http.createServer((req, res) => {
  console.log(`[proxy] ${req.method} ${req.url}`);
  const u = new URL(req.url);
  const fwd = http.request(u, { method: req.method, headers: { ...req.headers, host: u.host } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  fwd.on('error', (e) => {
    res.writeHead(502);
    res.end(e.message);
  });
  req.pipe(fwd);
});

server.on('connect', (req, socket, head) => {
  console.log(`[proxy] CONNECT ${req.url}`);
  const [host, port] = req.url.split(':');
  const up = net.connect(Number(port), host, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, () => {
  console.log(`mock proxy listening on http://localhost:${PORT}`);
});
