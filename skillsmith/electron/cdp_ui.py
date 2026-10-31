#!/usr/bin/env python
"""
UI 自动化验证：通过 CDP 驱动 Electron 窗口
  1. 打开「智能体管理」面板
  2. 截图面板
  3. 验证新增端 → 出现在列表 → 删除端
用法: python cdp_ui.py <动作> [端口]
"""
import base64, json, os, socket, struct, subprocess, sys, time

PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 9222
ACTION = sys.argv[1] if len(sys.argv) > 1 else 'shot'


def fetch_targets():
    out = subprocess.run(['curl', '-s', '-m', '8', f'http://127.0.0.1:{PORT}/json/list'],
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
            if not d:
                raise EOFError
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


def page_ws():
    for t in fetch_targets():
        if t.get('type') == 'page' and 'Skills' in (t.get('title') or ''):
            return WS(t['webSocketDebuggerUrl'])
    raise SystemExit('no page target')


def evaluate(ws, expr, await_promise=False):
    params = {'expression': expr, 'returnByValue': True}
    if await_promise:
        params['awaitPromise'] = True
    r = ws.call('Runtime.evaluate', params)
    if 'exceptionDetails' in r:
        return 'EXCEPTION: ' + json.dumps(r['exceptionDetails'], ensure_ascii=False)[:600]
    v = r.get('result', {})
    return v.get('value')


def shot(ws, path, w=1360, h=880):
    ws.call('Page.enable')
    ws.call('Emulation.setDeviceMetricsOverride',
            {'width': w, 'height': h, 'deviceScaleFactor': 2, 'mobile': False})
    time.sleep(1.0)
    res = ws.call('Page.captureScreenshot', {'format': 'png'})
    open(path, 'wb').write(base64.b64decode(res['data']))
    print('saved', path)


if __name__ == '__main__':
    ws = page_ws()
    if ACTION == 'open':
        print(evaluate(ws, """
        (() => {
          const b = document.querySelector('.sw-manage-btn');
          if (!b) return 'NO_MANAGE_BUTTON';
          b.click();
          return 'clicked';
        })()
        """))
        time.sleep(1.6)
        print(evaluate(ws, """
        (() => {
          const m = document.querySelector('.sw-modal');
          if (!m) return 'NO_MODAL';
          return JSON.stringify({
            modalOpen: true,
            rows: [...document.querySelectorAll('.sw-ag')].map(r => ({
              name: r.querySelector('.sw-ag-name input')?.value,
              dir: r.querySelector('.sw-ag-dir input')?.value,
              tags: [...r.querySelectorAll('.sw-tag')].map(t => t.textContent),
            })),
          });
        })()
        """))
        shot(ws, 'agent_panel.png')
    elif ACTION == 'shot':
        shot(ws, 'agent_panel.png')
    elif ACTION == 'add':
        print(evaluate(ws, """
        (async () => {
          const b = document.querySelector('.sw-manage-btn');
          if (b) b.click();
          await new Promise(r => setTimeout(r, 900));
          const addBtn = [...document.querySelectorAll('.sw-modal-foot button')].find(x => x.textContent.includes('新增'));
          if (!addBtn) return 'NO_ADD_BTN';
          addBtn.click();
          await new Promise(r => setTimeout(r, 400));
          const inputs = [...document.querySelectorAll('.sw-form input')];
          if (inputs.length < 4) return 'FORM_FIELDS=' + inputs.length;
          inputs[0].value = 'Zed 测试端';
          inputs[1].value = '~/.trae/skills';
          inputs[2].value = 'zed-test';
          inputs[3].value = '~/.trae/skill-config.json';
          const save = [...document.querySelectorAll('.sw-form button')].find(x => x.textContent === '添加');
          if (!save) return 'NO_SAVE';
          save.click();
          await new Promise(r => setTimeout(r, 1500));
          return JSON.stringify({
            rows: [...document.querySelectorAll('.sw-ag')].map(r => r.querySelector('.sw-ag-name input')?.value),
          });
        })()
        """, await_promise=True))
        shot(ws, 'agent_added.png')
    elif ACTION == 'remove':
        print(evaluate(ws, """
        (async () => {
          window.confirm = () => true;
          const b = document.querySelector('.sw-manage-btn');
          if (b) b.click();
          await new Promise(r => setTimeout(r, 900));
          const rows = [...document.querySelectorAll('.sw-ag')];
          const target = rows.find(r => (r.querySelector('.sw-ag-name input')?.value || '').includes('Zed'));
          if (!target) return 'NOT_FOUND';
          const del = [...target.querySelectorAll('button')].find(b => b.title.includes('删除'));
          if (!del) return 'NO_DEL_BTN';
          del.click();
          await new Promise(r => setTimeout(r, 1500));
          return JSON.stringify({
            rows: [...document.querySelectorAll('.sw-ag')].map(r => r.querySelector('.sw-ag-name input')?.value),
          });
        })()
        """, await_promise=True))
        shot(ws, 'agent_removed.png')
