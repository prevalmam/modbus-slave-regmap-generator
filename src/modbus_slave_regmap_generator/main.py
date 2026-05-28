import os
import sys
from typing import List
import tkinter as tk
from tkinter import filedialog, messagebox

if __package__ in {None, ""}:  # pragma: no cover - support direct execution / PyInstaller
    current_dir = os.path.dirname(os.path.abspath(__file__))
    sys.path.append(os.path.dirname(current_dir))

from modbus_slave_regmap_generator.generators import GeneratedFile
from modbus_slave_regmap_generator.generators import parser, reg_access, reg_edge, reg_idx, reg_map
from modbus_slave_regmap_generator.workbook_loader import load_workbook_data
from modbus_slave_regmap_generator.writer import write_generated_files

BASE_NVM_OFFSET = 0x0002


def main() -> None:
    root = tk.Tk()
    root.withdraw()
    file_path = filedialog.askopenfilename(filetypes=[("Excel files", "*.xlsx")])
    if not file_path:
        print("キャンセルされました")
        return

    try:
        workbook = load_workbook_data(file_path, BASE_NVM_OFFSET)

        generated_files: List[GeneratedFile] = []
        generated_files.extend(reg_map.generate(workbook))
        generated_files.extend(reg_idx.generate(workbook))
        generated_files.extend(reg_access.generate(workbook))
        generated_files.extend(reg_edge.generate(workbook))
        generated_files.extend(parser.generate(workbook))

        out_dir = os.path.dirname(file_path)
        write_generated_files(out_dir, generated_files)
    except ValueError as exc:
        messagebox.showerror("modbus-slave-regmap-generator", str(exc))
        return

    print("生成ファイル出力完了:", out_dir)


if __name__ == "__main__":
    main()
