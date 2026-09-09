import json
from pathlib import Path
import struct
import tempfile
import unittest

from device import cleanup, https_check, select_device
from decode import rtp


class DeviceTests(unittest.TestCase):
    def test_selection_never_picks_arbitrary_device(self):
        one = {"ConnectionType": "USB", "DeviceClass": "iPhone", "Identifier": "one"}
        two = {**one, "Identifier": "two"}
        self.assertEqual(select_device([one, two], "two"), two)
        for devices in ([], [one, two], [{**one, "ConnectionType": "Network"}]):
            with self.assertRaises(ValueError):
                select_device(devices)

    def test_https_rejects_credentials_query_and_http(self):
        for origin in ("http://localhost", "https://user:secret@localhost", "https://localhost/?invite=secret", "https://localhost/path"):
            with self.assertRaises(ValueError):
                https_check(origin, None)

    def test_cleanup_only_owned_media_and_preserves_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "capture.rtp").write_bytes(b"media")
            (folder / "timing.ndjson").write_text("numbers")
            manifest = folder / "manifest.json"
            manifest.write_text(json.dumps({"tool": "iphone-debug-v1", "media": ["capture.rtp"]}))
            cleanup(folder)
            self.assertFalse((folder / "capture.rtp").exists())
            self.assertTrue((folder / "timing.ndjson").exists())
            manifest.write_text(json.dumps({"tool": "iphone-debug-v1", "media": ["../other"]}))
            with self.assertRaises(ValueError):
                cleanup(folder)

    def test_rtp_extensions_padding_and_timestamp(self):
        header = struct.pack("!BBHII", 0xB1, 0xE0, 65535, 0xffffffff, 4)
        packet = header + b"\0" * 4 + b"\0\0\0\1" + b"ext!" + b"payload" + b"\0\2"
        self.assertEqual(rtp(packet), (65535, 0xffffffff, True, b"payload"))
        for packet in (b"", b"\x80" * 11, header, header + b"\0" * 8):
            with self.assertRaises(ValueError):
                rtp(packet)


if __name__ == "__main__":
    unittest.main()
