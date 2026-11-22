"""Windows-only WSGI entry point for the no-Valkey benchmark configuration."""
import os
import sys
from types import ModuleType

if os.name == "nt":
    # SearXNG imports pwd for logging failed Unix Valkey connections.
    # The loopback benchmark sets no Valkey URL, so that path is unused.
    sys.modules["pwd"] = ModuleType("pwd")

from searx import webapp

if os.name == "nt":
    # The HTML loader expects theme template names with URL-style separators.
    webapp.result_templates = {name.replace("\\", "/") for name in webapp.result_templates}

app = webapp.app
