#!/usr/bin/env python3
"""Transfer a reference photo's tone and color onto a user photo, pixel for pixel.

This is a color transform, not a renderer: it never synthesizes or moves image
content. Inputs are interpreted as sRGB unless an embedded 8-bit ICC profile
can be converted to sRGB. Tone is fitted with a smoothed empirical quantile
curve; Lab a/b mean and deviation are then matched (a Reinhard-style transform,
distinct from the original paper's l-alpha-beta color space).
"""
from __future__ import annotations

import argparse
import io
from pathlib import Path
import sys

import cv2
import numpy as np
from PIL import Image, ImageCms
from skimage.color import rgb2lab


def _read(path: Path) -> tuple[np.ndarray, np.ndarray | None, bytes | None]:
    """Read unchanged depth/channel data; return RGB(A), alpha, and ICC bytes."""
    arr = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if arr is None:
        raise ValueError(f"Could not read image: {path}")
    icc = None
    orientation = 1
    if path.suffix.lower() in {".tif", ".tiff"}:
        try:
            import tifffile
            with tifffile.TiffFile(path) as tf:
                icc = tf.pages[0].tags.get("InterColorProfile")
                icc = icc.value if icc is not None else None
                tag = tf.pages[0].tags.get("Orientation")
                orientation = int(tag.value) if tag is not None else 1
        except Exception:
            icc = None
    else:
        try:
            with Image.open(path) as im:
                icc = im.info.get("icc_profile")
                orientation = int(im.getexif().get(274, 1))
        except Exception:
            pass
    if arr.ndim == 2:
        arr = np.repeat(arr[..., None], 3, axis=2)
    if arr.ndim != 3 or arr.shape[2] not in (3, 4):
        raise ValueError(f"Expected grayscale, RGB, or RGBA input: {path}")
    if arr.dtype.kind not in "uif":
        raise ValueError(f"Unsupported image data type {arr.dtype}: {path}")
    if arr.dtype.kind == "f" and (not np.isfinite(arr).all() or arr.min() < 0 or arr.max() > 1):
        raise ValueError(f"Floating-point input must contain finite normalized values in [0, 1]: {path}")
    # OpenCV stores color channels as BGR(A).
    arr = arr[..., [2, 1, 0] + ([3] if arr.shape[2] == 4 else [])]
    # Apply the EXIF display transform to every channel before extracting alpha
    # or checking dimensions against masks. The transform is lossless and keeps
    # the decoded pixel values intact.
    if orientation == 2:
        arr = np.flip(arr, axis=1)
    elif orientation == 3:
        arr = np.rot90(arr, 2)
    elif orientation == 4:
        arr = np.flip(arr, axis=0)
    elif orientation == 5:
        arr = np.swapaxes(arr, 0, 1)
    elif orientation == 6:
        arr = np.rot90(arr, 3)
    elif orientation == 7:
        arr = np.flip(np.swapaxes(arr, 0, 1), axis=(0, 1))
    elif orientation == 8:
        arr = np.rot90(arr, 1)
    alpha = arr[..., 3].copy() if arr.shape[2] == 4 else None
    return arr[..., :3], alpha, icc


def _to_unit(rgb: np.ndarray) -> tuple[np.ndarray, float]:
    if rgb.dtype.kind == "f":
        return rgb.astype(np.float64), 1.0
    scale = float(np.iinfo(rgb.dtype).max)
    return rgb.astype(np.float64) / scale, scale


def _icc_to_srgb(rgb: np.ndarray, profile: bytes | None, path: Path) -> np.ndarray:
    if not profile:
        return rgb
    if rgb.dtype != np.uint8:
        try:
            name = ImageCms.getProfileName(ImageCms.ImageCmsProfile(io.BytesIO(profile))).strip().lower()
        except Exception as exc:
            raise ValueError(f"Could not identify embedded ICC profile in {path}: {exc}") from exc
        if name.startswith("srgb"):
            return rgb
        raise ValueError(
            f"{path} has a non-sRGB ICC profile, but profile conversion is only supported for 8-bit images. "
            "Convert it to 16-bit sRGB in a color-managed editor before matching; "
            "16-bit TIFF data is never silently reduced."
        )
    try:
        image = Image.fromarray(rgb, "RGB")
        source = ImageCms.ImageCmsProfile(io.BytesIO(profile))
        target = ImageCms.createProfile("sRGB")
        return np.asarray(ImageCms.profileToProfile(image, source, target, outputMode="RGB"))
    except Exception as exc:
        raise ValueError(f"Could not convert embedded ICC profile in {path}: {exc}") from exc


