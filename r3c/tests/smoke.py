from pathlib import Path
import errno
import fcntl
import http.server
import json
import os
import pty
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import termios
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / 'r3c'
FIXTURE = ROOT / 'build/fixture'
ANSI = re.compile(rb'\x1b\[[0-9;?]*[a-zA-Z]')


def run(*arguments, timeout=40):
    result = subprocess.run([str(EXE), *map(str, arguments)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    assert result.returncode == 0, (arguments, result.returncode, result.stderr.decode(errors='replace'))
    assert b'assertion' not in result.stderr, result.stderr
    return result


local = json.loads(run('-A', 'aa', '-j', FIXTURE).stdout)
names = {f['name']: i for i, f in enumerate(local['functions'])}
main = next(name for name in names if name == 'main' or name.endswith('.main'))
decode = next(name for name in names if name.endswith('decode'))
dispatch = next(name for name in names if name.endswith('dispatch'))
assert local['basic_blocks'] > 0
assert any(c['from'] == names[dispatch] and c['to'] == names[decode] for c in local['calls'])
assert any(c['from'] == names[main] and c['to'] == names[dispatch] for c in local['calls'])
print('native model: functions, basic blocks and attributed calls passed')

for mode in ('braille', 'rgb', 'ansi', '256', 'gray', 'ascii', 'mono', 'mono-braille'):
    frame = run('-d', '-m', mode, '-s', '110x32', '-T', '-E').stdout
    plain = ANSI.sub(b'', frame).decode('utf-8')
    assert len(plain.splitlines()) == 32, (mode, len(plain.splitlines()))
    assert all(len(line) == 110 for line in plain.splitlines()), mode
    if mode in ('braille', 'mono-braille'):
        assert any(0x2800 <= ord(ch) <= 0x28ff for ch in plain), mode
    if mode == 'mono':
        assert all(ord(ch) < 128 for ch in plain)
    if mode == 'ansi':
        assert re.search(rb'\x1b\[(?:3[0-7]|9[0-7])m', frame)
        assert b'\x1b[38;2;' in frame  # Text keeps RGB colors independently of the scene.
    assert 'main' in plain
print('image modes: pixel-to-cell scaling, dimensions and native text passed')

for view in ('city', 'graph', 'cfg'):
    result = run('-A', 'aa', '-s', '150x44', '-p', '-f', main, '-v', view, FIXTURE)
    assert main.encode() in result.stdout
    assert b'DISASSEMBLY' in result.stdout
    assert b'\x1b' not in result.stdout
    assert b'Do you want to print' not in result.stdout + result.stderr
print('real binary: city, constellation and CFG snapshots passed')


class RecordingServer(http.server.ThreadingHTTPServer):
    daemon_threads = True


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        self.server.commands.append((self.path, body))
        if self.path != '/cmd':
            self.send_error(404)
            return
        command = body.decode()
        if command == 'ij':
            reply = json.dumps({'core': {'file': 'remote fixture'}})
        elif command == 'aflj':
            reply = json.dumps([{'addr': 0x1000, 'name': 'main', 'size': 32, 'nbbs': 1, 'cc': 1}])
        elif command == 'afbj @@F':
            reply = '[{"addr":4096,"size":32}]\n'
        else:
            reply = '[]'
        data = reply.encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


server = RecordingServer(('127.0.0.1', 0), Handler)
server.commands = []
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    base = f'http://127.0.0.1:{server.server_port}'
    for suffix in ('', '/cmd', '/cmd/'):
        remote = json.loads(run('-j', base + suffix).stdout)
        assert remote['functions'][0]['name'] == 'main'
    assert server.commands and all(path == '/cmd' for path, _ in server.commands)
    assert not any(body in (b'aa', b'aaa') for _, body in server.commands)
finally:
    server.shutdown()
    server.server_close()
    thread.join()
print('HTTP: POST /cmd, URL normalization, optional metadata and existing analysis passed')


def real_http_server():
    r2 = shutil.which('radare2')
    if not r2:
        print('real HTTP server: skipped (radare2 executable unavailable)')
        return
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    url = f'http://127.0.0.1:{port}/cmd'
    child = subprocess.Popen([r2, '-NN', '-q', '-e', 'http.bind=127.0.0.1', '-e', f'http.port={port}',
                              '-e', 'http.log=false', '-c', 'aa;=h', str(FIXTURE)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 8
        while True:
            try:
                request = urllib.request.Request(url, data=b'ij', method='POST')
                with urllib.request.urlopen(request, timeout=.5) as response:
                    json.loads(response.read())
                break
            except (OSError, urllib.error.URLError):
                assert child.poll() is None, child.stderr.read().decode(errors='replace')
                assert time.monotonic() < deadline, 'r2 HTTP server did not start'
                time.sleep(.05)
        remote = json.loads(run('-j', url).stdout)
        assert {f['name'] for f in remote['functions']} == set(names)
        assert remote['basic_blocks'] == local['basic_blocks']
        assert len(remote['calls']) == len(local['calls'])
        frame = run('-s', '150x44', '-f', main, '-v', 'cfg', url)
        assert b'DISASSEMBLY' in frame.stdout
        themes = subprocess.run([str(ROOT / 'build/test_app'), '--http', url], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40)
        assert themes.returncode == 0, themes.stderr.decode(errors='replace')
        assert b'across all r2 themes' in themes.stdout
    finally:
        child.terminate()
        try:
            child.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.communicate()
    print('real r2 HTTP server: model parity and native CFG layout passed')


real_http_server()


def pty_session(termination=None):
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 170, 0, 0))
    env = dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor')
    child = subprocess.Popen([str(EXE), '-d', '-p', '-r', '12'], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
    output = bytearray()

    def drain(duration):
        until = time.monotonic() + duration
        while time.monotonic() < until:
            ready, _, _ = select.select([master], [], [], min(.04, max(0, until - time.monotonic())))
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                output.extend(data)

    try:
        drain(.5)
        assert child.poll() is None
        assert b'\x1b[38;2;' in output, 'snapshot-only -p must not suppress live colors'
        if termination is None:
            os.write(master, b'R')
            drain(.4)
            assert child.poll() is None and b'r2 theme:' in output
            os.write(master, b'RnpJK[]{}mMg0x1004\r')
            drain(.2)
            for cols, rows in ((90, 25), (210, 65), (55, 14), (150, 40)):
                fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                child.send_signal(signal.SIGWINCH)
                os.write(master, b'hjkl\x1b[A\x1b[B\x1b[C\x1b[D')
                drain(.15)
                assert child.poll() is None
            os.write(master, b',jl,jm')
            drain(.2)
            os.write(master, b'c')
            drain(.2)
            os.write(master, b'\x1b[<0;20;12M\x1b[<32;24;14M\x1b[<0;24;14m\x1b[<64;24;14M\x1b[<66;24;14M\x1b[<67;24;14M')
            drain(.2)
            os.write(master, b'\x03')
            drain(.2)
            assert child.poll() is None and b'Quit r3c?' in output
            os.write(master, b'n')
            drain(.1)
            child.send_signal(signal.SIGINT)
            drain(.2)
            assert child.poll() is None
            os.write(master, b'n')
            drain(.1)
            os.write(master, b'q')
            drain(.2)
            assert child.poll() is None and b'Quit r3c?' in output
            os.write(master, b'n')
            drain(.1)
            assert child.poll() is None
            os.write(master, b'qy')
        else:
            child.send_signal(termination)
        deadline = time.monotonic() + 5
        while child.poll() is None and time.monotonic() < deadline:
            drain(.05)
        assert child.poll() == 0, ('exit', child.poll())
        drain(.1)
        assert b'Do you want to print' not in output
        assert b'assertion' not in output
        assert b'\x1b[?1049h' in output and b'\x1b[?1049l' in output
        restored = termios.tcgetattr(slave)
        assert restored[3] & (termios.ICANON | termios.ECHO) == original[3] & (termios.ICANON | termios.ECHO)
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        os.close(slave)


pty_session()
pty_session(signal.SIGTERM)
print('terminal: resize, hjkl/arrows, mouse, themes, settings, Ctrl-C/SIGINT confirmation and clean exit passed')
