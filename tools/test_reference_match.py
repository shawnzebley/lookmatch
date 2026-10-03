"""Focused deterministic tests for the reference transfer CLI."""
import unittest

import numpy as np
import tifffile
from skimage.color import rgb2lab

from reference_match import (_local_detail, _match_hue_chroma, _match_local_contrast, _read, _smooth_quantile_curve,
                             gamut_map_lab, transfer)


class ReferenceMatchTests(unittest.TestCase):
    def test_quantile_curve_is_monotone_and_flat_maps_to_median(self):
        x = np.array([4.0, 4.0, 4.0])
        sx, sy = _smooth_quantile_curve(x, np.array([0.0, 20.0, 90.0]))
        self.assertTrue(np.all(np.diff(sx) >= 0))
        self.assertTrue(np.all(np.diff(sy) >= 0))
        self.assertTrue(np.isfinite(np.interp(x, sx, sy)).all())
        self.assertAlmostEqual(float(np.interp(4.0, sx, sy)), 20.0, delta=1.0)

    def test_identity_and_constant_inputs_are_finite_in_gamut(self):
        rng = np.random.default_rng(12)
        image = rng.uniform(0.05, 0.95, (8, 7, 3))
        result = transfer(image, image)
        self.assertTrue(np.isfinite(result).all())
        self.assertLess(float(np.max(np.abs(result - image))), 0.015)
        flat = np.full((4, 5, 3), 0.5)
        changed = transfer(flat, np.full((3, 6, 3), 0.7))
        self.assertTrue(np.isfinite(changed).all())
        self.assertTrue(np.all((changed >= 0) & (changed <= 1)))

    def test_gamut_mapping_keeps_result_in_rgb_gamut(self):
        lab = np.array([[[55.0, 140.0, 120.0], [40.0, -120.0, 100.0]]])
        rgb = gamut_map_lab(lab)
        self.assertTrue(np.all((rgb >= 0) & (rgb <= 1)))
        self.assertTrue(np.isfinite(rgb).all())
        actual = rgb2lab(rgb)
        self.assertTrue(np.allclose(actual[..., 0], lab[..., 0], atol=0.02))
        before_hue = np.arctan2(lab[..., 2], lab[..., 1])
        after_hue = np.arctan2(actual[..., 2], actual[..., 1])
        hue_error = np.abs((after_hue - before_hue + np.pi) % (2 * np.pi) - np.pi)
        self.assertTrue(np.all(hue_error < 0.002))

    def test_zero_strength_is_identity_even_with_chroma_matching_enabled(self):
        rng = np.random.default_rng(4)
        source, reference = rng.random((6, 8, 3)), rng.random((4, 5, 3))
        result = transfer(source, reference, strength=0, chroma_strength=1)
        self.assertTrue(np.array_equal(result, source))

    def test_hue_residual_does_not_repeat_a_global_mean_shift(self):
        hue = np.repeat(np.arange(12) * (2 * np.pi / 12), 30)
        source = np.stack([20 * np.cos(hue), 20 * np.sin(hue)], axis=-1).reshape(12, 30, 2)
        # A small global-only shift leaves sector memberships effectively
        # unchanged, so a hue residual must not apply that shift a second time.
        reference = source + np.array([0.01, -0.005])
        weights = np.ones((12, 30))
        for overall in (0.5, 1.0):
            normalized = source + overall * np.array([0.01, -0.005])
            corrected = _match_hue_chroma(source, reference, normalized, weights, weights, overall, 1)
            self.assertTrue(np.isfinite(corrected).all())
            self.assertLess(float(np.max(np.abs(corrected - normalized))), 1e-4)
        disabled = _match_hue_chroma(source, reference, source, weights, weights, 1, 0)
        self.assertTrue(np.array_equal(disabled, source))

    def test_local_contrast_moves_detail_toward_reference_without_inventing_flat_detail(self):
        yy, xx = np.indices((30, 30))
        pattern = (xx + yy) % 2 * 2.0
        source, reference = 49 + pattern, 45 + pattern * 4
        weights = np.ones((30, 30))
        before = _local_detail(source, weights)[0]
        target = _local_detail(reference, weights)[0]
        result = _match_local_contrast(source, reference, weights, weights, 1, 1)
        after = _local_detail(result, weights)[0]
        self.assertAlmostEqual(after, target, places=5)
        self.assertNotEqual(before, after)
        flat = np.full((30, 30), 50.0)
        self.assertTrue(np.array_equal(_match_local_contrast(flat, reference, weights, weights, 1, 1), flat))
        self.assertTrue(np.array_equal(_match_local_contrast(source, reference, weights, weights, 0, 1), source))

    def test_exif_orientation_is_applied_before_returning_dimensions(self):
        import tempfile
        from pathlib import Path
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rotated.jpg"
            image = Image.new("RGB", (6, 4), color=(100, 120, 140))
            exif = image.getexif()
            exif[274] = 6
            image.save(path, exif=exif)
            rgb, alpha, _ = _read(path)
            self.assertEqual(rgb.shape, (6, 4, 3))
            self.assertIsNone(alpha)

    def test_masks_fit_foreground_and_background_independently(self):
        source = np.zeros((8, 8, 3), dtype=float)
        source[:, :4] = (0.35, 0.25, 0.18)
        source[:, 4:] = (0.15, 0.2, 0.3)
        reference = source.copy()
        reference[:, 4:] = (0.65, 0.55, 0.4)
        mask = np.zeros((8, 8), dtype=float)
        mask[:, :4] = 1
        result = transfer(source, reference, source_mask=mask, reference_mask=mask)
        self.assertTrue(np.allclose(result[:, :4], source[:, :4], atol=0.005))
        self.assertGreater(float(np.mean(np.abs(result[:, 4:] - source[:, 4:]))), 0.05)

    def test_cli_preserves_16bit_tiff_dimensions_and_alpha(self):
        import tempfile
        from pathlib import Path
        from reference_match import main
        with tempfile.TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            reference = np.zeros((9, 11, 3), np.uint16)
            reference[...] = (46000, 30000, 20000)
            user = np.zeros((6, 8, 4), np.uint16)
            user[..., :3] = (18000, 24000, 32000)
            user[..., 3] = np.arange(48, dtype=np.uint16).reshape(6, 8) * 1200
            ref_path, src_path, out_path = tmp_path / "ref.tif", tmp_path / "user.tif", tmp_path / "out.tif"
            tifffile.imwrite(ref_path, reference, photometric="rgb")
            tifffile.imwrite(src_path, user, photometric="rgb", extrasamples="unassalpha")
            self.assertEqual(main(["--reference", str(ref_path), "--user_photo", str(src_path),
                                   "--output", str(out_path)]), 0)
            with tifffile.TiffFile(out_path) as tf:
                output = tf.asarray()
                self.assertIn("InterColorProfile", tf.pages[0].tags)
            self.assertEqual(output.dtype, np.uint16)
            self.assertEqual(output.shape, user.shape)
            self.assertTrue(np.array_equal(output[..., 3], user[..., 3]))
            self.assertEqual(main(["--reference", str(ref_path), "--user_photo", str(out_path),
                                  "--output", str(tmp_path / "again.tif")]), 0)


if __name__ == "__main__":
    unittest.main()