def _mask(path: Path | None, shape: tuple[int, int]) -> np.ndarray | None:
    if path is None:
        return None
    m = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if m is None:
        raise ValueError(f"Could not read mask: {path}")
    if m.shape != shape:
        raise ValueError(f"Mask dimensions {m.shape[1]}x{m.shape[0]} do not match image {shape[1]}x{shape[0]}: {path}")
    return m.astype(np.float64) / 255.0


def _smooth_quantile_curve(source: np.ndarray, reference: np.ndarray, weights: np.ndarray | None = None,
                           reference_weights: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Build a monotone, smoothed empirical quantile mapping for Lab lightness."""
    s = source.ravel()
    r = reference.ravel()
    sw = weights.ravel() if weights is not None else None
    if sw is not None:
        valid = sw > 0
        s, sw = s[valid], sw[valid]
    if s.size == 0 or r.size == 0:
        raise ValueError("A region mask has no pixels")
    quantiles = np.linspace(0, 1, 257)
    sq = np.quantile(s, quantiles) if sw is None else _weighted_quantile(s, sw, quantiles)
    if reference_weights is None:
        rq = np.quantile(r, quantiles)
    else:
        rw = reference_weights.ravel()
        valid = rw > 0
        if not valid.any():
            raise ValueError("Reference region mask has no pixels")
        rq = _weighted_quantile(r[valid], rw[valid], quantiles)
    if np.ptp(sq) <= 1e-12:
        median = float(np.quantile(r, 0.5)) if reference_weights is None else float(
            _weighted_quantile(r[valid], rw[valid], np.array([0.5]))[0])
        return np.array([sq[0]]), np.array([median])
    # Smooth the target lookup while preserving monotonicity. Ties remain ties;
    # a flat source region has no recoverable local detail to spread across.
    kernel = np.array([1, 4, 6, 4, 1], dtype=np.float64) / 16
    padded = np.pad(rq, (2, 2), mode="edge")
    rq = np.convolve(padded, kernel, mode="valid")
    rq = np.maximum.accumulate(rq)
    # Collapse tied source knots and average their corresponding targets. This
    # keeps the curve single-valued and maps a flat source distribution to the
    # reference median instead of arbitrarily choosing either endpoint.
    unique, inverse, counts = np.unique(sq, return_inverse=True, return_counts=True)
    target = np.bincount(inverse, weights=rq) / counts
    return unique, np.maximum.accumulate(target)


def _weighted_quantile(values: np.ndarray, weights: np.ndarray, q: np.ndarray) -> np.ndarray:
    order = np.argsort(values)
    x, w = values[order], weights[order]
    cumulative = np.cumsum(w) - 0.5 * w
    cumulative /= max(float(w.sum()), 1e-12)
    return np.interp(q, cumulative, x, left=x[0], right=x[-1])


def _weighted_stats(values: np.ndarray, weights: np.ndarray) -> tuple[float, float]:
    wsum = max(float(weights.sum()), 1e-12)
    mean = float(np.sum(values * weights) / wsum)
    std = float(np.sqrt(np.sum((values - mean) ** 2 * weights) / wsum))
    return mean, std


def _match_lab(src: np.ndarray, ref: np.ndarray, strength: float, chroma_strength: float,
               src_weights: np.ndarray | None = None, ref_weights: np.ndarray | None = None,
               local_contrast_strength: float = 1.0) -> np.ndarray:
    """Transform a single image region in CIE Lab."""
    out = src.copy()
    if strength == 0:
        return out
    sw = np.ones(src.shape[:2]) if src_weights is None else src_weights
    rw = np.ones(ref.shape[:2]) if ref_weights is None else ref_weights
    if sw.sum() <= 0 or rw.sum() <= 0:
        return out
    src_l, ref_l = src[..., 0], ref[..., 0]
    sx, sy = _smooth_quantile_curve(src_l, ref_l, sw, rw)
    tone = np.interp(src_l, sx, sy)
    out[..., 0] = src_l + (tone - src_l) * strength
    for channel in (1, 2):
        sm, ss = _weighted_stats(src[..., channel], sw)
        rm, rs = _weighted_stats(ref[..., channel], rw)
        reinhard = (src[..., channel] - sm) * (rs / max(ss, 1e-6)) + rm
        out[..., channel] = src[..., channel] + (reinhard - src[..., channel]) * strength
    if chroma_strength > 0:
        out[..., 1:3] = _match_hue_chroma(src[..., 1:3], ref[..., 1:3], out[..., 1:3],
                                           sw, rw, strength, chroma_strength)
    if local_contrast_strength > 0:
        out[..., 0] = _match_local_contrast(out[..., 0], ref_l, sw, rw,
                                             strength, local_contrast_strength)
    return out


def _local_detail(luminance: np.ndarray, weights: np.ndarray) -> tuple[float, np.ndarray, np.ndarray] | None:
    """Measure p75 local detail only where an entire 3x3 window is in-region."""
    supported = (weights >= 0.75).astype(np.uint8)
    supported = cv2.erode(supported, np.ones((3, 3), np.uint8), borderType=cv2.BORDER_CONSTANT)
    smooth = cv2.GaussianBlur(luminance.astype(np.float32), (3, 3), 0).astype(np.float64)
    detail = np.abs(luminance - smooth)
    values = detail[supported > 0]
    if values.size < 200:
        return None
    return float(np.percentile(values, 75)), smooth, detail


def _match_local_contrast(luminance: np.ndarray, ref_luminance: np.ndarray,
                          source_weights: np.ndarray, reference_weights: np.ndarray,
                          strength: float, local_strength: float) -> np.ndarray:
    """Scale existing 3x3 local luminance deviations toward the reference."""
    if strength == 0 or local_strength == 0:
        return luminance
    source = _local_detail(luminance, source_weights)
    reference = _local_detail(ref_luminance, reference_weights)
    if source is None or reference is None:
        return luminance
    source_p75, smooth, detail = source
    reference_p75, _, _ = reference
    if source_p75 < 1e-4:
        return luminance
    gain = 1 + (reference_p75 / source_p75 - 1) * strength * local_strength
    # Apply the gain to the signed residual (not its absolute value), retaining
    # the original local structure without inventing detail in flat regions.
    result = smooth + (luminance - smooth) * gain
    return np.clip(result, 0, 100)


def _match_hue_chroma(src_ab: np.ndarray, ref_ab: np.ndarray, normalized_ab: np.ndarray,
                      sw: np.ndarray, rw: np.ndarray, strength: float,
                      hue_strength: float) -> np.ndarray:
    """Add supported, smooth hue-sector residuals after Lab normalization."""
    if strength == 0 or hue_strength == 0:
        return normalized_ab.copy()
    sectors, step, min_chroma, min_support, min_fraction = 12, 30.0, 5.0, 20.0, 0.005
    centers = np.arange(sectors) * step
    def summarize(ab: np.ndarray, weights: np.ndarray,
                  hue_source: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
        hue_data = ab if hue_source is None else hue_source
        hue = (np.degrees(np.arctan2(hue_data[..., 1], hue_data[..., 0])) + 360) % 360
        chroma = np.hypot(ab[..., 0], ab[..., 1])
        result, support = np.zeros((sectors, 2)), np.zeros(sectors)
        valid = chroma >= min_chroma
        for idx, center in enumerate(centers):
            dist = np.abs((hue - center + 180) % 360 - 180) / step
            angular = np.where(dist < 1, 0.5 + 0.5 * np.cos(np.pi * dist), 0.0)
            w = angular * weights * valid
            support[idx] = w.sum()
            if support[idx] > 0:
                result[idx] = np.sum(ab * w[..., None], axis=(0, 1)) / support[idx]
        return result, support
    src_mean, src_support = summarize(src_ab, sw)
    ref_mean, ref_support = summarize(ref_ab, rw)
    src_n, ref_n = max(float(sw.sum()), 1), max(float(rw.sum()), 1)
    source_stats = [_weighted_stats(src_ab[..., c], sw) for c in (0, 1)]
    reference_stats = [_weighted_stats(ref_ab[..., c], rw) for c in (0, 1)]
    source_global = np.array([x[0] for x in source_stats])
    source_scale = np.array([x[1] for x in source_stats])
    ref_global = np.array([x[0] for x in reference_stats])
    ref_scale = np.array([x[1] for x in reference_stats])
    delta = np.zeros((sectors, 2))
    enabled = np.zeros(sectors, dtype=bool)
    for i in range(sectors):
        if (src_support[i] >= min_support and ref_support[i] >= min_support and
                src_support[i] / src_n >= min_fraction and ref_support[i] / ref_n >= min_fraction):
            scale = np.where(source_scale > 1e-8,
                             1 + strength * (ref_scale / np.maximum(source_scale, 1e-8) - 1), 1)
            predicted_global = source_global + strength * (ref_global - source_global)
            predicted = predicted_global + (src_mean[i] - source_global) * scale
            desired = src_mean[i] + strength * (ref_mean[i] - src_mean[i])
            delta[i] = (desired - predicted) * hue_strength
            enabled[i] = True
    if not enabled.any():
        return normalized_ab.copy()
    hue = (np.degrees(np.arctan2(src_ab[..., 1], src_ab[..., 0])) + 360) % 360
    chroma = np.hypot(src_ab[..., 0], src_ab[..., 1])
    out = normalized_ab.copy()
    for i, center in enumerate(centers):
        if not enabled[i]:
            continue
        dist = np.abs((hue - center + 180) % 360 - 180) / step
        weight = np.where(dist < 1, 0.5 + 0.5 * np.cos(np.pi * dist), 0.0)
        out += delta[i] * (weight * (chroma >= min_chroma))[..., None]
    return out


def _lab_to_linear_rgb(lab: np.ndarray) -> np.ndarray:
    """Convert D65 Lab to unclipped linear sRGB for real gamut decisions."""
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    fy = (L + 16) / 116
    fx, fz = fy + a / 500, fy - b / 200
    delta = 6 / 29
    def invf(t: np.ndarray) -> np.ndarray:
        return np.where(t > delta, t ** 3, 3 * delta ** 2 * (t - 4 / 29))
    x, y, z = invf(fx) * 0.95047, invf(fy), invf(fz) * 1.08883
    return np.stack([3.2404542*x - 1.5371385*y - 0.4985314*z,
                     -0.969266*x + 1.8760108*y + 0.041556*z,
                     0.0556434*x - 0.2040259*y + 1.0572252*z], axis=-1)


def _linear_to_srgb(rgb: np.ndarray) -> np.ndarray:
    return np.where(rgb <= 0.0031308, 12.92 * rgb, 1.055 * np.maximum(rgb, 0) ** (1/2.4) - 0.055)


def gamut_map_lab(lab: np.ndarray) -> np.ndarray:
    """Reduce chroma until raw linear sRGB is valid, preserving Lab L and hue."""
    L, original = lab[..., 0], lab[..., 1:3]
    raw = _lab_to_linear_rgb(lab)
    bad = np.any((raw < 0) | (raw > 1) | ~np.isfinite(raw), axis=-1)
    if not bad.any():
        return np.clip(_linear_to_srgb(raw), 0, 1)
    lo, hi = np.zeros(L.shape), np.ones(L.shape)
    for _ in range(28):
        mid = (lo + hi) / 2
        trial = lab.copy()
        trial[..., 1:3] = original * mid[..., None]
        rgb = _lab_to_linear_rgb(trial)
        fits = np.all((rgb >= 0) & (rgb <= 1) & np.isfinite(rgb), axis=-1)
        lo = np.where(bad & fits, mid, lo)
        hi = np.where(bad & ~fits, mid, hi)
    corrected = lab.copy()
    corrected[..., 1:3] = np.where(bad[..., None], original * lo[..., None], original)
    return np.clip(_linear_to_srgb(_lab_to_linear_rgb(corrected)), 0, 1)


def transfer(source: np.ndarray, reference: np.ndarray, *, strength: float = 1.0,
             chroma_strength: float = 1.0, source_mask: np.ndarray | None = None,
             reference_mask: np.ndarray | None = None, local_contrast_strength: float = 1.0) -> np.ndarray:
    """Apply transfer to float RGB arrays in [0,1], returning float RGB."""
    if source.shape[-1] != 3 or reference.shape[-1] != 3:
        raise ValueError("Expected RGB arrays")
    if strength == 0:
        return source.copy()
    src_lab, ref_lab = rgb2lab(np.clip(source, 0, 1)), rgb2lab(np.clip(reference, 0, 1))
    if (source_mask is None) != (reference_mask is None):
        raise ValueError("Provide both --reference-mask and --user-mask, or neither")
    if source_mask is None:
        matched = _match_lab(src_lab, ref_lab, strength, chroma_strength,
                             local_contrast_strength=local_contrast_strength)
        return gamut_map_lab(matched)
    sm = source_mask.astype(float)
    rm = reference_mask.astype(float)
    if sm.shape != src_lab.shape[:2] or rm.shape != ref_lab.shape[:2]:
        raise ValueError("Mask dimensions must match their corresponding images")
    sw, rw = sm.ravel(), rm.ravel()
    if sw.sum() <= 0 or rw.sum() <= 0:
        raise ValueError("Region masks must contain at least one nonzero pixel")
    # Histograms and per-channel moments use the corresponding masked pixels.
    foreground = _match_lab(src_lab, ref_lab, strength, chroma_strength, sm, rm, local_contrast_strength)
    background = _match_lab(src_lab, ref_lab, strength, chroma_strength, 1 - sm, 1 - rm, local_contrast_strength)
    return gamut_map_lab(foreground * sm[..., None] + background * (1 - sm[..., None]))


def run(reference_path: Path, user_path: Path, output_path: Path, reference_mask_path: Path | None = None,
        user_mask_path: Path | None = None, strength: float = 1.0, chroma_strength: float = 1.0,
        jpeg_quality: int = 95, local_contrast_strength: float = 1.0) -> None:
    ref_raw, _, ref_icc = _read(reference_path)
    src_raw, alpha, src_icc = _read(user_path)
    ref_rgb = _icc_to_srgb(ref_raw, ref_icc, reference_path)
    src_rgb = _icc_to_srgb(src_raw, src_icc, user_path)
    ref, _ = _to_unit(ref_rgb)
    src, _ = _to_unit(src_rgb)
    rm = _mask(reference_mask_path, ref.shape[:2])
    sm = _mask(user_mask_path, src.shape[:2])
    result = transfer(src, ref, strength=strength, chroma_strength=chroma_strength,
                      source_mask=sm, reference_mask=rm, local_contrast_strength=local_contrast_strength)
    # Restore alpha exactly. Output is sRGB; source ICC metadata is not copied.
    if output_path.suffix.lower() in {".tif", ".tiff"}:
        import tifffile
        pixels = np.rint(result * 65535).astype(np.uint16)
        if alpha is not None:
            alpha_unit, _ = _to_unit(alpha)
            pixels = np.dstack([pixels, np.rint(alpha_unit * 65535).astype(np.uint16)])
        srgb_profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        tifffile.imwrite(output_path, pixels, photometric="rgb",
                         extrasamples="unassalpha" if alpha is not None else None,
                         iccprofile=srgb_profile, compression=None)
    else:
        if output_path.suffix.lower() in {".jpg", ".jpeg"}:
            pixels = np.rint(result * 255).astype(np.uint8)
        elif src_raw.dtype == np.uint8:
            pixels = np.rint(result * 255).astype(np.uint8)
        elif src_raw.dtype == np.uint16:
            pixels = np.rint(result * 65535).astype(np.uint16)
        else:
            pixels = result.astype(src_raw.dtype)
        if alpha is not None and output_path.suffix.lower() not in {".jpg", ".jpeg"}:
            pixels = np.dstack([pixels, alpha])
        bgr = pixels[..., [2, 1, 0] + ([3] if pixels.ndim == 3 and pixels.shape[2] == 4 else [])]
        params = [cv2.IMWRITE_JPEG_QUALITY, jpeg_quality] if output_path.suffix.lower() in {".jpg", ".jpeg"} else []
        if not cv2.imwrite(str(output_path), bgr, params):
            raise ValueError(f"Could not write output: {output_path}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--user_photo", "--user-photo", dest="user_photo", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reference-mask", type=Path)
    parser.add_argument("--user-mask", type=Path)
    parser.add_argument("--strength", type=float, default=1.0)
    parser.add_argument("--chroma-strength", type=float, default=1.0,
                        help="Optional selective hue/chroma adjustment (0 disables, 1 fully matches bins)")
    parser.add_argument("--local-contrast-strength", type=float, default=1.0,
                        help="Blend local luminance detail contrast toward the reference (0 disables)")
    parser.add_argument("--jpeg-quality", type=int, default=95)
    args = parser.parse_args(argv)
    if not 0 <= args.strength <= 1 or not 0 <= args.chroma_strength <= 1 or not 0 <= args.local_contrast_strength <= 1:
        parser.error("strength values must be between 0 and 1")
    if not 1 <= args.jpeg_quality <= 100:
        parser.error("JPEG quality must be between 1 and 100")
    try:
        run(args.reference, args.user_photo, args.output, args.reference_mask, args.user_mask,
            args.strength, args.chroma_strength, args.jpeg_quality, args.local_contrast_strength)
    except (ValueError, OSError) as exc:
        print(f"reference_match: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
