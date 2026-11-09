"""Use Lightsail's expiring SSH certificate on an ephemeral GitHub runner."""
import json
import subprocess
import os
import ipaddress
import re
from pathlib import Path

instance = "QuietRoom-Tokyo-Public"
directory = Path(os.environ["RUNNER_TEMP"]) / "lightsail-session"
directory.mkdir(mode=0o700)
os.umask(0o077)
response = subprocess.check_output([
    "aws", "lightsail", "get-instance-access-details", "--region", "ap-northeast-1",
    "--instance-name", instance, "--protocol", "ssh", "--output", "json",
])
details = json.loads(response)["accessDetails"]
if (details["instanceName"], details["username"], details["protocol"]) != (instance, "ubuntu", "ssh"):
    raise ValueError("Unexpected Lightsail target")
host = str(ipaddress.IPv4Address(details["ipAddress"]))
key = directory / "tempkey"
key.write_text(details["privateKey"].strip() + "\n")
key.with_name("tempkey-cert.pub").write_text(details["certKey"].strip() + "\n")
hosts = []
for entry in details["hostKeys"]:
    algorithm = entry["algorithm"]
    if algorithm not in ("ssh-ed25519", "ecdsa-sha2-nistp256", "ssh-rsa"):
        continue
    parts = entry["publicKey"].split()
    blob = parts[1] if len(parts) >= 2 and parts[0] == algorithm else parts[0]
    if re.fullmatch(r"[A-Za-z0-9+/]+=*", blob):
        hosts.append(f"{host} {algorithm} {blob}")
if not hosts:
    raise ValueError("Missing authenticated server host keys")
ssh_dir = Path.home() / ".ssh"
ssh_dir.mkdir(mode=0o700, exist_ok=True)
with (ssh_dir / "known_hosts").open("a") as known:
    known.write("\n" + "\n".join(hosts) + "\n")
config = directory / "deploy.json"
config.write_text(json.dumps(dict(environment="tokyo-public", serverHost=host, serverUser="ubuntu",
                                 serverKey=str(key), publicOrigin="https://mijiu.cloud")))
with Path(os.environ["GITHUB_ENV"]).open("a") as env:
    env.write(f"QUIET_ROOM_DEPLOY_CONFIG={config}\n")
