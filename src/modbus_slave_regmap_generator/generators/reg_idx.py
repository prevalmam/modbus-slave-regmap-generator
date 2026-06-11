from __future__ import annotations

from typing import List

from ..workbook_loader import WorkbookData
from . import GeneratedFile


def generate(workbook: WorkbookData) -> List[GeneratedFile]:
    entries = workbook.entries

    idx_lines = [
        "#ifndef MODBUS_REG_IDX_SLAVE_H",
        "#define MODBUS_REG_IDX_SLAVE_H",
        "",
        f"#define MODBUS_SLAVE_ADDR {workbook.modbus_slave_addr}",
        "",
        "/* Modbus register index definitions */",
    ]

    idx = 0
    for entry in entries:
        base_name = entry["name"]
        length = entry["length"]

        if entry["type"] == "REG_TYPE_RESERVED":
            idx_lines.append(f"#define MODBUS_IDX_{base_name}  ({idx})")
            idx += 1
            continue

        # Base index for g_reg_table_slave
        idx_lines.append(f"#define MODBUS_IDX_{base_name}  ({idx})")

        if length > 1:
            for i in range(length):
                idx_lines.append(f"#define MODBUS_IDX_{base_name}_{i}  ({i})")

        idx += 1  # advance g_reg_table_slave index by one entry

    idx_lines.append("")
    idx_lines.append("#endif")

    return [GeneratedFile("modbus_reg_idx_slave.h", "\n".join(idx_lines))]
