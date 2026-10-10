"""Protect the extension pairing token with the current Windows user's DPAPI.

Plaintext travels only through private subprocess pipes, never command arguments.
"""
import base64
import ctypes
from ctypes import wintypes
import sys


class Blob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]


def transform(data, *, protect):
    if sys.platform != 'win32':
        raise RuntimeError('Windows DPAPI required')
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    source_buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(source_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    entropy_buffer = ctypes.create_string_buffer(b'chatgpt-web-images-extension-v1')
    entropy = Blob(len(entropy_buffer.value), ctypes.cast(entropy_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    result = Blob()
    if protect:
        ok = crypt.CryptProtectData(ctypes.byref(source), None, ctypes.byref(entropy), None, None, 1, ctypes.byref(result))
    else:
        ok = crypt.CryptUnprotectData(ctypes.byref(source), None, ctypes.byref(entropy), None, None, 1, ctypes.byref(result))
    if not ok:
        raise RuntimeError('Extension pairing token cannot be read by this Windows user')
    try:
        return ctypes.string_at(result.data, result.size)
    finally:
        kernel.LocalFree(result.data)


if __name__ == '__main__':
    try:
        value = sys.stdin.buffer.read()
        if sys.argv[1] == 'protect':
            sys.stdout.buffer.write(base64.b64encode(transform(value, protect=True)))
        elif sys.argv[1] == 'unprotect':
            sys.stdout.buffer.write(transform(base64.b64decode(value, validate=True), protect=False))
        else:
            raise ValueError('Unsupported operation')
    except Exception:
        sys.stderr.write('Extension pairing protection failed\n')
        raise SystemExit(1)
