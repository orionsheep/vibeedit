#!/usr/bin/env python3
"""autoedit CLI.

Focused on two responsibilities only:
1. ASR + subtitle generation
2. Launching the agent-based editing workspace
"""

import argparse
import csv as csv_mod
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS_DIR)

from shared.config import load_config, save_config
from shared.platform import get_backend, get_backend_label, check_dependency_available
from asr.qwen_asr_engine import asr_transcribe, asr_align, align_text, result_to_dict
from asr.pipeline import run_pipeline, split_line_after, _load_lines, _save_lines, stage_check


def cmd_asr(args):
    """Run ASR or subtitle generation."""
    audio = args.audio
    if not os.path.exists(audio):
        print(f"Error: Audio file not found: {audio}")
        sys.exit(1)

    cfg = load_config()
    model_size = args.model_size or cfg.get("asr_model_size", "1.7B")
    language = args.language or cfg.get("asr_language", "") or None
    output_dir = cfg.get("output_dir", tempfile.gettempdir())
    fmt = args.format

    if fmt == "text" or fmt is None:
        text = asr_transcribe(audio, language=language, model_size=model_size)
        print(text)
        return

    if fmt == "json":
        result = asr_align(audio, language=language, model_size=model_size)
        output_path = args.output or os.path.join(
            output_dir,
            os.path.splitext(os.path.basename(audio))[0] + ".asr.json",
        )
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result_to_dict(result), f, ensure_ascii=False, indent=2)
        print(f"Saved: {output_path}")
        return

    if fmt in ("srt", "ass"):
        fix_dir = getattr(args, "fix_dir", None)
        resume = getattr(args, "resume_from", None)
        max_chars = min(getattr(args, "max_chars", 14), 20)

        paths = run_pipeline(
            audio_path=audio,
            output_dir=output_dir,
            fmt="all",
            ass_style="default",
            fix_dir=fix_dir,
            language=language,
            model_size=model_size,
            max_chars=max_chars,
            resume_from=resume,
        )

        if "check_errors" in paths:
            print(f"\nRender blocked by {len(paths['check_errors'])} check error(s).")
            print(f"Lines file: {paths['lines_path']}")
            print("Fix the issues using 'autoedit asr-split', then re-run:")
            print(f"  autoedit asr {audio} --format {fmt} --resume-from render --max-chars {max_chars}")
            sys.exit(1)

        for _, path in paths.items():
            print(f"Saved: {path}")
        return

    print(f"Error: Unsupported format: {fmt}")
    sys.exit(1)


def cmd_align(args):
    """Align a provided transcript against audio."""
    audio = args.audio
    if not os.path.exists(audio):
        print(f"Error: Audio file not found: {audio}")
        sys.exit(1)

    transcript_text = args.text or ""
    if args.text_file:
        if not os.path.exists(args.text_file):
            print(f"Error: Text file not found: {args.text_file}")
            sys.exit(1)
        with open(args.text_file, "r", encoding="utf-8") as f:
            transcript_text = f.read()

    if not transcript_text.strip():
        print("Error: alignment requires --text or --text-file")
        sys.exit(1)

    cfg = load_config()
    language = args.language or cfg.get("asr_language", "") or None
    output_dir = cfg.get("output_dir", tempfile.gettempdir())
    result = align_text(audio, transcript_text, language=language)
    output_path = args.output or os.path.join(
        output_dir,
        os.path.splitext(os.path.basename(audio))[0] + ".align.json",
    )
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result_to_dict(result), f, ensure_ascii=False, indent=2)
    print(f"Saved: {output_path}")


