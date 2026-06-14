"""Make the service modules importable from the tests directory.

The service keeps its modules at the package root (``main.py``, ``label.py``)
rather than inside a package, mirroring how they are copied into the Docker
image. Adding the parent directory to ``sys.path`` lets the tests import them.
"""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
