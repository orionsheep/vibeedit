#!/usr/bin/env python3
"""Compatibility wrapper for the legacy opc.py path."""

try:
    from .cli import main as _main
except ImportError:  # pragma: no cover - direct script execution fallback
    from cli import main as _main


def main():
    return _main()


if __name__ == "__main__":
    raise SystemExit(main())
