from __future__ import annotations

import os
from typing import Iterable

try:
    from .generators import GeneratedFile
except ImportError:  # pragma: no cover - fallback for script execution
    from generators import GeneratedFile  # type: ignore


def write_generated_files(out_dir: str, files: Iterable[GeneratedFile]) -> None:
    """Write all generated files into the target directory."""
    for gen_file in files:
        full_path = os.path.join(out_dir, gen_file.filename)
        with open(full_path, "w", encoding="utf-8") as handle:
            handle.write(gen_file.content)
