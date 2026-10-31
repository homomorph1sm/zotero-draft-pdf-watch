import hashlib
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('builder', Path(__file__).resolve().parents[1] / 'build.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

class ReleaseTests(unittest.TestCase):
    def test_package_update_link_hash_and_reproducibility(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            package, update = builder.build(target)
            first = package.read_bytes()
            entry = update['addons']['draft-pdf-watch@local']['updates'][0]
            self.assertEqual(entry['update_hash'], 'sha256:' + hashlib.sha256(first).hexdigest())
            self.assertIn('/releases/download/v' + entry['version'] + '/', entry['update_link'])
            with zipfile.ZipFile(package) as archive:
                names = archive.namelist()
                self.assertIn('bootstrap.js', names)
                self.assertIn('content/core.js', names)
                self.assertTrue(all(info.create_system == 3 for info in archive.infolist()))
                self.assertFalse(any(n.startswith('tests/') or n.endswith('.sqlite') for n in names))
                manifest = json.loads(archive.read('manifest.json'))
                self.assertEqual(manifest['version'], entry['version'])
                page = archive.read('content/manager.xhtml').decode('utf-8')
                for asset in ('manager.css', 'manager.js'):
                    self.assertIn('"' + asset + '?v=' + entry['version'] + '"', page)
                self.assertTrue(manifest['applications']['zotero']['update_url'].endswith('/releases/latest/download/updates.json'))
            builder.build(target)
            self.assertEqual(first, package.read_bytes())

    def test_tag_must_match_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                builder.build(Path(directory), 'v99999.0.0')

if __name__ == '__main__':
    unittest.main()
