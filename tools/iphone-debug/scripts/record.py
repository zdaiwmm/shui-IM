import asyncio
import json
import signal
import struct
import time
import uuid
from pathlib import Path

from typer_injector import InjectingTyper
from pymobiledevice3.cli.cli_common import RSDServiceProviderDep, async_command
from pymobiledevice3.remote.core_device.display_service import DisplayService
from pymobiledevice3.remote.core_device.screen_stream import open_media_receiver

cli = InjectingTyper()


@cli.command()
@async_command
async def capture(service_provider: RSDServiceProviderDep, output: Path, seconds: int = 30, keyboard: str = ""):
    if not 1 <= seconds <= 180:
        raise ValueError("Duration must be 1..180 seconds")
    # The public entry point validates the target before passing touch coordinates.
    coords = [int(v) for v in keyboard.split(",")] if keyboard else []
    if coords and (seconds < 6 or len(coords) != 4 or any(v < 0 or v > 65535 for v in coords)):
        raise ValueError("Invalid touch coordinates")
    loop = asyncio.get_running_loop()
    owner = asyncio.current_task()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, owner.cancel)
    summary = {"schema": 1, "startedWall": time.time(), "packets": 0, "bytes": 0, "status": "incomplete"}
    try:
        async with DisplayService(service_provider) as display:
            transport, receiver_ip = open_media_receiver(display, (8 * 1024 * 1024,))
            session = None
            tasks = []
            highest = None
            last_frame = time.monotonic()
            try:
                answer = await asyncio.wait_for(display.start_video_stream(
                    receiver_ip=receiver_ip, receiver_port=transport.port,
                    sender_ip=service_provider.service.address[0], display_id=1), 10)
                session = uuid.UUID(str(answer["connection"]["options"]["avcMediaStreamOptionClientSessionID"]["uuid"]))
                config = answer["connection"]["streamConfig"]
                ready = asyncio.Event()

                async def receive():
                    nonlocal highest, last_frame
                    with (output / "capture.rtp").open("xb") as packets, (output / "timing.ndjson").open("x") as timing:
                        while True:
                            packet = await asyncio.wait_for(transport.recv(), 8)
                            if len(packet) < 12 or 64 <= packet[1] & 127 <= 95:
                                continue
                            seq = int.from_bytes(packet[2:4], "big")
                            if highest is None:
                                highest = seq
                            else:
                                delta = ((seq - (highest & 65535) + 32768) & 65535) - 32768
                                highest += max(0, delta)
                            summary["bytes"] += 4 + len(packet)
                            if summary["bytes"] > 256 * 1024 * 1024:
                                raise RuntimeError("Recording exceeded 256 MiB budget")
                            summary["packets"] += 1
                            packets.write(len(packet).to_bytes(4, "big") + packet)
                            if packet[1] & 128:
                                last_frame = time.monotonic()
                                timing.write(json.dumps({"wall": time.time(), "rtp": int.from_bytes(packet[4:8], "big")}) + "\n")
                                summary["framesReceived"] = summary.get("framesReceived", 0) + 1
                                ready.set()

                async def feedback():
                    while True:
                        await asyncio.sleep(1)
                        if time.monotonic() - last_frame > 8:
                            raise RuntimeError("No video frame for 8 seconds; check lock screen and stream health")
                        # Apple's streamConfig names SSRCs from the device's perspective.
                        ours, device = int(config["RemoteSSRC"]), int(config["LocalSSRC"])
                        rr = struct.pack("!BBHIIIIIII", 0x81, 201, 7, ours, device, 0, highest or 0, 0, 0, 0)
                        sdes = struct.pack("!BBHIBBBB", 0x81, 202, 2, ours, 1, 0, 0, 0)
                        await transport.sendto(rr + sdes, service_provider.service.address[0], int(config["SourcePort"]))

                async def exercise():
                    from pymobiledevice3.remote.core_device.hid_service import (
                        UniversalHIDServiceService, DIGITIZER_SURFACE_MAIN_TOUCHSCREEN,
                        TOUCHSCREEN_STATE_CONTACT, TOUCHSCREEN_STATE_RELEASE,
                    )
                    async with UniversalHIDServiceService(service_provider) as hid:
                        async def tap(x, y):
                            try:
                                await hid.send_touchscreen(TOUCHSCREEN_STATE_CONTACT, x, y, service_id=DIGITIZER_SURFACE_MAIN_TOUCHSCREEN)
                                await asyncio.sleep(0.05)
                            finally:
                                await hid.send_touchscreen(TOUCHSCREEN_STATE_RELEASE, x, y, service_id=DIGITIZER_SURFACE_MAIN_TOUCHSCREEN)
                        with (output / "actions.ndjson").open("x") as actions:
                            await asyncio.sleep(1)
                            for _ in range(max(1, (seconds - 2) // 4)):
                                for kind, point in [("focus", coords[:2]), ("dismiss", coords[2:])]:
                                    actions.write(json.dumps({"wall": time.time(), "action": kind}) + "\n")
                                    actions.flush()
                                    await tap(*point)
                                    await asyncio.sleep(1.5)
                            await asyncio.Event().wait()

                tasks = [asyncio.create_task(receive()), asyncio.create_task(feedback())]
                ready_task = asyncio.create_task(asyncio.wait_for(ready.wait(), 8))
                tasks.append(ready_task)
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
                tasks.remove(ready_task)
                print("CAPTURE_READY", flush=True)
                if coords:
                    tasks.append(asyncio.create_task(exercise()))
                timer = asyncio.create_task(asyncio.sleep(seconds))
                tasks.append(timer)
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
                if timer not in done:
                    raise RuntimeError("Recording worker stopped early")
                summary["status"] = "complete"
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                if session:
                    try:
                        await asyncio.wait_for(display.stop_media_stream(session), 5)
                        summary["streamStopped"] = True
                    except Exception:
                        summary["streamStopped"] = False
                transport.close()
    finally:
        summary["endedWall"] = time.time()
        (output / "capture.json").write_text(json.dumps(summary, indent=2) + "\n")
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(sig)
    print("CAPTURE_FINISHED", flush=True)


if __name__ == "__main__":
    cli()
