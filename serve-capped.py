"""Serve the built APK over HTTP on 127.0.0.1:8097 inside a Job Object capped
at 256 MB, so a phone can sideload it through a proxy or tunnel of your choice.

Why the cap is applied to THIS process rather than to a child: a Job Object dies
with its last open handle, so a helper that creates a job, assigns a running
server to it and then exits leaves no cap behind. This process joins the job
itself and then serves in-process: one PID, one job, capped for its whole life.

Every ctypes prototype below is declared. ctypes defaults a foreign function's
return to a 32-bit int, which on 64-bit Windows TRUNCATES a HANDLE -- the job
handle comes back mangled and AssignProcessToJobObject fails on a handle that
looks plausible. The declarations are the fix.

Directory listing is deliberately left on: it is one file, and the listing is a
useful "is this thing up?" page from the phone.

    py serve-capped.py
"""
import ctypes
import functools
import http.server
import os
import re
import socketserver
from ctypes import wintypes
from pathlib import Path

PORT = 8097
CAP_MB = 256
ROOT = Path(__file__).parent / ".serve"

JobObjectExtendedLimitInformation = 9
JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
        ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_void_p),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def apply_cap(mb):
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)

    k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    k32.CreateJobObjectW.restype = wintypes.HANDLE
    k32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD
    ]
    k32.SetInformationJobObject.restype = wintypes.BOOL
    k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k32.AssignProcessToJobObject.restype = wintypes.BOOL
    k32.GetCurrentProcess.argtypes = []
    k32.GetCurrentProcess.restype = wintypes.HANDLE

    job = k32.CreateJobObjectW(None, None)
    if not job:
        raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")

    info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_JOB_MEMORY
    info.JobMemoryLimit = mb * 1024 * 1024
    if not k32.SetInformationJobObject(
        job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)
    ):
        raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")

    if not k32.AssignProcessToJobObject(job, k32.GetCurrentProcess()):
        raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")

    # Deliberately leaked: closing this handle destroys the job and the cap with
    # it. It is released on process exit, which is the lifetime the cap wants.
    ctypes._facet_job_handle = job


RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)$")


class Handler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler, plus the one thing it has never implemented.

    The base class answers every request with the whole file and no
    `Accept-Ranges`, so a transfer that dies at 30 of 38 MB has to start again
    from zero. Over a tunnel to a phone that is not a theoretical concern: the
    server log for the previous build is twenty-odd `GET /facet-signed.apk 200`
    lines interleaved with WinError 10054, which is one download failing and
    restarting twenty times rather than resuming once.

    Android's DownloadManager only offers to resume when the first response
    advertised `Accept-Ranges: bytes`, so the header goes on every response,
    not just on the 206.
    """

    protocol_version = "HTTP/1.1"

    def end_headers(self):
        # A header rather than a Content-Type override, so unlike the .apk type
        # below this one can safely be appended: there is no base-class
        # Accept-Ranges for it to end up duplicating.
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        header = self.headers.get("Range")
        if not header:
            return super().send_head()

        match = RANGE_RE.match(header.strip())
        path = self.translate_path(self.path)
        if not match or os.path.isdir(path):
            return super().send_head()

        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        size = os.fstat(f.fileno()).st_size
        first, last = match.group(1), match.group(2)

        if first == "":
            # "bytes=-500" is the LAST 500 bytes, not the first. Getting this
            # backwards serves the wrong half of the file with a 206 on it,
            # which no client checks and every client is corrupted by.
            if last == "":
                f.close()
                return super().send_head()
            start = max(0, size - int(last))
            end = size - 1
        else:
            start = int(first)
            end = int(last) if last else size - 1

        end = min(end, size - 1)
        if start >= size or start > end:
            f.close()
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None

        f.seek(start)
        self.range_remaining = end - start + 1

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(self.range_remaining))
        self.send_header(
            "Last-Modified", self.date_time_string(os.fstat(f.fileno()).st_mtime)
        )
        self.end_headers()
        return f

    def copyfile(self, source, outputfile):
        # The base class copies to EOF. After a seek that is right only for a
        # range that happens to end at the end of the file; for any other one it
        # sends more bytes than the Content-Length promised, and the client
        # reads the overrun as the start of the next response.
        remaining = getattr(self, "range_remaining", None)
        if remaining is None:
            super().copyfile(source, outputfile)
            return
        self.range_remaining = None
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)

    def guess_type(self, path):
        # Android's download manager is markedly better behaved when the APK
        # arrives with its real type. Overriding guess_type rather than adding a
        # header in end_headers: the base class has already emitted its own
        # Content-Type by then, so appending produced a response with TWO of
        # them and the wrong one winning.
        if str(path).endswith(".apk"):
            return "application/vnd.android.package-archive"
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        # Keep the request log -- seeing the phone's GET is how the install is
        # confirmed from this side.
        print("%s - %s" % (self.address_string(), fmt % args), flush=True)


if __name__ == "__main__":
    apply_cap(CAP_MB)
    print("facet apk server: capped at %d MB (pid %d)" % (CAP_MB, os.getpid()), flush=True)
    print("serving %s on 127.0.0.1:%d" % (ROOT, PORT), flush=True)
    # Threaded, because HTTP/1.1 keep-alive plus a single-threaded server means
    # one phone holding a connection open blocks every other request -- including
    # the directory listing used to check the server is up.
    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    handler = functools.partial(Handler, directory=str(ROOT))
    with Server(("127.0.0.1", PORT), handler) as httpd:
        httpd.serve_forever()
