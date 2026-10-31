#!/usr/bin/env python
"""通过 CDP 给 Electron 窗口截图（真实渲染效果，不是 headless 浏览器）"""
import json, base64, sys, time, urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9222
OUT = sys.argv[2] if len(sys.argv) > 2 else "electron_shot.png"
WIDTH = int(sys.argv[3]) if len(sys.argv) > 3 else 1440
HEIGHT = int(sys.argv[4]) if len(sys.argv) > 4 else 900

def http_json(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=10) as r:
        return json.loads(r.read())

targets = [t for t in http_json("/json/list") if t.get("type") == "page"]
if not targets:
    print("no page target"); sys.exit(1)
ws = targets[0]["webSocketDebuggerUrl"]

# 用 websocket 客户端（标准库没有，这里用最小实现）
import socket, base64 as b64, hashlib, os, struct

class WS:
    def __init__(self, url):
        assert url.startswith("ws://")
        rest = url[5:]
        hostport, path = rest.split("/", 1)
        host, port = hostport.split(":")
        self.s = socket.create_connection((host, int(port)), timeout=30)
        key = b64.b64encode(os.urandom(16)).decode()
        req = (f"GET /{path} HTTP/1.1\r\nHost: {hostport}\r\n"
               f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
               f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.s.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        self.buf = buf.split(b"\r\n\r\n", 1)[1]

    def send(self, method, params=None, _id=[0]):
        _id[0] += 1
        msg = json.dumps({"id": _id[0], "method": method, "params": params or {}})
        data = msg.encode()
        hdr = bytearray([0x81])
        n = len(data)
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126); hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127); hdr += struct.pack(">Q", n)
        mask = os.urandom(4)
        hdr += mask
        self.s.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))
        return _id[0]

    def _read(self, n):
        while len(self.buf) < n:
            d = self.s.recv(65536)
            if not d: raise EOFError
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        b0, b1 = self._read(2)
        ln = b1 & 0x7F
        if ln == 126: ln = struct.unpack(">H", self._read(2))[0]
        elif ln == 127: ln = struct.unpack(">Q", self._read(8))[0]
        if b1 & 0x80:
            mask = self._read(4)
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(self._read(ln)))
        else:
            payload = self._read(ln)
        return json.loads(payload.decode("utf-8", "replace"))

    def call(self, method, params=None, timeout=30):
        i = self.send(method, params)
        t0 = time.time()
        while time.time() - t0 < timeout:
            self.s.settimeout(max(1, timeout - (time.time() - t0)))
            m = self.recv()
            if m.get("id") == i:
                return m.get("result", {})
        raise TimeoutError(method)

ws = WS(ws)
ws.call("Page.enable")
ws.call("Emulation.setDeviceMetricsOverride",
        {"width": WIDTH, "height": HEIGHT, "deviceScaleFactor": 2, "mobile": False})
time.sleep(1.2)
res = ws.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
open(OUT, "wb").write(base64.b64decode(res["data"]))
print("saved", OUT, os.path.getsize(OUT), "bytes")
