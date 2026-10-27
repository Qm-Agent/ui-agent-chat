import importlib.util
from pathlib import Path
import zipfile
import unittest


ROOT = Path(__file__).resolve().parents[3]
PATCH_SCRIPT = ROOT / "scripts" / "patch-browser-use.py"
WHEEL = ROOT / "vendor" / "browser-use" / "browser_use-3.1.6-py3-none-any.whl"


class PublicModelPatchTest(unittest.TestCase):
    def test_public_model_name_uses_configured_openai_route(self):
        spec = importlib.util.spec_from_file_location("uiwarden_patch_browser_use", PATCH_SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)

        with zipfile.ZipFile(WHEEL) as archive:
            source = archive.read("browser_use/agent/chat_models.py").decode("utf-8")

        self.assertIn("BU_OPENAI_API_KEY", source)
        self.assertIn("BU_OPENAI_API_BASE", source)
        self.assertIn('actor="qwen3.7-plus"', source)
        self.assertNotIn("BU_LLM_API_KEY", source)
        self.assertNotIn("model in __factory__", source)
        compile(source, "chat_models.py", "exec")

        patched, changed = module._patch_public_openai_models(source)
        self.assertFalse(changed)
        self.assertEqual(patched, source)

    def test_public_model_box_format_has_safe_default_and_override(self):
        spec = importlib.util.spec_from_file_location("uiwarden_patch_browser_use", PATCH_SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)

        with zipfile.ZipFile(WHEEL) as archive:
            source = archive.read("browser_use/agent/service.py").decode("utf-8")

        patched, changed = module._patch_public_model_box_format(source)
        self.assertTrue(changed)
        self.assertIn('os.getenv("BU_MODEL_BOX_FORMAT", "ltrb")', patched)
        self.assertIn('return configured if configured in {"tlbr", "ltrb"} else "ltrb"', patched)
        compile(patched, "service.py", "exec")

        patched_again, changed_again = module._patch_public_model_box_format(patched)
        self.assertFalse(changed_again)
        self.assertEqual(patched_again, patched)

    def test_semantic_ancestor_promotion_preserves_child_iou(self):
        spec = importlib.util.spec_from_file_location("uiwarden_patch_browser_use", PATCH_SCRIPT)
        module = importlib.util.module_from_spec(spec)
        assert spec and spec.loader
        spec.loader.exec_module(module)

        with zipfile.ZipFile(WHEEL) as archive:
            source = archive.read("browser_use/controller/service.py").decode("utf-8")

        patched, changed = module._patch_semantic_ancestor_iou(source)
        self.assertTrue(changed)
        self.assertEqual(patched.count("preserve the original child IoU"), 2)
        self.assertIn("max_iou = max(max_iou, calculate_iou(", patched)
        compile(patched, "controller_service.py", "exec")

        patched_again, changed_again = module._patch_semantic_ancestor_iou(patched)
        self.assertFalse(changed_again)
        self.assertEqual(patched_again, patched)


if __name__ == "__main__":
    unittest.main()
