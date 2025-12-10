import os
from typing import List
import tkinter as tk
from tkinter import filedialog

try:
    from .generators import GeneratedFile
    from .generators import reg_access, reg_edge, reg_idx, reg_map
    from .workbook_loader import load_workbook_data
except ImportError:  # pragma: no cover - fallback for direct execution
    from generators import GeneratedFile  # type: ignore
    from generators import reg_access, reg_edge, reg_idx, reg_map  # type: ignore
    from workbook_loader import load_workbook_data  # type: ignore

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
    for gen_file in generated_files:
        full_path = os.path.join(out_dir, gen_file.filename)
        with open(full_path, "w", encoding="utf-8") as f:
            f.write(gen_file.content)

    print("生成ファイル出力完了:", out_dir)


if __name__ == "__main__":
    main()
