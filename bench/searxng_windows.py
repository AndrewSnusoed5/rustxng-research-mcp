"""Windows-only WSGI entry point for the no-Valkey benchmark configuration."""
import os
import sys
from types import ModuleType

if os.name == "nt":
    # SearXNG imports pwd for logging failed Unix Valkey connections.
    # The loopback benchmark sets no Valkey URL, so that path is unused.
    sys.modules["pwd"] = ModuleType("pwd")

from searx.webapp import app
