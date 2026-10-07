"""Standard-library PTY bridge; omp receives a real controlling terminal."""
import os
import pty
import select
import signal
import struct
import sys
import termios
import fcntl

pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
try:
    while True:
        readable, _, _ = select.select([master, sys.stdin.fileno()], [], [])
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
            if b'\x1b[6n' in data:
                os.write(master, b'\x1b[1;1R')
        if sys.stdin.fileno() in readable:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            os.write(sys.stderr.fileno(), ('\nPTY input: ' + repr(data) + '\n').encode())
            os.write(master, data)
finally:
    os.close(master)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status))
