"""
voxelize_meshes.py — convert Allen CCFv3 meshes (.glb) into a 3D voxel volume.

Produces:
  meshes_volume.npy      uint16 NumPy array, shape (X, Y, Z)
                         matching the ABC annotation axis convention
                         (axis-0 = A-P, axis-1 = S-I, axis-2 = L-R).
  meshes_volume.json     metadata: shape, stride, voxel_size_um, ids_used

Each voxel is the structure_id of the deepest (most specific) mesh that
contains it. Deep-before-shallow is implemented by voxelizing meshes in
depth order (deepest first) and writing only to empty voxels.

Usage:
  python voxelize_meshes.py [--meshes-dir ./meshes] [--stride 3]
                            [--out meshes_volume]
"""

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np

# Windows consoles default stdout/stderr to the system codepage (cp1252),
# which can't encode characters like the arrow in the "[remap] ... →" print
# below — that raised UnicodeEncodeError and crashed the script after the
# (slow) voxelization pass had already finished, before the volume was ever
# saved to disk. Force UTF-8 so any such character is safe.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

try:
    import trimesh
except ImportError:
    print("trimesh not installed. Install via:  pip install trimesh", file=sys.stderr)
    sys.exit(1)


# --- Allen CCFv3 volume grid (10 µm full resolution) ----------------------
# Matches the ABC annotation volume dimensions (axis-0 A-P, axis-1 S-I, axis-2 L-R)
FULL_SHAPE_UM = (13200, 8000, 11400)   # total extent of the reference space
FULL_VOXELS   = (1320, 800, 1140)      # at 10 µm per voxel
BASE_VOXEL_UM = 10                     # reference grid voxel size


def load_ontology_depths():
    """Fetch Allen ontology and return dict: structure_id -> tree depth.
    Root has depth 0, deeper nodes have larger depths.
    """
    url = "http://api.brain-map.org/api/v2/structure_graph_download/1.json"
    print(f"[ontology] fetching {url}")
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.loads(r.read().decode("utf-8"))
    depths = {}
    def walk(node, d):
        depths[int(node["id"])] = d
        for c in node.get("children") or []:
            walk(c, d + 1)
    walk(data["msg"][0], 0)
    return depths


def load_ontology_hex_colors():
    """Return dict: structure_id -> hex string, from the ontology JSON."""
    url = "http://api.brain-map.org/api/v2/structure_graph_download/1.json"
    with urllib.request.urlopen(url, timeout=30) as r:
        data = json.loads(r.read().decode("utf-8"))
    colors = {}
    def walk(node):
        hx = (node.get("color_hex_triplet") or "").strip()
        if hx:
            colors[int(node["id"])] = hx
        for c in node.get("children") or []:
            walk(c)
    walk(data["msg"][0])
    return colors


