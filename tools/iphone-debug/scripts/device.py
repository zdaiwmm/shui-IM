"""Persistent entry point; standard library only until the explicit setup step."""
import argparse
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import urllib.request
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = Path(os.environ.get("IPHONE_DEBUG_RUNTIME", Path.home() / ".cache/iphone-debug/venv"))


def run(command, *, timeout=30, capture=False, env=None):
    process = subprocess.Popen(command, text=True, env=env,
                               stdout=subprocess.PIPE if capture else None,
                               stderr=subprocess.PIPE if capture else None)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        process.terminate()
        try:
            process.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
        raise
    if process.returncode:
        raise subprocess.CalledProcessError(process.returncode, command, stdout, stderr)
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def select_device(devices, requested=None):
    phones = [d for d in devices if d.get("ConnectionType") == "USB" and d.get("DeviceClass") == "iPhone"]
    if requested:
        phones = [d for d in phones if d.get("Identifier") == requested]
    if len(phones) != 1:
        raise ValueError("Connect one USB iPhone, or select a connected iPhone with --device.")
    return phones[0]


def https_check(origin, ca):
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("--origin must be a bare HTTPS origin without credentials or query.")
    context = ssl.create_default_context(cafile=ca)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=context))
    with opener.open(origin, timeout=10) as response:
        return {"origin": origin, "status": response.status, "certificateVerified": True}


def cleanup(output):
    if output.is_symlink() or (output / "manifest.json").is_symlink():
        raise ValueError("Refusing symlinked run or manifest.")
    output = output.resolve()
    manifest = json.loads((output / "manifest.json").read_text())
    if manifest.get("tool") != "iphone-debug-v1":
        raise ValueError("Not an iphone-debug run.")
    allowed = {"capture.rtp", "capture.mp4", "screen.png"}
    for name in manifest["media"]:
        if name not in allowed:
            raise ValueError("Unexpected media path in manifest.")
    for name in manifest["media"]:
        (output / name).unlink(missing_ok=True)
    manifest["mediaCleaned"] = True
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description="USB iPhone diagnostics on macOS; setup once, reuse afterward.")
    parser.add_argument("command", choices=["setup", "install-skill", "doctor", "screenshot", "record", "decode", "cleanup"])
    parser.add_argument("--device", help="USB device identifier; auto-select only when exactly one iPhone exists")
    parser.add_argument("--output", type=Path, help="New private run directory; existing directory only for decode/cleanup")
    parser.add_argument("--seconds", type=int, default=30, choices=range(1, 181), metavar="1..180")
    parser.add_argument("--origin")
    parser.add_argument("--ca", help="Trusted local CA PEM for HTTPS doctor")
    parser.add_argument("--keyboard", help="Input x,y and safe-dismiss x,y, normalized 0..65535")
    parser.add_argument("--target-verified", action="store_true", help="Current screenshot and project origin were verified before authorized touches")
    args = parser.parse_args()
    if args.command == "install-skill":
        destination = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "skills/iphone-debug"
        shutil.copytree(ROOT, destination, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        print(f"SKILL_INSTALLED {destination}")
        return
    if args.command == "setup":
        if sys.version_info < (3, 12):
            parser.error("Use Python 3.12+ to create the runtime.")
        if not (RUNTIME / "bin/python").exists():
            run([sys.executable, "-m", "venv", str(RUNTIME)], timeout=120)
        run([str(RUNTIME / "bin/python"), "-m", "pip", "install", "-r", str(ROOT / "requirements.txt")], timeout=600)
        print(f"RUNTIME_READY {RUNTIME}")
        return
    if args.command == "cleanup":
        if not args.output:
            parser.error("--output required")
        cleanup(args.output)
        return
    python = str(RUNTIME / "bin/python")
    if not Path(python).exists():
        parser.error("Runtime missing. Run setup with Python 3.12+ first.")
    if args.command == "decode":
        if not args.output:
            parser.error("--output required")
        run([python, str(ROOT / "scripts/decode.py"), str(args.output)], timeout=300)
        return
    base = [python, "-m", "pymobiledevice3"]
    devices = json.loads(run(base + ["usbmux", "list"], capture=True).stdout)
    device = select_device(devices, args.device)
    env = {**os.environ, "PYMOBILEDEVICE3_UDID": device["Identifier"]}
    if args.command == "doctor":
        print(json.dumps({"device": device["ProductType"], "ios": device["ProductVersion"], "id": device["Identifier"], "runtime": str(RUNTIME)}, indent=2), flush=True)
        run(base + ["developer", "core-device", "display", "get-media-support-info", "--native"], env=env)
        try:
            state = run(base + ["developer", "core-device", "get-lockstate", "--native"], capture=True, env=env)
            print(state.stdout)
        except subprocess.CalledProcessError:
            print(json.dumps({"lockState": "unknown", "note": "Lock-state query unavailable; verify the device screen before interaction."}))
        if args.origin:
            print(json.dumps(https_check(args.origin, args.ca)))
        return
    if not args.output:
        parser.error("--output required")
    if args.keyboard:
        coords = [int(v) for v in args.keyboard.split(",")]
        if args.command != "record" or args.seconds < 6 or not args.target_verified or len(coords) != 4 or any(v < 0 or v > 65535 for v in coords):
            parser.error("Keyboard recording requires four valid coordinates and --target-verified.")
    args.output = args.output.resolve()
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    media = ["screen.png"] if args.command == "screenshot" else ["capture.rtp", "capture.mp4"]
    (args.output / "manifest.json").write_text(json.dumps({"tool": "iphone-debug-v1", "media": media, "device": device["ProductType"], "ios": device["ProductVersion"]}, indent=2) + "\n")
    if args.command == "screenshot":
        run(base + ["developer", "core-device", "screen-capture", "screenshot", "--native", str(args.output / "screen.png")], env=env)
    else:
        command = [python, str(ROOT / "scripts/record.py"), "--native", str(args.output), "--seconds", str(args.seconds)]
        if args.keyboard:
            command += ["--keyboard", args.keyboard]
        run(command, timeout=args.seconds + 45, env=env)
        run([python, str(ROOT / "scripts/decode.py"), str(args.output)], timeout=300)
    print(f"ARTIFACTS {args.output}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
