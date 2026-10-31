"""Build a reproducible XPI and Zotero update manifest using stdlib only."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parent

def build(output, tag=None):
    manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    version = manifest['version']
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Release version must be x.y.z')
    if tag and tag != 'v' + version:
        raise ValueError('Git tag does not match manifest.json version')
    app = manifest['applications']['zotero']
    match = re.fullmatch(r'https://github.com/([\w.-]+/[\w.-]+)/releases/latest/download/updates.json', app['update_url'])
    if not match:
        raise ValueError('Expected a public GitHub Releases update URL')
    repository = match.group(1)
    output.mkdir(parents=True, exist_ok=True)
    package = output / f'draft-pdf-watch-{version}.xpi'
    paths = [ROOT / name for name in ('manifest.json', 'bootstrap.js', 'LICENSE')]
    for directory in ('content', 'locale'):
        paths.extend(p for p in (ROOT / directory).rglob('*') if p.is_file())
    with zipfile.ZipFile(package, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(paths):
            info = zipfile.ZipInfo(path.relative_to(ROOT).as_posix(), (2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            content = path.read_bytes()
            if path.suffix in ('.js', '.css', '.xhtml', '.ftl', '.json') or path.name == 'LICENSE':
                content = content.replace(b'\r\n', b'\n')
            archive.writestr(info, content)
    digest = hashlib.sha256(package.read_bytes()).hexdigest()
    updates = {'addons': {app['id']: {'updates': [{
        'version': version,
        'update_link': f'https://github.com/{repository}/releases/download/v{version}/{package.name}',
        'update_hash': 'sha256:' + digest,
        'applications': {'zotero': {k: app[k] for k in ('strict_min_version', 'strict_max_version')}}
    }]}}}
    (output / 'updates.json').write_text(json.dumps(updates, indent=2) + '\n', encoding='utf-8')
    (output / 'SHA256SUMS.txt').write_text(f'{digest}  {package.name}\n', encoding='utf-8')
    print(json.dumps({'version': version, 'xpi': str(package), 'sha256': digest}))
    return package, updates

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, default=ROOT / 'dist')
    parser.add_argument('--tag')
    args = parser.parse_args()
    build(args.out, args.tag)