def voxelize_one_mesh(mesh_path: Path, grid_origin_um, grid_shape_vox, voxel_um):
    """Voxelize one mesh. Returns a tuple (i_min, mask_local) or (None, error_msg).

    Uses trimesh's native mesh.voxelized(pitch) which is much faster than
    per-point mesh.contains() — uses surface rasterization + flood-fill under
    the hood, and doesn't require rtree.

    Allen mesh axis convention (verified empirically):
        mesh.x -> L-R   (volume axis-2)
        mesh.y -> S-I   (volume axis-1)
        mesh.z -> A-P   (volume axis-0)

    We swap axes on load so the resulting grid is (A-P, S-I, L-R) to
    match the ABC annotation convention.
    """
    try:
        # force='mesh': .glb files are technically a whole "scene" (even
        # though ours only ever has one mesh in it), so without this we'd
        # get back a trimesh.Scene instead of a plain mesh.
        mesh = trimesh.load(str(mesh_path), process=False, force='mesh')
    except Exception as e:
        return None, f"load error: {e}"
    if mesh.is_empty or not hasattr(mesh, "vertices") or len(mesh.faces) == 0:
        return None, "empty / no faces"

    # Swap axes: mesh (x, y, z) -> atlas (z, y, x)
    mesh.vertices = mesh.vertices[:, [2, 1, 0]].copy()

    # Voxelize to a grid of `pitch` (µm per voxel) — fast native routine.
    try:
        vg = mesh.voxelized(pitch=voxel_um).fill()
    except Exception as e:
        return None, f"voxelize error: {e}"
    if vg is None or vg.matrix is None or vg.matrix.size == 0:
        return None, "empty voxel grid"

    # vg.matrix is bool array. vg.translation is the origin (µm) of voxel (0,0,0).
    local_shape = vg.matrix.shape
    # Compute the integer voxel coordinate in the atlas grid for vg voxel (0,0,0).
    origin = vg.translation            # (3,) in µm
    i_min = np.floor((origin - np.array(grid_origin_um)) / voxel_um).astype(int)

    # Clip to atlas grid bounds
    i_max = i_min + np.array(local_shape, dtype=int)
    grid_shape_arr = np.array(grid_shape_vox, dtype=int)
    # If entirely out of bounds, skip
    if np.any(i_max <= 0) or np.any(i_min >= grid_shape_arr):
        return None, "bbox out of grid"

    # Intersect with grid bounds: compute cropped slices
    crop_lo = np.maximum(0, -i_min)
    crop_hi = np.array(local_shape, dtype=int) - np.maximum(0, i_max - grid_shape_arr)
    if np.any(crop_hi <= crop_lo):
        return None, "bbox collapsed after clipping"
    mask = vg.matrix[crop_lo[0]:crop_hi[0],
                     crop_lo[1]:crop_hi[1],
                     crop_lo[2]:crop_hi[2]]
    i_min = np.maximum(0, i_min)

    return (i_min, mask), None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meshes-dir", type=Path, default=Path("meshes"))
    ap.add_argument("--stride",     type=int, default=3, help="voxel stride vs 10µm grid")
    ap.add_argument("--out",        type=str, default="meshes_volume")
    ap.add_argument("--limit",      type=int, default=0, help="debug: only first N meshes")
    ap.add_argument("--shell-id",   type=int, default=997,
                    help="use this mesh's bounds as the voxel grid origin/extent "
                         "(default 997 = root/whole brain shell)")
    args = ap.parse_args()

    meshes_dir = args.meshes_dir
    if not meshes_dir.exists():
        print(f"error: meshes dir {meshes_dir} not found", file=sys.stderr)
        sys.exit(1)

    # Derive grid params from the shell mesh's actual bounds so this grid
    # aligns with the 3D scene (same coordinate system as all other meshes).
    shell_path = meshes_dir / f"{args.shell_id}.glb"
    if not shell_path.exists():
        print(f"warning: shell mesh {shell_path} not found; using full CCF extent")
        voxel_um = BASE_VOXEL_UM * args.stride
        grid_origin_um = (0.0, 0.0, 0.0)
        grid_shape = tuple(max(1, int(np.ceil(FULL_VOXELS[i] / args.stride)))
                           for i in range(3))
    else:
        shell = trimesh.load(str(shell_path), process=False, force='mesh')
        # Same axis swap as voxelize_one_mesh: mesh (x,y,z) -> atlas (z,y,x)
        shell_verts = shell.vertices[:, [2, 1, 0]]
        s_min = shell_verts.min(axis=0)
        s_max = shell_verts.max(axis=0)
        voxel_um = BASE_VOXEL_UM * args.stride
        # Pad by half a voxel so the shell surface lies fully inside the grid
        grid_origin_um = tuple(float(s_min[i] - voxel_um * 0.5) for i in range(3))
        extent_um = (s_max - s_min) + voxel_um
        grid_shape = tuple(int(np.ceil(extent_um[i] / voxel_um)) for i in range(3))
        print(f"[shell] id={args.shell_id} bounds(atlas-axis)=min{tuple(s_min)} max{tuple(s_max)}")

    print(f"[grid] origin={grid_origin_um}µm  shape={grid_shape}  voxel={voxel_um}µm  stride={args.stride}")
    extent = tuple(grid_shape[i]*voxel_um for i in range(3))
    print(f"[grid] extent={extent}µm")

    # Collect mesh files
    mesh_files = sorted(p for p in meshes_dir.glob("*.glb")
                        if p.stat().st_size > 0)
    if args.limit > 0:
        mesh_files = mesh_files[:args.limit]
    print(f"[input] {len(mesh_files)} mesh files")

    # Ontology depth for children-wins ordering
    try:
        depths = load_ontology_depths()
    except Exception as e:
        print(f"warning: couldn't fetch ontology ({e}); falling back to depth=0 for all")
        depths = {}

    # Sort meshes by depth DESCENDING so deepest mesh is voxelized first
    def mesh_depth(p):
        try:
            return depths.get(int(p.stem), 0)
        except ValueError:
            return 0
    mesh_files.sort(key=mesh_depth, reverse=True)

    # Output volume
    vol = np.zeros(grid_shape, dtype=np.uint32)
    ids_written = set()

    t_start = time.time()
    for n, mp in enumerate(mesh_files, 1):
        try:
            sid = int(mp.stem)
        except ValueError:
            continue
        t0 = time.time()
        result, err = voxelize_one_mesh(mp, grid_origin_um, grid_shape, voxel_um)
        if err or result is None:
            print(f"[{n:4d}/{len(mesh_files)}] sid={sid:<6d} SKIP ({err})")
            continue
        (i_min, mask) = result
        # Write only to voxels that are still empty (depth: first-writer wins,
        # and because we sorted deepest-first, that's "most specific wins")
        sl = (slice(i_min[0], i_min[0] + mask.shape[0]),
              slice(i_min[1], i_min[1] + mask.shape[1]),
              slice(i_min[2], i_min[2] + mask.shape[2]))
        target = vol[sl]
        write_mask = mask & (target == 0)
        target[write_mask] = sid
        vol[sl] = target
        ids_written.add(sid)
        dt = time.time() - t0
        print(f"[{n:4d}/{len(mesh_files)}] sid={sid:<6d} depth={mesh_depth(mp):<2d} "
              f"added={int(write_mask.sum()):>9d} vox  ({dt:.2f}s)")

    dt_total = time.time() - t_start
    print(f"\n[done] {dt_total/60:.1f} min total, {len(ids_written)} ids written")
    print(f"[vol] non-zero voxels: {int((vol != 0).sum())} / {vol.size} "
          f"({100*(vol != 0).mean():.1f}%)")

    # --- Remap structure_ids to dense compact indices -----------------------
    # Real Allen structure_ids can exceed 65535 (some are 9-digit numbers for
    # finely-split regions). We remap them to compact 1..N indices so the
    # volume fits in uint16 and the LUT stays tiny.
    sorted_ids = sorted(ids_written)
    sid_to_idx = {sid: i + 1 for i, sid in enumerate(sorted_ids)}  # 1-based; 0 = empty
    remapped = np.zeros_like(vol, dtype=np.uint16)
    for sid, idx in sid_to_idx.items():
        remapped[vol == sid] = idx
    vol = remapped
    print(f"[remap] {len(sorted_ids)} ids → compact indices 1..{len(sorted_ids)}")

    # Save
    out_npy = Path(f"{args.out}.npy")
    out_json = Path(f"{args.out}.json")
    np.save(out_npy, vol)

    # Record both coordinate conventions:
    # - volume-axis origin/size: the grid in atlas axis order (A-P, S-I, L-R),
    #   matching np.load(meshes_volume.npy) indexing
    # - scene-coord origin/size: what the Three.js shader should use to
    #   normalize world positions; atlas axes X (0) and Z (2) are swapped
    #   because the mesh's own vertex convention is (L-R, S-I, A-P)
    scene_origin_um = (grid_origin_um[2], grid_origin_um[1], grid_origin_um[0])
    scene_size_um   = (grid_shape[2]*voxel_um, grid_shape[1]*voxel_um, grid_shape[0]*voxel_um)
    meta = {
        "shape": list(grid_shape),
        "dtype": "uint16",
        "stride": args.stride,
        "voxel_size_um": voxel_um,
        "original_shape": list(FULL_VOXELS),
        "idx_to_sid": [0] + sorted_ids,
        "ids_written": sorted_ids,
        "origin_um": list(grid_origin_um),            # atlas-axis order
        "scene_origin_um": list(scene_origin_um),     # scene (mesh) axis order
        "scene_size_um": list(scene_size_um),
    }
    out_json.write_text(json.dumps(meta, indent=2))
    print(f"[save] {out_npy}  ({out_npy.stat().st_size/1024/1024:.1f} MB)")
    print(f"[save] {out_json}")


if __name__ == "__main__":
    main()
