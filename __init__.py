"""
Model Downloader: download models from CivitAI, Hugging Face or any direct link into ComfyUI's model folders.

All functionality lives in the web extension and the HTTP routes registered by
``model_downloader``; no graph nodes are added.
"""

from . import model_downloader  # noqa: F401  (registers routes)

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