def cmd_asr_split(args):
    """Split subtitle lines by text match or CSV."""
    lines_path = args.lines_json
    if not os.path.exists(lines_path):
        print(f"Error: File not found: {lines_path}")
        sys.exit(1)

    lines = _load_lines(lines_path)

    if args.csv:
        if not os.path.exists(args.csv):
            print(f"Error: CSV file not found: {args.csv}")
            sys.exit(1)

        rules = []
        with open(args.csv, "r", encoding="utf-8") as f:
            reader = csv_mod.reader(f)
            for row in reader:
                if not row or row[0].strip().startswith("#"):
                    continue
                if len(row) >= 2:
                    rules.append((int(row[0].strip()), row[1].strip()))

        print(f"Applying {len(rules)} split rules from {args.csv}...")
        rules.sort(key=lambda item: item[0], reverse=True)

        for line_idx, after in rules:
            if line_idx < 1 or line_idx > len(lines):
                print(f"  Skip line {line_idx}: out of range")
                continue
            try:
                lines = split_line_after(lines, line_idx, after)
                print(f"  Line {line_idx}: OK")
            except ValueError as error:
                print(f"  Line {line_idx}: {error}")
    else:
        if args.line is None or args.after is None:
            print("Error: single mode requires both --line and --after")
            sys.exit(1)

        line_idx = args.line
        after_text = args.after
        if line_idx < 1 or line_idx > len(lines):
            print(f"Error: Line index {line_idx} out of range (1-{len(lines)})")
            sys.exit(1)

        print(f"Line {line_idx}: \"{lines[line_idx - 1].text}\"")
        try:
            lines = split_line_after(lines, line_idx, after_text)
        except ValueError as error:
            print(f"Error: {error}")
            sys.exit(1)

        print("Result:")
        for i, line in enumerate(lines):
            marker = " → " if line_idx - 1 <= i < line_idx + 1 else "   "
            print(f"  {marker}Line {i+1}: \"{line.text}\"")

    _save_lines(lines, lines_path)
    print(f"Saved: {lines_path}")

    print()
    errors = stage_check(lines, max_chars=14)
    if not errors:
        print("Ready to render. Re-run with --resume-from render")


def cmd_cut(args):
    """Start the current project-first editing workspace."""
    project_root = os.path.dirname(SCRIPTS_DIR)
    dashboard_server_dir = os.path.join(project_root, "apps", "web")
    dashboard_port = args.dashboard_port or load_config().get("dashboard_port", 12080)
    api_port = args.api_port or load_config().get("api_port", 12081)
    requested_page = (args.page or "projects").strip().lower()
    if requested_page in {"agent", "editor"}:
        requested_page = "projects"
    if requested_page not in {"projects", "dashboard"}:
        requested_page = "projects"
    entry_path = f"http://localhost:{dashboard_port}/{'dashboard' if requested_page == 'dashboard' else 'projects'}"
    status_url = f"http://localhost:{api_port}/api/system/status"
    proc = None

    if not os.path.exists(dashboard_server_dir):
        print(f"Error: apps/web not found: {dashboard_server_dir}")
        sys.exit(1)

    if not _url_available(status_url, timeout=2):
        node_modules = os.path.join(dashboard_server_dir, "node_modules")
        if not os.path.exists(node_modules):
            print("[autoedit] node_modules not found. Running 'npm install'...")
            subprocess.run(["npm", "install"], cwd=dashboard_server_dir, check=True)

        print(f"[autoedit] Starting workspace from {dashboard_server_dir}")
        proc = subprocess.Popen(
            ["npm", "run", "dev:all"],
            cwd=dashboard_server_dir,
            env={**os.environ, "AUTOEDIT_PY_ROOT": project_root},
        )

        if not _wait_for_url(status_url, timeout=20):
            if proc.poll() is not None:
                print("[autoedit] Failed to start workspace.")
            else:
                print("[autoedit] Workspace did not become ready in time.")
                proc.terminate()
                proc.wait()
            sys.exit(1)

        print(f"[autoedit] Workspace started: {entry_path}")
    else:
        print(f"[autoedit] Reusing running workspace: {entry_path}")

    if args.video or args.json:
        print("[autoedit] Legacy single-video local initialization has been removed.")
        print(f"[autoedit] Open {entry_path} and upload files through the new dashboard/project flow.")

    if not args.no_browser:
        webbrowser.open(entry_path)

    if not proc:
        return

    try:
        proc.wait()
    except KeyboardInterrupt:
        print("\n[autoedit] Shutting down workspace...")
        proc.terminate()
        proc.wait()

def _url_available(url, timeout=2):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status < 500
    except Exception:
        return False


