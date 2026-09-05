"""Guard the generated static pages against missing assets and stale builds."""
import collections
from html.parser import HTMLParser
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]


class PageReferences(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.ids = []
        self.references = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if attrs.get("id"):
            self.ids.append(attrs["id"])
        for key in ("href", "src"):
            if attrs.get(key):
                self.references.append(attrs[key])


class SiteBuildTests(unittest.TestCase):
    def test_every_local_page_resource_exists(self):
        for page in ROOT.glob("*.html"):
            parsed = PageReferences(page.read_text())
            for reference in parsed.references:
                url = urlsplit(reference)
                if url.scheme or url.netloc or not url.path:
                    continue
                with self.subTest(page=page.name, resource=url.path):
                    self.assertTrue((ROOT / url.path).is_file())

    def test_chart_and_control_ids_are_unique(self):
        for page in ROOT.glob("*.html"):
            counts = collections.Counter(PageReferences(page.read_text()).ids)
            with self.subTest(page=page.name):
                self.assertEqual([key for key, n in counts.items() if n > 1], [])

    def test_generated_pages_are_current_and_build_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for file in ("build_pages.py", "cycling-analysis.html", "dashboard.html"):
                shutil.copy2(ROOT / file, target / file)
            (target / "assets").symlink_to(ROOT / "assets", target_is_directory=True)
            command = [sys.executable, str(target / "build_pages.py")]
            subprocess.run(command, check=True, capture_output=True)
            first = {page.name: page.read_bytes() for page in target.glob("*.html")}
            self.assertEqual(len(first), 10)
            subprocess.run(command, check=True, capture_output=True)
            for name, contents in first.items():
                with self.subTest(page=name):
                    self.assertEqual(contents, (target / name).read_bytes())
                    self.assertEqual(contents, (ROOT / name).read_bytes())


if __name__ == "__main__":
    unittest.main()
