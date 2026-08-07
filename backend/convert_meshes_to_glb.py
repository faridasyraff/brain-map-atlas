"""
convert_meshes_to_glb.py — one-time conversion of the downloaded Allen CCFv3
mesh files from .obj (plain text, large) to .glb (binary, much smaller).

Allen only publishes meshes as .obj, so _ensure_meshes() in App.py still
downloads that format — this script (and the same conversion step baked
into _ensure_meshes() for future downloads) is what turns them into the
smaller format the app actually serves to the browser.

Usage:
  python convert_meshes_to_glb.py [--meshes-dir ./meshes] [--delete-obj]
"""
import argparse
import sys
from pathlib import Path

import trimesh

# Same fix as voxelize_meshes.py and App.py: Windows consoles don't always
# handle non-ASCII output cleanly, which has crashed scripts here before.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--meshes-dir', type=Path, default=Path('meshes'))
    ap.add_argument('--delete-obj', action='store_true',
                     help='Remove each .obj file once it has been converted (frees disk space)')
    args = ap.parse_args()

    if not args.meshes_dir.exists():
        print(f'error: meshes dir {args.meshes_dir} not found', file=sys.stderr)
        sys.exit(1)

    obj_files = sorted(args.meshes_dir.glob('*.obj'))
    if not obj_files:
        print('No .obj files found — nothing to convert.')
        return

    total_obj_bytes = 0
    total_glb_bytes = 0
    failed = []

    for i, obj_path in enumerate(obj_files, 1):
        glb_path = obj_path.with_suffix('.glb')
        try:
            mesh = trimesh.load(obj_path, force='mesh')
            mesh.export(glb_path)
        except Exception as e:
            print(f'[{i}/{len(obj_files)}] FAILED {obj_path.name}: {e}')
            failed.append(obj_path.name)
            continue

        obj_size = obj_path.stat().st_size
        glb_size = glb_path.stat().st_size
        total_obj_bytes += obj_size
        total_glb_bytes += glb_size
        print(f'[{i}/{len(obj_files)}] {obj_path.name}: {obj_size/1024:.0f}KB -> {glb_size/1024:.0f}KB')

        if args.delete_obj:
            obj_path.unlink()

    print()
    print(f'Done. {len(obj_files) - len(failed)}/{len(obj_files)} converted.')
    if failed:
        print(f'Failed ({len(failed)}): {failed}')
    if total_obj_bytes:
        pct = 100 * (1 - total_glb_bytes / total_obj_bytes)
        print(f'Total size: {total_obj_bytes/1024/1024:.1f}MB -> {total_glb_bytes/1024/1024:.1f}MB ({pct:.0f}% smaller)')


if __name__ == '__main__':
    main()
