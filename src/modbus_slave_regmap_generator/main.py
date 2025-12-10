import os
from typing import List
import tkinter as tk
from tkinter import filedialog

try:
    from .generators import GeneratedFile
    from .generators import reg_access, reg_edge, reg_idx, reg_map
    from .workbook_loader import load_workbook_data
    from .writer import write_generated_files
except ImportError:  # pragma: no cover - fallback for direct execution
    from generators import GeneratedFile  # type: ignore
    from generators import reg_access, reg_edge, reg_idx, reg_map  # type: ignore
    from workbook_loader import load_workbook_data  # type: ignore
    from writer import write_generated_files  # type: ignore

BASE_FRAM_OFFSET = 0x0002


def main() -> None:
    root = tk.Tk()
    root.withdraw()
    file_path = filedialog.askopenfilename(filetypes=[("Excel files", "*.xlsx")])
    if not file_path:
        print("キャンセルされました")
        return

    workbook = load_workbook_data(file_path, BASE_FRAM_OFFSET)

    generated_files: List[GeneratedFile] = []
    generated_files.extend(reg_map.generate(workbook))
    generated_files.extend(reg_idx.generate(workbook))
    generated_files.extend(reg_access.generate(workbook))
    generated_files.extend(reg_edge.generate(workbook))

    out_dir = os.path.dirname(file_path)
    write_generated_files(out_dir, generated_files)

    print("生成ファイル出力完了:", out_dir)


if __name__ == "__main__":
    main()
