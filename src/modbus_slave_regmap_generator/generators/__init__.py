from dataclasses import dataclass
from typing import List


@dataclass
class GeneratedFile:
    """Represents a generated file (relative filename + textual content)."""

    filename: str
    content: str


GeneratedFiles = List[GeneratedFile]