def _wait_for_url(url, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _url_available(url, timeout=2):
            return True
        time.sleep(1)
    return False


def cmd_config(args):
    """Read or update editing-related configuration."""
    updates = []

    if args.set_asr_model_size:
        updates.append(("asr_model_size", args.set_asr_model_size))
    if args.set_asr_language is not None:
        updates.append(("asr_language", args.set_asr_language))
    if args.set_asr_provider is not None:
        updates.append(("asr_provider", args.set_asr_provider))
    if args.set_workspace:
        updates.append(("workspace_dir", args.set_workspace))
    if args.set_output_dir:
        updates.append(("output_dir", args.set_output_dir))
    if args.set_public_base_url is not None:
        updates.append(("public_base_url", args.set_public_base_url))
    if args.set_dashboard_host:
        updates.append(("dashboard_host", args.set_dashboard_host))
    if args.set_dashboard_port:
        updates.append(("dashboard_port", args.set_dashboard_port))
    if args.set_api_port:
        updates.append(("api_port", args.set_api_port))
    if args.set_backend is not None:
        updates.append(("backend", args.set_backend))
    if args.set_model_source:
        updates.append(("model_source", args.set_model_source))
    if args.set_model_cache_dir is not None:
        updates.append(("model_cache_dir", args.set_model_cache_dir))
    if args.set_siliconflow_api_key is not None:
        updates.append(("siliconflow_api_key", args.set_siliconflow_api_key))
    if args.set_siliconflow_model:
        updates.append(("siliconflow_asr_model", args.set_siliconflow_model))
    if args.set_siliconflow_base_url:
        updates.append(("siliconflow_base_url", args.set_siliconflow_base_url))
    if args.set_deepgram_api_key is not None:
        updates.append(("deepgram_api_key", args.set_deepgram_api_key))
    if args.set_deepgram_model:
        updates.append(("deepgram_asr_model", args.set_deepgram_model))
    if args.set_deepgram_base_url:
        updates.append(("deepgram_base_url", args.set_deepgram_base_url))
    if args.set_dashscope_api_key is not None:
        updates.append(("dashscope_api_key", args.set_dashscope_api_key))
    if args.set_dashscope_model:
        updates.append(("dashscope_asr_model", args.set_dashscope_model))
    if args.set_dashscope_base_url:
        updates.append(("dashscope_base_url", args.set_dashscope_base_url))
    if args.set_dashscope_timeout_ms is not None:
        updates.append(("dashscope_task_timeout_ms", args.set_dashscope_timeout_ms))
    if args.set_agent_provider:
        updates.append(("agent_llm_provider", args.set_agent_provider))
    if args.set_agent_model:
        updates.append(("agent_llm_model", args.set_agent_model))

    for key, value in updates:
        save_config(key, value)
        print(f"{key} = {value}")

    if args.show or not updates:
        backend = get_backend()
        label = get_backend_label()
        available = check_dependency_available(backend)
        status = "installed" if available else "not installed"
        print(f"# Backend: {label} ({status})")
        print(json.dumps(load_config(), indent=2, ensure_ascii=False))


def build_parser():
    parser = argparse.ArgumentParser(
        description="autoedit CLI - ASR, subtitles, and agent-based video editing workspace",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
examples:
  autoedit asr audio.mp3 --format srt
  autoedit asr audio.mp3 --format json -o result.json
  autoedit asr-split audio.lines.json --line 10 --after "理解"
  autoedit cut
  autoedit config --show
""",
    )
    subparsers = parser.add_subparsers(dest="command")

    p_asr = subparsers.add_parser(
        "asr",
        help="Transcribe audio or generate subtitle files",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p_asr.add_argument("audio", help="Audio or video file path")
    p_asr.add_argument("--format", "-f", choices=["text", "json", "srt", "ass"], default="text")
    p_asr.add_argument("--language", "-l", help="Language hint")
    p_asr.add_argument("--model-size", choices=["1.7B", "0.6B"], help="ASR model size")
    p_asr.add_argument("-o", "--output", help="Output file path (for json)")
    p_asr.add_argument("--fix-dir", help="Directory containing fix_*.csv files")
    p_asr.add_argument("--resume-from", choices=["asr", "break", "fix", "render"], dest="resume_from")
    p_asr.add_argument("--max-chars", type=int, default=14, dest="max_chars")

    p_split = subparsers.add_parser("asr-split", help="Split long subtitle lines")
    p_split.add_argument("lines_json", help="Path to .lines.json file")
    p_split.add_argument("--csv", type=str, help="CSV file with split rules")
    p_split.add_argument("--line", type=int, help="1-based line number to split")
    p_split.add_argument("--after", type=str, help="Split after this text")

    p_align = subparsers.add_parser("align", help="Align provided transcript text against audio")
    p_align.add_argument("audio", help="Audio file path")
    p_align.add_argument("--text", help="Transcript text")
    p_align.add_argument("--text-file", help="Path to transcript text file")
    p_align.add_argument("--language", "-l", help="Language hint")
    p_align.add_argument("-o", "--output", help="Output JSON file path")

    p_cut = subparsers.add_parser("cut", help="Open the project-first editing workspace")
    p_cut.add_argument("--page", default="projects", help="Open page: projects or dashboard")
    p_cut.add_argument("--no-browser", action="store_true", help="Do not open browser automatically")
    p_cut.add_argument("--video", help="Deprecated local init option; use dashboard upload instead")
    p_cut.add_argument("--json", help="Deprecated local init option; use dashboard upload instead")
    p_cut.add_argument("--language", default="Chinese", help="Deprecated local init language hint")
    p_cut.add_argument("--dashboard-port", type=int, help="Dashboard port override")
    p_cut.add_argument("--api-port", type=int, help="API port override")

    p_conf = subparsers.add_parser("config", help="View and manage configuration")
    p_conf.add_argument("--show", action="store_true")
    p_conf.add_argument("--set-asr-model-size", choices=["1.7B", "0.6B"])
    p_conf.add_argument("--set-asr-language", metavar="LANG")
    p_conf.add_argument("--set-asr-provider", choices=["local", "siliconflow", "deepgram", "qwen_filetrans"])
    p_conf.add_argument("--set-workspace", metavar="PATH")
    p_conf.add_argument("--set-output-dir", metavar="PATH")
    p_conf.add_argument("--set-public-base-url", metavar="URL")
    p_conf.add_argument("--set-dashboard-host", metavar="HOST")
    p_conf.add_argument("--set-dashboard-port", type=int, metavar="PORT")
    p_conf.add_argument("--set-api-port", type=int, metavar="PORT")
    p_conf.add_argument("--set-backend", choices=["cuda", "mlx", ""])
    p_conf.add_argument("--set-model-source", choices=["modelscope", "huggingface"])
    p_conf.add_argument("--set-model-cache-dir", metavar="PATH")
    p_conf.add_argument("--set-siliconflow-api-key", metavar="KEY")
    p_conf.add_argument("--set-siliconflow-model", metavar="MODEL")
    p_conf.add_argument("--set-siliconflow-base-url", metavar="URL")
    p_conf.add_argument("--set-deepgram-api-key", metavar="KEY")
    p_conf.add_argument("--set-deepgram-model", metavar="MODEL")
    p_conf.add_argument("--set-deepgram-base-url", metavar="URL")
    p_conf.add_argument("--set-dashscope-api-key", metavar="KEY")
    p_conf.add_argument("--set-dashscope-model", metavar="MODEL")
    p_conf.add_argument("--set-dashscope-base-url", metavar="URL")
    p_conf.add_argument("--set-dashscope-timeout-ms", type=int, metavar="MS")
    p_conf.add_argument("--set-agent-provider", metavar="PROVIDER")
    p_conf.add_argument("--set-agent-model", metavar="MODEL")

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    if args.command == "asr":
        cmd_asr(args)
    elif args.command == "asr-split":
        cmd_asr_split(args)
    elif args.command == "align":
        cmd_align(args)
    elif args.command == "cut":
        cmd_cut(args)
    elif args.command == "config":
        cmd_config(args)


if __name__ == "__main__":
    main()
