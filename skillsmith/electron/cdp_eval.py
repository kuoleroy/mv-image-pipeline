#!/usr/bin/env python
"""通过 CDP 在页面里执行任意 JS 并打印结果。用法: cdp_eval.py '<js expression>'"""
import json, os, socket, struct, subprocess, sys, time, base64

PORT = 9222

def fetch_targets():
    # 走 curl：urllib 会被沙箱代理拦（502）
    out = subprocess.run(
        ['curl', '-s', '-m', '8', f'http://127.0.0.1:{PORT}/json/list'],
        capture_output=True, text=True).stdout
    return json.loads(out)

class WS:
    def __init__(self, url):
        rest = url[5:]
        hp, path = rest.split('/', 1)
        host, port = hp.split(':')
        self.s = socket.create_connection((host, int(port)), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f'GET /{path} HTTP/1.1\r\nHost: {hp}\r\nUpgrade: websocket\r\n'
                        f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n'
                        f'Sec-WebSocket-Version: 13\r\n\r\n').encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            buf += self.s.recv(4096)
        self.buf = buf.split(b'\r\n\r\n', 1)[1]

    def send(self, m, p=None, _i=[0]):
        _i[0] += 1
        msg = json.dumps({'id': _i[0], 'method': m, 'params': p or {}}).encode()
        h = bytearray([0x81]); n = len(msg)
        if n < 126:
            h.append(0x80 | n)
        elif n < 65536:
            h.append(0x80 | 126); h += struct.pack('>H', n)
        else:
            h.append(0x80 | 127); h += struct.pack('>Q', n)
        mk = os.urandom(4); h += mk
        self.s.sendall(bytes(h) + bytes(b ^ mk[i % 4] for i, b in enumerate(msg)))
        return _i[0]

    def _read(self, n):
        while len(self.buf) < n:
            d = self.s.recv(65536)
            if not d: raise EOFError
            self.buf += d
        o, self.buf = self.buf[:n], self.buf[n:]
        return o

    def recv(self):
        b0, b1 = self._read(2); ln = b1 & 0x7F
        if ln == 126: ln = struct.unpack('>H', self._read(2))[0]
        elif ln == 127: ln = struct.unpack('>Q', self._read(8))[0]
        if b1 & 0x80:
            mk = self._read(4)
            pl = bytes(b ^ mk[i % 4] for i, b in enumerate(self._read(ln)))
        else:
            pl = self._read(ln)
        return json.loads(pl.decode('utf-8', 'replace'))

    def call(self, m, p=None, t=25):
        i = self.send(m, p); t0 = time.time()
        while time.time() - t0 < t:
            self.s.settimeout(max(1, t - (time.time() - t0)))
            r = self.recv()
            if r.get('id') == i:
                return r.get('result', {})
        raise TimeoutError(m)

def evaluate(expr):
    tgts = [t for t in fetch_targets() if t.get('type') == 'page']
    if not tgts:
        raise SystemExit('no page target')
    # 多个 target 时取标题匹配的那个，避免连到 DevTools 自己的页面
    pick = None
    for t in tgts:
        if 'Skills' in (t.get('title') or ''):
            pick = t
            break
    ws = WS((pick or tgts[0])['webSocketDebuggerUrl'])
    r = ws.call('Runtime.evaluate', {'expression': expr, 'returnByValue': True})
    # call() 已返回 m['result']，即 {"type":..., "value":...}
    if r.get('type') == 'undefined':
        return 'UNDEFINED'
    if 'exceptionDetails' in r:
        return 'EXCEPTION: ' + json.dumps(
            r['exceptionDetails'].get('exception', r['exceptionDetails']),
            ensure_ascii=False)[:900]
    return r.get('value')

if __name__ == '__main__':
    expr = sys.argv[1]
    out = evaluate(expr)
    if isinstance(out, str):
        print(out)
    else:
        print(json.dumps(out, ensure_ascii=False, indent=2))
