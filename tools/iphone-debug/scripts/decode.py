"""Decode length-prefixed RTP/HEVC packets; retain source timestamps in MP4."""
import argparse
from fractions import Fraction
import json
from pathlib import Path


def rtp(packet):
    if len(packet) < 12 or packet[0] >> 6 != 2:
        raise ValueError("Truncated or unsupported RTP header")
    header = 12 + (packet[0] & 15) * 4
    if packet[0] & 16:
        if len(packet) < header + 4:
            raise ValueError("Truncated RTP extension")
        header += 4 + int.from_bytes(packet[header + 2:header + 4], "big") * 4
    end = len(packet)
    if packet[0] & 32:
        padding = packet[-1]
        if not padding or padding > end - header:
            raise ValueError("Invalid RTP padding")
        end -= padding
    if header >= end:
        raise ValueError("Empty or truncated RTP payload")
    return (int.from_bytes(packet[2:4], "big"), int.from_bytes(packet[4:8], "big"), bool(packet[1] & 128), packet[header:end])


def decode(output):
    import av
    from pymobiledevice3.remote.core_device.screen_stream import depacketize_hevc
    target = output / "capture.mp4"
    if target.exists():
        raise ValueError("MP4 already exists; refusing to overwrite")
    codec = av.CodecContext.create("hevc", "r")
    fragment, units = bytearray(), []
    first, previous = None, None
    stats = {"schema": 1, "frames": 0, "sequenceDiscontinuities": 0, "decodeErrors": 0, "seconds": 0, "resolutionChanges": 0,
             "warning": "Encoder artifacts may occur even without packet loss. Verify visually."}
    stream = None
    dimensions = None
    with av.open(str(target), "w") as movie:
        def emit(frame):
            nonlocal stream, dimensions
            size = (frame.width, frame.height)
            if dimensions and size != dimensions:
                stats["resolutionChanges"] += 1
            dimensions = size
            if stream is None:
                stream = movie.add_stream("libx264", rate=60)
                stream.width, stream.height = size
                stream.pix_fmt = "yuv420p"
                stream.time_base = Fraction(1, 24000)
                stream.options = {"crf": "18", "preset": "fast"}
            t = float(frame.pts * frame.time_base)
            frame = frame.reformat(stream.width, stream.height, format="yuv420p")
            frame.pts, frame.time_base = round(t * 24000), Fraction(1, 24000)
            for encoded in stream.encode(frame):
                movie.mux(encoded)
            stats["frames"] += 1
            stats["seconds"] = t

        with (output / "capture.rtp").open("rb") as source:
            while prefix := source.read(4):
                if len(prefix) != 4:
                    raise ValueError("Truncated packet length")
                length = int.from_bytes(prefix, "big")
                if not 12 <= length <= 65535:
                    raise ValueError("Invalid packet length")
                packet = source.read(length)
                if len(packet) != length:
                    raise ValueError("Truncated packet")
                seq, timestamp, marker, payload = rtp(packet)
                if previous is not None and seq != (previous + 1) & 65535:
                    stats["sequenceDiscontinuities"] += 1
                    fragment.clear()
                    units.clear()
                previous = seq
                if first is None:
                    first = timestamp
                depacketize_hevc(payload, fragment, units)
                if marker and units:
                    compressed = av.Packet(b"".join(b"\x00\x00\x00\x01" + unit for unit in units))
                    compressed.pts = compressed.dts = (timestamp - first) & 0xffffffff
                    compressed.time_base = Fraction(1, 24000)
                    try:
                        for frame in codec.decode(compressed):
                            emit(frame)
                    except av.error.InvalidDataError:
                        stats["decodeErrors"] += 1
                    units.clear()
        for frame in codec.decode(None):
            emit(frame)
        if stream:
            for encoded in stream.encode():
                movie.mux(encoded)
    (output / "decode.json").write_text(json.dumps(stats, indent=2) + "\n")
    if not stats["frames"]:
        raise ValueError("No frames decoded")
    print(json.dumps(stats))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    decode(parser.parse_args().output)
